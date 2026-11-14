"""A Lambda context for the self-invoking jobs' tests (the workspace export and the workspace delete): its time runs
low after a given number of looks at the clock, so a test drives a hand-over at any point."""
from __future__ import annotations


class LambdaBudget:
    """A Lambda context whose time runs low after ``checks`` looks at the clock (one invocation's budget); None:
    it never runs low. A job's test names its function (``function_name``) in a subclass."""

    function_name = 'voc-job'

    def __init__(self, checks: int | None = None) -> None:
        self._left = checks

    def get_remaining_time_in_millis(self) -> int:
        if self._left is None:
            return 900_000
        self._left -= 1
        return 900_000 if self._left >= 0 else 60_000
