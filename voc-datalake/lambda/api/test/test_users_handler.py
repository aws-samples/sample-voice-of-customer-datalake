"""
Tests for users_handler.py - /users/* endpoints.
Cognito user management for admins.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestGetCallerGroups:
    """Tests for get_caller_groups helper function."""

    def test_extracts_groups_from_claims(self):
        """Extracts user groups from Cognito authorizer claims."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from users_handler import get_caller_groups
        
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {'cognito:groups': 'admins viewers'}
                }
            }
        }
        
        groups = get_caller_groups(event)
        assert 'admins' in groups
        assert 'viewers' in groups

    def test_handles_comma_separated_groups(self):
        """Handles comma-separated groups format."""
        from users_handler import get_caller_groups
        
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {'cognito:groups': 'admins, viewers'}
                }
            }
        }
        
        groups = get_caller_groups(event)
        assert 'admins' in groups

    def test_returns_empty_list_when_no_groups(self):
        """Returns empty list when no groups in claims."""
        from users_handler import get_caller_groups
        
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {}
                }
            }
        }
        
        groups = get_caller_groups(event)
        assert groups == []

    def test_handles_single_group(self):
        """Handles single group string."""
        from users_handler import get_caller_groups
        
        event = {
            'requestContext': {
                'authorizer': {
                    'claims': {'cognito:groups': 'admins'}
                }
            }
        }
        
        groups = get_caller_groups(event)
        assert groups == ['admins']


class TestListUsers:
    """Tests for GET /users endpoint."""

    @patch('users_handler.cognito')
    def test_returns_user_list_for_admins(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns list of users for admin callers."""
        # Arrange
        mock_cognito.list_users.return_value = {
            'Users': [{
                'Username': 'testuser',
                'Attributes': [
                    {'Name': 'email', 'Value': 'test@example.com'},
                    {'Name': 'name', 'Value': 'Test User'}
                ],
                'UserStatus': 'CONFIRMED',
                'Enabled': True,
                'UserCreateDate': datetime(2025, 1, 1, tzinfo=timezone.utc),
                'UserLastModifiedDate': datetime(2025, 1, 2, tzinfo=timezone.utc)
            }]
        }
        mock_cognito.admin_list_groups_for_user.return_value = {
            'Groups': [{'GroupName': 'viewers'}]
        }
        
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        # Add admin group to claims
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert len(body['users']) == 1
        assert body['users'][0]['username'] == 'testuser'
        assert body['users'][0]['email'] == 'test@example.com'

    @patch('users_handler.cognito')
    def test_returns_unauthorized_for_non_admins(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 401 for non-admin callers."""
        # Arrange
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'viewers'
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert
        assert response['statusCode'] == 401


class TestCreateUser:
    """Tests for POST /users endpoint."""

    @patch('users_handler.uuid')
    @patch('users_handler.cognito')
    def test_creates_user_successfully(
        self, mock_cognito, mock_uuid, api_gateway_event, lambda_context
    ):
        """Creates new user in Cognito with UUID username."""
        # Arrange
        mock_uuid.uuid4.return_value = 'test-uuid-1234'
        mock_cognito.admin_create_user.return_value = {
            'User': {'Username': 'test-uuid-1234'}
        }
        mock_cognito.admin_add_user_to_group.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/users',
            body={
                'email': 'newuser@example.com',
                'name': 'New User',
                'group': 'viewers'
            }
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'newuser@example.com' in body['message']
        # Verify UUID was used as username, not email
        mock_cognito.admin_create_user.assert_called_once()
        call_args = mock_cognito.admin_create_user.call_args
        assert call_args.kwargs['Username'] == 'test-uuid-1234'
        mock_cognito.admin_add_user_to_group.assert_called_once()

    @patch('users_handler.cognito')
    def test_returns_error_when_email_missing(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 400 when email not provided."""
        # Arrange
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/users',
            body={'name': 'No Email User'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert
        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_returns_error_for_invalid_group(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 400 for invalid group name."""
        # Arrange
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/users',
            body={'email': 'test@example.com', 'group': 'superadmins'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert
        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_handles_duplicate_user(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns error when user already exists."""
        # Arrange
        mock_cognito.exceptions.UsernameExistsException = type(
            'UsernameExistsException', (Exception,), {}
        )
        mock_cognito.admin_create_user.side_effect = mock_cognito.exceptions.UsernameExistsException()
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/users',
            body={'email': 'existing@example.com', 'group': 'viewers'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'already exists' in body['message']


class TestUpdateUserGroup:
    """Tests for PUT /users/<username>/group endpoint."""

    @patch('users_handler.cognito')
    def test_updates_user_group_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Updates user group from viewers to admins."""
        # Arrange
        mock_cognito.admin_list_groups_for_user.return_value = {
            'Groups': [{'GroupName': 'viewers'}]
        }
        mock_cognito.admin_remove_user_from_group.return_value = {}
        mock_cognito.admin_add_user_to_group.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser/group',
            path_params={'username': 'testuser'},
            body={'group': 'admins'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['group'] == 'admins'
        mock_cognito.admin_remove_user_from_group.assert_called_once()
        mock_cognito.admin_add_user_to_group.assert_called_once()

    @patch('users_handler.cognito')
    def test_handles_user_not_found(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns error when user not found."""
        # Arrange
        mock_cognito.exceptions.UserNotFoundException = type(
            'UserNotFoundException', (Exception,), {}
        )
        mock_cognito.admin_list_groups_for_user.side_effect = mock_cognito.exceptions.UserNotFoundException()
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/nonexistent/group',
            path_params={'username': 'nonexistent'},
            body={'group': 'admins'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'not found' in body['message'].lower()


class TestResetUserPassword:
    """Tests for POST /users/<username>/reset-password endpoint."""

    @patch('users_handler.cognito')
    def test_resets_password_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Resets user password and sends email."""
        # Arrange
        mock_cognito.admin_reset_user_password.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/users/testuser/reset-password',
            path_params={'username': 'testuser'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_cognito.admin_reset_user_password.assert_called_once()


class TestEnableUser:
    """Tests for PUT /users/<username>/enable endpoint."""

    @patch('users_handler.cognito')
    def test_enables_user_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Enables disabled user."""
        # Arrange
        mock_cognito.admin_enable_user.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser/enable',
            path_params={'username': 'testuser'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_cognito.admin_enable_user.assert_called_once()


class TestDisableUser:
    """Tests for PUT /users/<username>/disable endpoint."""

    @patch('users_handler.cognito')
    def test_disables_user_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Disables user to prevent login."""
        # Arrange
        mock_cognito.admin_disable_user.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser/disable',
            path_params={'username': 'testuser'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_cognito.admin_disable_user.assert_called_once()


class TestDeleteUser:
    """Tests for DELETE /users/<username> endpoint."""

    @patch('users_handler.cognito')
    def test_deletes_user_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Deletes user from Cognito."""
        # Arrange
        mock_cognito.admin_delete_user.return_value = {}
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/users/testuser',
            path_params={'username': 'testuser'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_cognito.admin_delete_user.assert_called_once()

    @patch('users_handler.cognito')
    def test_handles_delete_nonexistent_user(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns error when deleting nonexistent user."""
        # Arrange
        mock_cognito.exceptions.UserNotFoundException = type(
            'UserNotFoundException', (Exception,), {}
        )
        mock_cognito.admin_delete_user.side_effect = mock_cognito.exceptions.UserNotFoundException()
        
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/users/nonexistent',
            path_params={'username': 'nonexistent'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'not found' in body['message'].lower()
