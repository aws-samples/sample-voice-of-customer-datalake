"""voc-cost-rollup: the daily rollup of the ``bedrock_usage`` lines into cost rows (docs/multi-workspace.md, "Cost
per workspace", slice B; the rows: shared/platform_costs.py).

Two ways in:

- ``{"mode": "scheduled"}``, the 02:15 UTC tick: yesterday and the day before (``SCHEDULED_DAYS_BACK``), so a line
  that reached CloudWatch late is counted by the second run.
- ``{"days": ["YYYY-MM-DD", ...]}``, a manual backfill (an async invoke by an operator): each day over, at most
  ``MAX_DAYS_BACK`` days back (the Lambda log groups keep 30 days).

Each day is read with CloudWatch Logs Insights over the deployment's ``voc-*`` Lambda log groups, listed as the
System logs search lists them (shared/system_log_sources.py ``discover``), ``GROUPS_PER_QUERY`` groups a query and
``QUERIES_AT_ONCE`` queries at a time, each ``filter @timestamp`` in the day to the millisecond, then ``filter
message="bedrock_usage" and ispresent(model_id) and ispresent(operation) | stats …`` by workspace, model id and
service tier (``day_query``), the batches' rows summed. A day is written only when every one of its queries
completed under Insights' result cap; otherwise nothing of it is written and the run raises once the other days are
done (no async retry: the next tick or a backfill reruns it). A query still running past ``POLL_BUDGET_SECONDS`` is
stopped; a day whose read or write AWS refuses is recorded as failed with the error's code, and the others still run.

Then one whole-item PutItem per row and day (no ADD anywhere, so a rerun overwrites it): ``WS#{ws}#COST`` through the
workspace layer for each workspace that is active (``WorkspaceStatusCheck``), ``DEPLOYMENT#COST`` and
``UNATTRIBUTED#COST``. A workspace that is not active (deleting, deleted, or never was) gets no row: its calls are
added to ``DEPLOYMENT#COST``'s ``deleted_workspaces``. Each model's cost comes from shared/model_prices.py (None while
unpriced: its tokens are counted, the row is incomplete). The job calls no model.

Env: ``AGGREGATES_TABLE``, ``WORKSPACES_TABLE``, ``SYSTEM_LOG_GROUP_PATTERN``.
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from functools import cache
from typing import Any, Final

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from shared import usage_meter
from shared.aws import get_dynamodb_resource
from shared.exceptions import ConfigurationError
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.model_prices import PRICE_LIST, PriceList, estimated_usd, is_estimate
from shared.platform_costs import (
    COST_ROW_SCHEMA,
    COUNT_FIELDS,
    DEPLOYMENT_COST_PARTITION,
    UNATTRIBUTED_COST_PARTITION,
    cost_partition,
)
from shared.system_log_sources import PATTERN_ENV, SOURCE_LAMBDA, LogGroupPattern, LogSources, discover
from shared.system_logs import (
    ROW_LIMIT,
    aws_error_code,
    log_group_batches,
    poll,
    result_row,
    start_queries,
    stop_queries,
)
from shared.usage_meter import DEPLOYMENT, UNATTRIBUTED
from shared.warm_init import warm_at_init
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, WorkspaceStatusCheck, scope_from_message, ws_table

AGGREGATES_TABLE, WORKSPACES_TABLE = (os.environ.get(name, '') for name in ('AGGREGATES_TABLE', 'WORKSPACES_TABLE'))
#: The scheduled run's days, as days back from today (UTC).
SCHEDULED_DAYS_BACK: Final = (1, 2)
#: The furthest back a backfill reaches: the Lambda log groups keep 30 days (lib/utils/log-retention.ts).
MAX_DAYS_BACK: Final = 29
#: Insights queries running at once (the account allows 30; the System logs search shares them) and how long a
#: round of them may take.
QUERIES_AT_ONCE: Final = 4
POLL_BUDGET_SECONDS: Final = 240.0
#: The end of the invocation no round polls into (the writes and the outcome's log line come after it).
RESERVE_SECONDS: Final = 60.0
SECONDS_PER_DAY: Final = 86400
#: What a day's query keeps: the usage line itself (its message, and the fields only it carries), never a line that
#: merely mentions it.
USAGE_FILTER: Final = (f'message = "{usage_meter.USAGE_LINE}" and ispresent(model_id) and ispresent(operation)')
#: What it counts, by workspace, model and tier (``ROW_LIMIT`` rows at most; a day that reaches it is not written).
_STATS: Final = ('stats count(*) as calls, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, '
                 'sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens '
                 f'by workspace_id, model_id, service_tier | limit {ROW_LIMIT}')


def day_query(start_ms: int, end_ms: int) -> str:
    """The query of the day ``[start_ms, end_ms)``: the window filtered to the millisecond, whatever Insights rounds
    the query's own start and end to. Only integers go in: each bound passes through ``int`` (its callers hand it
    epoch milliseconds), so no text from an event or a request reaches the query."""
    return (f'filter @timestamp >= {int(start_ms)} and @timestamp < {int(end_ms)} | filter {USAGE_FILTER} '
            f'| {_STATS}')


#: A stored dollar figure's precision.
_STORED_USD_STEP: Final = Decimal('0.000000001')

#: (model id as sent, service tier) -> the counts of COUNT_FIELDS.
Usage = dict[tuple[str, str], dict[str, int]]


class IncompleteDay(Exception):
    """A day's queries did not all complete under the result cap: nothing of the day is written."""


