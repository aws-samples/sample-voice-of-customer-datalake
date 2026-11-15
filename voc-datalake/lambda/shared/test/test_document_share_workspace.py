"""Review links per workspace (docs/multi-workspace.md, the project plan, 3e; 7.37.00).

In a workspace a link is ``WS#{ws}#DOCSHARE#{id}`` / ``META``, its series' pointer and listing and its registry row
``WS#{ws}#DOCSHARE_IDS`` / ``{id}`` are the workspace's, and its ``DOCSHARE#{id}`` row is a deployment-wide routing
row naming the workspace, written by the layer alone (shared/ws_repo.py ``route_share_id``) in the same transaction.
A reviewer's link is resolved by its id alone: the routing row's workspace, and nothing else. Without a workspace
every request is the one sent before (pinned below). Three scopes share one project and series id here.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared import document_share as ds
from shared import ws_repo
from shared.document_comments import email_digest
from shared.exceptions import ConflictError, NotFoundError
from shared.project_keys import comments_pk, project_pk, review_link_key, review_link_registry_pk
from shared.review_share_audience import share_key
from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import (
    OutOfScopeError,
    OutsideEntry,
    WorkspaceScope,
    claim_project_id,
    read_share_route,
    release_share_route,
    route_share_id,
    ws_table,
)

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
SCOPES = (None, A, B)
PROJECT = 'proj_shared_id'
SERIES = {'series_id': 'ser_' + 'a' * 24, 'document_type': 'prfaq', 'base_title': 'Launch'}
CREATOR = {'sub': 'owner-sub', 'name': 'Olive Owner'}
REVIEWER = 'rev@partner.example'
TABLE = 'voc-projects-test'
SHARE_ID = 'shr_' + 'd' * 32


@pytest.fixture
def table(monkeypatch):
    monkeypatch.setenv('PROJECTS_TABLE', TABLE)
    with mock_aws():
        yield create_pk_sk_table(TABLE)


def _create(table, scope, **values: Any) -> dict[str, Any]:
    share, created = ds.create_share(table, project_id=PROJECT, series=SERIES, document_id='doc_1', creator=CREATOR,
                                     values=ds.validate_share_body(values), workspace=scope)
    assert created
    return share


def _partition(table, pk: str) -> list[dict]:
    return table.query(KeyConditionExpression=Key('pk').eq(pk), ConsistentRead=True)['Items']


def test_each_scope_keeps_its_own_link_for_one_series(table):
    made = {scope: _create(table, scope) for scope in SCOPES}
    assert len({share['share_id'] for share in made.values()}) == 3
    for scope in SCOPES:
        assert ds.current_share(table, PROJECT, SERIES['series_id'], workspace=scope) == made[scope]


def test_a_workspace_link_is_its_row_its_pointer_its_listing_its_registry_row_and_a_route(table):
    share = _create(table, A)
    share_id = share['share_id']
    assert (share['pk'], share['sk']) == (f'WS#{A.ws}#DOCSHARE#{share_id}', 'META')
    [route] = _partition(table, f'DOCSHARE#{share_id}')
    assert set(route) == {'pk', 'sk', 'workspace_id', 'routed_at', 'ttl'}
    assert route['workspace_id'] == A.ws
    # The route expires with the link (its ttl), leaving an expired link dark; the registry row has none, so the
    # workspace's delete always finds the link.
    [registry] = _partition(table, review_link_registry_pk(A))
    assert (registry['sk'], 'ttl' in registry, route['ttl']) == (share_id, False, share['ttl'])
    # The registry row names the link's project and series, so the per-project delete (3h) reaches its links.
    assert (registry['project_id'], registry['series_id']) == (PROJECT, SERIES['series_id'])
    assert [row['share_id'] for row in _partition(table, comments_pk(PROJECT, SERIES['series_id'], workspace=A))] == [
        share_id]
    assert [row['sk'] for row in _partition(table, project_pk(PROJECT, workspace=A))] == [
        f"COMMENT_SERIES#{SERIES['series_id']}"]


def test_a_deployment_link_is_its_one_row_and_its_pointer_as_before(table):
    share = _create(table, None)
    assert (share['pk'], share['sk']) == (f"DOCSHARE#{share['share_id']}", 'META')
    assert 'workspace_id' not in _partition(table, share['pk'])[0]
    assert len(table.scan()['Items']) == 2


def test_a_reviewer_resolves_a_workspace_link_by_its_id_alone(table):
    share = _create(table, A)
    found, workspace = ds.require_share_for(table, share['share_id'], REVIEWER)
    assert (found, workspace) == (share, A)


def test_a_route_naming_no_workspace_id_refuses(table):
    share = _create(table, A)
    table.update_item(Key=share_key(share['share_id']), UpdateExpression='SET workspace_id = :bad',
                      ExpressionAttributeValues={':bad': 'ws_bad'})
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share['share_id'], REVIEWER)


@pytest.mark.parametrize('mismatch', ['missing', 'another-id', 'other-workspace'])
def test_a_route_whose_workspace_holds_no_link_of_that_id_refuses(table, mismatch):
    share = _create(table, A)
    share_id = share['share_id']
    if mismatch == 'missing':
        table.delete_item(Key=review_link_key(share_id, workspace=A))
    elif mismatch == 'another-id':
        table.put_item(Item={**share, 'share_id': SHARE_ID})
    else:
        # The route names B, which holds no link of this id: A's link is never read.
        table.update_item(Key=share_key(share_id), UpdateExpression='SET workspace_id = :b',
                          ExpressionAttributeValues={':b': B.ws})
    with pytest.raises(NotFoundError, match=ds.LINK_GONE):
        ds.require_share_for(table, share_id, REVIEWER)


def test_revoking_a_workspace_link_revokes_that_one_only(table):
    made = {scope: _create(table, scope) for scope in SCOPES}
    assert ds.revoke_share(table, PROJECT, SERIES['series_id'], 'Olive', workspace=A)
    assert ds.current_share(table, PROJECT, SERIES['series_id'], workspace=A) is None
    assert [ds.current_share(table, PROJECT, SERIES['series_id'], workspace=scope) for scope in (None, B)] == [
        made[None], made[B]]
    assert table.get_item(Key=review_link_key(made[A]['share_id'], workspace=A))['Item']['revoked'] is True


def test_a_reviewers_writes_are_counted_in_the_links_workspace(table):
    ds.count_reviewer_write(table, SHARE_ID, REVIEWER, workspace=A)
    ds.count_reviewer_write(table, SHARE_ID, REVIEWER)
    rate = f'DCRATE#{SHARE_ID}#{email_digest(REVIEWER)}'
    assert [row['n'] for row in _partition(table, f'WS#{A.ws}#{rate}')] == [1]
    assert [row['n'] for row in _partition(table, rate)] == [1]
    assert _partition(table, f'WS#{B.ws}#{rate}') == []


def test_a_held_route_cancels_the_whole_create(table):
    """The route is put only if absent: one already there (a clash of ids) cancels the transaction, and nothing of
    the workspace's link is written."""
    table.put_item(Item={**share_key(SHARE_ID), 'workspace_id': B.ws, 'routed_at': 'x'})
    with patch.object(ds, 'new_share_id', return_value=SHARE_ID), pytest.raises(ConflictError, match='changed'):
        _create(table, A)
    assert [row['pk'] for row in table.scan()['Items']] == [f'DOCSHARE#{SHARE_ID}']


