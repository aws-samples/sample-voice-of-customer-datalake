"""Cost per workspace: the rows the daily rollup writes and ``GET /platform/costs`` reads (docs/multi-workspace.md,
"Cost per workspace", slice B).

The rows (voc-aggregates, one whole item a day, kept, no TTL; lambda/jobs/cost_rollup/handler.py writes them)::

    pk WS#{ws}#COST      sk YYYY-MM-DD   a workspace's day (``cost_partition``, through the workspace layer)
    pk DEPLOYMENT#COST   sk YYYY-MM-DD   the deployment's own calls, and ``deleted_workspaces``: the calls of every
                                         workspace that was not active when the day was rolled up
    pk UNATTRIBUTED#COST sk YYYY-MM-DD   the calls no handler attributed

Each holds ``schema`` 1, ``by_model`` (one entry per model id as sent and service tier: ``calls``, the four token
counts and ``estimated_usd``), ``totals`` (the counts summed), ``estimated_usd`` (the priced models' sum, None while
none of the day's models is priced), ``complete`` (every model priced), ``unpriced_models``, ``price_as_of`` and
``rolled_up_at``. A day with no metered call has no row.

The route's answer is an estimate from list prices (shared/model_prices.py), never a bill: ``estimate`` true, its
``label``, ``currency`` and ``price_as_of``; per workspace (a page of the listing, ``list_workspaces``'s cursor), and on
the first page the deployment's and the unattributed rows: ``days`` and a ``total`` (with its ``by_model``). A dollar
figure is a decimal string: None while a part with calls is unpriced and nothing is priced, ``0.000000`` for a
complete day or total with no calls.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Final

from shared.concurrency import concurrently, ordered_map
from shared.dynamo_paging import query_all
from shared.dynamo_values import as_count
from shared.exceptions import ValidationError
from shared.model_prices import PRICE_LIST, TOKEN_FIELDS
from shared.platform_workspaces import list_workspaces
from shared.usage_meter import DEPLOYMENT, UNATTRIBUTED
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, partition_query, scope_from_message, ws_table

#: The cost family's part of a workspace's key: ``WS#{ws}#COST`` (the hard delete sweeps it with the settings).
COST_FAMILY: Final = 'COST'
#: Every partition the rollup writes and the route reads (lib/stacks/cost-rollup-worker.ts holds IAM to them), beside
#: each workspace's ``WS#{ws}#COST``.
DEPLOYMENT_COST_PARTITION: Final = f'{DEPLOYMENT}#{COST_FAMILY}'
UNATTRIBUTED_COST_PARTITION: Final = f'{UNATTRIBUTED}#{COST_FAMILY}'
COST_ROW_SCHEMA: Final = 1
#: What a row counts, beside its estimate.
COUNT_FIELDS: Final = ('calls', *TOKEN_FIELDS)
ESTIMATE_LABEL: Final = 'Estimate from list prices, not a bill'
CURRENCY: Final = 'USD'
#: The widest range one request reads (about a quarter), the page size and its ceiling.
MAX_RANGE_DAYS: Final = 92
DEFAULT_LIMIT: Final = 20
MAX_LIMIT: Final = 25
#: A dollar figure's precision on the way out.
_USD_STEP: Final = Decimal('0.000001')


def cost_partition(scope: WorkspaceScope) -> str:
    """``WS#{ws}#COST``: a workspace's cost rows."""
    return scope.key(COST_FAMILY)


@dataclass(frozen=True)
class CostRange:
    """The UTC days of a request, both ends included."""

    start: date
    end: date

    def days(self) -> int:
        return (self.end - self.start).days + 1


def _day(raw: object, name: str) -> date:
    try:
        return date.fromisoformat(str(raw))
    except ValueError as error:
        raise ValidationError(f'{name} must be a date (YYYY-MM-DD)') from error