class RollupIncomplete(RuntimeError):
    """At least one day of the run was not written (``days``: each with its reason)."""


@dataclass(frozen=True)
class Rollup:
    """What a run reaches, injected: the Logs client, voc-aggregates (a boto3 Table), the workspaces' status check,
    the clock (UTC), and the polling's own clock and sleep."""

    logs: Any
    aggregates: Any
    is_active: Callable[[WorkspaceScope], bool]
    now: Callable[[], datetime]
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    price_list: PriceList = PRICE_LIST
    poll_budget: float = POLL_BUDGET_SECONDS
    #: Seconds left of the invocation (the Lambda context's); a round never polls into ``RESERVE_SECONDS``.
    remaining: Callable[[], float] = field(default=lambda: float('inf'))

    def round_budget(self) -> float:
        """How long the next round of queries may poll: the budget, or what is left before the reserve."""
        return min(self.poll_budget, self.remaining() - RESERVE_SECONDS)


# ── Which days ────────────────────────────────────────────────────────────────────────────────────────────────

def days_to_roll_up(event: Mapping[str, Any], today: date) -> list[date]:
    """The scheduled run's days, or a backfill's (``days``): each a date over (before today) and at most
    ``MAX_DAYS_BACK`` days back, without repeats. ValueError for anything else (nothing is run)."""
    if 'days' not in event:
        return [today - timedelta(days=back) for back in SCHEDULED_DAYS_BACK]
    raw = event['days']
    if not isinstance(raw, list) or not raw or len(raw) > MAX_DAYS_BACK:
        raise ValueError(f'days must list 1 to {MAX_DAYS_BACK} dates')
    days: list[date] = []
    for value in raw:
        day = date.fromisoformat(str(value))
        if not 1 <= (today - day).days <= MAX_DAYS_BACK:
            raise ValueError(f'each day must be over and at most {MAX_DAYS_BACK} days back')
        if day not in days:
            days.append(day)
    return days


def lambda_log_groups(logs: Any) -> list[str]:
    """The deployment's ``voc-*`` Lambda log groups (``SYSTEM_LOG_GROUP_PATTERN``), listed as the System logs search
    lists them; ConfigurationError when the pattern is not set."""
    pattern = LogGroupPattern.parse(os.environ.get(PATTERN_ENV, ''))
    if pattern is None:
        raise ConfigurationError('The cost rollup has no log group pattern')
    return [target.name for target in discover(logs, LogSources(lambdas=pattern)) if target.source == SOURCE_LAMBDA]


# ── Reading a day ─────────────────────────────────────────────────────────────────────────────────────────────

def _epoch(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp())


