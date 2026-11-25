"""A person's signals to an engineering run or one of its agents, through voc-engineering-start (7.51.02).

The run workspace's Pause, Resume and Save a checkpoint of the whole run, and an agent's Save, Pause, Resume, Shut
down, Stop now and Restart, reach the run as Stop does (``runtime/stop.py``): the Agents API invokes
voc-engineering-start's ``signal_run``, and never voc-engineering-runtime, whose role takes many actions IAM cannot
tell apart. The start function

1. checks the request before it reads anything (``parse``): one of the signals a run (``RUN_SIGNALS``) or an agent
   (``AGENT_SIGNALS``) takes, the agent's id with its task and the attempt the person saw, a restart's start, and
   the person; a whole run's Shut down and Stop now are its Stop (``stop_run``), never a signal here;
2. checks the run, the agent and the state (``check``): the run is there and has not ended, no Stop of it is under
   way (a Stop decided: the run takes no other signal meanwhile), the agent has a session row in the run and holds
   its task at that attempt, and the task has not ended (7.71.04: one that ended needing a person is answered with
   what to do instead, the run's Resume, ``ENDED_AT_A_PERSON``);
3. records who asked what of whom, when and why (their note), on a ``RUNLOG#`` row of its own (D4,
   ``RunStore.record_signal``), as a Stop records itself, before anything moves;
4. hands the signal on to voc-engineering-runtime's ``signal`` action, asynchronously (``handed_on``: a Resume may
   launch a coordinator, which does not fit behind API Gateway's 29 s), as its ``stop_run`` and ``finish_stop`` are.

The supervisor applies it there, as before (idempotent per agent; an agent another move holds is left as it is, and
the person sends it again; one on another attempt than the one given is left alone, ``stale``). The run's overview
shows the outcome at its next read.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from engineering.board.model import FINAL, NEEDS_HUMAN, OPEN
from engineering.board.store import BoardError, BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import RuntimeRefused, check_id, check_run_id
from engineering.runtime.runs import ENDED, RunNotActive, RunStore
from engineering.runtime.sessions import SessionStore

#: The start function's action for them.
SIGNAL_ACTION: Final = 'signal_run'
#: What a person sends the whole run here: Save a checkpoint, Pause and Resume (its Shut down and Stop now are its
#: Stop, ``stop_run``).
RUN_SIGNALS: Final = frozenset({'save', 'pause', 'resume'})
#: What a person sends one agent of it (engineering/monitor.py SIGNALS): a restart is an agent's only.
AGENT_SIGNALS: Final = frozenset({'save', 'pause', 'resume', 'shutdown', 'stop_now', 'restart'})
#: Where a restarted agent starts again: its newest checkpoint, or its task afresh (monitor.py RESTART_FROM).
RESTART_STARTS: Final = frozenset({'checkpoint', 'fresh'})
#: The most attempts a task has (the board's lease epoch).
MAX_ATTEMPT: Final = 1_000_000
#: (7.71.04) What a signal to the agent of a task that ended needing a person answers (409): its agent's session ended
#: with it, so nothing restarts or resumes it there; the whole run's Resume does, at the step's decision point
#: (``step_retry.py``: the step's task posted again for a new agent).
ENDED_AT_A_PERSON: Final = ('This task ended needing a person, so no agent works on it to restart or resume: '
                            'Resume the run instead, which posts the step\'s task again for a new agent')
#: The longest person's id recorded (runs.py MAX_ACTOR), and the longest note (why: monitor.py MAX_NOTE_BYTES).
MAX_ACTOR: Final = 200
MAX_NOTE_BYTES: Final = 500


@dataclass(frozen=True)
class SignalRequest:
    """A person's signal: to the whole run (no ``agent_id``), or to the agent holding ``task_id`` at ``attempt``."""
    run_id: str
    signal: str
    actor: str
    agent_id: str = ''
    task_id: str = ''
    attempt: int = 0
    #: A restart's start (``RESTART_STARTS``; '' for every other signal).
    restart_from: str = ''
    #: Why, as the person said it (the run monitor checked it holds no credential); '' for none.
    note: str = ''

    def handed_on(self) -> dict[str, Any]:
        """voc-engineering-runtime's ``signal`` event for it: only the fields a person's signal carries (never
        ``after_fill``, the runtime's own carrying on of a Resume)."""
        event: dict[str, Any] = {'action': 'signal', 'run_id': self.run_id, 'signal': self.signal, 'actor': self.actor}
        if self.agent_id:
            event |= {'agent_id': self.agent_id, 'attempt': self.attempt}
        if self.restart_from:
            event['restart_from'] = self.restart_from
        return event

    def view(self, at: str) -> dict[str, Any]:
        """The start function's answer: what was recorded and handed on (``sent``), and when."""
        return {'run_id': self.run_id, 'signal': self.signal, 'agent_id': self.agent_id or None,
                'task_id': self.task_id or None, 'attempt': self.attempt, 'status': 'sent', 'at': at}


