"""Radar counts read from the SAME distinct reviews the review list shows (docs/radar.md).

The daily counters (``RADAR#{brand}#daily_total`` …) are bumped once per STORED copy, so a
file imported twice counted every review twice: the page header said 12 reviews while
"Read all reviews" listed the 6 distinct ones, and a theme said "2 reviews" that opened 1
(wave-4 live finding). These helpers walk the stored reviews with the list's own reader and
its own "same review" rule (``radar_reviews.distinct_reviews``) and the caller's category
scope, so a count and the list behind it can no longer disagree.

Bounded by ``MAX_COUNT_READ`` stored reviews. Past it the window is too large to walk per
request and the caller falls back to the counters (``complete`` is False).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any, Final

from shared.category_access import CategoryScope
from shared.radar_reviews import ReviewFilter, distinct_reviews, scope_admits, written_day
from shared.radar_store import SENTIMENT_LABELS

__all__ = ['ReviewCounts', 'review_counts', 'side_view']

MAX_COUNT_READ: Final = 2000


@dataclass(frozen=True)
class ReviewCounts:
    """Totals, per-sentiment counts and a per-day trend over a set of distinct reviews."""

    items: list[dict[str, Any]]
    complete: bool

    def totals(self) -> dict[str, Any]:
        """``{total, avg_sentiment, sentiment: {label: count}}`` — the shape ``brand_totals`` returns."""
        labels = Counter(str(item.get('sentiment_label') or 'neutral') for item in self.items)
        total = len(self.items)
        score = sum((_score(item) for item in self.items), Decimal(0))
        return {
            'total': total,
            'avg_sentiment': _rounded(score / total) if total else None,
            'sentiment': {label: labels.get(label, 0) for label in SENTIMENT_LABELS},
        }

    def category_sides(self) -> dict[str, dict[str, Any]]:
        """Per category (``other`` when unset), ``{volume, positive_share, negative_share}``.

        The shape of the compare view's ``theirs`` side, counted from the distinct reviews,
        so a review stored twice is one in the comparison as in the list (wave-9 finding).
        """
        by_category: dict[str, Counter[str]] = {}
        for item in self.items:
            category = str(item.get('category') or 'other')
            by_category.setdefault(category, Counter())[str(item.get('sentiment_label') or 'neutral')] += 1
        return {category: side_view(labels) for category, labels in by_category.items()}

    def trend(self) -> list[dict[str, Any]]:
        """``[{date, count, avg_sentiment}]`` oldest first — the shape ``sentiment_trend`` returns."""
        by_day: dict[str, list[Decimal]] = {}
        for item in self.items:
            by_day.setdefault(written_day(item), []).append(_score(item))
        return [
            {'date': day, 'count': len(scores), 'avg_sentiment': _rounded(sum(scores, Decimal(0)) / len(scores))}
            for day, scores in sorted(by_day.items())
        ]


def review_counts(table: Any, brand: str, start: date, end: date, scope: CategoryScope) -> ReviewCounts:
    """The distinct reviews of ``brand`` in the window that ``scope`` admits (the list's own reading)."""
    items, complete = distinct_reviews(table, brand, admits=scope_admits(scope, ReviewFilter()),
                                       start=start, end=end, cap=MAX_COUNT_READ)
    return ReviewCounts(items, complete)


def side_view(by_label: Mapping[str, int]) -> dict[str, Any]:
    """``{volume, positive_share, negative_share}`` from per-sentiment counts (one compare side)."""
    volume = sum(int(by_label.get(label, 0)) for label in SENTIMENT_LABELS)
    return {
        'volume': volume,
        'positive_share': _rounded(Decimal(int(by_label.get('positive', 0))) / volume) if volume else None,
        'negative_share': _rounded(Decimal(int(by_label.get('negative', 0))) / volume) if volume else None,
    }


def _score(item: dict[str, Any]) -> Decimal:
    raw = item.get('sentiment_score')
    try:
        return Decimal(str(raw)) if raw is not None else Decimal(0)
    except ArithmeticError:
        return Decimal(0)


def _rounded(value: Decimal) -> float:
    return float(round(value, 3))
