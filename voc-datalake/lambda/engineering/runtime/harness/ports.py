"""What the harness needs from the parts of the system it does not own, as small interfaces.

The board (the task brief, the lease's heartbeat and progress; for the run coordinator, the run's tasks, posting
one and launching its agent), the agent's inbox (the run monitor's and the supervisor's messages: ``save``,
``pause``, a question), the knowledge pack (its agent reader: the latest approved version, read as data) and the
broker (every write to the repository host) are built apart from the runtime (engineering/board, engineering/connectors; the inbox is not built yet;
docs/autonomous-engineering.md → How the agents work together, Repository connectors). Until the harness is
wired to them, it reaches them only through these interfaces, the
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


@dataclass(frozen=True)
class TaskSummary:
    """One task of the run, as the coordinator reads the board."""

    task_id: str
    role: str
    title: str
    state: str
    attempt: int = 1


class Planner(Protocol):
    """The run coordinator's view of its run: ``tasks`` on the board, ``post`` a task (its id), ``launch`` one agent
    for a task (its id). The run's connection and commit are the board's to take from the verified caller's run,
    never anything the MicroVM sends."""

    def tasks(self, *, run_id: str) -> list[TaskSummary]: ...

    def post(self, *, run_id: str, role: str, title: str, instructions: str, paths: tuple[str, ...]) -> str: ...

    def launch(self, *, run_id: str, task_id: str, role: str, language: str, paths: tuple[str, ...]) -> str: ...


class KnowledgeReader(Protocol):
    """The knowledge pack's agent reader: the caller's run's connection's latest approved pack (the reader takes the
    connection from the verified caller), the parts on ``topic`` (it picks them; the harness shows them as data)."""

    def read(self, *, run_id: str, topic: str) -> list[str]: ...


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
    """A port the harness is not wired to yet: it refuses rather than guess."""


class PendingHarnessPorts:
    """The board, the planner, the knowledge reader, the inbox and the broker until the harness is wired to them:
    every call refuses."""

    @staticmethod
    def _refuse(name: str) -> HarnessPortNotWired:
        return HarnessPortNotWired(f'{name} is not wired yet (the harness does not reach the board, the inbox or '
                                   'the broker yet)')

    def brief(self, *, run_id: str, task_id: str) -> TaskBrief:
        raise self._refuse(f'board.brief({run_id}, {task_id})')

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        raise self._refuse(f'board.heartbeat({run_id}, {task_id}, {agent_id})')

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str) -> None:
        raise self._refuse(f'board.progress({run_id}, {task_id}, {agent_id}): {step[:40]}')

    def tasks(self, *, run_id: str) -> list[TaskSummary]:
        raise self._refuse(f'board.tasks({run_id})')

    def post(self, *, run_id: str, role: str, title: str, instructions: str, paths: tuple[str, ...]) -> str:
        raise self._refuse(f'board.post({run_id}, {role}, {len(paths)} paths, {len(instructions)} characters): '
                           f'{title[:40]}')

    def launch(self, *, run_id: str, task_id: str, role: str, language: str, paths: tuple[str, ...]) -> str:
        raise self._refuse(f'launch({run_id}, {task_id}, {role}, {language}, {len(paths)} paths)')

    def read(self, *, run_id: str, topic: str) -> list[str]:
        raise self._refuse(f'knowledge.read({run_id}): {topic[:40]}')

    def take(self, *, run_id: str, agent_id: str) -> list[InboxMessage]:
        raise self._refuse(f'inbox.take({run_id}, {agent_id})')

    def submit(self, run_id: str, agent_id: str, task_id: str, patch_key: str, summary: str) -> str:
        raise self._refuse(f'broker.submit({run_id}, {agent_id}, {task_id}, {patch_key}): {summary[:40]}')
