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
entry that appears in neither is recorded as a permanent failure with the code
``UnaccountedBySQS`` rather than being silently dropped, so the ``RuntimeError``
contract stays total even for a truncated or malformed response.

After all processing the metric is emitted with the **actual** successfully
enqueued count (not the attempted count), and a ``RuntimeError`` is raised if
any items could not be enqueued so callers cannot silently report success.
"""

import json
import random
import time

from shared.logging import logger, metrics

__all__ = ["send_messages_to_queue"]

_MAX_BATCH_SIZE = 10


def _split_batches(items: list[dict]) -> list[list[dict]]:
    """Return successive max-size slices of *items* as a list."""
    return [
        items[start : start + _MAX_BATCH_SIZE]
        for start in range(0, len(items), _MAX_BATCH_SIZE)
    ]


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

    total_sent = 0
    # List of (item_id_str, sqs_error_code) for items that permanently failed.
    permanent_failures: list[tuple[str, str]] = []
    # Items still waiting to be sent (starts as all items, shrinks each round).
    pending = list(items)

    for attempt in range(max_retries + 1):
        if not pending:
            break

        if attempt > 0 and initial_delay > 0:
            delay = initial_delay * (2 ** (attempt - 1)) * random.uniform(0.5, 1.5)
            logger.debug(
                "SQS retry attempt %d/%d for %d %s item(s); sleeping %.2fs",
                attempt,
                max_retries,
                len(pending),
                log_label,
                delay,
            )
            time.sleep(delay)

        # Items that fail with SenderFault=false this round get queued here.
        transient_retry: list[dict] = []

        for batch in _split_batches(pending):
            entries = [
                {
                    "Id": str(idx),
                    "MessageBody": json.dumps(item, default=str),
                }
                for idx, item in enumerate(batch)
            ]
            resp = sqs_client.send_message_batch(
                QueueUrl=queue_url, Entries=entries
            )
            total_sent += len(resp.get("Successful", []))

            for failed in resp.get("Failed", []):
                raw_id = failed.get("Id")
                if raw_id is None:
                    # A missing Id field cannot be mapped back to an item in
                    # the batch.  Log the full SQS entry (contains no user
                    # data — only SQS error metadata) and treat as permanent.
                    logger.error(
                        "SQS Failed entry missing Id field; entry=%s label=%s",
                        failed,
                        log_label,
                    )
                    error_code = failed.get("Code", "Unknown")
                    permanent_failures.append(("unknown", error_code))
                    continue
                try:
                    idx = int(raw_id)
                    if idx < 0:
                        raise IndexError(f"negative batch index: {idx}")
                    failed_item = batch[idx]
                except (ValueError, IndexError, TypeError):
                    logger.error(
                        "SQS Failed entry has invalid Id %r (batch size %d); "
                        "entry=%s label=%s",
                        raw_id,
                        len(batch),
                        failed,
                        log_label,
                    )
                    error_code = failed.get("Code", "Unknown")
                    permanent_failures.append((str(raw_id), error_code))
                    continue
                # Use the item's own id field for logging only — never log the
                # full message body because it may contain personal data.
                item_id = str(failed_item.get("id", f"idx-{raw_id}"))
                error_code = failed.get("Code", "Unknown")

                if failed.get("SenderFault", False):
                    # Malformed entry: retrying will fail identically.
                    permanent_failures.append((item_id, error_code))
                    logger.warning(
                        "SQS entry permanently rejected (SenderFault=true); "
                        "item_id=%s code=%s label=%s",
                        item_id,
                        error_code,
                        log_label,
                    )
                elif attempt < max_retries:
                    transient_retry.append(failed_item)
                else:
                    # Transient but retries exhausted.
                    permanent_failures.append((item_id, error_code))
                    logger.warning(
                        "SQS entry failed after %d retries; "
                        "item_id=%s code=%s label=%s",
                        max_retries,
                        item_id,
                        error_code,
                        log_label,
                    )

            # Reconcile the response against what was submitted.  SQS accounts
            # for every entry in either Successful or Failed; an entry present
            # in neither would otherwise be neither counted nor reported —
            # exactly the silent-loss class this helper exists to close.  Treat
            # any shortfall as a permanent failure so the RuntimeError contract
            # stays total for truncated or malformed responses.
            reported_ids = {
                str(entry.get("Id"))
                for entry in list(resp.get("Successful", [])) + list(resp.get("Failed", []))
            }
            unaccounted = [
                (idx, item)
                for idx, item in enumerate(batch)
                if str(idx) not in reported_ids
            ]
            if unaccounted:
                logger.error(
                    "SQS response accounted for %d of %d submitted entries; "
                    "treating %d unaccounted entry(ies) as failed. label=%s",
                    len(reported_ids),
                    len(entries),
                    len(unaccounted),
                    log_label,
                )
                for idx, item in unaccounted:
                    # Log the item's own id only — never the message body.
                    item_id = str(item.get("id", f"idx-{idx}"))
                    permanent_failures.append((item_id, "UnaccountedBySQS"))

        pending = transient_retry

    # Emit metric with the *actual* success count, not the attempted count.
    metrics.add_metric(name=metric_name, unit="Count", value=total_sent)
    logger.info(
        "Enqueued %d of %d %s items to processing queue",
        total_sent,
        len(items),
        log_label,
    )

    if permanent_failures:
        failed_ids = [item_id for item_id, _ in permanent_failures]
        logger.error(
            "Failed to enqueue %d %s item(s); ids=%s",
            len(permanent_failures),
            log_label,
            failed_ids,
        )
        raise RuntimeError(
            f"{len(permanent_failures)} {log_label} item(s) could not be "
            f"enqueued after retries; ids={failed_ids}"
        )

    return total_sent
