"""The "Other" bucket of a category breakdown: every review no configured category claims.

A review is counted under its own category when that category is configured.
Everything else — no category, the processor's ``'other'`` fallback, or a
category that has since been removed from the configuration (a "legacy"
category: prod still stores ``billing``, ``customer_support``, … from an earlier
taxonomy) — is counted under ``'other'``. That is what makes a breakdown add up
to the window's total: before this, ``/metrics/categories`` read only the
configured categories' counters, so the all-time breakdown summed to 16,295
while ``/metrics/summary`` said 17,066 (378 ``other`` + 393 legacy reviews).

The same rule picks which reviews ``category=other`` lists, so clicking the
"Other" row shows the reviews it counts.

Pure functions; no AWS clients. Access is NOT decided here: a restricted caller
still sees a review only when ``category_access.admits`` its stored category.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.category_access import FALLBACK_CATEGORY, item_category
from shared.category_scope_query import MAX_IN_OPERANDS

OTHER: Final = FALLBACK_CATEGORY


def category_bucket(category: object, configured: Collection[str]) -> str:
    """The breakdown row a review filed under ``category`` counts in."""
    name = category if isinstance(category, str) and category else OTHER
    return name if name in configured else OTHER


def item_bucket(item: Mapping[str, Any], configured: Collection[str]) -> str:
    """The breakdown row ``item`` counts in."""
    return category_bucket(item_category(item), configured)


def tally_buckets(items: Iterable[Mapping[str, Any]], configured: Collection[str]) -> dict[str, int]:
    """How many of ``items`` fall in each breakdown row."""
    counts: dict[str, int] = {}
    for item in items:
        bucket = item_bucket(item, configured)
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def fold_counts(counts: Mapping[str, int], configured: Collection[str]) -> dict[str, int]:
    """Per-category counts with every non-configured name merged into ``'other'``; zeros dropped."""
    folded: dict[str, int] = {}
    for name, count in counts.items():
        bucket = category_bucket(name, configured)
        folded[bucket] = folded.get(bucket, 0) + count
    return {name: count for name, count in folded.items() if count > 0}


def matches_category(item: Mapping[str, Any], requested: str, configured: Collection[str]) -> bool:
    """True when ``item`` belongs to the ``category=requested`` filter.

    An item matches its own stored category (a deep link to a legacy name keeps
    working), and ``'other'`` also matches every item outside the configuration.
    """
    stored = item_category(item)
    return stored == requested or (requested == OTHER and category_bucket(stored, configured) == OTHER)


def other_condition(configured: Collection[str]) -> ConditionBase | None:
    """A FilterExpression admitting only rows in the ``'other'`` bucket; None when too large to express.

    An optimisation of what a walk READS: callers still apply ``matches_category``.
    """
    names = sorted(name for name in configured if name != OTHER)
    if not names or len(names) >= MAX_IN_OPERANDS:
        return None
    return Attr('category').not_exists() | ~Attr('category').is_in(names)
