"""shared/platform_admin.py: the token gate and the live check of a platform admin (docs/multi-workspace.md)."""
import pytest
from botocore.exceptions import ClientError

from shared.exceptions import AuthorizationError
from shared.platform_admin import is_live_platform_admin, is_platform_admin, require_platform_admin
from shared.test.cognito_doubles import live_cognito

POOL = 'us-east-1_pool'
PLATFORM_ADMIN = {'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}


def _event(claims):
    return {'requestContext': {'authorizer': {'claims': claims}}}


# ── The token gate ───────────────────────────────────────────────────────────

def test_require_platform_admin_admits_the_group():
    assert (is_platform_admin(_event(PLATFORM_ADMIN)), require_platform_admin(_event(PLATFORM_ADMIN))) == (True, None)


@pytest.mark.parametrize('claims', [{'sub': 'sub-uma', 'cognito:groups': 'users'},
                                    {'sub': 'sub-ada', 'cognito:groups': 'admins'}], ids=['user', 'admin'])
def test_require_platform_admin_refuses_everyone_else_an_administrator_too(claims):
    assert is_platform_admin(_event(claims)) is False
    with pytest.raises(AuthorizationError, match='Platform admin access required'):
        require_platform_admin(_event(claims))


# ── The live check ───────────────────────────────────────────────────────────

def test_a_platform_admin_now_passes_the_live_check():
    cognito = live_cognito()
    assert is_live_platform_admin(_event(PLATFORM_ADMIN), cognito, POOL) is True
    cognito.admin_list_groups_for_user.assert_called_once_with(Username='pat', UserPoolId=POOL)
    cognito.admin_get_user.assert_called_once_with(UserPoolId=POOL, Username='pat')


@pytest.mark.parametrize(('cognito', 'why'), [
    (live_cognito(('admins',)), 'revoked'),
    (live_cognito(enabled=False), 'disabled'),
    (live_cognito(missing=True), 'deleted'),
    # The username was deleted and given to another platform admin: the old token's sub is not that account's.
    (live_cognito(sub='sub-someone-else'), 'reused username'),
], ids=['revoked', 'disabled', 'deleted', 'reused-username'])
def test_a_stale_token_fails_the_live_check(cognito, why):
    assert is_live_platform_admin(_event(PLATFORM_ADMIN), cognito, POOL) is False, why


def test_a_token_without_the_group_is_refused_without_a_look_up():
    cognito = live_cognito()
    assert is_live_platform_admin(_event({'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'admins'}),
                                  cognito, POOL) is False
    cognito.admin_list_groups_for_user.assert_not_called()


@pytest.mark.parametrize('username', [None, '', '   '], ids=['absent', 'empty', 'blank'])
def test_a_token_without_a_username_is_refused(username):
    claims = {**PLATFORM_ADMIN, 'cognito:username': username}
    cognito = live_cognito()
    assert is_live_platform_admin(_event(claims), cognito, POOL) is False
    cognito.admin_list_groups_for_user.assert_not_called()


def test_the_access_token_username_claim_is_read_too():
    claims = {'sub': 'sub-pat', 'username': ' pat ', 'cognito:groups': 'platform-admins'}
    cognito = live_cognito()
    assert is_live_platform_admin(_event(claims), cognito, POOL) is True
    cognito.admin_get_user.assert_called_once_with(UserPoolId=POOL, Username='pat')


def test_a_cognito_fault_propagates_and_admits_no_one():
    cognito = live_cognito()
    cognito.admin_get_user.side_effect = ClientError({'Error': {'Code': 'InternalErrorException', 'Message': 'x'}},
                                                     'AdminGetUser')
    with pytest.raises(ClientError, match='InternalError'):
        is_live_platform_admin(_event(PLATFORM_ADMIN), cognito, POOL)
