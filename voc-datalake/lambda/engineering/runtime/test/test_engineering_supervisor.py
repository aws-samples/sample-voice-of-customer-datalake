"""The supervisor on the local fake: boot, done, stall, pause and continue, crash, stop, budget."""
import json
import sys
import time
from collections.abc import Callable
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from engineering.runtime.caps import Timings
from engineering.runtime.checkpoints import checkpoint_prefix
from engineering.runtime.interface import Command, MicroVm, RuntimeRefused
from engineering.runtime.launcher import Launcher, RunStopped
from engineering.runtime.ports import Budget, Lease
from engineering.runtime.runs import RunCaps
from engineering.runtime.sessions import AgentSession, StaleSession
from engineering.runtime.supervisor import THIRTY_DAYS
from engineering.runtime.test.conftest import BUCKET, COMMIT, ROLE_ARNS, RUN, FakeSts, World

T = Timings()
SLEEP = 'import time; time.sleep(60)'
#: A harness that, once asked (a file `pause` appears in its directory), checkpoints and exits 75.
PAUSE_WHEN_ASKED = ('import os, sys, time\n'
                    'while not os.path.exists("pause"): time.sleep(0.02)\n'
                    'sys.exit(75)')
#: A harness that reports its status the way the real one does, then works.
REPORTS_STATUS = ('import json, os, time\n'
                  'os.makedirs("../home/.voc", exist_ok=True)\n'
                  'json.dump({"step": "running tests", "recent_tools": ["run", "read_file"],'
                  ' "tokens": {"model-a": {"in": 10, "out": 20}}}, open("../home/.voc/status.json", "w"))\n'
                  'time.sleep(60)')


def _workdir(world: World) -> Path:
    return Path(world.session().endpoint)


def _until(world: World, now: int, done: Callable[[AgentSession], bool], agent_id: str = 'fixer-1',
           progress: bool | None = True) -> AgentSession:
    """Tick at ``now`` until ``done`` holds for the agent's session.

    Before each tick the lease is renewed with progress (``True``), renewed by the heartbeat only
    (``False``), or left alone (``None``).
    """
    for _ in range(300):
        if progress is not None:
            world.renew(now, progress=progress, agent_id=agent_id, task_id=world.session(agent_id).task_id)
        world.supervisor.tick(now)
        session = world.session(agent_id)
        if done(session):
            return session
        time.sleep(0.02)
    raise AssertionError(f'the session never got there: {world.session(agent_id)}')


def _assert_terminated(world: World, session: AgentSession) -> None:
    with pytest.raises(RuntimeRefused, match='terminated'):
        world.runtime.mint_token(session.vm)


def test_a_session_boots_its_checkout_then_its_harness_and_ends_its_microvm_when_done(world: World):
    world.launch(code="import os; assert os.path.exists('checked-out')")
    working = _until(world, 1000, lambda s: s.status != 'booting')
    done = _until(world, 1000, lambda s: s.status == 'done')
    assert working.status in ('working', 'done')
    assert done.exec_id is None
    _assert_terminated(world, done)


def test_with_nothing_live_a_tick_does_nothing(world: World):
    world.launch()
    _until(world, 1000, lambda s: s.status == 'done')
    events = len(world.bus.events)
    assert world.supervisor.tick(1000) == {}
    assert len(world.bus.events) == events


def _on_an_open_wait(world: World, code: str) -> tuple[AgentSession, Lease]:
    """A working agent whose lease turns to an open wait, after the tick that sees it; and its lease before."""
    world.launch(code=code)
    working = _until(world, 1000, lambda s: s.status == 'working')
    lease = world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1']
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(lease, waiting=True)
    world.supervisor.tick(1001)
    return working, lease


def test_an_agent_on_an_open_wait_is_suspended_neither_polled_nor_stopped_and_resumed_after(world: World):
    working, _ = _on_an_open_wait(world, SLEEP)
    world.supervisor.tick(1000 + T.stall_after + T.lease_ttl + T.answer_window)
    with pytest.raises(RuntimeRefused, match='suspended'):
        world.runtime.mint_token(working.vm)
    assert (world.session().status, world.session().asked_at, world.session().suspended) == ('working', None, True)
    assert world.bus.kinds() == []
    world.renew(2000)
    world.supervisor.tick(2000)
    assert world.session().suspended is False
    assert world.runtime.mint_token(working.vm).value


def test_a_long_wait_whose_checkpoint_never_comes_is_held_without_its_microvm(world: World):
    working, _ = _on_an_open_wait(world, SLEEP)
    asked = 1001 + T.wait_suspend_limit
    world.supervisor.tick(asked)
    assert (world.session().status, world.session().after_pause) == ('pause_requested', 'wait')
    world.supervisor.tick(asked + T.answer_window)
    assert world.session().status == 'waiting'
    _assert_terminated(world, working)


