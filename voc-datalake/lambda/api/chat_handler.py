"""
Chat API Lambda - Handles /chat/conversations/*
Stores the AI assistant's conversation sessions. The assistant itself streams at
POST /chat/stream (the TypeScript stream Lambda); the legacy non-streaming
POST /chat route this module once served is gone.

Two record shapes share ``voc-conversations`` (``pk USER#{sub}``,
``sk CONV#{id}``), both strictly scoped to the caller's Cognito subject:

- **assistant** sessions of the unified AI assistant (``kind: 'assistant'``):
  ``messages`` / ``page`` / ``pendingInterrupts`` are stored as JSON strings
  (``messages_json`` / ``page_json`` / ``pending_json``) so arbitrary AG-UI
  message objects round-trip without boto3's float/Decimal restrictions and
  each blob is one attribute.
- **legacy** chat-page records (no ``kind``) with a native ``messages`` list —
  written exactly as before so an old client keeps working, and listed as
  ``kind: 'chat'``.

The stream Lambda (``lambda/stream/src/assistant/session/``) writes the same
assistant item while a run streams, adding ``run_id`` / ``run_status``
(running|finished|failed|interrupted) / ``revision`` (a number that only grows,
time-based). The server owns a run's answer, so an SPA save may never overwrite
a newer server revision:

- refused (409) while the stored run is ``running`` and its last write is
  younger than ``STALE_RUN_SECONDS`` (an older one is a dead run);
- refused (409) when the stored ``revision`` is newer than the save's
  ``baseRevision`` (the revision the client last saw: the stream's
  ``assistant.session`` event, or a GET);
- otherwise written with a condition on the revision read, so a server write
  landing in between still wins; the run fields are carried over unchanged.
"""

import json
import os
import re
import sys
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.api import api_handler, create_api_resolver, get_caller_subject
from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError, ConflictError, PayloadTooLargeError, ValidationError
from shared.logging import logger, tracer
from shared.request_body import json_body_value

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
CONVERSATIONS_TABLE = os.environ.get("CONVERSATIONS_TABLE", "")

conversations_table = dynamodb.Table(CONVERSATIONS_TABLE) if CONVERSATIONS_TABLE else None

app = create_api_resolver()


# ============================================
# Chat Conversations Endpoints
# ============================================

ASSISTANT_KIND = 'assistant'
LEGACY_KIND = 'chat'
CONVERSATION_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
DEFAULT_ASSISTANT_TITLE = 'New conversation'
MAX_TITLE_CHARS = 120
MAX_MESSAGES = 300
MAX_PENDING_INTERRUPTS = 20
# DynamoDB's hard item limit is 400 KB; stay well under it so attribute-name
# overhead and the estimate below can never tip a write into a 400 error.
MAX_ITEM_BYTES = 350_000
# The path segment the pre-assistant client posted a new or body-identified conversation to.
LEGACY_NEW_PATH_ID = 'new'
LIST_LIMIT = 100
# LOCKSTEP with STALE_RUN_SECONDS in lambda/stream/src/assistant/contract.ts: a
# stored `running` run whose last write is older than this is dead (the stream
# Lambda times out at 300 s and writes at every tool boundary).
STALE_RUN_SECONDS = 360
RUN_STATUS_RUNNING = 'running'
RUN_STATUSES = ('running', 'finished', 'failed', 'interrupted')
# Server-owned attributes an SPA save carries over unchanged.
_RUN_FIELDS = ('run_id', 'run_status', 'revision')
# Everything the list view needs, and nothing it doesn't: the JSON blobs (and
# a legacy record's native `messages` list) are what make items large.
# `messages` is projected for legacy items only so their count can be reported;
# assistant items never carry that attribute.
_LIST_PROJECTION = '#cid, #title, #kind, #mc, #created, #updated, #msgs, #rs'
_LIST_PROJECTION_NAMES = {
    '#cid': 'conversation_id',
    '#title': 'title',
    '#kind': 'kind',
    '#mc': 'message_count',
    '#created': 'created_at',
    '#updated': 'updated_at',
    '#msgs': 'messages',
    '#rs': 'run_status',
}


