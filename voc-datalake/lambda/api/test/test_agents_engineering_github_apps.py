"""The Agents API's GitHub App connect flow (7.45.00: ``…/agents/engineering/github-apps…``;
engineering/connectors/github_apps.py), through the routes.

Every route answers 404 while the module is off, then 403 for anyone but an administrator acting for themselves (a
plain user, a delegated MCP credential). Through the routes: the manifest, the code's exchange (the App's key to SSM),
the installation saving its repositories as connections, the check and the removal; and the token function's answer
and its refusals as this API reads them (``_invoke_app_tokens``), never a token.
"""
from __future__ import annotations

import io
import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

import agents_handler
from engineering.board.test.table import TABLE, create_table
from engineering.connectors import github_apps
from engineering.connectors.connections import ConnectionRefused
from engineering.connectors.test.test_github_apps import APP_ID, CODE, FakeGitHub, FakeTokens

PATH = '/agents/engineering/github-apps'
PREFIX = '/voc/engineering/'
FRONTEND = 'https://d111.cloudfront.net'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


@dataclass
class Env:
    ssm: Any
    github: FakeGitHub
    tokens: FakeTokens


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    with _api() as agents:
        create_table()
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        for name, value in (('ENGINEERING_AGENTS', 'on'), ('ENGINEERING_TABLE', TABLE),
                            ('ENGINEERING_PARAMETER_PREFIX', PREFIX), ('ENGINEERING_PARAMETER_KEY', key),
                            ('FRONTEND_URL', FRONTEND), ('ENGINEERING_APP_TOKENS_FUNCTION', 'voc-engineering-app-tokens')):
            monkeypatch.setenv(name, value)
        agents_handler._ssm_client.cache_clear()
        github, tokens = FakeGitHub(), FakeTokens()
        with patch.object(agents_handler, 'get_dynamodb_resource', return_value=agents.resource), \
                patch.object(github_apps, 'HttpsTransport', lambda **_: github), \
                patch.object(agents_handler, '_invoke_app_tokens', tokens):
            yield Env(boto3.client('ssm', region_name='us-east-1'), github, tokens)
        agents_handler._ssm_client.cache_clear()


def state_of(url: str) -> str:
    return parse_qs(urlsplit(url).query)['state'][0]


def create(lambda_context: Any) -> dict[str, Any]:
    status, manifest = _call(lambda_context, 'POST', f'{PATH}/manifest', body={'account': 'user'})
    assert status == 200
    status, made = _call(lambda_context, 'POST', f'{PATH}/conversions',
                         body={'code': CODE, 'state': state_of(manifest['action_url'])})
    assert status == 201
    return made


@pytest.mark.usefixtures('env')
def test_an_administrator_creates_installs_checks_and_removes_an_app(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', PATH) == (200, {'apps': [], 'limit': 5})
    made = create(lambda_context)
    assert made['app']['app_id'] == APP_ID
    assert FRONTEND not in made['install_url']
    status, done = _call(lambda_context, 'POST', f'{PATH}/installations', body={
        'installation_id': 777, 'setup_action': 'install', 'state': state_of(made['install_url'])})
    assert (status, [c['connection']['connection_id'] for c in done['connections']]) == (200, ['refund-service'])
    assert _call(lambda_context, 'GET', PATH)[1]['apps'][0]['connections'] == ['refund-service']
    assert _call(lambda_context, 'POST', f'{PATH}/{APP_ID}/check', body={}) == (
        200, {'repositories': ['example-org/refund-service'], 'missing': []})
    status, again = _call(lambda_context, 'POST', f'{PATH}/{APP_ID}/install', body={})
    assert status == 200
    assert again['install_url'].startswith('https://github.com/apps/')
    assert _call(lambda_context, 'DELETE', f'{PATH}/{APP_ID}')[0] == 409   # (a connection uses it)
    assert _call(lambda_context, 'DELETE', '/agents/engineering/connections/refund-service')[0] == 200
    assert _call(lambda_context, 'DELETE', f'{PATH}/{APP_ID}', body={'reason': 'done'}) == (200, {'removed': True})
    assert _call(lambda_context, 'GET', PATH)[1]['apps'] == []


@pytest.mark.usefixtures('env')
def test_the_routes_answer_the_flows_refusals(lambda_context: Any) -> None:
    assert _call(lambda_context, 'POST', f'{PATH}/manifest', body={'account': 'organization', 'org': '-bad'})[0] == 400
    assert _call(lambda_context, 'POST', f'{PATH}/conversions', body={'code': CODE, 'state': 'A' * 43})[0] == 400
    assert _call(lambda_context, 'POST', f'{PATH}/installations', body={
        'installation_id': 1, 'setup_action': 'request', 'state': 'A' * 43})[0] == 400
    assert _call(lambda_context, 'POST', f'{PATH}/{APP_ID}/install', body={})[0] == 404
    assert _call(lambda_context, 'POST', f'{PATH}/{APP_ID}/check', body={'x': 1})[0] == 400
    assert _call(lambda_context, 'DELETE', f'{PATH}/not-an-id')[0] == 404
    assert _call(lambda_context, 'DELETE', f'{PATH}/{APP_ID}', body={'other': 1})[0] == 400


@pytest.mark.usefixtures('env')
def test_the_same_installation_posted_again_answers_the_same_json(lambda_context: Any) -> None:
    made = create(lambda_context)
    body = {'installation_id': 777, 'setup_action': 'install', 'state': state_of(made['install_url'])}
    first = _call(lambda_context, 'POST', f'{PATH}/installations', body=body)
    again = _call(lambda_context, 'POST', f'{PATH}/installations', body=body)   # (a refresh: the stored outcome)
    assert again == first
    assert first[0] == 200
    assert isinstance(again[1]['connections'][0]['connection']['version'], int)   # (never a Decimal's string)


def test_an_installation_of_another_app_is_409(lambda_context: Any, env: Env) -> None:
    made = create(lambda_context)
    env.tokens.error = ConnectionRefused('conflict', 'this installation belongs to another GitHub App')
    status, refused = _call(lambda_context, 'POST', f'{PATH}/installations', body={
        'installation_id': 777, 'setup_action': 'install', 'state': state_of(made['install_url'])})
    assert (status, refused['error']) == (409, 'this installation belongs to another GitHub App')


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_route_is_an_administrators_acting_for_themselves(lambda_context: Any, env: Env,
                                                                claims: dict[str, Any]) -> None:
    for method, path, payload in (('GET', PATH, None), ('POST', f'{PATH}/manifest', {'account': 'user'}),
                                  ('POST', f'{PATH}/conversions', {'code': CODE, 'state': 'A' * 43}),
                                  ('POST', f'{PATH}/installations', {}), ('POST', f'{PATH}/{APP_ID}/install', {}),
                                  ('POST', f'{PATH}/{APP_ID}/check', {}), ('DELETE', f'{PATH}/{APP_ID}', None)):
        assert _call(lambda_context, method, path, body=payload, claims=claims)[0] == 403, (method, path)
    assert env.github.sent == []
    assert env.tokens.calls == []


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [ADMIN, USER], ids=['admin', 'plain user'])
def test_every_route_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                    claims: dict[str, Any]) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    for method, path in (('GET', PATH), ('POST', f'{PATH}/manifest'), ('POST', f'{PATH}/conversions'),
                         ('POST', f'{PATH}/installations'), ('POST', f'{PATH}/{APP_ID}/install'),
                         ('POST', f'{PATH}/{APP_ID}/check'), ('DELETE', f'{PATH}/{APP_ID}')):
        assert _call(lambda_context, method, path, body={}, claims=claims)[0] == 404, (method, path)