def test_a_crash_leaves_its_last_output_for_the_run_monitor(world: World):
    world.launch(code="import sys; sys.stderr.write('boom'); sys.exit(3)")
    continued = _until(world, 1000, lambda s: s.continuation >= 1)
    assert continued.inspect['last_exit']['exit_code'] == 3
    assert continued.inspect['last_exit']['stderr_tail'] == 'boom'


def test_a_quiet_agent_is_asked_for_its_state_then_its_task_is_reposted(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    _until(world, 1000 + T.stall_after, lambda s: s.asked_at is not None, progress=False)
    stopped = _until(world, 1000 + T.stall_after + T.answer_window, lambda s: s.status == 'reposted', progress=False)
    assert world.bus.kinds()[:2] == ['question', 'timed_out']
    assert world.board.reposted == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1', 'stalled')]
    _assert_terminated(world, stopped)


def test_progress_after_the_question_clears_it(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    _until(world, 1000 + T.stall_after, lambda s: s.asked_at is not None, progress=False)
    cleared = _until(world, 1000 + T.stall_after + 30, lambda s: s.asked_at is None)
    assert cleared.status == 'working'


def test_a_paused_harness_is_continued_in_a_new_microvm_from_its_newest_valid_checkpoint(world: World):
    prefix = checkpoint_prefix('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', COMMIT, 1)
    world.s3.put_object(Bucket=BUCKET, Key=f'{prefix}000001-a.json', Body=json.dumps({'position': {'step': 1}}))
    world.s3.put_object(Bucket=BUCKET, Key=f'{prefix}000002-b.json', Body=json.dumps({'position': 2, 'token': 'x'}))
    first = world.launch(code='import sys; sys.exit(75)')
    continued = _until(world, 1000, lambda s: s.continuation >= 1)
    event = next(event for event in world.bus.events if event['kind'] == 'continued')
    assert (continued.vm_id != first.vm_id, continued.crashes, continued.restore_key) == (
        True, 0, f'{prefix}000001-a.json')
    assert event['refs'] == {'continuation': '1', 'after': 'pause', 'checkpoint': f'{prefix}000001-a.json'}
    _assert_terminated(world, first)


def test_the_supervisor_asks_for_a_pause_ahead_of_the_limit_and_a_silent_agent_is_continued_at_the_hard_stop(
        world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    pausing = _until(world, 1000 + T.pause_after, lambda s: s.status == 'pause_requested')
    continued = _until(world, 1000 + T.hard_stop, lambda s: s.continuation == 1)
    assert pausing.pause_requested_at == 1000 + T.pause_after
    assert (continued.crashes, continued.restore_key) == (1, None)
    assert 'pause' in world.bus.kinds()


def test_a_crashing_agent_is_continued_twice_then_its_task_is_reposted(world: World):
    world.launch(code='import sys; sys.exit(1)')
    ended = _until(world, 1000, lambda s: s.status == 'reposted')
    assert ended.crashes == T.max_crash_continuations
    assert world.bus.kinds().count('continued') == T.max_crash_continuations
    assert world.board.reposted == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1', 'crashed')]


def test_a_run_coordinator_that_keeps_crashing_goes_to_a_person_not_to_the_board(world: World):
    world.launch(agent_id='coordinator-0', role='coordinator', task_id='coordinate', code='import sys; sys.exit(1)')
    ended = _until(world, 1000, lambda s: s.status == 'failed', agent_id='coordinator-0')
    assert ended.status == 'failed'
    assert world.control.humans == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'coordinator')]
    assert not world.board.reposted


def test_a_lost_lease_is_a_crash(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    del world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1']
    continued = _until(world, 1001, lambda s: s.continuation == 1, progress=None)
    assert continued.crashes == 1


def test_a_stop_ends_every_microvm_at_once_and_renews_no_session(world: World):
    first = world.launch(code=SLEEP)
    second = world.launch(agent_id='hunter-1', role='hunter', task_id='task-2', code=SLEEP)
    world.control.stops.add('01JD3R4NZXQ7Y2W8K4M6P9T0AB')
    world.supervisor.tick(2000)
    assert [world.session(agent).status for agent in ('fixer-1', 'hunter-1')] == ['stopped', 'stopped']
    assert world.sts.calls == []
    for session in (first, second):
        _assert_terminated(world, session)


def test_the_launcher_refuses_a_stopped_runs_agents():
    with pytest.raises(RunStopped):
        Launcher(FakeSts(), ROLE_ARNS).session_for(role='fixer', connection='c', run_id='r', agent_id='a', stopped=True)


def test_each_agent_gets_its_roles_session_named_and_tagged_and_renewed_before_it_lapses(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    (first, *_) = world.sts.calls
    # The session name the broker and the board read (<run ULID>.<agent index>), the tags the roles' conditions read.
    assert (first['RoleArn'], first['RoleSessionName'], first['DurationSeconds']) == (
        ROLE_ARNS['fixer'], '01JD3R4NZXQ7Y2W8K4M6P9T0AB.1', 900)
    assert {tag['Key']: tag['Value'] for tag in first['Tags']} == {
        'ws': 'default', 'run': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent': 'fixer-1', 'connection': 'conn-1'}
    calls = len(world.sts.calls)
    world.renew(1000 + 300)
    world.supervisor.tick(1000 + 300)
    assert len(world.sts.calls) == calls
    world.renew(1000 + 600)
    world.supervisor.tick(1000 + 600)
    assert len(world.sts.calls) == calls + 1


def test_a_run_is_stopped_at_thirty_days_at_a_decision_point_offering_only_stop(world: World):
    world.launch(code=SLEEP)
    world.supervisor.tick(1000 + THIRTY_DAYS)
    assert world.session().status == 'stopped'
    assert world.control.humans == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'thirty_days')]


def test_an_ended_run_past_thirty_days_is_stopped_without_opening_a_decision_point(world: World):
    world.launch(code=SLEEP)
    world.control.stops.add(RUN)
    world.supervisor.tick(1000 + THIRTY_DAYS)
    assert (world.session().status, world.control.humans) == ('stopped', [])


def test_a_run_past_thirty_days_cannot_be_resumed(world: World):
    with pytest.raises(RuntimeRefused, match='30 days'):
        world.supervisor.signal(RUN, None, 'resume', THIRTY_DAYS)


def test_a_continued_session_keeps_the_tokens_of_its_earlier_microvms():
    first = AgentSession(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                         egress=(), connection='conn-1', commit=COMMIT, paths=(), harness=('true',), vm_id='vm-1',
                         endpoint='', started_at=0, tokens={'model-a': {'in': 100, 'out': 10}})
    continued = first.on(MicroVm(vm_id='vm-2', agent_id='fixer-1', endpoint=''), 10, None)
    # The new MicroVM's harness counts from zero.
    tokens = continued.reported({'model-a': {'in': 5, 'out': 1}, 'model-b': {'in': 2, 'out': 0}})
    assert tokens == {'model-a': {'in': 105, 'out': 11}, 'model-b': {'in': 2, 'out': 0}}
    assert replace(continued, tokens=tokens).input_tokens == 107
    # A report from inside the MicroVM can only add: never a negative count, never below what was saved.
    lower = replace(continued, tokens=tokens).reported({'model-a': {'in': -1_000_000, 'out': 0}})
    assert lower == tokens


def test_pause_holds_the_agent_after_its_checkpoint_and_resume_continues_it(world: World):
    world.launch(code=PAUSE_WHEN_ASKED)
    _until(world, 1000, lambda s: s.status == 'working')
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'pause', 1001) == {'fixer-1': 'pause_requested'}
    (_workdir(world) / 'pause').write_text('x')
    held = _until(world, 1002, lambda s: s.status == 'paused')
    assert held.continuation == 0
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'resume', 1003) == {'fixer-1': 'booting'}
    assert world.session().continuation == 1


