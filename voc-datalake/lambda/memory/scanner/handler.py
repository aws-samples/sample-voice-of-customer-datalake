"""
Memory scanner (``voc-memory-scanner``) — decides WHEN memory is extracted.

Two entry points, one Lambda:

* **Schedule** (EventBridge, every 15 min): find assistant sessions in
  ``voc-conversations`` whose ``updated_at`` is older than ``IDLE_MINUTES`` (the
  session has ended) and that hold messages past their memory cursor, and
  enqueue one ``{"kind": "session"}`` message each for the extractor. Sessions
  untouched for longer than ``LOOKBACK_DAYS`` are ignored: they were either
  extracted long ago or predate memory.
* **Direct enqueue** (async invoke from the agents runtime / project chat):
  ``{"kind": "agent_run" | "project_chat", "ref", "text", "owner_sub"?, "agent_id"?}``
  is validated, bounded and forwarded to the same queue.

A session is not re-enqueued while a previous enqueue is in flight
(``enqueued_at`` on the cursor, retried after ``REENQUEUE_AFTER_MINUTES`` in case
the message was lost to the DLQ). ``voc-conversations`` has no index on
``updated_at``, so the schedule path is a filtered Scan bounded by the
invocation's remaining time; see the module report for the GSI follow-up.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.metrics import MetricUnit
from boto3.dynamodb.conditions import Attr

from shared import memory_policy as policy
from shared import memory_store as store
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics

if TYPE_CHECKING:
    from mypy_boto3_sqs.type_defs import SendMessageBatchRequestEntryTypeDef

CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', '')
# The CDK names the variable MEMORY_EXTRACT_QUEUE_URL (lib/stacks/memory-workers.ts).
MEMORY_QUEUE_URL = os.environ.get('MEMORY_EXTRACT_QUEUE_URL', '')

ASSISTANT_KIND: Final = 'assistant'
IDLE_MINUTES: Final = 30
LOOKBACK_DAYS: Final = 7
REENQUEUE_AFTER_MINUTES: Final = 120
SAFETY_MARGIN_MS: Final = 20_000
SQS_BATCH: Final = 10
USER_PK_PREFIX: Final = 'USER#'
CONV_SK_PREFIX: Final = 'CONV#'
DIRECT_KINDS: Final = ('agent_run', 'project_chat')
# SQS caps a message at 256 KiB; 60k characters of UTF-8 stays under it even
# when every character takes three bytes, with room for the envelope.
MAX_DIRECT_TEXT_CHARS: Final = 60_000
MAX_REF_CHARS: Final = 128


def get_conversations_table():
    return get_dynamodb_resource().Table(CONVERSATIONS_TABLE) if CONVERSATIONS_TABLE else None


def get_memory_table():
    return store.get_memory_table()


# ── Schedule path ────────────────────────────────────────────────────────────
def idle_sessions(table, now: datetime, time_left_ms) -> list[dict]:
    """``[{session_id, owner_sub, message_count, updated_at}]`` of ended assistant sessions."""
    idle_before = (now - timedelta(minutes=IDLE_MINUTES)).isoformat()
    not_before = (now - timedelta(days=LOOKBACK_DAYS)).isoformat()
    kwargs: dict[str, Any] = {
        'FilterExpression': (Attr('kind').eq(ASSISTANT_KIND)
                             & Attr('updated_at').lt(idle_before)
                             & Attr('updated_at').gte(not_before)),
        'ProjectionExpression': 'pk, sk, message_count, updated_at',
    }
    sessions: list[dict] = []
    while True:
        response = table.scan(**kwargs)
        for row in response.get('Items', []):
            session = _session_from_row(row)
            if session:
                sessions.append(session)
        last = response.get('LastEvaluatedKey')
        if not last:
            return sessions
        if time_left_ms() < SAFETY_MARGIN_MS:
            logger.warning('Memory scan stopped on its time budget; the rest is picked up next run')
            return sessions
        kwargs['ExclusiveStartKey'] = last


def _session_from_row(row: Mapping[str, Any]) -> dict | None:
    pk, sk = row.get('pk'), row.get('sk')
    if not (isinstance(pk, str) and isinstance(sk, str)
            and pk.startswith(USER_PK_PREFIX) and sk.startswith(CONV_SK_PREFIX)):
        return None
    try:
        count = int(row.get('message_count') or 0)
    except (TypeError, ValueError):
        count = 0
    return {
        'owner_sub': pk[len(USER_PK_PREFIX):],
        'session_id': sk[len(CONV_SK_PREFIX):],
        'message_count': count,
        'updated_at': str(row.get('updated_at') or ''),
    }


def needs_extraction(session: Mapping[str, Any], cursor: Mapping[str, Any] | None, now: datetime) -> bool:
    """True when the session has messages past its cursor and no enqueue is in flight.

    "Past its cursor" is a count mismatch: more messages than extracted, or fewer
    (the client trimmed the thread — the extractor restarts on what is there).
    An enqueue is in flight from ``enqueued_at`` until the extractor stamps a
    later ``extracted_at``; after ``REENQUEUE_AFTER_MINUTES`` it is presumed lost.
    """
    count = int(session.get('message_count') or 0)
    cursor = cursor or {}
    if count <= 0 or count == int(cursor.get('extracted_count') or 0):
        return False
    enqueued = policy.parse_datetime(cursor.get('enqueued_at'))
    if enqueued is None:
        return True
    extracted = policy.parse_datetime(cursor.get('extracted_at'))
    in_flight = extracted is None or enqueued > extracted
    return not in_flight or now - enqueued > timedelta(minutes=REENQUEUE_AFTER_MINUTES)


def _send_batch(messages: list[dict]) -> set[int]:
    """Send up to 10 messages; returns the indexes SQS accepted."""
    entries: list[SendMessageBatchRequestEntryTypeDef] = [
        {'Id': str(i), 'MessageBody': json.dumps(m)} for i, m in enumerate(messages)
    ]
    response = get_sqs_client().send_message_batch(QueueUrl=MEMORY_QUEUE_URL, Entries=entries)
    failed = {int(ident) for entry in response.get('Failed') or []
              if (ident := entry.get('Id')) and ident.isdigit()}
    if failed:
        logger.warning('Some memory messages were not accepted by SQS', extra={'failed': len(failed)})
    return set(range(len(messages))) - failed


def scan_and_enqueue(now: datetime, time_left_ms) -> dict[str, int]:
    conversations, memory_table = get_conversations_table(), get_memory_table()
    if conversations is None or memory_table is None or not MEMORY_QUEUE_URL:
        raise RuntimeError('memory scanner is not configured')
    sessions = idle_sessions(conversations, now, time_left_ms)
    cursors = store.get_cursors(memory_table, [s['session_id'] for s in sessions])
    due = [s for s in sessions if needs_extraction(s, cursors.get(s['session_id']), now)]
    enqueued = 0
    for start in range(0, len(due), SQS_BATCH):
        batch = due[start:start + SQS_BATCH]
        accepted = _send_batch(
            [{'kind': 'session', 'session_id': s['session_id'], 'owner_sub': s['owner_sub']} for s in batch])
        for index in sorted(accepted):
            session = batch[index]
            store.save_cursor(memory_table, session['session_id'],
                              {'owner_sub': session['owner_sub'], 'enqueued_at': store.now_iso(now)}, now=now)
            enqueued += 1
    if enqueued:
        metrics.add_metric(name='MemorySessionsEnqueued', unit=MetricUnit.Count, value=enqueued)
    return {'scanned': len(sessions), 'enqueued': enqueued}


# ── Direct enqueue path ──────────────────────────────────────────────────────
def direct_message(event: Mapping[str, Any]) -> dict | None:
    """The validated, bounded queue message for a direct enqueue, or None."""
    kind, ref, text = event.get('kind'), event.get('ref'), event.get('text')
    if kind not in DIRECT_KINDS:
        return None
    if not (isinstance(ref, str) and 0 < len(ref) <= MAX_REF_CHARS):
        return None
    if not (isinstance(text, str) and text.strip()):
        return None
    message: dict[str, Any] = {'kind': kind, 'ref': ref, 'text': text[-MAX_DIRECT_TEXT_CHARS:]}
    for optional in ('owner_sub', 'agent_id'):
        value = event.get(optional)
        if isinstance(value, str) and value.strip() and len(value) <= MAX_REF_CHARS:
            message[optional] = value.strip()
    return message


def enqueue_direct(event: Mapping[str, Any]) -> dict[str, Any]:
    message = direct_message(event)
    if message is None:
        logger.warning('Rejected a malformed direct memory enqueue')
        return {'enqueued': 0}
    if not MEMORY_QUEUE_URL:
        raise RuntimeError('MEMORY_QUEUE_URL is not configured')
    get_sqs_client().send_message(QueueUrl=MEMORY_QUEUE_URL, MessageBody=json.dumps(message))
    return {'enqueued': 1}


@instrumented_handler
def lambda_handler(event: object, context: Any) -> dict:
    if isinstance(event, dict) and event.get('kind') in DIRECT_KINDS:
        return enqueue_direct(event)
    return scan_and_enqueue(datetime.now(UTC), context.get_remaining_time_in_millis)
