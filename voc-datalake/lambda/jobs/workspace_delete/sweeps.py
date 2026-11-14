"""What a workspace's hard delete sweeps, in order: ``SWEEPS`` (docs/multi-workspace.md, "Export and delete", step 4;
the registry of slice 4d-2, the shape of the export's ``ENTITIES``).

Each ``Sweep(name, table, pages, delete, tombstone?, note?)`` is one named phase of the job (handler.py), run one
page at a time from a checkpointed cursor: ``pages(ctx, cursor)`` reads one page (a ``Batch``: its rows and the cursor
after them, None when the sweep is done), then ``note`` lists what a later sweep needs (the counter partitions a
feedback page touched, a form's id), then ``tombstone`` writes one tombstone per item (a conditional put of a new
key, before any delete), then ``delete`` deletes the page and answers how many rows or objects went. Every read is a
Query, a GetItem or a listing of ``ws/{ws}/``, never a Scan; every key goes through the workspace layer
(shared/ws_repo.py), which refuses one outside the workspace before any call.

``WORKSPACE_DELETE_GRANTS`` (lib/utils/workspace-delete-grants.ts) names the same sweeps, each with the grants it
needs, which each entry also declares beside its code (``Sweep.grants``); a test keeps the two equal and ties them to
the entry's table and hooks, and another keeps test/families.py ``FAMILIES`` (every key family of a workspace the code
builds, with its sweep or why it is kept or expires) in step with the code, seeding one row of each. Writes are
retried on a throttle (``unthrottled``) rather than failing the job.

The entry kinds: a fixed set of partitions listed once into the inventory, then each deleted in full
(``_partitions_sweep``); an owner list (``owner_list_sweep``: a partition of rows naming further partitions of the same
table, each deleted in full, then the list itself LAST, so a sweep stopped anywhere resumes from the list: the import
runs now, the reserved conversations entry next); and entries with their own pages (the feedback, the counters, the
memory, the objects, the control rows). ``Sweep.partitions`` is an entry's enumeration of what it reads, where it has
a fixed one; the memory's is shared/memory_partitions.py, the export's too.

What a tombstone or an audit row holds: counts and item ids only (a feedback id, a memory id: ``{ws}#{memory id}``),
never a member's sub, a session or a conversation id; the one sub on the platform's rows is the requester's (decision
17's "who").

The inventory (``delete_work_pk``, ``WS#{ws}#DELETE#PARTITIONS`` / ``{kind}#{name}``) holds what a sweep found for a
later one: the feedback's source partitions (``feedback``), the counter partitions its items touched (``counter``),
the sources and plugins it met (``source``, ``plugin``), the forms (``form``), and each partition family's
partitions (its sweep's name). It is deleted last, after the verify pass reads it.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.workspace_export.pages import TABLE_KEY, items, key, last_key, start
from shared.categorization import allowed_category_names, load_categories_config
from shared.dimension_config import allowed_values, load_dimensions_config
from shared.earliest_date import EARLIEST_DATE_ATTRIBUTE, earliest_date_key, meta_partition, parse_iso_date
from shared.erasure_jobs import WORKSPACE_LOCK_SK
from shared.export_jobs import mark_erased
from shared.import_runs import LIST_PK
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX, FEEDBACK_BY_DATE_INDEX
from shared.memory_partitions import memory_partitions
from shared.metric_keys import (
    CATEGORY_PREFIX,
    DAILY_TOTAL_PK,
    DIMENSION_PREFIX,
    DIMENSION_SENTIMENT_PREFIX,
    METRIC_PARTITION_PREFIX,
    PROFILE_METRIC_TYPES,
    SENTIMENT_AVG_PK,
    SENTIMENT_PREFIX,
    SUBCATEGORY_PREFIX,
    URGENT_PK,
    USEFULNESS_METRIC_TYPE,
    metric_partition,
    metric_type_partition,
)
from shared.onboarding import FEEDBACK_FORM_PK
from shared.plugin_identity import is_valid_plugin_identifier
from shared.radar_store import SENTIMENT_LABELS
from shared.retention import STORE_FEEDBACK, UNKNOWN_SOURCE, item_feedback_id, item_source
from shared.workspace_credentials import delete_parameters, list_parameter_names
from shared.workspace_members import MEMBER_PREFIX
from shared.ws_repo import (
    LOOKUP_SORT_KEY,
    WATERMARK_DIRECTORY,
    ExportObjects,
    ObjectVersion,
    OutOfScopeError,
    WorkspaceControlRows,
    WorkspaceObjectVersions,
    WorkspaceScope,
    WorkspaceTable,
    WorkspaceTombstones,
    control_query,
    date_pk,
    delete_work_pk,
    erasure_job_pk,
    export_job_pk,
    memory_event_pk,
    plugin_config_history_pk,
    plugin_config_pk,
    scraper_run_pk,
    source_run_pk,
)

__all__ = [
    'OWNER_LISTS',
    'PARTITION_FAMILIES',
    'SWEEPS',
    'WORK_PARTITION',
    'Context',
    'OutOfTime',
    'OwnerList',
    'Sweep',
    'listed_left',
    'memory_pages',
    'partition_has_rows',
    'unthrottled',
]

#: Rows one page reads (and so deletes, tombstones first) at most.
PAGE: Final = 100
#: The tombstone puts' pace: near 800 a second at most (a delete of millions of items stays far under a partition's
#: 1,000 writes a second on ``AUDIT#tombstone#<source>``, which voc-retention's tombstones share).
TOMBSTONES_PER_SECOND: Final = 800
#: How many tombstone puts go between two looks at the invocation's time (``_tombstone_each``).
TIME_CHECK_EVERY: Final = 25
#: What every tombstone of this job says it is.
MODE: Final = 'workspace_delete'
#: A memory tombstone's ``store`` and partition (``AUDIT#tombstone#memory``); a feedback item's is
#: shared/retention.py ``STORE_FEEDBACK``, as voc-retention writes it.
STORE_MEMORY: Final = 'memory'
#: The feedback walk's days: from the workspace's first known day (or today) to the day after the sweep began.
_DAYS_AFTER: Final = 2
#: The counter partitions the aggregator writes whatever an item holds (the rest come from each item: ``note``).
_FIXED_COUNTERS: Final = (DAILY_TOTAL_PK, SENTIMENT_AVG_PK, URGENT_PK)
#: The ``metric_type`` index's fixed types (shared/metric_keys.py; ``dim_sentiment#<key>`` types come from items).
_METRIC_TYPES: Final = ('source', 'persona', 'tag', 'channel', USEFULNESS_METRIC_TYPE, *PROFILE_METRIC_TYPES.values())
#: The category and sentiment pair's counters (lambda/aggregator/handler.py ``counter_dimensions``).
_CATEGORY_SENTIMENT_PREFIX: Final = f'{METRIC_PARTITION_PREFIX}category_sentiment#'
#: The processor's log partitions per source (lambda/processor/handler.py ``_log_row_base``).
_LOG_KINDS: Final = ('validation', 'processing')


class Pacer:
    """Holds a run of calls to at most ``per_second`` (sleeping when it is ahead)."""

    def __init__(self, per_second: int = TOMBSTONES_PER_SECOND, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self._gap = 1.0 / per_second
        self._clock = clock
        self._sleep = sleep
        self._next = 0.0

    def wait(self) -> None:
        now = self._clock()
        if self._next > now:
            self._sleep(self._next - now)
            now = self._next
        self._next = now + self._gap


class OutOfTime(Exception):
    """The invocation reached its hand-over reserve inside a page: the page is done again from its cursor by the
    next invocation (its notes and tombstones are idempotent, its deletes not yet made)."""


@dataclass
class Context:
    """One invocation's handles on the workspace, every one of them scoped (shared/ws_repo.py)."""

    scope: WorkspaceScope
    feedback: WorkspaceTable
    aggregates: WorkspaceTable
    memory: WorkspaceTable
    watermarks: WorkspaceTable
    workspaces: Any
    objects: WorkspaceObjectVersions
    exports: ExportObjects
    ssm: Any
    parameter_prefix: str
    plugin_ids: tuple[str, ...]
    job: Mapping[str, Any]
    #: The deployment's voc-aggregates, read for its category and dimension settings only (``_closed_counters``).
    settings: Any
    counts: dict[str, int] = field(default_factory=dict)
    pacer: Pacer = field(default_factory=Pacer)
    #: Whether the invocation still has its hand-over reserve (handler.py): checked inside a page's tombstones, so
    #: a throttled page cannot eat the reserve (``OutOfTime``).
    time_left: Callable[[], bool] = field(default=lambda: True)
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))

    @property
    def tombstones(self) -> WorkspaceTombstones:
        return WorkspaceTombstones(self.aggregates)

    @property
    def control(self) -> WorkspaceControlRows:
        return WorkspaceControlRows(self.scope, self.workspaces)

    def count(self, name: str, n: int = 1) -> None:
        if n:
            self.counts[name] = self.counts.get(name, 0) + n


