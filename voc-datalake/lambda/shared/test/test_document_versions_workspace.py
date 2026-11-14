"""The document versions and their history per workspace (docs/multi-workspace.md, the project plan 3b; 7.27.00).

One project id in three scopes (the deployment and two workspaces): each scope's versions counter, allocations,
legacy assignments and revisions sit in its own version partition (``DOCUMENT_VERSIONS#PROJECT#{id}``,
``WS#{ws}#DOCUMENT_VERSIONS#PROJECT#{id}``) and its documents in its own project partition, and nothing a scope
writes changes a row of another. The deployment's requests are pinned at the end, key for key (the mutation suites,
test_document_versions_mutation_*.py and test_document_history_mutation.py, pin every other request byte for byte).
No route passes a workspace yet.
"""
from __future__ import annotations

from collections.abc import Callable
from unittest.mock import patch

import pytest
from moto import mock_aws

from shared import document_history, document_series, document_versions, human_documents
from shared.project_keys import (
    document_listing,
    document_revision_key,
    legacy_assignment_prefix,
    project_pk,
    version_allocation_key,
    version_counter_key,
    version_partition_key,
)
from shared.test.document_versions_fixtures import sha
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
#: The deployment (None) and two workspaces.
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
STAMP = '2026-11-14T09:00:00+00:00'
LATER = '2026-11-14T10:00:00+00:00'
TABLE = 'voc-projects-versions-test'


@pytest.fixture
def table():
    with mock_aws():
        projects = create_pk_sk_table(TABLE)
        for scope in SCOPES:
            projects.put_item(Item={'pk': project_pk(PROJECT, workspace=scope), 'sk': 'META', 'project_id': PROJECT,
                                    'document_count': 0})
        yield projects


def _name(scope) -> str:
    return 'deployment' if scope is None else scope.ws


def _scope_of(row: dict) -> WorkspaceScope | None:
    return next((scope for scope in (A, B) if scope.owns(row['pk'])), None)


def _rows(table, scope) -> dict[tuple[str, str], dict]:
    """Every row of ``scope`` (its project and version partitions), by key."""
    return {(row['pk'], row['sk']): row for row in table.scan()['Items'] if _scope_of(row) == scope}


def _others(table, scope) -> dict:
    return {_name(other): _rows(table, other) for other in SCOPES if other != scope}


def _row(table, key: dict[str, str]) -> dict:
    return table.get_item(Key=key, ConsistentRead=True).get('Item') or {}


def _human(table, scope, *, content: str = 'First draft', create_id: str = 'c1') -> dict:
    return human_documents.create_human_document(
        table, PROJECT, 'prd', {'title': 'Trail map', 'content': content, 'create_id': create_id},
        creator_sub='sub-ada', workspace=scope)


def _untouched[T](table, scope, change: Callable[[], T]) -> T:
    """``change()``'s result, after checking it left every other scope's rows exactly as they were."""
    before = _others(table, scope)
    result = change()
    assert _others(table, scope) == before
    return result


# ── The versions counter and an allocation ───────────────────────────────────

def test_each_scope_counts_its_own_versions_of_one_project(table):
    for scope in SCOPES:
        item = document_versions.persist_versioned_document(
            table, PROJECT, 'prd', 'Trail map', 'job_1', {'created_at': STAMP, **document_listing(
                PROJECT, STAMP, workspace=scope)}, workspace=scope)
        assert (item['pk'], item['version'], item['title']) == (project_pk(PROJECT, workspace=scope), 1,
                                                                'Trail map (v1)')
    second = _untouched(table, A, lambda: document_versions.persist_versioned_document(
        table, PROJECT, 'prd', 'Trail map', 'job_2', {'created_at': LATER, **document_listing(
            PROJECT, LATER, workspace=A)}, workspace=A))
    assert second['version'] == 2
    for scope in SCOPES:
        counter = _row(table, version_counter_key(PROJECT, 'prd', 'trail map', workspace=scope))
        assert counter['last_version'] == (2 if scope == A else 1)
        allocation = _row(table, version_allocation_key(PROJECT, 'prd', 'job_1', workspace=scope))
        assert allocation['document_pk'] == project_pk(PROJECT, workspace=scope)
        meta = _row(table, {'pk': project_pk(PROJECT, workspace=scope), 'sk': 'META'})
        assert meta['document_count'] == (2 if scope == A else 1)


