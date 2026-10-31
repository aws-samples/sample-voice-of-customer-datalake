"""The multi-value list facets of :class:`shared.item_filters.ItemFilters`: parsing and push-down.

``source``, ``category``, ``subcategory``, ``sentiment`` and ``usefulness`` each take one
value or a comma-separated list, and a list means ANY of its values (OR within a facet,
AND across facets, like every other filter). One value means exactly what it meant
before lists existed. Ported from PR #429's ``shared/feedback_filters.py`` (@aws-bryan),
fitted to main's ``ItemFilters``.

Bounds: at most :data:`MAX_FACET_VALUES` values of at most :data:`MAX_FACET_VALUE_CHARS`
characters per facet, so a crafted URL cannot become an unbounded comparison loop or a
DynamoDB ``IN`` past its 100 operands. ``sentiment`` and ``usefulness`` are enums and
refuse an unknown value; sources and categories are open (an unknown one matches nothing,
and a deep link to a removed category keeps working).

``usefulness`` reads the stored band (``shared.usefulness``); a review without one matches
only the explicit value ``unrated`` (:data:`USEFULNESS_UNRATED`), never a band.

The caller's category and source access is NOT decided here: every route still applies its
scope after these filters, so a list can only narrow what the caller may see.
"""
from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.category_access import item_category
from shared.category_scope_query import combine
from shared.other_category import OTHER, matches_category, other_condition
from shared.usefulness import USEFULNESS_BANDS, USEFULNESS_FIELD, USEFULNESS_UNRATED, stored_band

__all__ = [
    'SENTIMENT_VALUES',
    'USEFULNESS_VALUES',
    'any_of',
    'category_admits',
    'facet_condition',
    'parse_facet',
    'usefulness_admits',
]

MAX_FACET_VALUES: Final = 50
MAX_FACET_VALUE_CHARS: Final = 128
SENTIMENT_VALUES: Final = ('positive', 'neutral', 'negative', 'mixed')
#: What ``usefulness=`` accepts: the stored bands plus ``unrated`` (no band stored).
USEFULNESS_VALUES: Final = (*USEFULNESS_BANDS, USEFULNESS_UNRATED)
_SEPARATOR: Final = ','


def parse_facet(
    params: Mapping[str, Any], name: str, allowed: Collection[str] | None = None,
) -> tuple[str, ...]:
    """``name``'s values: comma-split, trimmed, de-duplicated in order; ``()`` when absent or blank.

    A non-string value is ignored, like the other item filters. ValueError (client-safe)
    past the bounds or on a value outside ``allowed``.
    """
    raw = params.get(name)
    if not isinstance(raw, str):
        return ()
    values = tuple(dict.fromkeys(part.strip() for part in raw.split(_SEPARATOR) if part.strip()))
    if len(values) > MAX_FACET_VALUES:
        raise ValueError(f'{name} accepts at most {MAX_FACET_VALUES} values')
    if any(len(value) > MAX_FACET_VALUE_CHARS for value in values):
        raise ValueError(f'{name} values must be at most {MAX_FACET_VALUE_CHARS} characters')
    if allowed is not None and any(value not in allowed for value in values):
        raise ValueError(f'{name} must be one or more of: {", ".join(allowed)}')
    return values


def any_of(attribute: str, values: Sequence[str]) -> ConditionBase | None:
    """``attribute`` equal to one of ``values`` (``=`` for one, ``IN`` for several); None for none."""
    if not values:
        return None
    return Attr(attribute).eq(values[0]) if len(values) == 1 else Attr(attribute).is_in(list(values))


def category_admits(item: Mapping[str, Any], wanted: Sequence[str], configured: Collection[str] | None) -> bool:
    """True when ``item`` is under one of ``wanted``.

    With the configuration known, ``other`` also admits every review no configured category
    claims (``shared.other_category``); without it every value is an exact match.
    """
    if configured is None:
        return item_category(item) in wanted
    return any(matches_category(item, name, configured) for name in wanted)


def category_condition(wanted: Sequence[str], configured: Collection[str] | None) -> ConditionBase | None:
    """A FilterExpression a ``category`` list's rows pass; None when it cannot be expressed.

    Only an optimisation of what a walk READS: callers still apply :func:`category_admits`.
    """
    named = [name for name in wanted if name != OTHER]
    if len(named) == len(wanted):
        return any_of('category', named)
    other = other_condition(configured) if configured is not None else None
    if other is None:
        return None
    return other | Attr('category').is_in(named) if named else other


def usefulness_admits(item: Mapping[str, Any], wanted: Sequence[str]) -> bool:
    """True when the item's stored band (``unrated`` without one) is one of ``wanted``."""
    return stored_band(item) in wanted


def usefulness_condition(wanted: Sequence[str]) -> ConditionBase | None:
    """The FilterExpression form of :func:`usefulness_admits`; None for no values."""
    bands = [value for value in wanted if value in USEFULNESS_BANDS]
    banded = any_of(USEFULNESS_FIELD, bands)
    if USEFULNESS_UNRATED not in wanted:
        return banded
    unrated = Attr(USEFULNESS_FIELD).not_exists() | ~Attr(USEFULNESS_FIELD).is_in(list(USEFULNESS_BANDS))
    return unrated | banded if banded is not None else unrated


def facet_condition(
    *, categories: Sequence[str], subcategories: Sequence[str], sentiments: Sequence[str],
    usefulness: Sequence[str], configured: Collection[str] | None,
) -> ConditionBase | None:
    """Every non-source facet's FilterExpression, ANDed (None when nothing applies)."""
    return combine(
        category_condition(categories, configured) if categories else None,
        any_of('subcategory', subcategories),
        any_of('sentiment_label', sentiments),
        usefulness_condition(usefulness) if usefulness else None,
    )