class RecordingClient:
    """The table's client, recording each transaction it sends (every other call passed straight on)."""

    def __init__(self, client: Any) -> None:
        self.client, self.calls = client, []

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)

    def transact_write_items(self, **request: Any) -> Any:
        self.calls.append(request)
        return self.client.transact_write_items(**request)


def test_the_deployments_create_is_the_transaction_sent_before(table, monkeypatch):
    recording = RecordingClient(table.meta.client)
    monkeypatch.setattr(table.meta, 'client', recording)
    share = _create(table, None)
    index = {'pk': comments_pk(PROJECT, SERIES['series_id']), 'sk': 'SHARE', 'share_id': share['share_id'],
             'updated_at': share['created_at']}
    assert recording.calls == [{'TransactItems': [
        {'Put': {'TableName': TABLE, 'Item': share, 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'TableName': TABLE, 'Item': index}},
    ]}]


# ── The layer's route (shared/ws_repo.py) ─────────────────────────────────────

@pytest.mark.parametrize(('share_id', 'workspace', 'message'), [
    (SHARE_ID, None, 'never the deployment'),
    (SHARE_ID, A.ws, 'never the deployment'),
    ('shr_x', A, 'names a review link id'),
    (f'{SHARE_ID}#x', A, 'names a review link id'),
])
def test_a_route_is_made_for_a_real_workspace_and_a_link_id_only(share_id, workspace, message):
    with pytest.raises(OutOfScopeError, match=message):
        route_share_id(share_id, workspace=workspace, routed_at='2026-11-15T00:00:00Z', ttl=TTL)


