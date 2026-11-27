"""The supervisor's 7.71.02 fixes from the first live Bug fixer run (01M83JQWMKAYK9GJB8FBAVZV7E): a run whose
coordinator finished its flow ends done (no code ended one before, so the run stayed active, the rule ticking, its
agent's lock held), a session that ends between two ticks still has its last tokens counted (the run counted about
half of its tokens), and a session's boot commands follow each other within one tick (each agent waited about four
minutes and twenty seconds before its harness started)."""
from __future__ import annotations

import re
import sys
import time
from dataclasses import replace
from decimal import Decimal
from typing import Any

import boto3
import pytest

from engineering.board.model import Task
from engineering.board.store import COORDINATE_TASK, BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import handler
from engineering.runtime.caps import SessionPricing, SessionRates, TokenPrice, TokenPrices
from engineering.runtime.interface import Command
from engineering.runtime.ports import Budget, Lease
from engineering.runtime.runs import FLOW_FINISHED, TableRunControl
from engineering.runtime.sessions import AgentSession
from engineering.runtime.supervisor import BOOT_WAIT_SECONDS, CLAIM_SECONDS, COORDINATOR_LAUNCH_SECONDS, Supervisor
from engineering.runtime.test.conftest import RUN, TABLE, World
from engineering.runtime.test.test_engineering_images import DATALAKE
from engineering.runtime.test.test_engineering_runtime_handler import (
    COORDINATED,
    COORDINATOR_AGENT,
    OTHER_RUN,
    RESUME,
    _Context,
    _handing_on,
    _recording,
    _runs,
)

COORDINATE = f'{RUN}/coordinate'
#: A harness that reports its tokens the way the real one does, a moment after it starts (never before the tick that
#: starts it has read its status), then exits at once: its session ends between two ticks.
REPORTS_AND_EXITS = ('import json, os, time\n'
                     'time.sleep(0.5)\n'
                     'os.makedirs("../home/.voc", exist_ok=True)\n'
                     'json.dump({"step": "finished", "recent_tools": ["finish"],'
                     ' "tokens": {"model-a": {"in": 15000, "out": 2000}}}, open("../home/.voc/status.json", "w"))\n')


def _coordinator_finished(world: World, *, task_ended: str = 'done') -> AgentSession:
    """The run's coordinator, its harness exited after its ``finish`` (its session ended done by the tick that saw
    it) and its coordinate task ended ``task_ended``."""
    world.launch(agent_id='coordinator-1', role='coordinator', task_id='coordinate', code='pass')
    for _ in range(300):
        world.supervisor.tick(1000)
        if world.session('coordinator-1').status == 'done':
            break
        time.sleep(0.02)
    world.board.leases[COORDINATE] = replace(world.board.leases[COORDINATE], final_state=task_ended)
    return world.session('coordinator-1')


def test_a_finished_coordinator_on_a_finished_flow_ends_the_run_done_at_the_next_tick(world: World):
    world.control.finished_flows.add(RUN)
    assert _coordinator_finished(world).status == 'done'
    # (the tick that ended its session read it working: nothing was ended then)
    assert world.control.ended == set()
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == ({RUN}, [])
    world.supervisor.tick(1120)   # (ended once: the run is no longer active)
    assert world.control.ended == {RUN}


def test_a_coordinator_that_finished_on_a_flow_at_a_person_sends_the_run_to_that_decision_point(world: World):
    # (7.71.04) The live Bug fixer run's coordinator finished with its flow waiting at the commit step: the run goes to
    # that step's decision point, where a person's Resume decides the step and tries it again, not the coordinator's.
    assert _coordinator_finished(world).status == 'done'
    world.control.flow_points[RUN] = 'flow:commit'   # (its committer's task ended at a person meanwhile)
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == (set(), [(RUN, 'flow:commit')])


