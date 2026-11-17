"""A person's Stop of a whole engineering run (7.50.03): it always ends the run, with or without a live session.

Before 7.50.03 a whole-run Shut down or Stop now from the run monitor only moved the run's agents' sessions
(``Supervisor.signal_detailed``): a run with no session (its coordinator never started, at a person's decision point)
answered "no agent yet" and stayed where it was, holding its engineering agent's run lock for good. Now a Stop ends
the run itself, whatever its agents are doing:

- **Stop now** (``stop_now``): at once. META ``stopped`` with its ``RUNLOG#`` row naming the person and how (D4:
  ``RunStore.end``), every task that has not ended closed ``failed`` with a ``stop`` history row
  (``BoardStore.close_for_stop``: no agent's failure, learning/retrospective.py), every launch hold run out (a launch
  still under way finds the run ended and stops its session), then every session ended (``end_run``'s own step).
- **Stop** (``stop``, the run monitor's Shut down of the whole run): the agents save first. With no agent that has a
  session (none ever started, or every one held or paused, so checkpointed), it is a Stop now: nothing is lost. Else
  the request goes on META (``RunStore.request_stop``: no agent launches, no Resume, from then on), each agent is asked
  to checkpoint and stop (the Shut down signal, which falls back to stopping it when no checkpoint comes), and the run
  ends as above once none of its agents has a session, or ``STOP_GRACE_SECONDS`` after the request at the latest
  (the supervisor's tick, ``due``).

The engineering agent's run (voc-agents) ends with it: the heartbeat's lock heal reads META ``stopped`` as cancelled
(agents/heartbeat/engineering.py), and the Agents API ends it at once after a Stop it sent
(shared/engineering_agent_runs.py ``end_agent_run``). The issue's ``ISSUE_RUN#`` claim is kept, as the design says
(one run per issue, ever: only an administrator's Run now ``{issue}`` reruns it).

Pure over its stores: the handler wires it in both voc-engineering-start (the Agents API's door, which holds no
session and no bus: it ends a run or records the request and hands the rest on) and voc-engineering-runtime.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.board.model import PERSON_PREFIX
from engineering.board.store import BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import ENDED, STOP_MODES, STOP_NOW, UNATTRIBUTED, Run, RunNotActive, RunStore
from engineering.runtime.sessions import WITH_SESSION, AgentSession, SessionStore
from shared.logging import logger

#: How long a Stop waits for its agents' checkpoints before it ends the run anyway: an agent's Shut down falls back to
#: stopping it 3 minutes after the ask (supervisor.py ``shutdown`` timing), and the tick that sees it runs a minute
#: later; twice that, and a margin, for an agent that was busy with another move when it was asked.
STOP_GRACE_SECONDS: Final = 10 * 60
#: The board's actor for a change no person is named on (a Stop the runtime finishes with nobody recorded).
RUNTIME_ACTOR: Final = 'runtime'


@dataclass(frozen=True)
class Stopped:
    """What a Stop did: the run's status after it (``stopped``, ``stopping``, or the status it had ended with
    already), how it was asked, the tasks it closed, the launch holds it ran out, and the agents asked to save."""

    run_id: str
    status: str
    mode: str
    tasks_closed: tuple[str, ...] = ()
    holds_released: tuple[str, ...] = ()
    saving: tuple[str, ...] = ()
    #: The run had ended before this Stop (nothing was changed but what its end left undone).
    already: bool = False
    #: A Stop whose agents could not be asked to save (its hand-on failed): it stopped the run at once instead.
    fell_back: bool = False
    agents: dict[str, str] = field(default_factory=dict)

    def view(self) -> dict[str, Any]:
        return {'run_id': self.run_id, 'status': self.status, 'mode': self.mode,
                'tasks_closed': list(self.tasks_closed), 'holds_released': list(self.holds_released),
                'saving': list(self.saving), 'already': self.already, 'fell_back': self.fell_back,
                'agents': dict(self.agents)}


def check_mode(mode: object) -> str:
    """``stop`` or ``stop_now``; ``RuntimeRefused`` for anything else."""
    if mode not in STOP_MODES:
        raise RuntimeRefused(f'a stop is one of {sorted(STOP_MODES)}')
    return str(mode)


def board_actor(actor: str) -> str:
    """The person on the board's history rows (``human:<subject>``, as their own board actions are); the runtime's
    label when nobody is named."""
    if not actor or actor == UNATTRIBUTED:
        return RUNTIME_ACTOR
    return actor if actor.startswith(PERSON_PREFIX) else f'{PERSON_PREFIX}{actor}'


def reason_of(mode: str, *, saved: bool = False, grace: bool = False) -> str:
    """The ``RUNLOG#`` row's and the closed tasks' reason: how the run was stopped."""
    if mode == STOP_NOW:
        return 'stopped now from the run monitor, without a checkpoint'
    if grace:
        return 'stopped from the run monitor: not every agent saved within the grace, the rest were stopped'
    return ('stopped from the run monitor once its agents had saved' if saved
            else 'stopped from the run monitor (no agent had a session to save)')


def saving_agents(sessions: Sequence[AgentSession]) -> tuple[str, ...]:
    """The agents a Stop waits for: those with a session (running, booting or pausing), or a stop still pending."""
    return tuple(sorted(session.agent_id for session in sessions
                        if session.status in WITH_SESSION or session.stop_pending))


def close(runs: RunStore, board: BoardStore, sessions: SessionStore, run_id: str, *, actor: str, mode: str,
          now: int, reason: str) -> Stopped:
    """End the run ``stopped`` (when it is still live), close its tasks that have not ended and run out its launch
    holds; each step idempotent, so a retry (or the runtime's ``end_run`` after the start function's Stop) does what
    the first left undone. Its sessions are the caller's to end (``Supervisor.signal(… 'stop_now')``)."""
    already = False
    try:
        runs.end(run_id, 'stopped', now=now, actor=actor, reason=reason)
    except RunNotActive:
        run = runs.get(run_id)
        if run is None or run.status not in ENDED:
            raise
        already = True
    status = 'stopped' if not already else _ended_status(runs, run_id)
    closed = board.close_for_stop(WORKSPACE, run_id, actor=board_actor(actor), reason=reason)
    holds = release_holds(sessions, run_id)
    logger.info('engineering stop: the run ended', extra={'run_id': run_id, 'mode': mode, 'tasks_closed': len(closed),
                                                         'holds_released': len(holds), 'already': already})
    return Stopped(run_id, status, mode, tuple(closed), holds, already=already)


def _ended_status(runs: RunStore, run_id: str) -> str:
    run = runs.get(run_id)
    return run.status if run is not None else 'stopped'


def release_holds(sessions: SessionStore, run_id: str) -> tuple[str, ...]:
    """Run out every launch hold of an agent that has no session yet (``SessionStore.release_launch``: the row stays
    a run-out hold), so nothing reads the stopped run as still launching; the agents whose hold was live."""
    _sessions, holds = sessions.of_run_with_holds(run_id)
    released = []
    for agent_id, until in sorted(holds.items()):
        if until > 0:
            sessions.release_launch(run_id, agent_id)
            released.append(agent_id)
    return tuple(released)


def due(run: Run, sessions: Sequence[AgentSession], now: int) -> bool:
    """A stopping run is ended now: none of its agents has a session left to save, or its grace has passed."""
    return run.stopping and (not saving_agents(sessions) or now - run.stop_requested_at >= STOP_GRACE_SECONDS)

