"""
Shared SQS batch-send helper for VoC plugin ingestors.

``send_messages_to_queue`` wraps ``send_message_batch`` so that per-entry
failures reported in the ``Failed`` list of an HTTP-200 response are never
silently discarded.  It distinguishes:

* ``SenderFault: true``  — the entry is malformed; retrying identically will
  always fail, so these are collected as permanent failures immediately.
* ``SenderFault: false`` — throttling or a transient AWS-internal error; these
  are retried up to *max_retries* times (default 3).

Every batch response is also *reconciled* against the entries submitted: the
``Successful`` and ``Failed`` lists together must account for every entry.  An
entry that appears in neither is recorded as a permanent failure rather than
being silently dropped, so the ``RuntimeError`` contract stays total even for a
truncated or malformed response.  Conversely,
only ``Successful`` entries whose ``Id`` maps back to a distinct submitted entry
are counted, so a malformed response cannot inflate the metric either.  The
``Failed`` list is deduplicated by submitted entry for the same reason: acting on
a repeated ``Id`` would retry and report one entry several times, growing the
retry batch instead of shrinking it and re-delivering feedback SQS may already
have accepted.

Two kinds of self-contradictory response get an explicit policy:

* An entry claimed in **both** lists is treated as **failed**.  The directions are
  not symmetric — trusting ``Successful`` would let the caller report success and
  advance its watermark past feedback SQS explicitly reported as failed, losing it
  for good, whereas trusting ``Failed`` costs at most a re-delivery of a message
  SQS may already have accepted.  That re-delivery is deduplicated downstream
  **when ``IDEMPOTENCY_TABLE`` is configured**, as it is by default
  (``lib/stacks/processing-stack-consolidated.ts`` sets it unconditionally); with
  it unset the processor logs "duplicate protection disabled" and the item is
  processed twice.  So the trade-off is double-processing, which is recoverable
  and loudly degraded, against a lost item, which is neither.
* A ``Failed`` entry whose ``Id`` cannot be mapped back to a submitted entry is
  first paired with an entry the response left unaccounted for (already recorded
  as failed).  Any remainder is reported as a count of *unattributable failures*,
  separately from the item ids, because such an entry carries no identity:
  counting it as a lost item would report more failures than there were items.

The metric is emitted with the **actual** successfully enqueued count (not the
attempted count) on *every* exit path — including when ``send_message_batch``
itself raises part-way through a multi-batch send — so what actually landed on
the queue is always recorded.  A ``RuntimeError`` is raised if any items could
not be enqueued so callers cannot silently report success.
"""

import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from shared.logging import logger, metrics

__all__ = ["send_messages_to_queue"]

_MAX_BATCH_SIZE = 10

# Retry jitter only needs a uniform draw in [0.5, 1.5]; it is not security-relevant.
_jitter = secrets.SystemRandom()


@dataclass
class _SendState:
    """Running totals of one ``send_messages_to_queue`` call."""

    total_sent: int = 0
    # Ids (the item's own ``id`` field) of items that permanently failed.
    permanent_failures: list[str] = field(default_factory=list)
    # Raw Ids of Failed entries that no submitted entry can account for, across
    # every retry round.  Kept apart from permanent_failures because such an
    # entry has no identity: it says *something* failed without saying what, so
    # it is reported as a count of response anomalies rather than as a lost
    # feedback item.  Mixing the two lets one anomaly — or the same one seen in
    # several rounds — report more failed items than there were items to lose.
    unattributable_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _RoundContext:
    """What every batch of one retry round needs to classify its failures."""

    attempt: int
    max_retries: int
    log_label: str


def _split_batches(items: list[dict]) -> list[list[dict]]:
    """Return successive max-size slices of *items* as a list."""
    return [
        items[start : start + _MAX_BATCH_SIZE]
        for start in range(0, len(items), _MAX_BATCH_SIZE)
    ]


