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
"""

from __future__ import annotations

import operator
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from functools import lru_cache, reduce
from typing import Any

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.dimension_config import parse_dims_param

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

    @property
    def active(self) -> bool:
        return bool(self.channel or self.dims or self.tag or self.rates or self.urgent)

    @property
    def rates(self) -> bool:
        """True when a star-rating bound is set."""
        return self.rating_min is not None or self.rating_max is not None

    def admits(self, item: Mapping[str, Any]) -> bool:
        if self.channel and item.get('source_channel') != self.channel:
            return False
        if self.urgent and item.get('urgency') != URGENT_LEVEL:
            return False
        if self.dims and not _has_dimensions(item, self.dims):
            return False
        if self.rates and not self._rating_admits(item.get('rating')):
            return False
        return not self.tag or _has_tag(item, self.tag)

    def _rating_admits(self, raw: object) -> bool:
        rating = _rating_value(raw)
        if rating is None:
            return False
        if self.rating_min is not None and rating < self.rating_min:
            return False
        return self.rating_max is None or rating <= self.rating_max

    def row_condition(self) -> ConditionBase | None:
        """The part of these filters a DynamoDB FilterExpression can apply exactly (channel, urgent), or None.

        Only for an index that projects ``source_channel`` and ``urgency`` (``gsi1-by-date``,
        ``gsi2-by-category`` project ALL; ``gsi3-by-urgency`` does not). Callers
        still apply :meth:`filter` in memory.
        """
        conditions = [
            *([Attr('source_channel').eq(self.channel)] if self.channel else []),
            *([Attr('urgency').eq(URGENT_LEVEL)] if self.urgent else []),
        ]
        return reduce(operator.and_, conditions) if conditions else None

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
    """The filters a query string asks for; ValueError (client-safe) on a malformed ``dims`` or rating bound."""
    params = params or {}
    raw_dims = params.get('dims')
    return ItemFilters(
        channel=_text_param(params, 'channel'),
        dims=parse_dims_param(raw_dims if isinstance(raw_dims, str) else None),
        tag=_text_param(params, 'tag'),
        rating_min=_stars_param(params, 'rating_min'),
        rating_max=_stars_param(params, 'rating_max'),
        urgent=(_text_param(params, 'urgent') or '').lower() in _URGENT_ON,
    )
