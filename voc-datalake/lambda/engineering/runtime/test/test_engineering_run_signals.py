"""A person's signals through voc-engineering-start (7.51.02, ``runtime/run_signals.py``): the run workspace's Pause,
Resume and Save of the whole run, and an agent's Save, Pause, Resume, Shut down, Stop now and Restart, reach the run as
its Stop does. The start function takes only those (anything else refused before a read), checks the run, the agent and
the state (never while a Stop is under way), records who asked on the run's ``RUNLOG#`` rows (D4) and hands the signal
on to voc-engineering-runtime's ``signal``, which applies it. On moto and the local fake, as the handler is wired."""
from dataclasses import replace
from typing import Any

import boto3
import pytest

from engineering.board.store import BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import handler
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.run_signals import AGENT_SIGNALS, RUN_SIGNALS, SIGNAL_ACTION
from engineering.runtime.runs import RunNotActive, RunStore, run_pk
from engineering.runtime.test.conftest import COMMIT, TABLE
from shared import aws as shared_aws

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0SG'
ADMIN = 'admin-sub'
FIXER, TASK = 'fixer-2', 'task-1'
COORDINATED = {'action': 'start_run', 'run_id': RUN, 'max_tasks': 5, 'goal': 'fix the parser', 'connection': 'conn-1',
               'commit': COMMIT, 'language': 'python', 'actor': ADMIN}
FIXER_LAUNCH = {'action': 'launch', 'run_id': RUN, 'agent_id': FIXER, 'role': 'fixer', 'task_id': TASK,
                'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src']}


def _runs() -> RunStore:
    return RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE))


def _board() -> BoardStore:
    return BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: TASK)


def _signal_rows() -> list[dict[str, Any]]:
    """The run's RUNLOG# rows of a person's signals, oldest first."""
    rows = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
        ExpressionAttributeValues={':pk': run_pk(RUN), ':log': 'RUNLOG#'})['Items']
    return [row for row in rows if row.get('kind') == 'signal']


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


def _working_fixer(monkeypatch: pytest.MonkeyPatch) -> None:
    """A run with its fixer launched and working, holding its task at attempt 1."""
    monkeypatch.setattr(handler, '_hand_on_launch', lambda _run_id, _actor: None)
    handler.start_handler(COORDINATED, None)
    board = _board()
    board.post(WORKSPACE, RUN, role='fixer', title='Fix the page size', spec={'issue': 7}, parent_task='', priority=1,
               actor='coordinator-1')
    board.claim(WORKSPACE, RUN, TASK, role='fixer', agent=FIXER)
    handler.lambda_handler(FIXER_LAUNCH, None)
    sessions = handler._supervisor().sessions
    fixer = sessions.get(RUN, FIXER)
    assert fixer is not None
    sessions.save(replace(fixer, status='working', exec_id='exec-1'))


def _send(**fields: Any) -> dict[str, Any]:
    return handler.start_handler({'action': SIGNAL_ACTION, 'run_id': RUN, 'actor': ADMIN, **fields}, None)


AGENT = {'agent_id': FIXER, 'task_id': TASK, 'attempt': 1}


@pytest.mark.parametrize(('fields', 'handed'), [
    *(({'signal': name}, {}) for name in sorted(RUN_SIGNALS)),
    *(({'signal': name, **AGENT}, {'agent_id': FIXER, 'attempt': 1}) for name in sorted(AGENT_SIGNALS - {'restart'})),
    ({'signal': 'restart', 'restart_from': 'checkpoint', **AGENT}, {'agent_id': FIXER, 'attempt': 1,
                                                                    'restart_from': 'checkpoint'}),
    ({'signal': 'restart', 'restart_from': 'fresh', **AGENT}, {'agent_id': FIXER, 'attempt': 1, 'restart_from': 'fresh'}),
])
def test_each_signal_is_recorded_then_handed_on_to_the_runtime(wired: Any, monkeypatch: pytest.MonkeyPatch,
                                                               fields: dict[str, Any], handed: dict[str, Any]):
    assert wired is not None
    _working_fixer(monkeypatch)
    sent = _handed_on(monkeypatch)
    answer = _send(**fields)
    assert (answer['status'], answer['signal'], answer['agent_id']) == ('sent', fields['signal'], fields.get('agent_id'))
    # Handed on to the runtime's own signal, with only what a person's signal carries.
    assert sent == [{'action': 'signal', 'run_id': RUN, 'signal': fields['signal'], 'actor': ADMIN, **handed}]
    # Audited (D4): a RUNLOG row of its own names the person, the signal, its agent, task and attempt, and when.
    (row,) = _signal_rows()
    assert (row['actor'], row['signal'], row['at'], row['sk'].startswith(f"RUNLOG#{row['at']}#signal#")) == (
        ADMIN, fields['signal'], answer['at'], True)
    assert (row.get('agent_id'), row.get('task_id'), row.get('attempt'), row.get('restart_from')) == (
        fields.get('agent_id'), fields.get('task_id'), fields.get('attempt'), fields.get('restart_from'))