def test_a_run_coordinator_that_keeps_stalling_goes_to_a_person_after_its_continuations(world: World):
    world.launch(agent_id='coordinator-0', role='coordinator', task_id='coordinate', code=SLEEP)
    now = 1000
    for _ in range(200):
        world.renew(now, progress=False, agent_id='coordinator-0', task_id='coordinate')
        world.supervisor.tick(now)
        if world.session('coordinator-0').status == 'failed':
            break
        now += 60
        time.sleep(0.01)
    ended = world.session('coordinator-0')
    assert (ended.status, ended.continuation) == ('failed', T.max_crash_continuations)
    assert world.control.humans == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'coordinator')]
    assert world.board.reposted == []



def test_a_session_whose_task_another_agent_now_holds_ends_never_continued_nor_reposted(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    # Its task was re-posted and taken by fixer-2, whose heartbeat is fresh: none of it is fixer-1's.
    world.renew(1060, agent_id='fixer-2')
    world.supervisor.tick(1060)
    ended = world.session('fixer-1')
    assert (ended.status, ended.continuation, world.board.reposted) == ('reposted', 0, [])
    _assert_terminated(world, ended)


def test_a_session_whose_task_is_at_another_attempt_ends(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    world.board.leases[key] = replace(world.board.leases[key], attempt=2)  # re-posted and taken again by fixer-1
    world.supervisor.tick(1060)
    assert world.session('fixer-1').status == 'reposted'


def _working_on_a_task_that(world: World, **lease: Any) -> AgentSession:
    """fixer-1 working, its task's lease then changed on the board (``lease``: the Lease's fields)."""
    world.launch(code=SLEEP)
    working = _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    world.board.leases[key] = replace(world.board.leases[key], **lease)
    return working


def test_a_task_that_has_ended_waits_for_its_harness_to_exit_never_judged_crashed(world: World):
    # Done on the board, its lease no longer renewed: well past the lease's time, it is not a crash.
    working = _working_on_a_task_that(world, final_state='done')
    world.supervisor.tick(1000 + T.lease_ttl * 3)
    after = world.session('fixer-1')
    assert (after.status, after.crashes, after.continuation) == ('working', 0, working.continuation)


def test_a_stalled_agents_task_is_reposted_at_the_attempt_it_worked_on(world: World):
    world.launch(code=SLEEP, attempt=3)
    _until(world, 1000, lambda s: s.status == 'working')
    _until(world, 1000 + T.stall_after, lambda s: s.asked_at is not None, progress=False)
    _until(world, 1000 + T.stall_after + T.answer_window, lambda s: s.status == 'reposted', progress=False)
    assert world.board.attempts == [3]

def test_an_agent_that_stalls_while_pausing_is_held_never_reposted(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'pause', 1001)
    _until(world, 1000 + T.stall_after, lambda s: s.asked_at is not None or s.status != 'pause_requested',
           progress=False)
    held = _until(world, 1000 + T.stall_after + T.answer_window, lambda s: s.status != 'pause_requested',
                  progress=False)
    assert (held.status, held.continuation, world.board.reposted) == ('paused', 0, [])
    _assert_terminated(world, held)


def test_shut_down_on_a_paused_agent_stops_it_and_resume_leaves_it_alone(world: World):
    world.launch(code=PAUSE_WHEN_ASKED)
    _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'pause', 1001)
    (_workdir(world) / 'pause').write_text('x')
    _until(world, 1002, lambda s: s.status == 'paused')
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'save', 1003) == {'fixer-1': 'paused'}
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'shutdown', 1003) == {'fixer-1': 'stopped'}
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'resume', 1004) == {'fixer-1': 'stopped'}
    assert world.session().continuation == 0


