"""voc-retention: a workspace's erasure finds its items by index, not by a Scan of voc-feedback (7.96.00).

A job that names a workspace (handler.py ``_named_workspace``) reaches that workspace's ``FEEDBACK#`` items only. Its
``items`` phase reads them from the workspace's own index partitions, through the workspace layer
(shared/scoped_query.py ``query_partition``):

- by ``source_id``, which always comes with its source (api/settings_handler.py ``SOURCE_SCOPED_ERASURE_FIELDS``): one
  Query of ``gsi4-by-feedback-id`` at ``WS#{ws}#FEEDBACK#{feedback_item_id(source, source_id)}`` (the processor keys
  every review by exactly that id: shared/feedback_keys.py; a message without an id is refused, so no review has a
  content id). Its cursor is ``{id_start}`` (``ID_START``: the Query's ``LastEvaluatedKey``);
- by ``author``, ``csv_row_id`` or ``email`` (and a ``source_id`` job with no source, should one exist): the day walk
  the category reprocess built (7.94.00, shared/reprocess_slices.py ``query_day_page``), one Query of
  ``gsi1-by-date`` per ``WS#{ws}#DATE#{day}``, oldest first, from the day before the workspace's ``META``
  ``created_at`` (``first_walk_day``) to today UTC. Its cursor is ``{day, start}``. Only the processor's first put
  writes a review's ``gsi1pk`` (the day it processed it) and nothing rewrites it
  (lambda/shared/test/test_feedback_day_index_writers.py; lambda/processor/test/test_workspace_index_keys.py the
  positive half), so every review of the workspace is on one of those days, but a review with no ``gsi1pk`` (none is
  written so) would be on none (TENETS.md D5's gaps). Likewise only that first put writes ``gsi4pk``, so a review
  without one (none is written so) is on no id partition.

Each Query filters on the index with the Scan's own filter (shared/retention.py ``erase_filter`` in the workspace: both
indexes project every attribute, lib/stacks/core-stack.ts) and returns the keys alone (``DAY_KEYS``, ``ID_KEYS``;
``Select`` ``SPECIFIC_ATTRIBUTES``; IAM allows the keys and the filter's attributes only: lib/stacks/retention-worker.ts).
An index answers eventually consistent, so a hit is a candidate only: each is read again from the table, strongly
consistent (one GetItem through the workspace layer), and decided on the row as that read returns it: only a row that
still matches the job (``erase_matches``, the Scan filter's rule) goes on to its tombstone and its delete; a row that
changed or went meanwhile is left. The delete itself is unconditioned, as with the Scan: a row changed between that
read and its delete is still deleted. A row the index's filter rules out is never read again. A Query is billed on the
full size of the index items it reads, filtered or not (both project every attribute): keys only saves the bytes
returned, not read units. What the walk cannot see: a review written, or reaching the index, after the walk passed its
day, or (by source id) written just before the Query but not yet in gsi4 (the next erasure's, as for a Scan's pages
already read).

A workspace job's ``scanned`` count (handler.py ``_erase_pages``) is its index hits: the rows the index's filter
matched, each read again (``IndexWalk.page``'s ``ScannedCount``), not the index items the Query evaluated.

No Scan except in two cases (handler.py ``_scan_page``, as before): a job handed over with a Scan cursor (``{pk, sk}``,
checkpointed before 7.96.00) finishes with it; and a workspace whose ``META`` names no readable ``created_at`` (no
first day for the walk) or whose voc-workspaces is not configured, logged (each its own warning) and counted on the job
(``WORKSPACE_SCAN_COUNTER``). The deployment's erasures and the
retention window never come here.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Final, Literal

from boto3.dynamodb.conditions import ConditionBase

from shared.feedback_keys import feedback_item_id
from shared.feedback_partitions import FEEDBACK_ID_INDEX_PARTITION, feedback_id_partition
from shared.indexes import FEEDBACK_BY_DATE_POSITION, FEEDBACK_BY_ID_INDEX, FEEDBACK_BY_ID_POSITION
from shared.logging import logger
from shared.reprocess_slices import WALK_DAY, day_span, first_walk_day, position_after, query_day_page, walk_day
from shared.retention import STORE_FEEDBACK, WORKSPACE_SCAN_COUNTER, erase_filter, erase_matches
from shared.scoped_query import query_partition
from shared.ws_repo import WorkspaceScope, workspace_created_at, ws_table

#: What the day walk reads of gsi1-by-date, and the by-id read of gsi4-by-feedback-id: the keys only (IAM holds both,
#: with the filter's attributes: lib/stacks/retention-worker.ts ``FEEDBACK_DAY_INDEX_KEYS``, ``FEEDBACK_ID_INDEX_KEYS``,
#: ``FEEDBACK_ERASE_FILTER_ATTRIBUTES``).
DAY_KEYS: Final = FEEDBACK_BY_DATE_POSITION
ID_KEYS: Final = FEEDBACK_BY_ID_POSITION
#: A by-id read's cursor: the Query's ``LastEvaluatedKey``.
ID_START: Final = 'id_start'
_SOURCE_ID: Final = 'source_id'

CursorKind = Literal['start', 'day', 'id', 'scan']
#: One index page from a cursor (keys only).
IndexRead = Callable[[Mapping[str, Any] | None], dict]


def cursor_kind(cursor: Mapping[str, Any] | None) -> CursorKind:
    """Where an ``items`` phase goes on: its start (no cursor), a day walk's ``{day, start}``, a by-id read's
    ``{id_start}``, or a Scan's ``{pk, sk}`` (a job checkpointed before 7.96.00)."""
    if not cursor:
        return 'start'
    if WALK_DAY in cursor:
        return 'day'
    return 'id' if ID_START in cursor else 'scan'


