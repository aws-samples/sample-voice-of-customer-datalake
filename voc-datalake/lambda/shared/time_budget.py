"""Wall-clock budget for per-day `gsi1-by-date` walks.

`gsi1-by-date` is partitioned BY DAY, so a window of N days costs N queries. With
windows up to `MAX_FEEDBACK_WINDOW_DAYS` (and 0 = all time) the day count can no
longer bound a request's duration, so the walk is bounded by TIME instead: it stops
once `WALK_TIME_BUDGET_SECONDS` have elapsed and the response says so —
`is_partial: true`, `partial_reason: 'time_budget'`, `scanned_through: 'YYYY-MM-DD'`
(the oldest day that WAS read in full).

The budget leaves `API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS - WALK_TIME_BUDGET_SECONDS`
seconds of margin for the work after the walk (filtering, serialisation) and the
single in-flight query that may straddle the deadline. `lib/stacks/api-stack.test.ts`
reads both constants from this file and pins them against the metrics Lambda timeout.
"""
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

# API Gateway abandons a REST integration after 29 s whatever the Lambda's timeout.
API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS = 29

# Total wall-clock time one request may spend walking day partitions.
WALK_TIME_BUDGET_SECONDS = 20

TIME_BUDGET_PARTIAL_REASON = 'time_budget'


class WalkBudget:
    """One request's walk budget. Shared by every walk the request performs.

    `clock` is injectable so tests can exhaust the budget deterministically.
    """

    # The newest date a walk of this request fully read before stopping; None while no walk stopped.
    scanned_through: str | None

    def __init__(
        self,
        seconds: float = WALK_TIME_BUDGET_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._clock = clock
        self._deadline = clock() + seconds
        self.scanned_through = None

    @property
    def stopped(self) -> bool:
        """True once any walk of this request ended early on the budget."""
        return self.scanned_through is not None

    def exhausted(self) -> bool:
        return self._clock() >= self._deadline

    def record_stop(self, scanned_through: str) -> None:
        """Note that a walk stopped after fully reading `scanned_through`.

        With several walks in one request the NEWEST stop date wins: the response
        can only claim completeness back to the least-covered walk.
        """
        self.scanned_through = max(self.scanned_through or '', scanned_through)

    def partial_fields(self) -> dict[str, str]:
        """`{partial_reason, scanned_through}` when the budget cut a walk short, else `{}`."""
        if self.scanned_through is None:
            return {}
        return {
            'partial_reason': TIME_BUDGET_PARTIAL_REASON,
            'scanned_through': self.scanned_through,
        }


def budgeted_days(
    days: int, budget: WalkBudget, today: datetime | None = None,
) -> Iterator[str]:
    """Yield the window's dates ('YYYY-MM-DD'), newest first, while the budget lasts.

    The first day is always yielded, so every walk reads at least today. When the
    budget runs out before the window does, the walk stops, `budget.record_stop`
    is called with the last date yielded, and the caller sees `budget.stopped`.
    A caller that breaks out early for its own reason (a soft cap) is unaffected.
    """
    current = today or datetime.now(UTC)
    previous: str | None = None  # pragma: no mutate  a local annotation is never evaluated; `&` here is equivalent
    for i in range(days):
        if previous is not None and budget.exhausted():
            budget.record_stop(previous)
            return
        date = (current - timedelta(days=i)).strftime('%Y-%m-%d')
        yield date
        previous = date
