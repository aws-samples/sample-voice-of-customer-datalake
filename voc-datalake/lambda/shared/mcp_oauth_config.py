"""OAuth sign-in for the global MCP server: the deployment's fixed facts (docs/mcp.md → "OAuth sign-in").

Everything here comes from the Lambda environment, which VocApiStack writes (``lib/stacks/api-mcp-oauth.ts``),
and nothing from a request. ``oauth_config()`` answers ``None`` when any required value is missing or
malformed, and every caller treats ``None`` as "OAuth is off": the discovery documents and the facade
routes answer 404 and a JWT presented to ``/mcp/global`` is refused. Fail closed, never half-configured.

* ``MCP_RESOURCE_URL`` — the exact MCP URL (``<api url>mcp/global``, canonical, no trailing slash). It
  is the Cognito resource server's identifier, so every custom scope is ``<MCP_RESOURCE_URL>/<scope>``.
* ``MCP_OAUTH_ISSUER`` — the API base without its trailing slash (``…/v1``): the authorization server
  this API's facade presents (Cognito's own discovery lacks ``code_challenge_methods_supported``).
* ``MCP_OAUTH_CLIENTS`` — JSON ``{kind: client_id}`` of the public PKCE app clients, one per client kind.
* ``MCP_OAUTH_CURSOR_CALLBACKS`` / ``MCP_OAUTH_WEB_CALLBACKS`` — JSON lists of the exact non-loopback
  callbacks those clients may use (CDK context; the web ones are untested until signed in live).
* ``COGNITO_DOMAIN_URL`` (hosted UI, ``/oauth2/*``) and ``COGNITO_ISSUER`` (``iss`` and the JWKS).
* ``FRONTEND_URL`` — the SPA origin hosting the consent page.
* ``MCP_OAUTH_FORWARD_RESOURCE`` — ``true`` passes a client's ``resource`` (RFC 8707) on to Cognito.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Final
from urllib.parse import urlsplit, urlunsplit

KIND_KIRO: Final = 'kiro'
KIND_CLAUDE_CODE: Final = 'claude-code'
KIND_CURSOR: Final = 'cursor'
KIND_WEB: Final = 'web'
CLIENT_KINDS: Final[tuple[str, ...]] = (KIND_KIRO, KIND_CLAUDE_CODE, KIND_CURSOR, KIND_WEB)

# What the consent page and the grants list call each client (never shown to the model).
CLIENT_DISPLAY_NAMES: Final = {
    KIND_KIRO: 'Kiro',
    KIND_CLAUDE_CODE: 'Claude Code',
    KIND_CURSOR: 'Cursor',
    KIND_WEB: 'Web assistant',
}

# The loopback callback path each desktop client registers (RFC 8252 §7.3: any port, this path).
LOOPBACK_PATHS: Final = {
    KIND_KIRO: '/oauth/callback',
    KIND_CLAUDE_CODE: '/callback',
    KIND_CURSOR: '/callback',
}

SCOPE_NAMES: Final[tuple[str, ...]] = ('read', 'write')

# The facade's own paths, relative to the issuer (= the API base).
AUTHORIZE_PATH: Final = '/oauth/authorize'
EXCHANGE_PATH: Final = '/oauth/token'  # the token endpoint
REVOKE_PATH: Final = '/oauth/revoke'
REGISTER_PATH: Final = '/oauth/register'
CALLBACK_PATH: Final = '/oauth/callback'
# The SPA's consent page.
CONSENT_PAGE_PATH: Final = '/oauth/authorize'


def canonical_url(url: object) -> str | None:
    """``url`` with a lower-case scheme and host, no query or fragment and no trailing slash, or None.

    Only ``https``: the MCP resource and every audience compared against it are public HTTPS URLs.
    """
    if not isinstance(url, str) or not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme.lower() != 'https' or not parts.hostname or parts.username or parts.password:
        return None
    netloc = parts.hostname.lower() + (f':{parts.port}' if parts.port not in (None, 443) else '')
    return urlunsplit(('https', netloc, parts.path.rstrip('/'), '', ''))


@dataclass(frozen=True)
class OAuthConfig:
    resource: str
    issuer: str
    clients: dict[str, str]
    cursor_callbacks: tuple[str, ...]
    web_callbacks: tuple[str, ...]
    cognito_domain: str
    cognito_issuer: str
    frontend_url: str
    forward_resource: bool

    @property
    def client_ids(self) -> frozenset[str]:
        return frozenset(self.clients.values())

    def kind_of(self, client_id: object) -> str | None:
        """The client kind ``client_id`` belongs to, or None for any other client (the web app's too)."""
        for kind, known in self.clients.items():
            if client_id == known:
                return kind
        return None

    def scope(self, name: str) -> str:
        """The URL-prefixed custom scope (``<resource>/<name>``)."""
        return f'{self.resource}/{name}'

    @property
    def scopes_supported(self) -> list[str]:
        return [self.scope(name) for name in SCOPE_NAMES]

    @property
    def relay_url(self) -> str:
        return f'{self.issuer}{CALLBACK_PATH}'

    @property
    def jwks_uri(self) -> str:
        return f'{self.cognito_issuer}/.well-known/jwks.json'


def _string_list(raw: str | None) -> tuple[str, ...] | None:
    if raw is None or raw == '':
        return ()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        return None
    return tuple(value)


def _clients(raw: str | None) -> dict[str, str] | None:
    try:
        value = json.loads(raw or '')
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict) or not value:
        return None
    clients = {k: v for k, v in value.items() if k in CLIENT_KINDS and isinstance(v, str) and v}
    # Two kinds sharing one id would make the registration answer ambiguous.
    if len(clients) != len(value) or len(set(clients.values())) != len(clients):
        return None
    return clients


