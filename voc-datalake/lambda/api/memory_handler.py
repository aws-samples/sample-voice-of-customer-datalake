"""
Memory API Lambda (``voc-memory-api``) — every ``/memory`` route.

Who may do what:

* **Company** memories are visible to every signed-in user (§0 M7). Curating
  them — adding live, editing, forgetting, restoring, merging, resolving the
  review queue, importing pages — needs a *curator*: a workspace admin or a user
  with the ``memory_reviewer`` flag (``USERFLAGS#{sub}`` / ``config`` in the
  aggregates table). A non-curator's company add is stored as ``proposed``.
  Anyone may ``confirm`` (+1) a company memory.
* **Personal** memories are their owner's only. Admins see counts, never
  content (``GET /memory/stats``). A personal id is only ever looked up under the
  caller's own partition, so another user's memory is a 404, not a 403.
* **Delegated** principals (MCP tokens, ``agent:`` principals) may read
  (``retrieve``, ``conflict-check``) company memory only and write nothing.

``POST /memory/retrieve`` and ``GET /memory/conflict-check`` are internal: the
stream assistant and the agents runtime call them with the end user's claims.
Statements are screened (``memory_policy.clean_statement``) on every write;
an instruction-shaped statement is a 400. Subjects and content are never logged.
"""

import json
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aws_lambda_powertools.event_handler import Response, content_types

from shared import memory_policy as policy
from shared import memory_store as store
from shared import user_flags
from shared.api import api_handler, create_api_resolver, validate_int
from shared.aws import get_dynamodb_resource, get_s3_client, get_sqs_client
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_caller
from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    ServiceError,
    ValidationError,
)
from shared.logging import logger, tracer
from shared.project_access import Caller
from shared.project_gate import caller_from_event
from shared.request_body import json_body_value
from shared.snapstart import api_route_warmer, register_snapshot_hooks

AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
# The CDK names the variable MEMORY_EXTRACT_QUEUE_URL (lib/stacks/api-stack.ts).
MEMORY_QUEUE_URL = os.environ.get('MEMORY_EXTRACT_QUEUE_URL', '')

MEMORY_NOT_FOUND = 'Memory not found'
IMPORT_NOT_FOUND = 'Import not found'
MAX_QUERY_CHARS = 4_000
MAX_TITLE_CHARS = 200
MAX_URL_CHARS = 2_000
DEFAULT_PAGE = 50
MAX_PAGE = 100
MAX_IMPORTS_LISTED = 50
MAX_REVIEW_ITEMS = 200
IMPORT_PREFIX = 'memory-imports/'
_REFUSAL_MESSAGES = {
    'not_text': 'statement must be a string',
    'injection': 'statement reads like an instruction to the assistant and cannot be stored',
    'profanity': 'statement contains language that cannot be stored',
    'judgment': 'statement contains a judgment about a person and cannot be stored',
    'too_short': f'statement must be {policy.MIN_STATEMENT_CHARS}-{policy.MAX_STATEMENT_CHARS} characters',
}

app = create_api_resolver()


# ── Tables + caller ──────────────────────────────────────────────────────────
def get_memory_table():
    table = store.get_memory_table()
    if table is None:
        raise ConfigurationError('Memory is not configured')
    return table


def get_aggregates_table():
    return get_dynamodb_resource().Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None


def _now() -> datetime:
    return datetime.now(UTC)


def _caller() -> Caller:
    return caller_from_event(app.current_event.raw_event)


def _category_scope(caller: Caller) -> CategoryScope:
    """The feedback categories ``caller`` may see — company memories about any
    other category are hidden, like the reviews they were learned from.
    Fails closed (ServiceError) when access cannot be verified."""
    return scope_for_caller(caller, get_aggregates_table())


def _person(caller: Caller) -> Caller:
    """A real signed-in person (not a delegated credential), or 403."""
    if caller.delegated or not caller.subject:
        raise AuthorizationError('Memory writes need a signed-in user')
    return caller