@dataclass(frozen=True)
class Batch:
    """One page of a sweep: its rows (as read), and the cursor after them (None: the sweep is done)."""

    rows: list[dict[str, Any]]
    following: dict[str, Any] | None


Step = Callable[[Context, Batch], int]


@dataclass(frozen=True)
class Sweep:
    """One named phase of the delete (the module docstring).

    ``grants``: the grant groups of lib/utils/workspace-delete-grants.ts the entry's code needs, declared beside it
    (test_registry.py holds them equal to ``WORKSPACE_DELETE_GRANTS``, and to what the entry's table and hooks
    need). An entry's enumeration of what it reads is its pages function's own (the memory's is
    shared/memory_partitions.py, which the export reads too, so the two cannot drift)."""

    name: str
    table: str
    pages: Callable[[Context, dict[str, Any] | None], Batch]
    delete: Step
    tombstone: Step | None = None
    note: Step | None = None
    grants: tuple[str, ...] = ()


# ── Throttling ─────────────────────────────────────────────────────────────────────────────────────────────────

#: The codes a write is retried on, with a backoff, before it fails the job (a large delete beside other traffic).
THROTTLED: Final = frozenset({'ProvisionedThroughputExceededException', 'ThrottlingException',
                              'RequestLimitExceeded', 'SlowDown'})
#: How many tries a throttled write gets (the first included), and the backoff before the second (doubling, capped).
THROTTLE_ATTEMPTS: Final = 6
_THROTTLE_BACKOFF_SECONDS: Final = 0.2
_THROTTLE_BACKOFF_CAP_SECONDS: Final = 5.0


def unthrottled[T](call: Callable[[], T]) -> T:
    """``call()``, retried with a doubling backoff while DynamoDB or S3 answers a throttle (``THROTTLED``), at most
    ``THROTTLE_ATTEMPTS`` tries; any other error, or the last throttle, raises as it came."""
    for attempt in range(THROTTLE_ATTEMPTS):
        try:
            return call()
        except ClientError as error:
            if (error.response.get('Error', {}).get('Code') not in THROTTLED
                    or attempt == THROTTLE_ATTEMPTS - 1):
                raise
            time.sleep(min(_THROTTLE_BACKOFF_SECONDS * 2 ** attempt, _THROTTLE_BACKOFF_CAP_SECONDS))
    raise AssertionError('unreachable')  # pragma: no cover - the loop returns or raises