def _sleep_before_retry(
    attempt: int, max_retries: int, pending_count: int, log_label: str, initial_delay: float
) -> None:
    """Exponential backoff with uniform jitter in [0.5, 1.5] before a retry round."""
    if attempt == 0 or initial_delay <= 0:
        return
    delay = initial_delay * (2 ** (attempt - 1)) * _jitter.uniform(0.5, 1.5)
    logger.debug(
        "SQS retry attempt %d/%d for %d %s item(s); sleeping %.2fs",
        attempt,
        max_retries,
        pending_count,
        log_label,
        delay,
    )
    time.sleep(delay)


def _count_confirmed(
    successful: list[dict], batch_size: int, log_label: str, state: _SendState
) -> set[int]:
    """Credit the Successful entries that map to a distinct submitted entry.

    Taking len(Successful) on trust lets a duplicated or out-of-range Id credit
    the metric with a success that never happened.  Returns the confirmed batch
    indices.
    """
    valid_ids = {str(idx) for idx in range(batch_size)}
    confirmed_ids = {str(entry.get("Id")) for entry in successful} & valid_ids
    if len(confirmed_ids) != len(successful):
        logger.error(
            "SQS reported %d Successful entry(ies) but only %d map to "
            "a distinct submitted entry; ignoring the remainder for "
            "counting. label=%s",
            len(successful),
            len(confirmed_ids),
            log_label,
        )
    state.total_sent += len(confirmed_ids)
    return {int(sid) for sid in confirmed_ids}


def _batch_item_at(raw_id: Any, batch: list[dict]) -> tuple[int, dict]:
    """Map a Failed entry's Id (raw, untyped response JSON) to ``(index, item)``.

    Raises ValueError/TypeError for a non-integer Id and IndexError for one
    outside the batch (negative indices included).
    """
    idx = int(raw_id)
    if idx < 0:
        raise IndexError(f"negative batch index: {idx}")
    return idx, batch[idx]


def _map_failed_entry(
    failed: dict, batch: list[dict], log_label: str, unmappable_ids: list[str]
) -> tuple[int, dict] | None:
    """Resolve a Failed entry to its submitted entry, or record it as unmappable.

    An unmappable entry records nothing against an item here, so the real item
    is reported exactly once — by reconciliation — rather than twice alongside a
    raw SQS artefact that is not a feedback id.
    """
    raw_id = failed.get("Id")
    if raw_id is None:
        # A missing Id field cannot be mapped back to an item in the batch.  Log
        # the full SQS entry (contains no user data — only SQS error metadata).
        logger.error(
            "SQS Failed entry missing Id field; entry=%s label=%s",
            failed,
            log_label,
        )
        unmappable_ids.append("<missing>")
        return None
    try:
        mapped = _batch_item_at(raw_id, batch)
    except (ValueError, IndexError, TypeError):
        mapped = None
    if mapped is None:
        # Logged after the `except`, at error and without a traceback: the cause is
        # always an unparseable or out-of-range Id, which the message already names.
        logger.error(
            "SQS Failed entry has invalid Id %r (batch size %d); "
            "entry=%s label=%s",
            raw_id,
            len(batch),
            failed,
            log_label,
        )
        unmappable_ids.append(repr(raw_id))
    return mapped


def _record_failure(
    failed: dict, failed_item: dict, ctx: _RoundContext, state: _SendState
) -> bool:
    """Classify one mapped Failed entry; True means it should be retried."""
    # Use the item's own id field for logging only — never log the full message
    # body because it may contain personal data.
    item_id = str(failed_item.get("id", f"idx-{failed.get('Id')}"))
    error_code = failed.get("Code", "Unknown")

    if failed.get("SenderFault", False):
        # Malformed entry: retrying will fail identically.
        state.permanent_failures.append(item_id)
        logger.warning(
            "SQS entry permanently rejected (SenderFault=true); "
            "item_id=%s code=%s label=%s",
            item_id,
            error_code,
            ctx.log_label,
        )
        return False
    if ctx.attempt < ctx.max_retries:
        return True
    # Transient but retries exhausted.
    state.permanent_failures.append(item_id)
    logger.warning(
        "SQS entry failed after %d retries; "
        "item_id=%s code=%s label=%s",
        ctx.max_retries,
        item_id,
        error_code,
        ctx.log_label,
    )
    return False


