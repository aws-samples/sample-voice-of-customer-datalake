"""Platform-admin membership in the users API (docs/multi-workspace.md → Control plane; shared/user_admin_guard.py).

A member of ``platform-admins`` is managed by platform admins only: ``PUT /users/{username}/platform-admin`` grants
and revokes the group, a demotion revokes it too, and demoting, disabling, enabling, deleting or resetting the
password of a platform admin is refused (403) to a caller outside the group. No request leaves zero enabled platform
admins (409). Every grant and revoke writes an ``AUDIT#platform-admins`` row first. Against a moto aggregates table
and a Cognito double that keeps each user's groups and enabled state.
"""
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from users_table_fixtures import cognito_users, users_aggregates_table

import users_handler
from shared import user_admin_guard

PLATFORM = 'platform-admins'
PLATFORM_CALLER = {'sub': 'sub-root', 'cognito:username': 'root', 'cognito:groups': '[admins, platform-admins]'}
ADMIN_CALLER = {'sub': 'sub-root', 'cognito:username': 'root', 'cognito:groups': 'admins'}
USER_CALLER = {'sub': 'sub-uma', 'cognito:groups': 'users'}


@dataclass
class Pool:
    """Each user's groups (in order) and enabled state; the double reads and changes them.

    ``disabled``: what the group listing (``ListUsersInGroup``) reports, which the last-platform-admin guard counts.
    ``account_disabled``: what ``AdminGetUser`` answers, which the caller's live check reads. Kept apart so the guard
    can be tested on its own, as defence in depth, while the caller's own account stays enabled.
    """

    groups: dict[str, list[str]]
    disabled: set[str] = field(default_factory=set)
    account_disabled: set[str] = field(default_factory=set)

    def subs(self) -> dict[str, str]:
        return {name: f'sub-{name}' for name in self.groups}


def _double(pool: Pool) -> Any:
    cognito = cognito_users(pool.subs())

    def groups_of(Username: str, **_kw: Any) -> dict:
        if Username not in pool.groups:
            raise cognito.exceptions.UserNotFoundException
        return {'Groups': [{'GroupName': g} for g in pool.groups[Username]]}

    cognito.admin_list_groups_for_user.side_effect = groups_of

    def user_of(Username: str, **_kw: Any) -> dict:
        if Username not in pool.groups:
            raise cognito.exceptions.UserNotFoundException
        return {'Username': Username, 'Enabled': Username not in pool.account_disabled,
                'UserAttributes': [{'Name': 'sub', 'Value': f'sub-{Username}'}]}

    cognito.admin_get_user.side_effect = user_of
    cognito.list_users_in_group.side_effect = lambda GroupName, **_kw: {'Users': [
        {'Username': name, 'Enabled': name not in pool.disabled}
        for name, groups in pool.groups.items() if GroupName in groups]}
    cognito.admin_add_user_to_group.side_effect = lambda Username, GroupName, **_kw: pool.groups[Username].append(
        GroupName)
    cognito.admin_remove_user_from_group.side_effect = lambda Username, GroupName, **_kw: pool.groups[
        Username].remove(GroupName)
    group_names = list(dict.fromkeys(g for groups in pool.groups.values() for g in groups))
    cognito.list_groups.return_value = {'Groups': [{'GroupName': g} for g in group_names]}
    cognito.list_users.return_value = {'Users': [
        {'Username': name, 'Attributes': [{'Name': 'sub', 'Value': sub}], 'UserStatus': 'CONFIRMED',
         'Enabled': name not in pool.disabled} for name, sub in pool.subs().items()]}
    return cognito


def _pool() -> Pool:
    """root (the caller) and pia are platform admins; ada is an administrator; uma a user."""
    return Pool({'root': ['admins', PLATFORM], 'pia': ['admins', PLATFORM], 'ada': ['admins'], 'uma': ['users']})


@pytest.fixture
def table():
    with users_aggregates_table() as created:
        yield created


def _call(api_gateway_event, lambda_context, pool: Pool, method: str, path: str, body: Any = None,
          claims: dict = PLATFORM_CALLER) -> tuple[int, Any, Any]:
    cognito = _double(pool)
    with patch.object(users_handler, 'cognito', cognito):
        response, decoded = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context,
                                       method=method, path=path, body=body, claims=claims)
    return response['statusCode'], decoded, cognito


