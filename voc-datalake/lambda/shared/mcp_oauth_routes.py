"""The ANONYMOUS OAuth routes of the global MCP server, included by ``voc-mcp-tokens-api``.

Each is deliberately unauthenticated (an MCP client has no credential yet) and wired one by one in
``lib/stacks/api-mcp-oauth.ts`` (``INTENTIONALLY_PUBLIC_OAUTH_ROUTES`` pins the list), throttled there:

| Route | What it does |
|---|---|
| ``GET /.well-known/oauth-protected-resource[/mcp/global]`` | RFC 9728 metadata of ``/mcp/global`` |
| ``GET /.well-known/oauth-authorization-server``, ``/.well-known/openid-configuration`` | RFC 8414 metadata of this facade |
| ``POST /oauth/register`` | DCR facade: answers a PRE-registered client, stores nothing (``mcp_oauth_register``) |
| ``GET /oauth/authorize`` | 302 to the SPA's consent page with the query unchanged (after checking client + redirect) |
| ``GET /oauth/callback`` | The loopback relay: consumes its single-use row, 302 to the client's loopback URI |
| ``POST /oauth/token``, ``POST /oauth/revoke`` | Forward to Cognito; record / check the grant's chain (``mcp_oauth_exchange``) |

Every answer is ``Cache-Control: no-store``. Bodies are capped (8 KB register, 16 KB forms). With OAuth
not configured (``oauth_config() is None``) every route is a 404. Nothing logs a code, state, verifier
or token.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final
from urllib.parse import parse_qs, urlencode

from aws_lambda_powertools.event_handler import Response
from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import mcp_oauth_relay as relay
from shared import mcp_oauth_store as store
from shared.logging import logger
from shared.mcp_oauth_authorize import AuthorizeRefused, UntrustedRedirect, parse_authorize_query, with_query
from shared.mcp_oauth_config import CONSENT_PAGE_PATH, OAuthConfig, oauth_config
from shared.mcp_oauth_discovery import authorization_server_metadata, protected_resource_metadata
from shared.mcp_oauth_exchange import CognitoUnavailable, Exchange, FacadeAnswer, GrantStore, oauth_error
from shared.mcp_oauth_register import RegistrationRefused, public_metadata, register
from shared.tables import configured_table, get_jobs_table, get_projects_table

app = Router()

MAX_REGISTER_BYTES: Final = 8 * 1024
MAX_FORM_BYTES: Final = 16 * 1024
_NO_STORE: Final = {'Cache-Control': 'no-store', 'Pragma': 'no-cache'}
# Errors Cognito may send to the relay that are passed on to the client.
_RELAYED_ERRORS: Final = frozenset({'access_denied', 'invalid_request', 'invalid_scope', 'server_error',
                                    'temporarily_unavailable', 'unauthorized_client', 'unsupported_response_type'})
EXPIRED_SIGN_IN: Final = ('This sign-in link expired or was already used. '
                          'Start the sign-in again from your assistant.')


def _now() -> datetime:
    return datetime.now(UTC)


def json_answer(status: int, body: Mapping[str, Any]) -> Response:
    return Response(status_code=status, content_type='application/json', body=json.dumps(body), headers=_NO_STORE)


def _text(status: int, message: str) -> Response:
    return Response(status_code=status, content_type='text/plain; charset=utf-8', body=message, headers=_NO_STORE)


def _redirect(location: str) -> Response:
    return Response(status_code=302, content_type='text/plain', body='', headers={**_NO_STORE, 'Location': location})


def _not_found() -> Response:
    return json_answer(404, {'error': 'not_found'})


def _raw_body(limit: int) -> bytes | None:
    event = app.current_event
    raw = event.body or ''
    try:
        data = base64.b64decode(raw, validate=True) if event.is_base64_encoded else raw.encode()
    except (binascii.Error, ValueError):
        return None
    return data if len(data) <= limit else None


def _form() -> dict[str, str] | None:
    """The urlencoded form body, each field once, or None (malformed, repeated or too large)."""
    content_type = app.current_event.headers.get('Content-Type') or ''  # case-insensitive
    if not content_type.lower().startswith('application/x-www-form-urlencoded'):
        return None
    data = _raw_body(MAX_FORM_BYTES)
    if data is None:
        return None
    try:
        parsed = parse_qs(data.decode(), keep_blank_values=True, strict_parsing=bool(data), max_num_fields=32)
    except (UnicodeDecodeError, ValueError):
        return None
    if any(len(values) != 1 for values in parsed.values()):
        return None
    return {key: values[0] for key, values in parsed.items()}


# ── Discovery ───────────────────────────────────────────────────────────────
def _metadata(build: Callable[[OAuthConfig], dict[str, Any]]) -> Response:
    config = oauth_config()
    return _not_found() if config is None else json_answer(200, build(config))


@app.get('/.well-known/oauth-protected-resource')
def protected_resource():
    return _metadata(protected_resource_metadata)


@app.get('/.well-known/oauth-protected-resource/mcp/global')
def protected_resource_of_mcp():
    return _metadata(protected_resource_metadata)


@app.get('/.well-known/oauth-authorization-server')
def authorization_server():
    return _metadata(authorization_server_metadata)


@app.get('/.well-known/openid-configuration')
def openid_configuration():
    return _metadata(authorization_server_metadata)


# ── Registration ────────────────────────────────────────────────────────────
@app.post('/oauth/register')
def register_client():
    config = oauth_config()
    if config is None:
        return _not_found()
    data = _raw_body(MAX_REGISTER_BYTES)
    try:
        body = json.loads(data) if data else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        body = None
    if not isinstance(body, dict):
        return json_answer(400, {'error': 'invalid_client_metadata', 'error_description': 'a JSON object is required'})
    try:
        registration = register(body, config)
    except RegistrationRefused as refused:
        logger.info('MCP OAuth registration refused', extra={'error': refused.error, **public_metadata(body)})
        return json_answer(400, {'error': refused.error, 'error_description': refused.description})
    logger.info('MCP OAuth registration answered', extra={'client_kind': registration.kind})
    return json_answer(201, registration.response(config))


# ── Authorization ───────────────────────────────────────────────────────────
def _raw_query() -> str:
    """The request's query string as the client sent it (multi-value form, so repeats stay visible)."""
    multi = app.current_event.multi_value_query_string_parameters or {}
    # Every value kept: parse_authorize_query refuses a repeated parameter.
    return urlencode([(key, value) for key, values in multi.items() for value in values])