# ── Table calls, each on a parameter annotated as the layer's view (shared/test/test_ws_raw_access.py) ──────────

def _remove(table_view: WorkspaceTable, keys: Iterable[Mapping[str, Any]]) -> int:
    checked = list(keys)
    return unthrottled(lambda: table_view.batch_delete(checked))


def _remember(table_view: WorkspaceTable, rows: Iterable[Mapping[str, Any]]) -> None:
    with table_view.batch_writer() as writer:
        for row in rows:
            writer.put_item(Item=dict(row))


def _page(table_view: WorkspaceTable, attribute: str, partition: str, cursor_start: object, **kwargs: Any) -> dict:
    return table_view.query(attribute, partition, **start(cursor_start), **kwargs)


def _keys(rows: Iterable[Mapping[str, Any]], attributes: tuple[str, ...] = TABLE_KEY) -> list[dict[str, Any]]:
    return list({tuple(row[a] for a in attributes): key(row, attributes) for row in rows}.values())


# ── The inventory ──────────────────────────────────────────────────────────────────────────────────────────────

def note(ctx: Context, kind: str, values: Iterable[str]) -> None:
    """List ``values`` under ``kind`` in the workspace's inventory (puts of their keys alone: idempotent)."""
    partition = delete_work_pk(ctx.scope)
    unique = sorted({value for value in values if value})
    if unique:
        _remember(ctx.aggregates, ({'pk': partition, 'sk': f'{kind}#{value}'} for value in unique))


def _inventory_page(ctx: Context, kind: str, cursor_start: object) -> tuple[list[str], dict[str, Any] | None]:
    page = _page(ctx.aggregates, 'pk', delete_work_pk(ctx.scope), cursor_start, ConsistentRead=True, Limit=PAGE,
                 sort_condition='begins_with(#sk, :kind)', ExpressionAttributeNames={'#sk': 'sk'},
                 ExpressionAttributeValues={':kind': f'{kind}#'})
    return [str(row['sk'])[len(kind) + 1:] for row in items(page)], last_key(page)


def inventory(ctx: Context, kind: str) -> Iterator[str]:
    """Every value listed under ``kind``, page by page."""
    following: dict[str, Any] | None = None
    while True:
        values, following = _inventory_page(ctx, kind, following)
        yield from values
        if following is None:
            return


def _plugins(ctx: Context) -> list[str]:
    """Every plugin id the workspace may hold rows of: the deployment's plugins, and every one it met (credentials,
    config lists, watermarks), each a well-formed plugin id."""
    found = {*ctx.plugin_ids, *inventory(ctx, 'plugin')}
    found.update(str(row['sk']) for row in ctx.aggregates.iter_query('pk', plugin_config_pk(ctx.scope)))
    found.update(str(row['sk']).split('#', 1)[0]
                 for row in ctx.aggregates.iter_query('pk', ctx.scope.key(WATERMARK_DIRECTORY)))
    plugins = sorted(plugin for plugin in found if is_valid_plugin_identifier(plugin))
    # Listed, so a later sweep (the control rows', after the config lists and watermarks are gone) still finds them.
    note(ctx, 'plugin', plugins)
    return plugins


def _sources(ctx: Context) -> list[str]:
    """Every source the workspace's rows may be keyed by: the plugins, the sources its items named, ``unknown``."""
    return sorted({*_plugins(ctx), *inventory(ctx, 'source'), UNKNOWN_SOURCE})


# ── Partition families: listed once into the inventory, then each partition deleted page by page ─────────────────

def _partitions_sweep(name: str, partitions: Callable[[Context], Iterable[str]], *,
                      note_rows: Step | None = None) -> Sweep:
    """A sweep of every row of a set of partitions of voc-aggregates: the first step lists them (``partitions``,
    read while what they are found from still exists) under ``name`` in the inventory, then each is read and deleted
    a page at a time (``{inv, todo, start}``: the inventory page, the partitions of it still to do, the key within
    the first)."""
    def pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
        if cursor is None:
            note(ctx, name, (partition for partition in partitions(ctx) if ctx.scope.owns(partition)))
            return Batch([], {'inv': None, 'todo': [], 'inv_done': False, 'start': None})
        return walk_listed(ctx, ctx.aggregates, name, cursor)

    return Sweep(name, 'aggregates', pages, delete_keys(lambda ctx: ctx.aggregates), note=note_rows,
                 grants=('aggregates',))


@dataclass(frozen=True)
class OwnerList:
    """Where an owner-list entry's list is, and how to read its rows (``owner_list_sweep``)."""

    table: str
    view_of: Callable[[Context], WorkspaceTable]
    list_partition: Callable[[WorkspaceScope], str]
    listed: Callable[[WorkspaceScope, Mapping[str, Any]], Iterable[str]]