def test_stop_now_on_a_paused_agent_stops_it(world: World):
    world.launch(code='import sys; sys.exit(75)')
    world.control.spend = Budget(tokens=10, cost_usd=0.0, max_tokens=10, max_cost_usd=None)
    _until(world, 1000, lambda s: s.status == 'paused')
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'stop_now', 1001) == {'fixer-1': 'stopped'}


def test_a_crash_that_cannot_be_recorded_keeps_its_count_and_lets_go_of_the_row(
        world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code=SLEEP)
    working = _until(world, 1000, lambda s: s.status == 'working')

    def gone(*_args: object) -> None:
        raise OSError('the MicroVM is gone')

    def no_new_microvm(*_args: object) -> None:
        raise OSError('no capacity')

    monkeypatch.setattr(world.runtime, 'poll_exec', gone)
    monkeypatch.setattr(world.runtime, 'run', no_new_microvm)
    for now in range(1001, 1001 + T.max_runtime_failures + 1):
        world.renew(now)
        world.supervisor.tick(now)
    kept = world.session()
    assert (kept.vm_id, kept.claimed_until) == (working.vm_id, None)
    assert kept.failures >= T.max_runtime_failures


def test_resume_is_refused_for_a_stopped_run(world: World):
    world.launch()
    world.control.stops.add('01JD3R4NZXQ7Y2W8K4M6P9T0AB')
    with pytest.raises(RuntimeRefused, match='cannot be resumed'):
        world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'resume', 1000)


def test_shut_down_stops_the_agent_when_no_checkpoint_comes(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'shutdown', 1001)
    stopped = _until(world, 1001 + T.answer_window, lambda s: s.status == 'stopped')
    assert stopped.after_pause == 'shutdown'


def test_save_asks_for_a_checkpoint_and_stop_now_ends_at_once(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'save', 1001)
    assert world.bus.kinds() == ['save']
    stopped = world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'stop_now', 1002)
    assert stopped == {'fixer-1': 'stopped'}
    with pytest.raises(RuntimeRefused, match='no agent'):
        world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'ghost', 'save', 1003)


def test_the_row_carries_inspection_data_and_live_cost_counters(world: World):
    world.launch(code=REPORTS_STATUS)
    _until(world, 1000, lambda s: s.status == 'working')
    observed = _until(world, 1060, lambda s: s.inspect.get('step') == 'running tests')
    assert observed.tokens == {'model-a': {'in': 10, 'out': 20}}
    assert observed.inspect['recent_tools'] == ['run', 'read_file']
    assert (observed.inspect['microvm_state'], observed.inspect['heartbeat_age']) == ('running', 0)
    assert observed.microvm_seconds == 60


