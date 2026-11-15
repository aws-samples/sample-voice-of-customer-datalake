"""voc-participants' people and lists per workspace (docs/multi-workspace.md, the project plan, 3d; 7.31.00).

shared/participants_store.py, shared/participants_lists.py, shared/participants_intake.py and
shared/participants_erasure.py take a keyword-only ``workspace``: in one, a person is ``WS#{ws}#PERSON#{id}``, its
guard ``WS#{ws}#EMAIL#{sha}``, a list ``WS#{ws}#LIST#{id}``, their ``gsi1`` partitions ``WS#{ws}#PEOPLE`` /
``WS#{ws}#LISTS``, a project's links ``WS#{ws}#PROJECT#{id}``, every call through shared/ws_repo.py ``ws_table``, and
each partition listed first in ``WS#{ws}#PARTICIPANTS``; without one every request is the one sent before (pinned
below on a recording table). Three scopes hold the same ids here: the deployment and two workspaces.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import nullcontext
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import participants_erasure, participants_lists, participants_store, participants_tables
from shared.exceptions import NotFoundError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.participants_asks import asks_of_person, create_ask, token_workspace
from shared.participants_erasure import erase_person
from shared.participants_intake import collect_people
from shared.participants_keys import (
    email_guard_key,
    indexed_partitions,
    list_partition,
    member_key,
    membership_key,
    participants_index_key,
    participants_index_pk,
    person_key,
    project_link_key,
)
from shared.participants_lists import (
    add_member,
    all_lists,
    create_list,
    delete_list,
    get_list,
    get_lists,
    link,
    list_ids_of_person,
    member_ids,
    project_links,
    remove_member,
    unlink,
    update_list,
)
from shared.participants_store import (
    create_person,
    find_person_id,
    get_people,
    get_person,
    list_people,
    mark_unsubscribed,
    remember_token,
    update_person,
)
from shared.participants_tables import scoped_calls, unlist_if_empty
from shared.project_keys import NotPerWorkspaceError, project_pk
from shared.test.moto_tables import create_table_with_gsi1
from shared.ws_repo import WORKSPACE_FIELD, OutOfScopeError, WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
A = WorkspaceScope(WS_A)
B = WorkspaceScope(WS_B)
SCOPES = (None, A, B)
LIST_ID = 'lst_0123456789abcdef'
PERSON_ID = 'per_0123456789abcdef'
NEW_PERSON_ID = 'per_aaaaaaaaaaaaaaaa'
PROJECT = 'proj_shared_id'
EMAIL = 'pat@example.com'
#: The address guard's partition without a workspace prefix: the index row's ``sk`` in a workspace.
GUARD = email_guard_key(EMAIL)['pk']
ACTOR = {'sub': 'sub-ada', 'kind': 'admin'}
OPEN = {'allow_external_people': True, 'company_domains': []}


@pytest.fixture
def table() -> Iterator[Any]:
    """voc-participants with its ``gsi1``, every new id the same in each scope (``lst_…``, ``per_…``)."""
    ids = {'lst': LIST_ID, 'per': PERSON_ID}
    with mock_aws(), patch.object(participants_store, 'new_id', ids.get), \
            patch.object(participants_lists, 'new_id', ids.get):
        yield create_table_with_gsi1(boto3.resource('dynamodb', region_name='us-east-1'), 'test-participants',
                                     PARTICIPANTS_LISTING_INDEX)


def _seed(table: Any, scope: WorkspaceScope | None, name: str) -> None:
    """A list named ``name`` with one member, linked to the project, in ``scope``."""
    create_list(table, {'name': name, 'gsi1sk': name.lower(), 'description': '', 'kind': 'beta'}, 'sub-ada',
                workspace=scope)
    create_person(table, email=EMAIL, email_lc=EMAIL, fields={'name': name}, origin='manual', created_by='sub-ada',
                  workspace=scope)
    add_member(table, LIST_ID, PERSON_ID, 'sub-ada', workspace=scope)
    link(table, PROJECT, 'LIST', LIST_ID, 'sub-ada', workspace=scope)


def _rows_of(table: Any, scope: WorkspaceScope | None) -> list[dict]:
    """Every row of the scope's partitions (the deployment's: every row not ``WS#``, its audit partitions aside,
    which every scope's erasure records in)."""
    items = table.scan(ConsistentRead=True)['Items']
    if scope is None:
        return sorted((row for row in items if not str(row['pk']).startswith(('WS#', 'AUDIT#'))), key=str)
    return sorted((row for row in items if str(row['pk']).startswith(scope.prefix)), key=str)


