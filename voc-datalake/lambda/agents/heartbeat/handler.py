"""Agent heartbeat: every 15 minutes, start the autonomous-agent runs that are due.

EventBridge (``rate(15 minutes)``) invokes this Lambda with no payload. For each
enabled, non-archived agent it:

1. heals the run lock — a lock pointing at a finished or missing run is cleared,
   and a run active for longer than ``STALE_RUN_HOURS`` is failed as stale;
2. skips the agent while it has an active run (one active run per agent), when
   the month's model calls reached ``budget.monthly_call_cap``, or when today's
   scheduled runs reached ``budget.max_scheduled_runs_per_day`` (≤ 2);
3. evaluates every trigger — ``new_reviews`` (reviews in scope processed since the
   agent's ``last_run_cursor``, read from the feedback date GSI, with a cooldown
   after the last run), ``schedule`` (12h / 24h / cron in the trigger's time zone)
   and ``threshold`` (N reviews of one category or subcategory since the last
   heartbeat-started run, from the aggregator's ``METRIC#daily_category#`` and
   ``METRIC#daily_subcategory#`` counters);
4. starts a run for the first due trigger through ``shared.agents_store`` — the
   lock and the daily counter are taken in the same transaction as the run write,
   so overlapping ticks cannot double-start — then the ``voc-agent-run`` execution.

Manual "Run now" runs (agents API) are not counted against the daily cap.

Bundled as ``handler.py`` + ``shared/`` (like the category-reprocess worker), so it
imports ``shared.*`` from the asset root; tests import it as
``agents.heartbeat.handler``.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_store as store
from shared import workflow_schema
from shared.api import get_raw_categories_config
from shared.aws import get_dynamodb_resource
from shared.exceptions import ApiError
from shared.indexes import FEEDBACK_BY_DATE_INDEX
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics

FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

STALE_RUN_HOURS: Final = 24
# A cursor older than this is clamped: the heartbeat never walks more history.
MAX_NEW_REVIEW_DAYS: Final = 30
# Per agent, per tick: the most counter partitions a threshold trigger may read.
MAX_THRESHOLD_BUCKETS: Final = 200
# Stop starting work with this much of the invocation left.
TIME_RESERVE_MS: Final = 20_000
# EventBridge ticks are ~15 min apart, not exactly: a 12h schedule may fire this early.
SCHEDULE_TOLERANCE: Final = timedelta(minutes=7, seconds=30)
# A cron minute missed by a failed tick is still honoured this long afterwards.
CRON_LOOKBACK: Final = timedelta(hours=3)
EVERY_PERIODS: Final = {'12h': timedelta(hours=12), '24h': timedelta(hours=24)}
SUBCATEGORY_METRIC_PREFIX: Final = 'METRIC#daily_subcategory#'
CATEGORY_METRIC_PREFIX: Final = 'METRIC#daily_category#'


@dataclass
class Decision:
    """The trigger that fired (None when nothing is due) and the agent state to record."""

    trigger: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    agent_sets: dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------
# Pure trigger rules.
# --------------------------------------------------------------------------

def cooldown_elapsed(trigger: Mapping[str, Any], agent: Mapping[str, Any], now: datetime) -> bool:
    last = store.parse_iso(agent.get('last_run_at'))
    hours = int(store.plain(trigger.get('cooldown_hours')) or 0)
    return last is None or now - last >= timedelta(hours=hours)


def schedule_due(trigger: Mapping[str, Any], agent: Mapping[str, Any], now: datetime) -> bool:
    """True when a 12h/24h period has elapsed, or a cron minute passed since the last fire."""
    last_fired = store.parse_iso(agent.get('last_schedule_fired_at'))
    created = store.parse_iso(agent.get('created_at')) or now
    every = trigger.get('every')
    if every in EVERY_PERIODS:
        anchor = last_fired or created
        return now - anchor >= EVERY_PERIODS[every] - SCHEDULE_TOLERANCE
    if every != 'cron':
        return False
    try:
        spec = store.parse_cron(trigger.get('cron'))
    except ValueError:
        logger.warning('Agent has an unreadable cron trigger', extra={'agent_id': agent.get('agent_id')})
        return False
    zone = store.resolve_timezone(trigger.get('timezone'))
    floor = max(filter(None, [last_fired, created, now - CRON_LOOKBACK]))
    minute = now.replace(second=0, microsecond=0)
    while minute > floor:
        if spec.matches(minute.astimezone(zone)):
            return True
        minute -= timedelta(minutes=1)
    return False


def threshold_buckets(per: str, scope: Mapping[str, Any], categories_config: list[dict]) -> list[str]:
    """Counter partitions a threshold watches: ``cat`` or ``cat#sub`` keys, capped."""
    configured = {c['name']: c for c in categories_config if isinstance(c.get('name'), str)}
    categories = list(configured) if scope.get('all') is True else list(scope.get('categories') or [])
    explicit_subs = [f"{s['category']}#{s['name']}" for s in scope.get('subcategories') or []
                     if isinstance(s, Mapping) and isinstance(s.get('category'), str) and isinstance(s.get('name'), str)]
    if per == 'category':
        buckets = categories + explicit_subs
    else:
        buckets = [f'{name}#{sub}' for name in categories for sub in store.subcategory_names(configured.get(name, {}))]
        buckets += explicit_subs
    return list(dict.fromkeys(buckets))[:MAX_THRESHOLD_BUCKETS]