def test_an_agents_tokens_add_up_over_every_microvm_it_ran_in(world: World):
    world.launch(code=REPORTS_STATUS)
    _until(world, 1000, lambda s: s.status == 'working')
    first = _until(world, 1060, lambda s: s.tokens != {})
    # Its MicroVM goes away: the agent is continued in a new one, whose harness counts from zero again.
    world.runtime.terminate(first.vm)
    _until(world, 1120, lambda s: s.continuation == 1)
    _until(world, 1180, lambda s: s.status == 'working')
    both = _until(world, 1240, lambda s: s.tokens != first.tokens)
    assert both.tokens == {'model-a': {'in': 20, 'out': 40}}
    assert (both.input_tokens, both.output_tokens) == (20, 40)


def test_an_agents_microvm_time_is_priced_once_across_its_continuations(world: World):
    world.store._usd_per_second = Decimal('0.0001')  # the deployment's price
    first = world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.tick(1600)
    # Its MicroVM goes away: continued in a new one, then ended; every second counted once.
    world.runtime.terminate(first.vm)
    _until(world, 1660, lambda s: s.continuation == 1)
    world.supervisor.signal(RUN, 'fixer-1', 'stop_now', 3000)
    ended = world.session()
    row = world.store._table.get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'AGENT#fixer-1'})['Item']
    assert (ended.status, ended.priced_seconds) == ('stopped', ended.microvm_seconds)
    assert row['cost_usd'] == Decimal('0.0001') * ended.microvm_seconds


def test_a_signal_says_whether_it_took_effect_on_each_agent(world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'save', 1001) == {'fixer-1': ('working', True)}
    # Its message to the agent cannot be sent (a refused bus): the save did not happen.
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError('the bus refused')

    monkeypatch.setattr(world.bus, 'emit', refuse)
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'save', 1002) == {'fixer-1': ('working', False)}
    monkeypatch.undo()
    world.store.claim(world.session(), 1003, 300)
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'save', 1003) == {'fixer-1': ('busy', False)}


def test_a_signal_for_another_attempt_of_the_task_does_nothing_but_stop_now_always_stops(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'pause', 1001, attempt=2) == {'fixer-1': ('stale', False)}
    assert world.session().status == 'working'
    with pytest.raises(RuntimeRefused, match='agent_id'):
        world.supervisor.signal_detailed(RUN, None, 'pause', 1001, attempt=1)
    # A person's kill switch reaches whatever attempt the agent is on.
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'stop_now', 1002, attempt=2) == {'fixer-1': ('stopped', True)}
    # Nothing left to do: answered with its status, not applied.
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'resume', 1003) == {'fixer-1': ('stopped', False)}


def test_a_resume_of_an_agent_that_already_runs_is_not_applied(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    before = world.session()
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'resume', 1001) == {'fixer-1': ('working', False)}
    # Nothing written beyond the claim and its release.
    assert (world.session().status, world.session().suspended) == (before.status, before.suspended)


