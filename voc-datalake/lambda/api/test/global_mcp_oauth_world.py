"""MCP OAuth sign-in driven end to end, on top of ``global_mcp_world`` (moto tables, real handlers).

``OAuthWorld.sign_in`` walks the flow a desktop MCP client walks, through the REAL anonymous facade and
consent API of ``mcp_tokens_handler``: register (DCR facade) → ``GET /oauth/authorize`` (302 to the SPA)
→ consent (``GET`` + ``POST /connect/oauth/consent`` as the signed-in person) → Cognito's hosted sign-in
(``FakeCognito``: issues a code for whoever "signs in", then tokens signed with the session's test key)
→ ``GET /oauth/callback`` (the relay) → ``POST /oauth/token``. The resulting ACCESS token is then
presented to ``/mcp/global`` like any client would. Only Cognito and its JWKS are stubbed.
"""
from __future__ import annotations

import json
import secrets
import time
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

from global_mcp_world import World, global_mcp_world
from moto_helpers import rest_event

import mcp_tokens_handler
from shared import mcp_oauth_consent_routes, mcp_oauth_routes
from shared.test.mcp_oauth_fixtures import CLIENTS, COGNITO_DOMAIN, FRONTEND, RESOURCE, jwks_cache, oauth_env, sign

CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
LOOPBACK = {'kiro': 'http://127.0.0.1:{port}/oauth/callback', 'claude-code': 'http://localhost:{port}/callback',
            'cursor': 'http://127.0.0.1:{port}/callback'}


def _expect(condition: bool, detail: object = None) -> None:
    """An assertion that survives ``python -O`` (this is a support module, not a test file)."""
    if not condition:
        raise AssertionError(detail)


@dataclass
class FakeResponse:
    status_code: int
    payload: dict

    @property
    def content(self) -> bytes:
        return json.dumps(self.payload).encode()

    def json(self) -> dict:
        return self.payload


@dataclass
class FakeCognito:
    """Cognito's hosted UI + /oauth2/token + /oauth2/revoke, as far as the facade can observe them."""

    subs: dict[str, str]
    codes: dict[str, dict] = field(default_factory=dict)
    refresh: dict[str, dict] = field(default_factory=dict)
    revoked: list[str] = field(default_factory=list)
    token_calls: list[dict] = field(default_factory=list)

    def sign_in(self, authorize_url: str, username: str) -> dict[str, str]:
        """The person signs in at the hosted UI: a code for the URL's client and scope."""
        params = {k: v[0] for k, v in parse_qs(urlsplit(authorize_url).query).items()}
        code = secrets.token_urlsafe(24)
        self.codes[code] = {'username': username, 'client_id': params['client_id'], 'scope': params['scope'],
                            'redirect_uri': params['redirect_uri'], 'origin_jti': secrets.token_hex(8)}
        return {'code': code, 'state': params['state']}

    def access_token(self, grant: dict, **overrides: Any) -> str:
        now = int(time.time())
        claims = {'sub': self.subs[grant['username']], 'username': grant['username'], 'client_id': grant['client_id'],
                  'token_use': 'access', 'iss': 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e',
                  'iat': now, 'exp': now + 3600, 'origin_jti': grant['origin_jti'], 'scope': grant['scope'],
                  'jti': secrets.token_hex(8)}
        claims.update(overrides)
        return sign(claims)

    def post(self, url: str, data: dict, **_kwargs: Any) -> FakeResponse:
        path = urlsplit(url).path
        _expect(url.startswith(COGNITO_DOMAIN), url)
        if path == '/oauth2/revoke':
            self.revoked.append(data['token'])
            return FakeResponse(200, {})
        self.token_calls.append(dict(data))
        if data['grant_type'] == 'authorization_code':
            grant = self.codes.pop(data['code'], None)
            if grant is None or grant['redirect_uri'] != data['redirect_uri'] or grant['client_id'] != data['client_id']:
                return FakeResponse(400, {'error': 'invalid_grant'})
        else:
            grant = self.refresh.get(data['refresh_token'])
            if grant is None or data['refresh_token'] in self.revoked:
                return FakeResponse(400, {'error': 'invalid_grant'})
        refresh_token = data.get('refresh_token') or secrets.token_urlsafe(24)
        self.refresh[refresh_token] = grant
        return FakeResponse(200, {'access_token': self.access_token(grant), 'id_token': 'id', 'token_type': 'Bearer',
                                  'expires_in': 3600, 'refresh_token': refresh_token})


@dataclass
class Reply:
    status: int
    headers: dict
    body: Any


def anonymous(method: str, path: str, *, query: dict | None = None, form: dict | None = None,
              json_body: dict | None = None) -> dict:
    headers = {'Content-Type': 'application/x-www-form-urlencoded' if form is not None else 'application/json'}
    body = urlencode(form) if form is not None else json.dumps(json_body) if json_body is not None else None
    return {
        'httpMethod': method, 'path': path, 'resource': path, 'headers': headers, 'multiValueHeaders': {},
        'queryStringParameters': query, 'multiValueQueryStringParameters': {k: [v] for k, v in (query or {}).items()},
        'pathParameters': None, 'stageVariables': None, 'body': body, 'isBase64Encoded': False,
        'requestContext': {'requestId': 'anon', 'stage': 'v1', 'httpMethod': method, 'path': path,
                           'identity': {'sourceIp': '1.2.3.4'}},
    }


