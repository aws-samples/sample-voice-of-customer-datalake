"""The MCP OAuth authorization request, as ``GET /oauth/authorize`` and the consent API read it.

``parse_authorize_query`` validates the raw query string ONCE, the same way in both places, and answers
an :class:`AuthorizeRequest` or raises:

* :class:`UntrustedRedirect` — the ``client_id`` is not an MCP client or the ``redirect_uri`` is not one
  that client may use. Nothing may be redirected then (RFC 6749 §4.1.2.1): a plain 400.
* :class:`AuthorizeRefused` — any other fault (response type, PKCE, scope, ``resource``). The client is
  known and its redirect is trusted, so the error goes back to it (``error_redirect``).

PKCE is REQUIRED (S256 only). ``resource`` (RFC 8707), when sent, must name the MCP URL; whether it is
passed on to Cognito is the deployment's choice (``forward_resource``). The scope Cognito sees is the one
the person CONSENTED to (``cognito_authorize_url``), never more than the client asked for.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final
from urllib.parse import parse_qs, urlencode

from shared.mcp_oauth_config import CLIENT_DISPLAY_NAMES, LOOPBACK_PATHS, OAuthConfig, canonical_url
from shared.mcp_oauth_loopback import loopback_path
from shared.mcp_oauth_register import redirect_allowed

MAX_QUERY_LENGTH: Final = 4096
MAX_STATE_LENGTH: Final = 1024
_PKCE_CHALLENGE: Final = re.compile(r'^[A-Za-z0-9._~-]{43,128}\Z')
_OIDC_SCOPES: Final = frozenset({'openid', 'profile', 'email'})


class UntrustedRedirect(Exception):
    """Unknown client or redirect: answer 400 without redirecting."""


class AuthorizeRefused(Exception):
    """A refusal the client hears at its (trusted) redirect URI."""

    def __init__(self, error: str, description: str, request_state: str | None, redirect_uri: str):
        super().__init__(description)
        self.error = error
        self.description = description
        self.state = request_state
        self.redirect_uri = redirect_uri

    def error_redirect(self) -> str:
        return with_query(self.redirect_uri, {'error': self.error, 'error_description': self.description,
                                              'state': self.state})


@dataclass(frozen=True)
class AuthorizeRequest:
    client_id: str
    kind: str
    redirect_uri: str
    state: str | None
    code_challenge: str
    wants_write: bool
    resource: str | None

    @property
    def client_name(self) -> str:
        return CLIENT_DISPLAY_NAMES[self.kind]

    @property
    def uses_relay(self) -> bool:
        """A loopback redirect goes through the relay (Cognito matches callbacks exactly)."""
        return self.kind in LOOPBACK_PATHS and loopback_path(self.redirect_uri) is not None

    def deny_redirect(self) -> str:
        return with_query(self.redirect_uri, {'error': 'access_denied',
                                              'error_description': 'The connection was not approved',
                                              'state': self.state})


def with_query(base: str, params: dict[str, str | None]) -> str:
    """``base`` (a validated redirect URI without a query) with ``params`` appended; None values dropped."""
    query = urlencode({k: v for k, v in params.items() if v is not None})
    return f'{base}?{query}' if query else base


def _single_params(raw: object) -> dict[str, str]:
    if not isinstance(raw, str) or len(raw) > MAX_QUERY_LENGTH:
        raise UntrustedRedirect('the authorization request is missing or too long')
    try:
        parsed = parse_qs(raw, keep_blank_values=True, strict_parsing=bool(raw), max_num_fields=32)
    except ValueError as exc:
        raise UntrustedRedirect('the authorization request is malformed') from exc
    if any(len(values) != 1 for values in parsed.values()):
        raise UntrustedRedirect('a parameter of the authorization request is repeated')
    return {key: values[0] for key, values in parsed.items()}


def _wants_write(scope: str | None, config: OAuthConfig, refuse: Callable[[str, str], AuthorizeRefused]) -> bool:
    """Whether the client asked for write. No scope at all = the person decides on the consent screen."""
    if scope is None or not scope.strip():
        return True
    requested = set(scope.split())
    known = _OIDC_SCOPES | set(config.scopes_supported)
    if not requested <= known:
        raise refuse('invalid_scope', 'unknown scope requested')
    return config.scope('write') in requested or not requested & set(config.scopes_supported)


def parse_authorize_query(raw: object, config: OAuthConfig) -> AuthorizeRequest:
    params = _single_params(raw)
    client_id = params.get('client_id', '')
    kind = config.kind_of(client_id)
    redirect_uri = params.get('redirect_uri', '')
    if kind is None or not redirect_allowed(kind, redirect_uri, config):
        raise UntrustedRedirect('unknown client or redirect URI')
    state = params.get('state')
    if state is not None and len(state) > MAX_STATE_LENGTH:
        state = None  # never echo an oversized value back

    def refuse(error: str, description: str) -> AuthorizeRefused:
        return AuthorizeRefused(error, description, state, redirect_uri)

    if params.get('response_type') != 'code':
        raise refuse('unsupported_response_type', 'only response_type=code is supported')
    challenge = params.get('code_challenge', '')
    if params.get('code_challenge_method') != 'S256' or not _PKCE_CHALLENGE.fullmatch(challenge):
        raise refuse('invalid_request', 'PKCE with code_challenge_method=S256 is required')
    resource = params.get('resource')
    if resource is not None and canonical_url(resource) != config.resource:
        raise refuse('invalid_target', 'resource must be this MCP server')
    return AuthorizeRequest(client_id=client_id, kind=kind, redirect_uri=redirect_uri, state=state,
                            code_challenge=challenge, wants_write=_wants_write(params.get('scope'), config, refuse),
                            resource=config.resource if resource is not None else None)


def cognito_authorize_url(request: AuthorizeRequest, config: OAuthConfig, *, consented_scope: str,
                          relay_id: str | None) -> str:
    """Cognito's ``/oauth2/authorize`` for this request, carrying exactly the consented scopes.

    With a relay the redirect is the relay URL and ``state`` is the relay id (the client's own state is
    stored with the relay row); without one both pass through unchanged.
    """
    scopes = ['openid', config.scope('read')]
    if consented_scope == 'write':
        scopes.append(config.scope('write'))
    params: dict[str, str | None] = {
        'response_type': 'code',
        'client_id': request.client_id,
        'redirect_uri': config.relay_url if relay_id else request.redirect_uri,
        'state': relay_id or request.state,
        'scope': ' '.join(scopes),
        'code_challenge': request.code_challenge,
        'code_challenge_method': 'S256',
        'resource': request.resource if config.forward_resource else None,
    }
    return with_query(f'{config.cognito_domain}/oauth2/authorize', params)
