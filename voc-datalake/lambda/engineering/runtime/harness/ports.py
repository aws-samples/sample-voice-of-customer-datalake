"""What the harness needs from the parts of the system it does not own, as small interfaces.

The board (the task brief, the lease's heartbeat and progress), the agent's inbox (the run monitor's and
the supervisor's messages: ``save``, ``pause``, a question) and the broker (every write to the repository
host) are built apart from the runtime (docs/autonomous-engineering.md → How the agents work together,
Repository connectors). Until they land, the harness reaches them only through these interfaces, the
tests use fakes of them, and ``main.py`` wires adapters that refuse (``PendingHarnessPorts``), like the
supervisor's own ports.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Protocol

#: The inbox messages the harness acts on itself; any other kind is shown to the model as data.
SAVE: Final = 'save'
PAUSE: Final = 'pause'


@dataclass(frozen=True)
class TaskBrief:
    """What the agent is asked to do, and the only context it gets: its task and its slices."""

    task_id: str
    title: str
    instructions: str
    #: Knowledge-pack slices for this task (the connector's pack: conventions, build and test commands).
    knowledge: tuple[str, ...] = ()
    #: Memory slices (what earlier runs learnt that this task needs).
    memory: tuple[str, ...] = ()


@dataclass(frozen=True)
class InboxMessage:
    kind: str
    summary: str = ''


class Board(Protocol):
    """``brief``: the task's brief (refused when the agent does not hold the task's lease). ``heartbeat``: renew the
    lease (once a minute, the supervisor's crash clock). ``progress``: record progress on the task (the lease's last
    progress, the supervisor's activity clock)."""

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief: ...

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None: ...

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None: ...


class Inbox(Protocol):
    """``take``: the messages waiting for the agent, each taken once."""

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]: ...


class Broker(Protocol):
    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        """Hand the agent's work (a patch under its own keys) to the broker, which alone writes to the host."""
        ...


class Store(Protocol):
    def put(self, key: str, body: bytes) -> None:
        """Put one object under the agent's own keys (its role may write nowhere else)."""
        ...


class HarnessPortNotWired(RuntimeError):
    """A port whose owner has not landed yet: the harness refuses rather than guess."""


class PendingHarnessPorts:
    """The board, the inbox and the broker until they land: every call refuses."""

    @staticmethod
    def _refuse(name: str) -> HarnessPortNotWired:
        return HarnessPortNotWired(f'{name} is not wired yet (the board, the inbox and the broker land apart from '
                                   'the runtime)')

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        raise self._refuse(f'board.brief({run_id}, {task_id})')

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        raise self._refuse(f'board.heartbeat({run_id}, {task_id}, {agent_id})')

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        raise self._refuse(f'board.progress({run_id}, {task_id}, {agent_id}): {step[:40]}')

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        raise self._refuse(f'inbox.take({run_id}, {agent_id})')

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        raise self._refuse(f'broker.submit({run_id}, {agent_id}, {task_id}, {patch_key}): {summary[:40]}')
