"""``update_context`` records who last wrote each field (``field_meta.{field} = {by, sub, at}``, 7.104.00), on moto,
so DynamoDB itself evaluates the map paths and the conditions. ``by`` follows the caller: a person (the assistant's
approval card included: it runs with the person's own token, the owner's decision of 2026-11-26) or the assistant (an
MCP client, an agent, a plan step). Since review F1 (7.104.00 round 1) the write is shared/product_proposals.py
``write_context``, the one writer and the one rule of a value a person typed (S1: a value with no ``field_meta``
entry is a person's)."""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

import product_context as pc
from shared import product_proposals
from shared.exceptions import ConflictError

CONTEXT_KEY = {'pk': 'PROJECT#p1', 'sk': 'PRODUCT_CONTEXT'}
ADA = pc.Actor(sub='sub-ada', kind='user', autonomous=False)
MCP = pc.Actor(sub='mcp:tok1', kind='mcp', autonomous=True)


def _caller(kind: str, sub: str = 's-1') -> pc.Actor:
    return pc.Actor(sub=sub, kind=kind, autonomous=kind in ('mcp', 'agent', 'plan'))


@pytest.fixture
def table() -> Iterator[object]:
    with mock_aws():
        projects = pk_sk_table('test-projects')
        projects.put_item(Item={'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'status': 'active'})
        with patch.object(pc, 'projects_table', projects):
            yield projects


def _meta(table) -> dict:
    return table.get_item(Key=CONTEXT_KEY)['Item'].get('field_meta', {})


def _stored(table) -> dict:
    return table.get_item(Key=CONTEXT_KEY)['Item']


def test_the_first_write_records_each_field_it_wrote_as_the_persons(table):
    pc.update_context('p1', {'product_name': 'Acme Notes', 'current_state': 'beta', 'bogus': 'x'}, actor=ADA, workspace=None)
    meta = _meta(table)
    assert set(meta) == {'product_name', 'current_state'}
    assert {(entry['by'], entry['sub']) for entry in meta.values()} == {('person', 'sub-ada')}
    assert meta['product_name']['at'] == _stored(table)['updated_at']


def test_a_later_write_records_its_own_fields_and_keeps_the_others(table):
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=ADA, workspace=None)
    pc.update_context('p1', {'one_liner': 'Meeting notes that write themselves'}, actor=MCP, workspace=None)
    meta = _meta(table)
    assert (meta['product_name']['by'], meta['one_liner']['by'], meta['one_liner']['sub']) == (
        'person', 'assistant', 'mcp:tok1')


def test_a_record_from_before_7_72_gets_its_map_on_its_first_write(table):
    table.put_item(Item={**CONTEXT_KEY, 'product_name': 'Old name', 'updated_at': '2026-01-01T00:00:00+00:00'})
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=ADA, workspace=None)
    assert _meta(table)['product_name']['by'] == 'person'


@pytest.mark.parametrize(('kind', 'by'), [
    ('user', 'person'), ('admin', 'person'), ('mcp', 'assistant'), ('agent', 'assistant'), ('plan', 'assistant'),
])
def test_who_wrote_it_follows_the_kind_of_caller(table, kind, by):
    pc.update_context('p1', {'key_features': 'Search'}, actor=_caller(kind), workspace=None)
    assert _meta(table)['key_features']['by'] == by


@pytest.mark.usefixtures('table')
def test_the_context_route_is_read_without_the_meta():
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=ADA, workspace=None)
    assert 'field_meta' not in pc.get_context('p1', workspace=None)['context']


def test_the_assistants_approval_card_is_the_person_who_approved_it(table):
    """The card's PUT carries the person's own token: the writer is a user, and the call is not autonomous."""
    from shared.product_proposal_routes import writer_of

    card = {'requestContext': {'authorizer': {'claims': {'sub': 'sub-ada', 'cognito:groups': 'users'}}}}
    pc.update_context('p1', {'non_goals': 'No video'}, actor=writer_of(card, 'p1', workspace=None), workspace=None)
    assert _meta(table)['non_goals'] == {**_meta(table)['non_goals'], 'by': 'person', 'sub': 'sub-ada'}


def test_a_write_on_a_row_without_field_meta_meanwhile_given_one_is_read_again(table):
    table.put_item(Item={**CONTEXT_KEY, 'product_name': 'Old', 'updated_at': '2026-01-01T00:00:00+00:00'})
    real = product_proposals.context_state
    reads = []

    def a_map_meanwhile(*args, **kwargs):
        state = real(*args, **kwargs)
        if not reads:
            table.update_item(Key=CONTEXT_KEY, UpdateExpression='SET field_meta = :m',
                              ExpressionAttributeValues={':m': {'product_name': {'by': 'person'}}})
        reads.append(state)
        return state
    with patch.object(product_proposals, 'context_state', side_effect=a_map_meanwhile):
        pc.update_context('p1', {'one_liner': 'Fast'}, actor=ADA, workspace=None)
    assert len(reads) == 2
    assert (_meta(table)['product_name'], _meta(table)['one_liner']['by']) == ({'by': 'person'}, 'person')


