"""The project stores' plumbing per workspace (docs/multi-workspace.md, phase 3; 7.21.00).

Each threaded store takes ``workspace`` (keyword-only): in one it reads and writes only ``WS#{ws}#PROJECT#…`` rows,
through shared/ws_repo.py ``ws_table`` (shared/project_tables.py ``iter_project_rows`` over shared/scoped_query.py,
shared/ingest_tables.py ``table_view``, shared/workspace_config.py ``get_scoped_item``, shared/project_writes.py
``transact_project_writes``), and never sees the deployment's rows or another workspace's; without one it reads and
writes the deployment's ``PROJECT#…`` rows exactly as before, and never sees a workspace's. The stores that are not
per workspace yet (the document versions and their series, the access gate) refuse one. No route passes a workspace
yet.
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import (
    company_personas,
    decision_records,
    deleted_sources,
    document_comments,
    document_history,
    document_review,
    document_series,
    document_versions,
    human_documents,
    persona_overlap,
    persona_replace,
    persona_save,
    project_access,
    project_gate,
    project_writes,
)
from shared.exceptions import NotFoundError
from shared.project_access import Caller
from shared.project_keys import NotPerWorkspaceError, document_keys, personas_index_pk, project_pk, project_type_pk
from shared.project_tables import iter_project_rows
from shared.scoped_query import query_partition
from shared.test.moto_tables import create_pk_sk_table, create_projects_table_with_type_index
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
#: The deployment (None) and two workspaces.
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
STAMP = '2026-11-14T09:00:00+00:00'
CALLER = Caller(subject='sub-ada', username='ada')
ADMIN = Caller(subject='sub-admin', is_admin=True)
BY_TYPE = 'gsi1-by-type'


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('voc-projects-test')


def _pk(scope) -> str:
    return project_pk(PROJECT, workspace=scope)


def _meta(table, scope, **extra):
    """The project's META in ``scope`` (the same project id in each scope: the partitions alone tell them apart)."""
    table.put_item(Item={'pk': _pk(scope), 'sk': 'META', 'project_id': PROJECT,
                         'document_count': 0, 'persona_count': 0, **extra})


def _persona(table, scope, persona_id, **extra):
    table.put_item(Item={'pk': _pk(scope), 'sk': f'PERSONA#{persona_id}', 'persona_id': persona_id,
                         'gsi1pk': personas_index_pk(PROJECT, workspace=scope), 'gsi1sk': STAMP, 'name': persona_id,
                         **extra})


def _partition(table, scope) -> list[dict]:
    return table.query(KeyConditionExpression=Key('pk').eq(_pk(scope)), ConsistentRead=True)['Items']


def _scope_name(scope) -> str:
    return 'deployment' if scope is None else scope.ws


# ── The partition reader ─────────────────────────────────────────────────────

def test_the_reader_reads_its_scopes_partition_and_sort_prefix_only(table):
    for scope in SCOPES:
        _meta(table, scope)
        _persona(table, scope, f'persona_{_scope_name(scope)}')
    for scope in SCOPES:
        rows = list(iter_project_rows(table, PROJECT, workspace=scope, sort_prefix='PERSONA#'))
        assert [(row['pk'], row['sk']) for row in rows] == [(_pk(scope), f'PERSONA#persona_{_scope_name(scope)}')]


def test_the_reader_refuses_a_cursor_outside_its_workspace(table):
    deployment_cursor = {'pk': _pk(None), 'sk': 'META'}
    with pytest.raises(OutOfScopeError, match='cursor outside the workspace'):
        list(iter_project_rows(table, PROJECT, workspace=A, ExclusiveStartKey=deployment_cursor))
    with pytest.raises(OutOfScopeError, match='cursor outside the workspace'):
        list(iter_project_rows(table, PROJECT, workspace=A, ExclusiveStartKey={'pk': _pk(B), 'sk': 'META'}))