def owner_list_sweep(name: str, owners: OwnerList, *, grants: tuple[str, ...]) -> Sweep:
    """An entry whose partitions an owner list names: a partition of rows, each naming one or more partitions of the
    same table (``owners.listed``). Stage ``list``: the list a page at a time, then each partition it names deleted
    in full, a page at a time (``{list_start, list_done, todo, start}``); stage ``drop``: the list itself, LAST, so a
    sweep stopped anywhere (a hand-over, a failure and its resume, a verify pass sending the job back) still finds
    every partition from it. The import runs use it (``IMPORT_RUN`` lists each run's ``IMPORT_RUN#{run}``), and the
    reserved conversations entry will (``CONVERSANTS`` lists each member's ``USER#{sub}``). The verify pass checks the
    list is gone (``OWNER_LISTS``)."""
    def pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
        listed_view, owned = owners.view_of(ctx), owners.list_partition(ctx.scope)
        here = cursor or {'stage': 'list', 'list_start': None, 'list_done': False, 'todo': [], 'start': None}
        if here['stage'] == 'drop':
            # No cursor: what was read is deleted, so each page reads what is left of the list.
            rows = items(_page(listed_view, 'pk', owned, None, Limit=PAGE, ConsistentRead=True))
            return Batch(rows, {'stage': 'drop'} if rows else None)
        todo = list(here.get('todo') or [])
        if todo:
            page = _page(listed_view, 'pk', todo[0], here.get('start'), Limit=PAGE, ConsistentRead=True)
            following = last_key(page)
            return Batch(items(page), {**here, 'start': following} if following else {**here, 'todo': todo[1:],
                                                                                       'start': None})
        if here.get('list_done'):
            return Batch([], {'stage': 'drop'})
        page = _page(listed_view, 'pk', owned, here.get('list_start'), Limit=PAGE, ConsistentRead=True)
        following = last_key(page)
        named = sorted({partition for row in items(page) for partition in owners.listed(ctx.scope, row)
                        if ctx.scope.owns(partition) and partition != owned})
        return Batch([], {'stage': 'list', 'list_start': following, 'list_done': following is None, 'todo': named,
                          'start': None})

    return Sweep(name, owners.table, pages, delete_keys(owners.view_of), grants=grants)


def walk_listed(ctx: Context, table_view: WorkspaceTable, kind: str, cursor: Mapping[str, Any],
                **query: Any) -> Batch:
    """One page of the next listed partition of ``kind`` (the cursor's ``todo``, refilled from the inventory)."""
    todo = list(cursor.get('todo') or [])
    if not todo:
        if cursor.get('inv_done'):
            return Batch([], None)
        listed, following = _inventory_page(ctx, kind, cursor.get('inv'))
        return Batch([], {'inv': following, 'todo': listed, 'inv_done': following is None, 'start': None})
    page = _page(table_view, 'pk', todo[0], cursor.get('start'), Limit=PAGE, ConsistentRead=True, **query)
    following = last_key(page)
    here = {'inv': cursor.get('inv'), 'inv_done': cursor.get('inv_done')}
    rest = {**here, 'todo': todo, 'start': following} if following else {**here, 'todo': todo[1:], 'start': None}
    return Batch(items(page), rest)


def partition_has_rows(table_view: WorkspaceTable, partition: str) -> bool:
    """Whether one partition still holds a row (one strongly consistent Query of one row, a count only)."""
    return bool(table_view.query('pk', partition, Select='COUNT', Limit=1, ConsistentRead=True).get('Count'))


def listed_left(ctx: Context, table_view: WorkspaceTable, kind: str,
                cursor_start: object) -> tuple[int, dict[str, Any] | None]:
    """The verify pass's step over one inventory page of ``kind``: how many of its partitions still hold a row, and
    where the next page starts (None: done)."""
    listed, following = _inventory_page(ctx, kind, cursor_start)
    return sum(partition_has_rows(table_view, partition) for partition in listed), following


def delete_keys(view_of: Callable[[Context], WorkspaceTable]) -> Step:
    """Delete a page's rows by their table key."""
    return lambda ctx, batch: _remove(view_of(ctx), _keys(batch.rows)) if batch.rows else 0


# ── credentials ────────────────────────────────────────────────────────────────────────────────────────────────

def _credential_pages(ctx: Context, _cursor: dict[str, Any] | None) -> Batch:
    names = list_parameter_names(ctx.ssm, ctx.parameter_prefix, ctx.scope.ws)
    return Batch([{'name': name} for name in names], {} if names else None)


def _note_credential_plugins(ctx: Context, batch: Batch) -> int:
    note(ctx, 'plugin', (str(row['name']).rsplit('/', 1)[-1] for row in batch.rows))
    return 0


def _delete_credentials(ctx: Context, batch: Batch) -> int:
    if not batch.rows:
        return 0
    return delete_parameters(ctx.ssm, ctx.parameter_prefix, ctx.scope.ws, [str(row['name']) for row in batch.rows])


# ── feedback ───────────────────────────────────────────────────────────────────────────────────────────────────

def _first_day(ctx: Context, today: date) -> date:
    """The earliest of the workspace's earliest-date watermark, its first daily counter and today."""
    known = [today]
    item = ctx.aggregates.get_item(earliest_date_key(ctx.scope), ConsistentRead=True).get('Item')
    if isinstance(item, Mapping) and (watermark := parse_iso_date(item.get(EARLIEST_DATE_ATTRIBUTE))) is not None:
        known.append(watermark)
    first = items(ctx.aggregates.query('pk', metric_partition(ctx.scope, DAILY_TOTAL_PK), Limit=1))
    if first and (counted := parse_iso_date(first[0].get('sk'))) is not None:
        known.append(counted)
    return min(known)


def _feedback_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """Two stages. ``days``: the ``gsi1-by-date`` partitions day by day, listing the source partition of every item
    found (and its source); nothing is deleted from an index page (it is eventually consistent). ``partitions``:
    a strongly consistent Query of each listed source partition (and of each plugin's, which a dateless item may be
    in alone), a page at a time: those rows are tombstoned and deleted."""
    if cursor is None:
        today = ctx.now().date()
        note(ctx, 'feedback', (ctx.scope.key('SOURCE', plugin) for plugin in ctx.plugin_ids))
        return Batch([], {'stage': 'days', 'day': _first_day(ctx, today).isoformat(),
                          'last': (today + timedelta(days=_DAYS_AFTER)).isoformat(), 'start': None})
    if cursor.get('stage') == 'days':
        return _day_page(ctx, cursor)
    return walk_listed(ctx, ctx.feedback, 'feedback', cursor)


