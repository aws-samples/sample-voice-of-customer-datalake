"""DELETE /users/{username} removes the user's workspace memberships first (docs/multi-workspace.md → Invites).

Against a moto voc-workspaces table and a Cognito double that keeps each user's groups: the memberships go (each
audited first) BEFORE ``AdminDeleteUser``; the last admin of a workspace is refused (409, the account untouched)
unless the caller is a platform admin, live-checked; a fault while removing them leaves the account.
"""
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from moto import mock_aws
from users_table_fixtures import cognito_users

import users_handler
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_members import VIA_USER_DELETED

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
PLATFORM_CALLER = {'sub': 'sub-root', 'cognito:username': 'root', 'cognito:groups': '[admins, platform-admins]'}
ADMIN_CALLER = {'sub': 'sub-root', 'cognito:username': 'root', 'cognito:groups': 'admins'}
GROUPS = {'root': ['admins', 'platform-admins'], 'ada': ['admins'], 'gus': ['users']}


@pytest.fixture
def workspaces() -> Iterator[Any]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = create_pk_sk_table('test-aggregates', resource)
        table = create_pk_sk_table('test-workspaces', resource)
        table.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme',
                             'status': 'active'})
        with patch.object(users_handler, 'aggregates_table', aggregates), \
                patch.object(users_handler, 'workspaces_table', table):
            yield table


def _member(table: Any, sub: str, role: str) -> None:
    """The membership's two rows: the inverse ("my workspaces") row, then the MEMBER# row."""
    inverse = {'pk': f'USER#{sub}', 'sk': f'WS#{WS}', 'name': 'Acme Outfitters', 'slug': 'acme'}
    for row in (inverse, {'pk': f'WS#{WS}', 'sk': f'MEMBER#{sub}'}):
        table.put_item(Item={**row, 'role': role})


def _rows(table: Any) -> set[tuple[str, str]]:
    return {(row['pk'], row['sk']) for row in table.scan()['Items'] if not str(row['pk']).startswith('AUDIT#')}


def _cognito() -> Any:
    cognito = cognito_users({name: f'sub-{name}' for name in GROUPS})

    def user_of(Username: str, **_kw: Any) -> dict:
        if Username not in GROUPS:
            raise cognito.exceptions.UserNotFoundException
        return {'Username': Username, 'Enabled': True, 'UserAttributes': [{'Name': 'sub', 'Value': f'sub-{Username}'}]}

    cognito.admin_get_user.side_effect = user_of
    cognito.admin_list_groups_for_user.side_effect = lambda Username, **_kw: {
        'Groups': [{'GroupName': group} for group in GROUPS[Username]]}
    cognito.list_users_in_group.side_effect = lambda GroupName, **_kw: {'Users': [
        {'Username': name, 'Enabled': True} for name, groups in GROUPS.items() if GroupName in groups]}
    return cognito


def _delete(api_gateway_event, lambda_context, cognito: Any, claims: dict) -> tuple[int, Any]:
    with patch.object(users_handler, 'cognito', cognito):
        response, decoded = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context,
                                       method='DELETE', path='/users/gus', claims=claims)
    return response['statusCode'], decoded


def test_the_memberships_go_before_the_account(api_gateway_event, lambda_context, workspaces):
    _member(workspaces, 'sub-gus', 'editor')
    _member(workspaces, 'sub-ada', 'admin')
    cognito = _cognito()
    seen: list[set] = []
    cognito.admin_delete_user.side_effect = lambda **_kw: seen.append(_rows(workspaces))
    status, answer = _delete(api_gateway_event, lambda_context, cognito, ADMIN_CALLER)
    assert (status, answer['message']) == (200, 'User deleted')
    # When Cognito was asked to delete the account, the memberships were already gone.
    assert seen == [{(f'WS#{WS}', 'META'), (f'WS#{WS}', 'MEMBER#sub-ada'), ('USER#sub-ada', f'WS#{WS}')}]
    [audit] = workspaces.query(KeyConditionExpression='pk = :pk',
                               ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    assert (audit['kind'], audit['via'], audit['actor'], audit['target']) == (
        'member_removed', VIA_USER_DELETED, 'sub-root', 'sub-gus')


def test_the_last_admin_of_a_workspace_is_a_409_and_the_account_stays(api_gateway_event, lambda_context, workspaces):
    _member(workspaces, 'sub-gus', 'admin')
    cognito = _cognito()
    status, answer = _delete(api_gateway_event, lambda_context, cognito, ADMIN_CALLER)
    assert status == 409
    assert answer['error'].startswith('This user is the last admin of the workspace "Acme Outfitters": ')
    cognito.admin_delete_user.assert_not_called()
    assert (f'WS#{WS}', 'MEMBER#sub-gus') in _rows(workspaces)


def test_a_platform_admin_deletes_the_last_admin_and_the_workspace_keeps_none(
        api_gateway_event, lambda_context, workspaces):
    _member(workspaces, 'sub-gus', 'admin')
    cognito = _cognito()
    status, _answer = _delete(api_gateway_event, lambda_context, cognito, PLATFORM_CALLER)
    assert status == 200
    cognito.admin_delete_user.assert_called_once()
    assert _rows(workspaces) == {(f'WS#{WS}', 'META')}
    [audit] = workspaces.query(KeyConditionExpression='pk = :pk',
                               ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    assert (audit['platform_admin'], audit['left_without_admin']) == (True, True)


def test_a_fault_while_removing_the_memberships_leaves_the_account(api_gateway_event, lambda_context, workspaces):
    _member(workspaces, 'sub-gus', 'editor')
    cognito = _cognito()
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'table arn'}}, 'TransactWriteItems')
    with patch.object(workspaces.meta.client, 'transact_write_items', side_effect=fault):
        status, answer = _delete(api_gateway_event, lambda_context, cognito, ADMIN_CALLER)
    assert (status, answer['error']) == (500, users_handler.FAILED_DELETE_USER)
    cognito.admin_delete_user.assert_not_called()


def test_without_the_workspaces_table_the_delete_reads_no_memberships(api_gateway_event, lambda_context, workspaces):
    _member(workspaces, 'sub-gus', 'admin')
    cognito = _cognito()
    with patch.object(users_handler, 'workspaces_table', None):
        status, _answer = _delete(api_gateway_event, lambda_context, cognito, ADMIN_CALLER)
    assert status == 200
    assert (f'WS#{WS}', 'MEMBER#sub-gus') in _rows(workspaces)