def bucket_pk(bucket: str) -> str:
    category, _, subcategory = bucket.partition('#')
    return f'{SUBCATEGORY_METRIC_PREFIX}{category}#{subcategory}' if subcategory else f'{CATEGORY_METRIC_PREFIX}{category}'


def count_since_baseline(daily: Mapping[str, int], since_day: str | None, baseline: int) -> int:
    """Reviews counted after the baseline: whole days after ``since_day``, plus that day's growth."""
    total = 0
    for day, count in daily.items():
        if since_day is None or day > since_day:
            total += count
        elif day == since_day:
            total += max(count - baseline, 0)
    return total


def _window_first_day(trigger: Mapping[str, Any], now: datetime) -> str:
    days = int(store.plain(trigger.get('window_days')) or 7)
    return (now - timedelta(days=days - 1)).strftime('%Y-%m-%d')


# --------------------------------------------------------------------------
# Reads.
# --------------------------------------------------------------------------

def count_new_reviews(feedback_table: Any, scope: Mapping[str, Any], cursor: object, now: datetime,
                      needed: int) -> int:
    """Reviews in scope processed after ``cursor`` (stops counting at ``needed``)."""
    since = store.parse_iso(cursor) or now - timedelta(days=1)
    since = max(since, now - timedelta(days=MAX_NEW_REVIEW_DAYS))
    cursor_key = store.iso(since)
    count = 0
    for day in store.iter_days(since.strftime('%Y-%m-%d'), now.strftime('%Y-%m-%d')):
        kwargs: dict[str, Any] = {
            'IndexName': FEEDBACK_BY_DATE_INDEX,
            'KeyConditionExpression': Key('gsi1pk').eq(f'DATE#{day}') & Key('gsi1sk').gt(cursor_key),
            'ProjectionExpression': 'category, subcategory',
        }
        while True:
            page = feedback_table.query(**kwargs)
            count += sum(1 for item in page.get('Items', []) if store.item_in_scope(scope, item))
            if count >= needed:
                return count
            if not page.get('LastEvaluatedKey'):
                break
            kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    return count


def daily_counts(aggregates_table: Any, pk: str, first_day: str, last_day: str) -> dict[str, int]:
    """``{YYYY-MM-DD: count}`` of one aggregator counter partition over a window."""
    page = aggregates_table.query(
        KeyConditionExpression=Key('pk').eq(pk) & Key('sk').between(first_day, last_day),
        FilterExpression=Attr('count').exists(),
    )
    counts: dict[str, int] = {}
    for item in page.get('Items', []):
        value = item.get('count')
        if isinstance(value, Decimal | int) and not isinstance(value, bool):
            counts[str(item['sk'])] = int(value)
    return counts


# --------------------------------------------------------------------------
# Evaluation.
# --------------------------------------------------------------------------

@dataclass
class Context:
    feedback_table: Any
    aggregates_table: Any
    categories_config: list[dict]
    now: datetime


