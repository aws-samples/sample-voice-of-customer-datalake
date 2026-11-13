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
the message was lost to the DLQ). The schedule path reads only the window: a Query
of ``voc-conversations``' ``kind`` / ``updated_at`` index
(``CONVERSATIONS_BY_KIND_INDEX``), paged and bounded by the invocation's remaining
time, so its cost follows the sessions active in the last ``LOOKBACK_DAYS``, not
every conversation ever stored (TENETS.md tenet 7; until 6.04.00 it was a filtered
Scan of the whole table). Both conversation writers already store ``kind`` and
``updated_at``, and DynamoDB indexes the existing items when the index is added,
so no session is missed across the upgrade.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.metrics import MetricUnit
from boto3.dynamodb.conditions import Key

from shared import memory_policy as policy
from shared import memory_store as store
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.conversations import ASSISTANT_KIND, CONVERSATION_SK_PREFIX, USER_PARTITION_PREFIX
from shared.indexes import CONVERSATIONS_BY_KIND_INDEX
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.timestamps import now_iso
from shared.warm_init import warm_at_init
from shared.workspace import is_active
from shared.ws_repo import WorkspaceScope, partition_scope

if TYPE_CHECKING:
    from mypy_boto3_sqs.type_defs import SendMessageBatchRequestEntryTypeDef

CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', '')
# The CDK names the variable MEMORY_EXTRACT_QUEUE_URL (lib/stacks/memory-workers.ts).
MEMORY_QUEUE_URL = os.environ.get('MEMORY_EXTRACT_QUEUE_URL', '')
# voc-workspaces: whether a workspace whose sessions are idle is still active (shared/workspace.py ``is_active``).
WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')

IDLE_MINUTES: Final = 30
LOOKBACK_DAYS: Final = 7
REENQUEUE_AFTER_MINUTES: Final = 120
SAFETY_MARGIN_MS: Final = 20_000
SQS_BATCH: Final = 10
DIRECT_KINDS: Final = ('agent_run', 'project_chat')
# SQS caps a message at 256 KiB; 60k characters of UTF-8 stays under it even
# when every character takes three bytes, with room for the envelope.
MAX_DIRECT_TEXT_CHARS: Final = 60_000
MAX_REF_CHARS: Final = 128


def _table(name: str):
    """The table ``name`` names, or None when the stack set no name (the caller says what is not configured)."""
    if not name:
        return None
    return get_dynamodb_resource().Table(name)


def get_conversations_table():
    return _table(CONVERSATIONS_TABLE)


# ── Schedule path ────────────────────────────────────────────────────────────
def idle_sessions(table, now: datetime, time_left_ms) -> list[dict]:
    """``[{session_id, owner_sub, message_count, updated_at}]`` of ended assistant sessions.

    ``not_before <= updated_at < idle_before``: the key range is inclusive at both ends, so a
    session stamped exactly ``idle_before`` is dropped here, as the Scan's ``lt`` did.
    """
    idle_before = (now - timedelta(minutes=IDLE_MINUTES)).isoformat()
    not_before = (now - timedelta(days=LOOKBACK_DAYS)).isoformat()
    kwargs: dict[str, Any] = {
        'IndexName': CONVERSATIONS_BY_KIND_INDEX,
        'KeyConditionExpression': Key('kind').eq(ASSISTANT_KIND) & Key('updated_at').between(not_before, idle_before),
        'ProjectionExpression': 'pk, sk, message_count, updated_at',
    }
    sessions: list[dict] = []
    while True:
        response = table.query(**kwargs)
        for row in response.get('Items', []):
            if row.get('updated_at') == idle_before:
                continue  # not yet idle: the window is idle_before exclusive
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


def _owner(pk: str) -> tuple[WorkspaceScope | None, str] | None:
    """``(workspace, owner_sub)`` of a conversation partition: a person's own (``USER#{sub}``), or theirs inside a
    workspace (``WS#{ws}#USER#{sub}``, shared/conversations.py); None for anything else (a malformed workspace key
    included: it is never mined as the deployment's)."""
    if pk.startswith(USER_PARTITION_PREFIX):
        return None, pk[len(USER_PARTITION_PREFIX):]
    try:
        workspace = partition_scope(pk)
    except ValueError:
        return None
    if workspace is None:
        return None
    rest = pk[len(workspace.prefix):]
    return (workspace, rest[len(USER_PARTITION_PREFIX):]) if rest.startswith(USER_PARTITION_PREFIX) else None


