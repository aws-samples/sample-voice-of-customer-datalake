"""How far back each of a brand's searches looks (docs/radar.md → "News scan").

A brand's scan runs only part of its rotated query plan, so each SEARCH remembers the day it last
ran (``RADARSCAN#{brand}/STATE.since_by_step``, keyed ``<language>:<type>``, ``own_domains``, ``exa``)
and next looks back to that day. A search that never ran (a new brand, a new language, a newly
added source, a query type the rotation has not reached yet) looks back ``LOOKBACK_DAYS``, never
further. Feeds are free and always read over the whole lookback (``lookback``).

An item already filed is merged, not filed again (``shared.radar_releases``), so overlapping
windows only cost a little extra model reading, never a duplicate.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Final

LOOKBACK_DAYS: Final = 90
OWN_DOMAINS_STEP: Final = 'own_domains'
EXA_STEP: Final = 'exa'


def _iso_day(value: object) -> str | None:
    text = str(value or '')[:10]
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


@dataclass(frozen=True)
class BrandWindow:
    """The brand's lookback day, the day each search last ran, and where its plan resumes."""

    lookback: str
    since_by_step: Mapping[str, str] = field(default_factory=dict)
    cursor: int = 0

    def since(self, step: str) -> str:
        """The day ``step`` looks back to: when it last ran, but never before the lookback."""
        return max(self.since_by_step.get(step, self.lookback), self.lookback)


def _stored_days(stored: object) -> dict[str, str]:
    """``since_by_step`` as stored, keeping only valid ISO days."""
    if not isinstance(stored, Mapping):
        return {}
    return {str(step): day for step, raw in stored.items() if (day := _iso_day(raw))}


def _cursor(stored: object) -> int:
    """``query_cursor`` as stored (DynamoDB reads numbers as ``Decimal``); 0 when absent or malformed."""
    if isinstance(stored, bool) or not isinstance(stored, int | float | Decimal):
        return 0
    try:
        return max(int(stored), 0)
    except (ValueError, OverflowError):  # NaN / infinity
        return 0


def brand_window(state: Mapping[str, Any], today: date) -> BrandWindow:
    """The window of a brand from its stored scan state (``{}`` for a brand never scanned)."""
    lookback = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    # A day after today (a clock skew, a hand edit) would ask for nothing: that search looks back the whole lookback.
    days = {step: day for step, day in _stored_days(state.get('since_by_step')).items() if day <= today.isoformat()}
    return BrandWindow(lookback=lookback, since_by_step=days, cursor=_cursor(state.get('query_cursor')))


def next_state(window: BrandWindow, ran_steps: list[str], today: date) -> dict[str, str]:
    """``since_by_step`` after a scan: the searches that ran look back to today next time; the others keep theirs."""
    kept = {step: day for step, day in window.since_by_step.items() if day >= window.lookback}
    return {**kept, **dict.fromkeys(ran_steps, today.isoformat())}
