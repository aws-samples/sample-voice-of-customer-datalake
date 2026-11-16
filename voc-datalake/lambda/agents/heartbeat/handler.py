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

An engineering agent (7.47.00, ``agents/heartbeat/engineering.py``) runs its engineering flow through
voc-engineering-start instead: its ``new_reviews`` counts only in-scope reviews of its kind (``feedback_type`` ``bug`` or
``feature_request``) and its runs carry up to 50 of their ids (ids, top category and count, never text); a
``threshold`` that fires with none of its kind in the window skips (``no_bug_reports``, ``no_feature_requests``); a
``schedule`` goes ahead with what it finds; its ``github_issue`` trigger starts one run per issue, ever
(``agents/heartbeat/issues.py``). Its lock is held while the engineering run is live, read from that run's ``META``.

Bundled as ``handler.py`` + ``shared/`` (like the category-reprocess worker), so it
imports ``shared.*`` from the asset root; tests import it as
``agents.heartbeat.handler``.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError

from agents.heartbeat import engineering, issues
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared import workflow_schema
from shared.api import get_raw_categories_config
from shared.aws import get_dynamodb_resource
from shared.exceptions import ApiError
from shared.feedback_types import FEEDBACK_TYPE_KEY
from shared.indexes import FEEDBACK_BY_DATE_INDEX
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.metric_keys import CATEGORY_PREFIX, SUBCATEGORY_PREFIX
from shared.timestamps import parse_iso
from shared.warm_init import warm_at_init

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


@dataclass
class Decision:
    """The trigger that fired (None when nothing is due) and the agent state to record; for an engineering agent,
    what its run starts from (``issue``, ``feedback``) or why it does not (``skip``)."""

    trigger: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)
    agent_sets: dict[str, Any] = field(default_factory=dict)
    issue: eng_runs.IssueRef | None = None
    #: The claim the issue's run takes (7.50.00): its trigger's stage, ``act`` or ``triage``.
    issue_stage: str = store.ISSUE_STAGE_ACT
    feedback: eng_runs.Feedback | None = None
    skip: str | None = None


# --------------------------------------------------------------------------
# Pure trigger rules.
# --------------------------------------------------------------------------

def cooldown_elapsed(trigger: Mapping[str, Any], agent: Mapping[str, Any], now: datetime) -> bool:
    last = parse_iso(agent.get('last_run_at'))
    hours = int(store.plain(trigger.get('cooldown_hours')) or 0)
    return last is None or now - last >= timedelta(hours=hours)


def schedule_due(trigger: Mapping[str, Any], agent: Mapping[str, Any], now: datetime) -> bool:
    """True when a 12h/24h period has elapsed, or a cron minute passed since the last fire."""
    last_fired = parse_iso(agent.get('last_schedule_fired_at'))
    created = parse_iso(agent.get('created_at')) or now
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
    return f'{SUBCATEGORY_PREFIX}{category}#{subcategory}' if subcategory else f'{CATEGORY_PREFIX}{category}'


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

def _counted(scope: Mapping[str, Any], item: Mapping[str, Any], feedback_type: str | None) -> bool:
    """In scope, and (for an engineering agent) of its kind."""
    if not store.item_in_scope(scope, item):
        return False
    dimensions = item.get('dimensions')
    return feedback_type is None or (isinstance(dimensions, Mapping) and dimensions.get(FEEDBACK_TYPE_KEY) == feedback_type)