@pytest.fixture
def seeded(table: Any) -> Any:
    for scope, name in zip(SCOPES, ('Deployment list', 'Acme list', 'Birch list'), strict=True):
        _seed(table, scope, name)
    return table


# ── Keys ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_without_a_workspace_every_key_is_the_deployments():
    assert person_key(PERSON_ID) == {'pk': f'PERSON#{PERSON_ID}', 'sk': 'META'}
    assert list_partition(LIST_ID) == f'LIST#{LIST_ID}'
    assert person_key(PERSON_ID, workspace=A) == {'pk': f'WS#{WS_A}#PERSON#{PERSON_ID}', 'sk': 'META'}


def test_the_index_names_a_list_person_or_guard_of_its_own_workspace_only():
    assert participants_index_key(list_partition(LIST_ID, workspace=A), workspace=A) == {
        'pk': f'WS#{WS_A}#PARTICIPANTS', 'sk': f'LIST#{LIST_ID}'}
    for partition in (list_partition(LIST_ID), list_partition(LIST_ID, workspace=B), f'WS#{WS_A}#PROJECT#p',
                      f'WS#{WS_A}#LIST#'):
        with pytest.raises(ValueError, match='participants index'):
            participants_index_key(partition, workspace=A)
    assert indexed_partitions(A, {'sk': f'PERSON#{PERSON_ID}'}) == [f'WS#{WS_A}#PERSON#{PERSON_ID}']
    assert [indexed_partitions(A, {'sk': sk}) for sk in ('META', 'PERSON#', None)] == [[], [], []]


# ── The stores: three scopes, the same ids ──────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize('scope', SCOPES)
def test_each_scope_reads_its_own_list_person_and_links(seeded, scope):
    name = {None: 'Deployment list', A: 'Acme list', B: 'Birch list'}[scope]
    assert [row['name'] for row in all_lists(seeded, workspace=scope)] == [name]
    assert [row['name'] for row in list_people(seeded, 'pat', workspace=scope)] == [name]
    assert (member_ids(seeded, LIST_ID, workspace=scope), list_ids_of_person(seeded, PERSON_ID, workspace=scope),
            project_links(seeded, PROJECT, workspace=scope)) == ([PERSON_ID], [LIST_ID], ([LIST_ID], []))
    assert (get_lists(seeded, [LIST_ID], workspace=scope)[LIST_ID]['name'],
            get_people(seeded, [PERSON_ID], workspace=scope)[PERSON_ID]['name'],
            find_person_id(seeded, EMAIL, workspace=scope)) == (name, name, PERSON_ID)


def _index(table: Any, scope: WorkspaceScope) -> set[str]:
    return {str(row['sk']) for row in
            table.query(KeyConditionExpression=Key('pk').eq(participants_index_pk(scope)))['Items']}


def test_a_workspace_lists_its_partitions_first_and_the_deployment_keeps_no_index(seeded):
    assert _index(seeded, A) == {f'LIST#{LIST_ID}', f'PERSON#{PERSON_ID}', GUARD}
    assert not [row for row in _rows_of(seeded, None) if 'PARTICIPANTS' in str(row['pk'])]


@pytest.mark.parametrize('scope', SCOPES)
def test_writes_in_one_scope_leave_the_others_untouched(seeded, scope):
    others = {other: _rows_of(seeded, other) for other in SCOPES if other != scope}
    update_list(seeded, LIST_ID, {'description': 'changed'}, workspace=scope)
    update_person(seeded, PERSON_ID, {'title': 'changed'}, workspace=scope)
    assert mark_unsubscribed(seeded, PERSON_ID, workspace=scope)
    unlink(seeded, PROJECT, 'LIST', LIST_ID, workspace=scope)
    assert remove_member(seeded, LIST_ID, PERSON_ID, workspace=scope)
    delete_list(seeded, LIST_ID, workspace=scope)
    assert get_list(seeded, LIST_ID, workspace=scope) is None
    assert {other: _rows_of(seeded, other) for other in others} == others


