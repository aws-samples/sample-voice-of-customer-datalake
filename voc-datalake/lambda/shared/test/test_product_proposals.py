"""A product proposal's review (7.104.00, shared/product_proposals.py) on a moto voc-projects, where DynamoDB really
evaluates each condition: an accept writes the fields still at the value the reviewer saw, records who wrote them
and an audit row, and never lets an autonomous caller replace a value a person typed."""
from __future__ import annotations

import inspect
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import product_proposals as proposals
from shared.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    TooManyRequestsError,
    ValidationError,
)
from shared.project_keys import NotPerWorkspaceError, project_pk
from shared.test.moto_tables import create_pk_sk_table
from shared.test.product_extract_fixtures import PROJECT, World
from shared.test.product_extract_fixtures import world as extract_world
from shared.ws_repo import WorkspaceScope

NOW = datetime(2026, 11, 26, 12, 0, tzinfo=UTC)
PERSON = proposals.Actor(sub='editor-sub', kind='user', autonomous=False)
MCP = proposals.Actor(sub='mcp:tok1', kind='mcp', autonomous=True)
world = extract_world


def _field(value: str, status: str = 'proposed', seen: str = '', source_id: str = 'S1') -> dict[str, Any]:
    return {'status': status, 'value': value, 'confidence': 'high', 'note': '', 'seen': seen, 'accepted': False,
            'citations': [{'source_id': source_id, 'quote': value, 'page': None, 'verified': True}]}


def _proposal(world: World, at: datetime = NOW, **fields: dict[str, Any]) -> str:
    proposal_id, key = proposals.new_proposal_key(PROJECT, at, workspace=None)
    gaps = {name: {'status': 'gap', 'value': '', 'citations': [], 'confidence': 'low', 'note': '', 'seen': '',
                   'accepted': False} for name in proposals.FIELD_ORDER}
    proposals.put_proposal(world.table, PROJECT, {
        **key, 'proposal_id': proposal_id, 'status': 'open', 'job_id': 'job_1', 'created_at': '2026-11-26T12:00:00',
        'model': {'id': 'global.anthropic.claude-sonnet-5-5', 'effort': 'max'},
        'sources': [{'source_id': 'S1', 'doc_id': 'doc_a', 'name': 'a.md', 'kind': 'file', 'chars_sent': 10,
                     'cut': False},
                    {'source_id': 'S2', 'doc_id': 'doc_b', 'name': 'b.md', 'kind': 'file', 'chars_sent': 10,
                     'cut': False}],
        'skipped_sources': [], 'fields': {**gaps, **fields}, 'questions': []}, workspace=None)
    return proposal_id


def _context(world: World) -> dict[str, Any]:
    return world.table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_CONTEXT'}).get('Item') or {}


def _row(world: World, proposal_id: str) -> dict[str, Any]:
    return proposals.consistent_item(world.table, proposals._proposal_key(PROJECT, proposal_id, workspace=None)) or {}


def _audits(world: World) -> list[dict[str, Any]]:
    return [item for item in world.table.scan()['Items'] if item['pk'] == 'AUDIT#product_context']


