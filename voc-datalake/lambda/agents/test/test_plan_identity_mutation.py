"""Mutation hardening for `agents/plan_identity.py`.

The cross-track Example Air run (`api/test/test_plan_cross_track.py`) and the conductor suite only see the
approver re-check through a fake Cognito that ignores its arguments, through a whole plan. A mutation
run found unobserved:

* the directory transport — the ``cognito-idp`` client built once and reused, the ``USER_POOL_ID``
  refusal (exact message) and the pool id, ``Username`` and the 60-group ``Limit`` each call sends;
* the error mapping — only ``UserNotFoundException`` is a refusal; any other ClientError, one without
  an ``Error`` block and a BotoCoreError fail closed as ``DirectoryUnavailable(<operation>)`` after
  the ``Approver re-check failed`` log line naming the operation;
* the reading of the answers — a missing ``Enabled`` is disabled, a missing ``UserAttributes`` /
  ``Groups`` is empty, non-dict entries are skipped, the disabled check comes before the sub check;
* the claims — every key and value, the ``admins,users`` / ``users`` group strings, the
  ``plan:<id>`` principal, the four ways a plan has no approver, and that ``admins`` is forwarded
  for ``admin_if_current`` only while the approver is in the group (never by default).
"""
from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from agents import plan_identity as pi

POOL = 'pool-42'
META = {'approver_sub': 'sub-7', 'approver_username': 'ada', 'plan_id': 'pl_abc'}
USER_ONLY = {'sub': 'sub-7', 'cognito:username': 'ada', 'cognito:groups': 'users',
             'voc:acting_subject': 'sub-7', 'voc:principal': 'plan:pl_abc'}
ADMIN_CLAIMS = {**USER_ONLY, 'cognito:groups': 'admins,users'}


def _user(*, enabled: Any = True, sub: str = 'sub-7') -> dict:
    return {'Enabled': enabled, 'UserAttributes': ['junk', {'Name': 'email', 'Value': 'a@x'},
                                                     {'Name': 'sub', 'Value': sub}]}


def _groups(*names: str) -> dict:
    return {'Groups': ['junk', *({'GroupName': name} for name in names)]}


@pytest.fixture
def client() -> Iterator[MagicMock]:
    fake = MagicMock()
    fake.admin_get_user.return_value = _user()
    fake.admin_list_groups_for_user.return_value = _groups('users')
    with patch.object(pi, '_cognito', return_value=fake), patch.dict('os.environ', {'USER_POOL_ID': POOL}):
        yield fake


class TestTheDirectoryClient:
    def test_the_cognito_client_is_built_once_and_reused(self):
        built = MagicMock()
        with patch.object(pi, '_client', None), patch('agents.plan_identity.boto3.client',
                                                      return_value=built) as factory:
            assert pi._cognito() is built
            assert pi._cognito() is built
        factory.assert_called_once_with('cognito-idp')

    def test_a_fresh_module_builds_its_client_on_first_use(self):
        spec = importlib.util.spec_from_file_location('fresh_plan_identity', pi.__file__)
        assert spec
        assert spec.loader
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        built = MagicMock()
        with patch.object(fresh.boto3, 'client', return_value=built) as factory:
            assert fresh._cognito() is built
        factory.assert_called_once_with('cognito-idp')

    def test_an_unset_pool_is_a_directory_fault_with_its_reason(self):
        with patch.dict('os.environ', {}, clear=True), pytest.raises(pi.DirectoryUnavailable) as raised:
            pi._pool()
        assert str(raised.value) == 'USER_POOL_ID is not configured'

    def test_an_empty_pool_is_refused_too(self):
        with patch.dict('os.environ', {'USER_POOL_ID': ''}), pytest.raises(pi.DirectoryUnavailable):
            pi._pool()

    def test_every_call_names_the_pool_the_user_and_the_group_page(self, client: MagicMock):
        pi.approver_claims(META, needs_admin=False, admin_if_current=True)
        client.admin_get_user.assert_called_once_with(UserPoolId=POOL, Username='ada')
        client.admin_list_groups_for_user.assert_called_once_with(UserPoolId=POOL, Username='ada', Limit=60)