@app.get('/oauth/authorize')
def authorize():
    config = oauth_config()
    if config is None:
        return _not_found()
    query = _raw_query()
    try:
        request = parse_authorize_query(query, config)
    except UntrustedRedirect as exc:
        return _text(400, f'Sign-in refused: {exc}.')
    except AuthorizeRefused as refused:
        return _redirect(refused.error_redirect())
    logger.info('MCP OAuth authorize', extra={'client_kind': request.kind})
    return _redirect(f'{config.frontend_url}{CONSENT_PAGE_PATH}?{query}')


@app.get('/oauth/callback')
def relay_callback():
    config = oauth_config()
    if config is None:
        return _not_found()
    params = app.current_event.query_string_parameters or {}
    now = _now()
    delivery = relay.consume_relay(_jobs(), params.get('state') or '', now)
    if delivery is None:
        return _text(400, EXPIRED_SIGN_IN)
    error = params.get('error')
    if error is not None:
        relayed = error if error in _RELAYED_ERRORS else 'server_error'
        return _redirect(with_query(delivery.redirect_uri, {'error': relayed, 'state': delivery.state}))
    code = params.get('code') or ''
    if not code or len(code) > relay.MAX_CODE_LENGTH:
        return _text(400, EXPIRED_SIGN_IN)
    relay.store_code_binding(_jobs(), code, delivery, now)
    return _redirect(with_query(delivery.redirect_uri, {'code': code, 'state': delivery.state}))


# ── Token + revocation ──────────────────────────────────────────────────────
def _jobs() -> Any:
    return configured_table(get_jobs_table(), 'Jobs')


def _exchange(config: OAuthConfig) -> Exchange:
    projects = configured_table(get_projects_table(), 'Projects')
    grant_store = GrantStore(load=lambda token_id: store.load_grant(projects, token_id),
                             record_chain=lambda row, jti: store.record_chain(projects, row, jti))
    return Exchange(config=config, jobs_table=_jobs(), store=grant_store, now=_now())


def _facade(operation: str) -> Response:
    config = oauth_config()
    if config is None:
        return _not_found()
    form = _form()
    if form is None:
        answer: FacadeAnswer = oauth_error('invalid_request', 'a urlencoded form body (at most 16 KB) is required')
    else:
        exchange = _exchange(config)
        try:
            answer = exchange.token(form) if operation == 'token' else exchange.revoke(form)
        except CognitoUnavailable as exc:
            logger.warning('Cognito token endpoint unavailable', extra={'error_type': str(exc)})
            answer = oauth_error('temporarily_unavailable', 'the sign-in service is unavailable, try again', 503)
    if answer.status != 200:
        logger.info('MCP OAuth facade refused', extra={'operation': operation, 'error': answer.body.get('error')})
    return json_answer(answer.status, answer.body)


@app.post('/oauth/token')
def token():
    return _facade('token')


@app.post('/oauth/revoke')
def revoke():
    return _facade('revoke')
