"""What the supervisor needs from the parts of the system it does not own, as small interfaces.

The board and the bus (engineering/board, engineering/bus) and the run's controls (not built yet) are apart
from the runtime (docs/autonomous-engineering.md → How the agents work together). Until the runtime is wired
to them, the supervisor reaches them only through these
interfaces, the tests use fakes of them, and ``handler.py`` wires adapters that refuse (``PortNotWired``),
which is why the stack keeps the runtime behind ``-c engineeringAgents=true``.

Events go out by type, addressee, a short summary and references, never a payload (docs/autonomous-engineering.md → How the agents work together).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


class PortNotWired(RuntimeError):
    """A port the runtime is not wired to yet."""


@dataclass(frozen=True)
class Lease:
    """A task's row on the board, as the supervisor reads it."""

    task_id: str
    agent_id: str
    #: When the agent's heartbeat last renewed the lease (epoch seconds).
    renewed_at: float
    #: When the agent last reported progress through the board's API (epoch seconds).
    last_progress_at: float
    #: The agent is suspended on an open wait (its question, a review it asked for, a human decision point).
    waiting: bool = False


@dataclass(frozen=True)
class Budget:
    """A run's spend and the hard caps a person set (None: no cap of that kind)."""

    tokens: int
    cost_usd: float
    max_tokens: int | None
    max_cost_usd: float | None

    @property
    def exceeded(self) -> bool:
        return ((self.max_tokens is not None and self.tokens >= self.max_tokens)
                or (self.max_cost_usd is not None and self.cost_usd >= self.max_cost_usd))


class Board(Protocol):
    def lease(self, run_id: str, task_id: str) -> Lease | None:
        """The task's lease, or None when no agent holds it."""
        ...

    def repost(self, run_id: str, task_id: str, reason: str) -> None:
        """Free the task and post it again, to be taken up from its checkpoint by another agent."""
        ...


class Bus(Protocol):
    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None) -> None:
        """Put one event on the bus (``kind``: pause, save, question, continued, timed_out, run.health, …)."""
        ...

    def inbox_depth(self, run_id: str, agent_id: str) -> int:
        """Messages waiting in the agent's inbox."""
        ...


class RunControl(Protocol):
    def budget(self, run_id: str) -> Budget:
        ...

    def started_at(self, run_id: str) -> int:
        """When the run started (epoch seconds): the supervisor itself stops a run at 30 days."""
        ...

    def stop_requested(self, run_id: str) -> bool:
        """A person's "stop" or an agent's kill switch (the 30-day stop is the supervisor's own)."""
        ...

    def needs_human(self, run_id: str, reason: str) -> None:
        """Put the run at a human decision point (``budget``, ``coordinator``, ``thirty_days``: stop only)."""
        ...


class PendingPorts:
    """The board, the bus and the run's controls until the runtime is wired to them: every call refuses."""

    @staticmethod
    def _refuse(name: str) -> PortNotWired:
        return PortNotWired(f'{name} is not wired yet (the runtime does not reach the board, the bus or the run controls yet)')

    def lease(self, run_id: str, task_id: str) -> Lease | None:
        raise self._refuse(f'board.lease({run_id}, {task_id})')

    def repost(self, run_id: str, task_id: str, reason: str) -> None:
        raise self._refuse(f'board.repost({run_id}, {task_id}, {reason})')

    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None) -> None:
        raise self._refuse(f'bus.emit({run_id}, {to}, {kind}): {summary[:40]} {dict(refs or {})}')

    def inbox_depth(self, run_id: str, agent_id: str) -> int:
        raise self._refuse(f'bus.inbox_depth({run_id}, {agent_id})')

    def budget(self, run_id: str) -> Budget:
        raise self._refuse(f'run_control.budget({run_id})')

    def started_at(self, run_id: str) -> int:
        raise self._refuse(f'run_control.started_at({run_id})')

    def stop_requested(self, run_id: str) -> bool:
        raise self._refuse(f'run_control.stop_requested({run_id})')

    def needs_human(self, run_id: str, reason: str) -> None:
        raise self._refuse(f'run_control.needs_human({run_id}, {reason})')
