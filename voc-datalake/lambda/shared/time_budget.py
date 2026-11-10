"""Wall-clock budget for per-day `gsi1-by-date` walks.

`gsi1-by-date` is partitioned BY DAY, so a window of N days costs N queries. With
windows up to `MAX_FEEDBACK_WINDOW_DAYS` (and 0 = all time) the day count can no
longer bound a request's duration, so the walk is bounded by TIME instead: it stops
once `WALK_TIME_BUDGET_SECONDS` have elapsed and the response says so —
`is_partial: true`, `partial_reason: 'time_budget'`, `scanned_through: 'YYYY-MM-DD'`
(the oldest day that WAS read in full).

A walk can also stop on a ROW cap (a request holds at most so many rows, a day partition
is read to at most so many rows): then `partial_reason` is `'row_cap'` instead, and
`scanned_through` names the oldest day read in full before the cut, i.e. the day walked
just before the day the cap cut (the cut day itself is NOT claimed). When the cap cuts the
very first day walked, nothing was read in full and `scanned_through` is omitted.

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
ROW_CAP_PARTIAL_REASON = 'row_cap'


class WalkBudget:
    """One request's walk budget. Shared by every walk the request performs.

    `clock` is injectable so tests can exhaust the budget deterministically.
    """

    # The newest date a walk of this request fully read before stopping; None while no walk
    # stopped, or when the least-covered walk read no day in full.
    scanned_through: str | None
    # Why the least-covered walk stopped (`time_budget` / `row_cap`); None while no walk stopped.
    partial_reason: str | None

    def __init__(
        self,
        seconds: float = WALK_TIME_BUDGET_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._clock = clock
        self._deadline = clock() + seconds
        self.scanned_through = None
        self.partial_reason = None

    @property
    def stopped(self) -> bool:
        """True once any walk of this request ended early (on the budget or on a row cap)."""
        return self.partial_reason is not None

    def exhausted(self) -> bool:
        return self._clock() >= self._deadline

    def record_stop(self, scanned_through: str | None, reason: str = TIME_BUDGET_PARTIAL_REASON) -> None:
        """Note that a walk stopped after fully reading `scanned_through` (None: no day in full).

        With several walks in one request the LEAST-covered stop wins (the newest date, and
        a walk that read no day in full beats every date): the response can only claim
        completeness back to the least-covered walk. Its `reason` is the one reported.
        """
        if self.stopped and not self._less_covered(scanned_through):
            return
        self.scanned_through = scanned_through
        self.partial_reason = reason

    def _less_covered(self, scanned_through: str | None) -> bool:
        """True when a stop at `scanned_through` claims less than the stop already recorded."""
        if self.scanned_through is None:
            return False
        return scanned_through is None or scanned_through > self.scanned_through

    def partial_fields(self) -> dict[str, str]:
        """`{partial_reason, scanned_through}` when a walk stopped early, else `{}`.

        `scanned_through` is omitted when the least-covered walk read no day in full.
        """
        if self.partial_reason is None:
            return {}
        fields = {'partial_reason': self.partial_reason}
        if self.scanned_through is not None:
            fields['scanned_through'] = self.scanned_through
        return fields


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
