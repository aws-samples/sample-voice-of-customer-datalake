"""Mutation hardening for `agents/heartbeat/handler.py`.

`test_heartbeat.py` drives whole ticks through moto and checks that a run starts
(or does not), but a mutation run found what those ticks cannot see:

* every BOUNDARY of the trigger rules, on a frozen clock: the 7m30s schedule
  tolerance, the 3-hour cron lookback (strict, so the floor minute itself is not
  re-fired), a cooldown of exactly N hours, the 24-hour stale-run limit, the
  30-day cursor clamp, the 200-bucket cap, the 20 s time reserve and the
  ``count == needed`` / ``seen == needed`` firing points;
* the exact READS: the feedback date-GSI key condition, projection and
  pagination, and the aggregator counter query — rendered to DynamoDB
  expressions, because boto3 condition objects compare equal across names;
* the exact WRITES and calls: the ``RunStart`` the heartbeat hands the store
  (requested_by, revision fallback, review window, daily cap, trigger state),
  lock healing, stale-run failure wording, skip bookkeeping, metrics and the
  log lines an operator searches for;
* the defaults (``min_new``/``count`` of 1, a 7-day window, the 5,000-call
  monthly cap, 2 scheduled runs a day) and the module's environment reads.
"""
from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, ClassVar, get_type_hints
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag
from boto3.dynamodb.conditions import ConditionBase, ConditionExpressionBuilder
from botocore.exceptions import BotoCoreError, ClientError

from agents.heartbeat import handler as hb
from shared import agents_store as store
from shared.exceptions import ServiceError
from shared.test.fresh_module import fresh_module_copy
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

NOW = datetime(2026, 10, 5, 9, 30, tzinfo=UTC)  # a Monday
TODAY = '2026-10-05'
AGENT_ID = 'ag_0123456789ab'
RUN_ID = 'ar_000000000000'
SHIP = {'category': 'shipping'}
BILL = {'category': 'billing'}
SCOPE = {'all': False, 'categories': ['shipping']}
CONFIG = [
    {'name': 'shipping', 'subcategories': [{'name': 'late'}, {'name': 'damaged'}]},
    {'name': 'billing', 'subcategories': []},
]


def _iso(moment: datetime) -> str:
    return store.iso(moment)


def _render(condition: ConditionBase, *, key: bool = False) -> str:
    """A boto3 condition as the DynamoDB expression it sends, placeholders filled in."""
    built = ConditionExpressionBuilder().build_expression(condition, is_key_condition=key)
    expression = built.condition_expression
    for placeholder, name in built.attribute_name_placeholders.items():
        expression = expression.replace(placeholder, name)
    for placeholder, value in sorted(built.attribute_value_placeholders.items(), reverse=True):
        expression = expression.replace(placeholder, repr(value))
    return expression


def _ctx(**overrides: Any) -> hb.Context:
    """Tables whose reads fail at once: a test that reads must say what the read returns."""
    feedback, aggregates = MagicMock(name='feedback'), MagicMock(name='aggregates')
    feedback.query.side_effect = aggregates.query.side_effect = AssertionError('unexpected table read')
    fields: dict[str, Any] = {'feedback_table': feedback, 'aggregates_table': aggregates,
                              'categories_config': CONFIG, 'now': NOW}
    fields.update(overrides)
    return hb.Context(**fields)


def _agent(**overrides: Any) -> dict[str, Any]:
    agent: dict[str, Any] = {'agent_id': AGENT_ID, 'enabled': True, 'status': 'active', 'scope': SCOPE,
                             'created_at': _iso(NOW - timedelta(days=30)), 'triggers': []}
    agent.update(overrides)
    return agent


# --------------------------------------------------------------------------
# Module configuration.
# --------------------------------------------------------------------------

def _fresh_module(env: dict[str, str]) -> ModuleType:
    with patch.dict(os.environ, env, clear=False):
        for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE'):
            if name not in env:
                os.environ.pop(name, None)
        return fresh_module_copy('heartbeat_fresh_copy', Path(hb.__file__))


class TestModuleConfiguration:
    def test_table_names_come_from_the_environment(self):
        fresh = _fresh_module({'FEEDBACK_TABLE': 'fb-table', 'AGGREGATES_TABLE': 'agg-table'})
        assert (fresh.FEEDBACK_TABLE, fresh.AGGREGATES_TABLE) == ('fb-table', 'agg-table')

    def test_unset_table_names_are_empty(self):
        fresh = _fresh_module({})
        assert (fresh.FEEDBACK_TABLE, fresh.AGGREGATES_TABLE) == ('', '')

    def test_constants(self):
        assert hb.STALE_RUN_HOURS == 24
        assert hb.MAX_NEW_REVIEW_DAYS == 30
        assert hb.MAX_THRESHOLD_BUCKETS == 200
        assert hb.TIME_RESERVE_MS == 20_000
        assert timedelta(seconds=450) == hb.SCHEDULE_TOLERANCE
        assert timedelta(hours=3) == hb.CRON_LOOKBACK
        assert {'12h': timedelta(hours=12), '24h': timedelta(hours=24)} == hb.EVERY_PERIODS
        assert hb.CATEGORY_METRIC_PREFIX == 'METRIC#daily_category#'

    def test_a_decision_starts_empty(self):
        decision = hb.Decision()
        assert (decision.trigger, decision.detail, decision.agent_sets) == (None, {}, {})
        assert hb.Decision().detail is not decision.detail
        assert get_type_hints(hb.Decision)['trigger'] == str | None