def is_curator(caller: Caller) -> bool:
    """Admin, or a user flagged ``memory_reviewer``. A failed flag read is "no"."""
    if caller.delegated or not caller.subject:
        return False
    if caller.is_admin:
        return True
    aggregates = get_aggregates_table()
    if aggregates is None:
        return False
    try:
        return user_flags.is_memory_reviewer(aggregates, caller.subject)
    except Exception:  # noqa: BLE001 - fail closed: no curation on a read failure
        logger.warning('User flags read failed; treating the caller as a non-curator')
        return False


def _require_curator(caller: Caller) -> None:
    if not is_curator(caller):
        raise AuthorizationError('Only admins and memory reviewers can do this')


def _require_admin(caller: Caller) -> None:
    if caller.delegated or not caller.is_admin:
        raise AuthorizationError('Admin access required')


def _body() -> dict:
    """The request body as an object. Unparseable JSON is the shared helper's
    400; a body that parses to a non-object keeps this API's own wording."""
    body = json_body_value(app)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    return body


def _params() -> dict:
    return app.current_event.query_string_parameters or {}


# ── Validation ───────────────────────────────────────────────────────────────
def _choice(value: object, allowed: tuple, field: str, default: str | None = None) -> str | None:
    if value in (None, ''):
        return default
    if not isinstance(value, str) or value not in allowed:
        raise ValidationError(f"{field} must be one of: {', '.join(allowed)}")
    return value


def _statement(value: object) -> str:
    if isinstance(value, str) and len(value) > policy.MAX_STATEMENT_CHARS:
        raise ValidationError(f'statement must be at most {policy.MAX_STATEMENT_CHARS} characters')
    cleaned = policy.clean_statement(value)
    if cleaned.statement is None:
        raise ValidationError(_REFUSAL_MESSAGES.get(str(cleaned.reason), 'statement cannot be stored'))
    return cleaned.statement