def _day_page(ctx: Context, cursor: Mapping[str, Any]) -> Batch:
    day, last = str(cursor['day']), str(cursor['last'])
    page = _page(ctx.feedback, 'gsi1pk', date_pk(ctx.scope, day), cursor.get('start'),
                 IndexName=FEEDBACK_BY_DATE_INDEX, Limit=PAGE * 5)
    found = items(page)
    note(ctx, 'feedback', (str(row.get('pk')) for row in found if ctx.scope.owns(row.get('pk'))))
    note(ctx, 'source', (item_source(row) for row in found))
    following = last_key(page)
    if following is not None:
        return Batch([], {'stage': 'days', 'day': day, 'last': last, 'start': following})
    next_day = date.fromisoformat(day) + timedelta(days=1)
    if next_day > date.fromisoformat(last):
        return Batch([], {'stage': 'partitions', 'inv': None, 'todo': [], 'inv_done': False, 'start': None})
    return Batch([], {'stage': 'days', 'day': next_day.isoformat(), 'last': last, 'start': None})


def _counter_partitions(scope: WorkspaceScope, item: Mapping[str, Any]) -> list[str]:
    """The counter partitions the aggregator wrote for ``item`` in its workspace: its own key function, read as
    scripts/retention/rebuild_aggregates.py reads it (imported for its bucketing, never re-derived)."""
    from aggregator import handler as aggregator

    return [metric_partition(scope, pk) for pk, _field in aggregator.counter_dimensions(dict(item))]


def _note_counters(ctx: Context, batch: Batch) -> int:
    note(ctx, 'counter', (partition for row in batch.rows for partition in _counter_partitions(ctx.scope, row)))
    note(ctx, 'source', (item_source(row) for row in batch.rows))
    return 0


def _record(ctx: Context, store: str) -> dict[str, Any]:
    """What every tombstone of this job carries: no content, the job, the basis, the time."""
    return {'store': store, 'mode': MODE, 'run_id': _run_id(ctx),
            'legal_basis': str(ctx.job.get('legal_basis') or ''), 'deleted_at': ctx.now().isoformat()}


def _tombstone_each(ctx: Context, kind_and_ids: Iterable[tuple[str, str, Mapping[str, Any]]]) -> int:
    tombstones = ctx.tombstones
    written = 0
    for done, (kind, item_id, extra) in enumerate(kind_and_ids):
        # Every TIME_CHECK_EVERY puts (a throttled put may back off for seconds): never into the hand-over reserve.
        if done and done % TIME_CHECK_EVERY == 0 and not ctx.time_left():
            ctx.count('tombstones_written', written)
            raise OutOfTime
        ctx.pacer.wait()
        existing = unthrottled(lambda kind=kind, item_id=item_id, extra=extra: tombstones.put_new(kind, item_id, extra))
        if existing is None:
            written += 1
        elif existing.get('run_id') != _run_id(ctx):
            # Another job's (an erasure's): kept as it was. This job's own, from a page done again after a
            # hand-over, was counted when it was written.
            ctx.count('tombstones_kept')
    ctx.count('tombstones_written', written)
    return written


def _run_id(ctx: Context) -> str:
    """The run id every tombstone of this job carries (one per workspace: ``delete-{ws}``, the locks' holder)."""
    return f'delete-{ctx.scope.ws}'


def _tombstone_feedback(ctx: Context, batch: Batch) -> int:
    record = _record(ctx, STORE_FEEDBACK)
    return _tombstone_each(ctx, ((item_source(row), item_feedback_id(row),
                                  {**record, 'source': item_source(row), 'feedback_id': item_feedback_id(row)})
                                 for row in batch.rows if item_feedback_id(row)))


# ── counters ───────────────────────────────────────────────────────────────────────────────────────────────────

def _closed_counters(ctx: Context) -> Iterator[str]:
    """The counter partitions of the closed families, whatever an item still holds: every sentiment label, every
    category the deployment configures (with ``other``, the default) with each label and each of its
    subcategories, and every value of every configured dimension with each label. A workspace's messages are
    enriched with the deployment's settings (phase 3 moves them), so a counter of a category whose items were all
    erased before the delete is listed here even though no stored item names it."""
    labels = SENTIMENT_LABELS
    yield from (f'{SENTIMENT_PREFIX}{label}' for label in labels)
    configured_categories = load_categories_config(ctx.settings)
    # The names the model may answer with: the configured ones, or the defaults while none are saved.
    categories: dict[str, list[str]] = {name: [] for name in (*allowed_category_names(configured_categories), 'other')}
    for category in configured_categories:
        listed = category.get('subcategories')
        configured: list[Any] = listed if isinstance(listed, list) else []
        categories[str(category['name'])] = [str(sub.get('name')) for sub in configured
                                             if isinstance(sub, Mapping) and isinstance(sub.get('name'), str)]
    for name, subcategories in categories.items():
        yield f'{CATEGORY_PREFIX}{name}'
        yield from (f'{SUBCATEGORY_PREFIX}{name}#{sub}' for sub in subcategories)
        yield from (f'{_CATEGORY_SENTIMENT_PREFIX}{name}#{label}' for label in labels)
    for dimension in load_dimensions_config(ctx.settings):
        for value in allowed_values(dimension):
            yield f'{DIMENSION_PREFIX}{dimension["key"]}#{value}'
            yield from (f'{DIMENSION_SENTIMENT_PREFIX}{dimension["key"]}#{value}#{label}' for label in labels)


