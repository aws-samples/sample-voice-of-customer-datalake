"""workspaces_handler.py: GET /me/workspaces and GET /me/workspaces/current (moto-backed, docs/multi-workspace.md)."""
import json
from collections.abc import Iterator
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared.workspace import MembershipCache

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
ANA = {'sub': 'sub-ana', 'cognito:groups': 'users'}
SAM = {'sub': 'sub-sam', 'cognito:groups': 'users'}
PAT = {'sub': 'sub-pat', 'cognito:groups': 'platform-admins'}
DENIED = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': f'not on AUDIT#WS#{WS}'}}, 'PutItem')


@pytest.fixture
def table() -> Iterator:
    with mock_aws(), patch.object(workspaces_handler, 'memberships', MembershipCache()):
        created = pk_sk_table('workspaces')
        for ws, name, slug in ((WS, 'Acme Outfitters', 'acme'), (OTHER_WS, 'Birch Lane', 'birch')):
            created.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'name': name, 'slug': slug, 'status': 'active'})
            created.put_item(Item={'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-ana', 'role': 'viewer'})
            created.put_item(Item={'pk': 'USER#sub-ana', 'sk': f'WS#{ws}', 'name': name, 'slug': slug,
                                   'role': 'viewer'})
        yield created


def _get(table, lambda_context, path, claims, headers=None):
    event = rest_event('GET', path, claims=claims)
    event['headers'].update(headers or {})
    return invoke(workspaces_handler, event, lambda_context, workspaces=table)


def test_my_workspaces_lists_the_callers_own_by_name(table, lambda_context):
    status, body = _get(table, lambda_context, '/me/workspaces', ANA)
    assert status == 200
    assert body == {'workspaces': [
        {'id': WS, 'name': 'Acme Outfitters', 'slug': 'acme', 'role': 'viewer'},
        {'id': OTHER_WS, 'name': 'Birch Lane', 'slug': 'birch', 'role': 'viewer'},
    ]}


def test_my_workspaces_is_empty_for_someone_with_none(table, lambda_context):
    assert _get(table, lambda_context, '/me/workspaces', SAM) == (200, {'workspaces': []})


def test_my_workspaces_lists_nothing_for_a_platform_admin_who_is_no_member(table, lambda_context):
    assert _get(table, lambda_context, '/me/workspaces', PAT) == (200, {'workspaces': []})


def test_the_current_workspace_is_the_one_the_header_names(table, lambda_context):
    status, body = _get(table, lambda_context, '/me/workspaces/current', ANA, {'x-workspace-id': OTHER_WS})
    assert status == 200
    assert body == {'workspace': {'id': OTHER_WS, 'name': 'Birch Lane', 'slug': 'birch', 'role': 'viewer',
                                  'platform_admin': False}}


def test_the_current_workspace_needs_the_header(table, lambda_context):
    status, body = _get(table, lambda_context, '/me/workspaces/current', ANA)
    assert (status, body['success']) == (400, False)


@pytest.mark.parametrize('ws', ['ws_bogus', 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ', WS], ids=['malformed', 'unknown', 'not-a-member'])
def test_every_workspace_the_caller_may_not_enter_answers_the_same_404(table, lambda_context, ws):
    assert _get(table, lambda_context, '/me/workspaces/current', SAM, {'X-Workspace-Id': ws}) == (
        404, {'success': False, 'error': 'Workspace not found'})


def test_a_platform_admin_enters_as_admin_and_the_entry_is_audited(table, lambda_context):
    for _ in range(2):
        status, body = _get(table, lambda_context, '/me/workspaces/current', PAT, {'X-Workspace-Id': WS})
        assert (status, body['workspace']['role'], body['workspace']['platform_admin']) == (200, 'admin', True)
    audit = table.query(KeyConditionExpression='pk = :pk',
                        ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    assert [(row['kind'], row['actor']) for row in audit] == [('platform_admin_entry', 'sub-pat')]


def test_an_entry_whose_audit_put_fails_is_a_generic_500(table, lambda_context):
    with patch.object(table, 'put_item', side_effect=DENIED), patch.object(workspaces_handler, 'logger') as log:
        status, body = _get(table, lambda_context, '/me/workspaces/current', PAT, {'X-Workspace-Id': WS})
    # Refused, and the answer names neither the table, the key nor the AWS error (they are logged).
    assert (status, body) == (500, {'success': False, 'error': 'Failed to open the workspace'})
    log.exception.assert_called_once_with('Error resolving the workspace')


def test_an_unreadable_workspace_list_is_a_generic_500(table, lambda_context):
    with patch.object(table, 'query', side_effect=DENIED):
        assert _get(table, lambda_context, '/me/workspaces', ANA) == (
            500, {'success': False, 'error': 'Failed to list your workspaces'})


def test_an_unconfigured_table_is_a_500(lambda_context):
    event = rest_event('GET', '/me/workspaces', claims=ANA)
    with patch.object(workspaces_handler, 'WORKSPACES_TABLE', ''):
        response = workspaces_handler.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 500


def test_the_configured_table_is_read_by_name(lambda_context):
    with mock_aws():
        pk_sk_table('voc-workspaces').put_item(Item={'pk': 'USER#sub-ana', 'sk': f'WS#{WS}', 'name': 'Acme',
                                                     'slug': 'acme', 'role': 'admin'})
        with patch.object(workspaces_handler, 'WORKSPACES_TABLE', 'voc-workspaces'):
            response = workspaces_handler.lambda_handler(rest_event('GET', '/me/workspaces', claims=ANA), lambda_context)
    assert (response['statusCode'], json.loads(response['body'])) == (200, {'workspaces': [
        {'id': WS, 'name': 'Acme', 'slug': 'acme', 'role': 'admin'}]})
