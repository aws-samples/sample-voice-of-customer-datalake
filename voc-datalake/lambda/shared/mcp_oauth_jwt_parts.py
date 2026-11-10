"""Parsing the parts of a compact JWT, WITHOUT any signature check (docs/mcp.md → "OAuth sign-in").

Crypto-free on purpose: ``voc-mcp-tokens-api`` (the token facade) reads Cognito's own fresh answer with
:func:`unverified_claims` and needs no ``cryptography`` layer; ``shared.mcp_oauth_jwt`` (the verifier on
``/mcp/global``) builds on the same segment decoding.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Final

MAX_TOKEN_LENGTH: Final = 8192


class InvalidToken(Exception):
    """The credential is not a usable MCP access token (a 401). The message names the check, never a value."""


def b64url(segment: str) -> bytes:
    """Strict unpadded base64url (a ``=`` or an empty segment is malformed)."""
    if not segment or '=' in segment:
        raise InvalidToken('malformed segment')
    try:
        return base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4))
    except (binascii.Error, ValueError) as exc:
        raise InvalidToken('malformed segment') from exc


def json_segment(segment: str) -> dict[str, Any]:
    try:
        value = json.loads(b64url(segment))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidToken('malformed segment') from exc
    if not isinstance(value, dict):
        raise InvalidToken('malformed segment')
    return value


def unverified_claims(token: object) -> dict[str, Any] | None:
    """The payload of a JWT WITHOUT checking its signature, or None.

    Only for a token this service received DIRECTLY from Cognito's token endpoint over TLS (the token
    facade, which reads ``sub`` / ``client_id`` / ``origin_jti`` to record the grant's chain). Never for
    a token a client presented.
    """
    if not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH or token.count('.') != 2:
        return None
    try:
        return json_segment(token.split('.')[1])
    except InvalidToken:
        return None
