"""A project id's claim and a workspace's registry of its project ids (docs/multi-workspace.md, the project plan 3a;
7.26.00).

The claim, ``PROJECT_ID#{id}`` / ``CLAIM`` in voc-projects, is deployment-wide and the workspace layer's own entry
(shared/ws_repo.py ``claim_project_id``, a ``ProjectClaim``): the one entry outside the workspace a scoped
transaction takes, put first and only if absent, so it is written with the project's ``META`` and registry row or
not at all (shared/project_writes.py ``create_workspace_project``). Its reader (``project_claim``) answers the
workspace; ``release_project_claim`` deletes it only while it names that workspace. The registry,
``WS#{ws}#PROJECT_IDS`` / ``{id}``, is read back, ids only, through shared/project_tables.py
``iter_registered_project_ids``. Against moto, so the conditions and the cancellations are DynamoDB's own.
"""
from __future__ import annotations

from typing import Any

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import project_tables
from shared.ids import is_key_collision
from shared.project_keys import project_pk, project_registry_key, project_registry_pk, project_type_pk
from shared.project_tables import iter_registered_project_ids
from shared.project_writes import NEW_ROW_CONDITION, create_workspace_project, transact_project_writes
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import (
    PROJECT_CLAIM_INDEX,
    OutOfScopeError,
    ProjectClaim,
    WorkspaceScope,
    claim_project_id,
    project_claim,
    release_project_claim,
    ws_table,
)

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
PROJECT = 'proj_20261114090000_aaaa0000'
STAMP = '2026-11-14T09:00:00+00:00'
CLAIM_KEY = {'pk': f'PROJECT_ID#{PROJECT}', 'sk': 'CLAIM'}
#: What a careless caller might pass, typed loosely so the runtime refusals can be reached.
NO_WORKSPACE: Any = None
NOT_A_CLAIM: Any = {'Put': {'Item': CLAIM_KEY}}


PROJECTS = 'voc-projects-claims-test'


@pytest.fixture
def table(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', PROJECTS)
    with mock_aws():
        yield create_pk_sk_table(PROJECTS)


def _meta(project_id: str, workspace: WorkspaceScope) -> dict[str, Any]:
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': 'META', 'project_id': project_id,
            'gsi1pk': project_type_pk(workspace=workspace), 'gsi1sk': STAMP, 'created_at': STAMP, 'status': 'active'}


def _keys(table) -> list[tuple[str, str]]:
    return sorted((row['pk'], row['sk']) for row in table.scan(ConsistentRead=True)['Items'])


def _held_claim(table, workspace: WorkspaceScope, project_id: str = PROJECT) -> None:
    """A claim already there for ``workspace`` (as another create's transaction left it)."""
    table.put_item(Item={'pk': f'PROJECT_ID#{project_id}', 'sk': 'CLAIM', 'workspace_id': workspace.ws,
                         'claimed_at': STAMP})


# ── The claim's own entry ────────────────────────────────────────────────────

def test_a_claim_is_put_first_in_the_workspaces_transaction_naming_its_workspace(table, monkeypatch):
    client = table.meta.client
    sent: list[list[dict[str, Any]]] = []
    real_transact = client.transact_write_items

    def recording(**request: Any) -> dict:
        sent.append(request['TransactItems'])
        return real_transact(**request)

    monkeypatch.setattr(client, 'transact_write_items', recording)
    create_workspace_project(table, _meta(PROJECT, A), workspace=A)

    [items] = sent
    assert items[PROJECT_CLAIM_INDEX] == {'Put': {
        'TableName': PROJECTS, 'ConditionExpression': 'attribute_not_exists(pk)',
        'Item': {**CLAIM_KEY, 'workspace_id': A.ws, 'claimed_at': STAMP}}}
    assert table.get_item(Key=CLAIM_KEY)['Item'] == {**CLAIM_KEY, 'workspace_id': A.ws, 'claimed_at': STAMP}


def test_a_claim_is_built_by_the_layer_only():
    claim = claim_project_id(PROJECT, workspace=A, claimed_at=STAMP)

    assert (claim.project_id, claim.scope, claim.claimed_at) == (PROJECT, A, STAMP)
    with pytest.raises(TypeError, match='built by claim_project_id only'):
        ProjectClaim(object(), A, PROJECT, STAMP)
    held = '_scope'
    with pytest.raises(AttributeError, match='cannot be changed'):
        setattr(claim, held, B)
    with pytest.raises(TypeError, match='cannot be subclassed'):
        type('ForgedClaim', (ProjectClaim,), {})


