"""workspaces_handler.py: PUT /me/workspaces/current, a workspace's rename (moto-backed; shared/workspace_rename.py,
7.40.00)."""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event
from test_workspaces_members_routes import ADA, PAT, VIC, WS
from workspaces_api_world import handler_doubles

import workspaces_handler
from shared.workspace_rename import WORKSPACE_RENAMED, sync_member_names

OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
CURRENT = '/me/workspaces/current'


@dataclass
class World:
    table: Any


def _listing(name: str, ws: str = WS, slug: str = 'acme', status: str = 'active') -> dict:
    return {'pk': 'WORKSPACES', 'sk': f'{name.casefold()}#{ws}', 'workspace_id': ws, 'name': name, 'slug': slug,
            'status': status, 'created_at': '2026-11-15T10:00:00+00:00', 'secret_status': 'ready'}


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    handler_doubles(monkeypatch)
    with mock_aws():
        table = pk_sk_table('workspaces')
        rows = [
            {'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Matisa', 'slug': 'acme', 'status': 'active'},
            {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'admin'},
            {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic', 'role': 'viewer'},
            {'pk': 'USER#sub-ada', 'sk': f'WS#{WS}', 'name': 'Matisa', 'slug': 'acme', 'role': 'admin'},
            {'pk': 'USER#sub-vic', 'sk': f'WS#{WS}', 'name': 'Matisa', 'slug': 'acme', 'role': 'viewer'},
            _listing('Matisa'),
            # Another workspace Ada belongs to: nothing of it changes.
            {'pk': f'WS#{OTHER}', 'sk': 'META', 'name': 'Beta', 'slug': 'beta', 'status': 'active'},
            {'pk': 'USER#sub-ada', 'sk': f'WS#{OTHER}', 'name': 'Beta', 'slug': 'beta', 'role': 'admin'},
            _listing('Beta', OTHER, 'beta'),
        ]
        for row in rows:
            table.put_item(Item=row)
        yield World(table)


def _call(world, lambda_context, body, claims=ADA):
    event = rest_event('PUT', CURRENT, claims=claims, body=body)
    event['headers']['X-Workspace-Id'] = WS
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.table)


def _get(world, pk, sk):
    return world.table.get_item(Key={'pk': pk, 'sk': sk}).get('Item')


