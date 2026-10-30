"""The OAuth half of the ``/mcp/global`` credential check (docs/mcp.md → "OAuth sign-in").

``mcp_global_handler._authenticate`` (also the API Gateway TOKEN authorizer) hands a bearer value that
looks like a JWT here; a ``voc_tok_`` token keeps its own path in the handler, unchanged. The answer is
the same thing the token path answers: a usable credential ROW (the grant, with its scope narrowed to the
token's) or None (a 401), and :class:`CredentialBackendUnavailable` for a store, directory or JWKS fault
(a 500 — never a 401 that would send a client back through sign-in).

Accepted only when ALL hold: the JWT verifies (``shared.mcp_oauth_jwt``: RS256, pool issuer, access
token, an MCP client, unexpired, audience when present); the grant for (sub, client_id) exists, is a
grant, belongs to that sub and client, is neither revoked nor expired; the token's ``origin_jti`` is one
of the grant's recorded chains; the token carries an MCP scope; and the signed-in user is still current
in Cognito (``minter_current``: exists, enabled, same sub) — the very check a token's minter gets.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, TypeGuard

from aws_lambda_powertools import Logger

from shared import mcp_global_tokens as gt
from shared import mcp_oauth_grants as grants
from shared.mcp_oauth_config import oauth_config
from shared.mcp_oauth_jwt import InvalidToken, JwksCache, JwksUnavailable, verify_access_token

logger = Logger(child=True)


class CredentialBackendUnavailable(Exception):
    """The credential could not be checked (store, directory or key fault): a 500, not a 401."""


def looks_like_jwt(credential: str) -> bool:
    """A compact JWS (``eyJ…`` header, three segments): the only shape routed to the OAuth check."""
    return credential.startswith('eyJ') and credential.count('.') == 2


def _usable_grant(row: dict | None, *, sub: str, client_id: str, origin_jti: str,
                  now: datetime) -> TypeGuard[dict]:
    if row is None or not grants.is_grant(row):
        return False
    if row.get('created_by') != sub or row.get('client_id') != client_id:
        return False
    if gt.token_status(row, now) != gt.STATUS_ACTIVE:
        return False
    return origin_jti in grants.chains(row)


def authenticate_oauth(credential: str, *, load_row: Callable[[str], dict | None],
                       minter_current: Callable[[Mapping[str, Any]], bool], now: datetime,
                       cache: JwksCache | None = None) -> dict | None:
    """The effective grant row for an MCP OAuth access token, or None.

    ``load_row(token_id)`` and ``minter_current(row)`` are the handler's own token-row read and
    Cognito re-check, so both credential kinds share them (and their fault handling).
    """
    config = oauth_config()
    if config is None:
        return None
    try:
        claims = verify_access_token(credential, config, now=now.timestamp(), cache=cache)
    except InvalidToken as exc:
        logger.info('MCP OAuth token refused', extra={'reason': str(exc)})
        return None
    except JwksUnavailable as exc:
        logger.exception('JWKS unavailable', extra={'error_type': str(exc)})
        raise CredentialBackendUnavailable('jwks') from exc
    row = load_row(grants.grant_id(claims.sub, claims.client_id))
    if not _usable_grant(row, sub=claims.sub, client_id=claims.client_id, origin_jti=claims.origin_jti, now=now):
        logger.info('MCP OAuth token refused', extra={'reason': 'no usable grant for this token chain'})
        return None
    scope = grants.effective_scope(row, claims.scopes, config)
    if scope is None:
        logger.info('MCP OAuth token refused', extra={'reason': 'no MCP scope'})
        return None
    if row.get('created_by_username') != claims.username or not minter_current(row):
        logger.info('MCP OAuth token refused: user no longer current', extra={'grant_id': row.get('token_id')})
        return None
    return {**row, 'scope': scope}