def _assert_pia_untouched(cognito: Any, pool: Pool, write: str) -> None:
    """The Cognito ``write`` never ran, and pia is still an administrator and a platform admin."""
    getattr(cognito, write).assert_not_called()
    assert pool.groups['pia'] == ['admins', PLATFORM]


def _audit(table) -> list[tuple[str, str, str, str]]:
    rows = table.query(KeyConditionExpression='pk = :pk',
                       ExpressionAttributeValues={':pk': users_handler.PLATFORM_ADMIN_AUDIT_PK})['Items']
    return [(row['kind'], row['via'], row['target'], row['actor']) for row in rows]


GUARDED = [
    pytest.param('PUT', '/users/pia/group', {'group': 'users'}, 'admin_add_user_to_group',
                 user_admin_guard.ACTION_ROLE, id='demote'),
    pytest.param('PUT', '/users/pia/disable', None, 'admin_disable_user', user_admin_guard.ACTION_DISABLE, id='disable'),
    pytest.param('PUT', '/users/pia/enable', None, 'admin_enable_user', user_admin_guard.ACTION_ENABLE, id='enable'),
    pytest.param('DELETE', '/users/pia', None, 'admin_delete_user', user_admin_guard.ACTION_DELETE, id='delete'),
    pytest.param('POST', '/users/pia/reset-password', None, 'admin_reset_user_password',
                 user_admin_guard.ACTION_RESET_CREDENTIAL, id='reset-password'),
]


# ── The users API on a platform admin ────────────────────────────────────────

@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body', 'write', 'action'), GUARDED)
def test_a_plain_administrator_may_not_act_on_a_platform_admin(
        api_gateway_event, lambda_context, method, path, body, write, action):
    pool = _pool()
    status, answer, cognito = _call(api_gateway_event, lambda_context, pool, method, path, body, claims=ADMIN_CALLER)
    assert (status, answer['error']) == (403, f'Only a platform admin can {action} a platform admin.')
    _assert_pia_untouched(cognito, pool, write)


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body', 'write', 'action'), GUARDED)
def test_a_platform_admin_may_act_on_another(api_gateway_event, lambda_context, method, path, body, write, action):
    status, answer, cognito = _call(api_gateway_event, lambda_context, _pool(), method, path, body)
    assert (status, answer['success']) == (200, True), action
    getattr(cognito, write).assert_called_once()


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body', 'write'), [
    ('PUT', '/users/ada/disable', None, 'admin_disable_user'),
    ('POST', '/users/uma/reset-password', None, 'admin_reset_user_password'),
], ids=['admin', 'user'])
def test_a_plain_administrator_still_manages_everyone_else(api_gateway_event, lambda_context, method, path, body,
                                                           write):
    status, _, cognito = _call(api_gateway_event, lambda_context, _pool(), method, path, body, claims=ADMIN_CALLER)
    assert status == 200
    getattr(cognito, write).assert_called_once()