def _load(env: dict[str, str]) -> OAuthConfig | None:
    resource = canonical_url(env.get('MCP_RESOURCE_URL'))
    issuer = canonical_url(env.get('MCP_OAUTH_ISSUER'))
    cognito_domain = canonical_url(env.get('COGNITO_DOMAIN_URL'))
    cognito_issuer = canonical_url(env.get('COGNITO_ISSUER'))
    frontend_url = canonical_url(env.get('FRONTEND_URL'))
    clients = _clients(env.get('MCP_OAUTH_CLIENTS'))
    cursor_callbacks = _string_list(env.get('MCP_OAUTH_CURSOR_CALLBACKS'))
    web_callbacks = _string_list(env.get('MCP_OAUTH_WEB_CALLBACKS'))
    if (resource is None or issuer is None or cognito_domain is None or cognito_issuer is None
            or frontend_url is None or clients is None or cursor_callbacks is None or web_callbacks is None):
        return None
    if resource != f'{issuer}/mcp/global':
        return None
    return OAuthConfig(
        resource=resource, issuer=issuer, clients=clients, cursor_callbacks=cursor_callbacks,
        web_callbacks=web_callbacks, cognito_domain=cognito_domain, cognito_issuer=cognito_issuer,
        frontend_url=frontend_url, forward_resource=env.get('MCP_OAUTH_FORWARD_RESOURCE') == 'true',
    )


@lru_cache(maxsize=1)
def _cached(snapshot: tuple[tuple[str, str], ...]) -> OAuthConfig | None:
    return _load(dict(snapshot))


_ENV_KEYS: Final = ('MCP_RESOURCE_URL', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_CLIENTS', 'MCP_OAUTH_CURSOR_CALLBACKS',
                    'MCP_OAUTH_WEB_CALLBACKS', 'COGNITO_DOMAIN_URL', 'COGNITO_ISSUER', 'FRONTEND_URL',
                    'MCP_OAUTH_FORWARD_RESOURCE')


def oauth_config() -> OAuthConfig | None:
    """The deployment's OAuth facts, or None when OAuth is not (fully) configured."""
    return _cached(tuple((key, os.environ.get(key, '')) for key in _ENV_KEYS))


def token_minting_enabled() -> bool:
    """``-c mcpTokenMinting=false`` turns minting of ``voc_tok_`` tokens off; anything else keeps it on.

    Existing tokens are unaffected (they stay valid until revoked or expired).
    """
    return os.environ.get('MCP_TOKEN_MINTING') != 'false'
