"""Version counters the read caches key on (docs/caching.md).

Three counters, each a row holding ``v`` (a number, only ever ADDed to) and
``updated_at``:

* ``voc-aggregates`` ``METRIC#meta / data_version`` — the feedback data. Bumped
  ONCE per batch that changed feedback: a DynamoDB Streams batch of the aggregator
  that carried at least one feedback write, every category-reprocess checkpoint and
  completion, a retention run after it deleted, and the interactive edits
  (``PUT /feedback/{id}/category|dimensions``, ``PUT /data-explorer/feedback``) so a
  person reads their own write at once instead of after the stream catches up.
* ``voc-aggregates`` ``METRIC#meta / config_version`` — settings that change what
  reads return (categories, brand, source profiles, dimensions, models, a user's
  category access).
* ``voc-radar`` ``SETTINGS#radar / version`` — Radar data: the processor once per
  SQS batch that stored a Radar review, the Radar scan when it records its outcome
  (after its releases), and ``PUT /radar/brands`` / ``PUT /radar/settings``.

A bump never raises: it is logged and dropped, because the write it follows has
already happened and failing it now would only turn a success into a retry. The
cost of a lost bump is bounded by the read cache's maximum age.

Reads: ``read_versions`` fetches the two aggregates counters, the earliest-data
watermark (``shared.earliest_date``) and, for Radar, its counter in ONE
``BatchGetItem`` — the same single round trip the metrics routes already paid for
the lone watermark ``get_item``. Any failure answers ``versions=None`` (the caller
must not cache that request) and falls back to the plain watermark read.

A workspace (docs/multi-workspace.md) has its own ``data_version`` and watermark under
``WS#{ws}#METRIC#meta`` (``scope``): a workspace's feedback write bumps only its own, and a
read in the workspace keys its cache on its own. ``config_version`` and Radar's counter stay
the deployment's, like the settings they count (phase 3 moves the settings).

Data-layer only (no API-resolver imports), so the aggregator and the job workers
can use it.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.earliest_date import (
    METRIC_META_PK,
    earliest_date_from_item,
    earliest_date_key,
    meta_partition,
)
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.timestamps import now_iso
from shared.ws_repo import WorkspaceScope, ws_table

DATA_VERSION_SK: Final = 'data_version'
DATA_VERSION_KEY: Final = {'pk': METRIC_META_PK, 'sk': DATA_VERSION_SK}
CONFIG_VERSION_KEY: Final = {'pk': METRIC_META_PK, 'sk': 'config_version'}
RADAR_VERSION_KEY: Final = {'pk': 'SETTINGS#radar', 'sk': 'version'}
VERSION_ATTRIBUTE: Final = 'v'

_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def data_version_key(scope: WorkspaceScope | None = None) -> dict[str, str]:
    """The ``data_version`` row: the deployment's (``DATA_VERSION_KEY``), or the workspace's (``WS#{ws}#METRIC#meta``)."""
    if scope is None:
        return dict(DATA_VERSION_KEY)
    return {'pk': meta_partition(scope), 'sk': DATA_VERSION_SK}


def _bump(table: Any, key: Mapping[str, str], name: str, scope: WorkspaceScope | None = None) -> bool:
    """``ADD v 1`` on ``key`` (through the workspace layer with ``scope``); True when it landed. Never raises
    (see the module docstring)."""
    if table is None:
        return False
    request = {
        'UpdateExpression': 'ADD #v :one SET updated_at = :now',
        'ExpressionAttributeNames': {'#v': VERSION_ATTRIBUTE},
        'ExpressionAttributeValues': {':one': 1, ':now': now_iso()},
    }
    try:
        table_view(scope, table).update_item(key, **request)
    except _AWS_ERRORS:
        logger.exception('Could not bump a cache version; cached reads expire by age instead',
                         extra={'version': name})
        return False
    return True


def bump_data_version(aggregates_table: Any, scope: WorkspaceScope | None = None) -> bool:
    """The feedback data changed (once per batch / request, never per record): the deployment's, or with
    ``scope`` the workspace's own counter."""
    return _bump(aggregates_table, data_version_key(scope), 'data', scope)


def bump_config_version(aggregates_table: Any) -> bool:
    """A setting that changes what reads return was saved."""
    return _bump(aggregates_table, CONFIG_VERSION_KEY, 'config')


def bump_radar_version(radar_table: Any) -> bool:
    """Radar data (reviews, releases, the brand list, the scan settings or outcome) changed."""
    return _bump(radar_table, RADAR_VERSION_KEY, 'radar')


class BatchBump:
    """Collapse "this record wrote" marks into ONE bump per batch (and per workspace).

    A record handler calls ``mark()`` after a write it made (thread-safe: the SQS
    processor runs records on a thread pool), ``mark(scope)`` for a write of a
    workspace's item; the batch entry point calls ``flush(table)`` once after the
    batch, which bumps the deployment's counter when a deployment-wide write was
    marked and each marked workspace's own (``bump(table, scope)``) once.
    """

    def __init__(self, bump: Callable[..., bool]) -> None:
        self._bump = bump
        self._lock = threading.Lock()
        self._marked = False
        self._scopes: set[WorkspaceScope] = set()

    def mark(self, scope: WorkspaceScope | None = None) -> None:
        with self._lock:
            if scope is None:
                self._marked = True
            else:
                self._scopes.add(scope)

    def flush(self, table: Any) -> bool:
        """Bump once per marked scope since the last flush; True when every bump landed and one was made."""
        with self._lock:
            marked, self._marked = self._marked, False
            scopes, self._scopes = self._scopes, set()
        results = [self._bump(table)] if marked else []
        results += [self._bump(table, scope) for scope in sorted(scopes, key=lambda scope: scope.ws)]
        return bool(results) and all(results)


@dataclass(frozen=True)
class Versions:
    """The counters one request's cached reads are keyed on (``radar`` None outside Radar)."""

    data: int
    config: int
    radar: int | None = None

    def key(self) -> tuple[int, int, int | None]:
        return (self.data, self.config, self.radar)


@dataclass(frozen=True)
class VersionRead:
    """``versions`` None means "could not tell": the caller must serve that request live."""

    versions: Versions | None
    earliest_date: str | None


def _counter(item: object) -> int | None:
    """The row's ``v`` as an int; 0 for an absent row (never bumped); None when malformed."""
    if item is None:
        return 0
    if not isinstance(item, Mapping):
        return None
    value = item.get(VERSION_ATTRIBUTE)
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, Decimal)):
        return int(value)
    return None