def _categories(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > policy.MAX_CATEGORIES_PER_MEMORY:
        raise ValidationError(f'categories must be a list of at most {policy.MAX_CATEGORIES_PER_MEMORY} names')
    return policy.normalise_categories(value)


def _retention(body: dict, kind: str, today) -> tuple[str, str | None]:
    retention = _choice(body.get('retention'), policy.RETENTIONS, 'retention')
    expires_at = body.get('expires_at')
    if expires_at not in (None, ''):
        expiry = policy.parse_iso_date(expires_at)
        if expiry is None or expiry <= today:
            raise ValidationError('expires_at must be a future date (YYYY-MM-DD)')
    return policy.resolve_retention(kind, retention, expires_at, today)


def _memory_or_404(memory_id: str, caller: Caller) -> dict:
    item = store.locate(get_memory_table(), memory_id, caller.subject or None)
    if item is None:
        raise NotFoundError(MEMORY_NOT_FOUND)
    return item


def _require_can_edit(item: Mapping[str, Any], caller: Caller) -> None:
    """Company → curator; personal → its owner (``locate`` only finds the caller's own)."""
    _person(caller)
    if item.get('scope') == policy.SCOPE_COMPANY:
        _require_curator(caller)


def _view(item: dict) -> dict:
    return {'memory': store.public_view(item)}


# ── Listing + stats ──────────────────────────────────────────────────────────
@app.get('/memory')
@tracer.capture_method
def list_memories():
    caller = _caller()
    params = _params()
    scope = _choice(params.get('scope'), policy.SCOPES, 'scope', policy.SCOPE_COMPANY)
    status = _choice(params.get('status'), policy.STATUSES, 'status', policy.STATUS_ACTIVE)
    kind = _choice(params.get('kind'), policy.KINDS, 'kind')
    q = (params.get('q') or '').strip()[:200] or None
    limit = validate_int(params.get('limit'), default=DEFAULT_PAGE, min_val=1, max_val=MAX_PAGE)
    table = get_memory_table()
    if scope == policy.SCOPE_COMPANY:
        if status == policy.STATUS_ARCHIVED and not is_curator(caller):
            # Archived includes forgotten (tombstoned) statements: curators only.
            raise AuthorizationError('Only admins and memory reviewers can see archived company memories')
        start = store.decode_page_token(params.get('cursor'), store.COMPANY_PAGE_KEYS)
        rows, last = store.list_company(table, str(status), kind=kind, q=q, limit=limit, start_key=start)
        categories = _category_scope(caller)
        visible = [r for r in rows if store.visible_to(categories, r)]
        return {'items': [store.public_view(r) for r in visible], 'next_cursor': store.encode_page_token(last)}
    person = _person(caller)
    offset_token = store.decode_page_token(params.get('cursor'), frozenset({'o'}))
    offset = validate_int((offset_token or {}).get('o'), default=0, min_val=0, max_val=1_000_000)
    rows = store.list_personal(table, person.subject, str(status), kind=kind, q=q)
    page = rows[offset:offset + limit]
    more = offset + limit < len(rows)
    return {'items': [store.public_view(r) for r in page],
            'next_cursor': store.encode_page_token({'o': str(offset + limit)}) if more else None}


@app.get('/memory/stats')
@tracer.capture_method
def memory_stats():
    _require_admin(_caller())
    table = get_memory_table()
    return {scope: {status: store.count_status(table, scope, status) for status in policy.STATUSES}
            for scope in policy.SCOPES}


# ── Add + edit ───────────────────────────────────────────────────────────────
@app.post('/memory')
@tracer.capture_method
def add_memory():
    caller = _person(_caller())
    body = _body()
    now = _now()
    scope = _choice(body.get('scope'), policy.SCOPES, 'scope')
    if scope is None:
        raise ValidationError('scope is required')
    statement = _statement(body.get('statement'))
    kind = _choice(body.get('kind'), policy.KINDS, 'kind') or 'other'
    retention, expires_at = _retention(body, kind, now.date())
    status = policy.explicit_status(scope, scope == policy.SCOPE_PERSONAL or is_curator(caller))
    candidate = store.Candidate(
        statement=statement, kind=kind, scope=scope, confidence=1.0,
        source_kind=policy.SOURCE_USER_EXPLICIT,
        source={'type': 'session', 'ref': 'manual', 'at': store.now_iso(now)},
        supporter=store.supporter_hash(caller.subject),
        owner_sub=caller.subject if scope == policy.SCOPE_PERSONAL else None,
        retention=retention, expires_at=expires_at, categories=_categories(body.get('categories')),
    )
    item, deduplicated = store.write_explicit(get_memory_table(), candidate, status=status,
                                              aggregates_table=get_aggregates_table(), now=now)
    return {**_view(item), 'deduplicated': deduplicated}


@app.put('/memory/<memory_id>')
@tracer.capture_method
def update_memory(memory_id: str):
    caller = _caller()
    item = _memory_or_404(memory_id, caller)
    _require_can_edit(item, caller)
    body = _body()
    now = _now()
    table = get_memory_table()
    fields: dict[str, Any] = {}
    kind = _choice(body.get('kind'), policy.KINDS, 'kind') or str(item.get('kind') or 'other')
    if 'kind' in body:
        fields['kind'] = kind
    if 'categories' in body:
        fields['categories'] = _categories(body.get('categories'))
    if 'retention' in body or 'expires_at' in body:
        retention, expires_at = _retention(body, kind, now.date())
        fields['retention'] = retention
        fields['expires_at'] = expires_at
    if fields:
        item = store.set_fields(table, item, fields, now=now)
    if 'statement' in body:
        statement = _statement(body.get('statement'))
        if statement != item.get('statement'):
            item = store.reembed(table, item, statement, aggregates_table=get_aggregates_table(), now=now)
    store.append_event(table, memory_id, 'edited', actor=store.supporter_hash(caller.subject), now=now)
    return _view(item)


@app.post('/memory/<memory_id>/confirm')
@tracer.capture_method
def confirm_memory(memory_id: str):
    caller = _person(_caller())
    item = _memory_or_404(memory_id, caller)
    if item.get('tombstoned') or item.get('status') == policy.STATUS_ARCHIVED:
        raise ConflictError('An archived memory cannot be confirmed; restore it first')
    table = get_memory_table()
    now = _now()
    counted = store.reinforce(table, item, store.supporter_hash(caller.subject), None, now=now)
    store.append_event(table, memory_id, 'confirmed', actor=store.supporter_hash(caller.subject), now=now)
    return {**_view(store.get_item(table, store.item_key(item)) or item), 'counted': counted}


@app.post('/memory/<memory_id>/forget')
@tracer.capture_method
def forget_memory(memory_id: str):
    caller = _caller()
    item = _memory_or_404(memory_id, caller)
    _require_can_edit(item, caller)
    table = get_memory_table()
    now = _now()
    item = store.set_fields(table, item, {'status': policy.STATUS_ARCHIVED, 'tombstoned': True,
                                          'archived_reason': 'forgotten', 'archived_at': store.now_iso(now)}, now=now)
    store.append_event(table, memory_id, 'forgotten', actor=store.supporter_hash(caller.subject), now=now)
    return _view(item)


@app.post('/memory/<memory_id>/restore')
@tracer.capture_method
def restore_memory(memory_id: str):
    caller = _caller()
    item = _memory_or_404(memory_id, caller)
    _require_can_edit(item, caller)
    if item.get('status') != policy.STATUS_ARCHIVED:
        raise ConflictError('Only an archived memory can be restored')
    table = get_memory_table()
    now = _now()
    item = store.set_fields(table, item, {
        'status': policy.STATUS_ACTIVE, 'tombstoned': False, 'archived_reason': None,
        'last_reinforced_at': store.now_iso(now), 'gsi1sk': store.now_iso(now),
    }, now=now)
    store.append_event(table, memory_id, 'restored', actor=store.supporter_hash(caller.subject), now=now)
    return _view(item)


def _mergeable(ids: object, caller: Caller) -> list[Mapping[str, Any]]:
    if (not isinstance(ids, list) or not 2 <= len(ids) <= store.MAX_MERGE
            or not all(isinstance(i, str) for i in ids) or len(set(ids)) != len(ids)):
        raise ValidationError(f'ids must list 2-{store.MAX_MERGE} distinct memory ids')
    items: list[Mapping[str, Any]] = [_memory_or_404(memory_id, caller) for memory_id in ids]
    if len({str(i['pk']) for i in items}) != 1:
        raise ValidationError('Only memories of the same scope can be merged')
    if any(i.get('status') == policy.STATUS_ARCHIVED for i in items):
        raise ConflictError('Archived memories cannot be merged; restore them first')
    _require_can_edit(items[0], caller)
    return items


@app.post('/memory/merge')
@tracer.capture_method
def merge_memories():
    caller = _caller()
    body = _body()
    items = _mergeable(body.get('ids'), caller)
    statement = _statement(body.get('statement'))
    kind = _choice(body.get('kind'), policy.KINDS, 'kind')
    merged = store.merge_memories(get_memory_table(), items, statement, actor=store.supporter_hash(caller.subject),
                                  kind=kind, aggregates_table=get_aggregates_table(), now=_now())
    return _view(merged)


# ── Review queue ─────────────────────────────────────────────────────────────
def _review_entry(table, item: dict) -> dict:
    linked: list[Mapping[str, Any]] = list(store.linked_items(table, item))
    return {
        'memory': store.public_view(item),
        'linked': [store.public_view(other) for other in linked],
        'suggestion': policy.suggest_resolution(item, linked),
    }


@app.get('/memory/review')
@tracer.capture_method
def review_queue():
    caller = _person(_caller())
    table = get_memory_table()
    items: list[dict] = []
    if is_curator(caller):
        for status in (policy.STATUS_CONFLICT, policy.STATUS_PROPOSED):
            items += store.query_status(table, policy.SCOPE_COMPANY, status, attributes=store.LIST_ATTRIBUTES)
    for status in (policy.STATUS_CONFLICT, policy.STATUS_PROPOSED):
        items += store.list_personal(table, caller.subject, status, kind=None, q=None)
    items = items[:MAX_REVIEW_ITEMS]
    return {'items': [_review_entry(table, item) for item in items], 'count': len(items)}


def _clear_link(table, item: dict, other_id: str, now: datetime) -> None:
    remaining = [x for x in item.get('conflicts_with') or [] if x != other_id]
    store.set_fields(table, item, {'conflicts_with': remaining}, now=now)


def _retire(table, losers: list[dict], winner_id: str, actor: str, now: datetime) -> None:
    """Archive + tombstone the losing side: automation must not re-learn it."""
    for loser in losers:
        store.set_fields(table, loser, {'status': policy.STATUS_ARCHIVED, 'tombstoned': True,
                                        'archived_reason': 'superseded', 'superseded_by': winner_id,
                                        'conflicts_with': []}, now=now)
        store.append_event(table, str(loser.get('memory_id')), 'superseded', actor=actor,
                           detail={'by': winner_id}, now=now)


def _resolve_keep(table, item: dict, linked: list[dict], winner_id: str, actor: str, now: datetime) -> dict:
    sides = {str(s.get('memory_id')): s for s in [item, *linked]}
    winner = sides.get(winner_id)
    if winner is None:
        raise ValidationError('winner_id must be this memory or one it conflicts with')
    _retire(table, [s for sid, s in sides.items() if sid != winner_id], winner_id, actor, now)
    return store.set_fields(table, winner, {'status': policy.STATUS_ACTIVE, 'conflicts_with': []}, now=now)


@app.post('/memory/review/<memory_id>/resolve')
@tracer.capture_method
def resolve_review(memory_id: str):
    caller = _caller()
    item = _memory_or_404(memory_id, caller)
    _require_can_edit(item, caller)
    if item.get('status') not in (policy.STATUS_PROPOSED, policy.STATUS_CONFLICT):
        raise ConflictError('This memory is not waiting for review')
    body = _body()
    action = _choice(body.get('action'), policy.RESOLVE_ACTIONS, 'action')
    table = get_memory_table()
    now = _now()
    actor = store.supporter_hash(caller.subject)
    linked = store.linked_items(table, item)
    if action == 'keep_both':
        for other in linked:
            _clear_link(table, other, memory_id, now)
        result = store.set_fields(table, item, {'status': policy.STATUS_ACTIVE, 'conflicts_with': []}, now=now)
    elif action == 'keep':
        result = _resolve_keep(table, item, linked, str(body.get('winner_id') or memory_id), actor, now)
    elif action == 'replace':
        statement = _statement(body.get('statement')) if body.get('statement') is not None else None
        if statement and statement != item.get('statement'):
            item = store.reembed(table, item, statement, aggregates_table=get_aggregates_table(), now=now)
        result = _resolve_keep(table, item, linked, memory_id, actor, now)
    elif action == 'merge':
        result = store.merge_memories(table, [item, *linked], _statement(body.get('statement')), actor=actor,
                                      aggregates_table=get_aggregates_table(), now=now)
    else:
        raise ValidationError('action is required')
    store.append_event(table, memory_id, f'resolved_{action}', actor=actor, now=now)
    return _view(result)


# ── Imports ──────────────────────────────────────────────────────────────────
def _validated_import(body: dict) -> tuple[str, str | None, str]:
    title, url, content = body.get('title'), body.get('url'), body.get('content')
    if not isinstance(title, str) or not title.strip() or len(title) > MAX_TITLE_CHARS:
        raise ValidationError(f'title is required (at most {MAX_TITLE_CHARS} characters)')
    if url not in (None, ''):
        parsed = urlparse(url) if isinstance(url, str) else None
        if parsed is None or len(url) > MAX_URL_CHARS or parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise ValidationError('url must be an http(s) URL')
    if not isinstance(content, str) or not content.strip():
        raise ValidationError('content is required')
    if len(content) > policy.MAX_IMPORT_CHARS:
        raise PayloadTooLargeError(f'content must be at most {policy.MAX_IMPORT_CHARS} characters')
    return title.strip(), (url or None), content


@app.post('/memory/imports')
@tracer.capture_method
def create_import():
    caller = _caller()
    _require_curator(caller)
    if not RAW_DATA_BUCKET or not MEMORY_QUEUE_URL:
        raise ConfigurationError('Memory imports are not configured')
    title, url, content = _validated_import(_body())
    table = get_memory_table()
    now = _now()
    import_id = store.new_import_id()
    s3_key = f'{IMPORT_PREFIX}{import_id}.json'
    get_s3_client().put_object(
        Bucket=RAW_DATA_BUCKET, Key=s3_key, ContentType='application/json',
        Body=json.dumps({'import_id': import_id, 'title': title, 'url': url, 'content': content,
                         'created_at': store.now_iso(now)}, ensure_ascii=False).encode('utf-8'),
    )
    record = {
        **store.import_key(import_id), 'import_id': import_id, 'title': title, 'status': 'queued',
        's3_key': s3_key, 'content_chars': len(content), 'chunks_total': len(policy.chunk_text(content)),
        'chunks_done': 0, 'created': 0, 'reinforced': 0, 'proposed': 0, 'conflicts': 0, 'dropped': 0,
        'created_by_hash': store.supporter_hash(caller.subject),
        'created_at': store.now_iso(now), 'updated_at': store.now_iso(now),
    }
    if caller.username:
        record['created_by_username'] = caller.username
    if url:
        record['url'] = url
    table.put_item(Item=record)
    try:
        get_sqs_client().send_message(QueueUrl=MEMORY_QUEUE_URL, MessageBody=json.dumps(
            {'kind': 'import', 'import_id': import_id, 'chunk': 0}))
    except Exception as exc:
        store.add_import_counts(table, import_id, {}, {'status': 'failed', 'error': 'Could not queue the import'},
                                now=now)
        raise ServiceError('Could not queue the import. Please retry.') from exc
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'import_id': import_id, 'import': store.public_import(record)}, default=str))


