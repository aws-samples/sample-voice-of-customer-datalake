"""A person's Stop of a whole run (7.50.03, ``runtime/stop.py``): it always ends the run, a run with no session at all
included, through voc-engineering-start (the Agents API's door) or the runtime's own signal; it closes the run's
tasks, runs out its launch holds and ends its sessions; a Stop whose agents have sessions lets them save first and
ends the run once they have, or at its grace. On moto and the local fake, as the handler is wired."""
from dataclasses import replace
from typing import Any

import boto3
import pytest

from engineering.board.store import COORDINATE_TASK, STOP_OP, BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import handler
from engineering.runtime import supervisor as supervisor_module
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunNotActive, RunStore, run_pk
from engineering.runtime.stop import STOP_GRACE_SECONDS
from engineering.runtime.test.conftest import COMMIT, SCHEDULE, TABLE
from engineering.runtime.test.local_runtime import LocalAgentRuntime
from shared import aws as shared_aws

#: The stuck run's shape: a start whose coordinator launch was handed on and never got a session.
STUCK = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
COORDINATOR_AGENT = 'coordinator-1'
COORDINATED = {'action': 'start_run', 'run_id': STUCK, 'max_tasks': 5, 'goal': 'fix the parser',
               'connection': 'conn-1', 'commit': COMMIT, 'language': 'python'}
FIXER_LAUNCH = {'action': 'launch', 'run_id': STUCK, 'agent_id': 'fixer-2', 'role': 'fixer', 'task_id': 'task-1',
                'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src']}
ADMIN = 'admin-sub'


def _runs() -> RunStore:
    return RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE))


def _board() -> BoardStore:
    return BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: 'x')


def _rows(prefix: str) -> list[dict[str, Any]]:
    return boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues={':pk': run_pk(STUCK), ':p': prefix})['Items']


def _handed_on(monkeypatch: pytest.MonkeyPatch, *, fails: bool = False) -> list[dict[str, Any]]:
    """Every invocation the start function hands on to voc-engineering-runtime, kept, not run (``fails``: refused)."""
    handed: list[dict[str, Any]] = []
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')

    def invoke(name: str, payload: dict[str, Any]) -> None:
        if fails:
            raise RuntimeError('Lambda is unavailable')
        assert name == 'voc-engineering-runtime'
        handed.append(payload)

    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', invoke)
    return handed


def _stuck(monkeypatch: pytest.MonkeyPatch) -> int:
    """The live run 01M7KVTD…'s state: started, its coordinator's launch handed on and run out without a session
    (``launching_until`` 0), its coordinate task open with ``launched_agent`` recorded, then sent to a person by the
    tick (``needs_human`` = coordinator). When it started."""
    monkeypatch.setattr(handler, '_hand_on_launch', lambda _run_id, _actor: None)
    handler.start_handler({**COORDINATED, 'actor': ADMIN}, None)
    started = _runs().get(STUCK)
    assert started is not None
    sessions = handler._supervisor().sessions
    sessions.hold_launch(STUCK, COORDINATOR_AGENT, started.started_at)
    sessions.release_launch(STUCK, COORDINATOR_AGENT)
    _board().launch_coordinator(WORKSPACE, STUCK, attempt=1, actor=ADMIN)
    monkeypatch.setattr(handler, 'clock', lambda: float(started.started_at + supervisor_module.COORDINATOR_LAUNCH_SECONDS
                                                         + 60))
    handler.lambda_handler({'action': 'tick'}, None)
    run = _runs().get(STUCK)
    assert run is not None
    assert (run.status, run.waiting_at, handler._supervisor().sessions.of_run(STUCK)) == ('needs_human', 'coordinator',
                                                                                         [])
    return started.started_at


def _stop(mode: str = 'stop', actor: str = ADMIN) -> dict[str, Any]:
    return handler.start_handler({'action': 'stop_run', 'run_id': STUCK, 'actor': actor, 'mode': mode}, None)