@pytest.mark.parametrize('reserved', [{'ExpressionAttributeNames': {'#sk': 'secret'}},
                                      {'ExpressionAttributeNames': {'#p': 'secret'}},
                                      {'ExpressionAttributeValues': {':p': 'x'}},
                                      {'ExpressionAttributeValues': {':sk0': 'x'}},
                                      {'ExpressionAttributeValues': {':sk1': 'x'}}])
def test_the_reader_refuses_a_placeholder_the_workspace_query_names_itself(table, reserved):
    with pytest.raises(OutOfScopeError, match='placeholders reserved'):
        list(iter_project_rows(table, PROJECT, workspace=A, sort_prefix='PERSONA#', **reserved))


def test_the_type_index_keeps_each_scopes_projects_apart():
    with mock_aws():
        projects = create_projects_table_with_type_index('voc-projects-index-test')
        for scope in SCOPES:
            projects.put_item(Item={'pk': _pk(scope), 'sk': 'META', 'gsi1pk': project_type_pk(workspace=scope),
                                    'gsi1sk': STAMP, 'name': _scope_name(scope)})
        deployment = projects.query(IndexName=BY_TYPE, KeyConditionExpression=Key('gsi1pk').eq(project_type_pk()))
        assert [row['name'] for row in deployment['Items']] == ['deployment']
        listed = query_partition(A, projects, 'gsi1pk', project_type_pk(workspace=A), IndexName=BY_TYPE)
        assert [row['name'] for row in listed['Items']] == [A.ws]


# ── The writes ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize('scope', SCOPES, ids=_scope_name)
def test_project_writes_write_their_scopes_rows_only(table, scope):
    for each in SCOPES:
        _meta(table, each)
    item = {**document_keys(PROJECT, 'DOC#doc_1', STAMP, workspace=scope), 'document_id': 'doc_1',
            'created_at': STAMP}
    project_writes.put_project_item_and_increment(table, PROJECT, item, 'document_count', workspace=scope)
    project_writes.put_project_item(table, PROJECT, {'pk': _pk(scope), 'sk': 'PIN#pin_1'}, workspace=scope)
    for each in SCOPES:
        rows = {row['sk']: row for row in _partition(table, each)}
        if each == scope:
            assert set(rows) == {'META', 'DOC#doc_1', 'PIN#pin_1'}
            assert rows['META']['document_count'] == 1
        else:
            assert set(rows) == {'META'}
            assert rows['META']['document_count'] == 0


def test_a_workspace_transaction_refuses_another_table_and_another_workspace(table):
    _meta(table, A)
    with pytest.raises(OutOfScopeError, match='own table'):
        project_writes.transact_project_writes(table, [{'Put': {'TableName': 'voc-other', 'Item': {
            'pk': _pk(A), 'sk': 'DOC#x'}}}], workspace=A)
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        project_writes.put_project_item(table, PROJECT, {'pk': _pk(None), 'sk': 'DOC#x'}, workspace=A)
    assert [row['sk'] for row in _partition(table, A)] == ['META']
    assert _partition(table, None) == []


def test_a_workspace_project_is_not_writable_without_its_own_meta(table):
    _meta(table, None)
    with pytest.raises(ClientError, match='ConditionalCheckFailed'):
        project_writes.put_project_item(table, PROJECT, {'pk': _pk(A), 'sk': 'DOC#doc_1'}, workspace=A)
    assert _partition(table, A) == []


def test_a_counted_child_is_created_in_its_workspace(table):
    _meta(table, A)
    moment = datetime(2026, 11, 14, 9, 0, tzinfo=UTC)
    item = project_writes.create_counted_project_child(
        table, PROJECT, 'doc', lambda doc_id: {**document_keys(PROJECT, f'DOC#{doc_id}', STAMP, workspace=A),
                                               'document_id': doc_id},
        now=moment, workspace=A)
    assert item['document_id'].startswith('doc_20261114')
    assert item['pk'] == _pk(A)
    assert _partition(table, None) == []


# ── The gate ─────────────────────────────────────────────────────────────────

