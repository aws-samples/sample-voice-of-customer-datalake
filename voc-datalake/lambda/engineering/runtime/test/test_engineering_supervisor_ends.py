"""The supervisor's 7.71.02 fixes from the first live Bug fixer run (01M83JQWMKAYK9GJB8FBAVZV7E): a run whose
coordinator finished its flow ends done (no code ended one before, so the run stayed active, the rule ticking, its
agent's lock held), a session that ends between two ticks still has its last tokens counted (the run counted about
half of its tokens), and a session's boot commands follow each other within one tick (each agent waited about four
minutes and twenty seconds before its harness started)."""
from __future__ import annotations

import sys
import time
from dataclasses import replace
from decimal import Decimal
from typing import Any

import boto3
import pytest

from engineering.board.store import COORDINATE_TASK, BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import handler
from engineering.runtime.caps import SessionPricing, SessionRates, TokenPrice, TokenPrices
from engineering.runtime.interface import Command
from engineering.runtime.runs import FLOW_FINISHED, TableRunControl
from engineering.runtime.sessions import AgentSession
from engineering.runtime.test.conftest import RUN, TABLE, World
from engineering.runtime.test.test_engineering_runtime_handler import (
    COORDINATED,
    COORDINATOR_AGENT,
    OTHER_RUN,
    _Context,
    _handing_on,
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
    assert world.control.ended == {}
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == ({RUN: 'done'}, [])
    world.supervisor.tick(1120)   # (ended once: the run is no longer active)
    assert world.control.ended == {RUN: 'done'}


def _finished_through_the_handler(finished: bool, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """voc-engineering-runtime's own wiring: a run whose coordinator claimed its coordinate task, finished it (done)
    and whose session ended done, its flow finished or not as the conductor would say (``finished``: the conductor's
    side is the flow's tests' and the Bug hunt's end to end); then one tick. What the tick handed on."""
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
    calls = _handing_on(monkeypatch)
    handler.lambda_handler({'action': 'tick'}, _Context())
    return calls


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


def test_a_coordinator_that_finished_on_a_flow_that_did_not_goes_to_a_person(world: World):
    _coordinator_finished(world)
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == ({}, [(RUN, 'coordinator')])


def test_nothing_ends_while_an_agent_of_the_run_still_works_or_the_coordinate_task_did_not_end_done(world: World):
    world.control.finished_flows.add(RUN)
    _coordinator_finished(world)
    world.launch(code='import time; time.sleep(60)')
    world.supervisor.tick(1060)
    assert (world.control.ended, world.control.humans) == ({}, [])
    world.store.save(replace(world.session(), status='done', exec_id=None))
    # A coordinate task that went to a person, or another attempt's coordinator: never ended by the tick.
    for lease in (replace(world.board.leases[COORDINATE], final_state='needs_human'),
                  replace(world.board.leases[COORDINATE], attempt=2)):
        world.board.leases[COORDINATE] = lease
        world.supervisor.tick(1120)
        assert (world.control.ended, world.control.humans) == ({}, [])
    # Nor a run that is not active (stopped, or at a decision point already).
    world.board.leases[COORDINATE] = replace(world.board.leases[COORDINATE], attempt=1, final_state='done')
    world.control.stops.add(RUN)
    world.supervisor.tick(1180)
    assert world.control.ended == {}


def test_a_session_that_ends_between_two_ticks_still_has_its_tokens_and_cost_counted(world: World):
    # (its tokens priced alone: its session's time unpriced)
    world.store.pricing = SessionPricing(rates=SessionRates(Decimal(0), Decimal(0), Decimal(0), Decimal(0)),
                                         tokens=TokenPrices(prices={'model-a': TokenPrice(Decimal(3), Decimal(15))}))
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