def _counter_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """Stage ``types`` first: the fixed counters, the closed families' (``_closed_counters``), and every partition
    the ``metric_type`` index names for each fixed type, listed beside the ones the feedback pages listed; then each
    listed partition's rows (``walk_listed``). What this cannot list (a tag or channel value no stored item holds any
    more) expires on the counters' 90-day TTL, or stays as counts (TENETS.md D5's gaps)."""
    if cursor is None:
        note(ctx, 'counter', (*(metric_partition(ctx.scope, pk) for pk in (*_FIXED_COUNTERS, *_closed_counters(ctx))),
                              meta_partition(ctx.scope)))
        return Batch([], {'stage': 'types', 'i': 0, 'start': None})
    if cursor.get('stage') == 'types':
        index = int(cursor['i'])
        if index >= len(_METRIC_TYPES):
            return Batch([], {'stage': 'rows', 'inv': None, 'todo': [], 'inv_done': False, 'start': None})
        page = _page(ctx.aggregates, 'metric_type', metric_type_partition(ctx.scope, _METRIC_TYPES[index]),
                     cursor.get('start'), IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX, Limit=PAGE * 5)
        note(ctx, 'counter', (str(row.get('pk')) for row in items(page) if ctx.scope.owns(row.get('pk'))))
        following = last_key(page)
        return Batch([], {'stage': 'types', 'i': index if following else index + 1, 'start': following})
    return walk_listed(ctx, ctx.aggregates, 'counter', cursor)


# ── the other aggregates families ──────────────────────────────────────────────────────────────────────────────

def _source_runs(ctx: Context) -> list[str]:
    return [source_run_pk(ctx.scope, source) for source in _sources(ctx)]


def _failures(ctx: Context) -> list[str]:
    return [ctx.scope.key('FAILURES', plugin) for plugin in _plugins(ctx)]


def _circuits(ctx: Context) -> list[str]:
    return [ctx.scope.key('CIRCUIT', plugin) for plugin in _plugins(ctx)]


def _logs(ctx: Context) -> list[str]:
    return [ctx.scope.key('LOGS', kind, source) for source in _sources(ctx) for kind in _LOG_KINDS]


def _scraper_ids(configs: object) -> set[str]:
    """The ``id`` of every entry of a stored config list (its JSON text); none for anything else."""
    try:
        entries = json.loads(configs) if isinstance(configs, str) else []
    except ValueError:
        return set()
    return {str(entry['id']) for entry in entries if isinstance(entries, list) and isinstance(entry, Mapping)
            and isinstance(entry.get('id'), str) and entry['id'] and '#' not in entry['id']}


def _scraper_runs(ctx: Context) -> list[str]:
    """``SCRAPER_RUN#{id}`` of every scraper the workspace's config lists name, now or in their history."""
    ids: set[str] = set()
    for partition in (plugin_config_pk(ctx.scope), plugin_config_history_pk(ctx.scope)):
        for row in ctx.aggregates.iter_query('pk', partition):
            ids |= _scraper_ids(row.get('configs'))
    return [scraper_run_pk(ctx.scope, scraper_id) for scraper_id in sorted(ids)]


def _import_run_list(scope: WorkspaceScope) -> str:
    """The import runs' summary partition: one row per run (shared/import_runs.py)."""
    return scope.key(LIST_PK)


def _import_run_detail(scope: WorkspaceScope, row: Mapping[str, Any]) -> list[str]:
    """The detail partition a summary row names (``IMPORT_RUN#{run}``)."""
    run_id = row.get('run_id')
    return [scope.key(LIST_PK, run_id)] if isinstance(run_id, str) and run_id and '#' not in run_id else []


#: The owner-list entries, by name (``owner_list_sweep``; the verify pass checks each list is gone).
OWNER_LISTS: Final = {
    'import_runs': OwnerList('aggregates', lambda ctx: ctx.aggregates, _import_run_list, _import_run_detail),
}


def _note_forms(ctx: Context, batch: Batch) -> int:
    """Each form's id, for its ``FORM#{id}`` lookup row in voc-workspaces (the control rows' sweep)."""
    note(ctx, 'form', (str(row.get('form_id') or str(row.get('sk') or '').removeprefix('FORM#'))
                       for row in batch.rows))
    return 0


# ── watermarks ─────────────────────────────────────────────────────────────────────────────────────────────────

def _watermark_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    page = _page(ctx.aggregates, 'pk', ctx.scope.key(WATERMARK_DIRECTORY), (cursor or {}).get('start'), Limit=PAGE,
                 ConsistentRead=True)
    following = last_key(page)
    return Batch(items(page), {'start': following} if following else None)


def _delete_watermarks(ctx: Context, batch: Batch) -> int:
    """Each listed watermark (``{prefix}{sk}``, shared/ws_repo.py ``watermark_directory_key``), then its row."""
    if not batch.rows:
        return 0
    deleted = _remove(ctx.watermarks, [{'source': f'{ctx.scope.prefix}{row["sk"]}'} for row in batch.rows])
    _remove(ctx.aggregates, _keys(batch.rows))
    return deleted


# ── memory ─────────────────────────────────────────────────────────────────────────────────────────────────────

def memory_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """One page of the workspace's memory rows, partition by partition of shared/memory_partitions.py (the company
    memories, each personal status partition of the index, the cursors, the imports: the ones the export reads);
    the verify pass reads them the same way. A memory's events are its own partition, deleted with it."""
    stages = memory_partitions(ctx.scope)
    here = cursor or {'stage': 0, 'start': None}
    index = int(here['stage'])
    if index >= len(stages):
        return Batch([], None)
    part = stages[index]
    # The table's own partitions strongly consistent; an index cannot be (the verify pass reads it again).
    consistency = {} if part.index else {'ConsistentRead': True}
    page = _page(ctx.memory, part.attribute, part.partition, here.get('start'), Limit=PAGE, **part.query_options(),
                 **consistency)
    following = last_key(page)
    return Batch(items(page), {'stage': index, 'start': following} if following else {'stage': index + 1, 'start': None})