def test_a_demotion_revokes_platform_admin_and_is_audited(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, _, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/pia/group', {'group': 'users'})
    assert (status, pool.groups['pia']) == (200, ['users'])
    assert _audit(table) == [(users_handler.PLATFORM_ADMIN_REVOKE, 'demotion', 'sub-pia', 'sub-root')]


def test_demoting_an_administrator_who_is_no_platform_admin_records_nothing(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, _, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/ada/group', {'group': 'users'},
                         claims=ADMIN_CALLER)
    assert (status, pool.groups['ada'], _audit(table)) == (200, ['users'], [])


def test_a_promotion_keeps_platform_admin(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, _, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/pia/group', {'group': 'admins'},
                         claims=ADMIN_CALLER)
    assert (status, pool.groups['pia'], _audit(table)) == (200, ['admins', PLATFORM], [])


def test_deleting_a_platform_admin_is_audited_as_a_revoke(api_gateway_event, lambda_context, table):
    status, _, _ = _call(api_gateway_event, lambda_context, _pool(), 'DELETE', '/users/pia')
    assert status == 200
    assert _audit(table) == [(users_handler.PLATFORM_ADMIN_REVOKE, 'delete', 'sub-pia', 'sub-root')]


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body', 'write'), [
    ('PUT', '/users/pia/group', {'group': 'users'}, 'admin_add_user_to_group'),
    ('PUT', '/users/pia/disable', None, 'admin_disable_user'),
    ('DELETE', '/users/pia', None, 'admin_delete_user'),
    ('PUT', '/users/pia/platform-admin', {'platform_admin': False}, 'admin_remove_user_from_group'),
], ids=['demote', 'disable', 'delete', 'revoke'])
def test_the_last_enabled_platform_admin_is_kept(api_gateway_event, lambda_context, method, path, body, write):
    # pia is the only platform admin the group listing shows enabled (the caller's own row is listed disabled,
    # while its account answers enabled): the guard alone keeps her.
    pool = _pool()
    pool.disabled.add('root')
    status, answer, cognito = _call(api_gateway_event, lambda_context, pool, method, path, body)
    assert (status, answer['error']) == (409, user_admin_guard.LAST_PLATFORM_ADMIN_MESSAGE)
    _assert_pia_untouched(cognito, pool, write)


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('path', 'body', 'pia_groups', 'message'), [
    ('/users/pia@example.com/disable', None, ['admins', PLATFORM], user_admin_guard.LAST_PLATFORM_ADMIN_MESSAGE),
    ('/users/pia@example.com/platform-admin', {'platform_admin': False}, ['admins', PLATFORM],
     user_admin_guard.LAST_PLATFORM_ADMIN_MESSAGE),
    ('/users/ada@example.com/disable', None, ['users'], user_admin_guard.LAST_ADMIN_MESSAGE),
], ids=['disable-platform-admin', 'revoke', 'disable-admin'])
def test_an_email_alias_in_the_path_is_the_same_last_member(api_gateway_event, lambda_context, path, body,
                                                            pia_groups, message):
    # Cognito accepts the email alias as Username; the groups list the canonical names. The caller's row is disabled.
    pool = Pool({'root': ['admins', PLATFORM], 'pia': pia_groups, 'ada': ['admins']}, disabled={'root'})
    cognito = _double(pool)
    # The alias resolves to its canonical name; a canonical name (the caller's own live check) to itself.
    canonical = {**{name: name for name in pool.groups}, **{f'{name}@example.com': name for name in pool.groups}}
    cognito.admin_get_user.side_effect = lambda Username, **_kw: {
        'Username': canonical[Username], 'Enabled': True,
        'UserAttributes': [{'Name': 'sub', 'Value': f'sub-{canonical[Username]}'}]}
    cognito.admin_list_groups_for_user.side_effect = lambda Username, **_kw: {
        'Groups': [{'GroupName': g} for g in pool.groups[canonical[Username]]]}
    with patch.object(users_handler, 'cognito', cognito):
        response, answer = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                      path=path, body=body, claims=PLATFORM_CALLER)
    assert (response['statusCode'], answer['error']) == (409, message)


# ── PUT /users/{username}/platform-admin ─────────────────────────────────────

def test_a_grant_adds_the_group_and_is_audited(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, answer, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/ada/platform-admin',
                              {'platform_admin': True})
    assert (status, answer) == (200, {'success': True, 'username': 'ada', 'platform_admin': True,
                                      'message': 'Platform admin granted'})
    assert pool.groups['ada'] == ['admins', PLATFORM]
    assert _audit(table) == [(users_handler.PLATFORM_ADMIN_GRANT, 'platform_admin_route', 'sub-ada', 'sub-root')]


def test_the_audit_row_is_an_audit_partition_with_a_time_and_random_key(api_gateway_event, lambda_context, table):
    with patch.object(users_handler, 'now_iso', return_value='2026-11-12T08:00:00+00:00'):
        _call(api_gateway_event, lambda_context, _pool(), 'PUT', '/users/ada/platform-admin', {'platform_admin': True})
    [row] = table.query(KeyConditionExpression='pk = :pk',
                        ExpressionAttributeValues={':pk': 'AUDIT#platform-admins'})['Items']
    assert row['sk'].startswith('2026-11-12T08:00:00+00:00#')
    assert (len(row['sk'].split('#')[1]), row['at']) == (16, '2026-11-12T08:00:00+00:00')