def test_the_persons_note_is_recorded_with_it_and_never_handed_on(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    sent = _handed_on(monkeypatch)
    _send(signal='pause', note='Holding for the review', **AGENT)
    (row,) = _signal_rows()
    assert (row['note'], 'note' in sent[0]) == ('Holding for the review', False)


def test_the_handed_on_signal_is_applied_by_the_supervisor(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    sent = _handed_on(monkeypatch)
    _send(signal='pause', **AGENT)
    applied = handler.lambda_handler(sent[0], None)
    fixer = handler._supervisor().sessions.get(RUN, FIXER)
    assert fixer is not None
    assert (applied['agents'], applied['applied'], fixer.status) == (
        {FIXER: 'pause_requested'}, {FIXER: True}, 'pause_requested')


@pytest.mark.parametrize(('fields', 'says'), [
    # A whole run's Shut down and Stop now are its Stop (stop_run), never a signal here.
    ({'signal': 'shutdown'}, 'a signal to the whole run is one of'),
    ({'signal': 'stop_now'}, 'a signal to the whole run is one of'),
    ({'signal': 'restart'}, 'a signal to the whole run is one of'),
    ({'signal': 'check_in'}, 'a signal to the whole run is one of'),
    ({'signal': 'reboot', **AGENT}, 'a signal to an agent is one of'),
    ({'signal': None}, 'a signal to the whole run is one of'),
    ({'signal': 'save', 'attempt': 1}, 'names no task, attempt or restart'),
    ({'signal': 'pause', 'agent_id': 'fixer 2', 'task_id': TASK, 'attempt': 1}, 'agent_id must be'),
    ({'signal': 'pause', 'agent_id': FIXER, 'attempt': 1}, 'task_id must be'),
    ({'signal': 'pause', 'agent_id': FIXER, 'task_id': TASK}, 'the attempt of its task'),
    ({'signal': 'pause', **AGENT, 'attempt': True}, 'the attempt of its task'),
    ({'signal': 'pause', **AGENT, 'attempt': 0}, 'the attempt of its task'),
    ({'signal': 'restart', **AGENT}, "a restart's restart_from is"),
    ({'signal': 'restart', 'restart_from': 'scratch', **AGENT}, "a restart's restart_from is"),
    ({'signal': 'pause', 'restart_from': 'fresh', **AGENT}, 'restart_from goes with a restart'),
    ({'signal': 'pause', 'actor': ''}, 'names the person'),
    ({'signal': 'pause', 'note': 7}, 'note is a string'),
    ({'signal': 'pause', 'note': 'é' * 251}, 'note is a string'),
    ({'signal': 'pause', 'run_id': 'run-1'}, 'run_id must be a ULID'),
    # The runtime's own carrying on of a Resume is never a person's to send.
    ({'signal': 'resume', 'after_fill': True}, None),
])
def test_a_signal_off_its_rule_is_refused_before_anything_is_read(wired: Any, monkeypatch: pytest.MonkeyPatch,
                                                                  fields: dict[str, Any], says: str | None):
    assert wired is not None
    sent = _handed_on(monkeypatch)
    if says is None:   # (a field of the runtime's own is never handed on, whatever the request carried)
        _working_fixer(monkeypatch)
        _send(**fields)
        assert sent == [{'action': 'signal', 'run_id': RUN, 'signal': 'resume', 'actor': ADMIN}]
        return
    reached: list[str] = []

    def nothing_may_be_read(*_args: Any, **_kwargs: Any) -> Any:
        reached.append('read')
        raise AssertionError('the start function read something for a signal off its rule')

    monkeypatch.setattr(handler, '_runs', nothing_may_be_read)
    monkeypatch.setattr(handler, '_supervisor', nothing_may_be_read)
    monkeypatch.setattr(handler, '_board_store', nothing_may_be_read)
    with pytest.raises(RuntimeRefused, match=says):
        _send(**fields)
    assert (reached, sent) == ([], [])


def _ended(_monkeypatch: pytest.MonkeyPatch) -> None:
    _runs().end(RUN, 'done', now=int(handler.clock()), actor='someone-else')


def _stopping(_monkeypatch: pytest.MonkeyPatch) -> None:
    _runs().request_stop(RUN, mode='stop', now=int(handler.clock()), actor=ADMIN)


def _done_task(_monkeypatch: pytest.MonkeyPatch) -> None:
    board = _board()
    board.move(WORKSPACE, RUN, TASK, agent=FIXER, epoch=1, to_state='in_progress', result_keys=[])
    board.move(WORKSPACE, RUN, TASK, agent=FIXER, epoch=1, to_state='done', result_keys=[])


@pytest.mark.parametrize(('change', 'fields', 'error', 'says'), [
    (None, {'signal': 'pause', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0ZZ'}, RuntimeRefused, 'no run'),
    (_ended, {'signal': 'resume'}, RunNotActive, 'has ended'),
    # While a person's Stop of the run is under way, it takes no other signal, an agent's included (the Stop decided).
    (_stopping, {'signal': 'resume'}, RuntimeRefused, 'being stopped'),
    (_stopping, {'signal': 'save', **AGENT}, RuntimeRefused, 'being stopped'),
    (None, {'signal': 'pause', **AGENT, 'agent_id': 'fixer-9'}, RuntimeRefused, 'no agent fixer-9'),
    (None, {'signal': 'pause', **AGENT, 'task_id': 'task-9'}, RuntimeRefused, 'no task task-9'),
    (None, {'signal': 'pause', **AGENT, 'attempt': 2}, RuntimeRefused, 'moved on'),
    (_done_task, {'signal': 'pause', **AGENT}, RuntimeRefused, 'moved on'),
])
def test_the_run_the_agent_and_the_state_are_checked_before_anything_is_written(
        wired: Any, monkeypatch: pytest.MonkeyPatch, change: Any, fields: dict[str, Any], error: type, says: str):
    assert wired is not None
    _working_fixer(monkeypatch)
    if change is not None:
        change(monkeypatch)
    sent = _handed_on(monkeypatch)
    with pytest.raises(error, match=says):
        _send(**fields)
    assert (sent, _signal_rows()) == ([], [])


def test_a_task_a_person_took_has_no_agent_to_signal(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    _board().take(WORKSPACE, RUN, TASK, actor='human:admin-1')
    sent = _handed_on(monkeypatch)
    with pytest.raises(RuntimeRefused, match='moved on'):
        _send(signal='pause', **AGENT)
    assert (sent, _signal_rows()) == ([], [])


def test_a_signal_whose_hand_on_fails_is_raised_and_stays_recorded(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _working_fixer(monkeypatch)
    _handed_on(monkeypatch, fails=True)
    with pytest.raises(RuntimeError, match='unavailable'):
        _send(signal='save')
    # (who asked stays recorded; sending it again records it again and hands it on)
    assert [row['signal'] for row in _signal_rows()] == ['save']
    sent = _handed_on(monkeypatch)
    assert _send(signal='save')['status'] == 'sent'
    assert (len(sent), [row['signal'] for row in _signal_rows()]) == (1, ['save', 'save'])


def test_the_runtime_still_refuses_a_resume_while_a_stop_is_under_way(wired: Any, monkeypatch: pytest.MonkeyPatch):
    """The start function's check is the first: the runtime keeps its own, for a Stop that came after the hand-on."""
    assert wired is not None
    _working_fixer(monkeypatch)
    sent = _handed_on(monkeypatch)
    _send(signal='resume')
    _stopping(monkeypatch)
    with pytest.raises(RuntimeRefused, match='being stopped: it cannot be resumed'):
        handler.lambda_handler(sent[0], None)