GATE_REFUSED = 'Project gate is not per workspace yet'


@pytest.mark.parametrize('caller', [ADMIN, CALLER], ids=['deployment_admin', 'public_visibility'])
def test_the_gate_refuses_a_workspace_even_where_the_deployments_policy_would_pass(table, caller):
    # Workspace B's project is public: the deployment's policy would let its admin and every signed-in user in.
    _meta(table, B, visibility='public', owner_sub='sub-other')
    meta = table.get_item(Key={'pk': _pk(B), 'sk': 'META'})['Item']
    assert project_access.resolve_access(meta, caller).can_view
    with pytest.raises(NotPerWorkspaceError, match=GATE_REFUSED):
        project_access.resolve_access(meta, caller, workspace=B)
    with pytest.raises(NotPerWorkspaceError, match=GATE_REFUSED):
        project_gate.read_gate_meta(table, PROJECT, workspace=B)
    with pytest.raises(NotPerWorkspaceError, match=GATE_REFUSED):
        project_gate.require_project_level(lambda: meta, caller, project_access.LEVEL_VIEW, workspace=B)
    with pytest.raises(NotPerWorkspaceError, match=GATE_REFUSED):
        project_gate.require_viewable_pin(table, PROJECT, caller, workspace=B)


def test_the_gate_reads_the_deployments_meta_only(table):
    _meta(table, A, visibility='private', owner_sub='sub-ada')
    assert project_gate.read_gate_meta(table, PROJECT) is None
    _meta(table, None, visibility='public')
    assert (project_gate.read_gate_meta(table, PROJECT) or {}).get('visibility') == 'public'


# ── The stores ───────────────────────────────────────────────────────────────

def test_the_company_library_is_each_scopes_own(table):
    company_personas.ensure_company_personas_meta(table, workspace=A)
    library = company_personas.COMPANY_PERSONAS_CONTAINER
    table.put_item(Item={'pk': project_pk(library, workspace=A), 'sk': 'PERSONA#persona_a', 'persona_id': 'persona_a'})
    table.put_item(Item={'pk': project_pk(library), 'sk': 'PERSONA#persona_d', 'persona_id': 'persona_d'})
    assert [row['persona_id'] for row in company_personas.company_persona_items(table, workspace=A)] == ['persona_a']
    assert [row['persona_id'] for row in company_personas.company_persona_items(table)] == ['persona_d']
    assert company_personas.company_persona_items(table, workspace=B) == []
    assert table.get_item(Key={'pk': project_pk(library), 'sk': 'META'}).get('Item') is None


@pytest.mark.parametrize('scope', SCOPES, ids=_scope_name)
def test_decisions_live_in_their_scopes_project(table, scope):
    for each in SCOPES:
        _meta(table, each)
    body = {'title': 'Ship the trail map', 'verdict': 'pursue', 'rationale': 'Hikers at Acme Outfitters ask for it'}
    created = decision_records.create_decision(table, PROJECT, body, CALLER, workspace=scope)['document']
    document_id = created['document_id']
    assert created['pk'] == _pk(scope)
    updated = decision_records.update_decision(table, PROJECT, document_id, {'verdict': 'park'}, CALLER,
                                               workspace=scope)
    assert updated['document']['revision'] == 2
    decision_records.record_seeded_prfaq(table, created, 'job_1', workspace=scope)
    stored = decision_records.stored_decision(table, PROJECT, document_id, workspace=scope)
    assert stored['seeded_prfaq_job_id'] == 'job_1'
    for each in SCOPES:
        if each != scope:
            with pytest.raises(NotFoundError, match='Decision not found'):
                decision_records.stored_decision(table, PROJECT, document_id, workspace=each)