# Fixed text: the requested id is never echoed back into a response.
CONVERSATION_NOT_FOUND = 'Conversation not found'


def _require_valid_conversation_id(conversation_id: str) -> None:
    """Reject ids outside CONVERSATION_ID_PATTERN as not found.

    Legacy ids (``conv-<timestamp>``) and assistant ids both match the pattern,
    so valid records stay reachable; anything else cannot name a stored record
    this API would write, and gets the same answer as a missing one.
    """
    if not CONVERSATION_ID_PATTERN.fullmatch(conversation_id):
        raise NotFoundError(CONVERSATION_NOT_FOUND)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _conversations_store():
    """The conversations table, for the helpers the routes call once they have
    checked it is configured (so this raise is the backstop, not the answer)."""
    if conversations_table is None:
        raise ConfigurationError('Conversations not configured')
    return conversations_table


def _caller_pk() -> str:
    return f"USER#{get_caller_subject(app.current_event.raw_event)}"


def _is_iso_timestamp(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _validated_assistant_title(raw: object) -> str:
    if raw is None:
        return DEFAULT_ASSISTANT_TITLE
    if not isinstance(raw, str):
        raise ValidationError('title must be a string')
    title = raw.strip()
    if not title:
        return DEFAULT_ASSISTANT_TITLE
    if len(title) > MAX_TITLE_CHARS:
        raise ValidationError(f'title must be at most {MAX_TITLE_CHARS} characters')
    return title


def _validated_object_list(
    raw: object, field: str, limit: int, too_many: type[Exception] = ValidationError,
) -> list:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(entry, dict) for entry in raw):
        raise ValidationError(f'{field} must be a list of objects')
    if len(raw) > limit:
        raise too_many(f'{field} must contain at most {limit} entries')
    return raw


def _validated_assistant_body(proxy: str, body: dict) -> dict:
    """Validate an assistant-session save; returns the normalised fields."""
    conversation_id = _body_id_matching_path(body.get('id'), proxy)
    page = body.get('page')
    if page is not None and not isinstance(page, dict):
        raise ValidationError('page must be an object or null')
    created_at = body.get('createdAt')
    if created_at is not None and not _is_iso_timestamp(created_at):
        raise ValidationError('createdAt must be an ISO-8601 timestamp')
    base_revision = body.get('baseRevision', 0)
    if isinstance(base_revision, bool) or not isinstance(base_revision, int) or base_revision < 0:
        raise ValidationError('baseRevision must be a non-negative integer')
    return {
        'base_revision': base_revision,
        'id': conversation_id,
        'title': _validated_assistant_title(body.get('title')),
        # Too many messages is a size problem, not a malformed body: 413 lets the
        # client's trim-and-retry path shorten the thread instead of giving up.
        'messages': _validated_object_list(
            body.get('messages'), 'messages', MAX_MESSAGES, too_many=PayloadTooLargeError,
        ),
        'page': page,
        'pending': _validated_object_list(
            body.get('pendingInterrupts'), 'pendingInterrupts', MAX_PENDING_INTERRUPTS,
        ),
        'created_at': created_at,
    }


def _estimated_item_bytes(item: dict) -> int:
    """Upper-bound estimate of the stored item size (UTF-8 names + values)."""
    return len(json.dumps(item, ensure_ascii=False, default=str).encode('utf-8'))


def _valid_conversation_id(conversation_id: object) -> str:
    """`conversation_id`, when it matches CONVERSATION_ID_PATTERN."""
    if not isinstance(conversation_id, str) or not CONVERSATION_ID_PATTERN.fullmatch(conversation_id):
        raise ValidationError('id must match ^[A-Za-z0-9_-]{1,64}$')
    return conversation_id


def _body_id_matching_path(conversation_id: object, path_id: str) -> str:
    """The body's id, when it is a valid conversation id equal to the one in the path."""
    valid = _valid_conversation_id(conversation_id)
    if valid != path_id.strip():
        raise ValidationError('id must equal the conversation id in the path')
    return valid


