"""Which rows of a CSV dataset upload are new, changed or unchanged (issue #411, docs/csv-import.md).

The manual-import API reads the stored items its ``csv-row-v2`` rows name (BatchGetItem on
the feedback table, keys from ``shared.feedback_keys``, the derivation the processor writes
with) and compares each row's ``csv_content_hash`` with the stored one:

* no stored item              -> ``new`` (queued as an ordinary new record);
* a different / missing hash  -> ``changed`` (queued with ``csv_replace`` once confirmed);
* the same hash               -> ``unchanged`` (not queued at all).

Rows keyed by ``csv-row-v1`` (no ``id`` column value, or no dataset name) are ``v1_rows``:
they cannot be updated by a later upload and are queued exactly as before.

A read that DynamoDB leaves unprocessed after the retries raises: a changed row misread as
new would be queued without ``csv_replace`` and skipped as a duplicate, so the update the
preview promised would silently never happen.

An upload in a workspace (``scope``, 7.67.00) reads that workspace's items only: their keys
``WS#{ws}#SOURCE#…`` (shared/feedback_partitions.py ``item_key``), read through the workspace
layer (shared/ws_repo.py ``WorkspaceTable.batch_get_item``, every key checked in the scope).
"""
from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from shared.concurrency import ordered_map
from shared.feedback_keys import feedback_item_id, feedback_item_key
from shared.feedback_partitions import item_key
from shared.ws_repo import UnprocessedKeysError, WorkspaceScope, ws_table

__all__ = [
    'CsvDatasetPlan',
    'StoredRowsUnreadable',
    'plan_dataset_rows',
    'preview_view',
]

#: Changed rows a preview lists (with a before / after snippet); the counts cover every row.
CHANGED_ROWS_LIMIT: Final = 50
#: Characters of each before / after text snippet.
SNIPPET_LENGTH: Final = 160

_BATCH_GET_MAX_KEYS: Final = 100
_BATCH_GET_ATTEMPTS: Final = 4
_BATCH_GET_BACKOFF_SECONDS: Final = 0.05
_READ_WORKERS: Final = 8
_PLAN_FIELDS: Final = ('pk', 'sk', 'csv_content_hash', 'source_created_at', 's3_raw_uri')
_SNIPPET_FIELDS: Final = ('pk', 'sk', 'original_text')


class StoredRowsUnreadable(Exception):
    """DynamoDB left keys unprocessed after the retries: the upload cannot be classified (503, retry)."""


@dataclass
class CsvDatasetPlan:
    """The rows of one upload, by what queueing them would do. ``changed`` pairs each row with its stored item."""

    new: list[dict[str, Any]] = field(default_factory=list)
    changed: list[tuple[dict[str, Any], dict[str, Any]]] = field(default_factory=list)
    unchanged: list[dict[str, Any]] = field(default_factory=list)
    v1_rows: list[dict[str, Any]] = field(default_factory=list)

    def archive_rewrites(self) -> dict[str, str]:
        """Changed row id -> its stored item's raw archive (``shared.ingest_archive`` files the new version in its folder)."""
        return {item['id']: stored['s3_raw_uri'] for item, stored in self.changed if stored.get('s3_raw_uri')}

    def counts(self) -> dict[str, int]:
        return {'new': len(self.new), 'changed': len(self.changed),
                'unchanged': len(self.unchanged), 'v1_rows': len(self.v1_rows)}


def _key_tuple(key: Mapping[str, Any]) -> tuple[str, str]:
    """``(pk, sk)`` of a key or a stored item, as the lookup key of the plan's reads."""
    return str(key['pk']), str(key['sk'])


def _read_chunk(table: Any, keys: list[dict[str, str]], fields: Sequence[str]) -> list[dict[str, Any]]:
    names = {f'#f{i}': name for i, name in enumerate(fields)}
    pending: Mapping[str, Any] = {table.name: {
        'Keys': keys, 'ProjectionExpression': ', '.join(names), 'ExpressionAttributeNames': names,
    }}
    found: list[dict[str, Any]] = []
    for attempt in range(_BATCH_GET_ATTEMPTS):
        if attempt:
            time.sleep(_BATCH_GET_BACKOFF_SECONDS * 2 ** attempt)
        response = table.meta.client.batch_get_item(RequestItems=pending)
        found.extend(response.get('Responses', {}).get(table.name, []))
        pending = response.get('UnprocessedKeys') or {}
        if not pending:
            return found
    raise StoredRowsUnreadable('Stored rows could not be read; try the upload again')


