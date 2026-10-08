"""The ``channel``, ``dims`` and ``tag`` feedback filters, shared by every read route.

``channel=<source_channel>`` is an exact match; ``dims=key:value[,key:value...]``
requires every pair (AND; value matched ignoring case, the stored spelling being
the configured one); ``tag=<tag>`` requires the item's ``tags`` to contain it,
ignoring case. All three are post-query filters: they force a route off its
pre-aggregated counters and onto the item path, like ``sentiment``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from shared.dimension_config import parse_dims_param

__all__ = ['NO_ITEM_FILTERS', 'ItemFilters', 'parse_item_filters']


@dataclass(frozen=True)
class ItemFilters:
    """The parsed filters; an instance with nothing set admits every item."""

    channel: str | None = None
    dims: Mapping[str, str] = field(default_factory=dict)
    tag: str | None = None

    @property
    def active(self) -> bool:
        return bool(self.channel or self.dims or self.tag)

    def admits(self, item: Mapping[str, Any]) -> bool:
        if self.channel and item.get('source_channel') != self.channel:
            return False
        if self.dims and not _has_dimensions(item, self.dims):
            return False
        return not self.tag or _has_tag(item, self.tag)

    def filter(self, items: list[Any]) -> list[Any]:
        """``items`` this admits, in order (``items`` itself when no filter is set)."""
        return [item for item in items if self.admits(item)] if self.active else items


# The no-op filter (an immutable default for optional parameters).
NO_ITEM_FILTERS = ItemFilters()


def _has_dimensions(item: Mapping[str, Any], wanted: Mapping[str, str]) -> bool:
    stored = item.get('dimensions')
    if not isinstance(stored, Mapping):
        return False
    for key, value in wanted.items():
        actual = stored.get(key)
        if not isinstance(actual, str) or actual.casefold() != value.casefold():
            return False
    return True


def _has_tag(item: Mapping[str, Any], wanted: str) -> bool:
    tags = item.get('tags')
    if not isinstance(tags, list):
        return False
    folded = wanted.casefold()
    return any(isinstance(tag, str) and tag.casefold() == folded for tag in tags)


def _text_param(params: Mapping[str, Any], name: str) -> str | None:
    value = params.get(name)
    if not isinstance(value, str):
        return None
    return value.strip() or None


def parse_item_filters(params: Mapping[str, Any] | None) -> ItemFilters:
    """The filters a query string asks for; ValueError (client-safe) on a malformed ``dims``."""
    params = params or {}
    raw_dims = params.get('dims')
    return ItemFilters(
        channel=_text_param(params, 'channel'),
        dims=parse_dims_param(raw_dims if isinstance(raw_dims, str) else None),
        tag=_text_param(params, 'tag'),
    )
