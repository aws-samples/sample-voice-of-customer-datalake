"""The supervisor's board and bus: its ``ports.Board`` and ``ports.Bus`` on the board's store and the engineering bus.

Trusted code in the runtime's two functions (voc-engineering-runtime, voc-engineering-delivery), never in a MicroVM.
The board is read and re-posted through its own store (``engineering/board``: the supervisor's role holds the runs'
partitions); every event goes out as voc-msg/1 with the supervisor's source, ``voc.engineering/supervisor``, which
the bus's policy pins to these two roles (lib/stacks/engineering-bus.ts ``addPublisher``) and the router lets send
only the supervisor's types (``bus/senders.py``): the signals to an agent, ``run.health``, an agent's fate
(``run.agent_*``) and a re-posted task's ``task.posted`` (the board's ``repost_task`` sends it as the supervisor).
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Final

from engineering.board.api import repost_task
from engineering.board.model import FINAL, OPEN
from engineering.board.store import LEASE_S, BoardError, BoardStore
from engineering.bus.publish import EventBridgePublisher, new_event_id
from engineering.bus.schema import Message, Party, fit_summary
from engineering.connectors.identity import WORKSPACE
from engineering.quality_gate.text import redact
from engineering.runtime.ports import Lease

#: The supervisor's source on the bus (bus/senders.py).
SOURCE: Final = 'voc.engineering/supervisor'
#: Each kind the supervisor emits (supervisor.py), as its voc-msg/1 type (agreed with the bus's schema).
TYPES: Final = {
    'pause': 'signal.pause', 'save': 'signal.save', 'question': 'signal.check_in',
    'run.health': 'run.health', 'continued': 'run.agent_continued', 'timed_out': 'run.agent_timed_out',
    'failed': 'run.agent_failed',
}
_SUPERVISOR: Final = Party('supervisor', 'supervisor')


class BoardLeases:
    """``ports.Board`` on the board's store: a task's lease as the supervisor reads it, and its re-post."""

    def __init__(self, store: BoardStore, publisher: EventBridgePublisher) -> None:
        self.store = store
        self.publisher = publisher

    def lease(self, run_id: str, task_id: str) -> Lease | None:
        """The task's lease (an open task's has no holder, only its attempt), or None for no task."""
        if not task_id:
            return None  # the run coordinator holds no task
        try:
            task = self.store.task(WORKSPACE, run_id, task_id)
        except BoardError as error:
            if error.kind == 'not_found':
                return None
            raise
        if task.state == OPEN:
            # Nobody holds it, at this attempt (a re-post's next one, say): the supervisor sees the task moved on.
            return Lease(task_id=task.task_id, agent_id='', renewed_at=0, last_progress_at=0, attempt=task.attempt)
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

