"""workspaces_handler.py: POST and GET /platform/workspaces, and the live check on entering a workspace (moto-backed,
docs/multi-workspace.md, Control plane and Credentials)."""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared import platform_admin_gate
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache

PAT = {'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'admins'}
UMA = {'sub': 'sub-uma', 'cognito:username': 'uma', 'cognito:groups': 'users'}
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
BODY = {'name': 'Acme Outfitters', 'slug': 'acme'}
# A token that still carries platform-admins, for a caller Cognito no longer has in the group, or has disabled.
STALE_TOKENS = [live_cognito(('admins',)), live_cognito(enabled=False)]


@dataclass
class World:
    table: Any
    secrets: Any
    key: str
    cognito: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws(), patch.object(workspaces_handler, 'memberships', MembershipCache()):
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        secrets = boto3.client('secretsmanager', region_name='us-east-1')
        state = World(pk_sk_table('workspaces'), secrets, key, live_cognito())
        with patch.object(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool'), \
                patch.object(workspaces_handler, 'KMS_KEY_ARN', key), \
                patch.object(workspaces_handler, 'WORKSPACE_SECRET_PREFIX', 'voc/ws'), \
                patch.object(workspaces_handler, 'get_secrets_client', return_value=secrets), \
                patch.object(workspaces_handler, 'get_cognito_idp_client', side_effect=lambda: state.cognito), \
                patch.dict('os.environ', {'USER_POOL_ID': 'us-east-1_pool'}), \
                patch.object(platform_admin_gate, 'get_cognito_idp_client', side_effect=lambda: state.cognito):
            yield state


def _call(world, lambda_context, method, path, claims=PAT, body=None, query=None, headers=None):
    event = rest_event(method, path, claims=claims, body=body)
    event['queryStringParameters'] = query
    event['headers'].update(headers or {})
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.table)


def _rows(world, pk):
    return world.table.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


# ── POST /platform/workspaces ────────────────────────────────────────────────

def test_a_platform_admin_creates_a_workspace_and_is_its_admin(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)
    assert status == 201
    ws = body['workspace']['id']
    assert body == {'workspace': {'id': ws, 'name': 'Acme Outfitters', 'slug': 'acme', 'role': 'admin',
                                  'secret_status': 'ready'}}
    assert [row['role'] for row in _rows(world, 'USER#sub-pat')] == ['admin']
    assert world.table.get_item(Key={'pk': f'WS#{ws}', 'sk': 'META'})['Item']['secret_status'] == 'ready'
    # The creator's own picker lists it at once.
    assert _call(world, lambda_context, 'GET', '/me/workspaces')[1]['workspaces'][0]['id'] == ws


def test_the_credentials_secret_is_made_with_the_key_and_the_tag(world, lambda_context):
    ws = _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)[1]['workspace']['id']
    described = world.secrets.describe_secret(SecretId=f'voc/ws/{ws}/credentials')
    assert (described['KmsKeyId'], described['Tags']) == (world.key, [{'Key': 'workspace_id', 'Value': ws}])


def test_no_request_field_reaches_the_secret_name(world, lambda_context):
    hostile = {'name': '../voc-datalake/api-credentials', 'slug': 'other-secret'}
    with patch.object(workspaces_handler, 'ensure_credentials_secret',
                      wraps=workspaces_handler.ensure_credentials_secret) as ensure:
        status, body = _call(world, lambda_context, 'POST', '/platform/workspaces', body=hostile,
                             headers={'X-Workspace-Id': WS})
    assert status == 201
    [call] = ensure.call_args_list
    assert call.kwargs == {'prefix': 'voc/ws', 'ws': body['workspace']['id'], 'kms_key_arn': world.key}
    assert [s['Name'] for s in world.secrets.list_secrets()['SecretList']] == [
        f'voc/ws/{body["workspace"]["id"]}/credentials']


def test_a_secret_that_cannot_be_made_leaves_the_workspace_pending_and_says_so(world, lambda_context):
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'arn:secret'}}, 'CreateSecret')
    with patch.object(world.secrets, 'create_secret', side_effect=denied), \
            patch.object(workspaces_handler, 'logger') as log:
        status, body = _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)
    _assert_left_pending(world, status, body, log)


def _assert_left_pending(world: Any, status: int, body: dict, log: Any) -> str:
    """The create answered 201 ``pending``, META still says ``pending``, and the failure was logged; the id."""
    ws = body['workspace']['id']
    assert (status, body['workspace']['secret_status']) == (201, 'pending')
    assert world.table.get_item(Key={'pk': f'WS#{ws}', 'sk': 'META'})['Item']['secret_status'] == 'pending'
    log.exception.assert_called_once_with(
        'Workspace created without its credentials secret: secret_status stays pending', extra={'workspace_id': ws})
    return ws


def test_a_secret_made_but_not_marked_ready_says_pending_and_the_secret_is_there_to_recover(world, lambda_context):
    # The case the recovery steps name (docs/multi-workspace.md, Credentials): the secret exists, only the mark failed.
    denied = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
                         'TransactWriteItems')
    with patch.object(workspaces_handler, 'mark_secret_ready', side_effect=denied), \
            patch.object(workspaces_handler, 'logger') as log:
        status, body = _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)
    ws = _assert_left_pending(world, status, body, log)
    [secret] = world.secrets.list_secrets()['SecretList']
    assert {'Key': 'workspace_id', 'Value': ws} in secret['Tags']


def test_a_slug_that_is_taken_is_a_409(world, lambda_context):
    _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)
    status, body = _call(world, lambda_context, 'POST', '/platform/workspaces',
                         body={'name': 'Another', 'slug': 'acme'})
    assert (status, body['error']) == (409, 'That slug is taken: choose another')
    assert len(world.secrets.list_secrets()['SecretList']) == 1


