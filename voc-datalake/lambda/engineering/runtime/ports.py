"""What the supervisor needs from the parts of the system it does not own, as small interfaces.

The board and the bus (engineering/board, engineering/bus) and the run's controls are apart from the runtime
(docs/autonomous-engineering.md → How the agents work together). The supervisor reaches them only through these
interfaces: ``handler.py`` wires them (``board_bus.py``, ``runs.TableRunControl``) and the tests use fakes of them.

Events go out by type, addressee, a short summary and references, never a payload (docs/autonomous-engineering.md → How the agents work together).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Lease:
    """A task's row on the board, as the supervisor reads it."""

    task_id: str
    #: The holder; '' for an open task (posted, or re-posted at its next attempt, and not claimed yet).
    agent_id: str
    #: When the agent's heartbeat last renewed the lease (epoch seconds).
    renewed_at: float
    #: When the agent last reported progress through the board's API (epoch seconds).
    last_progress_at: float
    #: The agent is suspended on an open wait (its question, a review it asked for, a human decision point).
    waiting: bool = False
    #: The attempt of the task the lease is on (a re-post starts the next one).
    attempt: int = 1
    #: The state the task ended in under this holder (done, failed, needs_human), '' while it runs: its harness is
    #: to exit, and the session ends with it.
    final_state: str = ''

    @property
    def ended(self) -> bool:
        return bool(self.final_state)


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
    """``lease``: the task's lease (an open task's has no holder, only its attempt), or None for no task. ``repost``:
    free the task at the ``attempt`` the supervisor judged and post it again at the next one, for an agent to start
    afresh (a newer attempt is left alone). ``refresh``: the holder's lease runs its full time again (before a
    continuation's MicroVM starts, and when its harness does); False when the task is not the holder's at that
    attempt any more."""

    def lease(self, run_id: str, task_id: str) -> Lease | None: ...

    def repost(self, run_id: str, task_id: str, reason: str, *, attempt: int) -> None: ...

    def refresh(self, run_id: str, task_id: str, *, agent_id: str, attempt: int) -> bool: ...


class Bus(Protocol):
    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None, *,
             task_id: str = '', attempt: int = 1) -> None:
        """Put one event on the bus (``kind``: pause, save, question, continued, timed_out, failed, run.health), about
        ``task_id`` at ``attempt`` when it is about an agent's task; ``to`` is ``run`` or an agent id."""
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