@pytest.mark.parametrize('scope', [A, B])
def test_a_workspace_list_delete_takes_its_links_keeps_its_people_and_stays_listed(seeded, scope):
    delete_list(seeded, LIST_ID, workspace=scope)
    # Still listed (an opaque id): a membership a concurrent add writes there is still found by the hard delete.
    assert _index(seeded, scope) == {f'LIST#{LIST_ID}', f'PERSON#{PERSON_ID}', GUARD}
    person = get_person(seeded, PERSON_ID, workspace=scope)
    assert person is not None
    assert LIST_ID not in person.get('list_ids', set())
    assert project_links(seeded, PROJECT, workspace=scope) == ([], [])


@pytest.mark.parametrize('scope', SCOPES)
def test_an_erasure_takes_the_scopes_person_only(seeded, scope):
    link(seeded, PROJECT, 'PERSON', PERSON_ID, 'sub-ada', workspace=scope)
    others = {other: _rows_of(seeded, other) for other in SCOPES if other != scope}
    removed = erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    assert removed == {'lists': 1, 'asks': 0, 'tokens': 0, 'projects': 1}
    assert (get_person(seeded, PERSON_ID, workspace=scope), find_person_id(seeded, EMAIL, workspace=scope),
            member_ids(seeded, LIST_ID, workspace=scope)) == (None, None, [])
    assert {other: _rows_of(seeded, other) for other in others} == others


class _BatchFails:
    """The table, but its batch writer fails as a BatchWriteItem would partway (the deployment's erasure batch)."""

    def __init__(self, table: Any) -> None:
        self._table = table

    def __getattr__(self, name: str) -> Any:
        return getattr(self._table, name)

    def batch_writer(self) -> Any:
        raise RuntimeError('the batch failed partway')