def test_a_bad_body_is_a_400_and_writes_nothing(world, lambda_context):
    status, _ = _call(world, lambda_context, 'POST', '/platform/workspaces', body={'name': 'Acme', 'slug': 'API'})
    assert status == 400
    assert world.table.scan()['Items'] == []


@pytest.mark.parametrize('claims', [ADA, UMA], ids=['administrator', 'user'])
def test_everyone_but_a_platform_admin_gets_403(world, lambda_context, claims):
    for method, body in (('POST', BODY), ('GET', None)):
        assert _call(world, lambda_context, method, '/platform/workspaces', claims=claims, body=body)[0] == 403
    world.cognito.admin_list_groups_for_user.assert_not_called()


@pytest.mark.parametrize('cognito', STALE_TOKENS, ids=['revoked', 'disabled'])
def test_a_stale_platform_admin_token_gets_403_by_the_live_check(world, lambda_context, cognito):
    world.cognito = cognito
    for method, body in (('POST', BODY), ('GET', None)):
        status, answer = _call(world, lambda_context, method, '/platform/workspaces', body=body)
        assert (status, answer['error']) == (403, 'Platform admin access required')
    assert world.table.scan()['Items'] == []


def test_a_failed_live_check_is_a_fixed_500(world, lambda_context):
    world.cognito.admin_get_user.side_effect = ClientError(
        {'Error': {'Code': 'InternalErrorException', 'Message': 'us-east-1_pool'}}, 'AdminGetUser')
    assert _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY) == (
        500, {'success': False, 'error': 'Failed to create the workspace'})


def test_a_failed_transaction_is_a_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'table arn'}}, 'TransactWriteItems')
    with patch.object(world.table.meta.client, 'transact_write_items', side_effect=fault):
        assert _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY) == (
            500, {'success': False, 'error': 'Failed to create the workspace'})


def test_an_unconfigured_secret_refuses_the_create_before_writing(world, lambda_context):
    with patch.object(workspaces_handler, 'KMS_KEY_ARN', ''):
        assert _call(world, lambda_context, 'POST', '/platform/workspaces', body=BODY)[0] == 500
    assert world.table.scan()['Items'] == []


def test_an_unconfigured_user_pool_refuses_the_live_check(world, lambda_context):
    with patch.dict('os.environ', {'USER_POOL_ID': ''}):
        assert _call(world, lambda_context, 'GET', '/platform/workspaces')[0] == 500


# ── GET /platform/workspaces ─────────────────────────────────────────────────

def test_the_list_pages_every_workspace_by_name(world, lambda_context):
    for name, slug in (('zephyr', 'zephyr'), ('Acme', 'acme'), ('birch', 'birch')):
        _call(world, lambda_context, 'POST', '/platform/workspaces', body={'name': name, 'slug': slug})
    status, first = _call(world, lambda_context, 'GET', '/platform/workspaces', query={'limit': '2'})
    assert (status, [w['name'] for w in first['workspaces']]) == (200, ['Acme', 'birch'])
    assert set(first['workspaces'][0]) == {'id', 'name', 'slug', 'status', 'created_at', 'secret_status'}
    _, second = _call(world, lambda_context, 'GET', '/platform/workspaces',
                      query={'limit': '2', 'cursor': first['next_cursor']})
    assert ([w['name'] for w in second['workspaces']], second['next_cursor']) == (['zephyr'], None)


@pytest.mark.parametrize('query', [{'limit': 'ten'}, {'cursor': 'bogus'}], ids=['limit', 'cursor'])
def test_a_bad_limit_or_cursor_is_a_400(world, lambda_context, query):
    assert _call(world, lambda_context, 'GET', '/platform/workspaces', query=query) == (
        400, {'success': False, 'error': 'limit or cursor is not valid'})


def test_an_unreadable_list_is_a_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'table arn'}}, 'Query')
    with patch.object(world.table, 'query', side_effect=fault):
        assert _call(world, lambda_context, 'GET', '/platform/workspaces') == (
            500, {'success': False, 'error': 'Failed to list the workspaces'})


# ── Entering a workspace: the live check ─────────────────────────────────────

def _seed_workspace(world):
    world.table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme', 'slug': 'acme', 'status': 'active'})


def test_a_platform_admin_enters_when_the_live_check_confirms(world, lambda_context):
    _seed_workspace(world)
    status, body = _call(world, lambda_context, 'GET', '/me/workspaces/current', headers={'X-Workspace-Id': WS})
    assert (status, body['workspace']['role'], body['workspace']['platform_admin']) == (200, 'admin', True)
    world.cognito.admin_get_user.assert_called_once_with(UserPoolId='us-east-1_pool', Username='pat')


@pytest.mark.parametrize('cognito', STALE_TOKENS, ids=['revoked', 'disabled'])
def test_a_stale_platform_admin_token_cannot_enter_a_workspace(world, lambda_context, cognito):
    _seed_workspace(world)
    world.cognito = cognito
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', headers={'X-Workspace-Id': WS}) == (
        404, {'success': False, 'error': 'Workspace not found'})
    assert _rows(world, f'AUDIT#WS#{WS}') == []


def test_a_failed_live_check_on_entry_is_a_fixed_500(world, lambda_context):
    _seed_workspace(world)
    world.cognito.admin_list_groups_for_user.side_effect = ClientError(
        {'Error': {'Code': 'TooManyRequestsException', 'Message': 'pool'}}, 'AdminListGroupsForUser')
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', headers={'X-Workspace-Id': WS}) == (
        500, {'success': False, 'error': 'Failed to open the workspace'})
