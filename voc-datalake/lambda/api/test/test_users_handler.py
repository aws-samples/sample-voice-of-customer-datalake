"""
Tests for users_handler.py - /users/* endpoints.
Cognito user management for admins.
"""
import json
import pytest
from unittest.mock import patch
from datetime import datetime, timezone

from botocore.exceptions import ClientError


# NOTE: group-parsing/require_admin unit tests live in
# lambda/shared/test/test_api.py — users_handler now gates through the
# shared implementation instead of a local copy.


# A string no legitimate response body has reason to contain, planted in the text
# of the Cognito fault the handler catches. Whether it comes back out is the whole
# question in TestErrorDisclosure below: `shared/api.py` returns a ServiceError's
# `.message` verbatim, and every route here used to raise `ServiceError(str(e))`
# (issue #263).
_SENTINEL = 'SENTINEL_INTERNAL_DETAIL'

# The user pool this handler is configured with (conftest sets USER_POOL_ID).
# A botocore ClientError from an admin_* call names it, so it is the concrete thing
# `str(e)` published.
_INTERNAL_POOL_ID = 'us-east-1_testpool'


def _cognito_failure(operation: str = 'AdminGetUser') -> ClientError:
    """A Cognito client error whose message carries internal detail.

    Shaped like the real thing: botocore's ``str()`` renders the error code, the
    service message and the operation name, so interpolating it leaks all three
    plus the pool id the service echoes back.
    """
    return ClientError(
        {'Error': {
            'Code': 'InternalErrorException',
            'Message': f'{_SENTINEL} for user pool {_INTERNAL_POOL_ID}',
        }},
        operation,
    )