def _attempt(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_ATTEMPT:
        raise RuntimeRefused('attempt is the attempt of its task the person saw (the task\'s lease epoch)')
    return value


def parse(event: Mapping[str, Any]) -> SignalRequest:
    """The request, checked before anything is read: ``RuntimeRefused`` for a signal off its rule."""
    run_id, signal, agent = str(event.get('run_id', '')), event.get('signal'), event.get('agent_id')
    check_run_id(run_id)
    actor = str(event.get('actor') or '')[:MAX_ACTOR]
    if not actor:
        raise RuntimeRefused('a signal names the person who sent it')
    note = event.get('note', '')
    if not isinstance(note, str) or len(note.encode('utf-8')) > MAX_NOTE_BYTES:
        raise RuntimeRefused(f'note is a string of at most {MAX_NOTE_BYTES} bytes')
    if agent is None:
        if signal not in RUN_SIGNALS:
            raise RuntimeRefused(f"a signal to the whole run is one of {', '.join(sorted(RUN_SIGNALS))} (its Shut down "
                                 'and Stop now are its Stop)')
        if {'task_id', 'attempt', 'restart_from'} & set(event):
            raise RuntimeRefused('a signal to the whole run names no task, attempt or restart')
        return SignalRequest(run_id, str(signal), actor, note=note)
    if signal not in AGENT_SIGNALS:
        raise RuntimeRefused(f"a signal to an agent is one of {', '.join(sorted(AGENT_SIGNALS))}")
    agent_id = check_id('agent_id', str(agent))
    task_id = check_id('task_id', str(event.get('task_id') or ''))
    start = event.get('restart_from')
    if signal == 'restart' and start not in RESTART_STARTS:
        raise RuntimeRefused(f"a restart's restart_from is {' or '.join(sorted(RESTART_STARTS))}")
    if signal != 'restart' and start is not None:
        raise RuntimeRefused('restart_from goes with a restart')
    return SignalRequest(run_id, str(signal), actor, agent_id, task_id, _attempt(event.get('attempt')),
                         str(start) if signal == 'restart' else '', note)


def check(request: SignalRequest, runs: RunStore, board: BoardStore, sessions: SessionStore) -> None:
    """The run, the agent and the state, read before anything is written: ``RunNotActive`` for a run that has ended,
    ``RuntimeRefused`` for no run, a Stop under way, an agent not in the run, or a task that has moved on (another
    attempt, another holder, ended or open again)."""
    run = runs.get(request.run_id)
    if run is None:
        raise RuntimeRefused(f'no run {request.run_id}')
    if run.status in ENDED:
        raise RunNotActive(f'run {request.run_id} has ended: it takes no signal')
    if run.stopping:
        raise RuntimeRefused(f'run {request.run_id} is being stopped: it takes no other signal')
    if not request.agent_id:
        return
    if sessions.get(request.run_id, request.agent_id) is None:
        raise RuntimeRefused(f'no agent {request.agent_id} in run {request.run_id}')
    try:
        task = board.task(WORKSPACE, request.run_id, request.task_id)
    except BoardError as missing:
        raise RuntimeRefused(f'no task {request.task_id} in run {request.run_id}') from missing
    if (task.lease_agent, task.lease_epoch) != (request.agent_id, request.attempt) or task.state == OPEN:
        raise RuntimeRefused('this task has moved on since you looked: reload the run')
    if task.state == NEEDS_HUMAN:
        raise RuntimeRefused(ENDED_AT_A_PERSON)
    if task.state in FINAL:
        raise RuntimeRefused('this task has moved on since you looked: reload the run')