class TestDirectoryErrors:
    def test_an_unknown_user_stops_the_plan(self, client: MagicMock):
        client.admin_get_user.side_effect = ClientError({'Error': {'Code': 'UserNotFoundException'}}, 'AdminGetUser')
        with pytest.raises(pi.ApproverRefused) as raised:
            pi.approver_claims(META, needs_admin=False)
        assert str(raised.value) == "The approver's account no longer exists."
        assert isinstance(raised.value.__cause__, ClientError)

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Code': 'InternalErrorException'}}, 'AdminGetUser'),
        ClientError({}, 'AdminGetUser'),
        BotoCoreError(),
    ])
    def test_any_other_fault_fails_closed_naming_the_operation(self, client: MagicMock, error: Exception):
        client.admin_get_user.side_effect = error
        with patch.object(pi, 'logger') as log, pytest.raises(pi.DirectoryUnavailable) as raised:
            pi.approver_claims(META, needs_admin=False)
        assert str(raised.value) == 'admin_get_user'
        assert raised.value.__cause__ is error
        log.exception.assert_called_once_with('Approver re-check failed', extra={'operation': 'admin_get_user'})


class TestTheApproverIsCurrent:
    @pytest.mark.parametrize(('answer', 'reason'), [
        (_user(enabled=False), "The approver's account is disabled."),
        ({'UserAttributes': [{'Name': 'sub', 'Value': 'sub-7'}]}, "The approver's account is disabled."),
        (_user(enabled=False, sub='other'), "The approver's account is disabled."),
        (_user(sub='other'), "The approver's account no longer matches the plan."),
        ({'Enabled': True}, "The approver's account no longer matches the plan."),
    ])
    def test_a_disabled_or_different_user_is_refused(self, client: MagicMock, answer: dict, reason: str):
        client.admin_get_user.return_value = answer
        with pytest.raises(pi.ApproverRefused) as raised:
            pi.approver_claims(META, needs_admin=False)
        assert str(raised.value) == reason

    @pytest.mark.parametrize('meta', [
        {**META, 'approver_sub': None}, {**META, 'approver_sub': ''},
        {**META, 'approver_username': 7}, {**META, 'approver_username': ''},
    ])
    def test_a_plan_without_a_usable_approver_is_refused_before_any_call(self, client: MagicMock, meta: dict):
        with pytest.raises(pi.ApproverRefused) as raised:
            pi.approver_claims(meta, needs_admin=False)
        assert str(raised.value) == 'The plan has no approver.'
        client.admin_get_user.assert_not_called()


class TestTheClaims:
    def test_an_ordinary_step_runs_as_the_user_without_asking_for_groups(self, client: MagicMock):
        client.admin_list_groups_for_user.return_value = _groups('admins')
        assert pi.approver_claims(META, needs_admin=False) == USER_ONLY
        client.admin_list_groups_for_user.assert_not_called()

    def test_an_admin_step_carries_admins_for_a_current_admin(self, client: MagicMock):
        client.admin_list_groups_for_user.return_value = _groups('users', 'admins')
        assert pi.approver_claims(META, needs_admin=True) == ADMIN_CLAIMS
        client.admin_list_groups_for_user.assert_called_once_with(UserPoolId=POOL, Username='ada', Limit=60)

    @pytest.mark.parametrize('answer', [_groups('users'), {}])
    def test_an_admin_step_is_refused_for_a_demoted_approver(self, client: MagicMock, answer: dict):
        client.admin_list_groups_for_user.return_value = answer
        with pytest.raises(pi.ApproverRefused) as raised:
            pi.approver_claims(META, needs_admin=True)
        assert str(raised.value) == 'The approver is no longer an administrator.'

    @pytest.mark.parametrize(('groups', 'expected'), [(('admins',), ADMIN_CLAIMS), (('users',), USER_ONLY)])
    def test_admin_if_current_forwards_admins_only_while_the_approver_is_one(
            self, client: MagicMock, groups: tuple[str, ...], expected: dict):
        client.admin_list_groups_for_user.return_value = _groups(*groups)
        assert pi.approver_claims(META, needs_admin=False, admin_if_current=True) == expected