def test_without_the_apps_address_a_manifest_is_503(lambda_context: Any, env: Env,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('FRONTEND_URL')
    assert _call(lambda_context, 'POST', f'{PATH}/manifest', body={'account': 'user'})[0] == 503
    assert env.github.sent == []


# --- the token function as this API reads it ---------------------------------------------------------------------


class FakeLambda:
    def __init__(self, payload: object, function_error: str | None = None, error: Exception | None = None) -> None:
        self.payload, self.function_error, self.error = payload, function_error, error
        self.invoked: list[dict[str, Any]] = []

    def invoke(self, **kwargs: Any) -> dict[str, Any]:
        self.invoked.append(kwargs)
        if self.error is not None:
            raise self.error
        answer: dict[str, Any] = {'Payload': io.BytesIO(json.dumps(self.payload).encode())}
        if self.function_error is not None:
            answer['FunctionError'] = self.function_error
        return answer


def test_the_token_function_is_invoked_by_name_with_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('ENGINEERING_APP_TOKENS_FUNCTION', 'voc-engineering-app-tokens')
    client = FakeLambda({'account': {'login': 'o', 'type': 'User'}, 'repositories': [], 'truncated': False})
    with patch.object(agents_handler, '_start_client', return_value=client):
        found = agents_handler._invoke_app_tokens({'action': 'inspect_installation', 'app_id': APP_ID,
                                                   'installation_id': 7})
    assert found['account'] == {'login': 'o', 'type': 'User'}
    [call] = client.invoked
    assert (call['FunctionName'], call['InvocationType'], json.loads(call['Payload'])) == (
        'voc-engineering-app-tokens', 'RequestResponse',
        {'action': 'inspect_installation', 'app_id': APP_ID, 'installation_id': 7})


@pytest.mark.parametrize(('payload', 'kind', 'said'), [
    ({'errorType': 'InstallationRefused', 'errorMessage': 'another App'}, 'conflict', 'another App'),
    ({'errorType': 'AppKeyUnavailable', 'errorMessage': 'not stored'}, 'conflict', 'not stored'),
    ({'errorType': 'HostBusy', 'errorMessage': 'rate limited'}, 'unavailable', 'rate limited'),
    ({'errorType': 'AppTokensRefused', 'errorMessage': 'x'}, 'unavailable', 'GitHub could not be read'),
    ({'errorType': 'Sandbox.Timedout', 'errorMessage': 'Task timed out'}, 'unavailable', 'GitHub could not be read'),
])
def test_its_failures_are_its_refusals_in_its_words_or_a_plain_try_again(monkeypatch: pytest.MonkeyPatch,
                                                                         payload: dict[str, str], kind: str,
                                                                         said: str) -> None:
    monkeypatch.setenv('ENGINEERING_APP_TOKENS_FUNCTION', 'voc-engineering-app-tokens')
    with patch.object(agents_handler, '_start_client', return_value=FakeLambda(payload, 'Unhandled')), \
            pytest.raises(ConnectionRefused) as refused:
        agents_handler._invoke_app_tokens({'action': 'inspect_installation'})
    assert refused.value.kind == kind
    assert said in str(refused.value)


def test_without_the_token_function_an_installation_cannot_be_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_APP_TOKENS_FUNCTION', raising=False)
    with pytest.raises(ConnectionRefused) as refused:
        agents_handler._invoke_app_tokens({'action': 'inspect_installation'})
    assert refused.value.kind == 'unavailable'