def query_day(rollup: Rollup, groups: list[str], day: date) -> list[dict[str, str]]:
    """Every result row of ``day`` over ``groups``: ``QUERIES_AT_ONCE`` queries a round, each round polled for at
    most the budget. IncompleteDay when a query fails, runs past the budget (it is stopped) or reaches the cap."""
    start = _epoch(day)
    end = start + SECONDS_PER_DAY
    query = day_query(start * 1000, end * 1000)
    batches = list(log_group_batches(groups))
    rows: list[dict[str, str]] = []
    for first in range(0, len(batches), QUERIES_AT_ONCE):
        budget = rollup.round_budget()
        if budget <= 0:
            raise IncompleteDay('the invocation ran out of time')
        plan = [(batch, query) for batch in batches[first:first + QUERIES_AT_ONCE]]
        try:
            ids = start_queries(rollup.logs, plan, start, end)
            status, answers = poll(rollup.logs, ids, budget, rollup.sleep, rollup.monotonic)
        except (ClientError, BotoCoreError) as error:
            # Every query of the round is stopped first (shared/system_logs.py); the AWS text stays out of the row.
            raise IncompleteDay(f'the log search failed ({aws_error_code(error)})') from error
        if status == 'running':
            stop_queries(rollup.logs, ids)
            raise IncompleteDay('a query ran past its time budget')
        if status != 'complete':
            raise IncompleteDay('a query failed')
        for answer in answers:
            results = answer.get('results') or []
            if len(results) >= ROW_LIMIT:
                raise IncompleteDay('a query reached the result cap')
            rows.extend(result_row(fields) for fields in results)
    return rows


def _number(text: object) -> int:
    """A stats value: a whole, non-negative number ('' is 0, an absent sum); ValueError for anything else."""
    if text in (None, ''):
        return 0
    try:
        value = Decimal(str(text))
    except InvalidOperation as error:
        raise ValueError('a usage count is not a number') from error
    if not value.is_finite() or value < 0 or value != value.to_integral_value():
        raise ValueError('a usage count is not a whole non-negative number')
    return int(value)


def usage_by_attribution(rows: Iterable[Mapping[str, str]]) -> dict[str, Usage]:
    """The rows summed by what each is counted to (its ``workspace_id``; none: ``UNATTRIBUTED``), model and tier."""
    summed: dict[str, Usage] = {}
    for row in rows:
        attribution = row.get('workspace_id') or UNATTRIBUTED
        key = (row.get('model_id') or '', row.get('service_tier') or '')
        counts = summed.setdefault(attribution, {}).setdefault(key, dict.fromkeys(COUNT_FIELDS, 0))
        for name in COUNT_FIELDS:
            counts[name] += _number(row.get(name))
    return summed


# ── The rows ──────────────────────────────────────────────────────────────────────────────────────────────────

def _merge(target: Usage, more: Usage) -> None:
    for key, counts in more.items():
        into = target.setdefault(key, dict.fromkeys(COUNT_FIELDS, 0))
        for name in COUNT_FIELDS:
            into[name] += counts[name]


def priced(usage: Usage, price_list: PriceList) -> dict[str, Any]:
    """``by_model``, ``totals``, ``estimated_usd`` (the priced models' sum; None when none is priced), ``complete``
    and ``unpriced_models`` of one row's usage. An imported model's line is ``complete: false`` and so is its row: its
    figure is the registry's estimate, not what Custom Model Import bills (``model_prices.is_estimate``)."""
    by_model: list[dict[str, Any]] = []
    totals = dict.fromkeys(COUNT_FIELDS, 0)
    usd: Decimal | None = None
    unpriced: set[str] = set()
    estimates = False
    for (model_id, tier), counts in sorted(usage.items()):
        cost = estimated_usd(model_id, tier, counts, price_list)
        stored = None if cost is None else cost.quantize(_STORED_USD_STEP)
        estimate = is_estimate(model_id)
        estimates = estimates or estimate
        by_model.append({'model_id': model_id, 'service_tier': tier, **counts, 'estimated_usd': stored,
                         **({'complete': False} if estimate else {})})
        for name in COUNT_FIELDS:
            totals[name] += counts[name]
        if stored is None:
            unpriced.add(model_id)
        else:
            usd = stored if usd is None else usd + stored
    return {'by_model': by_model, 'totals': totals, 'estimated_usd': usd, 'complete': not unpriced and not estimates,
            'unpriced_models': sorted(unpriced)}


def _item(partition: str, attribution: str, day: date, part: Mapping[str, Any], rollup: Rollup,
          rolled_up_at: str) -> dict[str, Any]:
    return {'pk': partition, 'sk': day.isoformat(), 'schema': COST_ROW_SCHEMA, 'workspace_id': attribution, **part,
            'price_as_of': rollup.price_list.as_of, 'rolled_up_at': rolled_up_at}