def _threshold(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context,
               decision: Decision) -> dict[str, Any] | None:
    """Detail when one bucket crossed ``count``; records today's counts as the next baseline."""
    today = ctx.now.strftime('%Y-%m-%d')
    first_day = _window_first_day(trigger, ctx.now)
    # Before the first heartbeat-started run, count from the agent's creation day,
    # never the whole window of history it was created into.
    since_day = agent.get('threshold_since')
    if not isinstance(since_day, str):
        created = store.parse_iso(agent.get('created_at'))
        since_day = created.strftime('%Y-%m-%d') if created else None
    baselines = store.plain(agent.get('threshold_baseline') or {})
    needed = int(store.plain(trigger.get('count')) or 1)
    fired = None
    today_counts: dict[str, int] = dict(decision.agent_sets.get('threshold_baseline') or {})
    for bucket in threshold_buckets(str(trigger.get('per')), agent.get('scope') or {}, ctx.categories_config):
        daily = daily_counts(ctx.aggregates_table, bucket_pk(bucket), first_day, today)
        if daily.get(today):
            today_counts[bucket] = daily[today]
        baseline = int(baselines.get(bucket, 0)) if isinstance(baselines, Mapping) else 0
        seen = count_since_baseline(daily, since_day, baseline)
        if fired is None and seen >= needed:
            fired = {'bucket': bucket, 'count': seen}
    decision.agent_sets.update({'threshold_since': today, 'threshold_baseline': today_counts})
    return fired


def evaluate(agent: Mapping[str, Any], ctx: Context) -> Decision:
    """Every trigger is evaluated (threshold baselines and schedule marks are recorded
    for the run that starts); the first due one names the run."""
    decision = Decision()
    for trigger in agent.get('triggers') or []:
        kind, detail = trigger.get('kind'), None
        if kind == store.TRIGGER_NEW_REVIEWS and cooldown_elapsed(trigger, agent, ctx.now):
            needed = int(store.plain(trigger.get('min_new')) or 1)
            found = count_new_reviews(ctx.feedback_table, agent.get('scope') or {}, agent.get('last_run_cursor'),
                                      ctx.now, needed)
            detail = {'new_reviews': found} if found >= needed else None
        elif kind == store.TRIGGER_SCHEDULE and schedule_due(trigger, agent, ctx.now):
            decision.agent_sets['last_schedule_fired_at'] = store.iso(ctx.now)
            detail = {'every': trigger.get('every')}
        elif kind == store.TRIGGER_THRESHOLD:
            detail = _threshold(trigger, agent, ctx, decision)
        if detail is not None and decision.trigger is None:
            decision.trigger, decision.detail = str(kind), detail
    return decision


def _skip_reason(agent: Mapping[str, Any], now: datetime) -> str | None:
    budget = store.plain(agent.get('budget') or {})
    stats = store.agent_stats(agent, now)
    cap = budget.get('monthly_call_cap', store.DEFAULT_MONTHLY_CALL_CAP)
    if cap is not None and stats['model_calls_this_month'] >= int(cap):
        return 'monthly_cap'
    daily = int(budget.get('max_scheduled_runs_per_day', store.MAX_SCHEDULED_RUNS_PER_DAY))
    if stats['scheduled_runs_today'] >= daily:
        return 'daily_cap'
    return None


def _heal_lock(table: Any, agent: Mapping[str, Any], now: datetime) -> bool:
    """True when the agent is (still) busy with a live run."""
    run_id = agent.get('active_run_id')
    if not isinstance(run_id, str):
        return False
    run = store.get_run(table, agent['agent_id'], run_id)
    if run is None or run.get('status') not in store.ACTIVE_RUN_STATUSES:
        store.clear_lock(table, agent['agent_id'], run_id)
        return False
    started = store.parse_iso(run.get('started_at'))
    if started and now - started > timedelta(hours=STALE_RUN_HOURS):
        store.finish_run(table, agent['agent_id'], run_id, store.RUN_FAILED, now=now,
                         error=f'No progress for {STALE_RUN_HOURS} hours')
        logger.warning('Stale agent run failed', extra={'agent_id': agent['agent_id'], 'run_id': run_id})
    return True