def test_a_signal_whose_microvm_call_fails_is_not_applied(world: World, monkeypatch: pytest.MonkeyPatch):
    _until_waiting = world.launch(code=SLEEP)
    assert _until_waiting.status == 'booting'
    _until(world, 1000, lambda s: s.status == 'working')
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(
        world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'], waiting=True)
    world.supervisor.tick(1001)
    assert world.session().suspended

    def refuse(_vm: object) -> None:
        raise RuntimeError('the MicroVM did not answer')

    monkeypatch.setattr(world.runtime, 'resume', refuse)
    status, applied = world.supervisor.signal_detailed(RUN, 'fixer-1', 'save', 1002)['fixer-1']
    assert (status, applied, world.session().suspended) == ('working', False, True)


def test_a_spent_budget_asks_every_agent_to_pause_and_waits_for_a_person(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.control.spend = Budget(tokens=10, cost_usd=5.0, max_tokens=None, max_cost_usd=5.0)
    world.supervisor.tick(1001)
    assert world.session().status == 'pause_requested'
    assert world.control.humans == [('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'budget')]
    assert world.bus.kinds() == ['pause']


def test_under_a_spent_budget_agents_are_held_for_a_person_and_no_new_microvm_starts(world: World):
    world.launch(code='import sys; sys.exit(75)')
    world.control.spend = Budget(tokens=10, cost_usd=0.0, max_tokens=10, max_cost_usd=None)
    held = _until(world, 1000, lambda s: s.status == 'paused')
    assert held.continuation == 0
    assert ('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'budget') in world.control.humans
    with pytest.raises(RuntimeRefused, match='spent its budget'):
        world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'resume', 1001)


def test_once_the_budget_is_raised_resume_brings_a_held_agent_back(world: World):
    world.launch(code='import sys; sys.exit(75)')
    world.control.spend = Budget(tokens=10, cost_usd=0.0, max_tokens=10, max_cost_usd=None)
    _until(world, 1000, lambda s: s.status == 'paused')
    world.control.spend = Budget(tokens=10, cost_usd=0.0, max_tokens=100, max_cost_usd=None)
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, 'resume', 1001) == {'fixer-1': 'booting'}
    assert world.session().continuation == 1


def test_shut_down_during_an_eight_hour_pause_stops_the_agent_instead_of_continuing_it(world: World):
    world.launch(code=PAUSE_WHEN_ASKED)
    working = _until(world, 1000, lambda s: s.status == 'working')
    _until(world, 1000 + T.pause_after, lambda s: s.status == 'pause_requested')
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'shutdown', 1001 + T.pause_after) == {
        'fixer-1': 'pause_requested'}
    (Path(working.endpoint) / 'pause').write_text('x')
    stopped = _until(world, 1002 + T.pause_after, lambda s: s.status == 'stopped')
    assert stopped.continuation == 0


def test_a_failing_board_never_counts_against_a_healthy_microvm(world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code=SLEEP)
    working = _until(world, 1000, lambda s: s.status == 'working')

    def outage(_run_id: str, _task_id: str) -> None:
        raise ConnectionError('the board is down')

    monkeypatch.setattr(world.board, 'lease', outage)
    for now in range(1001, 1006):
        world.supervisor.tick(now)
    assert (world.session().status, world.session().failures, world.session().continuation) == ('working', 0, 0)
    assert world.session().claimed_until is None
    assert world.runtime.mint_token(working.vm).value


@pytest.mark.parametrize(('kind', 'status'), [('shutdown', 'stopped'), ('pause', 'paused')])
def test_shut_down_or_pause_on_an_agent_still_booting_takes_effect_at_once(world: World, kind: str, status: str):
    booting = world.launch(code=SLEEP)
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', None, kind, 1000) == {'fixer-1': status}
    with pytest.raises(RuntimeRefused, match='terminated'):
        world.runtime.mint_token(booting.vm)


def test_one_run_failing_does_not_keep_the_supervisor_from_the_others(world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code='pass')
    world.runs.start('01JD3R4NZXQ7Y2W8K4M6P9T0CD', caps=RunCaps(max_tasks=5), now=0)
    other = replace(world.session(), run_id='01JD3R4NZXQ7Y2W8K4M6P9T0CD', seq=0, claimed_until=None)
    world.store.create(other)
    real_budget = world.control.budget

    def budget(run_id: str) -> Budget:
        if run_id == '01JD3R4NZXQ7Y2W8K4M6P9T0AB':
            raise ConnectionError('run control is down')
        return real_budget(run_id)

    monkeypatch.setattr(world.control, 'budget', budget)
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0CD/task-1'] = world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1']
    world.supervisor.tick(1000)
    found = world.store.get('01JD3R4NZXQ7Y2W8K4M6P9T0CD', 'fixer-1')
    assert found is not None
    assert found.seq > 1


def test_a_signal_on_a_session_another_move_holds_answers_busy(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    world.store.claim(world.session(), 1001, 300)
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'stop_now', 1002) == {'fixer-1': 'busy'}
    assert world.session().status == 'working'


@pytest.mark.parametrize(('kind', 'status'), [('shutdown', 'stopped'), ('pause', 'paused')])
def test_shut_down_or_pause_on_an_agent_held_for_a_long_wait_decides_instead_of_the_wait(
        world: World, kind: str, status: str):
    working, lease = _on_an_open_wait(world, PAUSE_WHEN_ASKED)
    _until(world, 1001 + T.wait_suspend_limit, lambda s: s.status == 'pause_requested', progress=None)
    (Path(working.endpoint) / 'pause').write_text('x')
    _until(world, 1002 + T.wait_suspend_limit, lambda s: s.status == 'waiting', progress=None)
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', kind, 1003 + T.wait_suspend_limit) == {'fixer-1': status}
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(lease, waiting=False)
    world.supervisor.tick(1004 + T.wait_suspend_limit)
    assert (world.session().status, world.session().continuation) == (status, 0)


def test_resume_while_a_hold_is_still_pausing_continues_the_agent_once_it_has_paused(world: World):
    world.launch(code=PAUSE_WHEN_ASKED)
    working = _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'pause', 1001)
    assert world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'resume', 1002) == {'fixer-1': 'pause_requested'}
    (Path(working.endpoint) / 'pause').write_text('x')
    continued = _until(world, 1003, lambda s: s.continuation == 1)
    assert continued.status == 'booting'


def test_a_failure_after_a_save_in_the_same_move_still_releases_the_claim_and_counts(
        world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code=SLEEP)

    def down(_vm: object) -> None:
        raise ConnectionError('the runner is gone')

    monkeypatch.setattr(world.runtime, 'status', down)
    after_boot = _until(world, 1000, lambda s: s.failures >= 1)
    assert after_boot.claimed_until is None
    assert after_boot.status == 'working'