def _require_fits(item: dict) -> None:
    """Refuse an item DynamoDB would reject (400 KB), with a margin, as 413."""
    if _estimated_item_bytes(item) > MAX_ITEM_BYTES:
        raise PayloadTooLargeError(
            f'Conversation is too large to save (limit about {MAX_ITEM_BYTES} bytes); '
            'start a new conversation'
        )


def _existing_state(caller_pk: str, conversation_id: str) -> dict:
    """The stored item's created_at and server-owned run fields ({} when absent)."""
    response = _conversations_store().get_item(
        Key={'pk': caller_pk, 'sk': f'CONV#{conversation_id}'},
        ProjectionExpression='#created, #updated, #rid, #rs, #rev',
        ExpressionAttributeNames={
            '#created': 'created_at', '#updated': 'updated_at',
            '#rid': 'run_id', '#rs': 'run_status', '#rev': 'revision',
        },
    )
    return response.get('Item') or {}


def _revision_of(item: dict) -> int:
    raw = item.get('revision')
    # boto3 hands numbers back as Decimal.
    return int(raw) if isinstance(raw, (int, Decimal)) and not isinstance(raw, bool) else 0


def _run_is_live(item: dict) -> bool:
    """A stored run still streaming: `running` and written within STALE_RUN_SECONDS."""
    if item.get('run_status') != RUN_STATUS_RUNNING:
        return False
    updated = item.get('updated_at')
    if not _is_iso_timestamp(updated):
        return False
    age = datetime.now(UTC) - datetime.fromisoformat(str(updated))
    return age.total_seconds() < STALE_RUN_SECONDS


def _require_no_newer_server_revision(existing: dict, base_revision: int) -> None:
    """The server owns a run's answer: refuse a save that would overwrite it (409)."""
    if _run_is_live(existing):
        raise ConflictError('A reply is still being generated for this conversation')
    if _revision_of(existing) > base_revision:
        raise ConflictError('The conversation has a newer saved revision; reload it first')


def _put_unless_revised(item: dict, existing: dict) -> None:
    """Put, conditional on the revision read still being the stored one."""
    if 'revision' in existing:
        condition = {
            'ConditionExpression': '#rev = :rev',
            'ExpressionAttributeNames': {'#rev': 'revision'},
            'ExpressionAttributeValues': {':rev': existing['revision']},
        }
    else:
        condition = {
            'ConditionExpression': 'attribute_not_exists(#rev)',
            'ExpressionAttributeNames': {'#rev': 'revision'},
        }
    try:
        _conversations_store().put_item(Item=item, **condition)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise ConflictError('The conversation has a newer saved revision; reload it first') from error
        raise


def _save_assistant_conversation(caller_pk: str, proxy: str, body: dict) -> dict:
    fields = _validated_assistant_body(proxy, body)
    now = _now_iso()
    existing = _existing_state(caller_pk, fields['id'])
    _require_no_newer_server_revision(existing, fields['base_revision'])
    stored_created = existing.get('created_at')
    created_at = (
        (stored_created if isinstance(stored_created, str) and stored_created else None)
        or fields['created_at'] or now
    )
    item = {
        'pk': caller_pk,
        'sk': f"CONV#{fields['id']}",
        'conversation_id': fields['id'],
        'kind': ASSISTANT_KIND,
        'title': fields['title'],
        'messages_json': json.dumps(fields['messages'], ensure_ascii=False, separators=(',', ':')),
        'page_json': json.dumps(fields['page'], ensure_ascii=False, separators=(',', ':')),
        'pending_json': json.dumps(fields['pending'], ensure_ascii=False, separators=(',', ':')),
        'message_count': len(fields['messages']),
        'created_at': created_at,
        'updated_at': now,
        **{field: existing[field] for field in _RUN_FIELDS if field in existing},
    }
    _require_fits(item)
    _put_unless_revised(item, existing)
    return {'success': True, 'id': fields['id'], 'updatedAt': now, 'revision': _revision_of(existing)}


