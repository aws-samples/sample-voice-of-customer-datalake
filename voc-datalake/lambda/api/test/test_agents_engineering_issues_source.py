"""The GitHub Issues source configured from the connections, through the Agents API's routes (7.50.02:
``GET /agents/engineering/issues-source``, ``PUT …/connections/<id>/issues``, and the installation, check and removal
steps; engineering/connectors/issues_sync.py).

Connecting a repository through the deployment's App is what makes the source read it (its ``issues`` block); the
switch takes it out and back; removing the connection takes out what its automation added. Every route is the
connections' gate: 404 while the module is off, then 403 for anyone but an administrator acting for themselves. The
source's settings are voc-engineering-issues-config's (its real code over fakes, as ``_invoke_issues_config``
answers), and that function's errors are this API's as ``_invoke_issues_config`` maps them.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from test_agents_engineering_github_apps import DELEGATED_ADMIN, FRONTEND, PATH, PREFIX, FakeLambda, create, state_of

import agents_handler
from engineering.board.test.table import TABLE, create_table
from engineering.connectors import github_apps
from engineering.connectors.connections import ConnectionRefused
from engineering.connectors.issues_sync import APP_KEY, MANAGED_KEY, REPOS_KEY
from engineering.connectors.test.issues_fakes import OTHER_PLUGINS, RULE, FakeConfigFunction, FakeEvents, FakeSecrets
from engineering.connectors.test.test_github_apps import APP_ID, FakeGitHub, FakeTokens, listed
from shared.engineering_agents import ISSUES_CONFIG_FUNCTION_ENV

ISSUES = '/agents/engineering/issues-source'
CONFIG_FUNCTION = 'voc-engineering-issues-config'


class Tokens(FakeTokens):
    """The token function: an inspection as test_github_apps.py answers it, and ``ensure_label`` (created)."""

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get('action') == 'ensure_label':
            self.calls.append(request)
            return {'repository': request['repository'], 'label': request['label'], 'created': True}
        return super().__call__(request)


@dataclass
class Env:
    secrets: FakeSecrets
    events: FakeEvents
    tokens: Tokens
    config: FakeConfigFunction


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    with _api() as agents:
        create_table()
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        for name, value in (('ENGINEERING_AGENTS', 'on'), ('ENGINEERING_TABLE', TABLE),
                            ('ENGINEERING_PARAMETER_PREFIX', PREFIX), ('ENGINEERING_PARAMETER_KEY', key),
                            ('FRONTEND_URL', FRONTEND), ('ENGINEERING_APP_TOKENS_FUNCTION', 'voc-engineering-app-tokens'),
                            (ISSUES_CONFIG_FUNCTION_ENV, CONFIG_FUNCTION)):
            monkeypatch.setenv(name, value)
        agents_handler._ssm_client.cache_clear()
        secrets, events = FakeSecrets(dict(OTHER_PLUGINS)), FakeEvents()
        config = FakeConfigFunction(secrets, events)
        tokens = Tokens(repositories=[listed('example-org/refund-service'), listed('example-org/web')])
        with patch.object(agents_handler, 'get_dynamodb_resource', return_value=agents.resource), \
                patch.object(github_apps, 'HttpsTransport', lambda **_: FakeGitHub()), \
                patch.object(agents_handler, '_invoke_app_tokens', tokens), \
                patch.object(agents_handler, '_invoke_issues_config', config):
            yield Env(secrets, events, tokens, config)
        agents_handler._ssm_client.cache_clear()


def install(lambda_context: Any) -> dict[str, Any]:
    made = create(lambda_context)
    status, done = _call(lambda_context, 'POST', f'{PATH}/installations', body={
        'installation_id': 777, 'setup_action': 'install', 'state': state_of(made['install_url'])})
    assert status == 200
    return done


def test_connecting_github_configures_the_issues_source_with_no_data_sources_step(lambda_context: Any,
                                                                                 env: Env) -> None:
    done = install(lambda_context)
    assert done['issues']['added'] == ['example-org/refund-service', 'example-org/web']
    assert done['issues']['labels'] == [{'repository': 'example-org/refund-service', 'state': 'created'},
                                        {'repository': 'example-org/web', 'state': 'created'}]
    assert env.secrets.value == {**OTHER_PLUGINS, REPOS_KEY: 'example-org/refund-service\nexample-org/web',
                                 MANAGED_KEY: 'example-org/refund-service\nexample-org/web', APP_KEY: APP_ID}
    assert env.events.enabled == [RULE]
    status, view = _call(lambda_context, 'GET', ISSUES)
    assert status == 200
    assert (view['deployed'], view['signs_in'], view['schedule']) == (True, 'app', 'on')
    assert [(c['connection_id'], c['reading'], c['label']) for c in view['connections']] == [
        ('refund-service', True, 'created'), ('web', True, 'created')]


def test_the_switch_takes_a_repository_out_and_back(lambda_context: Any, env: Env) -> None:
    install(lambda_context)
    status, view = _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues', body={'read': False})
    assert status == 200
    assert view['connections'][1] == {'connection_id': 'web', 'repository': 'example-org/web', 'read': False,
                                      'reading': False, 'reason': 'off', 'label': 'created'}
    assert env.secrets.value[REPOS_KEY] == 'example-org/refund-service'
    # A check does not bring it back while it is off.
    check = _call(lambda_context, 'POST', f'{PATH}/{APP_ID}/check', body={})[1]
    assert check['issues']['skipped'] == [{'repository': 'example-org/web', 'reason': 'off'}]
    assert _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues',
                 body={'read': True})[1]['connections'][1]['reading'] is True


def test_removing_a_connection_takes_its_repository_out_of_the_source(lambda_context: Any, env: Env) -> None:
    install(lambda_context)
    assert _call(lambda_context, 'DELETE', '/agents/engineering/connections/web')[0] == 200
    assert env.secrets.value[REPOS_KEY] == 'example-org/refund-service'
    assert env.secrets.value[MANAGED_KEY] == 'example-org/refund-service'


@pytest.mark.usefixtures('env')
def test_the_switch_is_refused_off_its_shape_or_for_an_unknown_connection(lambda_context: Any) -> None:
    install(lambda_context)
    for body in ({}, {'read': 'yes'}, {'read': True, 'other': 1}):
        assert _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues', body=body)[0] == 400
    assert _call(lambda_context, 'PUT', '/agents/engineering/connections/nothing/issues',
                 body={'read': True})[0] == 404


def test_where_the_source_is_not_deployed_the_view_says_so_and_the_switch_is_409(
        lambda_context: Any, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ISSUES_CONFIG_FUNCTION_ENV)
    done = install(lambda_context)
    assert done['issues'] is None
    status, view = _call(lambda_context, 'GET', ISSUES)
    assert (status, view['deployed'], {c['reason'] for c in view['connections']}) == (200, False, {'not_deployed'})
    assert _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues', body={'read': True})[0] == 409
    assert env.secrets.writes == []


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_routes_are_an_administrators_acting_for_themselves(lambda_context: Any, env: Env,
                                                                claims: dict[str, Any]) -> None:
    assert _call(lambda_context, 'GET', ISSUES, claims=claims)[0] == 403
    assert _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues', body={'read': True},
                 claims=claims)[0] == 403
    assert env.secrets.writes == []


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [ADMIN, USER], ids=['admin', 'plain user'])
def test_the_routes_are_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                    claims: dict[str, Any]) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'GET', ISSUES, claims=claims)[0] == 404
    assert _call(lambda_context, 'PUT', '/agents/engineering/connections/web/issues', body={'read': True},
                 claims=claims)[0] == 404


# --- the settings function as this API reads it ----------------------------------------------------------------------


def test_the_settings_function_is_invoked_by_name_with_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ISSUES_CONFIG_FUNCTION_ENV, CONFIG_FUNCTION)
    status = {'repos': [], 'repos_managed': [], 'github_app_id': None, 'sign_in': 'none', 'token_set': False,
              'schedule_enabled': False}
    client = FakeLambda(status)
    with patch.object(agents_handler, '_start_client', return_value=client):
        assert agents_handler._invoke_issues_config({'action': 'status'}) == status
    [call] = client.invoked
    assert (call['FunctionName'], call['InvocationType'], json.loads(call['Payload'])) == (
        CONFIG_FUNCTION, 'RequestResponse', {'action': 'status'})


@pytest.mark.parametrize(('payload', 'kind', 'said'), [
    ({'errorType': 'IssuesConfigRefused', 'errorMessage': 'the request is {action}'}, 'invalid', 'the request is'),
    ({'errorType': 'IssuesSettingsFull', 'errorMessage': 'the settings are full'}, 'conflict', 'full'),
    ({'errorType': 'IssuesSettingsUnavailable', 'errorMessage': 'try again'}, 'unavailable', 'try again'),
    ({'errorType': 'Sandbox.Timedout', 'errorMessage': 'Task timed out'}, 'unavailable', 'could not be read'),
])
def test_its_failures_are_its_refusals_in_its_words_or_a_plain_try_again(monkeypatch: pytest.MonkeyPatch,
                                                                         payload: dict[str, str], kind: str,
                                                                         said: str) -> None:
    monkeypatch.setenv(ISSUES_CONFIG_FUNCTION_ENV, CONFIG_FUNCTION)
    with patch.object(agents_handler, '_start_client', return_value=FakeLambda(payload, 'Unhandled')), \
            pytest.raises(ConnectionRefused, match=said) as refused:
        agents_handler._invoke_issues_config({'action': 'status'})
    assert refused.value.kind == kind


def test_an_installation_whose_settings_function_fails_is_saved_all_the_same(lambda_context: Any, env: Env) -> None:
    env.secrets.fail = True
    done = install(lambda_context)
    assert [c['connection']['connection_id'] for c in done['connections']] == ['refund-service', 'web']
    assert done['issues']['error'] == 'the GitHub Issues source could not be read: try again'
