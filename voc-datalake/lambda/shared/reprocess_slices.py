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
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.api import ALL_TIME_DAYS
from shared.feedback import DATE_BASIS_IMPORTED, DATE_BASIS_REVIEW, basis_date
from shared.retention import FEEDBACK_SK_PREFIX
from shared.timestamps import ISO_DAY_RE

DATE_BASIS_PROCESSED: Final = 'processed'
DATE_BASES: Final = (DATE_BASIS_PROCESSED, DATE_BASIS_REVIEW)
MAX_SLICE_VALUES: Final = 50
MAX_SLICE_VALUE_CHARS: Final = 128


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


def admits(item: Mapping[str, Any], job_slice: ReprocessSlice, window: tuple[str | None, str | None]) -> bool:
    """Is ``item`` inside the slice? (The read's filter narrows first; this is the rule.)"""
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


def read_filter(job_slice: ReprocessSlice, window: tuple[str | None, str | None]) -> ConditionBase:
    """The FilterExpression a page's Scan applies: feedback rows, the sources (``source_platform``), the
    categories and a processed-date window.

    A review-date window is not pushed down (its fallback to ``date`` cannot be
    expressed); ``admits`` applies it.
    """
    conditions: list[ConditionBase] = [Attr('sk').begins_with(FEEDBACK_SK_PREFIX)]
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
    page_size: int,
) -> dict:
    """One page of the slice: a Scan whose filter names the sources, categories and processed-date window.

    Sources are matched on ``source_platform``, never on the partition: the processor stores an item under
    ``SOURCE#{brand_name}`` when it has a brand name, so a Query of ``SOURCE#{source}`` would skip it (the
    retention job matches sources the same way).
    """
    kwargs: dict[str, Any] = {'Limit': page_size, 'FilterExpression': read_filter(job_slice, window)}
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    return table.scan(**kwargs)