def walk_reviews(feedback_table: Any, scope: Mapping[str, Any], since: datetime, now: datetime, needed: int, *,
                 feedback_type: str | None = None) -> tuple[int, list[dict]]:
    """Reviews in scope (of ``feedback_type``, when given) processed after ``since``, counted until ``needed``, and
    the first ``eng_runs.MAX_FEEDBACK_IDS`` of them (their id and category: what an engineering run carries)."""
    since = max(since, now - timedelta(days=MAX_NEW_REVIEW_DAYS))
    cursor_key = store.iso(since)
    count, kept = 0, []
    # (only what the scope and the kind read: an agent's source scope its sources, an engineering agent its ids)
    fields = ['category', 'subcategory', *(['source_platform'] if scope.get('sources') else []),
              *(['feedback_id', '#dims'] if feedback_type else [])]
    for day in store.iter_days(since.strftime('%Y-%m-%d'), now.strftime('%Y-%m-%d')):
        kwargs: dict[str, Any] = {
            'IndexName': FEEDBACK_BY_DATE_INDEX,
            'KeyConditionExpression': Key('gsi1pk').eq(f'DATE#{day}') & Key('gsi1sk').gt(cursor_key),
            'ProjectionExpression': ', '.join(fields),
        }
        if feedback_type:
            kwargs['ExpressionAttributeNames'] = {'#dims': 'dimensions'}
        while True:
            page = feedback_table.query(**kwargs)
            for item in page.get('Items', []):
                if _counted(scope, item, feedback_type):
                    count += 1
                    if len(kept) < eng_runs.MAX_FEEDBACK_IDS:
                        kept.append(item)
            if count >= needed:
                return count, kept
            if not page.get('LastEvaluatedKey'):
                break
            kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    return count, kept


def _since_cursor(cursor: object, now: datetime) -> datetime:
    return parse_iso(cursor) or now - timedelta(days=1)


def count_new_reviews(feedback_table: Any, scope: Mapping[str, Any], cursor: object, now: datetime,
                      needed: int) -> int:
    """Reviews in scope processed after ``cursor`` (stops counting at ``needed``)."""
    return walk_reviews(feedback_table, scope, _since_cursor(cursor, now), now, needed)[0]


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
    #: The invocation's remaining time (Lambda's): an engineering start needs ``engineering.TIME_NEEDED_MS`` of it.
    remaining_ms: Callable[[], int] = field(default=lambda: 900_000, compare=False, repr=False)
    #: The connections an enabled Issue triage agent watches this tick (7.50.00, ``issues.triage_connections``): there
    #: an act trigger's ``requires_triage`` reads the issue's trusted triage row.
    triage_connections: frozenset[str] = frozenset()


def _threshold(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context,
               decision: Decision) -> dict[str, Any] | None:
    """Detail when one bucket crossed ``count``; records today's counts as the next baseline."""
    today = ctx.now.strftime('%Y-%m-%d')
    first_day = _window_first_day(trigger, ctx.now)
    # Before the first heartbeat-started run, count from the agent's creation day,
    # never the whole window of history it was created into.
    since_day = agent.get('threshold_since')
    if not isinstance(since_day, str):
        created = parse_iso(agent.get('created_at'))
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


#: Why an engineering agent's threshold or new-reviews trigger fired with none of its kind to work on.
NOTHING_OF_ITS_KIND: Final[Mapping[str, str]] = {'bug': 'no_bug_reports', 'feature_request': 'no_feature_requests'}


def _kind(agent: Mapping[str, Any]) -> str | None:
    """An engineering agent's ``feedback_type`` (what it works on), None for any other agent."""
    settings = agent.get('engineering')
    return str(settings.get('feedback_type')) if isinstance(settings, Mapping) else None


def _engineering_feedback(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context,
                          kind: str) -> eng_runs.Feedback:
    """The reviews of the agent's kind an engineering run of ``trigger`` carries: since the agent's cursor (a
    schedule), or within the threshold's window."""
    if trigger.get('kind') == store.TRIGGER_THRESHOLD:
        days = int(store.plain(trigger.get('window_days')) or 7)
        since = ctx.now - timedelta(days=days)
    else:
        since = _since_cursor(agent.get('last_run_cursor'), ctx.now)
    count, items = walk_reviews(ctx.feedback_table, agent.get('scope') or {}, since, ctx.now,
                                eng_runs.MAX_FEEDBACK_IDS, feedback_type=kind)
    return eng_runs.feedback_of(items, count)


def _new_reviews_due(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context,
                     decision: Decision) -> dict[str, Any] | None:
    """``new_reviews``: in-scope reviews since the cursor (an engineering agent: of its kind, with their ids)."""
    needed, of_kind = int(store.plain(trigger.get('min_new')) or 1), _kind(agent)
    if of_kind is None:
        found = count_new_reviews(ctx.feedback_table, agent.get('scope') or {}, agent.get('last_run_cursor'),
                                  ctx.now, needed)
        return {'new_reviews': found} if found >= needed else None
    found, items = walk_reviews(ctx.feedback_table, agent.get('scope') or {},
                                _since_cursor(agent.get('last_run_cursor'), ctx.now), ctx.now, needed,
                                feedback_type=of_kind)
    if found < needed:
        return None
    if decision.trigger is None:
        decision.feedback = eng_runs.feedback_of(items, found)
    return {'new_reviews': found}


