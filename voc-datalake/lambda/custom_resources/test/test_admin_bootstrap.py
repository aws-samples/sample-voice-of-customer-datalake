"""
Tests for the idempotent admin bootstrap custom resource (issue #196).

The load-bearing behavior: the initial password is generated AT RUNTIME and
only when the handler actually creates (or finishes creating) the admin. A
healthy admin — or an Update/Delete event — must never be touched, so
redeployments can never reset a live admin or print a password that was
never applied.
"""
import os
from unittest.mock import MagicMock

import pytest

import admin_bootstrap

HANDLER_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'admin_bootstrap.py'
)


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


def assert_untouched(cognito, result):
    cognito.admin_create_user.assert_not_called()
    cognito.admin_set_user_password.assert_not_called()
    cognito.admin_add_user_to_group.assert_not_called()
    assert result['Data']['Password'] == admin_bootstrap.UNCHANGED
    assert result['Data']['Bootstrap'] == 'skipped'


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

        assert result['Data']['Bootstrap'] == 'created'
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
    def test_healthy_admin_who_logged_in_is_untouched(self, cognito):
        cognito.admin_get_user.return_value = {'UserStatus': 'CONFIRMED'}

        result = admin_bootstrap.handler(make_event(), None)

        assert_untouched(cognito, result)
        # A confirmed admin is healthy regardless of groups — no group lookup.
        cognito.admin_list_groups_for_user.assert_not_called()

    def test_admin_with_group_membership_is_untouched(self, cognito):
        # Never logged in yet, but fully bootstrapped (group add succeeded).
        cognito.admin_get_user.return_value = {'UserStatus': 'FORCE_CHANGE_PASSWORD'}
        cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'admins'}]}

        assert_untouched(cognito, admin_bootstrap.handler(make_event(), None))

    def test_half_bootstrapped_admin_is_repaired(self, cognito):
        # A previous create failed after admin_create_user: the user exists,
        # never logged in, and belongs to no group. The old code skipped
        # forever, leaving an admin with an unknown password.
        cognito.admin_get_user.return_value = {'UserStatus': 'FORCE_CHANGE_PASSWORD'}
        cognito.admin_list_groups_for_user.return_value = {'Groups': []}

        result = admin_bootstrap.handler(make_event(), None)

        cognito.admin_create_user.assert_not_called()
        password_kwargs = cognito.admin_set_user_password.call_args.kwargs
        assert password_kwargs['Password'] == result['Data']['Password']
        cognito.admin_add_user_to_group.assert_called_once()
        assert result['Data']['Bootstrap'] == 'repaired'


class TestUpdateAndDelete:
    @pytest.mark.parametrize('request_type', ['Update', 'Delete'])
    def test_never_calls_cognito(self, cognito, request_type):
        result = admin_bootstrap.handler(
            make_event(request_type, physical_id='admin-bootstrap-us-east-1_TEST'), None
        )

        # Not even the existence check: redeploys are a strict no-op.
        cognito.admin_get_user.assert_not_called()
        assert_untouched(cognito, result)
        # Keeps the existing physical id so CloudFormation never replaces it.
        assert result['PhysicalResourceId'] == 'admin-bootstrap-us-east-1_TEST'


def test_alphabet_has_no_ambiguous_characters():
    pool = admin_bootstrap.UPPER + admin_bootstrap.LOWER + admin_bootstrap.DIGITS
    assert not set(pool) & set('0OlI')


def test_handler_fits_the_cloudformation_inline_limit():
    # core-stack.ts ships this file via Code.fromInline; CloudFormation's
    # ZipFile property caps at 4096 bytes. Fail here, not at synth.
    assert os.path.getsize(HANDLER_PATH) <= 4096