class TestCountSinceBaseline:
    def test_the_since_day_adds_to_later_days_whatever_the_order(self):
        assert hb.count_since_baseline({'2026-10-05': 2, '2026-10-04': 6}, '2026-10-04', 5) == 3


# --------------------------------------------------------------------------
# Pure trigger rules.
# --------------------------------------------------------------------------

class TestCooldown:
    @pytest.mark.parametrize(('ago', 'hours', 'elapsed'), [
        (timedelta(hours=12), 12, True),
        (timedelta(hours=12) - timedelta(seconds=1), 12, False),
        (timedelta(0), None, True),
        (timedelta(0), 0, True),
    ])
    def test_boundary(self, ago, hours, elapsed):
        trigger = {'cooldown_hours': Decimal(hours) if hours is not None else None}
        assert hb.cooldown_elapsed(trigger, {'last_run_at': _iso(NOW - ago)}, NOW) is elapsed

    def test_never_run_is_elapsed(self):
        assert hb.cooldown_elapsed({'cooldown_hours': 99}, {}, NOW) is True


class TestPeriodicSchedule:
    @pytest.mark.parametrize(('every', 'ago', 'due'), [
        ('12h', timedelta(hours=12) - timedelta(minutes=7, seconds=30), True),
        ('12h', timedelta(hours=12) - timedelta(minutes=7, seconds=31), False),
        ('24h', timedelta(hours=24) - timedelta(minutes=7, seconds=30), True),
        ('24h', timedelta(hours=24) - timedelta(minutes=7, seconds=31), False),
    ])
    def test_tolerance_boundary_from_the_last_fire(self, every, ago, due):
        agent = {'last_schedule_fired_at': _iso(NOW - ago), 'created_at': _iso(NOW - timedelta(days=9))}
        assert hb.schedule_due({'every': every}, agent, NOW) is due

    def test_falls_back_to_creation_then_to_now(self):
        assert hb.schedule_due({'every': '12h'}, {'created_at': _iso(NOW - timedelta(hours=12))}, NOW) is True
        assert hb.schedule_due({'every': '12h'}, {}, NOW) is False

    @pytest.mark.parametrize('every', ['weekly', None])
    def test_an_unknown_period_never_fires(self, every):
        assert hb.schedule_due({'every': every}, {'created_at': _iso(NOW - timedelta(days=99))}, NOW) is False


class TestCronSchedule:
    OLD: ClassVar[dict[str, str]] = {'created_at': _iso(NOW - timedelta(days=9))}

    def _due(self, cron: str, agent: dict, now: datetime = NOW) -> bool:
        return hb.schedule_due({'every': 'cron', 'cron': cron, 'timezone': 'UTC'}, agent, now)

    def test_unreadable_cron_logs_and_never_fires(self):
        with patch.object(hb, 'logger') as logger:
            assert hb.schedule_due({'every': 'cron', 'cron': 'nope'}, {'agent_id': AGENT_ID}, NOW) is False
        logger.warning.assert_called_once_with('Agent has an unreadable cron trigger',
                                               extra={'agent_id': AGENT_ID})

    def test_the_trigger_time_zone_is_used(self):
        trigger = {'every': 'cron', 'cron': '30 11 * * 1', 'timezone': 'Europe/Paris'}
        assert hb.schedule_due(trigger, self.OLD, NOW) is True
        assert hb.schedule_due({**trigger, 'timezone': 'UTC'}, self.OLD, NOW) is False

    def test_the_lookback_is_three_hours_and_strict(self):
        assert self._due('31 6 * * *', self.OLD) is True     # 2h59m ago
        assert self._due('30 6 * * *', self.OLD) is False    # exactly 3h ago: the floor itself
        assert self._due('29 6 * * *', self.OLD) is False    # 3h01m ago

    def test_walks_back_minute_by_minute_never_forward(self):
        assert self._due('29 9 * * *', self.OLD) is True
        assert self._due('45 9 * * *', self.OLD) is False

    @pytest.mark.parametrize('field', ['created_at', 'last_schedule_fired_at'])
    def test_a_recent_creation_or_fire_raises_the_floor(self, field):
        agent = {**self.OLD, field: _iso(NOW - timedelta(hours=1))}
        assert self._due('0 8 * * *', agent) is False
        assert self._due('0 9 * * *', agent) is True

    def test_the_current_minute_is_truncated_before_comparing_with_the_floor(self):
        now = NOW.replace(second=30, microsecond=500)
        assert self._due('30 9 * * *', {**self.OLD, 'last_schedule_fired_at': _iso(NOW)}, now) is False
        assert self._due('30 9 * * *', self.OLD, now) is True