def parse_range(params: Mapping[str, Any], today: date) -> CostRange:
    """``?from=`` and ``?to=`` (UTC days; ``to`` defaults to today, ``from`` to the first of ``to``'s month): ``to``
    not after today, ``from`` not after ``to``, at most ``MAX_RANGE_DAYS`` days. ValidationError (400) otherwise."""
    end = _day(params['to'], 'to') if params.get('to') else today
    start = _day(params['from'], 'from') if params.get('from') else end.replace(day=1)
    if end > today:
        raise ValidationError('to must not be after today (UTC)')
    if start > end:
        raise ValidationError('from must not be after to')
    chosen = CostRange(start, end)
    if chosen.days() > MAX_RANGE_DAYS:
        raise ValidationError(f'the range is at most {MAX_RANGE_DAYS} days')
    return chosen


def parse_cost_limit(raw: object) -> int:
    """``?limit=``: 1 to ``MAX_LIMIT`` workspaces a page, ``DEFAULT_LIMIT`` when absent; ValidationError otherwise."""
    if raw in (None, ''):
        return DEFAULT_LIMIT
    text = str(raw).strip()
    if not text.isdigit() or not 1 <= int(text) <= MAX_LIMIT:
        raise ValidationError(f'limit must be a whole number from 1 to {MAX_LIMIT}')
    return int(text)


# ── Summing ───────────────────────────────────────────────────────────────────────────────────────────────────

def _usd(value: object) -> Decimal | None:
    return value if isinstance(value, Decimal) else None


@dataclass
class _Sum:
    """Counts, the priced part's dollars (None until a priced part is added), whether every part was priced."""

    counts: dict[str, int] = field(default_factory=lambda: dict.fromkeys(COUNT_FIELDS, 0))
    usd: Decimal | None = None
    complete: bool = True
    unpriced: set[str] = field(default_factory=set)

    def add(self, counts: Mapping[str, Any], usd: object, complete: object, unpriced: Iterable[object] = ()) -> None:
        for name in COUNT_FIELDS:
            self.counts[name] += as_count(counts.get(name))
        if (priced := _usd(usd)) is not None:
            self.usd = priced if self.usd is None else self.usd + priced
        self.complete = self.complete and complete is True
        self.unpriced.update(str(model) for model in unpriced)

    def public(self) -> dict[str, Any]:
        # Nothing to price and nothing unpriced (no calls): a known zero, not an unknown.
        usd = Decimal(0) if self.usd is None and self.complete and not self.unpriced else self.usd
        return {**self.counts, 'estimated_usd': usd_text(usd), 'complete': self.complete,
                'unpriced_models': sorted(self.unpriced)}


def usd_text(value: Decimal | None) -> str | None:
    """A dollar figure on the way out: a decimal string to the millionth, None when a part with calls is unpriced
    and nothing is priced."""
    return None if value is None else str(value.quantize(_USD_STEP))


def _add_row(total: _Sum, row: Mapping[str, Any]) -> None:
    totals = row.get('totals')
    unpriced = row.get('unpriced_models')
    total.add(totals if isinstance(totals, Mapping) else {}, row.get('estimated_usd'), row.get('complete'),
              unpriced if isinstance(unpriced, list) else ())


def _by_model(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Each model and tier's sum over ``rows``, by model id then tier."""
    sums: dict[tuple[str, str], _Sum] = {}
    for row in rows:
        entries = row.get('by_model')
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, Mapping):
                continue
            key = (str(entry.get('model_id') or ''), str(entry.get('service_tier') or ''))
            usd = _usd(entry.get('estimated_usd'))
            sums.setdefault(key, _Sum()).add(entry, usd, usd is not None, () if usd is not None else (key[0],))
    return [{'model_id': model, 'service_tier': tier, **summed.public()} for (model, tier), summed in sorted(sums.items())]


def summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """One entity's ``days`` (only the days with a row) and ``total`` (with its ``by_model``). No month sums: the
    range is at most ``MAX_RANGE_DAYS``, so a reader sums the days it shows."""
    days = []
    total = _Sum()
    for row in rows:
        day = _Sum()
        _add_row(day, row)
        _add_row(total, row)
        days.append({'date': str(row.get('sk', '')), **day.public()})
    return {'days': days, 'total': {**total.public(), 'by_model': _by_model(rows)}}