def test_a_resume_since_the_coordinator_finished_waits_for_its_next_coordinator_launch(world: World):
    # (Q1, 7.71.04) A person resumed the run after its coordinator finished, and the Resume handed its launch on (a
    # fill first): the tick leaves the run alone while that launch may still come, and asks a person once it is late.
    assert _coordinator_finished(world).status == 'done'
    world.control.awaited[RUN] = 1030
    world.supervisor.tick(1060)
    world.supervisor.tick(1030 + COORDINATOR_LAUNCH_SECONDS)
    assert (world.control.ended, world.control.humans) == (set(), [])
    world.supervisor.tick(1031 + COORDINATOR_LAUNCH_SECONDS)
    assert (world.control.ended, world.control.humans) == (set(), [(RUN, 'coordinator')])


def _coordinator_finished_through_the_handler(finished: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    """voc-engineering-runtime's own wiring: a run whose coordinator claimed its coordinate task, finished it (done)
    and whose session ended done, its flow finished or not as the conductor would say (``finished``: the conductor's
    side is the flow's tests' and the Bug hunt's end to end); the run still active."""
    handler.lambda_handler(COORDINATED, None)
    board = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: 'unused')
    board.claim(WORKSPACE, OTHER_RUN, COORDINATE_TASK, role='coordinator', agent=COORDINATOR_AGENT)
    for state in ('in_progress', 'done'):
        board.move(WORKSPACE, OTHER_RUN, COORDINATE_TASK, agent=COORDINATOR_AGENT, epoch=1, to_state=state,
                   result_keys=())
    sessions = handler._supervisor().sessions
    session = sessions.get(OTHER_RUN, COORDINATOR_AGENT)
    assert session is not None
    sessions.save(replace(session, status='done', exec_id=None))
    monkeypatch.setattr(TableRunControl, 'flow_finished', lambda _control, _run_id: finished)


