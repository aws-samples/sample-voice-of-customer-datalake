"""OAuth grants for the global MCP server: one per (person, MCP client), docs/mcp.md → "OAuth sign-in".

A grant is what the consent screen creates and what Connect lists and revokes. It is stored EXACTLY like
a personal token row — same partition (``MCPGTOKEN``), same ``TOKEN#{id}`` sort key, the same
``created_by`` / ``created_by_username`` / ``minted_by_admin`` / ``scope`` / ``project_id`` /
``expires_at`` / ``revoked_at`` fields — so an OAuth caller goes through the SAME code as a token from
there on: ``synthetic_claims`` (never admin, ≤ editor), the per-minute rate limit, the per-call audit
partition, the ``run_agent`` admin re-check and the per-request ``AdminGetUser``. What differs:

* the id is ``oag_<40 hex>``, derived from the Cognito sub and the client id (one keyed read per
  request, no index); the token routes only address ``tok_`` ids, and a grant row has no
  ``secret_hash``, so neither credential kind can be presented as the other;
* ``origin_jtis`` — the refresh chains (Cognito's ``origin_jti``) the token facade recorded for this
  grant. An access token is accepted only from one of them, so a grant revoked or re-consented stops
  every earlier token at once, even one refreshed at Cognito directly;
* ``chain_open_until`` — consent opens a 10-minute window in which the token facade may record ONE new
  chain from an authorization code. A code obtained without consent (or long after it) records nothing
  and is refused.
* ``consent_challenge_sha256`` — the SHA-256 of the consented authorize request's PKCE ``code_challenge``.
  The window records a chain only for a code exchanged with THAT request's ``code_verifier``, so a second
  authorization started (by anyone) while the window is open cannot take the consent over. Cleared with
  the window.

Effective scope per request = the grant's scope narrowed by the token's scopes: ``write`` only when the
grant says ``write`` AND the token carries ``<resource>/write``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Final, TypeGuard

from shared import mcp_global_tokens as gt
from shared.mcp_oauth_config import CLIENT_DISPLAY_NAMES, OAuthConfig
from shared.timestamps import parse_iso

GRANT_ID_PREFIX: Final = 'oag_'
KIND_OAUTH_GRANT: Final = 'oauth_grant'
GRANT_LIFETIME_DAYS: Final = gt.MAX_EXPIRY_DAYS
CHAIN_WINDOW_MINUTES: Final = 10
# Sign-ins kept per grant (two laptops, a re-login): the oldest chain is dropped beyond this.
MAX_CHAINS: Final = 5
MAX_ORIGIN_JTI_LENGTH: Final = 128


def grant_id(subject: str, client_id: str) -> str:
    """The grant id of ``subject`` with ``client_id`` (ids are not secrets; the JWT is the credential)."""
    digest = hashlib.sha256(f'{subject}\n{client_id}'.encode()).hexdigest()
    return f'{GRANT_ID_PREFIX}{digest[:40]}'


def is_grant(row: Mapping[str, Any] | None) -> bool:
    return isinstance(row, Mapping) and row.get('kind') == KIND_OAUTH_GRANT and not row.get('secret_hash')


def is_active_grant_of(row: dict | None, *, sub: str, client_id: str, now: datetime) -> TypeGuard[dict]:
    """``row`` is an unrevoked, unexpired grant of exactly this person and this client."""
    if row is None or not is_grant(row):
        return False
    if row.get('created_by') != sub or row.get('client_id') != client_id:
        return False
    return gt.token_status(row, now) == gt.STATUS_ACTIVE


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def s256_challenge(code_verifier: str) -> str:
    """RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) without padding."""
    digest = hashlib.sha256(code_verifier.encode('ascii', errors='replace')).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode()


def verifier_matches_consent(row: Mapping[str, Any], code_verifier: object) -> bool:
    """``code_verifier`` belongs to the authorize request this grant's consent approved (S256).

    False for a grant without the stored hash (consented before it existed): the person approves again.
    """
    stored = row.get('consent_challenge_sha256')
    if not isinstance(stored, str) or not stored or not isinstance(code_verifier, str) or not code_verifier:
        return False
    return hmac.compare_digest(_sha256_hex(s256_challenge(code_verifier)), stored)


def grant_item(*, subject: str, username: str, is_admin: bool, client_id: str, client_kind: str,
               scope: str, project_id: str | None, code_challenge: str, now: datetime) -> dict[str, Any]:
    """A fresh grant (a re-consent REPLACES the row: earlier chains and any revocation are gone)."""
    gid = grant_id(subject, client_id)
    item: dict[str, Any] = {
        'pk': gt.GLOBAL_TOKEN_PK,
        'sk': gt.token_sk(gid),
        'token_id': gid,
        'kind': KIND_OAUTH_GRANT,
        'name': CLIENT_DISPLAY_NAMES.get(client_kind, client_kind),
        'client_id': client_id,
        'client_kind': client_kind,
        'scope': scope,
        'created_by': subject,
        'created_by_username': username,
        'minted_by_admin': is_admin,
        'created_at': now.isoformat(),
        'expires_at': (now + timedelta(days=GRANT_LIFETIME_DAYS)).isoformat(),
        'chain_open_until': (now + timedelta(minutes=CHAIN_WINDOW_MINUTES)).isoformat(),
        'consent_challenge_sha256': _sha256_hex(code_challenge),
        'origin_jtis': [],
    }
    if project_id:
        item['project_id'] = project_id
    return item


def chains(row: Mapping[str, Any]) -> list[str]:
    value = row.get('origin_jtis')
    return [jti for jti in value if isinstance(jti, str) and jti] if isinstance(value, list) else []


def chain_window_open(row: Mapping[str, Any], now: datetime) -> bool:
    deadline = parse_iso(row.get('chain_open_until'))
    return deadline is not None and now < deadline


def is_valid_origin_jti(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and 0 < len(value) <= MAX_ORIGIN_JTI_LENGTH and value.isprintable()


def with_chain(row: Mapping[str, Any], origin_jti: str) -> list[str]:
    """The chain list after recording ``origin_jti`` (newest last, at most MAX_CHAINS)."""
    kept = [jti for jti in chains(row) if jti != origin_jti]
    return [*kept, origin_jti][-MAX_CHAINS:]


def effective_scope(row: Mapping[str, Any], token_scopes: frozenset[str], config: OAuthConfig) -> str | None:
    """``write`` / ``read`` for this request, or None when the token carries no MCP scope at all."""
    has_write = config.scope('write') in token_scopes
    if not has_write and config.scope('read') not in token_scopes:
        return None
    return gt.SCOPE_WRITE if has_write and gt.scope_allows_write(row.get('scope')) else gt.SCOPE_READ


_SHARED_VIEW_FIELDS: Final = ('scope', 'project_id', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'status')


def grant_view(row: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """The Connect page's shape of a grant: the token view's lifecycle fields, never the chains or the subject."""
    token = gt.token_view(row, now)
    return {
        'grant_id': token['token_id'],
        'client_kind': row.get('client_kind') or '',
        'client_name': token['name'],
        **{field: token[field] for field in _SHARED_VIEW_FIELDS},
        'signed_in': bool(chains(row)),
    }
