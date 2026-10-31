"""Which Cognito app clients' tokens the main REST API accepts (docs/mcp.md → "OAuth sign-in").

API Gateway's Cognito authorizer accepts a token of ANY app client of the pool, and the handlers trust its
``cognito:groups``. The pool also holds the MCP OAuth clients (``api-mcp-oauth.ts``), whose tokens must only
ever reach ``/mcp/global`` (verified there, never admin, capped at editor, audited). So every API Lambda
refuses a token whose issuing client is not one of ``APP_CLIENT_IDS`` (the SPA's web client and the board
pool's client, set on every VocApiStack function by ``lib/utils/app-client-env.ts``) with a 401.

What counts as a token: a claim set carrying ``token_use``, ``aud`` or ``client_id``. Cognito puts
``token_use`` in every token, plus ``aud`` (ID token) or ``client_id`` (access token), and API Gateway
passes them all through. The claims our own Lambdas synthesize for an internal invocation (the assistant
stream, the MCP delegate, agents and plan steps) forward only ``sub`` / groups / username / email, so
they carry none of the three and are not judged here: those callers authenticated their own caller first.

Fails closed: a token with no issuing client, or any token while ``APP_CLIENT_IDS`` is unset, is refused.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Final

from shared.exceptions import AuthenticationError
from shared.project_access import claims_from_event

APP_CLIENT_IDS_ENV: Final = 'APP_CLIENT_IDS'
TOKEN_MARKER_CLAIMS: Final = ('token_use', 'aud', 'client_id')
REFUSAL: Final = 'This sign-in is not valid for this API'


def allowed_client_ids() -> frozenset[str]:
    raw = os.environ.get(APP_CLIENT_IDS_ENV, '')
    return frozenset(part.strip() for part in raw.split(',') if part.strip())


def issuing_client(claims: Mapping[str, Any]) -> str | None:
    """The app client a Cognito token was issued to: ``client_id`` (access token) or ``aud`` (ID token)."""
    for name in ('client_id', 'aud'):
        value = claims.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def is_token_claims(claims: Mapping[str, Any]) -> bool:
    return any(name in claims for name in TOKEN_MARKER_CLAIMS)


def require_app_client(event: Mapping[str, Any]) -> None:
    """Raise AuthenticationError (401) when the request's Cognito token was issued to a foreign client."""
    claims = claims_from_event(event)
    if not is_token_claims(claims):
        return
    client = issuing_client(claims)
    if client is None or client not in allowed_client_ids():
        raise AuthenticationError(REFUSAL)


__all__ = ['require_app_client']