@pytest.mark.parametrize('scope', SCOPES)
def test_an_erasure_stopped_after_the_guard_still_finds_the_person_and_frees_the_address(seeded, scope):
    """The guard goes first and ``META`` last, on its own: a failure in between leaves the person findable, so the
    retry erases the rest, and the address is never left guarding the erased id."""
    link(seeded, PROJECT, 'PERSON', PERSON_ID, 'sub-ada', workspace=scope)
    tokens = []
    if scope is None:
        token = {'pk': 'TOKEN#' + 'a' * 64, 'sk': 'UNSUB', 'person_id': PERSON_ID}
        seeded.put_item(Item=token)
        seeded.update_item(Key=person_key(PERSON_ID), UpdateExpression='ADD token_hashes :h',
                           ExpressionAttributeValues={':h': {'a' * 64}})
        tokens = [{'pk': token['pk'], 'sk': 'UNSUB'}]
        broken: Any = _BatchFails(seeded)
        failing: Any = nullcontext()
    else:
        broken = seeded
        failing = patch.object(participants_erasure, 'delete_many', side_effect=RuntimeError('the batch failed partway'))
    with failing, pytest.raises(RuntimeError, match='partway'):
        erase_person(broken, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    assert (get_person(seeded, PERSON_ID, workspace=scope) is not None,
            find_person_id(seeded, EMAIL, workspace=scope)) == (True, None)
    records = _audit(seeded)
    # The address is added again before the retry: the new person's guard is not the erased one's, and stays.
    with patch.object(participants_store, 'new_id', return_value=NEW_PERSON_ID):
        create_person(seeded, email=EMAIL, email_lc=EMAIL, fields={}, origin='manual', created_by='sub-ada',
                      workspace=scope)
    erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    assert (get_person(seeded, PERSON_ID, workspace=scope), find_person_id(seeded, EMAIL, workspace=scope)) == (
        None, NEW_PERSON_ID)
    # One erasure, one record: the retry keeps the first tombstone and adds no second delete record.
    assert _audit(seeded) == records
    # The rest went with the retry: the project link, the list mirror, the tokens.
    left = [*tokens, project_link_key(PROJECT, 'PERSON', PERSON_ID, workspace=scope),
            membership_key(PERSON_ID, LIST_ID, workspace=scope)]
    assert ['Item' in seeded.get_item(Key=key) for key in left] == [False] * len(left)


@pytest.mark.parametrize('scope', SCOPES)
def test_an_add_racing_an_erasure_fails_and_leaves_no_row(seeded, scope):
    """The member row and its mirror are one transaction with a check that the person's META is there: once the
    person is erased, an add writes neither. A repeat add of a member is still False."""
    assert add_member(seeded, LIST_ID, PERSON_ID, 'sub-ada', workspace=scope) is False
    erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    second = 'lst_fedcba9876543210'
    with pytest.raises(NotFoundError, match='Person not found'):
        add_member(seeded, second, PERSON_ID, 'sub-ada', workspace=scope)
    keys = [member_key(second, PERSON_ID, workspace=scope), membership_key(PERSON_ID, second, workspace=scope)]
    assert ['Item' in seeded.get_item(Key=key) for key in keys] == [False, False]


@pytest.mark.parametrize(('conflicts', 'joined'), [(2, True), (3, None)])
def test_an_add_a_concurrent_write_cancels_is_tried_again_a_bounded_number_of_times(seeded, conflicts, joined):
    real, sent = participants_lists.transact, []

    def flaky(table: Any, workspace: Any, entries: Any) -> dict:
        sent.append(entries)
        if len(sent) <= conflicts:
            raise _cancelled('TransactionConflict')
        return real(table, workspace, entries)

    second = 'lst_fedcba9876543210'
    with patch.object(participants_lists, 'transact', flaky):
        if joined is None:
            with pytest.raises(ClientError, match='TransactionCanceled'):
                add_member(seeded, second, PERSON_ID, 'sub-ada', workspace=A)
        else:
            assert add_member(seeded, second, PERSON_ID, 'sub-ada', workspace=A) is joined
    assert len(sent) == participants_lists.ADD_ATTEMPTS


@pytest.mark.parametrize('scope', SCOPES)
def test_an_add_landing_during_an_erasure_is_removed_once_meta_is_gone(seeded, scope):
    """An add that commits after the erasure read the person's lists, while ``META`` is still there, passes its
    check; the erasure reads the person's mirrors again once ``META`` is gone (no add can commit then) and removes
    it."""
    second = 'lst_fedcba9876543210'
    real, reads = participants_erasure._person_rows, []

    def add_after_the_first_read(table: Any, person_id: str, workspace: Any) -> list[dict]:
        found = real(table, person_id, workspace)
        reads.append(found)
        if len(reads) == 1:
            add_member(table, second, person_id, 'sub-ada', workspace=workspace)
        return found

    with patch.object(participants_erasure, '_person_rows', add_after_the_first_read):
        removed = erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    keys = [member_key(second, PERSON_ID, workspace=scope), membership_key(PERSON_ID, second, workspace=scope)]
    assert (removed['lists'], ['Item' in seeded.get_item(Key=key) for key in keys]) == (2, [False, False])


@pytest.mark.parametrize('scope', SCOPES)
def test_an_erasure_whose_record_failed_writes_exactly_one_on_its_retry(seeded, scope):
    """The record is written on every attempt, put only if absent, and its failure fails the erasure: never none."""
    real = participants_erasure.record_delete_once
    calls = []

    def fails_once(*args: Any, **kwargs: Any) -> bool:
        calls.append(kwargs)
        if len(calls) == 1:
            raise ClientError({'Error': {'Code': 'InternalServerError'}}, 'PutItem')
        return real(*args, **kwargs)

    with patch.object(participants_erasure, 'record_delete_once', fails_once):
        with pytest.raises(ClientError, match='InternalServerError'):
            erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
        erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=scope)
    records = [row for row in _audit(seeded) if row['pk'] == 'AUDIT#delete']
    assert ([row['target']['person_id'] for row in records], get_person(seeded, PERSON_ID, workspace=scope)) == (
        [PERSON_ID], None)


def _audit(table: Any) -> list[dict]:
    """Every row of the participants' audit partitions (the tombstones and the delete records)."""
    return sorted((row for row in table.scan(ConsistentRead=True)['Items'] if str(row['pk']).startswith('AUDIT#')),
                  key=str)


def test_a_workspace_erasure_records_a_tombstone_of_its_own_and_leaves_its_index(seeded):
    erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=A)
    tombstones = seeded.query(KeyConditionExpression=Key('pk').eq('AUDIT#tombstone#participant'))['Items']
    assert sorted(str(row['sk']).split('#')[0] for row in tombstones) == [WS_A]
    # The guard's row (the address's hash) goes; the person's (an opaque id) stays for the hard delete.
    assert _index(seeded, A) == {f'LIST#{LIST_ID}', f'PERSON#{PERSON_ID}'}
    records = seeded.query(KeyConditionExpression=Key('pk').eq('AUDIT#delete'))['Items']
    assert [row['target'] for row in records] == [{'person_id': PERSON_ID, WORKSPACE_FIELD: WS_A}]


