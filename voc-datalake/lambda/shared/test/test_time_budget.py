"""Tests for shared/time_budget.py — the wall-clock bound on per-day walks."""
from datetime import UTC, datetime

from shared.time_budget import ROW_CAP_PARTIAL_REASON, WalkBudget, budgeted_days

TODAY = datetime(2026, 3, 10, tzinfo=UTC)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_walk_inside_the_budget_yields_every_day_newest_first():
    budget = WalkBudget(seconds=10, clock=FakeClock())

    assert list(budgeted_days(3, budget, today=TODAY)) == ['2026-03-10', '2026-03-09', '2026-03-08']
    assert budget.stopped is False
    assert budget.partial_fields() == {}


def test_the_walk_stops_when_the_budget_runs_out_and_says_where():
    clock = FakeClock()
    budget = WalkBudget(seconds=10, clock=clock)
    seen = []
    for date in budgeted_days(30, budget, today=TODAY):
        seen.append(date)
        clock.now += 4  # each day costs 4 s; out after the third

    assert seen == ['2026-03-10', '2026-03-09', '2026-03-08']
    assert budget.partial_fields() == {
        'partial_reason': 'time_budget',
        'scanned_through': '2026-03-08',
    }


def test_the_first_day_is_always_read():
    clock = FakeClock()
    budget = WalkBudget(seconds=0, clock=clock)

    assert list(budgeted_days(5, budget, today=TODAY)) == ['2026-03-10']
    assert budget.scanned_through == '2026-03-10'


def test_a_caller_breaking_out_itself_is_not_a_budget_stop():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    for _ in budgeted_days(30, budget, today=TODAY):
        break

    assert budget.stopped is False


def test_with_several_walks_the_least_covered_stop_wins():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    budget.record_stop('2026-01-01')
    budget.record_stop('2026-02-01')
    budget.record_stop('2025-12-01')

    assert budget.scanned_through == '2026-02-01'


def test_zero_days_yields_nothing():
    budget = WalkBudget(seconds=10, clock=FakeClock())

    assert list(budgeted_days(0, budget, today=TODAY)) == []
    assert budget.stopped is False


def test_a_row_cap_stop_says_row_cap_not_time_budget():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    budget.record_stop('2026-03-09', ROW_CAP_PARTIAL_REASON)

    assert budget.stopped is True
    assert budget.partial_fields() == {'partial_reason': 'row_cap', 'scanned_through': '2026-03-09'}


def test_a_stop_that_read_no_day_in_full_omits_the_date():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    budget.record_stop(None, ROW_CAP_PARTIAL_REASON)

    assert budget.stopped is True
    assert budget.partial_fields() == {'partial_reason': 'row_cap'}


def test_a_stop_that_read_no_day_in_full_beats_any_date_and_keeps_its_reason():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    budget.record_stop('2026-03-09')
    budget.record_stop(None, ROW_CAP_PARTIAL_REASON)
    budget.record_stop('2026-03-10')

    assert budget.partial_fields() == {'partial_reason': 'row_cap'}


def test_the_least_covered_stop_brings_its_own_reason():
    budget = WalkBudget(seconds=10, clock=FakeClock())
    budget.record_stop('2026-03-08', ROW_CAP_PARTIAL_REASON)
    budget.record_stop('2026-03-09')

    assert budget.partial_fields() == {'partial_reason': 'time_budget', 'scanned_through': '2026-03-09'}