@dataclass
class SignIn:
    access_token: str
    refresh_token: str
    client_id: str
    tokens: dict


@dataclass
class OAuthWorld:
    world: World
    cognito: FakeCognito

    def call(self, event: dict) -> Reply:
        raw = mcp_tokens_handler.lambda_handler(event, self.world.context)
        headers = {**{k: v[-1] for k, v in (raw.get('multiValueHeaders') or {}).items() if v}, **(raw.get('headers') or {})}
        body: Any = raw.get('body') or ''
        if 'json' in str(headers.get('Content-Type', '')) and body:
            body = json.loads(body)
        return Reply(raw['statusCode'], headers, body)

    def consent_api(self, username: str, method: str, path: str, *, body: dict | None = None,
                    query: dict | None = None) -> tuple[int, dict]:
        event = rest_event(method, path, claims=self.world.claims(username), body=body)
        event['queryStringParameters'] = query
        response = mcp_tokens_handler.lambda_handler(event, self.world.context)
        return response['statusCode'], json.loads(response['body'])

    def register(self, kind: str = 'kiro', port: int = 51234, **extra: Any) -> Reply:
        body = {'redirect_uris': [LOOPBACK[kind].format(port=port)], 'client_name': extra.pop('client_name', kind),
                'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token'],
                'response_types': ['code'], **extra}
        return self.call(anonymous('POST', '/oauth/register', json_body=body))

    def authorize_query(self, client_id: str, redirect_uri: str, *, scope: str | None = None,
                        state: str = 'client-state', **extra: str) -> dict:
        query = {'response_type': 'code', 'client_id': client_id, 'redirect_uri': redirect_uri, 'state': state,
                 'code_challenge': CHALLENGE, 'code_challenge_method': 'S256', **extra}
        if scope is not None:
            query['scope'] = scope
        return query

    def consent(self, username: str, query: dict, scope: str = 'write', project_id: str | None = None) -> tuple[int, dict]:
        body: dict[str, Any] = {'authorize_query': urlencode(query), 'scope': scope}
        if project_id:
            body['project_id'] = project_id
        return self.consent_api(username, 'POST', '/connect/oauth/consent', body=body)

    def exchange(self, form: dict) -> Reply:
        return self.call(anonymous('POST', '/oauth/token', form=form))

    def sign_in(self, username: str, *, kind: str = 'kiro', scope: str = 'write', port: int = 51234,
                cognito_user: str | None = None, project_id: str | None = None) -> SignIn:
        registered = self.register(kind, port)
        _expect(registered.status == 201, registered.body)
        client_id, redirect_uri = registered.body['client_id'], registered.body['redirect_uris'][0]
        query = self.authorize_query(client_id, redirect_uri, scope=f'openid {RESOURCE}/read {RESOURCE}/write')
        authorized = self.call(anonymous('GET', '/oauth/authorize', query=query))
        _expect(authorized.status == 302, authorized.body)
        _expect(authorized.headers['Location'].startswith(f'{FRONTEND}/oauth/authorize?'))
        status, approved = self.consent(username, query, scope, project_id)
        _expect(status == 200, approved)
        delivered = self.cognito.sign_in(approved['redirect_to'], cognito_user or username)
        relayed = self.call(anonymous('GET', '/oauth/callback', query=delivered))
        _expect(relayed.status == 302, relayed.body)
        location = urlsplit(relayed.headers['Location'])
        _expect(f'{location.scheme}://{location.netloc}{location.path}' == redirect_uri)
        back = {k: v[0] for k, v in parse_qs(location.query).items()}
        _expect(back['state'] == 'client-state')
        answer = self.exchange({'grant_type': 'authorization_code', 'client_id': client_id, 'code': back['code'],
                                'redirect_uri': redirect_uri, 'code_verifier': 'v' * 43})
        _expect(answer.status == 200, answer.body)
        return SignIn(answer.body['access_token'], answer.body['refresh_token'], client_id, answer.body)

    def refresh(self, signed_in: SignIn) -> Reply:
        return self.exchange({'grant_type': 'refresh_token', 'client_id': signed_in.client_id,
                              'refresh_token': signed_in.refresh_token})


@contextmanager
def oauth_world(lambda_context: Any) -> Generator[OAuthWorld, None, None]:
    with global_mcp_world(lambda_context) as world, ExitStack() as stack:
        stack.enter_context(oauth_env())
        # The OAuth routers read the tables themselves: point them at the world's moto tables too.
        for module in (mcp_oauth_routes, mcp_oauth_consent_routes):
            stack.enter_context(patch.object(module, 'get_projects_table', return_value=world.projects))
            stack.enter_context(patch.object(module, 'get_jobs_table', return_value=world.jobs))
        cognito = FakeCognito(world.subs)
        stack.enter_context(patch('shared.mcp_oauth_exchange.requests.post', cognito.post))
        stack.enter_context(patch('shared.mcp_oauth_jwt._default_cache', jwks_cache()))
        yield OAuthWorld(world, cognito)


__all__ = ['CLIENTS', 'OAuthWorld', 'anonymous', 'oauth_world']