def _classify_failed_entries(
    failed_entries: list[dict],
    batch: list[dict],
    *,
    confirmed_idx: set[int],
    accounted_idx: set[int],
    ctx: _RoundContext,
    state: _SendState,
) -> tuple[list[dict], list[str]]:
    """Walk a response's Failed list.

    Returns ``(items to retry, raw Ids that could not be mapped)`` and adds every
    mapped index to *accounted_idx*.
    """
    retry: list[dict] = []
    # Batch indices already handled from this response's Failed list.  A
    # response that repeats an Id must not act on it twice: appending the same
    # item to the retry list per repetition grows *pending* instead of shrinking
    # it, which amplifies each retry round and delivers the same feedback more
    # than once.
    seen_failed_idx: set[int] = set()
    # Raw Ids of Failed entries that could not be mapped to a submitted entry.
    # Kept as identities rather than a bare count so reconciliation can pair each
    # one with the specific entry it is recorded against, and name the unpairable
    # remainder.
    unmappable_ids: list[str] = []

    for failed in failed_entries:
        mapped = _map_failed_entry(failed, batch, ctx.log_label, unmappable_ids)
        if mapped is None:
            continue
        idx, failed_item = mapped
        raw_id = failed.get("Id")

        if idx in seen_failed_idx:
            # A repeated Failed Id: acting on it again would retry and report the
            # same submitted entry more than once.  The first entry for an index
            # therefore decides how it is classified; when a response repeats an
            # Id with conflicting semantics (SenderFault true, then false), the
            # order SQS returned them in is what settles it.
            logger.error(
                "SQS repeated Failed Id %r in one response; ignoring "
                "the duplicate. label=%s",
                raw_id,
                ctx.log_label,
            )
            continue
        if idx in confirmed_idx:
            # The same entry is claimed as both enqueued and failed.  Trust the
            # Failed side: withdraw the success it was credited with and classify
            # it below like any other failure.  The two directions are not
            # symmetric.  Trusting Successful lets the caller report success and
            # advance its watermark past feedback SQS explicitly reported as
            # failed — permanent loss, and the exact class this helper exists to
            # close.  Trusting Failed costs at most a re-delivery, which is
            # deduplicated downstream when IDEMPOTENCY_TABLE is configured (the
            # default) and processed twice when it is not — see the module
            # docstring.  Withdrawing the count is safe to do exactly once
            # because the repeated-Id guard above has already returned for any
            # later mention of this index.
            logger.error(
                "SQS reported Id %r as both Successful and Failed; "
                "trusting the Failed entry and withdrawing the "
                "counted success. label=%s",
                raw_id,
                ctx.log_label,
            )
            state.total_sent -= 1
        seen_failed_idx.add(idx)
        accounted_idx.add(idx)
        if _record_failure(failed, failed_item, ctx, state):
            retry.append(failed_item)

    return retry, unmappable_ids


