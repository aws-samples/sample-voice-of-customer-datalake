"""The API refuses an administrator's change to their own account and the loss of the last administrator
(tenet 4; shared/user_admin_guard.py). The SPA and the assistant check the same as UX only."""
import json
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route

import users_handler
from shared import user_admin_guard
from shared.exceptions import ConflictError

CALLER = {'sub': 'sub-root', 'cognito:groups': 'admins'}
SUBS = {'root': 'sub-root', 'alice': 'sub-alice', 'bob': 'sub-bob'}


def _cognito(admins: list[dict]) -> MagicMock:
    cognito = MagicMock()
    cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    cognito.admin_get_user.side_effect = lambda Username, **_kw: {
        'UserAttributes': [{'Name': 'sub', 'Value': SUBS[Username]}]}
    cognito.admin_list_groups_for_user.return_value = {'Groups': [{'GroupName': 'admins'}]}
    cognito.list_users_in_group.return_value = {'Users': admins}
    return cognito


def _call(api_gateway_event, lambda_context, cognito, method, path, body=None):
    with patch.object(users_handler, 'cognito', cognito):
        response, answer = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context,
                                      method=method, path=path, body=body, claims=CALLER)
    return response['statusCode'], answer


TWO_ADMINS = [{'Username': 'root', 'Enabled': True}, {'Username': 'alice', 'Enabled': True}]


@pytest.mark.parametrize(('method', 'path', 'body', 'write'), [
    ('PUT', '/users/root/group', {'group': 'users'}, 'admin_add_user_to_group'),
    ('PUT', '/users/root/disable', None, 'admin_disable_user'),
    ('DELETE', '/users/root', None, 'admin_delete_user'),
])
def test_the_callers_own_account_is_refused(api_gateway_event, lambda_context, method, path, body, write):
    cognito = _cognito(TWO_ADMINS)
    status, answer = _call(api_gateway_event, lambda_context, cognito, method, path, body)
    assert status == 409
    assert 'your own account' in answer['error']
    getattr(cognito, write).assert_not_called()


@pytest.mark.parametrize(('method', 'path', 'body'), [
    ('PUT', '/users/alice/group', {'group': 'users'}),
    ('PUT', '/users/alice/disable', None),
    ('DELETE', '/users/alice', None),
])
def test_the_last_enabled_admin_is_refused(api_gateway_event, lambda_context, method, path, body):
    # alice is the only ENABLED administrator (the caller's row is listed disabled).
    cognito = _cognito([{'Username': 'root', 'Enabled': False}, {'Username': 'alice', 'Enabled': True}])
    status, answer = _call(api_gateway_event, lambda_context, cognito, method, path, body)
    assert (status, answer['error']) == (409, user_admin_guard.LAST_ADMIN_MESSAGE)


def test_another_admin_can_be_demoted(api_gateway_event, lambda_context):
    cognito = _cognito(TWO_ADMINS)
    status, _ = _call(api_gateway_event, lambda_context, cognito, 'PUT', '/users/alice/group', {'group': 'users'})
    assert status == 200
    cognito.admin_add_user_to_group.assert_called_once()


def test_promoting_oneself_is_not_a_change_to_refuse(api_gateway_event, lambda_context):
    cognito = _cognito(TWO_ADMINS)
    status, _ = _call(api_gateway_event, lambda_context, cognito, 'PUT', '/users/root/group', {'group': 'admins'})
    assert status == 200


def test_enabling_oneself_is_not_refused(api_gateway_event, lambda_context):
    status, answer = _call(api_gateway_event, lambda_context, _cognito(TWO_ADMINS), 'PUT', '/users/root/enable')
    assert status == 200, json.dumps(answer)


class TestGuard:
    def test_a_user_outside_the_group_is_never_the_last_admin(self):
        user_admin_guard.refuse_last_admin('bob', [{'Username': 'alice'}])

    def test_the_only_member_is_the_last_admin(self):
        with pytest.raises(ConflictError, match='last enabled administrator'):
            user_admin_guard.refuse_last_admin('alice', [{'Username': 'alice'}])

    def test_no_caller_subject_never_matches(self):
        user_admin_guard.refuse_own_account('', '', user_admin_guard.ACTION_DELETE)