def _deployment_summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The deployment's summary, and its rows' ``deleted_workspaces`` summed over the range."""
    deleted = _Sum()
    for row in rows:
        part = row.get('deleted_workspaces')
        if isinstance(part, Mapping):
            _add_row(deleted, part)
    return {**summary(rows), 'deleted_workspaces': deleted.public()}


# ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────

_RANGE_CONDITION: Final = '#d BETWEEN :from AND :to'


def _range_options(chosen: CostRange) -> dict[str, Any]:
    """The range's Query options, beside the key condition ``_RANGE_CONDITION``."""
    return {'ExpressionAttributeNames': {'#d': 'sk'},
            'ExpressionAttributeValues': {':from': chosen.start.isoformat(), ':to': chosen.end.isoformat()}}


def workspace_rows(table: Any, scope: WorkspaceScope, chosen: CostRange) -> list[dict[str, Any]]:
    """A workspace's rows of the range (one a day at most), through the workspace layer (``ws_table``)."""
    return list(ws_table(scope, table).iter_query('pk', cost_partition(scope), sort_condition=_RANGE_CONDITION,
                                                  max_items=chosen.days(), **_range_options(chosen)))


def deployment_rows(table: Any, partition: str, chosen: CostRange) -> list[dict[str, Any]]:
    """The deployment's or the unattributed rows of the range, one a day at most (``DEPLOYMENT_COST_PARTITION``,
    ``UNATTRIBUTED_COST_PARTITION``: no workspace's)."""
    if partition not in (DEPLOYMENT_COST_PARTITION, UNATTRIBUTED_COST_PARTITION):
        raise ValueError('not a deployment cost partition')
    return query_all(table, partition_query('pk', partition, _RANGE_CONDITION, _range_options(chosen)),
                     max_items=chosen.days())


def _workspace_entry(table: Any, workspace: Mapping[str, Any], chosen: CostRange) -> dict[str, Any]:
    # The listing row's id (shared/platform_workspaces.py checked it), never a request field.
    scope = scope_from_message({WORKSPACE_FIELD: workspace['id']})
    return {key: workspace[key] for key in ('id', 'name', 'slug', 'status')} | summary(
        workspace_rows(table, scope, chosen))


def cost_page(workspaces_table: Any, aggregates_table: Any, chosen: CostRange, *, limit: int,
              cursor: str | None) -> dict[str, Any]:
    """The ``GET /platform/costs`` body: a page of workspaces (one Query each, concurrently), and on the first page
    (no ``cursor``) the deployment's and the unattributed rows. ValidationError (400) for a cursor ``list_workspaces``
    refuses; any other fault is the caller's 500."""
    try:
        workspaces, next_cursor = list_workspaces(workspaces_table, limit=limit, cursor=cursor)
    except ValueError as error:
        raise ValidationError('cursor is not valid') from error
    first_page = cursor is None

    def deployment() -> dict[str, Any] | None:
        return _deployment_summary(deployment_rows(aggregates_table, DEPLOYMENT_COST_PARTITION, chosen)) \
            if first_page else None

    def unattributed() -> dict[str, Any] | None:
        return summary(deployment_rows(aggregates_table, UNATTRIBUTED_COST_PARTITION, chosen)) \
            if first_page else None

    entries, deployment_entry, unattributed_entry = concurrently(
        lambda: ordered_map(lambda workspace: _workspace_entry(aggregates_table, workspace, chosen), workspaces),
        deployment, unattributed)
    body: dict[str, Any] = {
        'estimate': True, 'label': ESTIMATE_LABEL, 'currency': CURRENCY, 'price_as_of': PRICE_LIST.as_of,
        'price_source': PRICE_LIST.source_url, 'from': chosen.start.isoformat(), 'to': chosen.end.isoformat(),
        'workspaces': entries, 'next_cursor': next_cursor,
    }
    if first_page:
        body['deployment'] = deployment_entry
        body['unattributed'] = unattributed_entry
    return body