# Every route in this handler, as (route description, event kwargs). Exercised as
# a set rather than through one representative case: the leak was per-route, so one
# fixed route proves nothing about the next.
_DISCLOSURE_ROUTES = [
    ('GET /users', {'method': 'GET', 'path': '/users'}),
    ('POST /users', {
        'method': 'POST', 'path': '/users',
        'body': {'email': 'a@example.com', 'group': 'users'}}),
    ('PUT /users/<username>', {
        'method': 'PUT', 'path': '/users/testuser',
        'path_params': {'username': 'testuser'},
        'body': {'given_name': 'New'}}),
    ('PUT /users/<username>/group', {
        'method': 'PUT', 'path': '/users/testuser/group',
        'path_params': {'username': 'testuser'}, 'body': {'group': 'admins'}}),
    ('POST /users/<username>/reset-password', {
        'method': 'POST', 'path': '/users/testuser/reset-password',
        'path_params': {'username': 'testuser'}}),
    ('PUT /users/<username>/enable', {
        'method': 'PUT', 'path': '/users/testuser/enable',
        'path_params': {'username': 'testuser'}}),
    ('PUT /users/<username>/disable', {
        'method': 'PUT', 'path': '/users/testuser/disable',
        'path_params': {'username': 'testuser'}}),
    ('DELETE /users/<username>', {
        'method': 'DELETE', 'path': '/users/testuser',
        'path_params': {'username': 'testuser'}}),
]


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
        """Returns 403 for non-admin callers."""
        # Arrange
        from users_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/users')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'viewers'
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert - now returns 403 Forbidden (AuthorizationError)
        assert response['statusCode'] == 403


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
                'group': 'users'  # Valid group: 'admins' or 'users'
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
            body={'email': 'existing@example.com', 'group': 'users'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 409 Conflict with error key
        assert response['statusCode'] == 409
        assert 'error' in body
        assert 'already exists' in body['error']


class TestUpdateUser:
    """Tests for PUT /users/<username> endpoint."""

    @patch('users_handler.cognito')
    def test_updates_user_attributes_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Updates given_name and family_name in Cognito."""
        mock_cognito.admin_get_user.return_value = {
            'UserAttributes': [
                {'Name': 'given_name', 'Value': 'Old'},
                {'Name': 'family_name', 'Value': 'Name'},
            ]
        }
        mock_cognito.admin_update_user_attributes.return_value = {}

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': 'New', 'family_name': 'Name'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['given_name'] == 'New'
        assert body['family_name'] == 'Name'
        assert body['name'] == 'New Name'
        mock_cognito.admin_update_user_attributes.assert_called_once()

    @patch('users_handler.cognito')
    def test_partial_update_given_name_only(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Updates only given_name, merges with existing family_name."""
        mock_cognito.admin_get_user.return_value = {
            'UserAttributes': [
                {'Name': 'given_name', 'Value': 'Old'},
                {'Name': 'family_name', 'Value': 'Smith'},
            ]
        }
        mock_cognito.admin_update_user_attributes.return_value = {}

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': 'New'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['given_name'] == 'New'
        assert body['family_name'] == 'Smith'
        assert body['name'] == 'New Smith'

    @patch('users_handler.cognito')
    def test_partial_update_family_name_only(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Updates only family_name, merges with existing given_name."""
        mock_cognito.admin_get_user.return_value = {
            'UserAttributes': [
                {'Name': 'given_name', 'Value': 'Jane'},
                {'Name': 'family_name', 'Value': 'Old'},
            ]
        }
        mock_cognito.admin_update_user_attributes.return_value = {}

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'family_name': 'Doe'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['given_name'] == 'Jane'
        assert body['family_name'] == 'Doe'
        assert body['name'] == 'Jane Doe'

    @patch('users_handler.cognito')
    def test_rejects_non_string_given_name(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 400 when given_name is not a string."""
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': 123}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_returns_error_when_both_names_missing(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 400 when neither given_name nor family_name in body."""
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'some_other_field': 'value'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_rejects_whitespace_only_names(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 400 when names are whitespace-only and no existing names."""
        mock_cognito.exceptions.UserNotFoundException = type(
            'UserNotFoundException', (Exception,), {}
        )
        mock_cognito.admin_get_user.return_value = {
            'UserAttributes': []
        }

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': '   ', 'family_name': '  '}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('users_handler.cognito')
    def test_returns_not_found_for_nonexistent_user(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 404 when user does not exist."""
        mock_cognito.exceptions.UserNotFoundException = type(
            'UserNotFoundException', (Exception,), {}
        )
        mock_cognito.admin_get_user.side_effect = (
            mock_cognito.exceptions.UserNotFoundException()
        )

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/ghost',
            path_params={'username': 'ghost'},
            body={'given_name': 'Ghost'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 404
        assert 'not found' in body['error'].lower()

    @patch('users_handler.cognito')
    def test_returns_unauthorized_for_non_admins(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Returns 403 for non-admin callers."""
        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': 'New'}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'viewers'

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403


class TestUpdateUserGroup:
    """Tests for PUT /users/<username>/group endpoint."""

    @patch('users_handler.cognito')
    def test_updates_user_group_successfully(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """Updates user group from users to admins."""
        # Arrange - use 'users' as current group since handler only removes 'admins' or 'users'
        mock_cognito.admin_list_groups_for_user.return_value = {
            'Groups': [{'GroupName': 'users'}]
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
        
        # Assert - now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()


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

        # Assert - now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()


class TestErrorDisclosure:
    """Regression (#263): a client-facing error body must carry no Cognito detail.

    `shared/api.py` renders `ServiceError.message` straight into the response, and
    all eight routes here raised `ServiceError(str(e))` — so a botocore
    ClientError published the user pool id, the error code and the admin operation
    name to anyone who could provoke a 500.
    """

    @pytest.mark.parametrize(
        'event_kwargs',
        [pytest.param(kwargs, id=name) for name, kwargs in _DISCLOSURE_ROUTES]
    )
    def test_returns_generic_500_without_cognito_detail(
        self, event_kwargs, api_gateway_event, lambda_context
    ):
        """Returns a 500 whose body names no pool, error code or operation."""
        # Arrange — fail whichever admin call the route makes.
        with patch('users_handler.cognito') as mock_cognito, \
             patch('users_handler.logger') as mock_logger:
            # Real exception classes, so the typed `except cognito.exceptions.*`
            # clauses are catchable and do not match the injected fault.
            mock_cognito.exceptions.UserNotFoundException = type(
                'UserNotFoundException', (Exception,), {}
            )
            mock_cognito.exceptions.UsernameExistsException = type(
                'UsernameExistsException', (Exception,), {}
            )
            for method in ('list_users', 'admin_list_groups_for_user',
                           'admin_create_user', 'admin_get_user',
                           'admin_update_user_attributes',
                           'admin_add_user_to_group', 'admin_remove_user_from_group',
                           'admin_reset_user_password', 'admin_enable_user',
                           'admin_disable_user', 'admin_delete_user'):
                getattr(mock_cognito, method).side_effect = _cognito_failure()

            from users_handler import lambda_handler
            event = api_gateway_event(**event_kwargs)
            event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

            # Act
            response = lambda_handler(event, lambda_context)
            raw_body = response['body']

            # Assert
            assert response['statusCode'] == 500
            for leak in (_SENTINEL, _INTERNAL_POOL_ID, 'InternalErrorException',
                         'AdminGetUser'):
                assert leak not in raw_body, (
                    f'{leak!r} must not reach the client; body was: {raw_body}'
                )
            # Still useful to a human, so "no detail" was not achieved by
            # returning an empty message.
            assert json.loads(raw_body)['error'].startswith('Failed to ')

            # Positive control: without this, "absent from the body" would also
            # hold for a fault that was swallowed and never recorded.
            logged = ' '.join(str(c.args) for c in mock_logger.exception.call_args_list)
            assert _SENTINEL in logged, (
                f'the fault must be logged for an operator; exception() calls: {logged}'
            )

    @patch('users_handler.cognito')
    def test_update_user_keeps_400_when_merged_names_are_empty(
        self, mock_cognito, api_gateway_event, lambda_context
    ):
        """PUT /users/<username> answers 400 for a ValidationError raised mid-block.

        The refusal ('...must be non-empty') is raised AFTER the admin_get_user
        call, i.e. inside the same `try` that answers AWS failures with a 500.
        Pins the boundary this slice relies on: widening that catch to
        `except Exception` without an `except ApiError: raise` in front would turn
        this 400 into a 500, exactly the #263 defect. Duplicates
        TestUpdateUser::test_rejects_whitespace_only_names' scenario on purpose —
        that one only asserts the status, this one names the boundary and asserts
        no write happened.
        """
        # Arrange — no existing names to merge with, and blank names supplied.
        mock_cognito.exceptions.UserNotFoundException = type(
            'UserNotFoundException', (Exception,), {}
        )
        mock_cognito.admin_get_user.return_value = {'UserAttributes': []}

        from users_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/users/testuser',
            path_params={'username': 'testuser'},
            body={'given_name': ' ', 'family_name': ''}
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'admins'

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 400
        assert 'non-empty' in body['error']
        mock_cognito.admin_update_user_attributes.assert_not_called()
