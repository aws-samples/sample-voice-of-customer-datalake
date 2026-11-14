"""Properties of the administrators' hard cap on a start (runtime/runs.py ``hard_capped``).

The rule in words: a run of a flow with a monthly budget may spend no more than what is left of that month's budget,
and no more than the run's own cost cap (the deployment's); with nothing left, the start is refused before anything is written. The
month's spend is read from the flow's month total, which this test supplies (the table is not what is under test).
"""
from __future__ import annotations

from decimal import Decimal
from unittest import mock

import pytest
from hypothesis import given
from hypothesis import strategies as st

from engineering.runtime import runs
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunCaps, hard_capped
from shared.test.properties import PROPERTY

NOW = 1_763_000_000   # a fixed instant in November 2025 (UTC): the month the spend is read for
FLOWS = st.from_regex(r'[a-z][a-z0-9_-]{0,30}', fullmatch=True)
BUDGETS = st.decimals(min_value=Decimal('1'), max_value=Decimal('5000'), places=2, allow_nan=False).map(float)
SPENT = st.decimals(min_value=Decimal('0'), max_value=Decimal('7000'), places=2, allow_nan=False)
CAPS = st.one_of(st.none(), st.floats(min_value=0.01, max_value=2000, allow_nan=False, allow_infinity=False))


def caps_of(max_cost: float | None) -> RunCaps:
    return RunCaps(max_tasks=5, max_tokens=50_000, max_cost_usd=max_cost)


@PROPERTY
@given(flow=FLOWS, budget=BUDGETS, spent=SPENT, cap=CAPS)
def test_a_run_may_spend_no_more_than_what_is_left_of_its_flows_month(flow: str, budget: float, spent: Decimal,
                                                                      cap: float | None) -> None:
    """The run's cost cap is the smaller of its own cap and what is left of the flow's monthly budget; the task and
    token caps it was given are kept; with nothing left the start is refused, saying so."""
    left = Decimal(str(budget)) - spent
    with mock.patch.object(runs, 'flow_month_usd', return_value=spent):
        if left <= 0:
            with pytest.raises(RuntimeRefused, match='has spent its monthly budget'):
                hard_capped(caps_of(cap), budget_usd=budget, flow=flow, table=None, now=NOW)
            return
        result = hard_capped(caps_of(cap), budget_usd=budget, flow=flow, table=None, now=NOW)
    assert result.max_cost_usd is not None
    assert result.max_cost_usd <= float(left)
    assert result.max_cost_usd == (float(left) if cap is None else min(cap, float(left)))
    assert (result.max_tasks, result.max_tokens) == (5, 50_000)


@PROPERTY
@given(flow=FLOWS, budget=BUDGETS, low=SPENT, high=SPENT)
def test_more_spent_never_raises_the_cap(flow: str, budget: float, low: Decimal, high: Decimal) -> None:
    """The cap only shrinks as the month's spend grows: a later start never gets more than an earlier one did."""
    first, second = sorted((low, high))
    caps = caps_of(None)
    with mock.patch.object(runs, 'flow_month_usd', return_value=first):
        try:
            early = hard_capped(caps, budget_usd=budget, flow=flow, table=None, now=NOW).max_cost_usd
        except RuntimeRefused:
            early = None
    with mock.patch.object(runs, 'flow_month_usd', return_value=second):
        try:
            late = hard_capped(caps, budget_usd=budget, flow=flow, table=None, now=NOW).max_cost_usd
        except RuntimeRefused:
            late = None
    if late is not None:
        assert early is not None
        assert late <= early


@PROPERTY
@given(budget=st.one_of(st.floats(max_value=0, allow_nan=False), st.just(float('nan')), st.just(float('inf'))))
def test_a_budget_that_is_not_a_positive_amount_refuses_the_start(budget: float) -> None:
    """A budget that is not a finite positive amount refuses the start before the month is read."""
    with mock.patch.object(runs, 'flow_month_usd', side_effect=AssertionError('no read for a bad budget')), \
            pytest.raises(RuntimeRefused):
        hard_capped(caps_of(None), budget_usd=budget, flow='triage-bug', table=None, now=NOW)


@PROPERTY
@given(budget=BUDGETS)
def test_a_flow_without_a_key_part_cannot_have_a_budget(budget: float) -> None:
    """A flow with no name that can key its own totals (empty) cannot be budgeted: its runs are refused."""
    with mock.patch.object(runs, 'flow_month_usd', side_effect=AssertionError('no read without a key')), \
            pytest.raises(RuntimeRefused, match="a budget is a flow's"):
        hard_capped(caps_of(None), budget_usd=budget, flow='', table=None, now=NOW)