@pytest.mark.parametrize('scope', SCOPES, ids=_name)
def test_an_allocation_replays_in_its_scope_only(table, scope):
    fields = {'created_at': STAMP, **document_listing(PROJECT, STAMP, workspace=scope)}
    first = document_versions.persist_versioned_document(table, PROJECT, 'prd', 'Trail map', 'job_1', fields,
                                                         workspace=scope)
    replay = document_versions.persist_versioned_document(table, PROJECT, 'prd', 'Trail map', 'job_1', fields,
                                                          workspace=scope)
    assert replay == first
    for other in SCOPES:
        found = document_versions.get_versioned_document_by_allocation(table, PROJECT, 'prd', 'job_1',
                                                                       workspace=other)
        assert (found is not None) is (other == scope)
    document_versions.preserve_versioned_document_allocation(table, PROJECT, first, workspace=scope)
    assert _others(table, scope) == {_name(other): {(project_pk(PROJECT, workspace=other), 'META'): {
        'pk': project_pk(PROJECT, workspace=other), 'sk': 'META', 'project_id': PROJECT, 'document_count': 0}}
        for other in SCOPES if other != scope}


# ── The legacy-series migration ──────────────────────────────────────────────

def _legacy(scope) -> dict:
    return {'pk': project_pk(PROJECT, workspace=scope), 'sk': 'PRD#legacy_1', 'document_id': 'legacy_1',
            'title': 'Trail map', 'content': _name(scope), 'created_at': STAMP}


@pytest.mark.parametrize('scope', SCOPES, ids=_name)
def test_the_legacy_migration_assigns_in_its_scope_only(table, scope):
    for each in SCOPES:
        table.put_item(Item=_legacy(each))
    [migrated] = _untouched(table, scope, lambda: document_versions.persist_legacy_document_versions(
        table, PROJECT, [_legacy(scope)], workspace=scope))
    assert (migrated['version'], migrated['title']) == (1, 'Trail map (v1)')
    counter = version_counter_key(PROJECT, 'prd', 'trail map', workspace=scope)
    assignments = [row for (pk, sk), row in _rows(table, scope).items()
                   if pk == version_partition_key(PROJECT, workspace=scope)
                   and sk.startswith(legacy_assignment_prefix(counter))]
    assert [(row['source_document_sk'], row['version']) for row in assignments] == [('PRD#legacy_1', 1)]
    assert 'migration_owner' not in _row(table, counter)
    for each in SCOPES:
        stored = _row(table, {'pk': project_pk(PROJECT, workspace=each), 'sk': 'PRD#legacy_1'})
        assert stored.get('version') == (1 if each == scope else None)


def test_a_new_version_migrates_its_scopes_legacy_series_first(table):
    for each in SCOPES:
        table.put_item(Item=_legacy(each))
    item = _untouched(table, B, lambda: document_versions.persist_versioned_document(
        table, PROJECT, 'prd', 'Trail map', 'job_1', {'created_at': LATER, **document_listing(
            PROJECT, LATER, workspace=B)}, workspace=B))
    assert item['version'] == 2
    assert _row(table, {'pk': project_pk(PROJECT, workspace=B), 'sk': 'PRD#legacy_1'})['version'] == 1


# ── Human documents, managed edits, restores and the series ─────────────────

@pytest.mark.parametrize('scope', SCOPES, ids=_name)
def test_a_human_document_is_created_edited_and_restored_in_its_scope(table, scope):
    for each in SCOPES:
        _human(table, each, content=f'First draft of {_name(each)}')

    def change() -> dict:
        created = document_series.latest_version(table, PROJECT, 'prd', 'Trail map', workspace=scope)
        assert created is not None
        edited = document_history.edit_document(table, PROJECT, created, {'content': 'Second draft',
                                                                          'edit_id': 'e1'},
                                                now=LATER, workspace=scope)['document']
        assert edited['version'] == 2
        restored = document_history.restore_document_version(table, PROJECT, edited, created['document_id'],
                                                             {'edit_id': 'r1'}, now=LATER, workspace=scope)
        return restored['document']

    restored = _untouched(table, scope, change)
    assert (restored['pk'], restored['version'], restored['content']) == (
        project_pk(PROJECT, workspace=scope), 3, f'First draft of {_name(scope)}')
    assert restored['gsi1pk'] == document_listing(PROJECT, STAMP, workspace=scope)['gsi1pk']
    listed = document_history.list_document_versions(table, PROJECT, restored, workspace=scope)
    assert [version['version'] for version in listed['versions']] == [3, 2, 1]
    for other in SCOPES:
        latest = document_series.latest_version(table, PROJECT, 'prd', 'Trail map', workspace=other)
        assert latest is not None
        assert latest['version'] == (3 if other == scope else 1)


