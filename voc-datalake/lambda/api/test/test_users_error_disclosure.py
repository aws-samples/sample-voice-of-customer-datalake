"""Regression tests for issue #263 on users_handler.py (ported from PR #403).

Every route used to raise `ServiceError(str(e))`, and `shared/api.py` returns
that message verbatim — so a Cognito ClientError published the user pool id, the
error code and the admin API name. These pin a fixed message per route, that the
fault is still logged, and that typed 4xx errors keep their status.
"""
import json
import os
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import recording_logger

_SENTINEL = 'SECRET-arn:aws:cognito-idp:us-east-1:123456789012:userpool/internal'
# From the env conftest sets, not a literal: it feeds an ABSENCE assertion.
_INTERNAL_POOL_ID = os.environ['USER_POOL_ID']


def _cognito_failure() -> ClientError:
    return ClientError(
        {'Error': {'Code': 'InternalErrorException', 'Message': f'{_SENTINEL} for user pool {_INTERNAL_POOL_ID}'}},
        'AdminGetUser',
    )




def _typed_cognito_exceptions(mock_cognito: MagicMock) -> None:
    # Real classes so the `except cognito.exceptions.*` clauses are valid and do
    # not match the injected ClientError.
    mock_cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    mock_cognito.exceptions.UsernameExistsException = type('UsernameExistsException', (Exception,), {})


_COGNITO_CALLS = (
    'list_users', 'admin_list_groups_for_user', 'admin_create_user', 'admin_get_user',
    'admin_update_user_attributes', 'admin_add_user_to_group', 'admin_remove_user_from_group',
    'admin_reset_user_password', 'admin_enable_user', 'admin_disable_user', 'admin_delete_user',
)

_ROUTES = [
    pytest.param({'method': 'GET', 'path': '/users'}, 'Failed to list users', id='GET /users'),
    pytest.param({'method': 'POST', 'path': '/users', 'body': {'email': 'a@example.com', 'group': 'users'}},
                 'Failed to create user', id='POST /users'),
    pytest.param({'method': 'PUT', 'path': '/users/testuser', 'path_params': {'username': 'testuser'},
                  'body': {'given_name': 'New'}}, 'Failed to update user', id='PUT /users/x'),
    pytest.param({'method': 'PUT', 'path': '/users/testuser/group', 'path_params': {'username': 'testuser'},
                  'body': {'group': 'admins'}}, 'Failed to update user group', id='PUT /users/x/group'),
    pytest.param({'method': 'POST', 'path': '/users/testuser/reset-password',
                  'path_params': {'username': 'testuser'}}, 'Failed to reset password', id='POST reset-password'),
    pytest.param({'method': 'PUT', 'path': '/users/testuser/enable', 'path_params': {'username': 'testuser'}},
                 'Failed to enable user', id='PUT enable'),
    pytest.param({'method': 'PUT', 'path': '/users/testuser/disable', 'path_params': {'username': 'testuser'}},
                 'Failed to disable user', id='PUT disable'),
    pytest.param({'method': 'DELETE', 'path': '/users/testuser', 'path_params': {'username': 'testuser'}},
                 'Failed to delete user', id='DELETE /users/x'),
]


class TestNoCognitoDetailInResponses:

    @pytest.mark.parametrize(('event_kwargs', 'message'), _ROUTES)
    def test_returns_fixed_500_message_and_logs_the_fault(
        self, event_kwargs, message, api_gateway_event, lambda_context
    ):
        mock_logger = recording_logger()
        with patch('users_handler.cognito') as mock_cognito, patch('users_handler.logger', mock_logger):
            _typed_cognito_exceptions(mock_cognito)
            for method in _COGNITO_CALLS:
                getattr(mock_cognito, method).side_effect = _cognito_failure()
            from users_handler import lambda_handler
            response = lambda_handler(api_gateway_event(**event_kwargs), lambda_context)

        assert response['statusCode'] == 500
        for leak in (_SENTINEL, _INTERNAL_POOL_ID, 'InternalErrorException', 'AdminGetUser'):
            assert leak not in response['body'], f'{leak!r} leaked: {response["body"]}'
        assert json.loads(response['body'])['error'] == message
        assert _SENTINEL in ' '.join(mock_logger.emitted_exceptions)

    @patch('users_handler.cognito')
    def test_update_user_non_boto_fault_is_a_controlled_500(self, mock_cognito, api_gateway_event, lambda_context):
        """Was `except (ClientError, BotoCoreError)`: a TypeError escaped lambda_handler."""
        _typed_cognito_exceptions(mock_cognito)
        mock_cognito.admin_get_user.return_value = {'UserAttributes': 'not-a-list'}
        from users_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='PUT', path='/users/testuser', path_params={'username': 'testuser'},
            body={'given_name': 'New'}), lambda_context)

        assert response['statusCode'] == 500
        assert json.loads(response['body'])['error'] == 'Failed to update user'
        mock_cognito.admin_update_user_attributes.assert_not_called()


class TestTypedErrorsKeepTheirStatus:

    @patch('users_handler.cognito')
    def test_update_user_validation_after_aws_call_stays_400(self, mock_cognito, api_gateway_event, lambda_context):
        """'...must be non-empty' is raised inside the try, after admin_get_user."""
        _typed_cognito_exceptions(mock_cognito)
        mock_cognito.admin_get_user.return_value = {'UserAttributes': []}
        from users_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='PUT', path='/users/testuser', path_params={'username': 'testuser'},
            body={'given_name': ' ', 'family_name': ''}), lambda_context)

        assert response['statusCode'] == 400
        assert 'non-empty' in json.loads(response['body'])['error']
        mock_cognito.admin_update_user_attributes.assert_not_called()

    @patch('users_handler.cognito')
    def test_existing_email_is_a_409_with_a_fixed_message(self, mock_cognito, api_gateway_event, lambda_context):
        _typed_cognito_exceptions(mock_cognito)
        mock_cognito.admin_create_user.side_effect = mock_cognito.exceptions.UsernameExistsException(_SENTINEL)
        from users_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='POST', path='/users', body={'email': 'a@example.com'}), lambda_context)

        assert response['statusCode'] == 409
        assert json.loads(response['body'])['error'] == 'A user with this email already exists'
        assert _SENTINEL not in response['body']

    @pytest.mark.parametrize('event_kwargs', [p.values[0] for p in _ROUTES[2:]],
                             ids=[p.id for p in _ROUTES[2:]])
    @patch('users_handler.cognito')
    def test_unknown_user_is_a_404(self, mock_cognito, event_kwargs, api_gateway_event, lambda_context):
        _typed_cognito_exceptions(mock_cognito)
        missing = mock_cognito.exceptions.UserNotFoundException(_SENTINEL)
        for method in _COGNITO_CALLS:
            getattr(mock_cognito, method).side_effect = missing
        from users_handler import lambda_handler
        response = lambda_handler(api_gateway_event(**event_kwargs), lambda_context)

        assert response['statusCode'] == 404
        assert _SENTINEL not in response['body']
