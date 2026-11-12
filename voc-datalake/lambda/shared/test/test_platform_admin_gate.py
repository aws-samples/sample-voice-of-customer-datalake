"""shared/platform_admin_gate.py: the live platform-admin gate of the deployment-wide writes."""
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from shared.exceptions import AuthorizationError, ConfigurationError, ServiceError
from shared.platform_admin_gate import require_live_platform_admin
from shared.test.cognito_doubles import live_cognito

PAT = {'requestContext': {'authorizer': {'claims': {
    'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}}}}


@pytest.fixture
def pool(monkeypatch):
    monkeypatch.setenv('USER_POOL_ID', 'us-east-1_pool')


def _with(cognito):
    return patch('shared.platform_admin_gate.get_cognito_idp_client', return_value=cognito)


@pytest.mark.usefixtures('pool')
def test_a_live_platform_admin_passes_and_the_pool_is_the_deployments():
    cognito = live_cognito()
    with _with(cognito):
        require_live_platform_admin(PAT, 'Failed')
    cognito.admin_list_groups_for_user.assert_called_once_with(Username='pat', UserPoolId='us-east-1_pool')


@pytest.mark.usefixtures('pool')
@pytest.mark.parametrize('cognito', [
    live_cognito(groups=('admins',)), live_cognito(enabled=False), live_cognito(missing=True),
    live_cognito(sub='sub-someone-else'),
], ids=['revoked', 'disabled', 'deleted', 'another-person'])
def test_anyone_but_a_live_platform_admin_is_refused(cognito):
    with _with(cognito), pytest.raises(AuthorizationError, match='Platform admin access required'):
        require_live_platform_admin(PAT, 'Failed')


@pytest.mark.usefixtures('pool')
def test_a_cognito_fault_answers_the_fixed_error_and_admits_nobody():
    cognito = live_cognito()
    cognito.admin_list_groups_for_user.side_effect = ClientError(
        {'Error': {'Code': 'InternalErrorException', 'Message': 'us-east-1_pool arn'}}, 'AdminListGroupsForUser')
    with _with(cognito), pytest.raises(ServiceError) as raised:
        require_live_platform_admin(PAT, 'Failed to save')
    assert str(raised.value) == 'Failed to save'


def test_without_the_user_pool_it_is_a_configuration_error(monkeypatch):
    monkeypatch.delenv('USER_POOL_ID', raising=False)
    with _with(live_cognito()), pytest.raises(ConfigurationError):
        require_live_platform_admin(PAT, 'Failed')
