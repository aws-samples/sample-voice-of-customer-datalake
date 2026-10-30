"""Import history: one run record per import, in voc-aggregates (docs/import-history.md).

Written by every import entry point: the manual-import routes (paste confirm, CSV
upload, JSON upload, which also serves the assistant's ``import_reviews``) and the
S3 import ingestor, once per file. Read by ``GET /scrapers/manual/history`` and
``GET /scrapers/manual/history/{run_id}`` (admin-only, the manual-import Lambda).

Two rows per run, both with ``ttl`` (90 days):

- the **summary** at ``pk IMPORT_RUN`` / ``sk {started_at}#{run_id}``: every field
  except the warning and error lists, so a newest-first Query of one partition
  lists runs without reading up to 400 messages per row;
- the **detail** at ``pk IMPORT_RUN#{run_id}`` / ``sk RUN``: the same fields plus
  ``warnings`` and ``errors`` (at most 200 each, each at most 300 characters;
  ``truncated`` is true when any were cut — the raw file at ``raw_s3_key`` has
  the full input).

Writing a record never fails the import: ``record_import_run`` logs a warning and
returns None instead of raising.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.dynamo_values import as_count
from shared.feedback_cursor import decode_key_cursor, encode_key_cursor
from shared.logging import logger

__all__ = [
    'MAX_MESSAGES',
    'ImportCounts',
    'ImportRun',
    'actor_from_event',
    'get_import_run',
    'list_import_runs',
    'parse_limit',
    'record_import_run',
]

LIST_PK: Final = 'IMPORT_RUN'
DETAIL_SK: Final = 'RUN'
RUN_TTL_SECONDS: Final = 90 * 24 * 3600
MAX_MESSAGES: Final = 200
MAX_MESSAGE_CHARS: Final = 300
MAX_LIST_LIMIT: Final = 100
DEFAULT_LIST_LIMIT: Final = 25
METHODS: Final = frozenset({'paste', 'csv', 'json', 's3', 'assistant'})
IMPORT_COMPLETED: Final = 'completed'
IMPORT_PARTIAL: Final = 'partial'
IMPORT_FAILED: Final = 'failed'
# The actor of a file dropped into the import bucket: the uploader is not known there.
S3_UPLOAD_ACTOR: Final = 's3-upload'
_COUNT_FIELDS: Final = ('received', 'imported', 'skipped', 'duplicate', 'failed')
_CURSOR_FIELDS: Final = frozenset({'pk', 'sk'})
_ELLIPSIS: Final = '…'


@dataclass(frozen=True)
class ImportCounts:
    """What one run did with its rows: ``received`` = imported + skipped + duplicate + failed."""

    received: int
    imported: int
    skipped: int = 0
    duplicate: int = 0
    failed: int = 0


@dataclass(frozen=True)
class ImportRun:
    """One import run as its entry point knows it."""

    method: str
    source: str
    actor: str
    started_at: str
    counts: ImportCounts
    actor_email: str = ''
    source_id: str = ''
    warnings: Iterable[object] = ()
    errors: Iterable[object] = ()
    raw_s3_key: str | None = None
    radar_brand: str = ''
    # Warnings the entry point counted but stopped collecting (a long file keeps at most MAX_MESSAGES in memory).
    warnings_not_kept: int = 0
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))


def run_status(counts: ImportCounts) -> str:
    """``failed`` when nothing was imported, ``partial`` when some rows failed, else ``completed``.

    Skipped and duplicate rows are expected outcomes (they carry a warning), not failures.
    """
    if counts.imported <= 0:
        return IMPORT_FAILED
    if counts.failed > 0:
        return IMPORT_PARTIAL
    return IMPORT_COMPLETED


def _bounded(messages: Iterable[object], *, not_kept: int = 0) -> tuple[list[str], int, bool]:
    """``(the first 200 messages, each cut to 300 characters; how many there were; whether any was cut)``.

    ``not_kept``: messages the caller counted but never collected; they add to the count and mark it cut.
    """
    kept: list[str] = []
    total = max(0, not_kept)
    cut = total > 0
    for message in messages:
        total += 1
        if len(kept) >= MAX_MESSAGES:
            cut = True
            continue
        text = str(message)
        if len(text) > MAX_MESSAGE_CHARS:
            text = text[:MAX_MESSAGE_CHARS - len(_ELLIPSIS)] + _ELLIPSIS
            cut = True
        kept.append(text)
    return kept, total, cut


def _count_fields(counts: ImportCounts) -> dict[str, int]:
    """The stored count attributes (never negative)."""
    return {
        'received': max(0, counts.received), 'imported': max(0, counts.imported), 'skipped': max(0, counts.skipped),
        'duplicate': max(0, counts.duplicate), 'failed': max(0, counts.failed),
    }


def _rows(run: ImportRun, now: datetime) -> tuple[dict[str, Any], dict[str, Any]]:
    """The ``(summary, detail)`` rows of ``run`` finished at ``now``."""
    warnings, warning_count, warnings_cut = _bounded(run.warnings, not_kept=run.warnings_not_kept)
    errors, error_count, errors_cut = _bounded(run.errors)
    summary: dict[str, Any] = {
        'pk': LIST_PK,
        'sk': f'{run.started_at}#{run.run_id}',
        'run_id': run.run_id,
        'method': run.method,
        'source': run.source[:MAX_MESSAGE_CHARS],
        'source_id': run.source_id,
        'actor': run.actor,
        'actor_email': run.actor_email,
        'started_at': run.started_at,
        'finished_at': now.isoformat(),
        **_count_fields(run.counts),
        'status': run_status(run.counts),
        'warning_count': warning_count,
        'error_count': error_count,
        'truncated': warnings_cut or errors_cut,
        'raw_s3_key': run.raw_s3_key or '',
        'radar_brand': run.radar_brand,
        'ttl': int(now.timestamp()) + RUN_TTL_SECONDS,
    }
    detail = {**summary, 'pk': f'{LIST_PK}#{run.run_id}', 'sk': DETAIL_SK, 'warnings': warnings, 'errors': errors}
    return summary, detail


def _put_rows(table: Any, rows: Iterable[Mapping[str, Any]]) -> None:
    """Write each row (the detail first, so a listed run always has its detail)."""
    for row in rows:
        table.put_item(Item=dict(row))


def record_import_run(table: Any, run: ImportRun, *, now: datetime | None = None) -> str | None:
    """Store ``run``; its ``run_id``, or None when there is no table or the write failed (logged, never raised)."""
    if table is None:
        return None
    if run.method not in METHODS:
        logger.warning('Import run not recorded: unknown method', extra={'method': run.method})
        return None
    try:
        summary, detail = _rows(run, now or datetime.now(UTC))
        _put_rows(table, (detail, summary))
    except (ClientError, BotoCoreError, TypeError, ValueError):
        # The import itself has already happened: losing its history row must not turn it into an error.
        # ClientError/BotoCoreError: the write; TypeError/ValueError: a value boto3 cannot serialise.
        logger.warning('Import run record not written', extra={'run_id': run.run_id}, exc_info=True)
        return None
    return run.run_id


def actor_from_event(raw_event: object) -> tuple[str, str]:
    """``(Cognito sub, email)`` of the caller of an API Gateway event; ``('unknown', '')`` without claims."""
    claims: object = {}
    if isinstance(raw_event, Mapping):
        context = raw_event.get('requestContext')
        authorizer = context.get('authorizer') if isinstance(context, Mapping) else None
        claims = authorizer.get('claims') if isinstance(authorizer, Mapping) else {}
    if not isinstance(claims, Mapping):
        return 'unknown', ''
    sub = claims.get('sub') or claims.get('cognito:username') or 'unknown'
    email = claims.get('email') or ''
    return str(sub), str(email)


# ── Reads ────────────────────────────────────────────────────────────────────


_TEXT_FIELDS: Final = ('run_id', 'method', 'source', 'source_id', 'actor', 'actor_email', 'started_at', 'finished_at', 'status')


def _messages(value: object) -> list[str]:
    return [m for m in value if isinstance(m, str)] if isinstance(value, list) else []


def _texts(item: Mapping[str, Any], names: Iterable[str]) -> dict[str, str]:
    """Each named string attribute of ``item`` ('' when absent or not a string)."""
    return {name: value if isinstance(value := item.get(name), str) else '' for name in names}


def run_view(item: Mapping[str, Any], *, detail: bool = False) -> dict[str, Any]:
    """What the history routes answer for a stored row (``detail`` adds the warning and error lists)."""
    optional = _texts(item, ('raw_s3_key', 'radar_brand'))
    view: dict[str, Any] = {
        **_texts(item, _TEXT_FIELDS),
        'counts': {name: as_count(item.get(name)) for name in _COUNT_FIELDS},
        'warning_count': as_count(item.get('warning_count')),
        'error_count': as_count(item.get('error_count')),
        'truncated': item.get('truncated') is True,
        'raw_s3_key': optional['raw_s3_key'] or None,
        'radar_brand': optional['radar_brand'] or None,
    }
    if detail:
        view['warnings'] = _messages(item.get('warnings'))
        view['errors'] = _messages(item.get('errors'))
    return view


def _live(item: Mapping[str, Any], now_epoch: int) -> bool:
    """False for a row past its TTL that DynamoDB has not deleted yet (that can take days)."""
    ttl = as_count(item.get('ttl'))
    return ttl == 0 or ttl > now_epoch


def parse_limit(raw: object) -> int:
    """The page size of ``?limit=``: 1..100, 25 when absent; ``ValueError`` when not a number."""
    if raw in (None, ''):
        return DEFAULT_LIST_LIMIT
    limit = int(str(raw))
    return max(1, min(MAX_LIST_LIMIT, limit))


def list_import_runs(table: Any, *, limit: int, cursor: str | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """One newest-first page of run summaries and the cursor of the next (None at the end).

    ``ValueError`` for a cursor that did not come from this listing.
    """
    request: dict[str, Any] = {
        'KeyConditionExpression': '#pk = :pk',
        'ExpressionAttributeNames': {'#pk': 'pk'},
        'ExpressionAttributeValues': {':pk': LIST_PK},
        'ScanIndexForward': False,
        'Limit': limit,
    }
    if cursor:
        request['ExclusiveStartKey'] = decode_key_cursor(cursor, _CURSOR_FIELDS, ('pk', LIST_PK))
    response = table.query(**request)
    now_epoch = int(time.time())
    items = response.get('Items') if isinstance(response, Mapping) else None
    runs = [run_view(item) for item in items or [] if isinstance(item, Mapping) and _live(item, now_epoch)]
    last = response.get('LastEvaluatedKey') if isinstance(response, Mapping) else None
    return runs, _next_cursor(last)


def _next_cursor(last_key: object) -> str | None:
    """The opaque cursor of a page's ``LastEvaluatedKey``; None at the end of the listing."""
    if not isinstance(last_key, Mapping) or not isinstance(last_key.get('sk'), str) or not last_key['sk']:
        return None
    return encode_key_cursor({'pk': LIST_PK, 'sk': last_key['sk']})


def get_import_run(table: Any, run_id: str) -> dict[str, Any] | None:
    """The detail view of one run, or None when there is no such (live) run."""
    try:
        uuid.UUID(run_id)
    except ValueError:
        return None
    item = table.get_item(Key={'pk': f'{LIST_PK}#{run_id}', 'sk': DETAIL_SK}).get('Item')
    if not isinstance(item, Mapping) or not _live(item, int(time.time())):
        return None
    return run_view(item, detail=True)