def _read_scoped(table: Any, keys: list[dict[str, str]], fields: Sequence[str],
                 scope: WorkspaceScope) -> list[dict[str, Any]]:
    names = {f'#f{i}': name for i, name in enumerate(fields)}
    try:
        return ws_table(scope, table).batch_get_item(keys, ProjectionExpression=', '.join(names),
                                                     ExpressionAttributeNames=names)
    except UnprocessedKeysError as e:
        raise StoredRowsUnreadable('Stored rows could not be read; try the upload again') from e


def _read_stored(table: Any, keys: list[dict[str, str]], fields: Sequence[str],
                 scope: WorkspaceScope | None = None) -> dict[tuple[Any, Any], dict[str, Any]]:
    """The stored items at ``keys`` (only ``fields``), by ``(pk, sk)``; absent keys are simply missing."""
    if scope is not None:
        return {_key_tuple(item): item for item in _read_scoped(table, keys, fields, scope)}
    chunks = [keys[start:start + _BATCH_GET_MAX_KEYS] for start in range(0, len(keys), _BATCH_GET_MAX_KEYS)]
    results = ordered_map(lambda chunk: _read_chunk(table, chunk, fields), chunks, max_workers=_READ_WORKERS)
    return {_key_tuple(item): item for chunk in results for item in chunk}


def _stored_key(scope: WorkspaceScope | None, source_platform: str, row_id: str) -> dict[str, str]:
    """Where the processor stores the row's item: the deployment's ``SOURCE#…`` key, or the workspace's."""
    if scope is None:
        return feedback_item_key(source_platform, row_id)
    return item_key(scope, source_platform, feedback_item_id(source_platform, row_id))


def plan_dataset_rows(table: Any, source_platform: str, items: list[dict[str, Any]],
                      scope: WorkspaceScope | None = None) -> CsvDatasetPlan:
    """Sort parsed CSV rows (``manual_import_handler._parse_csv_to_items``) into a ``CsvDatasetPlan`` (the stored
    items of ``scope``'s workspace in one)."""
    plan = CsvDatasetPlan()
    keyed = [(item, _stored_key(scope, source_platform, item['id'])) for item in items if item.get('content_hash')]
    plan.v1_rows = [item for item in items if not item.get('content_hash')]
    stored = _read_stored(table, [key for _, key in keyed], _PLAN_FIELDS, scope) if keyed else {}
    for item, key in keyed:
        existing = stored.get(_key_tuple(key))
        if existing is None:
            plan.new.append(item)
        elif existing.get('csv_content_hash') == item['content_hash']:
            plan.unchanged.append(item)
        else:
            plan.changed.append((item, existing))
    return plan


def _snippet(value: object) -> str:
    text = value if isinstance(value, str) else ''
    return text if len(text) <= SNIPPET_LENGTH else f'{text[:SNIPPET_LENGTH - 1]}…'


def preview_view(table: Any, plan: CsvDatasetPlan, scope: WorkspaceScope | None = None) -> dict[str, Any]:
    """``{counts, changed_rows, changed_rows_truncated}``: the first ``CHANGED_ROWS_LIMIT`` changed rows, before / after."""
    shown = plan.changed[:CHANGED_ROWS_LIMIT]
    texts = _read_stored(table, [{'pk': s['pk'], 'sk': s['sk']} for _, s in shown], _SNIPPET_FIELDS,
                         scope) if shown else {}
    rows = [{
        'row': item.get('row'),
        'csv_row_id': item.get('csv_row_id') or None,
        'before': _snippet(texts.get(_key_tuple(stored), {}).get('original_text')),
        'after': _snippet(item.get('text')),
    } for item, stored in shown]
    return {
        'counts': plan.counts(),
        'changed_rows': rows,
        'changed_rows_truncated': len(plan.changed) > len(shown),
    }
