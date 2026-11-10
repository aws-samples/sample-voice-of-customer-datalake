"""Shared fixtures for tests that walk feedback days (shared.feedback / shared.feedback_sampling).

A walk stops on a time budget (``shared.time_budget.WalkBudget``). Under a loaded test run the
default budget can expire mid-walk and turn a deterministic answer partial, so these tests swap in
a budget they cannot hit; an explicit ``seconds`` (a probe's own) is kept.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from shared.time_budget import WalkBudget

UNHURRIED_WALK_SECONDS = 600


class UnhurriedWalkBudget(WalkBudget):
    """`WalkBudget` with a default the tests cannot hit; an explicit `seconds` is kept."""

    def __init__(self, seconds: float = UNHURRIED_WALK_SECONDS, **kwargs: Any) -> None:
        super().__init__(seconds=seconds, **kwargs)


class FlooredWalkBudget(WalkBudget):
    """`WalkBudget` of at least ``UNHURRIED_WALK_SECONDS``, an explicit `seconds` included (for code
    under test that passes its own short budget, which a loaded run could otherwise exhaust)."""

    def __init__(self, seconds: float = UNHURRIED_WALK_SECONDS, **kwargs: Any) -> None:
        super().__init__(seconds=max(seconds, UNHURRIED_WALK_SECONDS), **kwargs)


def unhurried_walks(monkeypatch: pytest.MonkeyPatch, *modules: Any, floor_explicit: bool = False) -> None:
    """Swap the budget in ``shared.feedback`` and in each module that imported ``WalkBudget`` itself.

    ``floor_explicit`` also raises an explicit ``seconds`` to the unhurried floor.
    """
    budget = FlooredWalkBudget if floor_explicit else UnhurriedWalkBudget
    monkeypatch.setattr('shared.feedback.WalkBudget', budget)
    for module in modules:
        monkeypatch.setattr(module, 'WalkBudget', budget)


def day(offset: int) -> str:
    """The UTC calendar day ``offset`` days ago, ``YYYY-MM-DD``."""
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')
