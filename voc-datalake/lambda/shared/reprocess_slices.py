"""
The slice a category-reprocess job replays (TENETS.md D3): which reviews it reads.

``POST /settings/categories/reprocess`` takes, beside ``mode``:

* ``sources``    — up to 50 source ids (``source_platform``); absent = every source.
  Matched on each item's ``source_platform`` in the Scan's filter, never on its
  partition: a review with a brand name is stored under ``SOURCE#{brand_name}``.
* ``categories`` — up to 50 stored category names; absent = every category.
* ``days``       — the platform window (0 = all time), OR
* ``date_from`` / ``date_to`` — ``YYYY-MM-DD``, inclusive, either may be left open.
  ``days`` and a date range are mutually exclusive.
* ``date_basis`` — ``processed`` (the default: the item's ``date``, when it was
  processed) or ``review`` (``source_created_at``, when the customer wrote it,
  falling back to ``date`` like every review-basis read, ``shared.feedback.basis_date``).

Data-layer only: the settings API parses and stores a slice on the job row, the
worker reads it back (``slice_from_job``) and filters with ``admits``.

How a page is read (``read_page``, ``read_day_page``):

* The deployment's job: a Scan of voc-feedback, filtered (``read_filter``); its cursor is the Scan's
  ``LastEvaluatedKey`` (``{pk, sk}``).
* A workspace's job: Queries of voc-feedback's ``gsi1-by-date``, one day partition ``WS#{ws}#DATE#{day}`` at a time,
  oldest first, with the same filter (``walk_days`` chooses the days: from the first day the workspace can hold, the
  day before its ``META`` ``created_at``, to today UTC, clipped to a processed-date window). The processor stamps
  ``gsi1pk`` with the day it processed a review (lambda/processor/handler.py ``build_feedback_item``: the same day as
  ``date``), and only an active workspace is written to, so no review of a workspace is filed before it existed,
  whatever its own ``source_created_at``. Its cursor is ``{day, start}`` (``WALK_DAY``, ``WALK_START``: the day
  partition, and the Query's ``LastEvaluatedKey`` in it, absent at the day's start). No writer sets or removes a
  review's ``gsi1pk`` / ``gsi1sk`` or ``date`` after the processor's put (the reprocess moves ``gsi2pk`` and
  ``gsi3pk`` only; shared/source_updates.py and shared/csv_updates.py keep them), so a review never moves under the
  walk. Both facts are held by guards that name this walk: lambda/shared/test/test_feedback_day_index_writers.py (no
  production write of ``gsi1pk`` / ``gsi1sk``, or update naming ``date``, but the processor's conditional first put)
  and lib/customer-data-deletes.test.ts "voc-feedback: only the processor puts an item" (no other role may put one). A workspace's job still Scans (through the workspace layer, ``WorkspaceTable.scan``) when its cursor is a
  Scan's (``is_walk_cursor`` false: checkpointed before the walk) or its workspace names no creation time.

The walk is shared (7.96.00): ``first_walk_day``, ``day_span``, ``query_day_page`` and ``position_after`` also serve a
workspace's erasure (jobs/retention/item_walk.py), which filters each day with its erasure's own filter, reads the
hits' keys alone and decides each on the table's own row.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.api import ALL_TIME_DAYS
from shared.feedback import DATE_BASIS_IMPORTED, DATE_BASIS_REVIEW, basis_date
from shared.indexes import FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_DATE_POSITION
from shared.retention import FEEDBACK_SK_PREFIX
from shared.scoped_query import query_partition
from shared.timestamps import ISO_DAY_RE, parse_iso
from shared.ws_repo import WORKSPACE_KEY_PREFIX, WorkspaceScope, date_pk, is_workspace_key, ws_table

DATE_BASIS_PROCESSED: Final = 'processed'
DATE_BASES: Final = (DATE_BASIS_PROCESSED, DATE_BASIS_REVIEW)
MAX_SLICE_VALUES: Final = 50
MAX_SLICE_VALUE_CHARS: Final = 128
#: A workspace walk's cursor: the day partition being read, and the Query's ``LastEvaluatedKey`` in it.
WALK_DAY: Final = 'day'
WALK_START: Final = 'start'
#: The key of a walk page naming the day it was read from (``position_after``).
PAGE_DAY: Final = 'Day'


@dataclass(frozen=True)
class ReprocessSlice:
    """What one job replays. ``days`` None = the window is ``date_from``/``date_to``."""

    sources: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    days: int | None = ALL_TIME_DAYS
    date_from: str | None = None
    date_to: str | None = None
    date_basis: str = DATE_BASIS_PROCESSED

    def window(self, today: datetime) -> tuple[str | None, str | None]:
        """First and last included day (``None`` = open); ``days`` counts back from ``today``."""
        if self.days is None:
            return self.date_from, self.date_to
        if self.days <= ALL_TIME_DAYS:
            return None, None
        return (today - timedelta(days=self.days - 1)).strftime('%Y-%m-%d'), None

    def pinned_at(self, started: datetime) -> ReprocessSlice:
        """The same slice with a ``days`` window fixed to the days it covered at ``started``.

        A resume replays what its partial job started on: counted back from the resume's own day, a
        ``days`` window would move and skip the reviews of its first days still after the cursor.
        """
        if self.days is None or self.days <= ALL_TIME_DAYS:
            return self
        first, _last = self.window(started)
        return replace(self, days=None, date_from=first, date_to=started.strftime('%Y-%m-%d'))

    def fields(self) -> dict[str, Any]:
        """The job-row fields (only the axes this slice narrows, plus its basis)."""
        stored: dict[str, Any] = {'date_basis': self.date_basis}
        for name in ('sources', 'categories'):
            values = getattr(self, name)
            if values:
                stored[name] = list(values)
        for name in ('date_from', 'date_to'):
            value = getattr(self, name)
            if value:
                stored[name] = value
        return stored


def _values(body: Mapping[str, Any], name: str) -> tuple[str, ...]:
    """A list of distinct non-blank strings within the bounds; ValueError (client-safe) otherwise."""
    raw = body.get(name)
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(value, str) for value in raw):
        raise ValueError(f'{name} must be a list of strings')
    values = tuple(dict.fromkeys(value.strip() for value in raw if value.strip()))
    if len(values) > MAX_SLICE_VALUES:
        raise ValueError(f'{name} accepts at most {MAX_SLICE_VALUES} values')
    if any(len(value) > MAX_SLICE_VALUE_CHARS for value in values):
        raise ValueError(f'{name} values must be at most {MAX_SLICE_VALUE_CHARS} characters')
    return values


def _day(body: Mapping[str, Any], name: str) -> str | None:
    raw = body.get(name)
    if raw is None:
        return None
    if not isinstance(raw, str) or not ISO_DAY_RE.fullmatch(raw):
        raise ValueError(f'{name} must be a date (YYYY-MM-DD)')
    try:
        date.fromisoformat(raw)
    except ValueError as e:
        raise ValueError(f'{name} must be a real date (YYYY-MM-DD)') from e
    return raw


def _date_basis(body: Mapping[str, Any]) -> str:
    raw = body.get('date_basis')
    if raw is None:
        return DATE_BASIS_PROCESSED
    if raw not in DATE_BASES:
        raise ValueError(f"date_basis must be one of: {', '.join(DATE_BASES)}")
    return str(raw)


def parse_slice(body: Mapping[str, Any], parse_days: Callable[[object], int]) -> ReprocessSlice:
    """The slice a start body asks for. ``parse_days`` validates ``days`` (the route's own rule).

    ValueError (client-safe) on a malformed axis, on ``days`` together with a date
    range, or on ``date_from`` after ``date_to``. Without a date range ``days`` is
    required, as it always was.
    """
    date_from, date_to = _day(body, 'date_from'), _day(body, 'date_to')
    ranged = date_from is not None or date_to is not None
    if ranged and 'days' in body:
        raise ValueError('days and date_from/date_to are mutually exclusive')
    if date_from and date_to and date_from > date_to:
        raise ValueError('date_from must not be after date_to')
    return ReprocessSlice(
        sources=_values(body, 'sources'),
        categories=_values(body, 'categories'),
        days=None if ranged else parse_days(body.get('days')),
        date_from=date_from,
        date_to=date_to,
        date_basis=_date_basis(body),
    )


def _stored_values(job: Mapping[str, Any], name: str) -> tuple[str, ...]:
    raw = job.get(name)
    if not isinstance(raw, (list, tuple)):
        return ()
    return tuple(value for value in raw if isinstance(value, str) and value)


def _stored_day(job: Mapping[str, Any], name: str) -> str | None:
    raw = job.get(name)
    return raw if isinstance(raw, str) and ISO_DAY_RE.fullmatch(raw) else None


def _stored_days(job: Mapping[str, Any]) -> int:
    raw = job.get('days', ALL_TIME_DAYS)
    if isinstance(raw, bool):
        return ALL_TIME_DAYS
    try:
        return int(raw)
    except (TypeError, ValueError):
        return ALL_TIME_DAYS


def slice_from_job(job: Mapping[str, Any]) -> ReprocessSlice:
    """The slice stored on a job row; a row from before slices is ``days`` only."""
    date_from, date_to = _stored_day(job, 'date_from'), _stored_day(job, 'date_to')
    basis = job.get('date_basis')
    return ReprocessSlice(
        sources=_stored_values(job, 'sources'),
        categories=_stored_values(job, 'categories'),
        days=None if (date_from or date_to) else _stored_days(job),
        date_from=date_from,
        date_to=date_to,
        date_basis=basis if basis in DATE_BASES else DATE_BASIS_PROCESSED,
    )


def admits(item: Mapping[str, Any], job_slice: ReprocessSlice, window: tuple[str | None, str | None],
           scope: WorkspaceScope | None = None) -> bool:
    """Is ``item`` inside the slice? (The read's filter narrows first; this is the rule.) A job of the deployment
    (``scope`` None) never admits a workspace's item, and a workspace's job (since 7.13.00) only that workspace's
    (``WS#{ws}#…``): each job rewrites its own scope's items and index partitions only."""
    if scope is None:
        if is_workspace_key(item.get('pk')):
            return False
    elif not scope.owns(item.get('pk')):
        return False
    if job_slice.sources and item.get('source_platform') not in job_slice.sources:
        return False
    if job_slice.categories and item.get('category') not in job_slice.categories:
        return False
    first, last = window
    if first is None and last is None:
        return True
    basis = DATE_BASIS_REVIEW if job_slice.date_basis == DATE_BASIS_REVIEW else DATE_BASIS_IMPORTED
    day = str(basis_date(item, basis) or '')
    if not day:
        return False
    return (first is None or day >= first) and (last is None or day <= last)


def read_filter(job_slice: ReprocessSlice, window: tuple[str | None, str | None],
                scope: WorkspaceScope | None = None) -> ConditionBase:
    """The FilterExpression a page's Scan applies: feedback rows (the deployment's for a job of the deployment;
    a workspace's job reads through the workspace layer, which adds its own partition's prefix), the sources
    (``source_platform``), the categories and a processed-date window.

    A review-date window is not pushed down (its fallback to ``date`` cannot be
    expressed); ``admits`` applies it.
    """
    conditions: list[ConditionBase] = [Attr('sk').begins_with(FEEDBACK_SK_PREFIX)]
    if scope is None:
        conditions.append(~Attr('pk').begins_with(WORKSPACE_KEY_PREFIX))
    if job_slice.sources:
        conditions.append(Attr('source_platform').is_in(list(job_slice.sources)))
    if job_slice.categories:
        conditions.append(Attr('category').is_in(list(job_slice.categories)))
    first, last = window
    if job_slice.date_basis == DATE_BASIS_PROCESSED:
        if first is not None:
            conditions.append(Attr('date').gte(first))
        if last is not None:
            conditions.append(Attr('date').lte(last))
    combined = conditions[0]
    for condition in conditions[1:]:
        combined &= condition
    return combined


def read_page(
    table: Any, cursor: dict | None, job_slice: ReprocessSlice, window: tuple[str | None, str | None],
    page_size: int, scope: WorkspaceScope | None = None,
) -> dict:
    """One page of the slice: a Scan whose filter names the sources, categories and processed-date window; for a
    workspace's job (``scope``) through the workspace layer (shared/ws_repo.py ``WorkspaceTable.scan``), which
    answers only ``WS#{ws}#…`` rows. A workspace's job reads this way only where its day walk cannot start
    (``read_day_page``, the module docstring).

    Sources are matched on ``source_platform``, never on the partition: the processor stores an item under
    ``SOURCE#{brand_name}`` when it has a brand name, so a Query of ``SOURCE#{source}`` would skip it (the
    retention job matches sources the same way).
    """
    kwargs: dict[str, Any] = {'Limit': page_size, 'FilterExpression': read_filter(job_slice, window, scope)}
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    if scope is not None:
        return ws_table(scope, table).scan(**kwargs)
    return table.scan(**kwargs)


def is_walk_cursor(cursor: Mapping[str, Any] | None) -> bool:
    """Whether ``cursor`` is where a day walk goes on: none yet, or a ``{day, start}`` one (a Scan's is ``{pk, sk}``)."""
    return not cursor or WALK_DAY in cursor


def first_walk_day(created_at: object) -> date | None:
    """The first day partition a workspace's walk reads, from its ``META``'s ``created_at``
    (shared/ws_repo.py ``workspace_created_at``): the UTC day before it (one day of margin for the clocks of the API
    that created the workspace and of the processor), or None when it is not a readable ISO time (the walk cannot
    start: the job Scans instead). The category reprocess's and a workspace's erasure's (jobs/retention/item_walk.py)."""
    created = parse_iso(created_at)
    return None if created is None else created.astimezone(UTC).date() - timedelta(days=1)


def day_span(first_possible: date, today: date) -> tuple[str, str]:
    """The first and last day partition of a whole walk: ``first_possible`` to ``today``, inclusive."""
    return first_possible.isoformat(), today.isoformat()


def walk_days(job_slice: ReprocessSlice, window: tuple[str | None, str | None], first_possible: date,
              today: date) -> tuple[str, str]:
    """The first and last day partition a workspace's walk reads: ``first_possible`` to ``today``, inclusive, narrowed
    to a processed-date window (a review-date window does not choose the days: a review's processing day is not its
    own date). The first may come after the last: nothing to read."""
    first, last = day_span(first_possible, today)
    if job_slice.date_basis == DATE_BASIS_PROCESSED:
        since, until = window
        first = max(first, since) if since else first
        last = min(last, until) if until else last
    return first, last


def walk_day(raw: Any) -> str:
    """A walk cursor's day, held to ``YYYY-MM-DD`` and a real date. The walk compares days as strings, so another
    shape ``date.fromisoformat`` takes (``20261110``, ``2026-W46-2``) would sort past the last day and end the walk
    with days unread: it is refused instead (ValueError; the job fails and is started again, never skips days)."""
    if not isinstance(raw, str) or not ISO_DAY_RE.fullmatch(raw):
        raise ValueError(f'walk cursor day must be a date (YYYY-MM-DD), got {raw!r}')
    try:
        date.fromisoformat(raw)
    except ValueError as e:
        raise ValueError(f'walk cursor day must be a real date (YYYY-MM-DD), got {raw!r}') from e
    return raw


def read_day_page(
    table: Any, cursor: Mapping[str, Any] | None, job_slice: ReprocessSlice, window: tuple[str | None, str | None],
    page_size: int, scope: WorkspaceScope, days: tuple[str, str],
) -> dict:
    """One page of a workspace's walk (the module docstring): a Query of the cursor's day partition (the first of
    ``days`` without a cursor) on gsi1-by-date, through the workspace layer (shared/scoped_query.py
    ``query_partition``), with ``read_filter``'s filter. Returns the page's ``Items``, its day (``PAGE_DAY``) and,
    unless the walk is done, the next page's cursor as ``LastEvaluatedKey``: the same day from the Query's last key,
    else the next day while it is not past the last of ``days``. A cursor whose day is past the last reads nothing; one
    whose day is not a real ``YYYY-MM-DD`` date raises ValueError (``walk_day``): the job fails, never skips days."""
    return query_day_page(table, cursor, page_size, scope, days,
                          FilterExpression=read_filter(job_slice, window, scope))


def query_day_page(
    table: Any, cursor: Mapping[str, Any] | None, page_size: int, scope: WorkspaceScope, days: tuple[str, str],
    **options: Any,
) -> dict:
    """``read_day_page``'s walk with the rest of the Query in ``options`` (a filter, and a keys-only projection: a
    workspace's erasure filters with its own filter, reads the hits' keys alone and decides on the table's row,
    jobs/retention/item_walk.py). The same pages and cursors."""
    day = walk_day(cursor[WALK_DAY]) if cursor else days[0]
    following_day = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
    if day > days[1]:
        return {'Items': [], PAGE_DAY: day}
    kwargs: dict[str, Any] = {'IndexName': FEEDBACK_BY_DATE_INDEX, 'Limit': page_size, **options}
    start = cursor.get(WALK_START) if cursor else None
    if start:
        kwargs['ExclusiveStartKey'] = dict(start)
    response = query_partition(scope, table, 'gsi1pk', date_pk(scope, day), **kwargs)
    page: dict[str, Any] = {'Items': response.get('Items') or [], PAGE_DAY: day}
    last_key = response.get('LastEvaluatedKey')
    if last_key:
        page['LastEvaluatedKey'] = {WALK_DAY: day, WALK_START: dict(last_key)}
    elif following_day <= days[1]:
        page['LastEvaluatedKey'] = {WALK_DAY: following_day}
    return page


def position_after(page: Mapping[str, Any], item: Mapping[str, Any]) -> dict[str, Any]:
    """The cursor that goes on just after ``item`` of ``page``: in a walk's page its day and its gsi1 position
    (shared/indexes.py ``FEEDBACK_BY_DATE_POSITION``), in a Scan's its table key."""
    if PAGE_DAY in page:
        return {WALK_DAY: page[PAGE_DAY], WALK_START: {name: item[name] for name in FEEDBACK_BY_DATE_POSITION}}
    return {'pk': item['pk'], 'sk': item['sk']}