@pytest.mark.parametrize('mode', ['stop', 'stop_now'])
def test_a_stop_of_a_run_whose_coordinator_never_started_ends_it(wired: Any, monkeypatch: pytest.MonkeyPatch,
                                                                  mode: str):
    """The bug of 7.50.03: a Stop of a run at a person with no session did nothing; now it ends the run, at once."""
    _stuck(monkeypatch)
    handed = _handed_on(monkeypatch)
    answer = _stop(mode)
    assert (answer['status'], answer['mode'], answer['tasks_closed'], answer['already']) == (
        'stopped', mode, [COORDINATE_TASK], False)
    run = _runs().get(STUCK)
    assert run is not None
    assert run.status == 'stopped'
    # Audited (D4): its RUNLOG row names the person and how they stopped it.
    (log,) = [row for row in _rows('RUNLOG#') if row['status'] == 'stopped']
    assert (log['actor'], 'run monitor' in log['reason']) == (ADMIN, True)
    # Its open task is closed under a `stop` history row naming the person; no agent may move it any more.
    task = _board().task(WORKSPACE, STUCK, COORDINATE_TASK)
    assert (task.state, task.lease_agent, task.updated_op) == ('failed', '', STOP_OP)
    (closing,) = [row for row in _rows(f'TASKLOG#{COORDINATE_TASK}#') if row['op'] == STOP_OP]
    assert closing['actor'] == f'human:{ADMIN}'
    # The rest of its end (its sessions, its release) is handed on to the runtime's finish_stop (its end_run as
    # stopped), which a run with none finishes at once: no longer listed.
    assert handed == [{'action': 'finish_stop', 'run_id': STUCK, 'actor': ADMIN, 'reason': log['reason']}]
    assert handler.lambda_handler(handed[0], None)['status'] == 'stopped'
    # (the fixture's own run is still live, so the rule stays on for it)
    assert (STUCK in _runs().listed(), wired.describe_rule(Name=SCHEDULE)['State']) == (False, 'ENABLED')


@pytest.mark.parametrize('status', ['done', 'failed', 'stopped'])
def test_a_stop_of_an_ended_run_changes_nothing_and_says_how_it_ended(wired: Any, monkeypatch: pytest.MonkeyPatch,
                                                                      status: str):
    assert wired is not None
    _stuck(monkeypatch)
    _runs().end(STUCK, status, now=int(handler.clock()), actor='someone-else')
    _handed_on(monkeypatch)
    answer = _stop()
    run = _runs().get(STUCK)
    assert run is not None
    assert (answer['status'], answer['already'], run.status) == (status, True, status)
    assert [row['actor'] for row in _rows('RUNLOG#') if row['status'] in ('done', 'failed', 'stopped')] == [
        'someone-else']


