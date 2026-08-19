"""MCP credential format, storage keys, and the two reach axes.

The single source of truth for what an MCP token *is*. Before this module the
``voc_`` prefix was spelled in three places — the MCP handler, the projects
handler, and an inline Node authorizer in api-stack.ts — and the only shared
code was a bare SHA-256 helper.

Three things changed with this format, each fixing something structural:

1. **The token carries its own id**, so authentication is ONE keyed read
   instead of "Query every token row in a project and hash each one until
   something matches". That loop is also why the old credential needed an
   ``X-Project-Id`` header: without the project there was no partition to
   scan, and a header cannot express "no particular project", which is what
   made a workspace-wide tool such as ``list_projects`` unimplementable.
2. **Only the secret half is hashed.** The token id is therefore safe to log,
   display and put in an error message, while the secret never is.
3. **Reach is two independent axes** (see ``read_reach``), because "write
   here, look around everywhere" is the shape people actually want and a
   single project-scope field cannot say it.

Legacy ``voc_<64 hex>`` tokens are NOT accepted. They were never used in
production (owner confirmation, 2026-08-18), and the failure mode for a stray
one is a 401 that re-minting fixes — not data loss. Nothing in here should
grow a compatibility branch for them.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Final

# ---------------------------------------------------------------------------
# Format
# ---------------------------------------------------------------------------

TOKEN_PREFIX: Final = 'voc_'
TOKEN_ID_PREFIX: Final = 'tok_'

# secrets.token_hex(n) yields 2n hex characters.
_TOKEN_ID_BYTES: Final = 8      # → 16 hex chars, 64 bits of id space
_SECRET_BYTES: Final = 32       # → 64 hex chars, 256 bits of secret

_TOKEN_ID_HEX_LEN: Final = _TOKEN_ID_BYTES * 2
_SECRET_HEX_LEN: Final = _SECRET_BYTES * 2

# `voc` + `tok` + id + secret. The token id keeps its own `tok_` prefix
# because it is a public identifier elsewhere (the revoke route, the UI, log
# lines), so the credential contains one underscore more than the shape
# `voc_{token_id}_{secret}` suggests at a glance. Parsing therefore expects
# exactly four parts and rebuilds the id, rather than splitting on the last
# underscore and hoping.
_TOKEN_PART_COUNT: Final = 4

# ---------------------------------------------------------------------------
# Storage keys
# ---------------------------------------------------------------------------

# Tokens live in ONE partition of the projects table, deliberately outside any
# `PROJECT#{id}` partition: a credential is workspace-level and is no longer a
# child of the project it happened to be minted from.
#
# One partition serves both access patterns with only the base table:
#   • authenticate → Query(pk=MCPTOKEN, sk=TOKEN#{id})  — a single item
#   • list for the UI → Query(pk=MCPTOKEN)              — every token
# so no GSI is needed and the MCP role's existing Query+UpdateItem grant is
# already sufficient. `gsi1pk` is deliberately NOT set on these rows, which is
# what keeps them out of `projects.list_projects` (it queries the
# `TYPE#PROJECT` GSI, so an unindexed row is invisible to it).
#
# ponytail: single hot partition for all tokens. Ceiling is per-partition
# throughput (~3 000 RCU), which the endpoint's own 20 rps stage throttle sits
# three orders of magnitude below. Upgrade path if tokens ever number in the
# thousands: shard the pk by a prefix of the token id, which changes only the
# two helpers below. Same shape as the existing global PRIORITIZATION
# partition.
MCP_TOKEN_PK: Final = 'MCPTOKEN'


def token_sk(token_id: str) -> str:
    """Sort key for a token row."""
    return f'TOKEN#{token_id}'


# ---------------------------------------------------------------------------
# Scopes
# ---------------------------------------------------------------------------

# The scopes that currently grant something. Deliberately NOT the full nine of
# the design doc: a mintable scope that no tool consults is a phantom
# permission, and this codebase already had one (`read-write` was mintable,
# stored, and shown with its own badge while every tool required only `read`).
# Phase 3 adds a write scope in the same commit as the first write tool.
SCOPE_FEEDBACK_READ: Final = 'feedback:read'
SCOPE_METRICS_READ: Final = 'metrics:read'
SCOPE_PROJECTS_READ: Final = 'projects:read'

VALID_SCOPES: Final[frozenset[str]] = frozenset({
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
})

# What a token gets when it names no scopes. Every current scope is a read, so
# this is the whole vocabulary; it stops being the default the moment a write
# scope exists.
DEFAULT_SCOPES: Final[tuple[str, ...]] = (
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
)

# ---------------------------------------------------------------------------
# Reach — the two axes
# ---------------------------------------------------------------------------

# Axis 1 is the token's PROJECT SET (`projects` on the row): the projects this
# credential is about. Named `projects` rather than `write_projects` because in
# this phase it bounds *reads* (see REACH_PROJECT_SET) and there are no write
# tools yet; when Phase 3 adds them, writes are confined to the same list and
# the name still tells the truth.
#
# Axis 2 is how far the token may READ, which is independent: the useful
# default is "write in one place, look everywhere", and one field cannot say
# that.
REACH_WORKSPACE: Final = 'workspace'
REACH_PROJECT_SET: Final = 'project-set'
REACH_NONE: Final = 'none'

VALID_READ_REACHES: Final[tuple[str, ...]] = (
    REACH_WORKSPACE,
    REACH_PROJECT_SET,
    REACH_NONE,
)

# Workspace, by owner decision (2026-08-18). The reasoning is structural, not
# a preference: the feedback corpus has no project dimension at all
# (`voc-feedback` is keyed `SOURCE#{platform}`, and the project-scoped reads
# select by filters), so any narrower default would have to be *invented* for
# the corpus rather than enforced — and inventing it breaks the cross-project
# analysis that is the reason to expose an MCP server.
#
# ⚠️ Default is not the same as benign. Workspace read reaches every other
# project's unreleased PRDs, PR-FAQs and prototypes plus every raw verbatim.
# That is right for an agent working on behalf of the team and wrong for a
# token pasted into a third-party client, which is why the axis is explicit at
# mint time instead of implied.
DEFAULT_READ_REACH: Final = REACH_WORKSPACE

# How a tool's data is shaped, which decides how reach applies to it.
REACH_KIND_WORKSPACE: Final = 'workspace'   # no project dimension (feedback, metrics)
REACH_KIND_PROJECT: Final = 'project'       # addresses one project


def reach_allows(
    *,
    read_reach: str,
    token_projects: list[str] | tuple[str, ...],
    tool_reach_kind: str,
    project_id: str | None,
) -> bool:
    """Whether a read of *tool_reach_kind* is within the token's reach.

    Fail-closed on every unrecognised input: an unknown reach or an unknown
    tool kind denies rather than falls through to allowed.

    The interesting case is ``project-set`` against a workspace-shaped tool.
    It is REFUSED, and that is the honest answer rather than a gap: there is
    no project dimension in the feedback corpus to narrow, so "allow it" would
    silently hand a supposedly sealed token the entire verbatim history. A
    caller that needs both gets ``workspace`` and accepts what that means.
    """
    if read_reach == REACH_NONE:
        return False
    if tool_reach_kind == REACH_KIND_WORKSPACE:
        return read_reach == REACH_WORKSPACE
    if tool_reach_kind != REACH_KIND_PROJECT:
        return False
    if not project_id:
        return False
    if read_reach == REACH_WORKSPACE:
        return True
    if read_reach == REACH_PROJECT_SET:
        return project_id in token_projects
    return False


# ---------------------------------------------------------------------------
# Mint / parse / hash
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MintedToken:
    """A freshly minted credential.

    ``raw`` is the only time the full credential exists on this side; it is
    returned to the caller once and never stored.
    """

    raw: str
    token_id: str
    secret_hash: str


def hash_secret(secret: str) -> str:
    """Hash the secret half of a credential for storage.

    Plain SHA-256 over 256 bits of ``secrets.token_hex`` entropy: there is no
    dictionary to run against it, so the stored value is not a practical
    route back to the credential.

    HMAC with a Secrets Manager key (design doc §4.2) is deliberately NOT done
    here. Its benefit — a table read alone yields nothing verifiable — matters
    for low-entropy secrets, and buying it would put a Secrets Manager fetch
    on the authentication hot path, where a failure has to be told apart from
    a bad credential. That is a real cost for a marginal gain against a
    256-bit random value. Revisit if the secret ever becomes user-chosen.
    """
    return hashlib.sha256(secret.encode()).hexdigest()


def secret_matches(*, presented_secret: str, stored_hash: str) -> bool:
    """Constant-time comparison of a presented secret against a stored hash.

    Constant time to deny timing-based enumeration of the stored digest. The
    caller is responsible for having established that *stored_hash* is a
    ``str`` — a row where it is not is a data fault, not a mismatch, and the
    two deserve different handling.
    """
    return hmac.compare_digest(hash_secret(presented_secret).encode(), stored_hash.encode())


def mint_token() -> MintedToken:
    """Generate a new credential."""
    token_id = f'{TOKEN_ID_PREFIX}{secrets.token_hex(_TOKEN_ID_BYTES)}'
    secret = secrets.token_hex(_SECRET_BYTES)
    return MintedToken(
        raw=f'{TOKEN_PREFIX}{token_id}_{secret}',
        token_id=token_id,
        secret_hash=hash_secret(secret),
    )


def _is_lower_hex(value: str, length: int) -> bool:
    if len(value) != length:
        return False
    # `str.isalnum` would admit non-hex letters; an explicit set is clearer
    # than a regex here and cannot be tripped by Unicode digit lookalikes the
    # way `str.isdigit` can.
    return all(c in '0123456789abcdef' for c in value)


def parse_token(raw: str) -> tuple[str, str] | None:
    """Split a presented credential into ``(token_id, secret)``.

    Returns ``None`` for anything that is not exactly this format. Strictness
    is the point: the id half selects which row to read, so a lenient parse
    would turn caller-controlled text into a key lookup. Rejecting here means
    a malformed credential never reaches DynamoDB at all.
    """
    if not isinstance(raw, str) or not raw.startswith(TOKEN_PREFIX):
        return None
    parts = raw.split('_')
    if len(parts) != _TOKEN_PART_COUNT:
        return None
    prefix, id_prefix, id_hex, secret = parts
    if f'{prefix}_' != TOKEN_PREFIX or f'{id_prefix}_' != TOKEN_ID_PREFIX:
        return None
    if not _is_lower_hex(id_hex, _TOKEN_ID_HEX_LEN):
        return None
    if not _is_lower_hex(secret, _SECRET_HEX_LEN):
        return None
    return f'{TOKEN_ID_PREFIX}{id_hex}', secret