def _threshold_due(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context,
                   decision: Decision) -> dict[str, Any] | None:
    """``threshold``; for an engineering agent, only with reviews of its kind in the window (else ``decision.skip``)."""
    fired, of_kind = _threshold(trigger, agent, ctx, decision), _kind(agent)
    if fired is None or of_kind is None or decision.trigger is not None:
        return fired
    feedback = _engineering_feedback(trigger, agent, ctx, of_kind)
    if not feedback.count:   # (crossed, but none of the agent's kind: no run, unless another trigger is due)
        decision.skip = NOTHING_OF_ITS_KIND.get(of_kind, 'no_bug_reports')
        return None
    decision.feedback = feedback
    return fired


def _evaluate_one(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context, decision: Decision,
                  prepared: engineering.Ready | None) -> dict[str, Any] | None:
    """One trigger's detail when it is due (None otherwise), recording on ``decision`` what an engineering run of it
    would start from."""
    kind, of_kind = trigger.get('kind'), _kind(agent)
    if kind == store.TRIGGER_NEW_REVIEWS and cooldown_elapsed(trigger, agent, ctx.now):
        return _new_reviews_due(trigger, agent, ctx, decision)
    if kind == store.TRIGGER_SCHEDULE and schedule_due(trigger, agent, ctx.now):
        decision.agent_sets['last_schedule_fired_at'] = store.iso(ctx.now)
        if of_kind is not None and decision.trigger is None:
            decision.feedback = _engineering_feedback(trigger, agent, ctx, of_kind)
        return {'every': trigger.get('every')}
    if kind == store.TRIGGER_THRESHOLD:
        return _threshold_due(trigger, agent, ctx, decision)
    if kind == store.TRIGGER_GITHUB_ISSUE and prepared is not None and decision.trigger is None:
        return _issue_due(trigger, agent, ctx, decision, prepared)
    return None


def _issue_due(trigger: Mapping[str, Any], agent: Mapping[str, Any], ctx: Context, decision: Decision,
               prepared: engineering.Ready) -> dict[str, Any] | None:
    """A ``github_issue`` trigger's detail when an issue may start the agent's run (``issues.find_issue``)."""
    found = issues.find_issue(ctx.feedback_table, prepared.agents_table, agent, trigger, prepared.connection, ctx.now,
                              ctx.triage_connections)
    if found is None:
        return None
    decision.issue = found
    decision.issue_stage = store.issue_stage(trigger)
    return {'issue': found.number, 'repository': found.repository,
            **({'stage': decision.issue_stage} if decision.issue_stage != store.ISSUE_STAGE_ACT else {})}


def evaluate(agent: Mapping[str, Any], ctx: Context, prepared: engineering.Ready | None = None) -> Decision:
    """Every trigger is evaluated (threshold baselines and schedule marks are recorded
    for the run that starts); the first due one names the run (an engineering agent's ``prepared`` connection and
    flow: its ``github_issue`` trigger reads the repository's issues)."""
    decision = Decision()
    for trigger in agent.get('triggers') or []:
        detail = _evaluate_one(trigger, agent, ctx, decision, prepared)
        if detail is not None and decision.trigger is None:
            decision.trigger, decision.detail = str(trigger.get('kind')), detail
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
    if run.get('kind') == store.RUN_KIND_ENGINEERING:
        # (its engineering run's status, never the 24 hours: a run may wait days for a person, holding the lock)
        return engineering.heal(table, agent, run, now)
    # A resumed run is judged from its resume, not from when it first started.
    started = parse_iso(run.get('resumed_at')) or parse_iso(run.get('started_at'))
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