def test_a_stop_of_an_active_run_with_no_session_ends_it_too(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    monkeypatch.setattr(handler, '_hand_on_launch', lambda _run_id, _actor: None)
    handler.start_handler(COORDINATED, None)   # (active: its launch still on its way)
    hold = handler._supervisor().sessions
    hold.hold_launch(STUCK, COORDINATOR_AGENT, int(handler.clock()))
    _handed_on(monkeypatch)
    answer = _stop()
    # Its live launch hold is run out: the launch still under way finds the run ended and stops its session.
    assert (answer['status'], answer['holds_released']) == ('stopped', [COORDINATOR_AGENT])
    assert hold.of_run_with_holds(STUCK)[1] == {COORDINATOR_AGENT: 0}
    with pytest.raises(RunNotActive):
        handler.lambda_handler({**FIXER_LAUNCH, 'agent_id': 'fixer-9'}, None)


def test_a_retried_stop_closes_nothing_twice(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _stuck(monkeypatch)
    _handed_on(monkeypatch)
    _stop('stop_now')
    again = _stop('stop_now')
    assert (again['status'], again['already'], again['tasks_closed']) == ('stopped', True, [])
    assert len([row for row in _rows(f'TASKLOG#{COORDINATE_TASK}#') if row['op'] == STOP_OP]) == 1


def _working_fixer(monkeypatch: pytest.MonkeyPatch) -> None:
    """The stuck run resumed, its fixer launched and working (a session to save)."""
    _stuck(monkeypatch)
    _runs().resume(STUCK, now=int(handler.clock()), actor=ADMIN)
    handler.lambda_handler(FIXER_LAUNCH, None)
    sessions = handler._supervisor().sessions
    fixer = sessions.get(STUCK, 'fixer-2')
    assert fixer is not None
    sessions.save(replace(fixer, status='working', exec_id='exec-1'))


def test_a_stop_with_an_agent_at_work_lets_it_save_then_ends_the_run(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    handed = _handed_on(monkeypatch)
    answer = _stop()
    assert (answer['status'], answer['saving']) == ('stopping', ['fixer-2'])
    run = _runs().get(STUCK)
    assert run is not None
    assert (run.status, run.stopping, run.stop_mode, run.stop_requested_by) == ('active', True, 'stop', ADMIN)
    # The agents' save is the runtime's (the start function has no session): handed on, then run there.
    assert handed == [{'action': 'stop_run', 'run_id': STUCK, 'actor': ADMIN}]
    saving = handler.lambda_handler(handed[0], None)
    fixer = handler._supervisor().sessions.get(STUCK, 'fixer-2')
    assert fixer is not None
    assert (saving['status'], fixer.status, fixer.after_pause) == ('stopping', 'pause_requested', 'shutdown')
    # While it stops: no Resume, no new agent.
    with pytest.raises(RuntimeRefused, match='being stopped'):
        handler.lambda_handler({'action': 'signal', 'run_id': STUCK, 'signal': 'resume', 'actor': ADMIN}, None)
    with pytest.raises(RunNotActive):
        handler.lambda_handler({**FIXER_LAUNCH, 'agent_id': 'fixer-3'}, None)
    # Its agent saved and stopped: the next tick ends the run, as the person who asked.
    handler._supervisor().sessions.save(replace(fixer, status='stopped', exec_id=None))
    handler.lambda_handler({'action': 'tick'}, None)
    ended = _runs().get(STUCK)
    assert ended is not None
    assert ended.status == 'stopped'
    (log,) = [row for row in _rows('RUNLOG#') if row['status'] == 'stopped']
    assert (log['actor'], log['reason']) == (ADMIN, 'stopped from the run monitor once its agents had saved')


def test_an_agent_that_never_saves_is_stopped_at_the_grace(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    _handed_on(monkeypatch)
    _stop()
    run = _runs().get(STUCK)
    assert run is not None
    monkeypatch.setattr(handler, '_supervisor_cache', handler._supervisor())
    stuck_save = run.stop_requested_at + STOP_GRACE_SECONDS
    # (the supervisor's own tick is left out: the fixer stays pausing, as one whose checkpoint never comes)
    monkeypatch.setattr(handler._supervisor(), 'tick', lambda _now: {})
    monkeypatch.setattr(handler, 'clock', lambda: float(stuck_save - 60))
    handler.lambda_handler({'action': 'tick'}, None)
    waiting = _runs().get(STUCK)
    assert waiting is not None
    assert waiting.status == 'active'   # (within its grace)
    monkeypatch.setattr(handler, 'clock', lambda: float(stuck_save))
    handler.lambda_handler({'action': 'tick'}, None)
    ended = _runs().get(STUCK)
    fixer = handler._supervisor().sessions.get(STUCK, 'fixer-2')
    assert ended is not None
    assert fixer is not None
    assert (ended.status, fixer.status) == ('stopped', 'stopped')
    (log,) = [row for row in _rows('RUNLOG#') if row['status'] == 'stopped']
    assert 'grace' in log['reason']


def test_a_stop_now_with_an_agent_at_work_ends_its_session_at_once(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    vm = handler._supervisor().sessions.get(STUCK, 'fixer-2')
    assert vm is not None
    # The runtime's own signal path (a deployment that wires the monitor to it): a whole run's Stop now is its Stop.
    answer = handler.lambda_handler({'action': 'signal', 'run_id': STUCK, 'signal': 'stop_now', 'actor': ADMIN}, None)
    assert (answer['agents'], answer['run']['status']) == ({'fixer-2': 'stopped'}, 'stopped')
    runtime = handler._supervisor().runtime
    assert isinstance(runtime, LocalAgentRuntime)
    assert runtime.state_of(vm.vm) == 'terminated'
    run = _runs().get(STUCK)
    assert run is not None
    assert run.status == 'stopped'


def test_a_whole_run_shut_down_signal_ends_a_run_with_no_session(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _stuck(monkeypatch)
    answer = handler.lambda_handler({'action': 'signal', 'run_id': STUCK, 'signal': 'shutdown', 'actor': ADMIN}, None)
    run = _runs().get(STUCK)
    assert run is not None
    assert (answer['run']['status'], run.status) == ('stopped', 'stopped')
    # (released by the next tick, which settles it: the signal's path never switches the rule)
    handler.lambda_handler({'action': 'tick'}, None)
    assert STUCK not in _runs().listed()


def test_a_stop_whose_save_cannot_be_handed_on_stops_the_run_at_once(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    _handed_on(monkeypatch, fails=True)
    answer = _stop()
    run = _runs().get(STUCK)
    assert run is not None
    # Never left running: the agents could not be asked to save, so it is a Stop now (the tick ends the sessions).
    assert (answer['status'], answer['fell_back'], run.status) == ('stopped', True, 'stopped')


@pytest.mark.parametrize(('event', 'says'), [
    ({'mode': 'stop'}, 'names the person'),
    ({'actor': ADMIN, 'mode': 'halt'}, 'a stop is one of'),
    ({'actor': ADMIN, 'mode': 'stop', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0ZZ'}, 'no run'),
])
def test_the_start_function_refuses_a_bad_stop(wired: Any, monkeypatch: pytest.MonkeyPatch, event: dict[str, Any],
                                               says: str):
    assert wired is not None
    _handed_on(monkeypatch)
    with pytest.raises(RuntimeRefused, match=says):
        handler.start_handler({'action': 'stop_run', 'run_id': STUCK, **event}, None)