def _run_fields(item: dict) -> dict:
    """The server-owned run state as the SPA reads it (null status = never streamed server-side)."""
    status = item.get('run_status')
    return {
        'runStatus': status if status in RUN_STATUSES else None,
        'runId': item.get('run_id') if isinstance(item.get('run_id'), str) else None,
        'revision': _revision_of(item),
    }


def _decode_json_blob(raw: object, fallback):
    """Decode a stored JSON blob; a corrupt value degrades to the fallback."""
    if not isinstance(raw, str):
        return fallback
    try:
        return json.loads(raw)
    except ValueError:
        logger.warning('Stored conversation blob is not valid JSON; returning a fallback')
        return fallback


def _conversation_detail(item: dict) -> dict:
    if item.get('kind') == ASSISTANT_KIND:
        messages = _decode_json_blob(item.get('messages_json'), [])
        page = _decode_json_blob(item.get('page_json'), None)
        pending = _decode_json_blob(item.get('pending_json'), [])
        return {
            'id': item.get('conversation_id'),
            'title': item.get('title', DEFAULT_ASSISTANT_TITLE),
            'kind': ASSISTANT_KIND,
            'messages': messages if isinstance(messages, list) else [],
            'page': page if isinstance(page, dict) else None,
            'pendingInterrupts': pending if isinstance(pending, list) else [],
            'createdAt': item.get('created_at'),
            'updatedAt': item.get('updated_at'),
            **_run_fields(item),
        }
    # Legacy chat-page record: keep every field the old client reads, and
    # add the assistant shape's keys so one reader handles both.
    return {
        'id': item.get('conversation_id'),
        'title': item.get('title', 'New Conversation'),
        'kind': LEGACY_KIND,
        'messages': item.get('messages', []),
        'filters': item.get('filters', {}),
        'page': None,
        'pendingInterrupts': [],
        'createdAt': item.get('created_at'),
        'updatedAt': item.get('updated_at'),
    }


def _conversation_summary(item: dict) -> dict:
    is_assistant = item.get('kind') == ASSISTANT_KIND
    if is_assistant:
        count = item.get('message_count', 0)
        # boto3 hands numbers back as Decimal.
        message_count = int(count) if isinstance(count, (int, Decimal)) else 0
    else:
        messages = item.get('messages', [])
        message_count = len(messages) if isinstance(messages, list) else 0
    return {
        'id': item.get('conversation_id'),
        'title': item.get('title', DEFAULT_ASSISTANT_TITLE if is_assistant else 'New Conversation'),
        'kind': ASSISTANT_KIND if is_assistant else LEGACY_KIND,
        'messageCount': message_count,
        'createdAt': item.get('created_at'),
        'updatedAt': item.get('updated_at'),
        'runStatus': item.get('run_status') if item.get('run_status') in RUN_STATUSES else None,
    }