def test_a_series_no_scope_has_written_is_empty(table):
    _human(table, A)
    assert document_series.latest_version(table, PROJECT, 'prd', 'Trail map', workspace=B) is None
    assert document_history.series_versions(table, PROJECT, {'document_type': 'prd', 'base_title': 'Trail map'},
                                            workspace=None) == []


# ── Unmanaged revisions ──────────────────────────────────────────────────────

def _notes(scope) -> dict:
    return {'pk': project_pk(PROJECT, workspace=scope), 'sk': 'DOC#doc_1', 'document_id': 'doc_1', 'title': 'Notes',
            'content': f'first {_name(scope)}', 'created_at': STAMP}


@pytest.mark.parametrize('scope', SCOPES, ids=_name)
def test_a_revision_is_saved_restored_and_deleted_in_its_scope(table, scope):
    for each in SCOPES:
        table.put_item(Item=_notes(each))
        document_history.edit_document(table, PROJECT, _notes(each), {'content': f'second {_name(each)}'},
                                       now=LATER, workspace=each)

    def change() -> dict:
        current = _row(table, {'pk': project_pk(PROJECT, workspace=scope), 'sk': 'DOC#doc_1'})
        restored = document_history.restore_document_version(table, PROJECT, current, 'r1', {}, now=LATER,
                                                             workspace=scope)['document']
        listed = document_history.list_document_versions(table, PROJECT, restored, workspace=scope)
        assert [version['version_id'] for version in listed['versions']] == ['r3', 'r2', 'r1']
        return restored

    restored = _untouched(table, scope, change)
    assert (restored['content'], restored['revision']) == (f'first {_name(scope)}', 3)
    revision = _row(table, document_revision_key(PROJECT, 'doc_1', 2, workspace=scope))
    assert revision['content'] == f'second {_name(scope)}'
    _untouched(table, scope, lambda: document_history.delete_document_revisions(table, PROJECT, 'doc_1',
                                                                                workspace=scope))
    assert not [key for key in _rows(table, scope) if key[0] == version_partition_key(PROJECT, workspace=scope)]
    for other in SCOPES:
        if other != scope:
            assert _row(table, document_revision_key(PROJECT, 'doc_1', 1, workspace=other))


def _thirty_revisions(table) -> None:
    for each in SCOPES:
        for revision in range(1, 31):
            table.put_item(Item={**document_revision_key(PROJECT, 'doc_1', revision, workspace=each),
                                 'content': f'{_name(each)} r{revision}'})


def test_the_deployments_revision_delete_goes_in_batches_as_before(table):
    _thirty_revisions(table)
    client = table.meta.client
    with patch.object(client, 'batch_write_item', wraps=client.batch_write_item) as sent:
        _untouched(table, None, lambda: document_history.delete_document_revisions(table, PROJECT, 'doc_1'))
    requests = [recorded.kwargs['RequestItems'][TABLE] for recorded in sent.call_args_list]
    assert [len(request) for request in requests] == [25, 5]
    assert {entry['DeleteRequest']['Key']['pk'] for request in requests for entry in request} == {
        'DOCUMENT_VERSIONS#PROJECT#proj_shared_id'}
    assert list(_rows(table, None)) == [('PROJECT#proj_shared_id', 'META')]


@pytest.mark.parametrize('scope', [A, B], ids=_name)
def test_a_workspaces_revision_delete_is_one_checked_delete_per_row(table, scope):
    _thirty_revisions(table)
    client = table.meta.client
    with (patch.object(client, 'batch_write_item') as batched,
          patch.object(client, 'delete_item', wraps=client.delete_item) as deleted):
        _untouched(table, scope, lambda: document_history.delete_document_revisions(table, PROJECT, 'doc_1',
                                                                                    workspace=scope))
    batched.assert_not_called()
    assert deleted.call_count == 30
    assert {recorded.kwargs['Key']['pk'] for recorded in deleted.call_args_list} == {
        version_partition_key(PROJECT, workspace=scope)}
    assert list(_rows(table, scope)) == [(project_pk(PROJECT, workspace=scope), 'META')]


