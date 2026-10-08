"""Tests for the agent heartbeat (agents/heartbeat/handler.py): trigger rules and one tick (moto)."""
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from agents.heartbeat import handler as hb
from shared import agents_store as store
from shared.test.agents_fixtures import CATEGORIES, agent_body, agents_env

NOW = datetime(2026, 10, 5, 9, 30, tzinfo=UTC)  # a Monday
CREATED = NOW - timedelta(days=3)


def _context(remaining_ms=60_000):
    context = MagicMock()
    context.get_remaining_time_in_millis.return_value = remaining_ms
    return context


@contextmanager
def _tick_env():
    with agents_env() as env, \
            patch.object(hb, 'FEEDBACK_TABLE', env.feedback.name), \
            patch.object(hb, 'AGGREGATES_TABLE', env.aggregates.name), \
            patch.object(hb, 'get_dynamodb_resource', return_value=env.resource):
        yield env


def _agent(env, *, enabled=True, **overrides):
    fields = store.normalize_agent(agent_body(enabled=enabled, **overrides), CATEGORIES)
    fields['workflow_id'] = 'wf_default'
    return store.create_agent(env.agents, fields, created_by='admin-sub', now=CREATED)


def _stored_agent(env, agent_id: str) -> dict:
    """The agent row, which must exist."""
    stored = store.get_agent(env.agents, agent_id)
    assert stored is not None
    return stored


def _stored_run(env, agent_id: str, run_id: str) -> dict:
    """The run row, which must exist."""
    run = store.get_run(env.agents, agent_id, run_id)
    assert run is not None
    return run


def _review(env, feedback_id, *, at, category='shipping', subcategory=None):
    item = {'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'gsi1pk': f"DATE#{at.strftime('%Y-%m-%d')}",
            'gsi1sk': f'{at.isoformat()}#{feedback_id}', 'category': category}
    if subcategory:
        item['subcategory'] = subcategory
    env.feedback.put_item(Item=item)


def _counter(env, pk, day, count):
    env.aggregates.put_item(Item={'pk': pk, 'sk': day, 'count': Decimal(count)})


class TestThresholdRule:
    def test_bucket_partitions_match_the_aggregator(self):
        from aggregator.handler import SUBCATEGORY_PREFIX
        assert hb.SUBCATEGORY_METRIC_PREFIX == SUBCATEGORY_PREFIX
        assert hb.bucket_pk('shipping#late') == 'METRIC#daily_subcategory#shipping#late'
        assert hb.bucket_pk('shipping') == 'METRIC#daily_category#shipping'

    def test_count_since_baseline(self):
        daily = {'2026-10-03': 4, '2026-10-04': 6, '2026-10-05': 2}
        assert hb.count_since_baseline(daily, None, 0) == 12
        assert hb.count_since_baseline(daily, '2026-10-04', 5) == 3
        assert hb.count_since_baseline(daily, '2026-10-05', 9) == 0