class TestAccept:
    def test_one_field_is_written_with_who_wrote_it_and_the_rest_left(self, world):
        world.context(product_name='', one_liner='Trips', field_meta={'one_liner': {'by': 'person', 'sub': 'x'}})
        pid = _proposal(world, product_name=_field('Orbit'), target_users=_field('Remote teams', source_id='S2'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert result == {'applied': ['product_name'], 'conflicts': [], 'status': 'partly_applied'}
        context = _context(world)
        assert (context['product_name'], context['one_liner']) == ('Orbit', 'Trips')
        meta = context['field_meta']['product_name']
        assert (meta['by'], meta['sub'], meta['proposal_id'], meta['source_ids']) == (
            'extract', 'editor-sub', pid, ['doc_a'])
        assert context['field_meta']['one_liner'] == {'by': 'person', 'sub': 'x'}

    def test_accepting_every_proposed_field_applies_the_proposal(self, world):
        pid = _proposal(world, product_name=_field('Orbit'), target_users=_field('Remote teams'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': ''}, 'target_users': {'seen': ''}}}, PERSON, workspace=None)
        assert result['status'] == 'applied'
        row = _row(world, pid)
        assert (row['status'], row['fields']['product_name']['accepted']) == ('applied', True)

    def test_the_first_accept_makes_the_context_row(self, world):
        pid = _proposal(world, one_liner=_field('Trips for teams'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {'one_liner': {'seen': ''}}}, PERSON, workspace=None)
        context = _context(world)
        assert (context['one_liner'], context['product_name'], context['field_meta']['one_liner']['by']) == (
            'Trips for teams', '', 'extract')

    def test_an_edited_value_is_written_capped(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': '', 'value': 'O' * 300}}},
                         PERSON, workspace=None)
        assert _context(world)['product_name'] == 'O' * 200

    def test_a_value_the_reviewer_edited_is_recorded_as_theirs_with_the_proposal_and_its_sources(self, world):
        # Review S2 (7.104.00 round 1): an edited value was recorded `by: extract`, so an MCP client could replace it.
        pid = _proposal(world, product_name=_field('Orbit'), one_liner=_field('Trips'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': '', 'value': 'Orbit Travel'}, 'one_liner': {'seen': '', 'value': 'Trips'}}},
            PERSON, workspace=None)
        meta = _context(world)['field_meta']
        assert (meta['product_name']['by'], meta['product_name']['proposal_id'],
                meta['product_name']['source_ids']) == ('person', pid, ['doc_a'])
        assert meta['one_liner']['by'] == 'extract'
        # ...so an autonomous caller never replaces it afterwards.
        newer = _proposal(world, NOW.replace(second=5), product_name=_field('Orbit 3', status='conflict',
                                                                         seen='Orbit Travel'))
        with pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, newer, {'fields': {'product_name': {'seen': 'Orbit Travel'}}}, MCP, workspace=None)
        assert refused.value.details['conflicts'] == [{'field': 'product_name', 'reason': 'person_value'}]

    def test_an_autonomous_callers_own_edit_is_recorded_as_the_assistants(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': '', 'value': 'Orb'}}}, MCP, workspace=None)
        assert _context(world)['field_meta']['product_name']['by'] == 'assistant'

    def test_a_field_changed_since_the_extract_is_a_conflict(self, world):
        world.context(product_name='Orbit X', one_liner='')
        pid = _proposal(world, product_name=_field('Orbit'), one_liner=_field('Trips'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': ''}, 'one_liner': {'seen': ''}}}, PERSON, workspace=None)
        assert result['conflicts'] == [{'field': 'product_name', 'reason': 'changed'}]
        assert (_context(world)['product_name'], _context(world)['one_liner']) == ('Orbit X', 'Trips')

    def test_every_field_in_conflict_is_a_409_carrying_the_conflicts(self, world):
        world.context(product_name='Orbit X')
        pid = _proposal(world, product_name=_field('Orbit'))
        with pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert refused.value.details['conflicts'] == [{'field': 'product_name', 'reason': 'changed'}]
        assert refused.value.code == 'conflict'
        assert _audits(world) == []

    def test_a_race_is_read_again_once(self, world):
        world.context(product_name='')
        pid = _proposal(world, product_name=_field('Orbit'))
        real = proposals.context_state
        reads = []

        def racing(table: Any, project_id: str, *, workspace: Any):
            state = real(table, project_id, workspace=workspace)
            if not reads:
                world.context(product_name='Typed meanwhile')
            reads.append(state)
            return state
        with patch.object(proposals, 'context_state', side_effect=racing), pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert len(reads) == 2
        assert refused.value.details['conflicts'] == [{'field': 'product_name', 'reason': 'changed'}]
        assert _context(world)['product_name'] == 'Typed meanwhile'

    @pytest.mark.parametrize(('codes', 'refusal', 'code', 'attempts'), [
        (['None', 'ConditionalCheckFailed', 'None', 'None'], ServiceUnavailableError, 'busy', 2),
        (['None', 'None', 'ConditionalCheckFailed', 'None'], ServiceUnavailableError, 'busy', 2),
        (['ConditionalCheckFailed', 'None', 'None', 'None'], NotFoundError, None, 1),
        (['None', 'TransactionConflict', 'None', 'None'], ServiceUnavailableError, 'busy', 1),
        (['ThrottlingError', 'None', 'None', 'None'], ClientError, None, 1),
    ], ids=['context-race', 'proposal-race', 'project-gone', 'contention', 'other'])
    def test_a_cancelled_accept_is_read_by_its_entries_through_shared_aws(self, world, codes, refusal, code, attempts):
        # shared/aws.py cancelled_by_condition: a race on the context or on the proposal is read again once (a race
        # lost twice is 503 busy), the project's condition answers its own refusal, and contention
        # (TransactionConflict, no condition failed) is a transient 503, never taken for a changed field.
        world.context(product_name='')
        pid = _proposal(world, product_name=_field('Orbit'))
        cancelled = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
                                 'CancellationReasons': [{'Code': one} for one in codes]}, 'TransactWriteItems')
        with patch.object(proposals, 'transact_project_actions', side_effect=cancelled) as write, \
                pytest.raises(refusal) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert (write.call_count, getattr(refused.value, 'code', None)) == (attempts, code)

    def test_a_proposal_closed_between_the_read_and_the_write_is_read_again_and_refused(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        real = proposals.transact_project_actions
        calls = []

        def dismissed_meanwhile(*args: Any, **kwargs: Any) -> None:
            calls.append(1)
            if len(calls) == 1:
                proposals.dismiss(world.table, PROJECT, pid, workspace=None)
            real(*args, **kwargs)
        with patch.object(proposals, 'transact_project_actions', side_effect=dismissed_meanwhile), \
                pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert (len(calls), refused.value.code) == (1, 'proposal_closed')
        assert _context(world) == {}

    def test_two_accepts_at_once_keep_each_others_marks(self, world):
        # Review Q5 (7.104.00 round 1): the proposal was read once, before the write, so a second accept's update
        # wrote its status from stale marks ("partly_applied" with every field accepted).
        pid = _proposal(world, product_name=_field('Orbit'), one_liner=_field('Trips'))
        real = proposals.transact_project_actions
        calls = []

        def another_accept_meanwhile(*args: Any, **kwargs: Any) -> None:
            calls.append(1)
            if len(calls) == 1:
                proposals.accept(world.table, PROJECT, pid, {'fields': {'one_liner': {'seen': ''}}}, PERSON, workspace=None)
            real(*args, **kwargs)
        with patch.object(proposals, 'transact_project_actions', side_effect=another_accept_meanwhile):
            result = proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        row = _row(world, pid)
        assert (result['status'], row['status']) == ('applied', 'applied')
        assert (row['fields']['product_name']['accepted'], row['fields']['one_liner']['accepted']) == (True, True)

    def test_an_autonomous_caller_never_replaces_a_value_a_person_typed(self, world):
        world.context(product_name='Orbit', one_liner='Trips', field_meta={
            'product_name': {'by': 'person'}, 'one_liner': {'by': 'extract'}})
        pid = _proposal(world, product_name=_field('Orbit 2', status='conflict', seen='Orbit'),
                        one_liner=_field('Trips for teams', seen='Trips'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': 'Orbit'}, 'one_liner': {'seen': 'Trips'}}}, MCP, workspace=None)
        assert result['conflicts'] == [{'field': 'product_name', 'reason': 'person_value'}]
        assert (_context(world)['product_name'], _context(world)['one_liner']) == ('Orbit', 'Trips for teams')

    def test_an_autonomous_caller_never_replaces_a_value_written_before_field_meta_existed(self, world):
        # Review S1 (7.104.00 round 1): a value with no field_meta entry (typed before 7.104.00) is a person's.
        world.context(product_name='Orbit', one_liner='Trips', target_users='',
                      field_meta={'one_liner': {'by': 'assistant'}})
        pid = _proposal(world, product_name=_field('Orbit 2', status='conflict', seen='Orbit'),
                        one_liner=_field('Trips for teams', seen='Trips'), target_users=_field('Teams'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': 'Orbit'}, 'one_liner': {'seen': 'Trips'}, 'target_users': {'seen': ''}}}, MCP, workspace=None)
        assert result['conflicts'] == [{'field': 'product_name', 'reason': 'person_value'}]
        context = _context(world)
        assert (context['product_name'], context['one_liner'], context['target_users']) == (
            'Orbit', 'Trips for teams', 'Teams')

    def test_a_row_with_no_field_meta_at_all_keeps_every_value_from_an_autonomous_caller(self, world):
        world.context(product_name='Orbit', one_liner='')
        pid = _proposal(world, product_name=_field('Orbit 2', seen='Orbit'), one_liner=_field('Trips'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {
            'product_name': {'seen': 'Orbit'}, 'one_liner': {'seen': ''}}}, MCP, workspace=None)
        assert (result['applied'], result['conflicts']) == (
            ['one_liner'], [{'field': 'product_name', 'reason': 'person_value'}])
        assert _context(world)['product_name'] == 'Orbit'

    def test_the_write_condition_holds_an_unattributed_value_to_the_rule_too(self, world):
        # The write's own condition (not only the read's check): a value written between the read and the write
        # with no field_meta entry is caught as a person's and read again.
        world.context(product_name='Old', field_meta={'product_name': {'by': 'assistant'}})
        pid = _proposal(world, product_name=_field('New', seen='Old'))
        real = proposals.context_state
        reads = []

        def unattributed_meanwhile(table: Any, project_id: str, *, workspace: Any):
            state = real(table, project_id, workspace=workspace)
            if not reads:
                world.context(product_name='Old', field_meta={})
            reads.append(state)
            return state
        with patch.object(proposals, 'context_state', side_effect=unattributed_meanwhile), \
                pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': 'Old'}}}, MCP, workspace=None)
        assert (len(reads), refused.value.details['conflicts']) == (
            2, [{'field': 'product_name', 'reason': 'person_value'}])

    def test_the_person_accepts_their_own_typed_value_being_replaced(self, world):
        world.context(product_name='Orbit', field_meta={'product_name': {'by': 'person'}})
        pid = _proposal(world, product_name=_field('Orbit 2', status='conflict', seen='Orbit'))
        result = proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': 'Orbit'}}}, PERSON, workspace=None)
        assert result['applied'] == ['product_name']

    def test_each_accept_writes_an_audit_row_of_ids_only(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        [audit] = _audits(world)
        assert {key: audit[key] for key in ('kind', 'project_id', 'proposal_id', 'fields', 'actor', 'model_id')} == {
            'kind': 'product_proposal_accepted', 'project_id': PROJECT, 'proposal_id': pid,
            'fields': ['product_name'], 'actor': {'sub': 'editor-sub', 'kind': 'user'},
            'model_id': 'global.anthropic.claude-sonnet-5-5'}
        assert 'Orbit' not in str(audit)

    @pytest.mark.parametrize(('body', 'message'), [
        ({}, 'fields must map'), ({'fields': {'pricing': {'seen': ''}}}, 'Unknown field: pricing'),
        ({'fields': {'product_name': {}}}, 'product_name needs the value it was seen at'),
        ({'fields': {'one_liner': {'seen': ''}}}, 'one_liner has no proposed value'),
        ({'fields': {'product_name': {'seen': '', 'value': '  '}}}, 'product_name needs a value'),
    ])
    def test_a_malformed_accept_is_a_400(self, world, body, message):
        pid = _proposal(world, product_name=_field('Orbit'))
        with pytest.raises(ValidationError, match=message):
            proposals.accept(world.table, PROJECT, pid, body, PERSON, workspace=None)

    def test_a_dismissed_proposal_cannot_be_accepted(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        proposals.dismiss(world.table, PROJECT, pid, workspace=None)
        with pytest.raises(ConflictError) as refused:
            proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        assert refused.value.code == 'proposal_closed'

    @pytest.mark.parametrize('proposal_id', ['pp_nope', 'pp_20261126T120000000000Z_000000000000', '../x'])
    def test_an_unknown_proposal_is_a_404(self, world, proposal_id):
        with pytest.raises(NotFoundError):
            proposals.accept(world.table, PROJECT, proposal_id, {'fields': {}}, PERSON, workspace=None)


class TestDismissAndSupersede:
    def test_dismiss_is_idempotent(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        assert proposals.dismiss(world.table, PROJECT, pid, workspace=None) == {'proposal_id': pid, 'status': 'dismissed'}
        assert proposals.dismiss(world.table, PROJECT, pid, workspace=None) == {'proposal_id': pid, 'status': 'dismissed'}

    def test_an_applied_proposal_cannot_be_dismissed(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        proposals.accept(world.table, PROJECT, pid, {'fields': {'product_name': {'seen': ''}}}, PERSON, workspace=None)
        with pytest.raises(ConflictError):
            proposals.dismiss(world.table, PROJECT, pid, workspace=None)

    def test_a_new_proposal_supersedes_an_open_one_but_not_a_dismissed_one(self, world):
        dismissed = _proposal(world, product_name=_field('A'))
        proposals.dismiss(world.table, PROJECT, dismissed, workspace=None)
        opened = _proposal(world, NOW.replace(second=1), product_name=_field('B'))
        newest = _proposal(world, NOW.replace(second=2), product_name=_field('C'))
        assert [_row(world, pid)['status'] for pid in (dismissed, opened, newest)] == [
            'dismissed', 'superseded', 'open']
        assert (proposals.latest_row(world.table, PROJECT, workspace=None) or {}).get('proposal_id') == newest

    def test_a_proposal_for_a_deleted_project_is_refused(self, world):
        world.table.update_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'},
                                UpdateExpression='SET deletion_started_at = :now', ExpressionAttributeValues={':now': 1})
        with pytest.raises(proposals.ClientError):
            _proposal(world, product_name=_field('Orbit'))


class TestTheDto:
    def test_each_field_says_its_current_value_and_whether_it_changed_since(self, world):
        world.context(product_name='Orbit X', one_liner=['Trips', 'for teams'])
        pid = _proposal(world, product_name=_field('Orbit'), one_liner=_field('Trips', seen='Trips\nfor teams'))
        dto = proposals.proposal_dto(_row(world, pid), proposals.context_state(world.table, PROJECT, workspace=None), ['doc_a'])
        assert (dto['fields']['product_name']['current'], dto['fields']['product_name']['changed_since']) == (
            'Orbit X', True)
        assert dto['fields']['one_liner']['changed_since'] is False
        assert [(source['source_id'], source['deleted']) for source in dto['sources']] == [('S1', False), ('S2', True)]
        assert (dto['proposal_id'], dto['model_id'], dto['effort']) == (pid, 'global.anthropic.claude-sonnet-5-5',
                                                                        'max')
        assert dto['sources'][0]['chars_sent'] == 10


class TestTheLock:
    def test_one_extract_holds_it_until_released(self, world):
        assert proposals.take_lock(world.table, PROJECT, 'a', 'editor-sub', NOW, workspace=None)
        assert not proposals.take_lock(world.table, PROJECT, 'b', 'editor-sub', NOW, workspace=None)
        proposals.release_lock(world.table, PROJECT, 'b', workspace=None)
        assert not proposals.take_lock(world.table, PROJECT, 'b', 'editor-sub', NOW, workspace=None)
        proposals.release_lock(world.table, PROJECT, 'a', workspace=None)
        assert proposals.take_lock(world.table, PROJECT, 'b', 'editor-sub', NOW, workspace=None)

    def test_a_stale_lock_is_taken_over(self, world):
        assert proposals.take_lock(world.table, PROJECT, 'a', 'editor-sub', NOW, workspace=None)
        later = datetime.fromtimestamp(NOW.timestamp() + proposals.LOCK_STALE_SECONDS + 1, UTC)
        assert proposals.take_lock(world.table, PROJECT, 'b', 'editor-sub', later, workspace=None)

    def test_it_names_its_job(self, world):
        proposals.take_lock(world.table, PROJECT, 'a', 'editor-sub', NOW, workspace=None)
        proposals.note_lock_job(world.table, PROJECT, 'a', 'job_1', workspace=None)
        lock = world.table.get_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'PRODUCT_EXTRACT'})['Item']
        assert (lock['job_id'], lock['started_by']) == ('job_1', 'editor-sub')


class TestTheLimits:
    @pytest.fixture
    def aggregates(self, request):
        request.getfixturevalue('world')  # inside its moto context
        return create_pk_sk_table('test-aggregates')

    def test_one_extract_a_minute_per_project(self, aggregates):
        proposals.count_extract(aggregates, PROJECT, 'editor-sub', NOW)
        with pytest.raises(TooManyRequestsError) as limited:
            proposals.count_extract(aggregates, PROJECT, 'other-sub', NOW)
        assert limited.value.code == 'rate_limited'

    def test_ten_a_day_per_project(self, aggregates):
        for minute in range(proposals.PROJECT_EXTRACTS_PER_DAY):
            proposals.count_extract(aggregates, PROJECT, f'sub-{minute}', NOW.replace(minute=minute))
        with pytest.raises(TooManyRequestsError):
            proposals.count_extract(aggregates, PROJECT, 'sub-new', NOW.replace(minute=30))

    def test_twenty_a_day_per_person(self, aggregates):
        for index in range(proposals.PERSON_EXTRACTS_PER_DAY):
            proposals.count_extract(aggregates, f'p{index}', 'editor-sub', NOW)
        with pytest.raises(TooManyRequestsError):
            proposals.count_extract(aggregates, 'p-new', 'editor-sub', NOW)

    def test_a_refused_extract_counts_against_no_limit(self, aggregates):
        # Review Q4 (7.104.00 round 1): the limits were counted one by one, so a person at their day's limit still
        # spent the project's minute and day.
        for index in range(proposals.PERSON_EXTRACTS_PER_DAY):
            proposals.count_extract(aggregates, f'p{index}', 'editor-sub', NOW)
        with pytest.raises(TooManyRequestsError) as limited:
            proposals.count_extract(aggregates, 'p-new', 'editor-sub', NOW)
        assert limited.value.code == 'rate_limited'
        assert not [row for row in aggregates.scan()['Items'] if 'p-new' in row['pk']]
        proposals.count_extract(aggregates, 'p-new', 'other-sub', NOW)

    def test_the_counters_expire_after_two_days(self, aggregates):
        proposals.count_extract(aggregates, PROJECT, 'editor-sub', NOW)
        rows = aggregates.scan()['Items']
        assert {row['pk'] for row in rows} == {
            'PRODUCTX#PROJECT#p1#202611261200', 'PRODUCTX#PROJECT#p1#2026-11-26', 'PRODUCTX#USER#editor-sub#2026-11-26'}
        assert {int(row['ttl']) for row in rows} == {int(NOW.timestamp()) + 2 * 86_400}


class TestTheRule:
    @pytest.mark.parametrize(('value', 'meta', 'by'), [
        ('Orbit', {'by': 'person'}, 'person'), ('Orbit', {'by': 'extract'}, 'extract'),
        ('Orbit', {'by': 'assistant'}, 'assistant'), ('Orbit', None, 'person'), ('', {'by': 'person'}, None),
        (['Orbit', 'Notes'], None, 'person'),
    ], ids=['person', 'extract', 'assistant', 'no-entry', 'empty', 'legacy-list'])
    def test_who_wrote_a_field_and_whether_a_person_typed_it(self, world, value, meta, by):
        world.context(product_name=value, **({'field_meta': {'product_name': meta}} if meta else {}))
        state = proposals.context_state(world.table, PROJECT, workspace=None)
        assert (proposals.written_by(state, 'product_name'), proposals.person_typed(state, 'product_name')) == (
            by, by == 'person')


class TestTheContextsPut:
    """PUT …/product-context's write (write_context): an accept of the values just read."""

    def test_the_first_write_makes_the_row_with_every_field_and_who_wrote_it(self, world):
        assert proposals.write_context(world.table, PROJECT, {'product_name': 'Orbit'}, PERSON, workspace=None) == []
        context = _context(world)
        assert (context['product_name'], context['one_liner'], context['field_meta']['product_name']['by']) == (
            'Orbit', '', 'person')

    def test_an_autonomous_caller_writes_the_rest_and_answers_the_persons_fields(self, world):
        world.context(product_name='Orbit', non_goals='No video', field_meta={'non_goals': {'by': 'person'}})
        conflicts = proposals.write_context(world.table, PROJECT, {
            'product_name': 'Orbit AI', 'non_goals': 'Video', 'one_liner': 'Trips'}, MCP, workspace=None)
        assert conflicts == [{'field': 'product_name', 'reason': 'person_value'},
                             {'field': 'non_goals', 'reason': 'person_value'}]
        context = _context(world)
        assert (context['product_name'], context['non_goals'], context['one_liner']) == ('Orbit', 'No video', 'Trips')
        assert context['field_meta']['one_liner']['by'] == 'assistant'

    def test_a_write_on_a_deleted_project_is_a_404(self, world):
        world.table.update_item(Key={'pk': f'PROJECT#{PROJECT}', 'sk': 'META'},
                                UpdateExpression='SET deletion_started_at = :now', ExpressionAttributeValues={':now': 1})
        with pytest.raises(NotFoundError):
            proposals.write_context(world.table, PROJECT, {'product_name': 'Orbit'}, PERSON, workspace=None)


class TestADeletedSource:
    def test_its_citations_leave_every_proposal_and_the_rest_stays(self, world):
        # Review S3 (7.104.00 round 1): a deleted source's quoted words stayed in every proposal that cited it.
        field = _field('Orbit')
        field['citations'] = [{'source_id': 'S1', 'quote': 'Orbit plans trips', 'page': None, 'verified': True},
                              {'source_id': 'S2', 'quote': 'Orbit is for teams', 'page': None, 'verified': True}]
        older = _proposal(world, product_name=field, one_liner=_field('Trips', source_id='S2'))
        proposals.dismiss(world.table, PROJECT, older, workspace=None)
        newer = _proposal(world, NOW.replace(second=3), product_name=_field('Orbit'))
        assert proposals.forget_source(world.table, PROJECT, 'doc_a', workspace=None) == 2
        old_row, new_row = _row(world, older), _row(world, newer)
        assert [c['source_id'] for c in old_row['fields']['product_name']['citations']] == ['S2']
        assert [c['source_id'] for c in old_row['fields']['one_liner']['citations']] == ['S2']
        assert new_row['fields']['product_name']['citations'] == []
        assert 'Orbit plans trips' not in str(old_row)
        assert (new_row['fields']['product_name']['value'], old_row['status']) == ('Orbit', 'dismissed')
        dto = proposals.proposal_dto(new_row, proposals.context_state(world.table, PROJECT, workspace=None), ['doc_b'])
        assert [(source['doc_id'], source['deleted']) for source in dto['sources']] == [
            ('doc_a', True), ('doc_b', False)]

    def test_a_proposal_changed_meanwhile_is_read_again(self, world):
        pid = _proposal(world, product_name=_field('Orbit'), one_liner=_field('Trips', source_id='S2'))
        real = proposals.update_unless_condition_fails
        calls = []

        def changed_first(table: Any, **update: Any) -> bool:
            calls.append(1)
            if len(calls) == 1:
                world.table.update_item(Key=proposals._proposal_key(PROJECT, pid, workspace=None),
                                        UpdateExpression='SET #f.#n.citations = :c',
                                        ExpressionAttributeNames={'#f': 'fields', '#n': 'product_name'},
                                        ExpressionAttributeValues={':c': [
                                            {'source_id': 'S1', 'quote': 'Orbit again', 'page': None}]})
            return real(table, **update)
        with patch.object(proposals, 'update_unless_condition_fails', side_effect=changed_first):
            proposals.forget_source(world.table, PROJECT, 'doc_a', workspace=None)
        assert (len(calls), _row(world, pid)['fields']['product_name']['citations']) == (2, [])

    def test_a_proposal_citing_no_such_source_is_left_alone(self, world):
        pid = _proposal(world, product_name=_field('Orbit'))
        before = _row(world, pid)
        assert proposals.forget_source(world.table, PROJECT, 'doc_other', workspace=None) == 0
        assert _row(world, pid) == before


class TestTheWorkspace:
    """The store's scope (7.104.00, docs/multi-workspace.md 3h): every key takes the workspace, a required keyword,
    and every public function refuses one (``PRODUCT_SOURCES_STORE``) before it reads or writes anything."""

    SCOPE = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
    REFUSALS: ClassVar[dict[str, Callable[[Any, WorkspaceScope], object]]] = {
        'context_state': lambda table, ws: proposals.context_state(table, PROJECT, workspace=ws),
        'put_proposal': lambda table, ws: proposals.put_proposal(table, PROJECT, {'sk': 'x'}, workspace=ws),
        'latest_row': lambda table, ws: proposals.latest_row(table, PROJECT, workspace=ws),
        'dismiss': lambda table, ws: proposals.dismiss(table, PROJECT, 'pp_x', workspace=ws),
        'write_context': lambda table, ws: proposals.write_context(table, PROJECT, {'product_name': 'x'}, PERSON,
                                                                   workspace=ws),
        'accept': lambda table, ws: proposals.accept(table, PROJECT, 'pp_x', {'fields': {}}, PERSON, workspace=ws),
        'forget_source': lambda table, ws: proposals.forget_source(table, PROJECT, 'doc_a', workspace=ws),
        'take_lock': lambda table, ws: proposals.take_lock(table, PROJECT, 'lock-1', 'sub', NOW, workspace=ws),
        'note_lock_job': lambda table, ws: proposals.note_lock_job(table, PROJECT, 'lock-1', 'job_1', workspace=ws),
        'release_lock': lambda table, ws: proposals.release_lock(table, PROJECT, 'lock-1', workspace=ws),
    }

    @pytest.mark.parametrize('name', sorted(REFUSALS))
    def test_a_workspace_is_refused_before_any_read_or_write(self, name):
        table = MagicMock()
        with pytest.raises(NotPerWorkspaceError, match=r'^Product sources is not per workspace yet$'):
            self.REFUSALS[name](table, self.SCOPE)
        assert table.mock_calls == []

    def test_every_public_function_that_takes_a_workspace_is_one_of_those_refusals(self):
        takes = {name for name in proposals.__all__ if callable(getattr(proposals, name))
                 and 'workspace' in inspect.signature(getattr(proposals, name)).parameters}
        assert takes - {'new_proposal_key'} == set(self.REFUSALS)

    @pytest.mark.parametrize('scope', [None, SCOPE], ids=['deployment', 'workspace'])
    def test_a_new_proposals_key_is_in_its_scopes_project_partition(self, scope):
        proposal_id, key = proposals.new_proposal_key(PROJECT, NOW, workspace=scope)
        assert key['pk'] == project_pk(PROJECT, workspace=scope)
        assert key == proposals._proposal_key(PROJECT, proposal_id, workspace=scope)
