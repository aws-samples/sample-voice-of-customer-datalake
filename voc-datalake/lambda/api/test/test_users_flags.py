"""Route tests for user flags in users_handler.py (GET /users rows, PUT /users/{username}/flags,
and the fallback-owner drop on demotion), against a moto aggregates table."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import users_handler
from shared import user_flags
from shared.test.moto_tables import create_pk_sk_table
from users_handler import lambda_handler

ADMIN = {'sub': 'admin-sub', 'cognito:groups': 'admins'}
SUBS = {'alice': 'sub-alice', 'bob': 'sub-bob'}


def _cognito(groups_by_user):
    cognito = MagicMock()
    cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    cognito.admin_get_user.side_effect = lambda Username, **_kw: {
        'UserAttributes': [{'Name': 'sub', 'Value': SUBS[Username]}]}
    cognito.admin_list_groups_for_user.side_effect = lambda Username, **_kw: {
        'Groups': [{'GroupName': g} for g in groups_by_user[Username]]}
    group_names = list(dict.fromkeys(g for groups in groups_by_user.values() for g in groups))
    cognito.list_groups.return_value = {'Groups': [{'GroupName': g} for g in group_names]}
    cognito.list_users_in_group.side_effect = lambda GroupName, **_kw: {
        'Users': [{'Username': user} for user, groups in groups_by_user.items() if GroupName in groups]}
    cognito.list_users.return_value = {'Users': [
        {'Username': name, 'Attributes': [{'Name': 'sub', 'Value': sub}], 'UserStatus': 'CONFIRMED',
         'Enabled': True, 'UserCreateDate': datetime(2026, 1, 1, tzinfo=UTC)}
        for name, sub in SUBS.items()]}
    return cognito


@pytest.fixture
def table():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        table = create_pk_sk_table('test-aggregates', resource)
        with patch.object(users_handler, 'aggregates_table', table), \
                patch.object(users_handler, 'get_dynamodb_resource', return_value=resource):
            yield table


@pytest.fixture
def cognito():
    groups = {'alice': ['admins'], 'bob': ['users']}
    mock = _cognito(groups)
    with patch.object(users_handler, 'cognito', mock):
        yield mock


def _put_flags(api_gateway_event, lambda_context, username, body, claims=ADMIN):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='PUT',
                      path=f'/users/{username}/flags', body=body, claims=claims)


@pytest.mark.usefixtures('cognito')
class TestFlagsRoute:
    def test_admin_sets_flags_and_list_shows_them(self, api_gateway_event, lambda_context, table):
        response, body = _put_flags(api_gateway_event, lambda_context, 'alice', {'fallback_owner': True})
        assert response['statusCode'] == 200
        assert body['flags'] == {'fallback_owner': True, 'memory_reviewer': False}
        _put_flags(api_gateway_event, lambda_context, 'bob', {'memory_reviewer': True})

        _, listed = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path='/users', claims=ADMIN)
        flags = {u['username']: u['flags'] for u in listed['users']}
        assert flags == {'alice': {'fallback_owner': True, 'memory_reviewer': False},
                         'bob': {'fallback_owner': False, 'memory_reviewer': True}}
        assert user_flags.get_fallback_owner(table) == {'sub': 'sub-alice', 'username': 'alice'}

    def test_demotion_drops_fallback_owner(self, api_gateway_event, lambda_context, table):
        _put_flags(api_gateway_event, lambda_context, 'alice', {'fallback_owner': True})
        response, _ = call_route(lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                 path='/users/alice/group', body={'group': 'users'}, claims=ADMIN)
        assert response['statusCode'] == 200
        assert user_flags.get_fallback_owner(table) is None


@pytest.mark.usefixtures('cognito')
def test_list_degrades_when_flags_are_unreadable(api_gateway_event, lambda_context):
    from botocore.exceptions import ClientError
    with patch.object(users_handler.user_flags, 'flags_for_subs',
                      side_effect=ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'BatchGetItem')):
        response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path='/users', claims=ADMIN)
    assert response['statusCode'] == 200
    assert all(u['flags'] == {'fallback_owner': False, 'memory_reviewer': False} for u in body['users'])
