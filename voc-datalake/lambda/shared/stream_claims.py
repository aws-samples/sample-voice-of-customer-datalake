"""
Once-only claims for the aggregator's REVERSALS (REMOVE, MODIFY) — audit G1.

An INSERT claims its stream record's ``eventID`` INSIDE the transaction of its
counters (``shared.idempotency.dedupe_claim_item``). A reversal cannot: its
decrements are conditional writes whose refusals the aggregator reads one by one
(an aged-out row, the persona fallback, the average pairing), and a transaction
reports no per-item outcome. So a reversal takes a claim that is NOT a
transaction participant:

* ``claim`` before the writes: a conditional ``PutItem`` of a marker keyed by the
  record's ``eventID``. Refused = an earlier delivery already reversed this record,
  and the redelivery writes nothing (closing the double decrement).
* ``release`` when the writes then FAIL: an unconditional ``PutItem`` marking the
  claim released, so the stream's retry may claim it again and re-run the record
  exactly as it did before claims existed.

The markers live in the idempotency table beside the INSERT claims (its
``expiration`` TTL collects them after ``CLAIM_TTL_SECONDS``, two days, longer
than the stream's 24-hour retention), so the aggregator needs no new grant: its
role already holds ``PutItem`` there.

Residuals, chosen in the "a missed -1 beats a second -1" direction the aggregator
takes everywhere: a function that dies AFTER its claim and BEFORE its writes (a
timeout, an out-of-memory) leaves the claim in place, and the retry skips that
reversal; and a claim that cannot be written at all (throttling, a missing table)
fails OPEN: the reversal runs unclaimed, as it did before.
"""
from __future__ import annotations

from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import is_conditional_check_failure
from shared.idempotency import IDEMPOTENCY_EXPIRY_ATTRIBUTE, IDEMPOTENCY_KEY_ATTRIBUTE
from shared.logging import logger

CLAIM_TTL_SECONDS: Final = 2 * 24 * 60 * 60
STATE_ATTRIBUTE: Final = 'claim_state'
STATE_CLAIMED: Final = 'claimed'
STATE_RELEASED: Final = 'released'
_KEY_PREFIX: Final = 'aggregator#reversal#'


def reversal_key(event_id: object) -> str | None:
    """The claim key of one stream record (its ``eventID``), or None when it has none."""
    return f'{_KEY_PREFIX}{event_id}' if isinstance(event_id, str) and event_id else None


def _marker(key: str, state: str, now: int) -> dict[str, Any]:
    return {IDEMPOTENCY_KEY_ATTRIBUTE: key, STATE_ATTRIBUTE: state,
            IDEMPOTENCY_EXPIRY_ATTRIBUTE: now + CLAIM_TTL_SECONDS}


def claim(table: Any, key: str, now: int) -> bool:
    """Claim ``key``; False when an earlier delivery holds it (the record was reversed already).

    Fails open: any other failure answers True (the reversal runs unclaimed).
    """
    try:
        table.put_item(
            Item=_marker(key, STATE_CLAIMED, now),
            ConditionExpression='attribute_not_exists(#key) OR #state = :released',
            ExpressionAttributeNames={'#key': IDEMPOTENCY_KEY_ATTRIBUTE, '#state': STATE_ATTRIBUTE},
            ExpressionAttributeValues={':released': STATE_RELEASED},
        )
    except (ClientError, BotoCoreError) as e:
        if is_conditional_check_failure(e):
            return False
        logger.warning(f"Reversal claim not written ({type(e).__name__}); reversing unclaimed")
    return True


def release(table: Any, key: str, now: int) -> None:
    """Give ``key`` back after the reversal's writes failed, so the retry runs it. Never raises."""
    try:
        table.put_item(Item=_marker(key, STATE_RELEASED, now))
    except (ClientError, BotoCoreError) as e:
        logger.warning(f"Reversal claim not released ({type(e).__name__}); the retry will skip it")
