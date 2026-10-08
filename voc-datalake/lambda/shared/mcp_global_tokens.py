"""Global MCP credentials (todofeatures §6.3): storage keys, scopes, lifecycle, audit.

The GLOBAL endpoint (``POST /mcp/global``, ``api/mcp_global_handler.py``) is the
app's only MCP server since 3.00.00, which retired the per-project one (``/mcp``)
and its token routes. Its credentials live in their own keyspace:

* **Isolation.** A global token lives in partition ``MCPGTOKEN``; the retired
  per-project tokens are rows in ``MCPTOKEN``, left in place and never read. The
  global server's role can reach ``MCPGTOKEN`` only, so a stale per-project
  credential is a plain 401 here — refused by where it is looked up, not by its
  format.
* **Same credential scheme.** Minting, parsing and hashing use
  ``shared.mcp_tokens`` (``voc_tok_<16 hex>_<64 hex>``, only the secret half
  hashed, constant-time comparison), the shape the gateway's authorizer checks.

What a global token grants is never more than its minter has: every tool is
delegated to the domain Lambda that owns the route, as the synthetic ``mcp:``
subject acting for ``created_by`` (``shared.mcp_delegate.synthetic_claims``), so
project access is the minter's capped at editor and category access is the
minter's — never admin. On top of that the token narrows, never widens:

* ``scope`` — ``read`` (read tools only) or ``write`` (read + document writes +,
  for an admin-minted token, ``run_agent``);
* ``project_id`` — optional pin: project tools are confined to that project;
* ``expires_at`` — always set (default 30 days, at most 90); there is no
  non-expiring global token.

Revocation is a SOFT revoke (``revoked_at``) so the token and its audit trail stay
listable; authentication refuses a revoked row exactly like an expired one.

Audit rows record one ``tools/call`` each — tool name, time, project id and
outcome, NEVER the arguments or any content — in the jobs table, whose ``ttl``
attribute expires them after ``AUDIT_RETENTION_DAYS`` (the projects table has no
TTL, and adding one would change a live retained table).
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

# ---------------------------------------------------------------------------
# Storage keys
# ---------------------------------------------------------------------------

# Projects table. One partition for every global token, keyed by token id, so
# authentication is ONE keyed read; "my tokens" reads the creator-scoped pointer
# rows below (CREATOR_INDEX_SK_PREFIX). Rows carry no gsi1pk, which keeps them out
# of the projects listing index.
GLOBAL_TOKEN_PK: Final = 'MCPGTOKEN'

# Jobs table (it has a TTL). One partition per token, newest-first by sort key.
AUDIT_PK_PREFIX: Final = 'MCPAUDIT#'
AUDIT_RETENTION_DAYS: Final = 90
AUDIT_PAGE_SIZE: Final = 50


def token_sk(token_id: str) -> str:
    """Sort key of a global token row (same spelling as the per-project rows)."""
    return f'TOKEN#{token_id}'


def audit_pk(token_id: str) -> str:
    """Partition holding one token's audit events."""
    return f'{AUDIT_PK_PREFIX}{token_id}'


# "My tokens" index: one KEYS-ONLY pointer row per token, written in the same
# transaction as the token row, in the SAME partition under a creator-scoped sort
# key — so listing a user's tokens is a key-condition Query on
# ``begins_with(sk, 'CREATOR#{sub}#')`` (never the whole partition) followed by a
# consistent BatchGetItem of the ``TOKEN#`` rows. The pointer holds no mutable
# state (revoke and ``last_used_at`` stay on the token row), so it never drifts.
# Authentication (``/mcp/global``) keeps its one GetItem on ``TOKEN#{id}``.
CREATOR_INDEX_SK_PREFIX: Final = 'CREATOR#'
# Written by the backfill script (scripts/mcp_tokens/backfill_creator_index.py)
# once every pre-index token row has its pointer. Until it exists the list route
# ALSO reads the old layout (the filtered partition Query) and merges.
CREATOR_INDEX_MARKER_SK: Final = 'MIGRATION#creator-index'


def creator_index_prefix(subject: str) -> str:
    """Sort-key prefix of ``subject``'s pointer rows. Raises ValueError for a subject
    that could address another user's prefix (``#``) or every user's (empty)."""
    if not subject or '#' in subject:
        raise ValueError('subject cannot key the creator index')
    return f'{CREATOR_INDEX_SK_PREFIX}{subject}#'


def creator_index_sk(subject: str, token_id: str) -> str:
    return f'{creator_index_prefix(subject)}{token_sk(token_id)}'


def creator_index_item(subject: str, token_id: str, created_at: str) -> dict[str, str]:
    """The pointer row for one token: keys and immutable facts only."""
    return {
        'pk': GLOBAL_TOKEN_PK,
        'sk': creator_index_sk(subject, token_id),
        'token_id': token_id,
        'created_by': subject,
        'created_at': created_at,
    }


# ---------------------------------------------------------------------------
# Scope, lifetime, pin
# ---------------------------------------------------------------------------

SCOPE_READ: Final = 'read'
SCOPE_WRITE: Final = 'write'
VALID_SCOPES: Final[tuple[str, ...]] = (SCOPE_READ, SCOPE_WRITE)

