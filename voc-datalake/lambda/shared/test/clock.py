"""Test-side reads of the real UTC clock.

A module-level ``TODAY = datetime.now(UTC)...`` is computed once at import. A suite
that starts before 00:00 UTC and reaches the test after it seeds YESTERDAY's
partition, while the handler under test queries today's — every count reads 0.
Call ``today_utc()`` where the date is used instead.
"""
from datetime import UTC, datetime


def today_utc() -> str:
    """Today's ``YYYY-MM-DD`` in UTC, read at the call."""
    return datetime.now(UTC).strftime('%Y-%m-%d')
