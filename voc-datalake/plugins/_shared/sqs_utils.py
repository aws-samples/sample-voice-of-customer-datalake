"""
Shared SQS batch-send helper for VoC plugin ingestors.

``send_messages_to_queue`` wraps ``send_message_batch`` so that per-entry
failures reported in the ``Failed`` list of an HTTP-200 response are never
silently discarded.  It distinguishes:

* ``SenderFault: true``  — the entry is malformed; retrying identically will
  always fail, so these are collected as permanent failures immediately.
* ``SenderFault: false`` — throttling or a transient AWS-internal error; these
  are retried up to *max_retries* times (default 3).

After all processing the metric is emitted with the **actual** successfully
enqueued count (not the attempted count), and a ``RuntimeError`` is raised if
any items could not be enqueued so callers cannot silently report success.
"""

import json
import os
import sys

# Ensure the lambda shared module is importable when this file is used directly
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, metrics

__all__ = ["send_messages_to_queue"]

_MAX_BATCH_SIZE = 10


def _split_batches(items: list[dict]) -> list[list[dict]]:
    """Yield successive max-size slices of *items*."""
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
) -> int:
    """Send *items* to *queue_url* in batches of 10 with failure handling.

    Args:
        sqs_client:  A boto3 SQS client (or compatible mock).
        queue_url:   The SQS queue URL.
        items:       Normalised feedback dicts to enqueue.
        metric_name: CloudWatch metric name for successfully enqueued count.
        log_label:   Short label used in log messages (e.g. ``"ingestor"``).
        max_retries: Maximum number of retries for transient (non-sender-fault)
                     failures.  Defaults to 3.

    Returns:
        The number of items that were successfully enqueued.

    Raises:
        RuntimeError: If one or more items could not be enqueued after all
                      retries are exhausted, or because the entry is malformed.
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
                idx = int(failed.get("Id", 0))
                failed_item = batch[idx]
                # Use the item's own id field for logging only — never log the
                # full message body because it may contain personal data.
                item_id = str(failed_item.get("id", f"idx-{idx}"))
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