@app.get('/memory/imports')
@tracer.capture_method
def list_imports():
    _require_curator(_caller())
    rows = store.query_partition(get_memory_table(), store.IMPORT_PK)
    rows.sort(key=lambda r: str(r.get('sk')), reverse=True)
    return {'items': [store.public_import(r) for r in rows[:MAX_IMPORTS_LISTED]]}


@app.get('/memory/imports/<import_id>')
@tracer.capture_method
def get_import(import_id: str):
    _require_curator(_caller())
    record = store.get_import(get_memory_table(), import_id)
    if record is None:
        raise NotFoundError(IMPORT_NOT_FOUND)
    return {'import': store.public_import(record)}


# ── Internal: retrieve + conflict-check ──────────────────────────────────────
def _query_text(body: dict) -> str:
    query = body.get('query')
    if not isinstance(query, str) or not query.strip():
        raise ValidationError('query is required')
    text = query.strip()[:MAX_QUERY_CHARS]
    page = body.get('page')
    if isinstance(page, dict):
        hints = [str(page.get(k)) for k in ('kind', 'title') if isinstance(page.get(k), str) and page.get(k)]
        if hints:
            text = f"{text}\n({' / '.join(hints)[:200]})"
    return text


@app.post('/memory/retrieve')
@tracer.capture_method
def retrieve_memories():
    caller = _caller()
    body = _body()
    query = _query_text(body)
    k = policy.clamp_top_k(body.get('k'))
    # Personal memories are the caller's own: a person, or an MCP credential acting
    # for its minter (same subject). Never an `agent:` principal, whose subject is
    # its owner but which must not read the owner's private notes.
    include_personal = bool(caller.subject) and not caller.agent_id
    rows = store.retrieve(get_memory_table(), query, caller_sub=caller.subject or None,
                          include_personal=include_personal, k=k, scope=_category_scope(caller), now=_now())
    return {'items': [store.summary_view(r) for r in rows]}


def _conflict_statement() -> str:
    statement = _params().get('statement')
    if statement is None:
        statement = _body().get('statement')
    if not isinstance(statement, str) or not statement.strip():
        raise ValidationError('statement is required')
    return statement.strip()[:policy.MAX_STATEMENT_CHARS]


@app.get('/memory/conflict-check')
@tracer.capture_method
def conflict_check():
    caller = _caller()
    statement = _conflict_statement()
    related = store.related_live(get_memory_table(), statement,
                                 caller_sub=None if caller.delegated else (caller.subject or None),
                                 scope=_category_scope(caller))
    labels = store.judge_relations([(statement, str(row.get('statement') or '')) for row, _ in related],
                                   service_tier=None)
    # judge_relations returns exactly one label per pair (it pads), so strict holds.
    conflicts = [store.summary_view(row) for (row, _), label in zip(related, labels, strict=True)
                 if label == policy.RELATION_CONTRADICTS]
    return {'conflicts': conflicts}


# SnapStart (lib/utils/snapstart.ts): build the DynamoDB resource and the tables
# GET /memory reads before the snapshot, so a restored environment skips them.
register_snapshot_hooks(store.get_memory_table, get_aggregates_table, api_route_warmer(app))


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