@pytest.mark.parametrize('scope', SCOPES, ids=_scope_name)
def test_deleted_sources_mark_their_scopes_documents_only(table, scope):
    for each in SCOPES:
        table.put_item(Item={'pk': _pk(each), 'sk': 'DOC#doc_1', 'document_id': 'doc_1',
                             'derivation': {'persona_ids': ['persona_gone']}})
    gone = [deleted_sources.DeletedSource('persona', 'persona_gone', 'Trail runner')]
    assert deleted_sources.mark_citing_documents(table, PROJECT, gone, deleted_at=STAMP, workspace=scope) == 1
    for each in SCOPES:
        [row] = _partition(table, each)
        assert ('deleted_sources' in row) is (each == scope)


def test_deleted_sources_raise_a_key_outside_the_workspace(table, monkeypatch):
    # Best effort covers DynamoDB's failures, never a key the workspace layer refused.
    deployment_row = {'pk': _pk(None), 'sk': 'DOC#doc_1', 'document_id': 'doc_1',
                      'derivation': {'persona_ids': ['persona_gone']}}
    monkeypatch.setattr(deleted_sources, '_documents', lambda *_args, **_kwargs: iter([deployment_row]))
    gone = [deleted_sources.DeletedSource('persona', 'persona_gone')]
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        deleted_sources.mark_citing_documents(table, PROJECT, gone, deleted_at=STAMP, workspace=A)


def test_a_persona_clear_raises_a_key_outside_the_workspace(table, monkeypatch):
    # A failed delete is kept and counted; a key the workspace layer refused is raised.
    monkeypatch.setattr(persona_replace, '_persona_rows',
                        lambda *_args, **_kwargs: [{'pk': _pk(None), 'sk': 'PERSONA#x'}])
    monkeypatch.setattr(persona_replace, 'project_pk', lambda *_args, **_kwargs: _pk(None))
    with pytest.raises(OutOfScopeError, match='outside the workspace'):
        persona_replace.clear_personas(table, PROJECT, workspace=A)


def test_document_readers_find_their_scopes_rows_only(table):
    for scope in SCOPES:
        table.put_item(Item={'pk': _pk(scope), 'sk': 'DOC#doc_1', 'document_id': 'doc_1',
                             'content': _scope_name(scope)})
        table.put_item(Item={'pk': _pk(scope), 'sk': 'PRD#prd_1', 'document_id': 'prd_1', 'document_type': 'prd',
                             'title': 'Trail map (v1)', 'base_title': 'Trail map', 'version': 1,
                             'content': _scope_name(scope)})
        _persona(table, scope, f'persona_{_scope_name(scope)}')
    for scope in SCOPES:
        name = _scope_name(scope)
        assert document_series.find_document(table, PROJECT, 'doc_1', workspace=scope)['content'] == name
        assert [row['persona_id'] for row in document_review.project_personas(table, PROJECT, workspace=scope)] == [
            f'persona_{name}']
        existing = persona_overlap.read_existing_personas(table, PROJECT, workspace=scope)
        assert existing.names == (f'persona_{name}',)


@pytest.mark.parametrize('scope', SCOPES, ids=_scope_name)
def test_persona_saves_counts_and_clears_stay_in_their_scope(table, scope):
    for each in SCOPES:
        _meta(table, each)
        _persona(table, each, 'persona_old')
        _persona(table, each, 'persona_guarded', protected=True)
    persona_save.require_writable_project(table, PROJECT, workspace=scope)
    new = {'pk': _pk(scope), 'sk': 'PERSONA#persona_new', 'persona_id': 'persona_new',
           'gsi1pk': personas_index_pk(PROJECT, workspace=scope), 'gsi1sk': STAMP}
    assert persona_save.save_persona_items(table, PROJECT, [new], workspace=scope) == [new]
    assert persona_save.store_persona_count(table, PROJECT, STAMP, workspace=scope) == 3
    persona_replace.set_protection(table, PROJECT, 'persona_new', True, STAMP, workspace=scope)
    cleared = persona_replace.clear_personas(table, PROJECT, workspace=scope)
    assert cleared.deleted == ['PERSONA#persona_old']
    for each in SCOPES:
        rows = {row['sk']: row for row in _partition(table, each)}
        if each == scope:
            assert set(rows) == {'META', 'PERSONA#persona_guarded', 'PERSONA#persona_new'}
            assert rows['META']['persona_count'] == 3
        else:
            assert set(rows) == {'META', 'PERSONA#persona_guarded', 'PERSONA#persona_old'}
            assert rows['META']['persona_count'] == 0