def _finished_through_the_handler(finished: bool, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """``_coordinator_finished_through_the_handler``, then one tick: what the tick handed on."""
    _coordinator_finished_through_the_handler(finished, monkeypatch)
    calls = _handing_on(monkeypatch)
    handler.lambda_handler({'action': 'tick'}, _Context())
    return calls


@pytest.mark.parametrize(('resumed', 'reopened'), [(None, False), (-3600, False), (60, True)],
                         ids=['never-resumed', 'resumed-before-it-finished', 'resumed-since'])
def test_only_a_launch_after_a_resume_since_the_coordinator_finished_reopens_its_coordinate_task(
        wired: Any, monkeypatch: pytest.MonkeyPatch, resumed: int | None, reopened: bool):
    # (F3, 7.104.00) A coordinate task done on a flow that did not finish is reopened only once a person resumed the run
    # after it ended: the run's ``resumed_at``, whoever launches (here the fill's launch_coordinator, as a Resume's
    # hand-on, a start's retry or a board launch's fill carries it on). 7.71.04 carried a ``resumed`` flag on the
    # launch event for it instead, which an event handed on before the deploy lacked.
    assert wired is not None
    _coordinator_finished_through_the_handler(False, monkeypatch)
    if resumed is not None:
        _runs().needs_human(OTHER_RUN, 'coordinator', now=int(time.time()))
        _runs().resume(OTHER_RUN, now=int(time.time()) + resumed, actor='admin-1')
    _runtime, started = _recording(monkeypatch)
    handler.launch_coordinator({'run_id': OTHER_RUN, 'actor': 'admin-1', 'filled': True})
    task = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE,
                      new_id=lambda: 'unused').task(WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    assert (task.state, task.attempt, [vm.agent_id for vm in started]) == (
        ('open', 2, ['coordinator-2']) if reopened else ('done', 1, []))


def test_the_tick_after_a_coordinator_finished_its_flow_ends_the_run_done_and_settling_releases_it(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    calls = _finished_through_the_handler(True, monkeypatch)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    # Ended done by the supervisor (its RUNLOG row says why), released with its retrospective handed on; the other
    # run still listed keeps the rule on.
    assert (run.status, OTHER_RUN in _runs().listed(), RUN in _runs().listed()) == ('done', False, True)
    assert ('voc-engineering-runtime', {'action': 'retrospective', 'run_id': OTHER_RUN}) in calls
    [ended] = [row for row in _runs().typed_rows(OTHER_RUN, 'RUNLOG#') if row.get('status', {}).get('S') == 'done']
    assert (ended['actor']['S'], ended['reason']['S']) == ('supervisor', FLOW_FINISHED)


def test_the_tick_after_a_coordinator_finished_on_a_flow_that_did_not_sends_the_run_to_a_person(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _finished_through_the_handler(False, monkeypatch)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert (run.status, run.waiting_at, OTHER_RUN in _runs().listed()) == ('needs_human', 'coordinator', True)


def _resumed(monkeypatch: pytest.MonkeyPatch, *, finished: bool) -> tuple[BoardStore, Task, list[str]]:
    """A person's Resume of the run its coordinator finished on a flow that did not (sent to a person), its flow read
    as ``finished`` by then: the board, the coordinate task after it, and the agents it started."""
    _finished_through_the_handler(False, monkeypatch)
    if finished:
        monkeypatch.setattr(TableRunControl, 'flow_finished', lambda _control, _run_id: True)
    _runtime, started = _recording(monkeypatch)
    handler.lambda_handler(RESUME, None)
    board = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: 'unused')
    return board, board.task(WORKSPACE, OTHER_RUN, COORDINATE_TASK), [vm.agent_id for vm in started]


def test_a_resume_after_a_coordinator_finished_on_a_flow_that_did_not_starts_a_new_coordinator(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    # (7.71.03) The run went to a person (coordinator) with its coordinate task done: a person's Resume reopens the task
    # at the next attempt for a new coordinator, so the run is planned again instead of going straight back to them.
    assert wired is not None
    board, task, started = _resumed(monkeypatch, finished=False)
    assert (task.state, task.attempt, task.lease_agent, task.launched_agent, task.launched_attempt) == (
        'open', 2, '', 'coordinator-2', 2)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert (run.status, started) == ('active', ['coordinator-2'])
    moves = board.history(WORKSPACE, OTHER_RUN)[COORDINATE_TASK]
    assert sorted((move.op, move.attempt) for move in moves if move.actor == 'admin-1') == [('launch', 2), ('repost', 2)]
    # A retried reopen finds the task open at the next attempt and changes nothing (7.71.04: the store's re-post).
    assert board.repost(WORKSPACE, OTHER_RUN, COORDINATE_TASK, attempt=1, actor='admin-1', reason='again',
                        reopen=True) == task


def test_a_resume_reopens_no_coordinate_task_whose_flow_finished(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _board, task, started = _resumed(monkeypatch, finished=True)
    assert (task.state, task.attempt, started) == ('done', 1, [])


def test_a_coordinator_that_finished_on_a_flow_that_did_not_sends_the_run_to_a_person_at_the_next_tick(world: World):
    # (7.71.04: no 90 s wait for the flow first; its started run's own launch window is long over by then)
    world.control.awaited[RUN] = 0
    _coordinator_finished(world)
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == (set(), [(RUN, 'coordinator')])


def test_nothing_ends_while_an_agent_of_the_run_still_works_or_the_coordinate_task_did_not_end_done(world: World):
    world.control.finished_flows.add(RUN)
    _coordinator_finished(world)
    world.launch(code='import time; time.sleep(60)')
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == (set(), [])
    world.store.save(replace(world.session(), status='done', exec_id=None))
    # A coordinate task that went to a person, or another attempt's coordinator: never ended by the tick.
    for lease in (replace(world.board.leases[COORDINATE], final_state='needs_human'),
                  replace(world.board.leases[COORDINATE], attempt=2)):
        world.board.leases[COORDINATE] = lease
        world.supervisor.tick(1120)
        assert (world.control.ended, world.control.humans) == (set(), [])
    # Nor a run that is not active (stopped, or at a decision point already).
    world.board.leases[COORDINATE] = replace(world.board.leases[COORDINATE], attempt=1, final_state='done')
    world.control.stops.add(RUN)
    world.supervisor.tick(1180)
    assert world.control.ended == set()


def test_a_session_that_ends_between_two_ticks_still_has_its_tokens_and_cost_counted(world: World,
                                                                                      monkeypatch: pytest.MonkeyPatch):
    # (its tokens priced alone: its session's time unpriced)
    world.store.pricing = SessionPricing(rates=SessionRates(Decimal(0), Decimal(0), Decimal(0), Decimal(0)),
                                         tokens=TokenPrices(prices={'model-a': TokenPrice(Decimal(3), Decimal(15))}))

    def spent(run_id: str) -> Budget:   # (the caps' own source, as TableRunControl reads it)
        tokens, cost = world.runs.spend(run_id)
        return Budget(tokens=tokens, cost_usd=cost, max_tokens=None, max_cost_usd=None)

    monkeypatch.setattr(world.control, 'budget', spent)
    session = world.launch(code=REPORTS_AND_EXITS)
    for _ in range(300):
        world.supervisor.tick(1000)
        if world.session().status == 'working':
            break
    started = world.session()
    assert (started.status, started.tokens) == ('working', {})   # (read before the harness reported anything)
    for _ in range(1500):   # its harness reports, and exits before the next tick
        if world.runtime.poll_exec(session.vm, str(started.exec_id)) is not None:
            break
        time.sleep(0.02)
    world.supervisor.tick(1060)
    ended = world.session()
    # Its last report is read before its session ends: the run's spend, which its caps and health message read,
    # has every token, priced (3 USD a million in, 15 out).
    assert (ended.status, ended.tokens) == ('done', {'model-a': {'in': 15000, 'out': 2000}})
    assert world.runs.spend(RUN) == (17000, float(Decimal('0.045') + Decimal('0.03')))
    # (7.71.03) The tick's health, its last for the run, has them too: the spend is read again after the moves (the
    # first live rerun's last health said 405,193 tokens of the agents' 491,208).
    [*_, health] = [event for event in world.bus.events if event['kind'] == 'run.health']
    assert (health['summary'], health['refs']) == ('1 done', {'tokens': '17000', 'cost_usd': f'{0.075:.2f}'})


def _working(world: World) -> None:
    world.launch(code='import time; time.sleep(60)')
    for _ in range(300):
        world.supervisor.tick(1000)
        if world.session().status == 'working':
            return
        time.sleep(0.02)
    raise AssertionError('the agent never worked')


@pytest.mark.parametrize(('point', 'said'), [
    ('budget', 'The run reached its budget: checkpoint and pause.'),
    ('flow:commit', 'The run waits for a person to decide at flow:commit: checkpoint and pause.'),
])
def test_a_held_agent_is_told_why_the_run_waits_for_a_person(world: World, point: str, said: str):
    # (7.71.03) Every hold said the budget, the first live rerun's at its flow's commit step too.
    _working(world)
    if point == 'budget':
        world.control.spend = Budget(tokens=10, cost_usd=5.0, max_tokens=None, max_cost_usd=5.0)
    else:
        world.control.flow_points[RUN] = point
    world.supervisor.tick(1060)
    [pause] = [event for event in world.bus.events if event['kind'] == 'pause']
    assert (pause['summary'], world.session().status, world.control.humans) == (
        said, 'pause_requested', [(RUN, point)])


def test_a_session_whose_task_went_to_a_person_ends_needs_human_never_failed(world: World):
    # (7.71.03) The first live rerun's health read "1 done, 1 failed" for a run that stopped for a person.
    world.launch(code='import time; time.sleep(60)')
    world.board.leases[f'{RUN}/task-1'] = Lease(task_id='task-1', agent_id='', renewed_at=0, last_progress_at=0,
                                                attempt=1, final_state='needs_human')
    world.supervisor.tick(1000)
    [*_, health] = [event for event in world.bus.events if event['kind'] == 'run.health']
    assert (world.session().status, health['summary']) == ('needs_human', '1 needs_human')


def test_the_handlers_supervisor_has_the_production_boot_wait_well_inside_its_claim_and_its_timeout(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    # (7.71.03) Every other test's supervisor waits for no boot (conftest's QuickSupervisor): this one is built as
    # voc-engineering-runtime builds it, and its 40 s is pinned against the claim a tick moves sessions under and the
    # function's own timeout (lib/stacks/engineering-runtime.ts), which a tick's boot wait must leave room in.
    assert wired is not None
    monkeypatch.setattr(handler, 'Supervisor', Supervisor)
    monkeypatch.setattr(handler, '_supervisor_cache', None)
    assert handler._supervisor().boot_wait == BOOT_WAIT_SECONDS
    stack = (DATALAKE / 'lib' / 'stacks' / 'engineering-runtime.ts').read_text()
    [minutes] = re.findall(r"handler: 'engineering/runtime/handler\.lambda_handler',[^}]*?"
                           r'timeout: cdk\.Duration\.minutes\((\d+)\)', stack, re.DOTALL)
    assert int(minutes) * 60 == CLAIM_SECONDS
    # Well under both: a quarter of the claim at most, and inside the rule's one-minute tick.
    assert (BOOT_WAIT_SECONDS * 4 <= CLAIM_SECONDS, BOOT_WAIT_SECONDS < 60) == (True, True)


def _checkout(*steps: str) -> list[Command]:
    """Boot commands that each run ``python -c <step>``."""
    return [Command(argv=(sys.executable, '-c', step), timeout_seconds=30, repository_code=False) for step in steps]


def _chained(world: World) -> None:
    """A boot wait for a test of boot commands chained within one tick (the world's supervisor has none), its polls
    50 ms apart rather than a second."""
    world.supervisor.boot_wait = 10.0
    world.supervisor.sleep = lambda _seconds: time.sleep(0.05)


def test_a_sessions_checkout_commands_follow_each_other_within_one_tick_then_its_harness_starts(world: World):
    _chained(world)
    world.supervisor.checkout = lambda *_: _checkout("open('one', 'w')", "open('two', 'w')", "open('three', 'w')")
    world.launch(code="import os; assert all(map(os.path.exists, ('one', 'two', 'three')))")
    world.supervisor.tick(1000)
    working = world.session()
    assert (working.status, working.boot_index, working.harness_at) == ('working', 3, 1000)


def test_with_no_boot_wait_each_checkout_command_waits_for_the_next_tick(world: World):
    world.supervisor.boot_wait = 0
    world.supervisor.checkout = lambda *_: _checkout("open('one', 'w')", "open('two', 'w')")
    world.launch()
    world.supervisor.tick(1000)
    assert (world.session().status, world.session().boot_index) == ('booting', 0)


@pytest.mark.timing
def test_a_tick_waits_for_a_boot_only_as_long_as_its_boot_wait(world: World):
    world.supervisor.boot_wait = 1.5
    world.supervisor.checkout = lambda *_: _checkout('import time; time.sleep(30)', "open('two', 'w')")
    world.launch()
    started = time.monotonic()
    world.supervisor.tick(1000)
    booting = world.session()
    assert time.monotonic() - started < 10
    assert (booting.status, booting.boot_index, booting.exec_id is not None) == ('booting', 0, True)


def test_a_checkout_command_that_fails_within_the_tick_still_ends_the_agent_failed(world: World):
    _chained(world)
    world.supervisor.checkout = lambda *_: _checkout("open('one', 'w')", 'import sys; sys.exit(128)', 'pass')
    world.launch()
    world.supervisor.tick(1000)
    failed = world.session()
    assert (failed.status, failed.boot_index, failed.inspect['last_exit']['exit_code']) == ('failed', 1, 128)
    assert failed.inspect['last_failure'].startswith('The repository checkout failed (python')
    assert world.control.humans == [(RUN, 'checkout_failed')]
