"""
Additional coverage tests for users_handler.py.
Covers: get_caller_groups edge cases, list_users pagination/errors,
create_user without name, update/reset/enable/disable/delete error paths.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestGetCallerGroupsEdgeCases:
    """Cover remaining get_caller_groups branches."""

    def test_handles_groups_as_list(self):
        from users_handler import get_caller_groups
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {'cognito:groups': ['admins', 'users']}
                }
            }
        }
        groups = get_caller_groups(event)
        assert groups == ['admins', 'users']

    def test_handles_missing_request_context(self):
        from users_handler import get_caller_groups
        groups = get_caller_groups({})
        assert groups == []

    def test_handles_exception_in_parsing(self):
        from users_handler import get_caller_groups
        # Pass something that will cause an error in .get() chain
        groups = get_caller_groups(None)
        assert groups == []


class TestListUsersEdgeCases:
    """Cover list_users pagination and error paths."""

    @patch('users_handler.cognito')
    def test_handles_pagination(self, mock_cognito, api_gateway_event, lambda_context):
        """Cover the pagination loop with PaginationToken."""
        first_page = {
            'Users': [{
                'Username': 'user1',
                'Attributes': [{'Name': 'email', 'Value': 'u1@example.com'}],
                'UserStatus': 'CONFIRMED',
                'Enabled': True,
                'UserCreateDate': datetime(2025, 1, 1, tzinfo=timezone.utc),
                'UserLastModifiedDate': datetime(2025, 1, 2, tzinfo=timezone.utc),
            }],
            'PaginationToken': 'next-page-token',
        }
        second_page = {
            'Users': [{
                'Username': 'user2',
                'Attributes': [{'Name': 'email', 'Value': 'u2@example.com'}],
                'UserStatus': 'CONFIRMED',
                'Enabled': True,
                'UserCreateDate': datetime(2025, 2, 1, tzinfo=timezone.utc),
                'UserLastModifiedDate': datetime(2025, 2, 2, tzinfo=timezone.utc),
            }],
        }
        mock_cognito.list_users.side_effect = [first_page, second_page]
        mock_cognito.admin_list_groups_for_user.return_value = {'Groups': []}

        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert len(body['users']) == 2
        assert mock_cognito.list_users.call_count == 2

    @patch('users_handler.cognito')
    def test_returns_error_on_list_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.list_users.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('users_handler.cognito')
    def test_handles_user_without_name_attribute(self, mock_cognito, api_gateway_event, lambda_context):
        """Cover attrs.get('name', '') when name attribute is missing."""
        mock_cognito.list_users.return_value = {
            'Users': [{
                'Username': 'noname',
                'Attributes': [{'Name': 'email', 'Value': 'noname@example.com'}],
                'UserStatus': 'CONFIRMED',
                'Enabled': True,
                'UserCreateDate': datetime(2025, 1, 1, tzinfo=timezone.utc),
                'UserLastModifiedDate': datetime(2025, 1, 2, tzinfo=timezone.utc),
            }],
        }
        mock_cognito.admin_list_groups_for_user.return_value = {'Groups': []}
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['users'][0]['name'] == ''


class TestCreateUserEdgeCases:
    """Cover create_user edge cases."""

    @patch('users_handler.uuid')
    @patch('users_handler.cognito')
    def test_creates_user_without_name(self, mock_cognito, mock_uuid, api_gateway_event, lambda_context):
        """Cover the branch where name is empty (no name attribute added)."""
        mock_uuid.uuid4.return_value = 'uuid-no-name'
        mock_cognito.admin_create_user.return_value = {'User': {'Username': 'uuid-no-name'}}
        mock_cognito.admin_add_user_to_group.return_value = {}
        from users_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/users', body={'email': 'noname@example.com', 'group': 'users'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['success'] is True
        # Verify name attribute was NOT included
        call_args = mock_cognito.admin_create_user.call_args
        user_attrs = call_args.kwargs['UserAttributes']
        attr_names = [a['Name'] for a in user_attrs]
        assert 'name' not in attr_names

    @patch('users_handler.uuid')
    @patch('users_handler.cognito')
    def test_returns_error_on_generic_create_failure(self, mock_cognito, mock_uuid, api_gateway_event, lambda_context):
        mock_uuid.uuid4.return_value = 'uuid-fail'
        mock_cognito.exceptions.UsernameExistsException = type('UsernameExistsException', (Exception,), {})
        mock_cognito.admin_create_user.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/users', body={'email': 'fail@example.com', 'group': 'users'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestUpdateUserGroupEdgeCases:
    """Cover update_user_group error paths."""

    @patch('users_handler.cognito')
    def test_rejects_invalid_group(self, mock_cognito, api_gateway_event, lambda_context):
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/u/group', path_params={'username': 'u'}, body={'group': 'invalid'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_returns_error_on_generic_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_list_groups_for_user.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/u/group', path_params={'username': 'u'}, body={'group': 'admins'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestResetPasswordEdgeCases:
    """Cover reset_password error paths."""

    @patch('users_handler.cognito')
    def test_handles_user_not_found(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_reset_user_password.side_effect = mock_cognito.exceptions.UserNotFoundException()
        from users_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/users/x/reset-password', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('users_handler.cognito')
    def test_returns_error_on_generic_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_reset_user_password.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/users/x/reset-password', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestEnableUserEdgeCases:
    """Cover enable_user error paths."""

    @patch('users_handler.cognito')
    def test_handles_user_not_found(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_enable_user.side_effect = mock_cognito.exceptions.UserNotFoundException()
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/x/enable', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('users_handler.cognito')
    def test_returns_error_on_generic_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_enable_user.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/x/enable', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestDisableUserEdgeCases:
    """Cover disable_user error paths."""

    @patch('users_handler.cognito')
    def test_handles_user_not_found(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_disable_user.side_effect = mock_cognito.exceptions.UserNotFoundException()
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/x/disable', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('users_handler.cognito')
    def test_returns_error_on_generic_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_disable_user.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/users/x/disable', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestDeleteUserEdgeCases:
    """Cover delete_user generic error path."""

    @patch('users_handler.cognito')
    def test_returns_error_on_generic_failure(self, mock_cognito, api_gateway_event, lambda_context):
        mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
        mock_cognito.admin_delete_user.side_effect = Exception('Service error')
        from users_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/users/x', path_params={'username': 'x'})
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