@pytest.mark.parametrize('scope', [A, B])
def test_intake_resolves_its_workspaces_people_and_refuses_a_new_one(table, scope):
    """The settings that decide who may be added are the deployment's: a new person in a workspace is refused
    before anything is written; the workspace's own people resolve, by id and by address."""
    with pytest.raises(NotPerWorkspaceError, match='Participant settings'):
        collect_people(table, OPEN, {'people': [{'email': EMAIL}]}, created_by='sub-ada', workspace=scope)
    assert table.scan()['Items'] == []
    create_person(table, email=EMAIL, email_lc=EMAIL, fields={}, origin='manual', created_by='sub-ada',
                  workspace=scope)
    again = collect_people(table, OPEN, {'person_ids': [PERSON_ID], 'people': [{'email': EMAIL}]},
                           created_by='sub-ada', workspace=scope)
    assert (again.person_ids, again.created) == ([PERSON_ID], 0)
    with pytest.raises(NotFoundError, match='Person not found'):
        collect_people(table, OPEN, {'person_ids': [PERSON_ID]}, created_by='sub-ada')


# ── Fail closed ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_asks_and_the_tokens_refuse_a_workspace_before_any_call():
    recording = MagicMock()
    with pytest.raises(NotPerWorkspaceError, match='Participant asks'):
        asks_of_person(recording, PERSON_ID, workspace=A)
    with pytest.raises(NotPerWorkspaceError, match='Participant asks'):
        create_ask(recording, {'subject': 's'}, [PERSON_ID], 'sub-ada', workspace=A)
    with pytest.raises(NotPerWorkspaceError, match='Participant asks'):
        remember_token(recording, PERSON_ID, 'h' * 64, unsubscribe=True, workspace=A)
    assert recording.mock_calls == []


def test_a_workspace_person_with_tokens_is_refused_before_anything_is_recorded(seeded):
    seeded.update_item(Key=person_key(PERSON_ID, workspace=A), UpdateExpression='ADD token_hashes :h',
                       ExpressionAttributeValues={':h': {'h' * 64}})
    before = seeded.scan()['Items']
    with pytest.raises(NotPerWorkspaceError, match='Participant asks'):
        erase_person(seeded, PERSON_ID, legal_basis='erasure_request', actor=ACTOR, workspace=A)
    assert seeded.scan()['Items'] == before


def test_a_person_and_its_index_rows_are_written_together_or_not_at_all(seeded):
    """The index rows ride in the person's own transaction: a create refused for a taken address lists nothing."""
    with patch.object(participants_store, 'new_id', return_value='per_fedcba9876543210'), \
            pytest.raises(participants_store.EmailTakenError, match='already exists'):
        create_person(seeded, email=EMAIL, email_lc=EMAIL, fields={}, origin='manual', created_by='sub-ada',
                      workspace=A)
    assert 'PERSON#per_fedcba9876543210' not in _index(seeded, A)


def test_a_guard_written_again_keeps_its_index_row(seeded):
    """An erasure's unlisting of the address guard is conditional on the guard being gone: when the same address is
    added again in between, the guard stays listed (the hard delete still finds it)."""
    guard = email_guard_key(EMAIL, workspace=A)
    index_row = participants_index_key(guard['pk'], workspace=A)
    assert not unlist_if_empty(seeded, A, index_row, guard)
    assert GUARD in _index(seeded, A)
    seeded.delete_item(Key=guard)
    assert unlist_if_empty(seeded, A, index_row, guard)
    assert GUARD not in _index(seeded, A)


def _cancelled(code: str) -> ClientError:
    return ClientError({'Error': {'Code': 'TransactionCanceledException'},
                        'CancellationReasons': [{'Code': 'None'}, {'Code': code}]}, 'TransactWriteItems')


@pytest.mark.parametrize(('failures', 'unlisted', 'tries'), [(2, True, 3), (3, False, 3)])
def test_an_unlisting_a_concurrent_write_cancels_is_tried_again_a_bounded_number_of_times(failures, unlisted, tries):
    sent = []

    def flaky(_table, _workspace, entries):
        sent.append(entries)
        if len(sent) <= failures:
            raise _cancelled('TransactionConflict')
        return {}

    with patch.object(participants_tables, 'transact', flaky):
        assert participants_tables.unlist_if_empty(MagicMock(), A, {'pk': 'i', 'sk': 'x'}, {'pk': 'r', 'sk': 'y'}) \
            is unlisted
    assert len(sent) == tries