def _reconcile_unaccounted(
    batch: list[dict],
    accounted_idx: set[int],
    response_entry_count: int,
    log_label: str,
    state: _SendState,
) -> list[tuple[int, dict]]:
    """Record every submitted entry the response did not account for.

    SQS accounts for every entry in either Successful or Failed; an entry present
    in neither — or referenced only by an Id that cannot be mapped back to it —
    would otherwise be neither counted nor reported: exactly the silent-loss
    class this helper exists to close.  Any shortfall is a permanent failure so
    the RuntimeError contract stays total for truncated or malformed responses.
    """
    unaccounted = [
        (idx, item)
        for idx, item in enumerate(batch)
        if idx not in accounted_idx
    ]
    if unaccounted:
        logger.error(
            "SQS response returned %d entry(ies) covering %d of %d "
            "submitted entries; treating %d unaccounted entry(ies) "
            "as failed. label=%s",
            response_entry_count,
            len(accounted_idx),
            len(batch),
            len(unaccounted),
            log_label,
        )
        for idx, item in unaccounted:
            # Log the item's own id only — never the message body.
            state.permanent_failures.append(str(item.get("id", f"idx-{idx}")))
    return unaccounted


def _attribute_unmappable(
    unmappable_ids: list[str],
    unaccounted: list[tuple[int, dict]],
    log_label: str,
    state: _SendState,
) -> None:
    """Attribute the unmappable Failed entries.

    Such an entry reports a failure for *some* submitted entry, but its Id does
    not say which.  The only entries it can refer to are those the response did
    not otherwise account for — the unaccounted set — and every one of those is
    already recorded as a failure.  So each unmappable entry is paired with one
    unaccounted entry and adds no second record for the same loss.

    That pairing is an inference, not a fact: if the response is
    self-contradictory (it claims an entry as Successful *and* reports a failure
    for it with an unusable Id) the pairing attributes the failure to the wrong
    entry.  The identities on both sides are therefore logged explicitly, so the
    attribution is visible and reviewable rather than a silent count offset.
    """
    paired = min(len(unmappable_ids), len(unaccounted))
    if paired:
        logger.error(
            "SQS reported %d Failed entry(ies) with unusable Id(s) %s; "
            "attributing them to unaccounted submitted entry(ies) %s, "
            "already recorded as failed. label=%s",
            paired,
            unmappable_ids[:paired],
            [
                str(item.get("id", f"idx-{idx}"))
                for idx, item in unaccounted[:paired]
            ],
            log_label,
        )
    # Any unmappable entry left over has no unaccounted entry to refer to, so its
    # failure would vanish entirely.  Record each one individually — naming the
    # raw Id in the log — rather than trusting a response that contradicts itself.
    for raw in unmappable_ids[paired:]:
        logger.error(
            "SQS reported a Failed entry with unusable Id %s that no "
            "unaccounted submitted entry can explain; escalating it as "
            "an unattributable failure. label=%s",
            raw,
            log_label,
        )
        state.unattributable_ids.append(raw)


def _send_batch(
    sqs_client, queue_url: str, batch: list[dict], ctx: _RoundContext, state: _SendState
) -> list[dict]:
    """Send one batch and account for its response; returns items to retry."""
    entries = [
        {
            "Id": str(idx),
            "MessageBody": json.dumps(item, default=str),
        }
        for idx, item in enumerate(batch)
    ]
    resp = sqs_client.send_message_batch(QueueUrl=queue_url, Entries=entries)
    successful = list(resp.get("Successful", []))
    failed_entries = list(resp.get("Failed", []))

    confirmed_idx = _count_confirmed(successful, len(batch), ctx.log_label, state)
    # Batch indices this response accounted for, in either list.  Used to
    # reconcile the response against what was submitted, so an entry can be
    # recorded at most once.
    accounted_idx: set[int] = set(confirmed_idx)

    retry, unmappable_ids = _classify_failed_entries(
        failed_entries,
        batch,
        confirmed_idx=confirmed_idx,
        accounted_idx=accounted_idx,
        ctx=ctx,
        state=state,
    )
    unaccounted = _reconcile_unaccounted(
        batch,
        accounted_idx,
        len(successful) + len(failed_entries),
        ctx.log_label,
        state,
    )
    _attribute_unmappable(unmappable_ids, unaccounted, ctx.log_label, state)
    return retry