def _workspace_scope(attribution: str) -> WorkspaceScope | None:
    """The scope a usage line's ``workspace_id`` names (the line's own field, written by shared/usage_meter.py from
    a resolved scope), or None when it names none."""
    try:
        return scope_from_message({WORKSPACE_FIELD: attribution})
    except ValueError:
        return None


def roll_up_day(rollup: Rollup, groups: list[str], day: date) -> dict[str, int]:
    """Read ``day`` (``query_day``), then write its rows; what was written, counted."""
    try:
        by_attribution = usage_by_attribution(query_day(rollup, groups, day))
    except ValueError as error:
        raise IncompleteDay(str(error)) from error
    rolled_up_at = rollup.now().isoformat()
    deployment: Usage = {}
    unattributed: Usage = {}
    deleted: Usage = {}
    deleted_count = 0
    workspaces: list[tuple[WorkspaceScope, Usage]] = []
    for attribution, usage in sorted(by_attribution.items()):
        if attribution == DEPLOYMENT:
            _merge(deployment, usage)
            continue
        scope = _workspace_scope(attribution) if attribution != UNATTRIBUTED else None
        if scope is None:
            # UNATTRIBUTED, or a value that names no workspace: never counted to a guessed one.
            _merge(unattributed, usage)
        elif rollup.is_active(scope):
            workspaces.append((scope, usage))
        else:
            _merge(deleted, usage)
            deleted_count += 1
    for scope, usage in workspaces:
        ws_table(scope, rollup.aggregates).put_item(
            _item(cost_partition(scope), scope.ws, day, priced(usage, rollup.price_list), rollup, rolled_up_at))
    if deployment or deleted:
        part = priced(deployment, rollup.price_list)
        if deleted:
            gone = priced(deleted, rollup.price_list)
            del gone['by_model']
            part['deleted_workspaces'] = {**gone, 'workspaces': deleted_count}
        rollup.aggregates.put_item(Item=_item(DEPLOYMENT_COST_PARTITION, DEPLOYMENT, day, part, rollup, rolled_up_at))
    if unattributed:
        rollup.aggregates.put_item(Item=_item(UNATTRIBUTED_COST_PARTITION, UNATTRIBUTED, day,
                                              priced(unattributed, rollup.price_list), rollup, rolled_up_at))
    return {'workspaces': len(workspaces), 'deleted_workspaces': deleted_count,
            'deployment': int(bool(deployment or deleted)), 'unattributed': int(bool(unattributed))}


def handle_event(event: Mapping[str, Any], rollup: Rollup) -> dict[str, Any]:
    """Roll up each day of the run; RollupIncomplete (after the others are written) when a day could not be. A day
    whose read or write AWS refused is recorded with the error's code only; the outcome line is always logged."""
    days = days_to_roll_up(event, rollup.now().date())
    written: dict[str, dict[str, int]] = {}
    failed: dict[str, str] = {}
    outcome: dict[str, Any] = {'log_groups': None, 'written': written, 'failed': failed}
    try:
        groups = lambda_log_groups(rollup.logs)
        outcome['log_groups'] = len(groups)
        for day in days:
            try:
                written[day.isoformat()] = roll_up_day(rollup, groups, day)
            except IncompleteDay as error:
                failed[day.isoformat()] = str(error)
            except (ClientError, BotoCoreError) as error:
                failed[day.isoformat()] = f'AWS refused a call ({aws_error_code(error)})'
    finally:
        logger.info('cost_rollup', extra=outcome)
    if failed:
        raise RollupIncomplete(f'days not written: {", ".join(sorted(failed))}')
    return outcome


@cache
def _logs_client() -> Any:
    # Standard retries back off on Insights' throttles (10 requests a second each for StartQuery and GetQueryResults).
    return boto3.client('logs', config=Config(retries={'mode': 'standard', 'max_attempts': 5}))


def _rollup(remaining: Callable[[], float]) -> Rollup:
    resource = get_dynamodb_resource()
    # The deployment's and the unattributed rows are no workspace's (shared/platform_costs.py); a workspace's go
    # through ws_table. voc-workspaces: a workspace's META status only (the control plane).
    return Rollup(logs=_logs_client(), aggregates=resource.Table(AGGREGATES_TABLE),
                  is_active=WorkspaceStatusCheck(resource.Table(WORKSPACES_TABLE)), now=lambda: datetime.now(UTC),
                  remaining=remaining)


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, _logs_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, _rollup(lambda: context.get_remaining_time_in_millis() / 1000))