def test_a_refused_revision_key_stops_the_delete_before_the_next(table):
    rows = [document_revision_key(PROJECT, 'doc_1', 1, workspace=A), document_revision_key(PROJECT, 'doc_1', 1),
            document_revision_key(PROJECT, 'doc_1', 2, workspace=A)]
    for key in rows:
        table.put_item(Item=key)
    with (patch.object(document_history, 'iter_version_rows', return_value=iter(rows)),
          pytest.raises(OutOfScopeError, match='a key outside the workspace')):
        document_history.delete_document_revisions(table, PROJECT, 'doc_1', workspace=A)
    assert _row(table, rows[1])
    assert _row(table, rows[2])
    assert not _row(table, rows[0])


# ── Fail closed: a row or index key of another scope ─────────────────────────

def test_a_workspace_refuses_a_document_row_of_another_scope(table):
    table.put_item(Item=_notes(None))
    before = table.scan()['Items']
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        document_history.edit_document(table, PROJECT, _notes(None), {'content': 'x'}, now=LATER, workspace=A)
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        document_versions.persist_versioned_document(
            table, PROJECT, 'prd', 'Trail map', 'job_1', {'created_at': STAMP, **document_listing(PROJECT, STAMP)},
            workspace=A)
    assert table.scan()['Items'] == before


# ── The deployment's requests ────────────────────────────────────────────────

#: shared/project_writes.py PROJECT_WRITABLE_CONDITION, spelled out: the deployment's META condition, unchanged.
WRITABLE = ('attribute_exists(pk) AND attribute_exists(sk) AND attribute_not_exists(#deleting) '
            'AND (attribute_not_exists(#status) OR (#status <> :deleting_status AND #status <> :deleted_status))')


def test_the_deployments_create_sends_the_requests_it_always_sent(table):
    with patch.object(table.meta.client, 'transact_write_items', wraps=table.meta.client.transact_write_items) as sent:
        _human(table, None)
    [entries] = [recorded.kwargs['TransactItems'] for recorded in sent.call_args_list]
    allocation = f"ALLOCATION#PRD#{sha('human:c1')}"
    document_id = f"prd_{sha(f'{PROJECT}|prd|human:c1')[:20]}"
    assert [(action, body['TableName'], body.get('Key') or {'pk': body['Item']['pk'], 'sk': body['Item']['sk']},
             body['ConditionExpression']) for entry in entries for action, body in entry.items()] == [
        ('Put', TABLE, {'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_shared_id', 'sk': f"PRD#{sha('trail map')}"},
         'attribute_not_exists(pk) AND attribute_not_exists(sk)'),
        ('Put', TABLE, {'pk': 'DOCUMENT_VERSIONS#PROJECT#proj_shared_id', 'sk': allocation},
         'attribute_not_exists(pk) AND attribute_not_exists(sk)'),
        ('Put', TABLE, {'pk': 'PROJECT#proj_shared_id', 'sk': f'PRD#{document_id}'},
         'attribute_not_exists(pk) AND attribute_not_exists(sk)'),
        ('Update', TABLE, {'pk': 'PROJECT#proj_shared_id', 'sk': 'META'}, WRITABLE),
    ]
    assert entries[2]['Put']['Item']['gsi1pk'] == 'PROJECT#proj_shared_id#DOCUMENTS'


def test_the_deployments_revision_requests_are_the_ones_it_always_sent(table):
    table.put_item(Item=_notes(None))
    with patch.object(table.meta.client, 'transact_write_items', wraps=table.meta.client.transact_write_items) as sent:
        document_history.edit_document(table, PROJECT, _notes(None), {'content': 'second'}, now=LATER)
    [[snapshot, update]] = [recorded.kwargs['TransactItems'] for recorded in sent.call_args_list]
    assert snapshot['Put']['Item']['pk'] == 'DOCUMENT_VERSIONS#PROJECT#proj_shared_id'
    assert snapshot['Put']['Item']['sk'] == 'REVISION#doc_1#000001'
    assert update['Update']['Key'] == {'pk': 'PROJECT#proj_shared_id', 'sk': 'DOC#doc_1'}
    assert update['Update']['TableName'] == TABLE