def _list_conversations(caller_pk: str, kind: str | None) -> dict:
    """Every conversation of the caller (paginated Query), newest first.

    Sorted by ``updatedAt`` rather than by key: the sort key is the id, which
    says nothing about recency.
    """
    summaries = []
    query_kwargs = {
        'KeyConditionExpression': Key('pk').eq(caller_pk),
        'ProjectionExpression': _LIST_PROJECTION,
        'ExpressionAttributeNames': _LIST_PROJECTION_NAMES,
    }
    while True:
        response = _conversations_store().query(**query_kwargs)
        summaries.extend(_conversation_summary(item) for item in response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
        query_kwargs['ExclusiveStartKey'] = last_key
    if kind:
        summaries = [summary for summary in summaries if summary['kind'] == kind]
    summaries.sort(key=lambda summary: summary.get('updatedAt') or '', reverse=True)
    return {'conversations': summaries[:LIST_LIMIT]}


# The routes name the segment `<conversation_id>`, not API Gateway's `{proxy+}`:
# Powertools only recognises `<\w+>` as a dynamic segment, so the `<proxy+>`
# spelling these routes used to carry matched no request at all and every call
# through `lambda_handler` answered 404. API Gateway still fronts them with a
# `{proxy+}` resource; Powertools matches the request PATH, so the one segment
# after `/chat/conversations/` arrives here as `conversation_id`.
@app.get("/chat/conversations/<conversation_id>")
@tracer.capture_method
def get_conversations(conversation_id: str = ""):
    """List (``_list[?kind=assistant|chat]``) or get one of the caller's conversations."""
    # Identity is resolved before the table check on purpose: whether the caller
    # is allowed to ask must not depend on whether the resource happens to be
    # configured. Reversing these two lines hands a 200 to a caller with no
    # subject claim whenever the table is unset.
    caller_pk = _caller_pk()
    if not conversations_table:
        # Deliberately softer than the write paths, which raise ConfigurationError:
        # a deployment without the conversations table has no history to show, and
        # "no conversations" is the truthful answer to that read. A write, by
        # contrast, cannot be honoured at all, so it must fail loudly rather than
        # report success for data it silently dropped.
        return {'conversations': []}
    requested = conversation_id.strip() if conversation_id and conversation_id != '_list' else None

    if requested:
        _require_valid_conversation_id(requested)
        response = conversations_table.get_item(Key={'pk': caller_pk, 'sk': f'CONV#{requested}'})
        item = response.get('Item')
        if not item:
            raise NotFoundError(CONVERSATION_NOT_FOUND)
        return _conversation_detail(item)

    params = app.current_event.query_string_parameters or {}
    kind = params.get('kind')
    if kind is not None and kind not in (ASSISTANT_KIND, LEGACY_KIND):
        raise ValidationError(f"kind must be '{ASSISTANT_KIND}' or '{LEGACY_KIND}'")
    return _list_conversations(caller_pk, kind)


@app.post("/chat/conversations/<conversation_id>")
@tracer.capture_method
def save_conversation(conversation_id: str = ""):
    """Save a chat conversation (assistant session when ``kind`` is set)."""
    caller_pk = _caller_pk()
    if not conversations_table:
        raise ConfigurationError('Conversations not configured')
    body = json_body_value(app)
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    if 'kind' in body:
        if body.get('kind') != ASSISTANT_KIND:
            raise ValidationError(f"kind must be '{ASSISTANT_KIND}'")
        return _save_assistant_conversation(caller_pk, conversation_id, body)
    return _save_legacy_conversation(caller_pk, conversation_id, body)


def _save_legacy_conversation(caller_pk: str, path_id: str, body: dict) -> dict:
    """The pre-assistant save, in its old item shape.

    Its id is held to the same pattern as an assistant save (or GET/DELETE could
    never reach the record again) and the item must fit MAX_ITEM_BYTES. The old
    client posted to `/chat/conversations/new` with the id in the body (or none, for
    a server-made `conv-<timestamp>`); any other path id must equal the body's.
    """
    if path_id == LEGACY_NEW_PATH_ID:
        generated = f"conv-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}"
        conversation_id = _valid_conversation_id(body.get('id', generated))
    else:
        conversation_id = _body_id_matching_path(body.get('id', path_id), path_id)

    item = {
        'pk': caller_pk,
        'sk': f'CONV#{conversation_id}',
        'conversation_id': conversation_id,
        'title': body.get('title', 'New Conversation'),
        'messages': body.get('messages', []),
        'filters': body.get('filters', {}),
        'created_at': body.get('createdAt') or datetime.now(UTC).isoformat(),
        'updated_at': datetime.now(UTC).isoformat(),
    }
    _require_fits(item)

    _conversations_store().put_item(Item=item)
    return {'success': True, 'id': conversation_id}


@app.delete("/chat/conversations/<conversation_id>")
@tracer.capture_method
def delete_conversation(conversation_id: str):
    """Delete a chat conversation."""
    caller_pk = _caller_pk()
    if not conversations_table:
        raise ConfigurationError('Conversations table not configured')
    _require_valid_conversation_id(conversation_id)
    conversations_table.delete_item(Key={'pk': caller_pk, 'sk': f'CONV#{conversation_id}'})
    return {'success': True}



# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