def _record_skip(table: Any, agent: Mapping[str, Any], reason: str) -> str:
    """Remember a cap skip (``_skip_reason`` returns only cap reasons) the first time it is hit."""
    if agent.get('last_skip_reason') != reason:
        store.set_agent_attributes(table, agent['agent_id'], {'last_skip_reason': reason})
    return reason


def process_agent(table: Any, agent: Mapping[str, Any], ctx: Context) -> str:
    """One agent's tick; the outcome (``started`` or a skip reason)."""
    if _heal_lock(table, agent, ctx.now):
        return 'active_run'
    reason = _skip_reason(agent, ctx.now)
    if reason:
        return _record_skip(table, agent, reason)
    decision = evaluate(agent, ctx)
    if decision.trigger is None:
        return 'not_due'
    workflow = store.get_workflow(table, str(agent.get('workflow_id') or workflow_schema.DEFAULT_WORKFLOW_ID))
    if workflow is None:
        logger.warning('Agent workflow missing; not starting', extra={'agent_id': agent['agent_id']})
        return 'workflow_missing'
    budget = store.plain(agent.get('budget') or {})
    run = store.start_run(table, agent, store.RunStart(
        trigger=decision.trigger, requested_by='heartbeat', trigger_detail=decision.detail,
        workflow_revision=int(store.plain(workflow.get('revision')) or 1),
        review_since=str(agent.get('last_run_cursor') or store.iso(ctx.now - timedelta(days=1))),
        counts_against_daily_cap=True,
        daily_cap=int(budget.get('max_scheduled_runs_per_day', store.MAX_SCHEDULED_RUNS_PER_DAY)),
        extra_agent_sets={**decision.agent_sets, 'last_skip_reason': None},
    ), now=ctx.now)
    if run is None:
        return 'lock_or_cap'
    store.launch_run(table, run, now=ctx.now)
    logger.info('Agent run started', extra={'agent_id': agent['agent_id'], 'run_id': run['run_id'],
                                            'trigger': decision.trigger})
    return 'started'


def _eligible(agent: Mapping[str, Any]) -> bool:
    return agent.get('enabled') is True and agent.get('status') != store.AGENT_STATUS_ARCHIVED \
        and store.is_agent_id(agent.get('agent_id'))


def run_heartbeat(context: Any, now: datetime | None = None) -> dict[str, Any]:
    """One tick over every agent; ``{evaluated, started, outcomes: {reason: n}}``."""
    now = now or datetime.now(UTC)
    table = store.get_agents_table()
    if table is None or not store.state_machine_arn() or not FEEDBACK_TABLE or not AGGREGATES_TABLE:
        logger.warning('Agent heartbeat not configured; nothing to do')
        return {'evaluated': 0, 'started': 0, 'outcomes': {}}
    resource = get_dynamodb_resource()
    aggregates = resource.Table(AGGREGATES_TABLE)
    ctx = Context(resource.Table(FEEDBACK_TABLE), aggregates, list(get_raw_categories_config(aggregates)), now)
    outcomes: dict[str, int] = {}
    for agent in store.list_agents(table):
        if not _eligible(agent):
            continue
        if context.get_remaining_time_in_millis() < TIME_RESERVE_MS:
            outcomes['out_of_time'] = outcomes.get('out_of_time', 0) + 1
            continue
        try:
            outcome = process_agent(table, agent, ctx)
        except (ApiError, ClientError, BotoCoreError):
            # One agent's failure must not stop the others' wakes.
            logger.exception('Agent heartbeat failed for one agent', extra={'agent_id': agent.get('agent_id')})
            outcome = 'error'
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    started = outcomes.get('started', 0)
    metrics.add_metric(name='AgentRunsStarted', unit='Count', value=started)
    if outcomes.get('error'):
        metrics.add_metric(name='AgentHeartbeatErrors', unit='Count', value=outcomes['error'])
    summary = {'evaluated': sum(outcomes.values()), 'started': started, 'outcomes': outcomes}
    logger.info('Agent heartbeat finished', extra=summary)
    return summary


@instrumented_handler
def lambda_handler(_event: dict, context: Any) -> dict:
    return run_heartbeat(context)
