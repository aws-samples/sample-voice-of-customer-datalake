"""Mutation hardening for `shared/time_budget.py`.

`test_time_budget.py` pins what a walk yields and says when the budget cuts it
short, but a mutation run found three things it could not see:

* the VALUES of the two timing constants. The earlier test only asserted that
  the budget sits below the API Gateway ceiling with a margin of at least 5 s,
  so 29 → 30 and 20 → 21 both survived. `lib/stacks/api-stack.test.ts` reads
  these constants from this file and pins the metrics Lambda timeout against
  them, so a drift is a cross-stack contract change — each is pinned here as a
  literal, and so is the 9 s margin the module docstring reserves for the work
  after the walk.
* the deadline boundary of `exhausted()`: the budget is spent at EXACTLY the
  deadline (`>=`), not one tick after; nothing pinned the equal case.
* that a stop at an EQUAL date and at an OLDER date both leave `scanned_through`
  unchanged, so the newest-wins rule has no drift in either direction.
"""
import pytest

from shared.test.test_time_budget import TODAY, FakeClock
from shared.time_budget import (
    API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS,
    TIME_BUDGET_PARTIAL_REASON,
    WALK_TIME_BUDGET_SECONDS,
    WalkBudget,
    budgeted_days,
)


class TestTheTimingConstantsArePinned:
    def test_api_gateway_abandons_a_rest_integration_after_29_seconds(self):
        assert API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS == 29

    def test_a_walk_may_spend_20_seconds(self):
        assert WALK_TIME_BUDGET_SECONDS == 20

    def test_9_seconds_are_left_for_the_work_after_the_walk(self):
        assert API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS - WALK_TIME_BUDGET_SECONDS == 9

    def test_the_partial_reason_is_the_wire_literal(self):
        assert TIME_BUDGET_PARTIAL_REASON == 'time_budget'

    def test_the_default_budget_is_the_module_constant(self):
        clock = FakeClock()
        budget = WalkBudget(clock=clock)

        clock.now = 19.999
        assert budget.exhausted() is False
        clock.now = 20
        assert budget.exhausted() is True


class TestTheBudgetIsSpentExactlyAtTheDeadline:
    @pytest.mark.parametrize(('now', 'exhausted'), [
        (9.999, False),
        (10, True),
        (10.001, True),
    ])
    def test_exhausted_at_the_boundary(self, now, exhausted):
        clock = FakeClock()
        budget = WalkBudget(seconds=10, clock=clock)

        clock.now = now
        assert budget.exhausted() is exhausted

    def test_the_deadline_is_measured_from_construction_not_zero(self):
        clock = FakeClock()
        clock.now = 100
        budget = WalkBudget(seconds=10, clock=clock)

        clock.now = 109.999
        assert budget.exhausted() is False
        clock.now = 110
        assert budget.exhausted() is True

    def test_a_walk_stops_on_the_day_after_the_deadline_is_reached(self):
        clock = FakeClock()
        budget = WalkBudget(seconds=10, clock=clock)
        seen = []
        for date in budgeted_days(5, budget, today=TODAY):
            seen.append(date)
            clock.now += 5  # 5, 10: exactly at the deadline after the second day

        assert seen == ['2026-03-10', '2026-03-09']
        assert budget.scanned_through == '2026-03-09'
        assert budget.stopped is True


class TestTheNewestStopDateWinsInBothDirections:
    @pytest.mark.parametrize(('second', 'kept'), [
        ('2026-02-01', '2026-02-01'),  # equal: unchanged
        ('2026-01-31', '2026-02-01'),  # older: unchanged
        ('2026-02-02', '2026-02-02'),  # newer: replaces
    ])
    def test_record_stop(self, second, kept):
        budget = WalkBudget(seconds=10, clock=FakeClock())
        budget.record_stop('2026-02-01')
        budget.record_stop(second)

        assert budget.scanned_through == kept
        assert budget.partial_fields() == {
            'partial_reason': 'time_budget',
            'scanned_through': kept,
        }

    def test_the_first_stop_is_kept_whatever_its_date(self):
        budget = WalkBudget(seconds=10, clock=FakeClock())
        budget.record_stop('1999-01-01')

        assert budget.scanned_through == '1999-01-01'
        assert budget.stopped is True
