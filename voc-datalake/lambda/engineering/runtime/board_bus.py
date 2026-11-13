"""The supervisor's board and bus: its ``ports.Board`` and ``ports.Bus`` on the board's store and the engineering bus.

Trusted code in the runtime's two functions (voc-engineering-runtime, voc-engineering-delivery), never in a MicroVM.
The board is read and re-posted through its own store (``engineering/board``: the supervisor's role holds the runs'
partitions); every event goes out as voc-msg/1 with the supervisor's source, ``voc.engineering/supervisor``, which
the bus's policy pins to these two roles (lib/stacks/engineering-bus.ts ``addPublisher``) and the router lets send
only the supervisor's types (``bus/senders.py``): the signals to an agent, ``run.health``, an agent's fate
(``run.agent_*``) and a re-posted task's ``task.posted`` (the board's ``repost_task`` sends it as the supervisor).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final, Literal

from botocore.exceptions import BotoCoreError, ClientError

from engineering.board.api import repost_task
from engineering.board.model import FINAL, OPEN
from engineering.board.store import COORDINATE_TASK, LEASE_S, BoardError, BoardStore
from engineering.bus.publish import EventBridgePublisher, new_event_id
from engineering.bus.schema import Message, Party, fit_summary
from engineering.connectors.identity import WORKSPACE
from engineering.quality_gate.text import redact
from engineering.runtime.ports import Lease
from shared.logging import logger

#: The supervisor's source on the bus (bus/senders.py).
SOURCE: Final = 'voc.engineering/supervisor'
#: Each kind the supervisor emits (supervisor.py), as its voc-msg/1 type (agreed with the bus's schema).
TYPES: Final = {
    'pause': 'signal.pause', 'save': 'signal.save', 'question': 'signal.check_in',
    'run.health': 'run.health', 'continued': 'run.agent_continued', 'timed_out': 'run.agent_timed_out',
    'failed': 'run.agent_failed',
}
_SUPERVISOR: Final = Party('supervisor', 'supervisor')
#: An agent's session as ``BoardLeases.coordinator_to_start`` asks after it: ``failed`` (it kept crashing), ``none``
#: yet, or ``kept`` (live, held, or ended by a person's Shut down or Stop now or by its task: never replaced).
SessionState = Literal['kept', 'failed', 'none']


class BoardLeases:
    """``ports.Board`` on the board's store: a task's lease as the supervisor reads it, and its re-post."""

    def __init__(self, store: BoardStore, publisher: EventBridgePublisher) -> None:
        self.store = store
        self.publisher = publisher

    def lease(self, run_id: str, task_id: str) -> Lease | None:
        """The task's lease (an open task's has no holder, only its attempt), or None for no task."""
        if not task_id:
            return None  # a session with no task (the run coordinator's is ``coordinate``, read like any other)
        try:
            task = self.store.task(WORKSPACE, run_id, task_id)
        except BoardError as error:
            if error.kind == 'not_found':
                return None
            raise
        if task.state == OPEN:
            # Nobody holds it, at this attempt (a re-post's next one, say): the supervisor sees the task moved on.
            return Lease(task_id=task.task_id, agent_id='', renewed_at=0, last_progress_at=0, attempt=task.attempt)
        if not task.lease_agent and task.state in FINAL:
            # Ended with no holder (a person's block clears it, of a task under way or one still open for a booting
            # agent): ended all the same, never a lost lease (a crash, which would be continued in a new MicroVM).
            return Lease(task_id=task.task_id, agent_id='', renewed_at=0, last_progress_at=0, attempt=task.attempt,
                         final_state=task.state)
        if not task.lease_agent:
            return None
        # A task that has ended keeps its holder: the session waits for its harness to exit, never judged crashed.
        return Lease(task_id=task.task_id, agent_id=task.lease_agent, renewed_at=task.lease_expires - LEASE_S,
                     last_progress_at=task.progress_at, waiting=task.waiting, attempt=task.attempt,
                     final_state=task.state if task.state in FINAL else '')

    def refresh(self, run_id: str, task_id: str, *, agent_id: str, attempt: int) -> bool:
        """The holder's lease runs ``LEASE_S`` from now, whether or not it ran out (``BoardStore.refresh``); False
        when the task is not ``agent_id``'s at ``attempt`` (its epoch) any more, or is open or has ended."""
        try:
            self.store.refresh(WORKSPACE, run_id, task_id, agent=agent_id, epoch=attempt)
        except BoardError as error:
            if error.kind == 'conflict':
                return False
            raise
        return True

    def repost(self, run_id: str, task_id: str, reason: str, *, attempt: int) -> None:
        """Free the task at ``attempt`` and post it again at the next one (``task.posted``, published as the
        supervisor); a task that has ended meanwhile is left as it is, one still open at ``attempt`` (never claimed) is
        re-posted only if an agent was launched for it, and a newer attempt is refused by the board."""
        task = self.store.task(WORKSPACE, run_id, task_id)
        if task.state in FINAL:
            return
        if task.state == OPEN and task.attempt == attempt:
            # Never claimed at this attempt: the board re-posts it when an agent was launched for it (a new agent
            # gets the next attempt), and refuses otherwise (nobody launched: open for its role already).
            try:
                repost_task(self.store, self.publisher, WORKSPACE, run_id, task_id, reason, attempt)
            except BoardError as error:
                if error.kind != 'conflict':
                    raise
            return
        repost_task(self.store, self.publisher, WORKSPACE, run_id, task_id, reason, attempt)

    def coordinator_to_start(self, run_id: str, session: Callable[[str], SessionState], *,
                             actor: str, launchable: Callable[[], None] = lambda: None) -> tuple[str, int] | None:
        """The run coordinator the runtime is to start, and its task's attempt, or None when the run has one (or no
        coordinate task, or one that ended). ``session(agent)`` says whether that agent's session ``failed``, has
        ``none`` yet, or is ``kept`` as it is. ``launchable()`` raises what the launch would refuse (no skill, no
        image): it runs before a re-post or a new ``coordinator-<n>`` is numbered, as the board's launch op checks
        before it numbers an agent, so a refused Resume uses up none of the run's agent numbers.

        The coordinate task's coordinator is its holder, or the one recorded as launched at its attempt (the run's
        start records ``coordinator-1``). One with no session yet (a fresh start, or a start whose MicroVM failed) is
        started as it is. One whose session failed (it kept crashing, so the run went to a person) is replaced: the
        task re-posted at its attempt, a new ``coordinator-<n>`` recorded at the next (``launch_coordinator``, which
        the board then checks every coordinator op against, so the old one is refused from the re-post on; its
        MicroVM ended with its session). A retry finds the new one recorded, with no session or a live one."""
        try:
            task = self.store.task(WORKSPACE, run_id, COORDINATE_TASK)
        except BoardError as error:
            if error.kind == 'not_found':
                return None
            raise
        if task.state in FINAL:
            return None
        recorded = task.launched_agent if task.launched_attempt == task.attempt else ''
        holder = task.lease_agent if task.state != OPEN else recorded
        state = session(holder) if holder else 'none'
        if state == 'kept':
            return None   # live or held, or a person ended it (a Shut down or Stop now stays final)
        if holder and state == 'none' and task.state == OPEN:
            return holder, task.attempt
        launchable()
        if holder:
            # The store's re-post alone, never published: a task.posted is for the role that claims a task, and the
            # coordinate task is claimed only by the coordinator recorded next (the bus has no coordinator queue).
            task = self.store.repost(WORKSPACE, run_id, COORDINATE_TASK, reason=f'{holder} is gone: a new coordinator',
                                     attempt=task.attempt, actor=actor)
        launched = self.store.launch_coordinator(WORKSPACE, run_id, attempt=task.attempt, actor=actor)
        return launched.launched_agent, launched.attempt

    def clear_coordinator(self, run_id: str, agent_id: str, attempt: int, *, actor: str, reason: str) -> None:
        """Forget the coordinator recorded on the coordinate task after the runtime refused its launch (the board's
        ``CLEARS_LAUNCH`` rule: no session and no launch of it exist), so the next start or Resume numbers a new one.
        Only that record, at that attempt (a task that moved on is left as it is); a ``launch_refused`` history row
        says who and why (D4). A failure here is logged, never raised: the caller raises the runtime's refusal."""
        try:
            task = self.store.task(WORKSPACE, run_id, COORDINATE_TASK)
            if task.launched_agent == agent_id and task.attempt == attempt == task.launched_attempt:
                self.store.clear_launch(WORKSPACE, run_id, task, actor=actor, reason=reason)
        except (BoardError, ClientError, BotoCoreError):
            logger.exception('engineering runtime: a refused coordinator launch could not be cleared',
                             extra={'run_id': run_id, 'agent_id': agent_id})