TTL = 1_900_000_000


def _entry(scope) -> dict[str, Any]:
    return {'Put': {'Item': {**review_link_key(SHARE_ID, workspace=scope), 'share_id': SHARE_ID}}}


@pytest.mark.parametrize('case', ['another-workspace', 'not-an-outside-entry', 'unbuilt', 'another-table'])
def test_a_transaction_takes_one_route_of_its_own_workspace_on_voc_projects(table, case, monkeypatch):
    outside: Any = route_share_id(SHARE_ID, workspace=A, routed_at='2026-11-15T00:00:00Z', ttl=TTL)
    view = ws_table(A, table)
    if case == 'another-workspace':
        view = ws_table(B, table)
    elif case == 'not-an-outside-entry':
        outside = {'Put': {'Item': {**share_key(SHARE_ID), 'workspace_id': A.ws}}}
    elif case == 'unbuilt':
        outside = object.__new__(OutsideEntry)
    else:
        monkeypatch.setenv('PROJECTS_TABLE', 'voc-another-table')
    with pytest.raises(OutOfScopeError, match=r'share route|of its own workspace'):
        view.transact_write_items([_entry(A if case != 'another-workspace' else B)], outside=outside)
    assert table.scan()['Items'] == []


def test_a_claim_and_a_route_are_one_kind_of_entry_built_by_the_layer_only():
    route = route_share_id(SHARE_ID, workspace=A, routed_at='2026-11-15T00:00:00Z', ttl=TTL)
    claim = claim_project_id(PROJECT, workspace=A, claimed_at='2026-11-15T00:00:00Z')
    assert [(entry.kind, entry.item_id, entry.ttl) for entry in (route, claim)] == [
        ('route', SHARE_ID, TTL), ('claim', PROJECT, None)]
    assert {type(route), type(claim)} == {OutsideEntry}
    with pytest.raises(TypeError, match='built by claim_project_id or route_share_id only'):
        OutsideEntry(object(), 'route', A, SHARE_ID, 'x', TTL)


@pytest.mark.parametrize('ttl', [0, -1, True, False, None, 1.5, '1900000000'],
                         ids=['zero', 'negative', 'true', 'false', 'none', 'float', 'string'])
def test_a_routes_ttl_is_a_positive_int(ttl):
    with pytest.raises(ValueError, match="share route's ttl is a positive epoch second"):
        route_share_id(SHARE_ID, workspace=A, routed_at='2026-11-15T00:00:00Z', ttl=ttl)


@pytest.mark.parametrize('ttl', [TTL, 1, True])
def test_a_claims_ttl_is_none(ttl):
    """A claim is kept for good: the one builder of both kinds refuses any ttl on it."""
    with pytest.raises(ValueError, match="project claim's ttl is none"):
        ws_repo._outside('claim', PROJECT, A, '2026-11-15T00:00:00Z', ttl)
    assert claim_project_id(PROJECT, workspace=A, claimed_at='2026-11-15T00:00:00Z').ttl is None


def test_a_route_is_read_as_its_workspace_and_a_deployment_link_as_itself(table):
    table.put_item(Item={**share_key(SHARE_ID), 'workspace_id': A.ws, 'routed_at': 'x'})
    deployment_id = 'shr_' + 'e' * 32
    table.put_item(Item={**share_key(deployment_id), 'share_id': deployment_id})
    assert read_share_route(table, SHARE_ID) == (None, A)
    assert read_share_route(table, deployment_id) == ({**share_key(deployment_id), 'share_id': deployment_id}, None)
    assert read_share_route(table, 'shr_' + 'f' * 32) == (None, None)


def test_a_route_is_released_only_while_it_names_the_workspace(table):
    deployment_id = 'shr_' + 'e' * 32
    table.put_item(Item={**share_key(SHARE_ID), 'workspace_id': B.ws, 'routed_at': 'x'})
    table.put_item(Item={**share_key(deployment_id), 'share_id': deployment_id})
    assert not release_share_route(table, SHARE_ID, workspace=A)
    assert not release_share_route(table, deployment_id, workspace=A)
    assert len(table.scan()['Items']) == 2
    assert release_share_route(table, SHARE_ID, workspace=B)
    assert table.get_item(Key=share_key(SHARE_ID)).get('Item') is None