# ── The assistant never replaces a value a person typed (owner decision 4, 7.104.00) ──────────────────────────────


@pytest.mark.parametrize('kind', ['mcp', 'agent', 'plan'])
def test_an_assistant_write_over_a_persons_value_is_a_conflict_and_the_rest_applies(table, kind):
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=ADA, workspace=None)
    answer = pc.update_context('p1', {'product_name': 'Acme AI', 'one_liner': 'Notes that write themselves'},
                               actor=_caller(kind, f'{kind}-1'), workspace=None)
    assert answer['conflicts'] == [{'field': 'product_name', 'reason': 'person_value'}]
    assert (answer['context']['product_name'], answer['context']['one_liner']) == (
        'Acme Notes', 'Notes that write themselves')
    meta = _meta(table)
    assert (meta['product_name']['by'], meta['one_liner']['by']) == ('person', 'assistant')


def test_when_every_field_is_a_persons_the_write_is_refused_and_nothing_changes(table):
    pc.update_context('p1', {'product_name': 'Acme Notes', 'non_goals': 'No video'}, actor=ADA, workspace=None)
    before = _stored(table)
    with pytest.raises(ConflictError) as refused:
        pc.update_context('p1', {'product_name': 'Acme AI', 'non_goals': 'Video'}, actor=MCP, workspace=None)
    assert (refused.value.code, refused.value.details['conflicts']) == ('conflict', [
        {'field': 'product_name', 'reason': 'person_value'}, {'field': 'non_goals', 'reason': 'person_value'}])
    assert _stored(table) == before


def test_the_assistant_writing_a_persons_value_as_it_is_leaves_it_the_persons(table):
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=ADA, workspace=None)
    answer = pc.update_context('p1', {'product_name': 'Acme Notes', 'one_liner': 'Fast'}, actor=MCP, workspace=None)
    assert 'conflicts' not in answer
    assert (_meta(table)['product_name']['by'], _meta(table)['one_liner']['by']) == ('person', 'assistant')


def test_the_assistant_replaces_its_own_or_an_empty_value_never_an_unattributed_one(table):
    # Review S1 (7.104.00 round 1): a value written before field_meta existed (no entry) is a person's.
    table.put_item(Item={**CONTEXT_KEY, 'key_features': 'Old list', 'updated_at': '2026-01-01T00:00:00+00:00'})
    pc.update_context('p1', {'one_liner': 'Fast'}, actor=MCP, workspace=None)
    answer = pc.update_context('p1', {'one_liner': 'Faster', 'key_features': 'Search'}, actor=MCP, workspace=None)
    assert answer['conflicts'] == [{'field': 'key_features', 'reason': 'person_value'}]
    assert (_stored(table)['one_liner'], _stored(table)['key_features']) == ('Faster', 'Old list')
    # A person replaces any.
    assert 'conflicts' not in pc.update_context('p1', {'one_liner': 'Fastest', 'key_features': 'Search'}, actor=ADA, workspace=None)
    assert (_stored(table)['one_liner'], _stored(table)['key_features']) == ('Fastest', 'Search')


def test_a_legacy_list_valued_field_is_a_persons_too(table):
    table.put_item(Item={**CONTEXT_KEY, 'key_features': ['Search', 'Sync'], 'field_meta': {}})
    with pytest.raises(ConflictError):
        pc.update_context('p1', {'key_features': 'Other'}, actor=MCP, workspace=None)
    assert _stored(table)['key_features'] == ['Search', 'Sync']


def test_a_person_typing_between_the_assistants_read_and_write_is_caught_and_read_again(table):
    pc.update_context('p1', {'product_name': 'Acme Notes'}, actor=MCP, workspace=None)
    real = product_proposals.context_state
    reads = []

    def read_then_a_person_types(*args, **kwargs):
        state = real(*args, **kwargs)
        if not reads:
            table.update_item(Key=CONTEXT_KEY, UpdateExpression='SET product_name = :v, field_meta.product_name = :m',
                              ExpressionAttributeValues={':v': 'Typed', ':m': {'by': 'person', 'sub': 'sub-ada'}})
        reads.append(state)
        return state

    with patch.object(product_proposals, 'context_state', side_effect=read_then_a_person_types), \
            pytest.raises(ConflictError) as refused:
        pc.update_context('p1', {'product_name': 'Acme AI'}, actor=MCP, workspace=None)
    assert (len(reads), refused.value.details['conflicts']) == (2, [{'field': 'product_name', 'reason': 'person_value'}])
    assert _stored(table)['product_name'] == 'Typed'