DEFAULT_EXPIRY_DAYS: Final = 30
# OWASP MCP01 asks for short-lived bearer credentials; a token outliving a quarter
# is the leak that keeps working. Tokens minted before 3.02.00 keep their stored
# `expires_at` (up to 365 days) — the bound applies at mint time only.
MAX_EXPIRY_DAYS: Final = 90
MAX_ACTIVE_TOKENS_PER_USER: Final = 20
MAX_TOKEN_NAME_LENGTH: Final = 80

STATUS_ACTIVE: Final = 'active'
STATUS_REVOKED: Final = 'revoked'
STATUS_EXPIRED: Final = 'expired'

# A path segment a tool may interpolate into a domain route. Every id this app
# mints (proj_…, doc_…, agent ids, tok_…, 32-hex feedback ids) fits; '/', '.',
# '%' and whitespace never do, so a tool argument cannot traverse to another route.
_PATH_ID: Final = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
# Fails `is_path_id`, so it can equal no real project id and no tool argument.
UNMATCHABLE_PROJECT: Final = '\u0000unmatchable'


def is_path_id(value: object) -> bool:
    """True when ``value`` is safe to place in a route path segment."""
    return isinstance(value, str) and bool(_PATH_ID.fullmatch(value))


def scope_allows_write(scope: object) -> bool:
    """Only the exact ``write`` value grants writes (fail closed on anything else)."""
    return scope == SCOPE_WRITE


def scope_is_valid(scope: object) -> bool:
    return isinstance(scope, str) and scope in VALID_SCOPES


def expiry_for(days: object, now: datetime) -> str:
    """The ISO deadline for a requested lifetime; raises ValueError when invalid.

    ``None`` means the default (30 days). Strict rather than clamped — a lifetime
    nobody chose must not be minted — and bools are refused before the int check
    because ``isinstance(True, int)`` holds.
    """
    if days is None:
        days = DEFAULT_EXPIRY_DAYS
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_EXPIRY_DAYS:
        raise ValueError(f'expires_in_days must be an integer between 1 and {MAX_EXPIRY_DAYS}')
    return (now + timedelta(days=days)).isoformat()


def _parsed_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def token_status(row: Mapping[str, Any], now: datetime) -> str:
    """``active`` | ``revoked`` | ``expired``, failing closed.

    A missing or unreadable ``expires_at`` reads as expired: every global token is
    minted with one, so its absence is data damage, and an unreadable deadline
    must not become an unlimited one.
    """
    if row.get('revoked_at'):
        return STATUS_REVOKED
    deadline = _parsed_time(row.get('expires_at'))
    if deadline is None or deadline <= now:
        return STATUS_EXPIRED
    return STATUS_ACTIVE


def pinned_project(row: Mapping[str, Any]) -> str | None:
    """The project a token is pinned to, or None for a workspace token.

    A present-but-malformed value pins to an impossible project id rather than
    unpinning: a damaged row must narrow, never widen.
    """
    value = row.get('project_id')
    if value is None or value == '':
        return None
    return value if is_path_id(value) else UNMATCHABLE_PROJECT



def token_view(row: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """The API shape of a token row. Never the secret hash."""
    return {
        'token_id': row.get('token_id'),
        'name': row.get('name') or '',
        'scope': row.get('scope') if scope_is_valid(row.get('scope')) else SCOPE_READ,
        'project_id': row.get('project_id') or None,
        'created_at': row.get('created_at'),
        'expires_at': row.get('expires_at'),
        'last_used_at': row.get('last_used_at'),
        'revoked_at': row.get('revoked_at'),
        'status': token_status(row, now),
        # Whether run_agent CAN be offered (still re-checked against Cognito per call).
        'can_run_agents': bool(row.get('minted_by_admin')) and scope_allows_write(row.get('scope')),
    }


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

OUTCOME_OK: Final = 'ok'               # the domain route answered 2xx
OUTCOME_ERROR: Final = 'error'         # the route refused (4xx) or the tool rejected the arguments
OUTCOME_DENIED: Final = 'denied'       # the token's scope, pin or admin check refused it
OUTCOME_FAILED: Final = 'failed'       # a server-side fault; the call never completed
OUTCOMES: Final[tuple[str, ...]] = (OUTCOME_OK, OUTCOME_ERROR, OUTCOME_DENIED, OUTCOME_FAILED)

_MAX_TOOL_NAME_LENGTH: Final = 64


def audit_item(token_id: str, *, tool: str, project_id: str | None, outcome: str,
               now: datetime) -> dict[str, Any]:
    """One audit row. Holds no argument, no result and no content by construction:
    those values are not parameters of this function."""
    at = now.isoformat()
    item: dict[str, Any] = {
        'pk': audit_pk(token_id),
        # Random suffix: two calls in one microsecond must not overwrite each other.
        'sk': f'{at}#{secrets.token_hex(4)}',
        'token_id': token_id,
        'tool': tool[:_MAX_TOOL_NAME_LENGTH],
        'at': at,
        'outcome': outcome if outcome in OUTCOMES else OUTCOME_FAILED,
        'ttl': int((now + timedelta(days=AUDIT_RETENTION_DAYS)).timestamp()),
    }
    if project_id and is_path_id(project_id):
        item['project_id'] = project_id
    return item


def audit_view(row: Mapping[str, Any]) -> dict[str, Any]:
    """The API shape of an audit row: exactly the four recorded facts."""
    return {
        'tool': row.get('tool') or '',
        'at': row.get('at') or '',
        'project_id': row.get('project_id') or None,
        'outcome': row.get('outcome') if row.get('outcome') in OUTCOMES else OUTCOME_FAILED,
    }