def _engineering_tick(table: Any, agent: Mapping[str, Any], ctx: Context) -> str:
    """An engineering agent's tick once its lock and caps allow a run: set up, due, then started through
    voc-engineering-start (``engineering.start``)."""
    prepared = engineering.ready(table, agent)
    if prepared is None:
        return _record_skip(table, agent, 'not_set_up')
    decision = evaluate(agent, ctx, prepared)
    if decision.trigger is None:
        if decision.skip:
            # (the threshold's baselines move on, so it waits for new reviews rather than firing every tick)
            store.set_agent_attributes(table, agent['agent_id'], {**decision.agent_sets,
                                                                  'last_skip_reason': decision.skip})
            return decision.skip
        return 'not_due'
    if ctx.remaining_ms() < engineering.TIME_NEEDED_MS:
        return 'out_of_time'
    budget = store.plain(agent.get('budget') or {})
    issue = decision.issue
    feedback_type = str((agent.get('engineering') or {}).get('feedback_type'))
    repository = str(prepared.connection.get('repository') or '')
    if issue is not None:
        sentence = eng_runs.issue_sentence(feedback_type, issue.repository, issue.number, decision.issue_stage)
    elif decision.feedback is not None and decision.feedback.count:
        sentence = eng_runs.reviews_sentence(feedback_type, decision.feedback.count, agent.get('scope') or {})
    else:
        sentence = eng_runs.hunt_sentence(repository)
    return engineering.start(table, agent, prepared, eng_runs.AgentStart(
        trigger=decision.trigger, requested_by='heartbeat', actor=str(agent.get('owner_sub') or ''),
        sentence=sentence, trigger_detail=decision.detail, issue=issue, feedback=decision.feedback,
        stage=decision.issue_stage, counts_against_daily_cap=True,
        daily_cap=int(budget.get('max_scheduled_runs_per_day', store.DEFAULT_ENGINEERING_RUNS_PER_DAY)),
        extra_agent_sets={**decision.agent_sets, 'last_skip_reason': None}), ctx.now)


def process_agent(table: Any, agent: Mapping[str, Any], ctx: Context) -> str:
    """One agent's tick; the outcome (``started`` or a skip reason)."""
    if _heal_lock(table, agent, ctx.now):
        return 'active_run'
    reason = _skip_reason(agent, ctx.now)
    if reason:
        return _record_skip(table, agent, reason)
    if store.is_engineering_agent(agent):
        return _engineering_tick(table, agent, ctx)
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


def _heal_disabled(table: Any, agent: Mapping[str, Any], now: datetime) -> None:
    """A disabled or archived engineering agent's run still ends when its engineering run does (nothing else ends
    it: the agents' interpreter never runs it). Best effort: logged, never stopping the others' wakes."""
    if not (store.is_engineering_agent(agent) and isinstance(agent.get('active_run_id'), str)
            and store.is_agent_id(agent.get('agent_id'))):
        return
    try:
        _heal_lock(table, agent, now)
    except (ApiError, ClientError, BotoCoreError):
        logger.exception('Engineering agent run lock not healed', extra={'agent_id': agent.get('agent_id')})


def run_heartbeat(context: Any, now: datetime | None = None) -> dict[str, Any]:
    """One tick over every agent; ``{evaluated, started, outcomes: {reason: n}}``."""
    now = now or datetime.now(UTC)
    table = store.get_agents_table()
    if table is None or not store.state_machine_arn() or not FEEDBACK_TABLE or not AGGREGATES_TABLE:
        logger.warning('Agent heartbeat not configured; nothing to do')
        return {'evaluated': 0, 'started': 0, 'outcomes': {}}
    resource = get_dynamodb_resource()
    aggregates = resource.Table(AGGREGATES_TABLE)
    agents = store.list_agents(table)
    ctx = Context(resource.Table(FEEDBACK_TABLE), aggregates, list(get_raw_categories_config(aggregates)), now,
                  remaining_ms=context.get_remaining_time_in_millis,
                  triage_connections=issues.triage_connections(agents))
    outcomes: dict[str, int] = {}
    for agent in agents:
        if not _eligible(agent):
            _heal_disabled(table, agent, now)
            continue
        if context.get_remaining_time_in_millis() < TIME_RESERVE_MS:
            outcomes['out_of_time'] = outcomes.get('out_of_time', 0) + 1
            continue
        try:
            outcome = process_agent(table, agent, ctx)
        except engineering.DirectoryUnavailable:
            logger.warning('Engineering agent owner not checked; not starting', extra={'agent_id': agent.get('agent_id')})
            outcome = 'error'
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


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(_event: dict, context: Any) -> dict:
    return run_heartbeat(context)
