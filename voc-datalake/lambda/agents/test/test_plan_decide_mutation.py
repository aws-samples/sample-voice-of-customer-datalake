"""Mutation hardening for `agents/conductor/plan_decide.py`.

`test_plan_conductor.py` drives whole plans and asserts how they END, with clocks that move by whole
minutes from "now". A mutation run found what such runs cannot see:

* the BOUNDARIES, on a frozen clock: a paused write fails at exactly 30 minutes and not one second
  earlier, a wait at exactly its ``timeout_minutes``, the poll slows to 120 s at exactly one hour (and
  never while a write is paused), a paused step with no ``pending_since`` never times out;
* the JOURNAL: ``plan_running`` / ``step_failed`` (with its step) / ``plan_finished`` / ``plan_failed``
  rows and their summaries, read back by the plan card;
* the WORDING of the plan summary and of a skip, and the fallbacks of a finish that lost a race;
* the SETTLE LOOP: one reload per pass, a pass that changed something followed by one more, and none
  after a pass that changed nothing.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from agents import plan_waits
from agents.conductor import plan_decide, plan_state
from agents.test.plan_fixtures import PlanEnv, conduct, plan_env, plan_of, write_step
from shared import agents_store
from shared import plans_store as ps

T0 = datetime(2026, 3, 2, 9, 0, tzinfo=UTC)
SECOND = timedelta(seconds=1)
ALL_STEP_STATUSES = (ps.STEP_PENDING, ps.STEP_RUNNING, ps.STEP_WAITING, ps.STEP_NEEDS_APPROVAL, ps.STEP_DONE,
                     ps.STEP_FAILED, ps.STEP_SKIPPED, ps.STEP_CANCELLED)


@pytest.fixture
def env() -> Iterator[PlanEnv]:
    with plan_env() as environment:
        yield environment


def _decide(plan_id: str, moment: datetime) -> dict:
    with patch.object(agents_store, 'utc_now', return_value=moment):
        return conduct({'action': 'plan_decide', 'plan_id': plan_id})


def _set_step(env: PlanEnv, plan_id: str, step_id: str, sets: dict[str, Any]) -> None:
    assert ps.update_step(env.agents, plan_id, step_id, ps.Change(sets, ALL_STEP_STATUSES), now=T0) is not None


def _events(env: PlanEnv, plan_id: str) -> list[tuple[str, str, str | None]]:
    items = env.agents.query(KeyConditionExpression=Key('pk').eq(f'PLAN#{plan_id}') & Key('sk').begins_with('EVT#'))
    return [(str(i['kind']), str(i['summary']), i.get('step_id')) for i in items['Items']]


def _event_kinds(env: PlanEnv, plan_id: str) -> list[str]:
    return [kind for kind, _summary, _step in _events(env, plan_id)]


def _write(step_id: str, name: str = 'A', *, after: list[str] | None = None) -> dict:
    return write_step(step_id, 'create_project', {'name': name}, after=after)


def _wait_step(step_id: str, timeout_minutes: int, *, after: list[str] | None = None) -> dict:
    step: dict[str, Any] = {'id': step_id, 'pack': 'scrapers', 'kind': 'wait', 'title': 'Wait for the run',
                            'wait': {'for': 'scraper_run', 'scraper_id': 'sc_1', 'execution_id': 'run_1',
                                     'timeout_minutes': timeout_minutes}}
    if after:
        step['after'] = after
    return step


def _started(env: PlanEnv, plan: dict) -> str:
    """A plan created and started at T0 (its first decide)."""
    plan_id = env.create(plan, now=T0)
    _decide(plan_id, T0)
    return plan_id


def _paused(env: PlanEnv, sets: dict[str, Any]) -> str:
    plan_id = _started(env, plan_of(_write('s1', 'A')))
    _set_step(env, plan_id, 's1', {'status': ps.STEP_NEEDS_APPROVAL, **sets})
    return plan_id


APPROVAL_ERROR = 'No one approved the paused write within 30 minutes.'


class TestAPausedWriteFailsAtExactlyThirtyMinutes:
    def test_one_second_before_it_keeps_waiting_on_the_fast_poll(self, env: PlanEnv):
        plan_id = _paused(env, {'pending_since': agents_store.iso(T0)})
        assert _decide(plan_id, T0 + timedelta(minutes=30) - SECOND) == {'kind': 'wait', 'wait_seconds': 30}
        assert env.statuses(plan_id) == {'s1': ps.STEP_NEEDS_APPROVAL}

    def test_at_thirty_minutes_it_fails_journals_and_finishes_the_plan(self, env: PlanEnv):
        plan_id = _paused(env, {'pending_since': agents_store.iso(T0)})
        assert _decide(plan_id, T0 + timedelta(minutes=30)) == {
            'kind': 'finish', 'status': ps.PLAN_COMPLETED_WITH_ERRORS}
        assert (env.statuses(plan_id), env.steps(plan_id)['s1']['error']) == ({'s1': ps.STEP_FAILED}, APPROVAL_ERROR)
        assert _events(env, plan_id) == [
            ('plan_running', 'Plan started', None),
            ('step_failed', APPROVAL_ERROR, 's1'),
            ('plan_finished', 'Plan completed_with_errors', None),
        ]
        assert env.meta(plan_id)['summary'] == f'0 of 1 steps done.\ns1 (Run create_project) failed: {APPROVAL_ERROR}'

    def test_a_paused_step_without_pending_since_never_times_out_and_polls_fast_after_an_hour(self, env: PlanEnv):
        plan_id = _paused(env, {})
        assert _decide(plan_id, T0 + timedelta(hours=10)) == {'kind': 'wait', 'wait_seconds': 30}
        assert env.statuses(plan_id) == {'s1': ps.STEP_NEEDS_APPROVAL}


class TestAWaitTimesOutAtExactlyItsTimeout:
    def test_a_ready_wait_starts_waiting_at_the_decide(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 5)))
        assert env.steps(plan_id)['s1']['status'] == ps.STEP_WAITING
        assert env.steps(plan_id)['s1']['started_at'] == agents_store.iso(T0)

    def test_one_second_before_it_keeps_waiting(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 5)))
        assert _decide(plan_id, T0 + timedelta(minutes=5) - SECOND) == {'kind': 'wait', 'wait_seconds': 30}
        assert env.statuses(plan_id) == {'s1': ps.STEP_WAITING}

    def test_at_the_timeout_it_fails_and_journals(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 5)))
        _decide(plan_id, T0 + timedelta(minutes=5))
        assert (env.statuses(plan_id), env.steps(plan_id)['s1']['error']) == (
            {'s1': ps.STEP_FAILED}, 'The wait timed out.')
        assert ('step_failed', 'The wait timed out.', 's1') in _events(env, plan_id)

    def test_a_finished_run_completes_the_wait_with_its_outputs(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 5)))
        env.aggregates.put_item(Item={'pk': 'SCRAPER_RUN#sc_1', 'sk': 'run_1', 'status': 'completed'})
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED}
        assert env.statuses(plan_id) == {'s1': ps.STEP_DONE}
        assert env.meta(plan_id)['summary'] == '1 of 1 steps done.'

    def test_a_wait_after_an_unfinished_step_stays_pending(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _wait_step('s2', 5, after=['s1'])))
        assert env.statuses(plan_id) == {'s1': ps.STEP_PENDING, 's2': ps.STEP_PENDING}


class TestThePollSlowsDownAtExactlyOneHour:
    @pytest.mark.parametrize(('elapsed', 'seconds'), [(timedelta(hours=1) - SECOND, 30), (timedelta(hours=1), 120)])
    def test_the_wait_seconds_around_the_hour(self, env: PlanEnv, elapsed: timedelta, seconds: int):
        plan_id = _started(env, plan_of(_wait_step('s1', 600)))
        assert _decide(plan_id, T0 + elapsed) == {'kind': 'wait', 'wait_seconds': seconds}


class TestSkipsAndSummaries:
    def test_a_dependent_of_a_failed_step_is_skipped_naming_its_blocker(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _write('s2', 'B', after=['s1'])))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_FAILED})
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED_WITH_ERRORS}
        assert env.steps(plan_id)['s2']['error'] == 'Skipped: step s1 did not complete.'
        # a step that failed without an error reads "failed:" with nothing after it
        assert env.meta(plan_id)['summary'] == (
            '0 of 2 steps done.\ns1 (Run create_project) failed:\n'
            's2 (Run create_project) skipped: Skipped: step s1 did not complete.')

    def test_a_done_and_a_cancelled_step_count_one_of_two(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _write('s2', 'B')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_DONE})
        _set_step(env, plan_id, 's2', {'status': ps.STEP_CANCELLED, 'error': 'Gone'})
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED_WITH_ERRORS}
        assert env.meta(plan_id)['summary'] == '1 of 2 steps done.\ns2 (Run create_project) cancelled: Gone'


class TestAFinishThatLostTheRace:
    def test_it_reports_the_status_the_plan_now_has_and_journals_nothing(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_DONE})
        with patch.object(ps, 'finish_plan', return_value=None):
            assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_RUNNING}
        assert _event_kinds(env, plan_id) == ['plan_running']

    def test_a_plan_gone_meanwhile_reads_cancelled(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_DONE})
        state = plan_state.load(plan_id, T0)
        assert state is not None
        with patch.object(plan_state, 'load', side_effect=[state, state, None]), \
                patch.object(ps, 'finish_plan', return_value=None):
            assert plan_decide.decide(plan_id) == {'kind': 'finish', 'status': ps.PLAN_CANCELLED}

    def test_a_plan_gone_during_the_settle_is_decided_on_the_state_last_read(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        state = plan_state.load(plan_id, T0)
        assert state is not None
        with patch.object(plan_state, 'load', side_effect=[state, None]):
            assert plan_decide.decide(plan_id) == {'kind': 'execute', 'steps': ['s1']}


def _counting_loads() -> Any:
    return patch.object(plan_state, 'load', wraps=plan_state.load)


class TestTheSettleLoop:
    def test_a_pass_that_changes_nothing_is_the_last(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 600)))
        with _counting_loads() as load:
            _decide(plan_id, T0 + SECOND)
        assert load.call_count == 2  # decide's read + one settle pass

    def test_a_pending_write_is_no_change(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1')))
        with _counting_loads() as load:
            assert _decide(plan_id, T0 + SECOND) == {'kind': 'execute', 'steps': ['s1']}
        assert load.call_count == 2

    def test_a_pass_that_changed_something_is_followed_by_one_more(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_RUNNING})
        with _counting_loads() as load:
            assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED_WITH_ERRORS}
        assert load.call_count == 3

    def test_a_skip_and_a_wait_start_each_count_as_a_change(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _write('s2', 'B', after=['s1']),
                                        _wait_step('s3', 600, after=['s2'])))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_FAILED, 'error': 'x'})
        with _counting_loads() as load:
            _decide(plan_id, T0 + SECOND)
        # pass 1 skips s2, pass 2 skips s3, pass 3 changes nothing
        assert load.call_count == 4
        assert env.statuses(plan_id) == {'s1': ps.STEP_FAILED, 's2': ps.STEP_SKIPPED, 's3': ps.STEP_SKIPPED}

    def test_a_finished_wait_counts_as_a_change(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_wait_step('s1', 600)))
        env.aggregates.put_item(Item={'pk': 'SCRAPER_RUN#sc_1', 'sk': 'run_1', 'status': 'completed'})
        with _counting_loads() as load:
            _decide(plan_id, T0 + SECOND)
        assert load.call_count == 3

    def test_a_fail_that_lost_the_race_journals_nothing_and_is_no_change(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_RUNNING})
        with _counting_loads() as load, patch.object(ps, 'finish_step', return_value=None):
            _decide(plan_id, T0 + SECOND)
        assert load.call_count == 2
        assert _event_kinds(env, plan_id) == ['plan_running']


class TestDecideOnAPlanThatIsNotRunning:
    def test_a_plan_without_a_status_finishes_failed(self, env: PlanEnv):
        plan_id = env.create(plan_of(_write('s1', 'A')), now=T0)
        state = plan_state.load(plan_id, T0)
        assert state is not None
        meta = {key: value for key, value in state.meta.items() if key != 'status'}
        with patch.object(plan_state, 'load', return_value=plan_state.PlanState(
                meta, state.rows, state.definitions, state.order, T0)):
            assert plan_decide.decide(plan_id) == {'kind': 'finish', 'status': ps.PLAN_FAILED}

    def test_a_finished_plan_closes_no_steps(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _write('s2', 'B')))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_FAILED})
        ps.finish_plan(env.agents, plan_id, ps.PLAN_FAILED, now=T0, summary='x')
        close = MagicMock()
        with patch.object(ps, 'close_open_steps', close):
            assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_FAILED}
        close.assert_not_called()

    def test_an_approved_plan_that_lost_its_start_is_read_again(self, env: PlanEnv):
        plan_id = env.create(plan_of(_write('s1', 'A')), now=T0)
        with patch.object(ps, 'update_meta', return_value=None):
            assert _decide(plan_id, T0) == {'kind': 'finish', 'status': ps.PLAN_APPROVED}
        assert _events(env, plan_id) == []


class TestStop:
    def test_it_fails_the_plan_skips_open_steps_and_journals_the_summary(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'),
                                        _write('s2', 'B', after=['s1'])))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_RUNNING})
        assert plan_decide.stop(plan_id, 'Halted.') == {'kind': 'finish', 'status': ps.PLAN_FAILED}
        assert env.meta(plan_id)['status'] == ps.PLAN_FAILED
        assert {k: (r['status'], r.get('error')) for k, r in env.steps(plan_id).items()} == {
            's1': (ps.STEP_RUNNING, None), 's2': (ps.STEP_SKIPPED, 'The plan stopped before this step ran.')}
        assert _events(env, plan_id)[-1] == ('plan_failed', 'Halted.', None)

    def test_a_plan_already_finished_is_left_alone(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A')))
        ps.finish_plan(env.agents, plan_id, ps.PLAN_COMPLETED, now=T0, summary='done')
        assert plan_decide.stop(plan_id, 'Halted.') == {'kind': 'finish', 'status': ps.PLAN_FAILED}
        assert (env.meta(plan_id)['status'], env.statuses(plan_id)) == (ps.PLAN_COMPLETED, {'s1': ps.STEP_PENDING})
        assert _event_kinds(env, plan_id) == ['plan_running']


def _wait_chain(length: int) -> dict:
    """``length`` waits, each after the one before, every run already completed: each takes two passes."""
    steps = [_wait_step(f's{i}', 600, after=[f's{i - 1}'] if i > 1 else None) for i in range(1, length + 1)]
    for step in steps:
        step['wait']['execution_id'] = f"run_{step['id']}"
    return plan_of(*steps)


class TestTheSettleLoopStopsAfterTwentyFivePasses:
    def _settled(self, env: PlanEnv) -> tuple[str, dict]:
        plan_id = env.create(_wait_chain(13), now=T0)
        for i in range(1, 14):
            env.aggregates.put_item(Item={'pk': 'SCRAPER_RUN#sc_1', 'sk': f'run_s{i}', 'status': 'completed'})
        return plan_id, _decide(plan_id, T0)

    def test_the_twenty_fifth_pass_starts_the_last_wait_and_the_decide_waits(self, env: PlanEnv):
        plan_id, directive = self._settled(env)
        assert directive == {'kind': 'wait', 'wait_seconds': 30}
        statuses = env.statuses(plan_id)
        assert (statuses['s12'], statuses['s13']) == (ps.STEP_DONE, ps.STEP_WAITING)

    def test_the_next_decide_finishes_it(self, env: PlanEnv):
        plan_id, _directive = self._settled(env)
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED}
        assert env.meta(plan_id)['summary'] == '13 of 13 steps done.'


class TestAWaitIsNeverExecuted:
    def test_a_ready_wait_whose_start_lost_the_race_keeps_the_plan_running(self, env: PlanEnv):
        plan_id = env.create(plan_of(_wait_step('s1', 600)), now=T0)
        with patch.object(ps, 'update_step', return_value=None):
            assert _decide(plan_id, T0) == {'kind': 'wait', 'wait_seconds': 30}
        assert (env.meta(plan_id)['status'], env.statuses(plan_id)) == (ps.PLAN_RUNNING, {'s1': ps.STEP_PENDING})

    def test_the_next_decide_starts_the_wait_that_lost_the_race(self, env: PlanEnv):
        plan_id = env.create(plan_of(_wait_step('s1', 600)), now=T0)
        with patch.object(ps, 'update_step', return_value=None):
            _decide(plan_id, T0)
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'wait', 'wait_seconds': 30}
        assert env.statuses(plan_id) == {'s1': ps.STEP_WAITING}


class TestAPendingStepKeepsThePlanRunning:
    def test_a_pending_step_behind_a_failed_one_is_skipped_before_the_plan_finishes(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'), _write('s2', 'B', after=['s1'])))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_FAILED, 'error': 'x'})
        assert _decide(plan_id, T0 + SECOND) == {'kind': 'finish', 'status': ps.PLAN_COMPLETED_WITH_ERRORS}
        assert env.statuses(plan_id) == {'s1': ps.STEP_FAILED, 's2': ps.STEP_SKIPPED}

    def test_a_pending_step_whose_skip_lost_the_race_keeps_the_plan_running(self, env: PlanEnv):
        plan_id = _started(env, plan_of(_write('s1', 'A'), _write('s2', 'B', after=['s1'])))
        _set_step(env, plan_id, 's1', {'status': ps.STEP_FAILED, 'error': 'x'})
        with patch.object(ps, 'finish_step', return_value=None):
            assert _decide(plan_id, T0 + SECOND) == {'kind': 'wait', 'wait_seconds': 30}
        assert env.meta(plan_id)['status'] == ps.PLAN_RUNNING


def test_a_failed_wait_without_a_reason_reads_the_job_failed(env: PlanEnv):
    plan_id = _started(env, plan_of(_wait_step('s1', 600)))
    failed = plan_waits.WaitResult(plan_waits.WAIT_FAILED)
    with patch.object(plan_waits, 'poll', return_value=failed):
        _decide(plan_id, T0 + SECOND)
    assert env.steps(plan_id)['s1']['error'] == 'The job failed.'
