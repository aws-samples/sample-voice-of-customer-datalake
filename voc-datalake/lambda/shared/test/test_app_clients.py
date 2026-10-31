"""The main API refuses Cognito tokens issued to any app client but the SPA's (shared/app_clients.py).

Security review of 5.62.00: an MCP OAuth client's token (same user pool) passes API Gateway's Cognito
authorizer, so every handler must refuse it itself, or an MCP client would act with the person's full
(admin) rights on every REST route.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from aws_lambda_powertools.utilities.typing import LambdaContext

from shared.api import create_api_resolver
from shared.app_clients import APP_CLIENT_IDS_ENV, issuing_client, require_app_client
from shared.exceptions import AuthenticationError

WEB = 'web-client-id'
BOARD = 'board-client-id'
MCP = 'kiro-client-id'
ENV = {APP_CLIENT_IDS_ENV: f'{WEB}, {BOARD}'}
API_DIR = Path(__file__).resolve().parents[2] / 'api'


def _event(claims: dict | None) -> dict:
    context: dict = {'requestId': 'r', 'stage': 'v1', 'httpMethod': 'GET', 'path': '/ping',
                     'identity': {'sourceIp': '1.2.3.4'}}
    if claims is not None:
        context['authorizer'] = {'claims': claims}
    return {'httpMethod': 'GET', 'path': '/ping', 'resource': '/ping', 'headers': {}, 'multiValueHeaders': {},
            'queryStringParameters': None, 'multiValueQueryStringParameters': None, 'pathParameters': None,
            'stageVariables': None, 'body': None, 'isBase64Encoded': False, 'requestContext': context}


def id_token(client: str) -> dict:
    return {'sub': 'sub-alice', 'token_use': 'id', 'aud': client, 'cognito:groups': '[admins]',
            'cognito:username': 'alice', 'email': 'alice@example.com'}


def access_token(client: str) -> dict:
    return {'sub': 'sub-alice', 'token_use': 'access', 'client_id': client, 'username': 'alice',
            'cognito:groups': '[admins]', 'scope': 'https://api.example/v1/mcp/global/write'}


def _resolve(claims: dict | None, env: dict = ENV) -> dict:
    """One GET through a resolver built like every handler's (create_api_resolver)."""
    app = create_api_resolver()

    @app.get('/ping')
    def ping():
        return {'ok': True}

    with patch.dict('os.environ', env):
        return app.resolve(_event(claims), LambdaContext())


def _status(claims: dict | None, env: dict = ENV) -> int:
    return _resolve(claims, env)['statusCode']


@pytest.mark.parametrize('token', [id_token, access_token])
def test_an_mcp_client_token_is_401_on_a_normal_route(token):
    assert _status(token(MCP)) == 401


@pytest.mark.parametrize('token', [id_token, access_token])
def test_the_spa_and_board_tokens_still_work(token):
    assert _status(token(WEB)) == 200
    assert _status(token(BOARD)) == 200


def test_the_refusal_is_the_api_error_shape():
    response = _resolve(id_token(MCP))
    assert json.loads(response['body']) == {'success': False, 'error': 'This sign-in is not valid for this API'}


@pytest.mark.parametrize('claims', [
    {'sub': 's', 'token_use': 'id'},                       # a token with no issuing client
    {'sub': 's', 'token_use': 'access', 'client_id': ''},
    {'sub': 's', 'aud': ['web-client-id']},                # not a string: never guessed
])
def test_a_token_without_a_usable_client_is_refused(claims):
    assert _status(claims) == 401


def test_without_the_env_every_token_is_refused():
    assert _status(id_token(WEB), env={APP_CLIENT_IDS_ENV: ''}) == 401


@pytest.mark.parametrize('claims', [
    None,                                                   # an anonymous route
    {'sub': 'mcp:tok_x', 'cognito:groups': '', 'email': 'mcp:tok_x'},  # MCP delegate (synthetic_claims)
    {'sub': 'sub-alice', 'cognito:groups': 'admins', 'cognito:username': 'alice'},  # stream-forwarded
])
def test_internal_and_anonymous_calls_are_not_judged(claims):
    assert _status(claims, env={APP_CLIENT_IDS_ENV: ''}) == 200


def test_issuing_client_prefers_client_id_over_a_resource_audience():
    claims = {'token_use': 'access', 'client_id': WEB, 'aud': 'https://api.example/v1/mcp/global'}
    assert issuing_client(claims) == WEB


def test_require_app_client_raises_the_401_error():
    with patch.dict('os.environ', ENV), pytest.raises(AuthenticationError):
        require_app_client(_event(access_token(MCP)))


def test_every_rest_handler_but_the_mcp_endpoint_builds_the_shared_resolver():
    """The check lives in create_api_resolver: a handler with its own resolver would skip it."""
    skipped = {'mcp_global_handler.py'}  # its own credential path (OAuth JWT / voc_tok_), unchanged
    missing = [path.name for path in sorted(API_DIR.glob('*_handler.py'))
               if path.name not in skipped and not re.search(r'\bcreate_api_resolver\(', path.read_text())]
    assert missing == []
