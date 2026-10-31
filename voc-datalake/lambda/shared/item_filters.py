"""The ``channel``, ``dims``, ``tag``, star-rating and urgent feedback filters, shared by every read route.

``channel=<source_channel>`` is an exact match; ``dims=key:value[,key:value...]``
requires every pair (AND; value matched ignoring case, the stored spelling being
the configured one; ``key:a|b`` accepts either value, and the choice ``~unset``
accepts an item with no value for the key); ``tag=<tag>`` requires the item's ``tags`` to contain it,
ignoring case; ``rating_min`` / ``rating_max`` (whole stars, 1-5, inclusive) bound
the item's ``rating``, and an unrated item is refused once either bound is set
("3 stars and below" implies the item was rated); ``urgent=1`` admits only
``urgency == 'high'`` items (the Categories page's "Urgent only", so its
distribution and gauge count what its list shows). All are post-query filters:
they force a route off its pre-aggregated counters and onto the item path, like
``sentiment``.

``channel`` is ALSO pushed into the day walks' DynamoDB FilterExpression
(:meth:`ItemFilters.row_condition`): the walks stop at a candidate cap, so a
filter applied only in memory found nothing for a small channel whose rows sat
past the cap in a big import (a 26,000-row CSV day: ``channel=google_play`` had
70 reviews and listed 0). ``urgent`` is pushed down the same way. ``dims`` and
``tag`` match ignoring case, which a FilterExpression cannot do, so they stay in memory.

The list facets ``source``, ``category``, ``subcategory``, ``sentiment`` and ``usefulness``
(``shared/item_facets.py``) take one value or a comma-separated any-of list. The sources are
pushed down through :meth:`ItemFilters.source_condition` (every index projects
``source_platform``), the others through :meth:`ItemFilters.row_condition`. ``category=other``
needs the configured categories: bind them with :meth:`ItemFilters.with_configured`.
"""

from __future__ import annotations

import operator
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation
from functools import lru_cache, reduce
from typing import Any

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.category_scope_query import combine
from shared.dimension_config import parse_dims_param
from shared.item_facets import (
    SENTIMENT_VALUES,
    USEFULNESS_VALUES,
    any_of,
    category_admits,
    facet_condition,
    parse_facet,
    usefulness_admits,
)

__all__ = ['NO_ITEM_FILTERS', 'ItemFilters', 'parse_item_filters']

# Whole-star bounds a rating filter accepts (the UI's 1-5 star picker).
MIN_STARS = 1
MAX_STARS = 5
# `dims=feedback_type:bug|service_failure`: several values of one key, any may match
# (DIMENSION_VALUE_RE already admits `|`, so the pair parses unchanged), and the
# reserved choice `~unset` admits an item that has no value for the key at all (the
# Problems page's "Problems only" keeps reviews not typed yet).
DIMS_ANY_SEPARATOR = '|'
DIMS_UNSET_VALUE = '~unset'
# The stored urgency `urgent=1` admits, and the query values that switch it on.
URGENT_LEVEL = 'high'
_URGENT_ON = frozenset({'1', 'true'})


@dataclass(frozen=True)
class ItemFilters:
    """The parsed filters; an instance with nothing set admits every item."""

    channel: str | None = None
    dims: Mapping[str, str] = field(default_factory=dict)
    tag: str | None = None
    rating_min: int | None = None
    rating_max: int | None = None
    urgent: bool = False
    # The list facets (shared/item_facets.py): empty = any; several values = any of them.
    sources: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    subcategories: tuple[str, ...] = ()
    sentiments: tuple[str, ...] = ()
    usefulness: tuple[str, ...] = ()
    # The configured category names, for `category=other`; None = exact category matches only.
    configured_categories: frozenset[str] | None = None

    @property
    def active(self) -> bool:
        return bool(self.channel or self.dims or self.tag or self.rates or self.urgent or self.sources
                    or self.has_facets)

    @property
    def has_facets(self) -> bool:
        """True when a list facet other than ``source`` is set."""
        return bool(self.categories or self.subcategories or self.sentiments or self.usefulness)

    @property
    def channel_index_serves(self) -> bool:
        """True when ``gsi5-by-channel`` rows carry every attribute these filters read (not ``usefulness``)."""
        return not self.usefulness

    def with_configured(self, configured: Iterable[str]) -> ItemFilters:
        """These filters with the configured categories bound (``category=other``); unchanged without categories."""
        return replace(self, configured_categories=frozenset(configured)) if self.categories else self

    def without_sources(self) -> ItemFilters:
        """The same filters minus the source list (a route that fixes its own source)."""
        return replace(self, sources=())

    @property
    def rates(self) -> bool:
        """True when a star-rating bound is set."""
        return self.rating_min is not None or self.rating_max is not None

    def admits(self, item: Mapping[str, Any]) -> bool:
        if self.channel and item.get('source_channel') != self.channel:
            return False
        if not self._facets_admit(item):
            return False
        if self.urgent and item.get('urgency') != URGENT_LEVEL:
            return False
        if self.dims and not _has_dimensions(item, self.dims):
            return False
        if self.rates and not self._rating_admits(item.get('rating')):
            return False
        return not self.tag or _has_tag(item, self.tag)

    def _facets_admit(self, item: Mapping[str, Any]) -> bool:
        if self.sources and item.get('source_platform') not in self.sources:
            return False
        if self.categories and not category_admits(item, self.categories, self.configured_categories):
            return False
        if self.subcategories and item.get('subcategory') not in self.subcategories:
            return False
        if self.sentiments and item.get('sentiment_label') not in self.sentiments:
            return False
        return not self.usefulness or usefulness_admits(item, self.usefulness)

    def _rating_admits(self, raw: object) -> bool:
        rating = _rating_value(raw)
        if rating is None:
            return False
        if self.rating_min is not None and rating < self.rating_min:
            return False
        return self.rating_max is None or rating <= self.rating_max

    def row_condition(self) -> ConditionBase | None:
        """What a DynamoDB FilterExpression can apply of these filters (channel, urgent, list facets), or None.

        Only for an index that projects ALL (``gsi1-by-date``, ``gsi2-by-category``;
        ``gsi3-by-urgency`` and ``gsi5-by-channel`` do not). The sources are NOT in it:
        see :meth:`source_condition`. Callers still apply :meth:`filter` in memory.
        """
        conditions = [
            *([Attr('source_channel').eq(self.channel)] if self.channel else []),
            *([Attr('urgency').eq(URGENT_LEVEL)] if self.urgent else []),
        ]
        own = reduce(operator.and_, conditions) if conditions else None
        if not self.has_facets:
            return own
        return combine(own, facet_condition(
            categories=self.categories, subcategories=self.subcategories, sentiments=self.sentiments,
            usefulness=self.usefulness, configured=self.configured_categories))

    def source_condition(self) -> ConditionBase | None:
        """``source_platform`` in the requested sources (``=`` for one), or None; every index projects it."""
        return any_of('source_platform', self.sources)

    def filter(self, items: list[Any]) -> list[Any]:
        """``items`` this admits, in order (``items`` itself when no filter is set)."""
        return [item for item in items if self.admits(item)] if self.active else items