def _listing_rows(world) -> list[dict]:
    return world.table.query(KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': 'WORKSPACES'})['Items']


def _audit_kinds(world) -> list[str]:
    rows = world.table.query(KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    return [row['kind'] for row in rows]


def test_an_admin_renames_meta_the_listing_and_every_members_menu_row(world, lambda_context):
    status, body = _call(world, lambda_context, {'name': '  Matias  '})
    assert status == 200
    assert body['workspace'] == {'id': WS, 'name': 'Matias', 'slug': 'acme', 'role': 'admin', 'platform_admin': False}
    assert _get(world, f'WS#{WS}', 'META')['name'] == 'Matias'
    assert [(row['sk'], row['name']) for row in _listing_rows(world)] == [
        (f'beta#{OTHER}', 'Beta'), (f'matias#{WS}', 'Matias')]
    moved = next(row for row in _listing_rows(world) if row['workspace_id'] == WS)
    assert {k: moved[k] for k in ('slug', 'status', 'created_at', 'secret_status')} == {
        'slug': 'acme', 'status': 'active', 'created_at': '2026-11-15T10:00:00+00:00', 'secret_status': 'ready'}
    assert _get(world, 'USER#sub-ada', f'WS#{WS}')['name'] == 'Matias'
    assert _get(world, 'USER#sub-vic', f'WS#{WS}')['name'] == 'Matias'
    assert _get(world, 'USER#sub-ada', f'WS#{OTHER}')['name'] == 'Beta'
    assert _audit_kinds(world) == [WORKSPACE_RENAMED]


def test_the_audit_row_records_no_name(world, lambda_context):
    """An audit row is kept for good (the audit-row guard), and a name may name a person (TENETS.md D5)."""
    _call(world, lambda_context, {'name': 'Matias'})
    row = world.table.query(KeyConditionExpression='pk = :pk',
                            ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items'][0]
    assert set(row) == {'pk', 'sk', 'kind', 'actor', 'at', 'platform_admin'}
    assert 'Matias' not in str(row)
    assert 'Matisa' not in str(row)


def test_a_change_of_case_only_keeps_one_listing_row(world, lambda_context):
    status, _ = _call(world, lambda_context, {'name': 'MATISA'})
    assert status == 200
    ours = [row for row in _listing_rows(world) if row['workspace_id'] == WS]
    assert [(row['sk'], row['name']) for row in ours] == [(f'matisa#{WS}', 'MATISA')]


def test_a_viewer_is_refused_and_nothing_is_written(world, lambda_context):
    before = world.table.scan()['Items']
    status, _ = _call(world, lambda_context, {'name': 'Matias'}, claims=VIC)
    assert status == 403
    assert world.table.scan()['Items'] == before


@pytest.mark.parametrize('body', [{'name': ''}, {'name': '   '}, {'name': 'x' * 81}, {'name': 'a\nb'}, {'name': 7},
                                  {'name': 'Matias', 'slug': 'other'}, {}])
def test_a_bad_body_is_refused_before_anything_is_read_or_written(world, lambda_context, body):
    before = world.table.scan()['Items']
    status, _ = _call(world, lambda_context, body)
    assert status == 400
    assert world.table.scan()['Items'] == before


def test_the_same_name_writes_no_audit_and_repairs_the_members_rows(world, lambda_context):
    world.table.update_item(Key={'pk': 'USER#sub-vic', 'sk': f'WS#{WS}'}, UpdateExpression='SET #n = :n',
                            ExpressionAttributeNames={'#n': 'name'}, ExpressionAttributeValues={':n': 'stale'})
    status, _ = _call(world, lambda_context, {'name': 'Matisa'})
    assert status == 200
    assert _get(world, 'USER#sub-vic', f'WS#{WS}')['name'] == 'Matisa'
    assert _audit_kinds(world) == []


def test_a_workspace_marked_deleting_meanwhile_is_not_renamed(world, lambda_context, monkeypatch):
    """The delete's status lands on the listing row between the resolve and the rename's commit: 409, no rename."""
    from shared import workspace_rename

    real = workspace_rename._listing_row

    def read_then_delete_lands(table, context):
        row = real(table, context)
        table.update_item(Key={'pk': 'WORKSPACES', 'sk': row['sk']}, UpdateExpression='SET #s = :d',
                          ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})
        return row

    monkeypatch.setattr(workspace_rename, '_listing_row', read_then_delete_lands)
    status, body = _call(world, lambda_context, {'name': 'Matias'})
    assert (status, body['error']) == (409, workspace_rename.RENAME_CHANGED_MEANWHILE)
    assert _get(world, f'WS#{WS}', 'META')['name'] == 'Matisa'
    assert _get(world, 'USER#sub-ada', f'WS#{WS}')['name'] == 'Matisa'


def test_an_admin_demoted_meanwhile_renames_nothing(world, lambda_context, monkeypatch):
    from shared import workspace_rename

    real = workspace_rename._listing_row

    def read_then_demoted(table, context):
        table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada'}, UpdateExpression='SET #r = :v',
                          ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'viewer'})
        return real(table, context)

    monkeypatch.setattr(workspace_rename, '_listing_row', read_then_demoted)
    status, body = _call(world, lambda_context, {'name': 'Matias'})
    assert (status, body['error']) == (403, workspace_rename.NO_LONGER_ADMIN)
    assert _get(world, f'WS#{WS}', 'META')['name'] == 'Matisa'


def test_a_platform_admin_who_entered_renames_without_a_member_row(world, lambda_context):
    status, body = _call(world, lambda_context, {'name': 'Matias'}, claims=PAT)
    assert status == 200
    assert body['workspace']['platform_admin'] is True
    assert _get(world, f'WS#{WS}', 'META')['name'] == 'Matias'
    # The entry and the rename, both audited.
    assert sorted(_audit_kinds(world)) == ['platform_admin_entry', WORKSPACE_RENAMED]


def test_the_members_sync_skips_a_member_removed_meanwhile(world):
    world.table.delete_item(Key={'pk': 'USER#sub-vic', 'sk': f'WS#{WS}'})
    assert sync_member_names(world.table, WS, 'Matias') == 1
    assert _get(world, 'USER#sub-vic', f'WS#{WS}') is None