class TestThresholdBuckets:
    def test_all_scope_uses_configured_string_names(self):
        config = [*CONFIG, {'name': 5}, {'description': 'nameless'}]
        assert hb.threshold_buckets('category', {'all': True}, config) == ['shipping', 'billing']
        assert hb.threshold_buckets('subcategory', {'all': True}, config) == ['shipping#late', 'shipping#damaged']

    def test_all_must_be_literally_true(self):
        assert hb.threshold_buckets('category', {'all': 'yes', 'categories': ['billing']}, CONFIG) == ['billing']

    def test_explicit_subcategories_are_validated_and_appended_once(self):
        scope = {'categories': ['shipping'], 'subcategories': [
            {'category': 'shipping', 'name': 'late'}, {'category': 'billing', 'name': 'refund'},
            'junk', {'category': 1, 'name': 'x'}, {'category': 'billing', 'name': None}]}
        assert hb.threshold_buckets('category', scope, CONFIG) == ['shipping', 'shipping#late', 'billing#refund']
        assert hb.threshold_buckets('subcategory', scope, CONFIG) == [
            'shipping#late', 'shipping#damaged', 'billing#refund']

    def test_missing_lists_and_unknown_categories_yield_nothing(self):
        assert hb.threshold_buckets('subcategory', {'categories': None, 'subcategories': None}, CONFIG) == []
        assert hb.threshold_buckets('subcategory', {'categories': ['ghost']}, CONFIG) == []

    def test_capped_at_200(self):
        names = [f'c{i}' for i in range(201)]
        assert hb.threshold_buckets('category', {'categories': names}, []) == names[:200]

    @pytest.mark.parametrize(('bucket', 'pk'), [
        ('shipping', 'METRIC#daily_category#shipping'),
        ('shipping#', 'METRIC#daily_category#shipping'),
        ('shipping#late', 'METRIC#daily_subcategory#shipping#late'),
    ])
    def test_bucket_pk(self, bucket, pk):
        assert hb.bucket_pk(bucket) == pk


class TestWindow:
    @pytest.mark.parametrize(('days', 'first'), [(None, '2026-09-29'), (1, TODAY), (Decimal(3), '2026-10-03')])
    def test_first_day(self, days, first):
        assert hb._window_first_day({'window_days': days}, NOW) == first


# --------------------------------------------------------------------------
# Reads.
# --------------------------------------------------------------------------

def _gsi_call(day: str, cursor_key: str) -> tuple[str, str, str]:
    return ('gsi1-by-date', f"(gsi1pk = 'DATE#{day}' AND gsi1sk > '{cursor_key}')", 'category, subcategory')


def _rendered_queries(table: MagicMock) -> list[tuple[str, str, str]]:
    return [(c.kwargs['IndexName'], _render(c.kwargs['KeyConditionExpression'], key=True),
             c.kwargs['ProjectionExpression']) for c in table.query.call_args_list]