def test_an_unlisting_raises_any_other_error():
    error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'TransactWriteItems')
    with patch.object(participants_tables, 'transact', side_effect=error), \
            pytest.raises(ClientError, match='ProvisionedThroughput'):
        participants_tables.unlist_if_empty(MagicMock(), A, {'pk': 'i', 'sk': 'x'}, {'pk': 'r', 'sk': 'y'})


def test_a_key_of_another_scope_is_refused_by_the_layer(seeded):
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        scoped_calls(seeded, A).get_item(Key=person_key(PERSON_ID, workspace=B))
    assert scoped_calls(seeded, None) is seeded


def test_a_token_names_its_workspace_or_none():
    assert token_workspace({'person_id': PERSON_ID}) is None
    assert token_workspace({'person_id': PERSON_ID, WORKSPACE_FIELD: WS_A}) == A
    for value in ('not-a-workspace', None):
        with pytest.raises(ValueError, match='workspace'):
            token_workspace({'person_id': PERSON_ID, WORKSPACE_FIELD: value})


# ── The deployment's requests, pinned ───────────────────────────────────────────────────────────────────────────────

def _recording() -> MagicMock:
    recording = MagicMock()
    recording.name = 'test-participants'
    recording.get_item.return_value = {'Item': {'pk': f'LIST#{LIST_ID}', 'sk': 'META', 'list_id': LIST_ID}}
    recording.query.return_value = {'Items': []}
    return recording


def test_without_a_workspace_the_reads_are_the_deployments():
    recording = _recording()
    get_person(recording, PERSON_ID)
    all_lists(recording)
    member_ids(recording, LIST_ID)
    project_links(recording, PROJECT)
    assert recording.mock_calls == [
        ('get_item', (), {'Key': {'pk': f'PERSON#{PERSON_ID}', 'sk': 'META'}}),
        ('query', (), {'IndexName': 'gsi1', 'KeyConditionExpression': 'gsi1pk = :p',
                       'ExpressionAttributeValues': {':p': 'LISTS'}}),
        ('query', (), {'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :prefix)',
                       'ExpressionAttributeValues': {':pk': f'LIST#{LIST_ID}', ':prefix': 'MEMBER#'}}),
        ('query', (), {'KeyConditionExpression': 'pk = :pk',
                       'ExpressionAttributeValues': {':pk': project_pk(PROJECT)}}),
    ]


def test_without_a_workspace_the_writes_are_the_deployments():
    recording = _recording()
    with patch.object(participants_store, 'new_id', return_value=PERSON_ID), \
            patch.object(participants_store, 'now_iso', return_value='2026-11-15T00:00:00+00:00'):
        create_person(recording, email=EMAIL, email_lc=EMAIL, fields={}, origin='manual', created_by='sub-ada')
    [(entries,)] = [call.kwargs.values() for call in recording.meta.client.transact_write_items.call_args_list]
    assert [entry['Put']['Item']['pk'] for entry in entries] == [f'PERSON#{PERSON_ID}', email_guard_key(EMAIL)['pk']]
    assert entries[0]['Put']['Item']['gsi1pk'] == 'PEOPLE'
    assert [list(entry['Put']) for entry in entries] == [['TableName', 'Item', 'ConditionExpression'],
                                                         ['TableName', 'ConditionExpression', 'Item']]
    recording.put_item.assert_not_called()


def test_without_a_workspace_a_link_and_a_list_delete_send_what_they_always_sent():
    recording = _recording()
    with patch.object(participants_lists, 'now_iso', return_value='2026-11-15T00:00:00+00:00'):
        link(recording, PROJECT, 'LIST', LIST_ID, 'sub-ada')
    recording.put_item.assert_called_once_with(Item={
        'pk': f'PROJECT#{PROJECT}', 'sk': f'LIST#{LIST_ID}', 'target_id': LIST_ID,
        'added_at': '2026-11-15T00:00:00+00:00', 'added_by': 'sub-ada'})
    recording.reset_mock()
    delete_list(recording, LIST_ID)
    recording.delete_item.assert_called_once_with(Key={'pk': f'LIST#{LIST_ID}', 'sk': 'META'})
    recording.batch_writer.assert_called_once_with()
