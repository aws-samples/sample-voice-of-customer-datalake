"""The dynamic-client-registration FACADE of the MCP OAuth server (``POST /oauth/register``, RFC 7591).

Cognito has no DCR, and MCP clients register before they sign in. This facade stores NOTHING: it answers
the PRE-REGISTERED public PKCE client (VocApiStack, one per client kind) that the request's redirect URIs
select, so registration can never mint a client, a secret or a callback.

* Loopback URIs (``shared.mcp_oauth_loopback``) must all share one path: ``/oauth/callback`` is Kiro,
  ``/callback`` is Cursor when ``client_name`` names it, else Claude Code. Any other path is refused.
* A non-loopback URI is kept only when it is EXACTLY one of the deployment's configured callbacks for the
  chosen kind (Cursor's web callback, the web assistants' list); any other is DROPPED, not refused — Cursor
  registers its loopback and its web callback together.
* Refused: a confidential client (``token_endpoint_auth_method`` other than ``none``), grant or response
  types beyond code + refresh, no usable URI, a kind this deployment has no client for.

Refusals are logged with the request's PUBLIC metadata (client name, redirect URIs), never more.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.mcp_oauth_config import (
    CLIENT_DISPLAY_NAMES,
    KIND_CLAUDE_CODE,
    KIND_CURSOR,
    KIND_KIRO,
    KIND_WEB,
    LOOPBACK_PATHS,
    OAuthConfig,
)
from shared.mcp_oauth_loopback import loopback_path

MAX_REDIRECT_URIS: Final = 10
GRANT_TYPES: Final = ('authorization_code', 'refresh_token')
RESPONSE_TYPES: Final = ('code',)
_PATH_KINDS: Final = {LOOPBACK_PATHS[KIND_KIRO]: KIND_KIRO, LOOPBACK_PATHS[KIND_CLAUDE_CODE]: KIND_CLAUDE_CODE}


class RegistrationRefused(Exception):
    """A 400 with an RFC 7591 error code."""

    def __init__(self, error: str, description: str):
        super().__init__(description)
        self.error = error
        self.description = description


@dataclass(frozen=True)
class Registration:
    kind: str
    client_id: str
    redirect_uris: tuple[str, ...]

    def response(self, config: OAuthConfig) -> dict[str, Any]:
        return {
            'client_id': self.client_id,
            'client_id_issued_at': 0,
            'client_name': CLIENT_DISPLAY_NAMES[self.kind],
            'redirect_uris': list(self.redirect_uris),
            'grant_types': list(GRANT_TYPES),
            'response_types': list(RESPONSE_TYPES),
            'token_endpoint_auth_method': 'none',
            'scope': ' '.join(['openid', *config.scopes_supported]),
        }


def _check_client_type(body: Mapping[str, Any]) -> None:
    method = body.get('token_endpoint_auth_method', 'none')
    if method != 'none':
        raise RegistrationRefused('invalid_client_metadata', 'only public clients (PKCE, no secret) are supported')
    for field, allowed in (('grant_types', GRANT_TYPES), ('response_types', RESPONSE_TYPES)):
        value = body.get(field, list(allowed[:1]))
        if not isinstance(value, list) or not value or any(item not in allowed for item in value):
            raise RegistrationRefused('invalid_client_metadata', f'{field} must be a subset of {", ".join(allowed)}')


def _redirect_uris(body: Mapping[str, Any]) -> list[str]:
    uris = body.get('redirect_uris')
    if not isinstance(uris, list) or not uris or len(uris) > MAX_REDIRECT_URIS:
        raise RegistrationRefused('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs')
    if not all(isinstance(uri, str) for uri in uris):
        raise RegistrationRefused('invalid_redirect_uri', 'redirect_uris must be strings')
    return uris


def _loopback_kind(paths: set[str], client_name: object) -> str | None:
    if not paths:
        return None
    if len(paths) > 1:
        raise RegistrationRefused('invalid_redirect_uri', 'loopback redirect URIs must share one path')
    kind = _PATH_KINDS.get(next(iter(paths)))
    if kind is None:
        raise RegistrationRefused('invalid_redirect_uri', 'unsupported loopback callback path')
    if kind == KIND_CLAUDE_CODE and isinstance(client_name, str) and 'cursor' in client_name.lower():
        return KIND_CURSOR
    return kind


def _web_callbacks(kind: str | None, config: OAuthConfig) -> tuple[str, ...]:
    if kind == KIND_CURSOR:
        return config.cursor_callbacks
    if kind == KIND_WEB:
        return config.web_callbacks
    return ()


def _kind_for_web_uris(web: list[str], config: OAuthConfig) -> str | None:
    if any(uri in config.cursor_callbacks for uri in web):
        return KIND_CURSOR
    if any(uri in config.web_callbacks for uri in web):
        return KIND_WEB
    return None


def register(body: Mapping[str, Any], config: OAuthConfig) -> Registration:
    """The pre-registered client this request selects; raises RegistrationRefused."""
    _check_client_type(body)
    uris = _redirect_uris(body)
    loopback = [uri for uri in uris if loopback_path(uri) is not None]
    web = [uri for uri in uris if uri not in loopback]
    kind = _loopback_kind({loopback_path(uri) or '' for uri in loopback}, body.get('client_name'))
    if kind is None:
        kind = _kind_for_web_uris(web, config)
    known_web = _web_callbacks(kind, config)
    kept = (*loopback, *[uri for uri in web if uri in known_web])
    client_id = config.clients.get(kind) if kind else None
    if not kept or kind is None or client_id is None:
        raise RegistrationRefused('invalid_redirect_uri', 'no redirect URI this server accepts')
    return Registration(kind=kind, client_id=client_id, redirect_uris=kept)


def redirect_allowed(kind: str, redirect_uri: object, config: OAuthConfig) -> bool:
    """Whether ``redirect_uri`` may receive an authorization response for a client of ``kind``."""
    if kind in LOOPBACK_PATHS and loopback_path(redirect_uri) == LOOPBACK_PATHS[kind]:
        return True
    return isinstance(redirect_uri, str) and redirect_uri in _web_callbacks(kind, config)


def public_metadata(body: Mapping[str, Any]) -> dict[str, Any]:
    """What a refused registration is logged with: the client's name and URIs, truncated."""
    uris = body.get('redirect_uris')
    name = body.get('client_name')
    return {
        'client_name': name[:80] if isinstance(name, str) else None,
        'redirect_uris': [uri[:200] for uri in uris[:MAX_REDIRECT_URIS] if isinstance(uri, str)]
        if isinstance(uris, list) else None,
    }
