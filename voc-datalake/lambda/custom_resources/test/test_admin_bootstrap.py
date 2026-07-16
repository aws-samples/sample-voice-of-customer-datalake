"""
Tests for the idempotent admin bootstrap custom resource (issue #196).

The load-bearing behavior: the initial password is generated AT RUNTIME and
only when the handler actually creates the admin. If the admin exists — or
the event is an Update/Delete — nothing in Cognito is touched and no new
password is minted, so redeployments can never reset a live admin or print
a password that was never applied.
"""
from unittest.mock import MagicMock

import pytest

import admin_bootstrap


class UserNotFound(Exception):
    pass


@pytest.fixture
def cognito(monkeypatch):
    """Mocked cognito client injected into the module."""
    client = MagicMock()
    client.exceptions.UserNotFoundException = UserNotFound
    monkeypatch.setattr(admin_bootstrap, 'cognito', client)
    return client


def make_event(request_type='Create', physical_id=None):
    event = {
        'RequestType': request_type,
        'ResourceProperties': {
            'UserPoolId': 'us-east-1_TEST',
            'Username': 'admin',
            'Email': 'admin@local.host',
            'GroupName': 'admins',
        },
    }
    if physical_id is not None:
        event['PhysicalResourceId'] = physical_id
    return event


class TestCreateWhenAdminMissing:
    def test_creates_user_sets_temp_password_and_group(self, cognito):
        cognito.admin_get_user.side_effect = UserNotFound()

        result = admin_bootstrap.handler(make_event(), None)

        create_kwargs = cognito.admin_create_user.call_args.kwargs
        assert create_kwargs['UserPoolId'] == 'us-east-1_TEST'
        assert create_kwargs['Username'] == 'admin'
        assert create_kwargs['MessageAction'] == 'SUPPRESS'
        assert {'Name': 'email_verified', 'Value': 'true'} in create_kwargs['UserAttributes']

        password_kwargs = cognito.admin_set_user_password.call_args.kwargs
        assert password_kwargs['Password'] == result['Data']['Password']
        # Temporary on purpose: first login forces a change.
        assert 'Permanent' not in password_kwargs

        group_kwargs = cognito.admin_add_user_to_group.call_args.kwargs
        assert group_kwargs['GroupName'] == 'admins'

        assert result['Data']['AdminCreated'] == 'true'
        assert result['PhysicalResourceId'] == 'admin-bootstrap-us-east-1_TEST'

    def test_returned_password_is_real_and_policy_compliant(self, cognito):
        cognito.admin_get_user.side_effect = UserNotFound()

        password = admin_bootstrap.handler(make_event(), None)['Data']['Password']

        assert len(password) == admin_bootstrap.PASSWORD_LENGTH
        assert any(c in admin_bootstrap.UPPER for c in password)
        assert any(c in admin_bootstrap.LOWER for c in password)
        assert any(c in admin_bootstrap.DIGITS for c in password)
        assert any(c in admin_bootstrap.SPECIAL for c in password)


class TestCreateWhenAdminExists:
    def test_touches_nothing_and_returns_placeholder(self, cognito):
        cognito.admin_get_user.return_value = {'Username': 'admin'}

        result = admin_bootstrap.handler(make_event(), None)

        cognito.admin_create_user.assert_not_called()
        cognito.admin_set_user_password.assert_not_called()
        cognito.admin_add_user_to_group.assert_not_called()
        assert result['Data']['Password'] == admin_bootstrap.UNCHANGED
        assert result['Data']['AdminCreated'] == 'false'


class TestUpdateAndDelete:
    @pytest.mark.parametrize('request_type', ['Update', 'Delete'])
    def test_never_calls_cognito(self, cognito, request_type):
        result = admin_bootstrap.handler(
            make_event(request_type, physical_id='admin-bootstrap-us-east-1_TEST'), None
        )

        # Not even the existence check: redeploys are a strict no-op.
        cognito.admin_get_user.assert_not_called()
        cognito.admin_create_user.assert_not_called()
        cognito.admin_set_user_password.assert_not_called()
        cognito.admin_add_user_to_group.assert_not_called()
        assert result['Data']['Password'] == admin_bootstrap.UNCHANGED
        # Keeps the existing physical id so CloudFormation never replaces it.
        assert result['PhysicalResourceId'] == 'admin-bootstrap-us-east-1_TEST'


def test_password_generation_uses_no_ambiguous_characters():
    for _ in range(50):
        assert not set(admin_bootstrap.generate_password()) & set('0OlI')