def test_a_persona_save_into_a_deleted_workspace_project_is_refused(table):
    _meta(table, None)
    _meta(table, A, status='deleting')
    with pytest.raises(persona_save.ProjectNotWritableError, match='deleted'):
        persona_save.require_writable_project(table, PROJECT, workspace=A)
    persona_save.require_writable_project(table, PROJECT)


# ── The stores not per workspace yet fail closed ─────────────────────────────

@pytest.mark.parametrize('write', [
    lambda table: document_versions.persist_versioned_document(table, PROJECT, 'prd', 'Trail map', 'job_1', {},
                                                               workspace=A),
    lambda table: human_documents.create_human_document(table, PROJECT, 'prd', {'title': 'Trail map'},
                                                        creator_sub='sub-ada', workspace=A),
    lambda table: document_history.edit_document(table, PROJECT, {'document_id': 'doc_1'}, {'content': 'x'},
                                                 now=STAMP, workspace=A),
    lambda table: document_history.list_document_versions(table, PROJECT, {'document_id': 'doc_1'}, workspace=A),
    lambda table: document_history.restore_document_version(table, PROJECT, {'document_id': 'doc_1'}, 'r1', {},
                                                            now=STAMP, workspace=A),
    lambda table: document_history.delete_document_revisions(table, PROJECT, 'doc_1', workspace=A),
    lambda table: document_history.series_versions(table, PROJECT, {'document_type': 'prd', 'base_title': 'Trail map'},
                                                   workspace=A),
    lambda table: document_series.latest_version(table, PROJECT, 'prd', 'Trail map', workspace=A),
], ids=['persist', 'human', 'edit', 'list', 'restore', 'delete_revisions', 'series', 'latest'])
def test_the_document_version_stores_refuse_a_workspace_and_write_nothing(table, write):
    _assert_refused(table, write, 'Document versions is not per workspace yet')


THREAD = {'pk': 'DCOMMENTS#proj_shared_id#ser_0', 'sk': 'C#dc_00000000000000000000abcdef'}


@pytest.mark.parametrize('call', [
    lambda table: document_comments.put_thread(table, THREAD, workspace=A),
    lambda table: document_comments.get_thread(table, PROJECT, 'ser_0', 'dc_00000000000000000000abcdef',
                                               workspace=A),
    lambda table: document_comments.list_threads(table, PROJECT, 'ser_0', workspace=A),
    lambda table: document_comments.append_reply(table, THREAD, {'at': STAMP}, workspace=A),
    lambda table: document_comments.set_status(table, THREAD, 'resolved', 'ada', workspace=A),
    lambda table: document_comments.delete_thread(table, THREAD, workspace=A),
    lambda table: document_review.run_review(table, project_id=PROJECT, series_id='ser_0',
                                             document={'content': 'Trail map'}, document_type='prd',
                                             personas=[], invoke=_no_model, workspace=A),
], ids=['put', 'get', 'list', 'reply', 'status', 'delete', 'review'])
def test_the_comment_stores_refuse_a_workspace_and_write_nothing(table, call):
    _assert_refused(table, call, 'Document comments is not per workspace yet')


def _no_model(_prompt: str, _system: str) -> str:
    raise AssertionError('a refused review never calls a model')


def _assert_refused(table, call, message: str) -> None:
    _meta(table, A)
    with pytest.raises(NotPerWorkspaceError, match=message):
        call(table)
    assert table.scan()['Items'] == [{'pk': _pk(A), 'sk': 'META', 'project_id': PROJECT, 'document_count': 0,
                                      'persona_count': 0}]