def _raise_if_failures(state: _SendState, log_label: str) -> None:
    """Raise RuntimeError naming every failure, if there was any.

    The two kinds are reported separately.  The item count is derived only from
    failures that name a submitted entry, so it can never exceed the number of
    items submitted; unattributable failures are counted as the response
    anomalies they are, which keeps both numbers honest.
    """
    if not (state.permanent_failures or state.unattributable_ids):
        return
    parts = []
    if state.permanent_failures:
        failed_ids = state.permanent_failures
        logger.error(
            "Failed to enqueue %d %s item(s); ids=%s",
            len(failed_ids),
            log_label,
            failed_ids,
        )
        parts.append(
            f"{len(failed_ids)} {log_label} item(s) could not be "
            f"enqueued after retries; ids={failed_ids}"
        )
    if state.unattributable_ids:
        logger.error(
            "SQS reported %d %s failure(s) that no submitted entry can "
            "account for; unusable Id(s)=%s",
            len(state.unattributable_ids),
            log_label,
            state.unattributable_ids,
        )
        parts.append(
            f"{len(state.unattributable_ids)} {log_label} failure(s) could not be "
            f"attributed to a submitted entry; "
            f"unusable Id(s)={state.unattributable_ids}"
        )
    raise RuntimeError("; ".join(parts))


def send_messages_to_queue(
    sqs_client,
    queue_url: str,
    items: list[dict],
    *,
    metric_name: str,
    log_label: str,
    max_retries: int = 3,
    initial_delay: float = 0.5,
) -> int:
    """Send *items* to *queue_url* in batches of 10 with failure handling.

    Args:
        sqs_client:    A boto3 SQS client (or compatible mock).
        queue_url:     The SQS queue URL.
        items:         Normalised feedback dicts to enqueue.
        metric_name:   CloudWatch metric name for successfully enqueued count.
        log_label:     Short label used in log messages (e.g. ``"ingestor"``).
        max_retries:   Maximum number of retries for transient (non-sender-fault)
                       failures.  Defaults to 3.
        initial_delay: Base delay in seconds for the first retry.  Each
                       subsequent retry doubles the base, multiplied by a
                       uniform jitter in [0.5, 1.5].  Defaults to 0.5 s.
                       Pass ``0`` in tests to keep them fast.

    Returns:
        The number of items that were successfully enqueued.

    Raises:
        RuntimeError: If one or more items could not be enqueued after all
                      retries are exhausted, because the entry is malformed, or
                      because the response did not account for every submitted
                      entry.
    """
    if not items:
        return 0

    state = _SendState()
    # Items still waiting to be sent (starts as all items, shrinks each round).
    # The loop ends when a round retries nothing: _record_failure stops retrying
    # once ``attempt`` reaches *max_retries*, so at most max_retries + 1 rounds run.
    pending = list(items)
    attempt = 0

    try:
        while pending:
            _sleep_before_retry(attempt, max_retries, len(pending), log_label, initial_delay)
            ctx = _RoundContext(attempt=attempt, max_retries=max_retries, log_label=log_label)
            # Items that fail with SenderFault=false this round get queued here.
            transient_retry: list[dict] = []
            for batch in _split_batches(pending):
                transient_retry.extend(_send_batch(sqs_client, queue_url, batch, ctx, state))
            pending = transient_retry
            attempt += 1
    finally:
        # Emit the metric with the *actual* success count, not the attempted
        # count, on every exit path.  If send_message_batch raises part-way
        # through a multi-batch send, the items already enqueued must still be
        # counted, otherwise what landed on the queue is unrecoverable from
        # metrics.  The original exception is not swallowed.
        metrics.add_metric(name=metric_name, unit="Count", value=state.total_sent)
        logger.info(
            "Enqueued %d of %d %s items to processing queue",
            state.total_sent,
            len(items),
            log_label,
        )

    _raise_if_failures(state, log_label)
    return state.total_sent