def _rows_by_sk(rows: object, pk: str) -> dict[str, Mapping[str, Any]]:
    if not isinstance(rows, list):
        return {}
    return {str(row.get('sk')): row for row in rows if isinstance(row, Mapping) and row.get('pk') == pk}


def _fallback_earliest(aggregates_table: Any, scope: WorkspaceScope | None) -> str | None:
    """The plain watermark read the routes made before (fails open to None); the workspace's with ``scope``."""
    try:
        response = table_view(scope, aggregates_table).get_item(earliest_date_key(scope))
    except Exception:
        # Fail open: the watermark only narrows windows, losing it costs efficiency, not data.
        logger.exception('Could not read the earliest-date watermark')
        return None
    return earliest_date_from_item(_item_of(response))


def _item_of(response: object) -> object:
    """A get_item answer's ``Item``; None when the answer is not a mapping (a stubbed table may answer anything)."""
    return response.get('Item') if isinstance(response, Mapping) else None


def _batch_request(aggregates_table: Any, radar_table: Any, scope: WorkspaceScope | None) -> dict[str, Any]:
    keys = [data_version_key(scope), dict(CONFIG_VERSION_KEY), earliest_date_key(scope)]
    if scope is not None:
        # The workspace's own rows (its data_version and watermark), checked as any key of the workspace is; the
        # config counter is the deployment's (its settings are).
        ws_table(scope, aggregates_table).check_keys(keys[0::2])
    request: dict[str, Any] = {aggregates_table.name: {'Keys': keys, 'ConsistentRead': True}}
    if radar_table is not None:
        request[radar_table.name] = {'Keys': [dict(RADAR_VERSION_KEY)], 'ConsistentRead': True}
    return request


def _rows_by_key(rows: object) -> dict[tuple[str, str], Mapping[str, Any]]:
    if not isinstance(rows, list):
        return {}
    return {(str(row.get('pk')), str(row.get('sk'))): row for row in rows if isinstance(row, Mapping)}


def _row(rows: Mapping[tuple[str, str], Mapping[str, Any]], key: Mapping[str, str]) -> Mapping[str, Any] | None:
    return rows.get((key['pk'], key['sk']))


def _parse(response: object, aggregates_table: Any, radar_table: Any,
           scope: WorkspaceScope | None) -> VersionRead | None:
    """The read, or None when the response is not a complete, well-formed answer."""
    if not isinstance(response, Mapping) or response.get('UnprocessedKeys'):
        return None
    responses = response.get('Responses')
    if not isinstance(responses, Mapping) or not isinstance(responses.get(aggregates_table.name), list):
        return None
    rows = _rows_by_key(responses.get(aggregates_table.name))
    data = _counter(_row(rows, data_version_key(scope)))
    config = _counter(_row(rows, CONFIG_VERSION_KEY))
    radar: int | None = None
    if radar_table is not None:
        radar_rows = _rows_by_sk(responses.get(radar_table.name), RADAR_VERSION_KEY['pk'])
        radar = _counter(radar_rows.get(RADAR_VERSION_KEY['sk']))
        if radar is None:
            return None
    if data is None or config is None:
        return None
    earliest = earliest_date_from_item(_row(rows, earliest_date_key(scope)))
    return VersionRead(Versions(data, config, radar), earliest)


def read_versions(aggregates_table: Any, radar_table: Any = None, scope: WorkspaceScope | None = None) -> VersionRead:
    """data_version + config_version + the earliest-date watermark (+ the Radar counter) in one call.

    With ``scope`` the data_version and the watermark are the workspace's own (the config counter stays the
    deployment's), so a cached answer of the deployment or of another workspace is never keyed alike by chance
    of equal counters (shared/response_cache.py also keys on the workspace).

    Strongly consistent, so a write's bump is visible to the very next read (a person
    saving a correction sees it). Fails open: ``versions=None`` and the watermark from
    a plain ``get_item``, so the request is served live exactly as before.
    """
    if aggregates_table is None:
        return VersionRead(None, None)
    try:
        response = aggregates_table.meta.client.batch_get_item(
            RequestItems=_batch_request(aggregates_table, radar_table, scope))
        parsed = _parse(response, aggregates_table, radar_table, scope)
    except Exception:
        # A version read must never fail the request.
        logger.exception('Could not read the cache versions; serving this request live')
        parsed = None
    if parsed is not None:
        return parsed
    return VersionRead(None, _fallback_earliest(aggregates_table, scope))