def _memory_id(row: Mapping[str, Any]) -> str | None:
    memory_id = row.get('memory_id')
    return memory_id if isinstance(memory_id, str) and memory_id and str(row.get('sk', '')).startswith('MEM#') else None


def _tombstone_memories(ctx: Context, batch: Batch) -> int:
    record = _record(ctx, STORE_MEMORY)
    return _tombstone_each(ctx, ((STORE_MEMORY, memory_id, {**record, 'memory_id': memory_id,
                                                            'scope': str(row.get('scope') or '')})
                                 for row in batch.rows if (memory_id := _memory_id(row)) is not None))


def _delete_memories(ctx: Context, batch: Batch) -> int:
    """Each memory's events (``MEMEVT#{id}``, every page), then the page's rows by their table key (a personal
    memory's base row, as the status index projects it)."""
    deleted = 0
    for memory_id in sorted({memory_id for row in batch.rows if (memory_id := _memory_id(row)) is not None}):
        partition, cursor_start = memory_event_pk(ctx.scope, memory_id), None
        while True:
            page = _page(ctx.memory, 'pk', partition, cursor_start, Limit=PAGE, ConsistentRead=True,
                         ProjectionExpression='pk, sk')
            if rows := items(page):
                deleted += _remove(ctx.memory, _keys(rows))
            cursor_start = last_key(page)
            if cursor_start is None:
                break
    ctx.count('memory_events', deleted)
    return _remove(ctx.memory, _keys(batch.rows)) if batch.rows else 0


# ── exports ────────────────────────────────────────────────────────────────────────────────────────────────────

def _export_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """First every export marked ``erased`` (shared/export_jobs.py ``mark_erased``: no link is signed for one again)
    and every open export upload aborted (the export job's own sweep, as voc-retention's exports phase does), then
    the export jobs' rows a page at a time. Their LOCK, held by the delete, stays until the job's last step
    (handler.py): while it holds ``delete-{ws}`` an erasure that meets the workspace cannot take it over and
    re-create the partition after this sweep (shared/export_jobs.py ``hold_for_erasure``)."""
    if cursor is None:
        mark_erased(ctx.aggregates, ctx.now())
        for upload_key, upload_id in ctx.exports.open_uploads():
            ctx.exports.abort_multipart_upload(upload_key, upload_id)
            ctx.count('export_uploads_aborted')
        return Batch([], {'start': None})
    page = _page(ctx.aggregates, 'pk', export_job_pk(ctx.scope), cursor.get('start'), Limit=PAGE, ConsistentRead=True)
    following = last_key(page)
    return Batch([row for row in items(page) if row.get('sk') != WORKSPACE_LOCK_SK],
                 {'start': following} if following else None)


# ── objects ────────────────────────────────────────────────────────────────────────────────────────────────────

#: Rounds a version S3 would not delete gets before the sweep fails (it resumes from the start of the prefix).
_OBJECT_RETRIES: Final = 5


def _object_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """Every open upload under ``ws/{ws}/`` aborted first, then the first page of versions and delete markers left
    (no listing cursor: what was listed is deleted, so each page lists what is left)."""
    if cursor is None:
        for upload_key, upload_id in ctx.objects.open_uploads():
            ctx.objects.abort_upload(upload_key, upload_id)
            ctx.count('uploads_aborted')
        return Batch([], {'failed_rounds': 0})
    page = ctx.objects.list_page(None)
    rows = [{'key': version.key, 'version_id': version.version_id} for version in page.versions]
    return Batch(rows, {'failed_rounds': int(cursor.get('failed_rounds') or 0)} if rows else None)


def _delete_objects(ctx: Context, batch: Batch) -> int:
    if not batch.rows:
        return 0
    failures = ctx.objects.delete([ObjectVersion(str(row['key']), str(row['version_id'])) for row in batch.rows])
    if failures:
        rounds = int((batch.following or {}).get('failed_rounds') or 0) + 1
        if rounds > _OBJECT_RETRIES:
            raise RuntimeError(f'{len(failures)} object versions could not be deleted')
        if batch.following is not None:
            batch.following['failed_rounds'] = rounds
    return len(batch.rows) - len(failures)


# ── control rows ───────────────────────────────────────────────────────────────────────────────────────────────

def _partition_rows(ctx: Context, cursor_start: object) -> dict[str, Any] | None:
    """One page of ``WS#{ws}`` but ``META`` (its own stage, last: the job's checks read it until then): each row
    deleted, a ``MEMBER#`` row with its member's ``USER#`` row first; the next page's start, or None."""
    rows = ctx.control
    page = control_query(ctx.scope, ctx.workspaces, 'meta', Limit=PAGE, ConsistentRead=True, **start(cursor_start))
    for row in items(page):
        sort_key = str(row['sk'])
        if sort_key == LOOKUP_SORT_KEY:
            continue
        if sort_key.startswith(MEMBER_PREFIX):
            rows.delete_user_row(sort_key.removeprefix(MEMBER_PREFIX))
        rows.delete_partition_row(sort_key)
        ctx.count('control_rows')
    return last_key(page)


def _form_lookups(ctx: Context) -> None:
    rows = ctx.control
    for form_id in inventory(ctx, 'form'):
        _control_change(ctx, lambda form=form_id: rows.delete_form_lookup(form))


def _plugin_rows(ctx: Context) -> None:
    plugins = _plugins(ctx)
    for plugin in plugins:
        ctx.control.delete_plugin_row(plugin)
    ctx.count('control_rows', len(plugins))


def _meta(ctx: Context) -> None:
    ctx.control.delete_meta()
    ctx.count('control_rows')