def _keys_only(keys: tuple[str, ...], hits: ConditionBase) -> dict[str, Any]:
    """A Query's options: ``hits`` (the job's ``erase_filter``) as its filter, the keys alone returned."""
    return {'ProjectionExpression': ', '.join(keys), 'Select': 'SPECIFIC_ATTRIBUTES', 'FilterExpression': hits}


@dataclass
class IndexWalk:
    """A workspace job's ``items`` pages: ``page(cursor)`` reads one index page and answers the rows that still match,
    read again from the table; ``position(page, item)`` is the cursor right after one of them (for a hand-over in the
    middle of a page)."""

    view: Any
    read: IndexRead
    position_of: Callable[[dict, Mapping[str, Any]], dict[str, Any]]
    matches: Callable[[Mapping[str, Any]], bool]
    _positions: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    def page(self, cursor: Mapping[str, Any] | None) -> dict:
        """The index page from ``cursor``: its ``Items`` the matching table rows (strongly consistent), its
        ``LastEvaluatedKey`` the index's, ``ScannedCount`` the index hits (the rows its filter matched, each read
        again): what the job counts as ``scanned``."""
        hits_page = self.read(cursor)
        hits = hits_page.get('Items') or []
        rows: list[dict] = []
        self._positions.clear()
        for hit in hits:
            key = {'pk': hit['pk'], 'sk': hit['sk']}
            row = self.view.get_item(key, ConsistentRead=True).get('Item')
            if row is None or not self.matches(row):
                continue
            rows.append(row)
            self._positions[(str(row['pk']), str(row['sk']))] = self.position_of(hits_page, hit)
        return {**{name: value for name, value in hits_page.items() if name != 'Items'}, 'Items': rows,
                'ScannedCount': len(hits)}

    def position(self, _page: dict, item: Mapping[str, Any]) -> dict[str, Any]:
        """Where the read goes on after ``item`` of the last page: the index position of its hit."""
        return self._positions[(str(item['pk']), str(item['sk']))]