class TestCountNewReviews:
    def test_no_cursor_reads_the_last_day_in_scope(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': [SHIP, BILL]}, {'Items': [SHIP]}]
        assert hb.count_new_reviews(table, SCOPE, None, NOW, 5) == 2
        since = _iso(NOW - timedelta(days=1))
        assert _rendered_queries(table) == [_gsi_call('2026-10-04', since), _gsi_call(TODAY, since)]

    def test_a_recent_cursor_is_kept(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': []}]
        cursor = _iso(NOW - timedelta(hours=2))
        assert hb.count_new_reviews(table, SCOPE, cursor, NOW, 1) == 0
        assert _rendered_queries(table) == [_gsi_call(TODAY, cursor)]

    def test_an_old_cursor_is_clamped_to_30_days(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': []}] * 31
        assert hb.count_new_reviews(table, SCOPE, _iso(NOW - timedelta(days=40)), NOW, 1) == 0
        queries = _rendered_queries(table)
        assert len(queries) == 31
        assert queries[0] == _gsi_call('2026-09-05', _iso(NOW - timedelta(days=30)))

    def test_stops_as_soon_as_enough_are_counted(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': [SHIP, SHIP], 'LastEvaluatedKey': {'k': 1}}]
        assert hb.count_new_reviews(table, SCOPE, None, NOW, 2) == 2
        assert table.query.call_count == 1

    def test_follows_pages_within_a_day(self):
        table = MagicMock()
        table.query.side_effect = [{'Items': [SHIP], 'LastEvaluatedKey': {'k': 1}}, {'Items': [SHIP]},
                                   {'Items': [BILL]}]
        assert hb.count_new_reviews(table, SCOPE, None, NOW, 9) == 2
        starts = [c.kwargs.get('ExclusiveStartKey') for c in table.query.call_args_list]
        assert starts == [None, {'k': 1}, None]


class TestDailyCounts:
    def test_query_and_value_filtering(self):
        table = MagicMock()
        table.query.return_value = {'Items': [
            {'sk': '2026-10-01', 'count': Decimal(3)}, {'sk': '2026-10-02', 'count': 4},
            {'sk': '2026-10-03', 'count': True}, {'sk': '2026-10-04', 'count': '5'}, {'sk': TODAY}]}
        assert hb.daily_counts(table, 'METRIC#x', '2026-09-29', TODAY) == {'2026-10-01': 3, '2026-10-02': 4}
        kwargs = table.query.call_args.kwargs
        assert set(kwargs) == {'KeyConditionExpression', 'FilterExpression'}
        assert _render(kwargs['KeyConditionExpression'], key=True) == \
            "(pk = 'METRIC#x' AND sk BETWEEN '2026-09-29' AND '2026-10-05')"
        assert _render(kwargs['FilterExpression']) == 'attribute_exists(count)'

    def test_no_items(self):
        table = MagicMock()
        table.query.return_value = {}
        assert hb.daily_counts(table, 'METRIC#x', TODAY, TODAY) == {}


# --------------------------------------------------------------------------
# Evaluation.
# --------------------------------------------------------------------------

@contextmanager
def _counters(data: dict[str, dict[str, int]]) -> Iterator[MagicMock]:
    with patch.object(hb, 'daily_counts', side_effect=lambda _t, pk, _f, _l: dict(data.get(pk, {}))) as mock:
        yield mock


THRESHOLD = {'kind': 'threshold', 'count': 5, 'per': 'category', 'window_days': 7}
SHIP_PK = 'METRIC#daily_category#shipping'


class TestThreshold:
    def test_reads_every_bucket_over_the_window_and_records_the_baseline(self):
        ctx = _ctx()
        agent = _agent(scope={'categories': ['shipping', 'billing']}, threshold_since='2026-10-03',
                       threshold_baseline={'shipping': 9})
        with _counters({SHIP_PK: {'2026-10-03': 9, '2026-10-04': 2, TODAY: 3}}) as reads:
            decision = hb.evaluate({**agent, 'triggers': [THRESHOLD]}, ctx)
        assert reads.call_args_list == [call(ctx.aggregates_table, SHIP_PK, '2026-09-29', TODAY),
                                        call(ctx.aggregates_table, 'METRIC#daily_category#billing',
                                             '2026-09-29', TODAY)]
        assert (decision.trigger, decision.detail) == ('threshold', {'bucket': 'shipping', 'count': 5})
        assert decision.agent_sets == {'threshold_since': TODAY, 'threshold_baseline': {'shipping': 3}}

    def test_one_below_the_count_does_not_fire(self):
        with _counters({SHIP_PK: {TODAY: 4}}):
            decision = hb.evaluate(_agent(triggers=[THRESHOLD], threshold_since='2026-10-04'), _ctx())
        assert decision.trigger is None
        assert decision.agent_sets == {'threshold_since': TODAY, 'threshold_baseline': {'shipping': 4}}

    def test_the_baseline_discounts_the_since_day(self):
        agent = _agent(triggers=[THRESHOLD], threshold_since=TODAY, threshold_baseline={'shipping': Decimal(2)})
        with _counters({SHIP_PK: {TODAY: 7}}):
            assert hb.evaluate(agent, _ctx()).detail == {'bucket': 'shipping', 'count': 5}
        with _counters({SHIP_PK: {TODAY: 6}}):
            assert hb.evaluate(agent, _ctx()).trigger is None

    def test_an_unreadable_baseline_counts_from_zero(self):
        agent = _agent(triggers=[THRESHOLD], threshold_since=TODAY, threshold_baseline=['junk'])
        with _counters({SHIP_PK: {TODAY: 5}}):
            assert hb.evaluate(agent, _ctx()).detail == {'bucket': 'shipping', 'count': 5}

    def test_before_the_first_run_counts_from_the_creation_day(self):
        agent = _agent(triggers=[THRESHOLD], created_at='2026-10-03T12:00:00+00:00', threshold_since=7)
        with _counters({SHIP_PK: {'2026-10-02': 50, '2026-10-03': 1, '2026-10-04': 4}}):
            assert hb.evaluate(agent, _ctx()).detail == {'bucket': 'shipping', 'count': 5}

    def test_without_a_creation_day_the_whole_window_counts(self):
        agent = _agent(triggers=[{**THRESHOLD, 'count': None}])
        del agent['created_at']
        with _counters({SHIP_PK: {'2026-09-30': 1}}):
            assert hb.evaluate(agent, _ctx()).detail == {'bucket': 'shipping', 'count': 1}

    def test_the_first_crossing_bucket_names_the_run_and_baselines_merge(self):
        agent = _agent(scope={'categories': ['shipping', 'billing']}, threshold_since='2026-10-01', triggers=[
            {**THRESHOLD, 'count': 1}, {**THRESHOLD, 'per': 'subcategory', 'count': 1}])
        data = {SHIP_PK: {TODAY: 1}, 'METRIC#daily_category#billing': {TODAY: 2},
                'METRIC#daily_subcategory#shipping#late': {TODAY: 3}}
        with _counters(data):
            decision = hb.evaluate(agent, _ctx())
        assert decision.detail == {'bucket': 'shipping', 'count': 1}
        assert decision.agent_sets['threshold_baseline'] == {'shipping': 1, 'billing': 2, 'shipping#late': 3}

    def test_a_scopeless_agent_reads_nothing(self):
        with _counters({}) as reads:
            decision = hb.evaluate(_agent(scope=None, triggers=[THRESHOLD]), _ctx())
        assert reads.call_count == 0
        assert decision.agent_sets == {'threshold_since': TODAY, 'threshold_baseline': {}}


class TestEvaluate:
    NEW: ClassVar[dict[str, Any]] = {'kind': 'new_reviews', 'min_new': 3, 'cooldown_hours': 1}

    def test_new_reviews_counts_with_the_scope_cursor_and_needed(self):
        ctx = _ctx()
        agent = _agent(last_run_cursor='2026-10-05T08:00:00+00:00', triggers=[self.NEW])
        with patch.object(hb, 'count_new_reviews', return_value=3) as count:
            decision = hb.evaluate(agent, ctx)
        count.assert_called_once_with(ctx.feedback_table, SCOPE, '2026-10-05T08:00:00+00:00', NOW, 3)
        assert (decision.trigger, decision.detail, decision.agent_sets) == ('new_reviews', {'new_reviews': 3}, {})

    def test_new_reviews_below_needed_does_not_fire(self):
        with patch.object(hb, 'count_new_reviews', return_value=2):
            assert hb.evaluate(_agent(triggers=[self.NEW]), _ctx()).trigger is None

    def test_new_reviews_defaults_to_one_and_an_empty_scope(self):
        ctx = _ctx()
        with patch.object(hb, 'count_new_reviews', return_value=1) as count:
            decision = hb.evaluate(_agent(scope=None, triggers=[{'kind': 'new_reviews'}]), ctx)
        count.assert_called_once_with(ctx.feedback_table, {}, None, NOW, 1)
        assert decision.detail == {'new_reviews': 1}

    def test_cooldown_skips_the_count(self):
        agent = _agent(last_run_at=_iso(NOW - timedelta(minutes=30)), triggers=[self.NEW])
        with patch.object(hb, 'count_new_reviews') as count:
            assert hb.evaluate(agent, _ctx()).trigger is None
        assert count.call_count == 0

    def test_a_due_schedule_records_its_fire_and_wins_over_later_triggers(self):
        agent = _agent(threshold_since=TODAY, triggers=[
            {'kind': 'schedule', 'every': '24h'}, {**THRESHOLD, 'count': 1}])
        with _counters({SHIP_PK: {TODAY: 1}}):
            decision = hb.evaluate(agent, _ctx())
        assert (decision.trigger, decision.detail) == ('schedule', {'every': '24h'})
        assert decision.agent_sets == {'last_schedule_fired_at': _iso(NOW), 'threshold_since': TODAY,
                                       'threshold_baseline': {'shipping': 1}}

    def test_a_schedule_not_due_records_nothing(self):
        agent = _agent(created_at=_iso(NOW), triggers=[{'kind': 'schedule', 'every': '12h'}])
        decision = hb.evaluate(agent, _ctx())
        assert (decision.trigger, decision.agent_sets) == (None, {})

    def test_unknown_kinds_and_no_triggers(self):
        assert hb.evaluate(_agent(triggers=[{'kind': 'manual', 'every': '12h'}]), _ctx()).trigger is None
        assert hb.evaluate(_agent(triggers=None), _ctx()) == hb.Decision()


# --------------------------------------------------------------------------
# One agent's tick.
# --------------------------------------------------------------------------

class TestSkipReason:
    @pytest.mark.parametrize(('agent', 'reason'), [
        ({'month_key': '2026-10', 'month_calls': 4999}, None),
        ({'month_key': '2026-10', 'month_calls': 5000}, 'monthly_cap'),
        ({'month_key': '2026-10', 'month_calls': 9, 'budget': {'monthly_call_cap': Decimal(10)}}, None),
        ({'month_key': '2026-10', 'month_calls': 10, 'budget': {'monthly_call_cap': Decimal(10)}}, 'monthly_cap'),
        ({'month_key': '2026-10', 'month_calls': 10 ** 7, 'budget': {'monthly_call_cap': None}}, None),
        ({'scheduled_day': TODAY, 'scheduled_count': 1}, None),
        ({'scheduled_day': TODAY, 'scheduled_count': 2}, 'daily_cap'),
        ({'scheduled_day': TODAY, 'scheduled_count': 0, 'budget': {'max_scheduled_runs_per_day': Decimal(1)}},
         None),
        ({'scheduled_day': TODAY, 'scheduled_count': 1, 'budget': {'max_scheduled_runs_per_day': Decimal(1)}},
         'daily_cap'),
    ])
    def test_caps(self, agent, reason):
        assert hb._skip_reason(agent, NOW) == reason


@dataclass
class StoreMocks:
    get_run: MagicMock
    clear_lock: MagicMock
    finish_run: MagicMock
    set_agent_attributes: MagicMock
    get_workflow: MagicMock
    start_run: MagicMock
    launch_run: MagicMock
    logger: MagicMock


@contextmanager
def _store_mocks() -> Iterator[StoreMocks]:
    names = ('get_run', 'clear_lock', 'finish_run', 'set_agent_attributes', 'get_workflow', 'start_run',
             'launch_run')
    patches = [patch.object(store, name) for name in names]
    mocks = [p.start() for p in patches]
    try:
        with patch.object(hb, 'logger') as logger:
            yield StoreMocks(*mocks, logger=logger)
    finally:
        for p in patches:
            p.stop()


class TestHealLock:
    def test_no_lock(self):
        with _store_mocks() as m:
            assert hb._heal_lock('T', {'agent_id': AGENT_ID, 'active_run_id': 5}, NOW) is False
        assert m.get_run.call_count == 0

    @pytest.mark.parametrize('run', [None, {'status': 'completed'}, {'status': 'needs_human'}])
    def test_a_lock_on_a_gone_or_finished_run_is_cleared(self, run):
        with _store_mocks() as m:
            m.get_run.return_value = run
            assert hb._heal_lock('T', {'agent_id': AGENT_ID, 'active_run_id': RUN_ID}, NOW) is False
        m.get_run.assert_called_once_with('T', AGENT_ID, RUN_ID)
        m.clear_lock.assert_called_once_with('T', AGENT_ID, RUN_ID)

    @pytest.mark.parametrize(('status', 'age'), [
        ('queued', timedelta(hours=24)), ('running', timedelta(hours=1)), ('running', None)])
    def test_a_live_run_keeps_the_lock(self, status, age):
        run = {'status': status} if age is None else {'status': status, 'started_at': _iso(NOW - age)}
        with _store_mocks() as m:
            m.get_run.return_value = run
            assert hb._heal_lock('T', {'agent_id': AGENT_ID, 'active_run_id': RUN_ID}, NOW) is True
        assert (m.clear_lock.call_count, m.finish_run.call_count) == (0, 0)

    def test_a_run_older_than_24_hours_is_failed_as_stale(self):
        with _store_mocks() as m:
            m.get_run.return_value = {'status': 'running',
                                      'started_at': _iso(NOW - timedelta(hours=24, seconds=1))}
            assert hb._heal_lock('T', {'agent_id': AGENT_ID, 'active_run_id': RUN_ID}, NOW) is True
        m.finish_run.assert_called_once_with('T', AGENT_ID, RUN_ID, 'failed', now=NOW,
                                             error='No progress for 24 hours')
        m.logger.warning.assert_called_once_with('Stale agent run failed',
                                                 extra={'agent_id': AGENT_ID, 'run_id': RUN_ID})


SCHEDULED = {'kind': 'schedule', 'every': '12h'}


class TestProcessAgent:
    def test_a_busy_agent(self):
        with _store_mocks() as m:
            m.get_run.return_value = {'status': 'running'}
            assert hb.process_agent('T', _agent(active_run_id=RUN_ID, triggers=[SCHEDULED]), _ctx()) == 'active_run'
        assert m.start_run.call_count == 0

    def test_a_cap_is_recorded_once(self):
        capped = _agent(month_key='2026-10', month_calls=5000, triggers=[SCHEDULED])
        with _store_mocks() as m:
            assert hb.process_agent('T', capped, _ctx()) == 'monthly_cap'
            assert hb.process_agent('T', {**capped, 'last_skip_reason': 'monthly_cap'}, _ctx()) == 'monthly_cap'
            assert hb.process_agent('T', {**capped, 'last_skip_reason': 'daily_cap'}, _ctx()) == 'monthly_cap'
        assert m.set_agent_attributes.call_args_list == [call('T', AGENT_ID, {'last_skip_reason': 'monthly_cap'})] * 2
        assert m.start_run.call_count == 0

    def test_nothing_due(self):
        with _store_mocks() as m:
            assert hb.process_agent('T', _agent(), _ctx()) == 'not_due'
        assert m.get_workflow.call_count == 0

    def test_a_missing_workflow_is_logged(self):
        with _store_mocks() as m:
            m.get_workflow.return_value = None
            assert hb.process_agent('T', _agent(triggers=[SCHEDULED]), _ctx()) == 'workflow_missing'
        m.get_workflow.assert_called_once_with('T', 'wf_default')
        m.logger.warning.assert_called_once_with('Agent workflow missing; not starting',
                                                 extra={'agent_id': AGENT_ID})
        assert m.start_run.call_count == 0

    def test_starts_with_the_agent_settings(self):
        agent = _agent(workflow_id='wf_abcdefabcdef', last_run_cursor='2026-10-01T00:00:00+00:00',
                       budget={'max_scheduled_runs_per_day': Decimal(1)}, triggers=[SCHEDULED])
        with _store_mocks() as m:
            m.get_workflow.return_value = {'revision': Decimal(3)}
            m.start_run.return_value = {'run_id': RUN_ID}
            assert hb.process_agent('T', agent, _ctx()) == 'started'
        m.get_workflow.assert_called_once_with('T', 'wf_abcdefabcdef')
        m.start_run.assert_called_once_with('T', agent, store.RunStart(
            trigger='schedule', requested_by='heartbeat', trigger_detail={'every': '12h'}, workflow_revision=3,
            review_since='2026-10-01T00:00:00+00:00', counts_against_daily_cap=True, daily_cap=1,
            extra_agent_sets={'last_schedule_fired_at': _iso(NOW), 'last_skip_reason': None}), now=NOW)
        m.launch_run.assert_called_once_with('T', {'run_id': RUN_ID}, now=NOW)
        m.logger.info.assert_called_once_with('Agent run started', extra={
            'agent_id': AGENT_ID, 'run_id': RUN_ID, 'trigger': 'schedule'})

    def test_defaults_when_the_agent_and_workflow_say_nothing(self):
        with _store_mocks() as m:
            m.get_workflow.return_value = {}
            m.start_run.return_value = {'run_id': RUN_ID}
            assert hb.process_agent('T', _agent(triggers=[SCHEDULED]), _ctx()) == 'started'
        request = m.start_run.call_args.args[2]
        assert (request.workflow_revision, request.review_since, request.daily_cap) == (
            1, _iso(NOW - timedelta(days=1)), 2)

    def test_lock_or_cap_refusal_launches_nothing(self):
        with _store_mocks() as m:
            m.get_workflow.return_value = {'revision': 1}
            m.start_run.return_value = None
            assert hb.process_agent('T', _agent(triggers=[SCHEDULED]), _ctx()) == 'lock_or_cap'
        assert m.launch_run.call_count == 0


# --------------------------------------------------------------------------
# The tick over every agent.
# --------------------------------------------------------------------------

def _context(remaining_ms: int = 60_000) -> MagicMock:
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = remaining_ms
    return context


@dataclass
class Tick:
    table: MagicMock
    feedback: MagicMock
    aggregates: MagicMock
    categories: MagicMock
    process: MagicMock
    metrics: MagicMock
    logger: MagicMock


@contextmanager
def _tick(agents: list[dict], outcomes: list[Any] | None = None, *, feedback_name: str = 'fb',
          aggregates_name: str = 'agg', arn: str = 'arn:sm', has_table: bool = True) -> Iterator[Tick]:
    agents_table = MagicMock(name='agents') if has_table else None
    feedback, aggregates = MagicMock(name='feedback'), MagicMock(name='aggregates')
    resource = MagicMock()
    resource.Table.side_effect = {'fb': feedback, 'agg': aggregates}.__getitem__
    with patch.object(store, 'get_agents_table', return_value=agents_table), \
            patch.object(store, 'state_machine_arn', return_value=arn), \
            patch.object(store, 'list_agents', return_value=agents), \
            patch.object(hb, 'FEEDBACK_TABLE', feedback_name), patch.object(hb, 'AGGREGATES_TABLE', aggregates_name), \
            patch.object(hb, 'get_dynamodb_resource', return_value=resource), \
            patch.object(hb, 'get_raw_categories_config', return_value=tuple(CONFIG)) as categories, \
            patch.object(hb, 'process_agent', side_effect=outcomes or []) as process, \
            patch.object(hb, 'metrics') as metrics, patch.object(hb, 'logger') as logger:
        yield Tick(agents_table, feedback, aggregates, categories, process, metrics, logger)


EMPTY = {'evaluated': 0, 'started': 0, 'outcomes': {}}


class TestRunHeartbeat:
    @pytest.mark.parametrize('missing', [
        {'has_table': False}, {'arn': ''}, {'feedback_name': ''}, {'aggregates_name': ''}])
    def test_unconfigured_is_a_logged_no_op(self, missing):
        with _tick([_agent()], **missing) as tick:
            assert hb.run_heartbeat(_context(), now=NOW) == EMPTY
        tick.logger.warning.assert_called_once_with('Agent heartbeat not configured; nothing to do')
        assert tick.process.call_count == 0

    def test_processes_eligible_agents_with_one_shared_context(self):
        eligible = _agent()
        agents = [_agent(enabled=1), _agent(status='archived'), _agent(agent_id='nope'), eligible]
        with _tick(agents, ['started']) as tick:
            summary = hb.run_heartbeat(_context(), now=NOW)
        tick.categories.assert_called_once_with(tick.aggregates)
        tick.process.assert_called_once_with(tick.table, eligible, hb.Context(
            tick.feedback, tick.aggregates, CONFIG, NOW))
        assert summary == {'evaluated': 1, 'started': 1, 'outcomes': {'started': 1}}
        tick.metrics.add_metric.assert_called_once_with(name='AgentRunsStarted', unit='Count', value=1)
        tick.logger.info.assert_called_once_with('Agent heartbeat finished', extra=summary)

    def test_the_clock_defaults_to_now_in_utc(self):
        clock = MagicMock(wraps=datetime)
        clock.now.return_value = NOW
        with _tick([_agent()], ['not_due']) as tick, patch.object(hb, 'datetime', clock):
            hb.run_heartbeat(_context())
        clock.now.assert_called_once_with(UTC)
        assert tick.process.call_args.args[2].now == NOW

    @pytest.mark.parametrize(('remaining', 'outcomes'), [
        (19_999, {'out_of_time': 2}), (20_000, {'not_due': 2})])
    def test_the_time_reserve(self, remaining, outcomes):
        with _tick([_agent(), _agent()], ['not_due', 'not_due']) as tick:
            summary = hb.run_heartbeat(_context(remaining), now=NOW)
        assert summary == {'evaluated': 2, 'started': 0, 'outcomes': outcomes}
        tick.metrics.add_metric.assert_called_once_with(name='AgentRunsStarted', unit='Count', value=0)

    @pytest.mark.parametrize('error', [
        ServiceError('boom'), ClientError({'Error': {'Code': 'X', 'Message': 'm'}}, 'Query'), BotoCoreError()])
    def test_one_agent_failing_is_counted_and_logged(self, error):
        first, second = _agent(agent_id='ag_aaaaaaaaaaaa'), _agent()
        with _tick([first, second, _agent()], [error, 'started', 'started']) as tick:
            summary = hb.run_heartbeat(_context(), now=NOW)
        assert summary == {'evaluated': 3, 'started': 2, 'outcomes': {'error': 1, 'started': 2}}
        tick.logger.exception.assert_called_once_with('Agent heartbeat failed for one agent',
                                                      extra={'agent_id': 'ag_aaaaaaaaaaaa'})
        assert tick.metrics.add_metric.call_args_list == [
            call(name='AgentRunsStarted', unit='Count', value=2),
            call(name='AgentHeartbeatErrors', unit='Count', value=1)]

    def test_an_unexpected_error_propagates(self):
        with _tick([_agent()], [ValueError('bug')]), pytest.raises(ValueError, match='bug'):
            hb.run_heartbeat(_context(), now=NOW)


class TestLambdaHandler:
    def test_the_handler_wears_the_shared_instrumentation_stack_in_order(self):
        """`@instrumented_handler`: logger, tracer, metrics, invocation cost, then the function itself."""
        assert handler_layers(hb.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS

    def test_delegates_and_emits_the_cold_start_metric(self, capsys):
        reset_cold_start_flag()
        context = SimpleNamespace(
            function_name='voc-agent-heartbeat', memory_limit_in_mb=256, aws_request_id='hb-req-1',
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-agent-heartbeat',
            get_remaining_time_in_millis=lambda: 60_000)
        with patch.object(hb, 'run_heartbeat', return_value=EMPTY) as run:
            assert hb.lambda_handler({'source': 'aws.events'}, context) == EMPTY
        run.assert_called_once_with(context)
        assert hb.logger.get_current_keys()['function_request_id'] == 'hb-req-1'
        assert '"ColdStart":[1.0]' in capsys.readouterr().out.replace(' ', '')