def test_a_session_claimed_by_another_move_is_left_alone(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    held = world.store.claim(world.session(), 1001, 300)
    world.supervisor.tick(1002)
    assert world.session() == held
    world.supervisor.tick(1001 + 301)
    assert world.session().claimed_until is None
    assert world.session().seq > held.seq


def test_one_failing_session_does_not_stop_the_others_and_a_gone_microvm_becomes_a_crash(world: World):
    world.launch(code='pass')
    broken = world.launch(agent_id='hunter-1', role='hunter', task_id='task-2', code=SLEEP)
    world.store.save(replace(broken, vm_id='gone', status='working', exec_id='x'))
    done = _until(world, 1000, lambda s: s.status == 'done')
    assert done.status == 'done'
    continued = _until(world, 1000, lambda s: s.continuation == 1, agent_id='hunter-1')
    assert (continued.vm_id != 'gone', continued.crashes, continued.failures) == (True, 1, 0)
    assert continued.inspect['last_failure'] == 'the MicroVM stopped answering'


def test_a_boot_that_takes_too_long_is_a_crash(world: World):
    world.launch(code=SLEEP)
    world.supervisor.checkout = lambda _commit, _paths: [
        Command(argv=(sys.executable, '-c', 'import time; time.sleep(60)'), timeout_seconds=600,
                repository_code=False)]
    world.supervisor.tick(1000)
    continued = _until(world, 1000 + T.boot_deadline, lambda s: s.continuation == 1)
    assert continued.inspect['last_failure'] == 'the boot took too long'


def test_a_long_open_wait_is_checkpointed_and_held_without_a_microvm_then_continued_when_it_closes(world: World):
    working, lease = _on_an_open_wait(world, PAUSE_WHEN_ASKED)
    assert world.session().suspended
    asked = _until(world, 1001 + T.wait_suspend_limit, lambda s: s.status == 'pause_requested', progress=None)
    assert (asked.after_pause, asked.suspended) == ('wait', False)
    (Path(working.endpoint) / 'pause').write_text('x')
    held = _until(world, 1002 + T.wait_suspend_limit, lambda s: s.status == 'waiting', progress=None)
    assert held.crashes == 0
    world.supervisor.tick(1000 + 2 * T.hard_stop)
    assert world.session().status == 'waiting'
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(lease, waiting=False)
    world.supervisor.tick(2000 + 2 * T.hard_stop)
    assert (world.session().status, world.session().continuation) == ('booting', 1)


def test_a_new_wait_is_held_45_minutes_after_its_own_start_not_the_last_ones(world: World):
    _, lease = _on_an_open_wait(world, SLEEP)
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(lease, waiting=False)
    world.supervisor.tick(1060)
    assert world.session().wait_since is None
    second = 1001 + T.wait_suspend_limit - 60
    world.board.leases['01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'] = replace(lease, waiting=True)
    world.supervisor.tick(second)
    # Past 45 minutes from the first wait's start, but not from its own.
    world.supervisor.tick(1001 + T.wait_suspend_limit + 60)
    assert (world.session().status, world.session().suspended) == ('working', True)
    world.supervisor.tick(second + T.wait_suspend_limit)
    assert world.session().status == 'pause_requested'


def test_save_on_a_suspended_agent_wakes_it_renews_its_session_and_saves(world: World):
    working, _ = _on_an_open_wait(world, SLEEP)
    calls = len(world.sts.calls)
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'save', 1001 + 20 * 60)
    assert world.session().suspended is False
    assert len(world.sts.calls) == calls + 1
    assert world.runtime.mint_token(working.vm).value


def test_a_lost_claim_on_a_continuation_ends_the_microvm_it_started(world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code='import sys; sys.exit(75)')
    started = []
    original_run = world.runtime.run

    def run(spec):
        started.append(original_run(spec))
        return started[-1]

    real_save = world.store.save

    def save(session):
        if session.continuation == 1:
            raise StaleSession('someone else moved it')
        return real_save(session)

    monkeypatch.setattr(world.runtime, 'run', run)
    monkeypatch.setattr(world.store, 'save', save)
    for now in range(1000, 1010):
        world.supervisor.tick(now)
        if started:
            break
        time.sleep(0.05)
    assert started
    with pytest.raises(RuntimeRefused, match='terminated'):
        world.runtime.mint_token(started[0])


def test_time_without_a_microvm_is_not_counted_as_microvm_seconds(world: World):
    world.launch(code=PAUSE_WHEN_ASKED)
    working = _until(world, 1000, lambda s: s.status == 'working')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'pause', 1060)
    (Path(working.endpoint) / 'pause').write_text('x')
    held = _until(world, 1120, lambda s: s.status == 'paused')
    world.supervisor.signal('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1', 'resume', 1120 + 86400)
    assert world.session().microvm_seconds == held.microvm_seconds


def test_run_health_reports_counts_and_spend(world: World):
    world.launch(code=SLEEP)
    world.supervisor.tick(1000)
    health = [event for event in world.bus.events if event['kind'] == 'run.health'][-1]
    assert health['summary'] == '1 booting'
    # No inbox backlog: the inbox has no read state (an agent reads after its cursor).
    assert health['refs'] == {'tokens': '0', 'cost_usd': '0.00'}