def _id_position(_page: dict, hit: Mapping[str, Any]) -> dict[str, Any]:
    return {ID_START: {name: hit[name] for name in ID_KEYS}}


def _id_read(table: Any, scope: WorkspaceScope, partition: str, page_size: int, hits: ConditionBase) -> IndexRead:
    def read(cursor: Mapping[str, Any] | None) -> dict:
        kwargs: dict[str, Any] = {'IndexName': FEEDBACK_BY_ID_INDEX, 'Limit': page_size,
                                  **_keys_only(ID_KEYS, hits)}
        start = cursor.get(ID_START) if cursor else None
        if start:
            kwargs['ExclusiveStartKey'] = dict(start)
        response = query_partition(scope, table, FEEDBACK_ID_INDEX_PARTITION, partition, **kwargs)
        page: dict[str, Any] = {'Items': response.get('Items') or []}
        if response.get('LastEvaluatedKey'):
            page['LastEvaluatedKey'] = {ID_START: dict(response['LastEvaluatedKey'])}
        return page

    return read


def _day_read(table: Any, scope: WorkspaceScope, days: tuple[str, str], page_size: int,
              hits: ConditionBase) -> IndexRead:
    def read(cursor: Mapping[str, Any] | None) -> dict:
        return query_day_page(table, cursor, page_size, scope, days, **_keys_only(DAY_KEYS, hits))

    return read


def _first_day(run: dict[str, Any], workspaces_table: Any | None, scope: WorkspaceScope) -> date | None:
    """The walk's first day, or None (and the run counts its Scan) when the workspace's ``META`` names no readable
    ``created_at`` or voc-workspaces is not configured. A failed read raises (the job fails and is started again)."""
    if workspaces_table is None:
        first, why = None, 'Workspace erasure Scans voc-feedback: the workspaces table is not configured'
    else:
        first = first_walk_day(workspace_created_at(workspaces_table, scope))
        why = 'Workspace erasure Scans voc-feedback: its workspace names no creation time'
    if first is None:
        # Once per job, whatever the hand-overs: 1 on its rows.
        run[WORKSPACE_SCAN_COUNTER] = 1
        logger.warning(why, extra={'job_id': str(run.get('job_id') or '')})
    return first


def index_walk(run: dict[str, Any], value: str, feedback: Any, workspaces_table: Any | None, scope: WorkspaceScope,
               cursor: Mapping[str, Any] | None, today: date, page_size: int) -> IndexWalk | None:
    """The ``items`` pages of a job that names ``scope``'s workspace in voc-feedback (``feedback``), from ``cursor``
    (the module docstring), or None when it Scans instead (a Scan cursor; a workspace with no ``created_at``,
    counted). ValueError for a cursor of another read than the job's."""
    kind = cursor_kind(cursor)
    if kind == 'scan':
        logger.info('Workspace erasure resumes the Scan it was handed over with',
                    extra={'job_id': str(run.get('job_id') or '')})
        return None
    field_name, source = str(run.get('field')), run.get('source') or None
    by_id = field_name == _SOURCE_ID and isinstance(source, str)
    if (kind == 'id') != by_id and kind != 'start':
        raise ValueError('The erasure cursor is not the one its job reads')
    hits = erase_filter(field_name, value, source, STORE_FEEDBACK, scope)
    if by_id:
        partition = feedback_id_partition(scope, feedback_item_id(str(source), value))
        read, position = _id_read(feedback, scope, partition, page_size, hits), _id_position
    else:
        if cursor is None:
            first = _first_day(run, workspaces_table, scope)
            if first is None:
                return None
            days = day_span(first, today)
        else:
            days = (walk_day(cursor[WALK_DAY]), today.isoformat())
        read, position = _day_read(feedback, scope, days, page_size, hits), position_after
    return IndexWalk(view=ws_table(scope, feedback), read=read, position_of=position,
                     matches=lambda row: erase_matches(row, field_name, value, source, scope))