def test_a_revoke_removes_the_group_and_is_audited(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, answer, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/pia/platform-admin',
                              {'platform_admin': False})
    assert (status, answer['message'], pool.groups['pia']) == (200, 'Platform admin revoked', ['admins'])
    assert _audit(table) == [(users_handler.PLATFORM_ADMIN_REVOKE, 'platform_admin_route', 'sub-pia', 'sub-root')]


@pytest.mark.usefixtures('table')
def test_a_platform_admin_may_revoke_themselves_while_another_remains(api_gateway_event, lambda_context):
    pool = _pool()
    status, _, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/root/platform-admin',
                         {'platform_admin': False})
    assert (status, pool.groups['root']) == (200, ['admins'])


def test_the_last_platform_admin_may_not_revoke_themselves(api_gateway_event, lambda_context, table):
    pool = Pool({'root': ['admins', PLATFORM], 'ada': ['admins']})
    status, answer, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/root/platform-admin',
                              {'platform_admin': False})
    assert (status, answer['error'], _audit(table)) == (409, user_admin_guard.LAST_PLATFORM_ADMIN_MESSAGE, [])


@pytest.mark.parametrize(('username', 'grant'), [('pia', True), ('ada', False)], ids=['grant', 'revoke'])
def test_asking_for_what_holds_changes_and_records_nothing(api_gateway_event, lambda_context, table, username, grant):
    status, answer, cognito = _call(api_gateway_event, lambda_context, _pool(), 'PUT',
                                    f'/users/{username}/platform-admin', {'platform_admin': grant})
    assert (status, answer['message'], _audit(table)) == (200, 'Platform admin membership unchanged', [])
    cognito.admin_add_user_to_group.assert_not_called()
    cognito.admin_remove_user_from_group.assert_not_called()


def test_only_an_administrator_can_be_granted(api_gateway_event, lambda_context, table):
    pool = _pool()
    status, answer, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/uma/platform-admin',
                              {'platform_admin': True})
    assert (status, pool.groups['uma'], _audit(table)) == (400, ['users'], [])
    assert answer['error'].startswith('Only an administrator can be a platform admin')


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('claims', 'error'), [(ADMIN_CALLER, 'Platform admin access required'),
                                               (USER_CALLER, 'Admin access required')], ids=['admin', 'user'])
def test_the_route_is_for_platform_admins_only(api_gateway_event, lambda_context, claims, error):
    status, answer, cognito = _call(api_gateway_event, lambda_context, _pool(), 'PUT', '/users/ada/platform-admin',
                                    {'platform_admin': True}, claims=claims)
    assert (status, answer['error'], cognito.mock_calls) == (403, error, [])


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('body', [{}, {'platform_admin': 'true'}, {'platform_admin': None},
                                  {'platform_admin': True, 'group': 'admins'}],
                         ids=['empty', 'string', 'null', 'extra-field'])
def test_the_body_is_exactly_one_boolean(api_gateway_event, lambda_context, body):
    status, answer, cognito = _call(api_gateway_event, lambda_context, _pool(), 'PUT', '/users/ada/platform-admin', body)
    assert (status, answer['error']) == (400, 'Body must be {"platform_admin": true} or {"platform_admin": false}')
    assert cognito.mock_calls == []


@pytest.mark.usefixtures('table')
def test_an_unknown_user_is_404(api_gateway_event, lambda_context):
    status, answer, _ = _call(api_gateway_event, lambda_context, _pool(), 'PUT', '/users/nobody/platform-admin',
                              {'platform_admin': True})
    assert (status, answer['error']) == (404, 'User not found')


def test_a_change_whose_audit_row_cannot_be_written_is_refused(api_gateway_event, lambda_context, table):
    pool = _pool()
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'PutItem')
    with patch.object(table, 'put_item', side_effect=denied):
        status, answer, _ = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/ada/platform-admin',
                                  {'platform_admin': True})
    assert (status, answer['error'], pool.groups['ada']) == (500, users_handler.FAILED_UPDATE_PLATFORM_ADMIN,
                                                              ['admins'])