@pytest.mark.parametrize(('final', 'status'), [('done', 'done'), ('failed', 'failed'), ('needs_human', 'failed')])
def test_a_task_that_has_ended_ends_its_session_however_the_harness_exits(world: World, final: str, status: str):
    # A harness that crashes a moment after its task ended on the board.
    world.launch(code='import sys, time; time.sleep(0.5); sys.exit(1)')
    _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    world.board.leases[key] = replace(world.board.leases[key], final_state=final)
    for _ in range(200):
        world.supervisor.tick(1060)
        if world.session('fixer-1').status != 'working':
            break
        time.sleep(0.02)
    ended = world.session('fixer-1')
    # Its harness crashed after the task ended on the board: ended as the task did, never continued nor re-posted.
    assert (ended.status, ended.continuation, world.board.reposted) == (status, 0, [])


def test_a_harness_that_does_not_exit_after_its_task_ended_is_ended_at_the_hard_stop(world: World):
    working = _working_on_a_task_that(world, final_state='done')
    world.supervisor.tick(working.started_at + T.hard_stop)
    ended = world.session('fixer-1')
    assert (ended.status, ended.continuation, world.board.reposted) == ('done', 0, [])


def test_a_session_whose_own_repost_landed_posts_it_again_and_ends_never_continued(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    # Its re-post was written (open at the next attempt) but its publish failed: the session stayed live.
    world.board.leases[key] = Lease(task_id='task-1', agent_id='', renewed_at=0, last_progress_at=0, attempt=2)
    world.supervisor.tick(1060)
    ended = world.session('fixer-1')
    assert (ended.status, ended.continuation, world.board.reposted, world.board.attempts) == (
        'reposted', 0, [('01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1', 'reposted')], [1])


@pytest.mark.parametrize(('lease', 'status'), [
    ({'final_state': 'done'}, 'done'), ({'attempt': 2}, 'reposted'), ({'agent_id': 'fixer-2'}, 'reposted')])
def test_a_continuation_of_a_task_that_ended_or_moved_on_never_starts(world: World, lease: dict[str, object],
                                                                      status: str):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    held = world.supervisor._save(replace(world.session('fixer-1'), status='waiting'))  # held on a long wait
    world.board.leases[key] = replace(world.board.leases[key], **lease)
    ended = world.supervisor._continue(held, 1060, crashed=False)
    assert (ended.status, ended.continuation) == (status, 0)


def test_a_suspended_session_whose_task_ended_is_ended_at_once(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, lambda s: s.status == 'working')
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    suspended = world.supervisor._save(replace(world.session('fixer-1'), suspended=True))
    world.board.leases[key] = replace(world.board.leases[key], final_state='done')
    assert world.supervisor._task_ended(suspended, world.board.leases[key], 1060).status == 'done'


def test_a_continuation_refreshes_its_lease_before_its_microvm_starts(world: World):
    working = _working_on_a_task_that(world)
    before = len(world.board.refreshed)  # (its first harness started on a refreshed lease too)
    continued = world.supervisor._continue(working, 1060, crashed=False)
    assert (world.board.refreshed[before:], continued.continuation) == (
        [('01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1', 'fixer-1', 1)], 1)


def test_a_continuation_whose_lease_cannot_be_refreshed_ends_never_starting(world: World):
    working = _working_on_a_task_that(world)
    world.board.refreshes = False
    ended = world.supervisor._continue(working, 1060, crashed=False)
    assert (ended.status, ended.continuation) == ('reposted', 0)


def test_a_continuations_lease_is_refreshed_again_when_its_harness_starts(world: World):
    working = _working_on_a_task_that(world)
    before = len(world.board.refreshed)
    world.supervisor._continue(working, 1060, crashed=False)
    # Through its boot (the checkout, then the harness), a tick at a time.
    _until(world, 1120, lambda s: s.status == 'working')
    assert len(world.board.refreshed) - before == 2  # before its MicroVM started, and when its harness did


def test_a_continuation_whose_lease_is_refused_when_its_harness_starts_ends(world: World):
    working = _working_on_a_task_that(world)
    world.supervisor._continue(working, 1060, crashed=False)
    world.board.refreshes = False
    ended = _until(world, 1120, lambda s: s.status != 'booting')
    assert (ended.status, ended.exec_id) == ('reposted', None)


def test_a_booting_session_whose_task_ended_ends_as_the_task_did(world: World):
    working = _working_on_a_task_that(world)
    booting = world.supervisor._continue(working, 1060, crashed=False)
    key = '01JD3R4NZXQ7Y2W8K4M6P9T0AB/task-1'
    world.board.leases[key] = replace(world.board.leases[key], final_state='done')
    world.supervisor.tick(1120)
    assert (booting.status, world.session('fixer-1').status) == ('booting', 'done')