def test_a_forged_or_foreign_claim_is_refused_before_anything_is_sent(table):
    entry = {'Put': {'Item': project_registry_key(PROJECT, workspace=A), 'ConditionExpression': NEW_ROW_CONDITION}}
    unbuilt = object.__new__(ProjectClaim)
    for claim in (unbuilt, claim_project_id(PROJECT, workspace=B, claimed_at=STAMP), NOT_A_CLAIM):
        with pytest.raises(OutOfScopeError, match='of its own workspace'):
            ws_table(A, table).transact_write_items([entry], claim=claim)
    assert _keys(table) == []


def test_a_claim_is_written_in_the_projects_table_only(table, monkeypatch):
    other = create_pk_sk_table('voc-other-table')
    entry = {'Put': {'Item': project_registry_key(PROJECT, workspace=A), 'ConditionExpression': NEW_ROW_CONDITION}}
    claim = claim_project_id(PROJECT, workspace=A, claimed_at=STAMP)

    with pytest.raises(OutOfScopeError, match='projects table only'):
        ws_table(A, other).transact_write_items([entry], claim=claim)
    monkeypatch.delenv('PROJECTS_TABLE')
    with pytest.raises(OutOfScopeError, match='projects table only'):
        ws_table(A, table).transact_write_items([entry], claim=claim)
    assert other.scan()['Items'] == []
    assert _keys(table) == []


@pytest.mark.parametrize('workspace', [None, A.ws, {'ws': A.ws}], ids=['deployment', 'bare_id', 'mapping'])
def test_the_claim_refuses_anything_but_a_workspace(workspace):
    with pytest.raises(OutOfScopeError, match='never the deployment'):
        claim_project_id(PROJECT, workspace=workspace, claimed_at=STAMP)


@pytest.mark.parametrize('project_id', ['', 'proj#META', f'{PROJECT}#CLAIM', 'WS#x', 'proj x', 'p' * 129, None, 7],
                         ids=['empty', 'hash', 'claim_suffix', 'workspace_key', 'space', 'too_long', 'none', 'int'])
def test_the_claim_and_its_reader_refuse_any_other_key(table, project_id):
    with pytest.raises(OutOfScopeError, match='names a project id'):
        claim_project_id(project_id, workspace=A, claimed_at=STAMP)
    with pytest.raises(OutOfScopeError, match='names a project id'):
        project_claim(table, project_id)
    with pytest.raises(OutOfScopeError, match='names a project id'):
        release_project_claim(table, project_id, workspace=A)


def test_a_claim_says_when_it_was_made():
    with pytest.raises(ValueError, match='when it was made'):
        claim_project_id(PROJECT, workspace=A, claimed_at='')


def test_a_callers_own_claim_entry_stays_refused(table):
    raw_claim = {'Put': {'Item': {**CLAIM_KEY, 'workspace_id': A.ws}, 'ConditionExpression': 'attribute_not_exists(pk)'}}
    with pytest.raises(OutOfScopeError, match='a key outside the workspace'):
        ws_table(A, table).transact_write_items([raw_claim])
    with pytest.raises(OutOfScopeError, match='a key outside the workspace'):
        transact_project_writes(table, [{'Put': {'TableName': table.name, **raw_claim['Put']}}], workspace=A)
    assert _keys(table) == []


def test_the_deployment_takes_no_claim(table):
    with pytest.raises(OutOfScopeError, match='never the deployment'):
        transact_project_writes(table, [], claim=claim_project_id(PROJECT, workspace=A, claimed_at=STAMP))
    assert _keys(table) == []


# ── The create in a workspace and the registry ───────────────────────────────

def test_a_workspace_create_writes_the_claim_the_meta_and_the_registry_row(table):
    create_workspace_project(table, _meta(PROJECT, A), workspace=A)

    assert _keys(table) == [(f'PROJECT_ID#{PROJECT}', 'CLAIM'), (project_pk(PROJECT, workspace=A), 'META'),
                            (project_registry_pk(A), PROJECT)]
    registry_row = table.get_item(Key=project_registry_key(PROJECT, workspace=A))['Item']
    assert registry_row == {**project_registry_key(PROJECT, workspace=A), 'created_at': STAMP}
    assert project_claim(table, PROJECT) == A
    assert list(iter_registered_project_ids(table, workspace=A)) == [PROJECT]


def test_a_held_claim_cancels_the_create_at_the_claims_index_and_writes_nothing(table):
    _held_claim(table, B)

    with pytest.raises(ClientError, match='TransactionCanceled') as cancelled:
        create_workspace_project(table, _meta(PROJECT, A), workspace=A)

    assert is_key_collision(cancelled.value, put_index=PROJECT_CLAIM_INDEX)
    assert _keys(table) == [(f'PROJECT_ID#{PROJECT}', 'CLAIM')]
    assert project_claim(table, PROJECT) == B


