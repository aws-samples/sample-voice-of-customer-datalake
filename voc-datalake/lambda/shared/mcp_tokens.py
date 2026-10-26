"""The MCP credential format: mint, parse and hash a ``voc_tok_<id>_<secret>`` token.

The single definition of what an MCP token *is*, shared by the global MCP server
(``api/mcp_global_handler.py``, ``POST /mcp/global``) and its token API
(``api/mcp_tokens_handler.py``, ``/connect/tokens``); WHERE a token is stored and
what it may do live in ``shared.mcp_global_tokens``.

* **The token carries its own id**, so authentication is ONE keyed read of the
  token row, never a scan that hashes every stored credential.
* **Only the secret half is hashed.** The token id is therefore safe to log,
  display and put in an error message, while the secret never is.

The per-project MCP server (``/mcp``) and its ``MCPTOKEN`` rows, scopes and
read-reach axes were retired in 3.00.00; a stale per-project credential still
PARSES (same format) but names no ``MCPGTOKEN`` row, so the global server answers
401. Legacy ``voc_<64 hex>`` tokens are not accepted either.
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


def parse_token(raw: object) -> tuple[str, str] | None:
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