@pytest.mark.parametrize(('method', 'path', 'body', 'never_called'), [
    ('PUT', '/users/pia/group', {'group': 'users'}, 'admin_remove_user_from_group'),
    ('DELETE', '/users/pia', None, 'admin_delete_user'),
], ids=['demote', 'delete'])
def test_a_demotion_or_delete_whose_audit_row_cannot_be_written_changes_nothing(
        api_gateway_event, lambda_context, table, method, path, body, never_called):
    # The audit row is written BEFORE the Cognito change: a row that cannot be written leaves pia as she was.
    pool = _pool()
    denied = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'PutItem')
    with patch.object(table, 'put_item', side_effect=denied):
        status, _, cognito = _call(api_gateway_event, lambda_context, pool, method, path, body)
    assert status == 500
    _assert_pia_untouched(cognito, pool, never_called)


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body'), [
    ('PUT', '/users/root/platform-admin', {'platform_admin': True}),
    ('PUT', '/users/pia/disable', None),
], ids=['grant-back', 'disable-a-platform-admin'])
def test_a_revoked_platform_admin_whose_token_still_carries_the_group_is_refused(
        api_gateway_event, lambda_context, method, path, body):
    # root's token still lists platform-admins, but the group was revoked: the live membership decides.
    pool = Pool({'root': ['admins'], 'pia': ['admins', PLATFORM], 'ada': ['admins'], 'uma': ['users']})
    status, answer, cognito = _call(api_gateway_event, lambda_context, pool, method, path, body)
    assert status == 403
    assert 'platform admin' in answer['error'].lower()
    cognito.admin_add_user_to_group.assert_not_called()
    cognito.admin_disable_user.assert_not_called()


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('method', 'path', 'body'), [
    ('PUT', '/users/ada/platform-admin', {'platform_admin': True}),
    ('PUT', '/users/pia/disable', None),
], ids=['grant', 'disable-a-platform-admin'])
def test_a_disabled_platform_admin_whose_token_is_still_valid_is_refused(
        api_gateway_event, lambda_context, method, path, body):
    # Cognito keeps a disabled user's groups and the ID token stays valid: the account's live state decides.
    pool = _pool()
    pool.account_disabled.add('root')
    status, _, cognito = _call(api_gateway_event, lambda_context, pool, method, path, body)
    assert status == 403
    cognito.admin_add_user_to_group.assert_not_called()
    cognito.admin_disable_user.assert_not_called()


@pytest.mark.usefixtures('table')
def test_a_deleted_caller_whose_token_is_still_valid_is_refused_not_a_fault(api_gateway_event, lambda_context):
    pool = Pool({'pia': ['admins', PLATFORM], 'ada': ['admins'], 'uma': ['users']})  # root is gone
    status, _, cognito = _call(api_gateway_event, lambda_context, pool, 'PUT', '/users/ada/platform-admin',
                               {'platform_admin': True})
    assert status == 403
    cognito.admin_add_user_to_group.assert_not_called()


@pytest.mark.usefixtures('table')
def test_a_demotion_that_fails_part_way_never_leaves_a_platform_admin_who_is_no_administrator(
        api_gateway_event, lambda_context):
    # platform-admins is removed first, so a fault on the next remove leaves pia an administrator without it.
    pool = _pool()
    cognito = _double(pool)
    remove = cognito.admin_remove_user_from_group.side_effect

    def remove_then_fail(Username: str, GroupName: str, **kw: Any) -> None:
        if GroupName == 'admins':
            raise ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow'}}, 'Remove')
        remove(Username=Username, GroupName=GroupName, **kw)

    cognito.admin_remove_user_from_group.side_effect = remove_then_fail
    with patch.object(users_handler, 'cognito', cognito):
        response, _ = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                 path='/users/pia/group', body={'group': 'users'}, claims=PLATFORM_CALLER)
    assert response['statusCode'] == 500
    assert pool.groups['pia'] == ['admins']