#: The keyed stages after the partition's rows, in order (each one step).
_CONTROL_STAGES: Final[tuple[Callable[[Context], None], ...]] = (
    _form_lookups,
    _plugin_rows,
    lambda ctx: _control_change(ctx, lambda: ctx.control.delete_listing_row(str(ctx.job.get('listing_sk') or ''))),
    _meta,
    lambda ctx: _control_change(ctx, lambda: ctx.control.mark_slug_deleted(str(ctx.job.get('slug') or ''),
                                                                           ctx.now().isoformat())),
)


def _control_pages(ctx: Context, cursor: dict[str, Any] | None) -> Batch:
    """One stage a step: the rows of ``WS#{ws}`` but ``META`` a page at a time (stage 0); every listed form's lookup
    row; every plugin's ``PLUGIN#`` row; the listing row; ``META`` (only while it reads ``deleting``); the slug guard,
    marked and kept. The audit trail ``AUDIT#WS#{ws}`` stays."""
    here = cursor or {'stage': 0, 'start': None}
    index = int(here['stage'])
    if index == 0:
        following = _partition_rows(ctx, here.get('start'))
        return Batch([], {'stage': 0, 'start': following} if following else {'stage': 1, 'start': None})
    if index > len(_CONTROL_STAGES):
        return Batch([], None)
    _CONTROL_STAGES[index - 1](ctx)
    return Batch([], {'stage': index + 1, 'start': None})


def _control_change(ctx: Context, change: Callable[[], None]) -> None:
    """One keyed control row: a row of another workspace at that key is left and counted, never changed."""
    try:
        change()
    except OutOfScopeError:
        ctx.count('control_rows_of_another_workspace')
        return
    ctx.count('control_rows')


# ── The registry ───────────────────────────────────────────────────────────────────────────────────────────────

def _done_in_pages(_ctx: Context, _batch: Batch) -> int:
    """The control rows' step: each stage deletes its rows itself (one keyed call each), so there is no page left."""
    return 0


#: The aggregates families swept partition by partition (``_partitions_sweep``), in order, with how each finds its
#: partitions: by source or plugin id, by the scraper ids of the config lists (before those lists go), or fixed.
PARTITION_FAMILIES: Final[dict[str, Callable[[Context], Iterable[str]]]] = {
    'source_runs': _source_runs,
    'failures': _failures,
    'circuits': _circuits,
    'logs': _logs,
    'scraper_runs': _scraper_runs,
    'plugin_configs': lambda ctx: [plugin_config_pk(ctx.scope), plugin_config_history_pk(ctx.scope)],
    'feedback_forms': lambda ctx: [ctx.scope.key(FEEDBACK_FORM_PK)],
    'erasure_jobs': lambda ctx: [erasure_job_pk(ctx.scope)],
}


def _family(name: str) -> Sweep:
    return _partitions_sweep(name, PARTITION_FAMILIES[name], note_rows=_note_forms if name == 'feedback_forms' else None)


#: Every sweep, in the order the job runs them (docs/multi-workspace.md, "Export and delete", step 4).
SWEEPS: Final = (
    Sweep('credentials', 'ssm', _credential_pages, _delete_credentials, note=_note_credential_plugins,
          grants=('credentials', 'aggregates')),
    Sweep('feedback', 'feedback', _feedback_pages, delete_keys(lambda ctx: ctx.feedback),
          tombstone=_tombstone_feedback, note=_note_counters, grants=('feedback', 'aggregates', 'tombstones')),
    Sweep('counters', 'aggregates', _counter_pages, delete_keys(lambda ctx: ctx.aggregates),
          grants=('aggregates', 'metricTypeIndex', 'deploymentSettings')),
    *(_family(name) for name in ('source_runs', 'failures', 'circuits', 'logs', 'scraper_runs', 'plugin_configs',
                                 'feedback_forms')),
    owner_list_sweep('import_runs', OWNER_LISTS['import_runs'], grants=('aggregates',)),
    _family('erasure_jobs'),
    Sweep('watermarks', 'watermarks', _watermark_pages, _delete_watermarks, grants=('aggregates', 'watermarks')),
    Sweep('memory', 'memory', memory_pages, _delete_memories, tombstone=_tombstone_memories,
          grants=('memory', 'tombstones')),
    Sweep('exports', 'aggregates', _export_pages, delete_keys(lambda ctx: ctx.aggregates),
          grants=('aggregates', 'exportJobs', 'objects')),
    Sweep('objects', 'bucket', _object_pages, _delete_objects, grants=('objects',)),
    Sweep('control_rows', 'workspaces', _control_pages, _done_in_pages, grants=('controlRows', 'aggregates')),
    # Reserved for voc-lead, owner_list_sweep('conversations', …): voc-conversations' list WS#{ws}#CONVERSANTS (sk
    # {sub}) names each member's WS#{ws}#USER#{sub} (its CONV# and RUNCANCEL# rows); each listed partition goes in
    # full, then the list LAST, so a stopped sweep resumes from it. It brings a conversations view on Context, an
    # OWNER_LISTS row (so the verify pass checks the list is gone), and its own grant group in
    # lib/utils/workspace-delete-grants.ts: Query and BatchWriteItem on voc-conversations, held by LeadingKeys to the
    # workspace's CONVERSANTS and USER partitions. The export's count-only grants there stay as they are.
    # Reserved for voc-lead's P2e, Sweep('projects', …): a WS#{ws}#PROJECT_IDS registry names each project's partitions
    # in voc-projects, voc-jobs and voc-participants (the same owner-list kind, across tables), found without a Scan.
    # Reserved, Sweep('mcp_tokens', …): no MCP token names a workspace until phase 3 pins tokens to one; that change
    # adds a WS#{ws}#MCPTOKENS pointer and this entry.
)
#: The last sweep: the inventory itself (and the export LOCK the delete held), after the verify pass (handler.py).
WORK_PARTITION: Final = 'work_partition'