# The no-op filter (an immutable default for optional parameters).
NO_ITEM_FILTERS = ItemFilters()


@lru_cache(maxsize=256)
def dimension_choices(value: str) -> tuple[str, ...]:
    """The values one ``dims`` pair accepts: ``bug|service_failure`` = either (OR within a key).

    The whole spelling is kept as a choice too, so a configured value that itself
    contains ``|`` still matches exactly as before multi-value pairs existed.
    """
    parts = tuple(part for part in value.split(DIMS_ANY_SEPARATOR) if part)
    return parts if value in parts else (value, *parts)


def _dimension_admits(actual: object, wanted: str) -> bool:
    """One key: the stored value is one of the choices, or unset when ``~unset`` is a choice."""
    choices = dimension_choices(wanted)
    if not isinstance(actual, str) or not actual:
        return DIMS_UNSET_VALUE in choices
    folded = actual.casefold()
    return any(choice.casefold() == folded for choice in choices)


def _has_dimensions(item: Mapping[str, Any], wanted: Mapping[str, str]) -> bool:
    stored = item.get('dimensions')
    stored = stored if isinstance(stored, Mapping) else {}
    return all(_dimension_admits(stored.get(key), value) for key, value in wanted.items())


def _has_tag(item: Mapping[str, Any], wanted: str) -> bool:
    tags = item.get('tags')
    if not isinstance(tags, list):
        return False
    folded = wanted.casefold()
    return any(isinstance(tag, str) and tag.casefold() == folded for tag in tags)


def _rating_value(raw: object) -> Decimal | None:
    """A stored rating as a number; None when absent, unparsable or not above zero (unrated)."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str, Decimal)):
        return None
    try:
        value = Decimal(str(raw))
    except InvalidOperation:
        return None
    return value if value.is_finite() and value > 0 else None


def _stars_param(params: Mapping[str, Any], name: str) -> int | None:
    """A whole-star bound (1-5); None when absent or blank, ValueError otherwise."""
    value = _text_param(params, name)
    if value is None:
        return None
    if not value.isdigit() or not MIN_STARS <= int(value) <= MAX_STARS:
        raise ValueError(f'{name} must be a whole number of stars from {MIN_STARS} to {MAX_STARS}')
    return int(value)


def _text_param(params: Mapping[str, Any], name: str) -> str | None:
    value = params.get(name)
    if not isinstance(value, str):
        return None
    return value.strip() or None


def parse_item_filters(params: Mapping[str, Any] | None) -> ItemFilters:
    """The filters a query string asks for.

    ValueError (client-safe) on a malformed ``dims``, a rating bound, or a list facet past its
    bounds / with an unknown ``sentiment`` or ``usefulness`` value.
    """
    params = params or {}
    raw_dims = params.get('dims')
    return ItemFilters(
        sources=parse_facet(params, 'source'),
        categories=parse_facet(params, 'category'),
        subcategories=parse_facet(params, 'subcategory'),
        sentiments=parse_facet(params, 'sentiment', SENTIMENT_VALUES),
        usefulness=parse_facet(params, 'usefulness', USEFULNESS_VALUES),
        channel=_text_param(params, 'channel'),
        dims=parse_dims_param(raw_dims if isinstance(raw_dims, str) else None),
        tag=_text_param(params, 'tag'),
        rating_min=_stars_param(params, 'rating_min'),
        rating_max=_stars_param(params, 'rating_max'),
        urgent=(_text_param(params, 'urgent') or '').lower() in _URGENT_ON,
    )