def _session_from_row(row: Mapping[str, Any]) -> dict | None:
    pk, sk = row.get('pk'), row.get('sk')
    if not (isinstance(pk, str) and isinstance(sk, str) and sk.startswith(CONVERSATION_SK_PREFIX)):
        return None
    owner = _owner(pk)
    if owner is None or not owner[1]:
        return None
    try:
        count = int(row.get('message_count') or 0)
    except (TypeError, ValueError):
        count = 0
    session = {
        'owner_sub': owner[1],
        'session_id': sk[len(CONVERSATION_SK_PREFIX):],
        'message_count': count,
        'updated_at': str(row.get('updated_at') or ''),
    }
    return session if owner[0] is None else {**session, 'workspace': owner[0]}


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


def _cursor_id(session: Mapping[str, Any]) -> tuple[str | None, str]:
    """A session's cursor, by its workspace and id (one session id can be in two workspaces)."""
    workspace = session.get('workspace')
    return (None if workspace is None else workspace.ws, str(session['session_id']))


def _cursors(memory_table, sessions: list[dict]) -> dict[tuple[str | None, str], dict]:
    """Every session's cursor: the deployment's in one batch read, each workspace's in its own partition."""
    by_workspace: dict[str | None, tuple[WorkspaceScope | None, list[str]]] = {}
    for session in sessions:
        workspace = session.get('workspace')
        key = None if workspace is None else workspace.ws
        by_workspace.setdefault(key, (workspace, []))[1].append(str(session['session_id']))
    found: dict[tuple[str | None, str], dict] = {}
    for key, (workspace, ids) in by_workspace.items():
        for session_id, cursor in store.get_cursors(memory_table, ids, **store.workspace_kwargs(workspace)).items():
            found[(key, session_id)] = cursor
    return found


def _in_active_workspaces(sessions: list[dict]) -> list[dict]:
    """The sessions to consider: the deployment's, and a workspace's only while it is active (one strongly consistent
    read per workspace), so a workspace being deleted gets no cursor and no message again (its rows are being swept).
    A workspace whose read fails is left for the next run (logged and counted): it never stops the deployment's scan
    or another workspace's."""
    workspaces = {session['workspace'].ws for session in sessions if session.get('workspace') is not None}
    if not workspaces:
        return sessions
    table = get_workspaces_table()
    active = set() if table is None else {ws for ws in workspaces if _active(table, ws)}
    if table is None:
        logger.error('WORKSPACES_TABLE is not configured; workspace sessions are left for a later run')
    if left := len(workspaces) - len(active):
        metrics.add_metric(name='MemoryScanWorkspacesSkipped', unit=MetricUnit.Count, value=left)
    return [s for s in sessions if s.get('workspace') is None or s['workspace'].ws in active]


def get_workspaces_table():
    return _table(WORKSPACES_TABLE)


def _active(table, ws: str) -> bool:
    try:
        return is_active(table, ws)
    except Exception:  # noqa: BLE001 - one workspace's read fault waits for the next run, see _in_active_workspaces
        logger.warning('A workspace could not be read; its sessions are left for the next run', extra={'workspace_id': ws})
        return False


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
    conversations, memory_table = get_conversations_table(), store.get_memory_table()
    if conversations is None or memory_table is None or not MEMORY_QUEUE_URL:
        raise RuntimeError('memory scanner is not configured')
    sessions = _in_active_workspaces(idle_sessions(conversations, now, time_left_ms))
    cursors = _cursors(memory_table, sessions)
    due = [s for s in sessions if needs_extraction(s, cursors.get(_cursor_id(s)), now)]
    enqueued = 0
    for start in range(0, len(due), SQS_BATCH):
        batch = due[start:start + SQS_BATCH]
        accepted = _send_batch(
            [store.session_message(s['session_id'], s['owner_sub'], s.get('workspace')) for s in batch])
        for index in sorted(accepted):
            session = batch[index]
            store.save_cursor(memory_table, session['session_id'],
                              {'owner_sub': session['owner_sub'], 'enqueued_at': now_iso(now)}, now=now,
                              **store.workspace_kwargs(session.get('workspace')))
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


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_sqs_client)


@instrumented_handler
def lambda_handler(event: object, context: Any) -> dict:
    if isinstance(event, dict) and event.get('kind') in DIRECT_KINDS:
        return enqueue_direct(event)
    return scan_and_enqueue(datetime.now(UTC), context.get_remaining_time_in_millis)