class SupervisorBus:
    """``ports.Bus`` on the engineering bus: each of the supervisor's kinds as its voc-msg/1 type."""

    def __init__(self, publisher: EventBridgePublisher) -> None:
        self.publisher = publisher

    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None, *,
             task_id: str = '', attempt: int = 1) -> None:
        """Put one event on the bus: ``to`` is ``run`` or an agent id; ``refs`` (the supervisor's figures) go into
        the summary, since a message's refs hold only object keys, a commit, a PR and files."""
        kind_type = TYPES.get(kind)
        if kind_type is None:
            raise ValueError(f'the supervisor emits no {kind!r}')
        self.publisher.publish(message(run_id, to, kind_type, summary, refs, task_id=task_id, attempt=attempt))


def message(run_id: str, to: str, kind_type: str, summary: str, refs: Mapping[str, str] | None, *,
            task_id: str, attempt: int, at: datetime | None = None) -> Message:
    """The supervisor's voc-msg/1 message (its thread is the run's)."""
    figures = ', '.join(f'{key} {value}' for key, value in (refs or {}).items())
    text = redact(f'{summary} ({figures})' if figures else summary)
    return Message(
        event_id=new_event_id(), ws=WORKSPACE, run_id=run_id, thread_id=run_id, attempt=max(1, attempt),
        sender=_SUPERVISOR, to=Party('run', run_id) if to == 'run' else Party('agent', to), type=kind_type,
        summary=fit_summary(text), at=(at or datetime.now(UTC)).strftime('%Y-%m-%dT%H:%M:%S.%fZ'), task_id=task_id)


def wired(client: Any, table: str, events: Any, bus_name: str) -> tuple[BoardLeases, SupervisorBus]:
    """The supervisor's board and bus on these clients (both functions' wiring, ``handler.py``)."""
    publisher = EventBridgePublisher(events, bus_name, SOURCE)
    return BoardLeases(BoardStore(client, table, new_id=new_event_id), publisher), SupervisorBus(publisher)