def test_another_cancellation_is_not_a_claim_collision_and_leaves_no_claim(table):
    # The registry row is already there (as no create makes it): the transaction is cancelled at its Put, not the
    # claim's, and nothing of it is written: no claim is left without its project.
    table.put_item(Item=project_registry_key(PROJECT, workspace=A))

    with pytest.raises(ClientError, match='TransactionCanceled') as cancelled:
        create_workspace_project(table, _meta(PROJECT, A), workspace=A)

    assert not is_key_collision(cancelled.value, put_index=PROJECT_CLAIM_INDEX)
    assert _keys(table) == [(project_registry_pk(A), PROJECT)]
    assert project_claim(table, PROJECT) is None


def test_a_meta_keyed_outside_the_workspace_is_refused_before_anything_is_sent(table):
    with pytest.raises(OutOfScopeError, match='keyed in that workspace'):
        create_workspace_project(table, _meta(PROJECT, B), workspace=A)
    with pytest.raises(OutOfScopeError, match='keyed in that workspace'):
        create_workspace_project(table, {**_meta(PROJECT, A), 'sk': 'PERSONA#x'}, workspace=A)
    assert _keys(table) == []


# ── Reading and releasing a claim ────────────────────────────────────────────

def test_the_reader_answers_the_claims_workspace_or_none(table):
    _held_claim(table, A)

    assert project_claim(table, PROJECT) == A
    assert project_claim(table, 'proj_never_made') is None


def test_the_reader_projects_the_workspace_only_and_reads_strongly():
    class Recorder:
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []

        def get_item(self, **request: Any) -> dict[str, Any]:
            self.requests.append(request)
            return {'Item': {'workspace_id': B.ws}}

    recorder = Recorder()

    assert project_claim(recorder, PROJECT) == B
    assert recorder.requests == [{'Key': CLAIM_KEY, 'ConsistentRead': True, 'ProjectionExpression': '#ws',
                                  'ExpressionAttributeNames': {'#ws': 'workspace_id'}}]


def test_a_claim_that_names_no_workspace_is_never_read_as_the_deployments(table):
    table.put_item(Item={**CLAIM_KEY, 'workspace_id': 'not-a-workspace'})

    with pytest.raises(ValueError, match='names no workspace'):
        project_claim(table, PROJECT)


def test_a_claim_is_released_only_by_its_own_workspace(table):
    _held_claim(table, A)

    assert release_project_claim(table, PROJECT, workspace=B) is False
    assert project_claim(table, PROJECT) == A
    assert release_project_claim(table, PROJECT, workspace=A) is True
    assert project_claim(table, PROJECT) is None
    assert release_project_claim(table, PROJECT, workspace=A) is False


def test_a_release_refuses_the_deployment(table):
    _held_claim(table, A)

    with pytest.raises(OutOfScopeError, match='never the deployment'):
        release_project_claim(table, PROJECT, workspace=NO_WORKSPACE)
    assert project_claim(table, PROJECT) == A


def test_the_registry_pages_and_stays_in_its_workspace(table, monkeypatch):
    ids_a = [f'proj_a_{n:02d}' for n in range(5)]
    for project_id in ids_a:
        table.put_item(Item=project_registry_key(project_id, workspace=A))
    table.put_item(Item=project_registry_key('proj_b_00', workspace=B))
    table.put_item(Item={'pk': project_pk('proj_a_00', workspace=A), 'sk': 'META'})
    pages: list[dict[str, Any]] = []
    real_query = project_tables.query_partition

    def two_a_page(*args: Any, **kwargs: Any) -> dict:
        response = real_query(*args, Limit=2, **kwargs)
        pages.append(kwargs)
        return response

    monkeypatch.setattr(project_tables, 'query_partition', two_a_page)

    assert list(iter_registered_project_ids(table, workspace=A)) == ids_a
    assert len(pages) >= 3
    assert all(page['ProjectionExpression'] == 'sk' for page in pages)
    assert all(page['ConsistentRead'] for page in pages)
    assert list(iter_registered_project_ids(table, workspace=B)) == ['proj_b_00']


def test_the_registry_is_a_workspaces_only(table):
    with pytest.raises(OutOfScopeError, match='only a workspace'):
        iter_registered_project_ids(table, workspace=NO_WORKSPACE)


def test_a_registry_row_names_a_project():
    with pytest.raises(ValueError, match='names a project id'):
        project_registry_key('', workspace=A)
