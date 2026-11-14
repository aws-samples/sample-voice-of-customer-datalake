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
class FlowStop:
    """Where a run's flow waits at a person: its decision point (``flow:<step>``), and whether the run waits there
    already (nothing to ask again: its agents stay held)."""

    point: str
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
    """``lease``: the task's lease (an open task's has no holder, only its attempt), or None for no task. ``repost``:
    free the task at the ``attempt`` the supervisor judged and post it again at the next one, for an agent to start
    afresh (a newer attempt is left alone). ``refresh``: the holder's lease runs its full time again (before a
    continuation's session starts, and when its harness does); False when the task is not the holder's at that
    attempt any more."""

    def lease(self, run_id: str, task_id: str) -> Lease | None: ...

    def repost(self, run_id: str, task_id: str, reason: str, *, attempt: int) -> None: ...

    def refresh(self, run_id: str, task_id: str, *, agent_id: str, attempt: int) -> bool: ...


class Bus(Protocol):
    def emit(self, run_id: str, to: str, kind: str, summary: str, refs: Mapping[str, str] | None = None, *,
             task_id: str = '', attempt: int = 1) -> None:
        """Put one event on the bus (``kind``: pause, save, question, continued, timed_out, failed, run.health,
        run.budget_alert), about
        ``task_id`` at ``attempt`` when it is about an agent's task; ``to`` is ``run`` or an agent id."""
        ...


@dataclass(frozen=True)
class BudgetAlert:
    """A run's flow passed alert levels of its monthly budget (spend.py ``alert_levels``) this month: the ``levels``
    this run claimed to say (the highest is said), and ``flag``, the highest the flow passed."""

    flow: str
    month: str
    levels: tuple[int, ...]
    flag: int
    spent_usd: float
    budget_usd: float

    def summary(self) -> str:
        # (the share is the spend's own, not the level's: a tick that jumps levels says how far it is)
        share = int(self.spent_usd * 100 / self.budget_usd) if self.budget_usd else 0
        return (f'Workflow {self.flow} has spent ${self.spent_usd:,.2f} of its ${self.budget_usd:,.2f} monthly budget '
                f'for {self.month} ({share}%, past {self.levels[-1]}%). Session time only: model tokens are not '
                f'priced yet.')


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

    def is_active(self, run_id: str) -> bool:
        """The run is active: not ended, and not waiting at a decision point."""
        ...

    def flow_stop(self, run_id: str) -> FlowStop | None:
        """The decision point the run's flow waits at (``flow:<step>``, engineering/flow/conductor.py), and whether
        the run waits there already; None for no flow, nothing to decide, or another decision point or an end."""
        ...

    def coordinator_awaited(self, run_id: str) -> int | None:
        """When the run started or a person last resumed it, whichever is later (epoch seconds), if it is active and was
        started with its connection, commit and language, so it has a coordinator to launch; None otherwise. One read
        of the run's row."""
        ...

    def budget_alert(self, run_id: str, now: int) -> BudgetAlert | None:
        """The alert this tick is to say, when the run's flow has a budget and its month passed a level no run of it
        said yet (claimed for this run); with none to say, the run is flagged with the highest level passed."""
        ...

    def alert_sent(self, run_id: str, alert: BudgetAlert, now: int) -> None:
        """The alert was said: its claims are closed and the run is flagged."""
        ...

    def alert_not_sent(self, run_id: str, alert: BudgetAlert) -> None:
        """Saying the alert failed: its claims are given back, for any live run of the flow's next tick."""
        ...

