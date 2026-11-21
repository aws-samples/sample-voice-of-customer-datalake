"""Sending queue messages ten at a time (SendMessageBatch), the one loop of the API's batch producers: the manual
import's CSV and JSON uploads (lambda/api/manual_import_handler.py) and an imported form's rows (7.67.00,
lambda/api/feedback_form_handler.py).

Batching cuts the SQS round trips about tenfold against one ``send_message`` per message, so thousands of messages
enqueue well within the API Gateway's 29 s. A failed entry is reported under its message's number (``{label} {n}``,
from ``first``), a batch the queue refused as a whole under its range (``{label}s {a}-{b}``) and logged; nothing raises.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger

if TYPE_CHECKING:
    from mypy_boto3_sqs.type_defs import SendMessageBatchRequestEntryTypeDef

__all__ = ['BATCH_SIZE', 'send_batches']

BATCH_SIZE = 10


def send_batches(sqs: Any, queue_url: str, bodies: Sequence[str], *, label: str = 'row',
                 first: int = 0) -> tuple[int, list[str]]:
    """Send ``bodies`` to ``queue_url`` ten a call; ``(how many the queue took, one line per failure)``. Messages are
    numbered from ``first`` in the failure lines."""
    sent = 0
    errors: list[str] = []
    for start in range(0, len(bodies), BATCH_SIZE):
        chunk = bodies[start:start + BATCH_SIZE]
        entries: list[SendMessageBatchRequestEntryTypeDef] = [
            {'Id': str(i), 'MessageBody': body} for i, body in enumerate(chunk)]
        try:
            response = sqs.send_message_batch(QueueUrl=queue_url, Entries=entries)
        except (ClientError, BotoCoreError) as e:
            logger.warning(f"Failed to send SQS batch at {label} {start + first}: {e}")
            errors.append(f"{label}s {start + first}-{start + first + len(chunk) - 1}: {e!s}")
            continue
        sent += len(response.get('Successful', []))
        errors.extend(f"{label} {start + first + int(failed.get('Id', 0))}: {failed.get('Message', 'send failed')}"
                      for failed in response.get('Failed', []))
    return sent, errors
