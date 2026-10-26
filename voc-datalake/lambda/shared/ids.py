"""Server-minted, time-sortable ids that two creates in the same second cannot share.

Projects, personas, documents, research reports, notes and run records were
named ``<prefix>_<YYYYmmddHHMMSS>``: one-second resolution and nothing else, so a
second create inside the same second minted the SAME id. Where the write was
conditional (``attribute_not_exists``) the second create answered 500; where it
was not, it overwrote the first.

The shape is now ``<prefix>_<YYYYmmddHHMMSS>_<8 hex>``:

* the UTC stamp stays first, so ids still read as a date and still sort by
  creation time to the second (sort keys and S3 avatar keys rely on that);
* 32 random bits after it make a same-second collision a ~1-in-4-billion event
  per pair rather than a certainty;
* creates that are conditional writes retry ONCE with a fresh id when the
  refusal was the new row's own ``attribute_not_exists`` (`write_with_fresh_id`),
  so even that event is not a 500.

Ids minted before this change (no suffix) stay valid: nothing parses the suffix,
and every route validator accepts ``[A-Za-z0-9_-]``.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from shared.aws import is_conditional_check_failure
from shared.logging import logger

STAMP_FORMAT: Final = '%Y%m%d%H%M%S'
SUFFIX_BYTES: Final = 4


def timestamped_id(prefix: str, now: datetime | None = None) -> str:
    """``<prefix>_<UTC YYYYmmddHHMMSS>_<8 hex>`` — readable, sortable, collision-safe."""
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    return f'{prefix}_{moment.strftime(STAMP_FORMAT)}_{secrets.token_hex(SUFFIX_BYTES)}'


def is_key_collision(error: Exception, *, put_index: int | None = None) -> bool:
    """Was this write refused because the new row's key already exists?

    ``put_index`` None: a plain conditional ``put_item`` — any
    ConditionalCheckFailed is the key condition. Otherwise the write was a
    transaction and only the cancellation reason AT the Put's index counts: a
    failed project-writable check on another item (a deleted project) is not a
    collision, and retrying it with a new id would only fail the same way.
    """
    if put_index is None:
        return is_conditional_check_failure(error)
    response = getattr(error, 'response', None)
    if not isinstance(response, dict):
        return False
    if (response.get('Error') or {}).get('Code') != 'TransactionCanceledException':
        return False
    reasons = response.get('CancellationReasons')
    if not isinstance(reasons, list) or len(reasons) <= put_index:
        return False
    reason = reasons[put_index]
    return isinstance(reason, dict) and reason.get('Code') == 'ConditionalCheckFailed'


def write_with_fresh_id[T](
    prefix: str,
    write: Callable[[str], T],
    *,
    put_index: int | None = None,
    now: datetime | None = None,
) -> T:
    """``write(new_id)``; on a key collision, once more with another fresh id.

    ``write`` must be a conditional create that has written nothing when it
    raises (``attribute_not_exists`` on the new key, or a transaction), so the
    retry cannot leave a half-made row behind. A second collision, and every
    other error, propagates.
    """
    try:
        return write(timestamped_id(prefix, now))
    except Exception as error:
        if not is_key_collision(error, put_index=put_index):
            raise
        logger.warning(f'{prefix} id collided with an existing row; retrying once with a new id')
    return write(timestamped_id(prefix, now))