@pytest.mark.usefixtures('table')
def test_a_promotion_of_an_administrator_never_removes_the_admins_group(api_gateway_event, lambda_context):
    # Even a plain admin may send it, and even if the add then fails, pia keeps admins and platform-admins.
    pool = _pool()
    cognito = _double(pool)
    cognito.admin_add_user_to_group.side_effect = ClientError(
        {'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow'}}, 'Add')
    with patch.object(users_handler, 'cognito', cognito):
        call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                   path='/users/pia/group', body={'group': 'admins'}, claims=ADMIN_CALLER)
    _assert_pia_untouched(cognito, pool, 'admin_remove_user_from_group')


@pytest.mark.usefixtures('table')
def test_a_token_without_a_username_is_not_a_platform_admin(api_gateway_event, lambda_context):
    claims = {'sub': 'sub-root', 'cognito:groups': '[admins, platform-admins]'}
    status, _, cognito = _call(api_gateway_event, lambda_context, _pool(), 'PUT', '/users/ada/platform-admin',
                               {'platform_admin': True}, claims=claims)
    assert status == 403
    cognito.admin_add_user_to_group.assert_not_called()


@pytest.mark.usefixtures('table')
def test_a_failed_live_check_of_the_caller_is_a_fixed_500(api_gateway_event, lambda_context):
    pool = _pool()
    cognito = _double(pool)
    real = cognito.admin_list_groups_for_user.side_effect
    denied = ClientError({'Error': {'Code': 'InternalErrorException', 'Message': 'pool detail'}}, 'AdminListGroupsForUser')

    def groups_of(Username: str, **kw: Any) -> dict:
        if Username == 'root':  # the caller's own live check fails
            raise denied
        return real(Username=Username, **kw)

    cognito.admin_list_groups_for_user.side_effect = groups_of
    with patch.object(users_handler, 'cognito', cognito):
        response, answer = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                      path='/users/ada/platform-admin', body={'platform_admin': True},
                                      claims=PLATFORM_CALLER)
    assert (response['statusCode'], answer['error']) == (500, users_handler.FAILED_UPDATE_PLATFORM_ADMIN)
    assert pool.groups['ada'] == ['admins']


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize(('fault', 'expected'), [
    (RuntimeError('cognito detail'), (500, users_handler.FAILED_UPDATE_PLATFORM_ADMIN)),
    ('not-found', (404, 'User not found')),
], ids=['fault', 'gone'])
def test_a_failed_group_change_answers_a_fixed_error(api_gateway_event, lambda_context, fault, expected):
    cognito = _double(_pool())
    cognito.admin_add_user_to_group.side_effect = (
        cognito.exceptions.UserNotFoundException() if fault == 'not-found' else fault)
    with patch.object(users_handler, 'cognito', cognito):
        response, answer = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                      path='/users/ada/platform-admin', body={'platform_admin': True},
                                      claims=PLATFORM_CALLER)
    assert (response['statusCode'], answer['error']) == expected


@pytest.mark.usefixtures('table')
def test_an_unreadable_platform_admin_list_is_a_fixed_500(api_gateway_event, lambda_context):
    cognito = _double(_pool())
    cognito.list_users_in_group.side_effect = RuntimeError('cognito detail')
    with patch.object(users_handler, 'cognito', cognito), patch.object(users_handler, 'logger') as log:
        response, answer = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context, method='PUT',
                                      path='/users/pia/platform-admin', body={'platform_admin': False},
                                      claims=PLATFORM_CALLER)
    assert (response['statusCode'], answer['error']) == (500, users_handler.FAILED_UPDATE_PLATFORM_ADMIN)
    log.exception.assert_called_once_with('Error checking the platform admins')


# ── GET /users ───────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('table')
def test_the_user_list_reports_each_users_platform_admin_membership(api_gateway_event, lambda_context):
    status, answer, _ = _call(api_gateway_event, lambda_context, _pool(), 'GET', '/users', claims=ADMIN_CALLER)
    assert status == 200
    assert {user['username']: user['platform_admin'] for user in answer['users']} == {
        'root': True, 'pia': True, 'ada': False, 'uma': False}