class TestTick:
    def test_new_reviews_in_scope_start_a_run(self):
        with _tick_env() as env:
            agent = _agent(env)
            _review(env, 'a', at=NOW - timedelta(hours=1))
            _review(env, 'b', at=NOW - timedelta(minutes=5), category='billing')
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'not_due': 1}
            _review(env, 'c', at=NOW - timedelta(minutes=2))
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 1
            stored = _stored_agent(env, agent['agent_id'])
            run = _stored_run(env, agent['agent_id'], stored['active_run_id'])
            assert run['trigger'] == 'new_reviews'
            assert run['trigger_detail'] == {'new_reviews': 2}
            assert stored['scheduled_count'] == 1
            assert stored['last_run_cursor'] == store.iso(NOW)
            assert env.sfn.start_execution.call_count == 1
            # One active run per agent.
            assert hb.run_heartbeat(_context(), now=NOW + timedelta(minutes=15))['outcomes'] == {'active_run': 1}

    def test_reviews_before_creation_do_not_count(self):
        with _tick_env() as env:
            _agent(env)
            _review(env, 'old1', at=CREATED - timedelta(hours=2))
            _review(env, 'old2', at=CREATED - timedelta(hours=1))
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 0

    def test_cooldown_after_a_run(self):
        with _tick_env() as env:
            agent = _agent(env)
            store.set_agent_attributes(env.agents, agent['agent_id'],
                                       {'last_run_at': store.iso(NOW - timedelta(hours=1))})
            for name in ('a', 'b', 'c'):
                _review(env, name, at=NOW - timedelta(minutes=1))
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'not_due': 1}

    def test_disabled_and_archived_agents_are_ignored(self):
        with _tick_env() as env:
            _agent(env, enabled=False)
            assert hb.run_heartbeat(_context(), now=NOW)['evaluated'] == 0

    def test_daily_cap(self):
        with _tick_env() as env:
            agent = _agent(env, triggers=[{'kind': 'schedule', 'every': '12h'}],
                           budget={'max_scheduled_runs_per_day': 1})
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 1
            stored = _stored_agent(env, agent['agent_id'])
            store.finish_run(env.agents, agent['agent_id'], stored['active_run_id'], 'completed', now=NOW)
            later = NOW + timedelta(hours=12)
            assert hb.run_heartbeat(_context(), now=later)['outcomes'] == {'daily_cap': 1}
            assert _stored_agent(env, agent['agent_id'])['last_skip_reason'] == 'daily_cap'
            assert hb.run_heartbeat(_context(), now=NOW + timedelta(days=1))['started'] == 1

    def test_monthly_cap_pauses_the_agent(self):
        with _tick_env() as env:
            agent = _agent(env, triggers=[{'kind': 'schedule', 'every': '12h'}], budget={'monthly_call_cap': 10})
            store.set_agent_attributes(env.agents, agent['agent_id'], {'month_key': '2026-10', 'month_calls': 10})
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'monthly_cap': 1}

    def test_threshold_per_subcategory_with_baseline(self):
        with _tick_env() as env:
            agent = _agent(env, triggers=[{'kind': 'threshold', 'count': 5, 'per': 'subcategory', 'window_days': 7}])
            day = NOW.strftime('%Y-%m-%d')
            _counter(env, 'METRIC#daily_subcategory#shipping#late', day, 4)
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 0
            _counter(env, 'METRIC#daily_subcategory#shipping#late', day, 6)
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 1
            stored = _stored_agent(env, agent['agent_id'])
            assert stored['threshold_baseline'] == {'shipping#late': 6}
            assert stored['threshold_since'] == day
            store.finish_run(env.agents, agent['agent_id'], stored['active_run_id'], 'completed', now=NOW)
            _counter(env, 'METRIC#daily_subcategory#shipping#late', day, 9)
            assert hb.run_heartbeat(_context(), now=NOW + timedelta(minutes=15))['started'] == 0

    def test_a_lock_on_a_finished_run_is_healed(self):
        with _tick_env() as env:
            agent = _agent(env, triggers=[{'kind': 'schedule', 'every': '12h'}])
            store.set_agent_attributes(env.agents, agent['agent_id'], {'active_run_id': 'ar_000000000000'})
            assert hb.run_heartbeat(_context(), now=NOW)['started'] == 1

    def test_a_stale_run_is_failed(self):
        with _tick_env() as env:
            agent = _agent(env)
            old = NOW - timedelta(hours=hb.STALE_RUN_HOURS + 1)
            run = store.start_run(env.agents, agent, store.RunStart(
                trigger='manual', requested_by='x', workflow_revision=1, review_since=store.iso(old)), now=old)
            assert run is not None
            assert hb.run_heartbeat(_context(), now=NOW)['outcomes'] == {'active_run': 1}
            assert _stored_run(env, agent['agent_id'], run['run_id'])['status'] == 'failed'
            assert 'active_run_id' not in _stored_agent(env, agent['agent_id'])
