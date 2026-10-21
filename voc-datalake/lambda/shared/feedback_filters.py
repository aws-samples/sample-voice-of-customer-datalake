"""One feedback filter model shared by every read path.

The dashboard pages, the long-running project tasks and chat all narrow feedback
by the same dimensions. Before this module each endpoint parsed its own subset
(single-valued `source`/`category`/`sentiment`, `cf_*` in one place only), so a
filter could mean one thing on the list and another on the metrics. Every reader
now parses into `FeedbackFilters` and calls `matches()`.

Wire format (query params, and the same keys in JSON bodies):

    source=a,b            source_platform IN (a, b)
    category=x,y          category IN (x, y)
    subcategory=s         subcategory IN (s)
    sentiment=negative    sentiment_label IN (...)
    urgent=true           urgency == 'high'
    <enrichment field>=high,unscored
                          registry field (shared/enrichment_fields.py) IN (...);
                          `unscored` matches items with no stored value
    cf_<key>=<value>      str(custom_fields[key]) IN (...); REPEAT the param for
                          more values (`cf_tier=Gold&cf_tier=Platinum`), AND
                          across keys — in a JSON body,
                          `custom_fields: {key: [v1, v2]}` (or a single string)

The other multi-value dimensions are comma-separated: every value in them is a
slug or an enum (source_platform is `^[a-z][a-z0-9_]*$`, categories are
admin-configured slugs, sentiments and registry fields are enums). Custom-field
values are free text that may contain commas ("Las Vegas, NV"), so they are never
comma-split; several values arrive as a repeated `cf_<key>`, which API Gateway
exposes only through `multiValueQueryStringParameters` — pass that view to
`from_mapping` too.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from typing import Any

from shared.enrichment_fields import ENRICHMENT_FIELDS, UNSCORED, item_value
from shared.exceptions import ValidationError

CUSTOM_FIELD_FILTER_PREFIX = 'cf_'

# Bounds on what one request may ask for. Values are matched in memory (and the
# source list is pushed down as a DynamoDB IN, which accepts at most 100
# operands), so these keep a crafted URL from turning one request into an
# unbounded comparison loop or an invalid expression.
MAX_FILTER_VALUES = 50
MAX_FILTER_VALUE_LENGTH = 128
MAX_CUSTOM_FIELD_FILTERS = 10

URGENT_VALUE = 'high'
_TRUE_STRINGS = frozenset({'true', '1', 'yes'})

# (wire key, item attribute) for the plain multi-value dimensions, in the order
# `to_dict` emits them.
_LIST_DIMENSIONS: tuple[tuple[str, str], ...] = (
    ('source', 'source_platform'),
    ('category', 'category'),
    ('subcategory', 'subcategory'),
    ('sentiment', 'sentiment_label'),
)


def _bounded_unique(key: str, texts: Iterable[str]) -> tuple[str, ...]:
    """De-duplicated, order-preserving values, within the per-dimension bounds."""
    seen: dict[str, None] = {}
    for text in texts:
        if len(text) > MAX_FILTER_VALUE_LENGTH:
            raise ValidationError(
                f'{key} filter values must be at most {MAX_FILTER_VALUE_LENGTH} characters'
            )
        seen[text] = None
    if len(seen) > MAX_FILTER_VALUES:
        raise ValidationError(f'{key} filter accepts at most {MAX_FILTER_VALUES} values')
    return tuple(seen)


def _clean_values(key: str, raw: Iterable[Any]) -> tuple[str, ...]:
    """Trimmed, non-empty string values, bounded (slug and enum dimensions)."""
    texts = (str(value).strip() for value in raw if value is not None)
    return _bounded_unique(key, (text for text in texts if text))


def _split_param(value: Any) -> list[Any]:
    """A wire value as a list: comma-split strings, lists/tuples passed through."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return str(value).split(',')


def _clean_custom_values(key: str, raw: Any) -> tuple[str, ...]:
    """One custom field's selected values: str()'d, de-duplicated, bounded.

    Deliberately NOT trimmed or comma-split, unlike `_clean_values`: the match is
    `str(stored) == wanted`, so `"EMEA "` and `"Las Vegas, NV"` must reach it
    exactly as stored. Empty values are dropped (`cf_region=` is the UI's "no
    selection" and must not filter everything out).
    """
    values = raw if isinstance(raw, (list, tuple)) else [raw]
    return _bounded_unique(key, (str(value) for value in values if value is not None and value != ''))


def parse_custom_field_filters(
    params: Mapping[str, Any],
    multi_params: Mapping[str, Sequence[str]] | None = None,
) -> dict[str, tuple[str, ...]]:
    """Pull `cf_<key>` params into a ``{key: (value, ...)}`` map.

    A repeated `cf_<key>` reaches the single-value view as its LAST value only,
    so `multi_params` (API Gateway's `multiValueQueryStringParameters`) wins when
    it carries the key; callers without it (the MCP delegate) send one value per
    key and are read from `params`. A bare `cf_` (empty key) is ignored.
    """
    multi_params = multi_params or {}
    filters: dict[str, tuple[str, ...]] = {}
    for raw_key, value in params.items():
        if not isinstance(raw_key, str) or not raw_key.startswith(CUSTOM_FIELD_FILTER_PREFIX):
            continue
        key = raw_key[len(CUSTOM_FIELD_FILTER_PREFIX):]
        if not key:
            continue
        values = _clean_custom_values(raw_key, multi_params.get(raw_key, value))
        if values:
            filters[key] = values
    if len(filters) > MAX_CUSTOM_FIELD_FILTERS:
        raise ValidationError(f'At most {MAX_CUSTOM_FIELD_FILTERS} custom-field filters are allowed')
    return filters


def item_matches_custom_fields(
    item: Mapping[str, Any], cf_filters: Mapping[str, Sequence[str]],
) -> bool:
    """True when `item`'s custom_fields satisfy every selected key (AND across
    keys, any of a key's values).

    Compares `str(stored)` against the requested strings, so a numeric field and
    its string twin match the same selection. A missing field, a null value, or an
    item with no `custom_fields` map fails the match.
    """
    if not cf_filters:
        return True
    fields = item.get('custom_fields')
    if not isinstance(fields, dict):
        return False
    for key, wanted in cf_filters.items():
        # A bare string is one value, never a substring test.
        allowed = (wanted,) if isinstance(wanted, str) else wanted
        stored = fields.get(key)
        if stored is None or str(stored) not in allowed:
            return False
    return True


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return isinstance(value, str) and value.strip().lower() in _TRUE_STRINGS


def _parse_enrichment(data: Mapping[str, Any]) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """Registry-field selections, validated against each field's declared values."""
    parsed: list[tuple[str, tuple[str, ...]]] = []
    for ef in ENRICHMENT_FIELDS:
        values = _clean_values(ef.name, (str(v).lower() for v in _split_param(data.get(ef.name))))
        allowed = (*ef.values, UNSCORED)
        if any(v not in allowed for v in values):
            raise ValidationError(f'{ef.name} must be one of: {", ".join(allowed)}')
        if values:
            parsed.append((ef.name, values))
    return tuple(parsed)


def _parse_custom(
    data: Mapping[str, Any], multi_params: Mapping[str, Sequence[str]] | None,
) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """Custom-field selections from a body map or `cf_*` params, as sorted pairs."""
    body_map = data.get('custom_fields')
    if isinstance(body_map, Mapping):
        source = {f'{CUSTOM_FIELD_FILTER_PREFIX}{k}': v for k, v in body_map.items()}
        return tuple(sorted(parse_custom_field_filters(source).items()))
    return tuple(sorted(parse_custom_field_filters(data, multi_params).items()))


@dataclass(frozen=True)
class FeedbackFilters:
    """A parsed, validated set of feedback filters. Empty dimensions mean "any".

    Every field is an immutable tuple, so instances are hashable and safe to use
    as cache keys.
    """

    sources: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()
    subcategories: tuple[str, ...] = ()
    sentiments: tuple[str, ...] = ()
    urgent_only: bool = False
    # (field name, allowed values) for registry enrichment fields.
    enrichment: tuple[tuple[str, tuple[str, ...]], ...] = ()
    # (key, allowed values) custom-field selections, sorted by key.
    custom_fields: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @classmethod
    def from_mapping(
        cls,
        data: Mapping[str, Any] | None,
        multi_values: Mapping[str, Sequence[str]] | None = None,
    ) -> FeedbackFilters:
        """Parse query params (comma strings) or a JSON body (lists or strings).

        `multi_values` is the request's multi-value query view, needed only for a
        repeated `cf_<key>`; see the module docstring.

        Raises ValidationError (a 400 through the API resolver) on values that
        exceed the bounds or name an undeclared enrichment value.
        """
        data = data or {}
        lists = {key: _clean_values(key, _split_param(data.get(key))) for key, _ in _LIST_DIMENSIONS}
        return cls(
            sources=lists['source'],
            categories=lists['category'],
            subcategories=lists['subcategory'],
            sentiments=lists['sentiment'],
            urgent_only=_truthy(data.get('urgent')),
            enrichment=_parse_enrichment(data),
            custom_fields=_parse_custom(data, multi_values),
        )

    @cached_property
    def custom_field_map(self) -> dict[str, tuple[str, ...]]:
        # Cached: `matches` runs once per candidate item. cached_property writes the
        # instance __dict__ directly, which a frozen dataclass permits.
        return dict(self.custom_fields)

    @property
    def is_empty(self) -> bool:
        return not (self.sources or self.has_post_filters)

    @property
    def has_post_filters(self) -> bool:
        """Anything beyond the source list (which can be pushed down to DynamoDB)."""
        return bool(
            self.categories or self.subcategories or self.sentiments
            or self.urgent_only or self.enrichment or self.custom_fields
        )

    def enrichment_values(self, name: str) -> tuple[str, ...]:
        return next((values for field_name, values in self.enrichment if field_name == name), ())

    def _list_values(self) -> tuple[tuple[str, ...], ...]:
        """The plain multi-value dimensions, aligned with `_LIST_DIMENSIONS`."""
        return (self.sources, self.categories, self.subcategories, self.sentiments)

    def matches(self, item: Mapping[str, Any]) -> bool:
        """True when `item` satisfies every active dimension (AND across, OR within)."""
        for (_, attribute), allowed in zip(_LIST_DIMENSIONS, self._list_values()):
            if allowed and item.get(attribute) not in allowed:
                return False
        if self.urgent_only and item.get('urgency') != URGENT_VALUE:
            return False
        for ef in ENRICHMENT_FIELDS:
            allowed = self.enrichment_values(ef.name)
            if allowed and item_value(item, ef) not in allowed:
                return False
        return item_matches_custom_fields(item, self.custom_field_map)

    def attribute_paths(self) -> tuple[tuple[str, ...], ...]:
        """The item attribute paths `matches` reads for the ACTIVE dimensions.

        For projections: a read that keeps only these gets the same `matches`
        answer as one that keeps everything. A custom field is the nested path
        `('custom_fields', key)`, so a read keeps that one key rather than the
        whole map. Lives beside `matches` so the two cannot disagree about what
        is read.
        """
        paths: list[tuple[str, ...]] = [
            (attribute,)
            for (_, attribute), allowed in zip(_LIST_DIMENSIONS, self._list_values())
            if allowed
        ]
        if self.urgent_only:
            paths.append(('urgency',))
        paths.extend((name,) for name, values in self.enrichment if values)
        paths.extend(('custom_fields', key) for key, _ in self.custom_fields)
        return tuple(paths)

    def without_sources(self) -> FeedbackFilters:
        """The same filters minus the source list — for callers that pushed it down."""
        return FeedbackFilters(
            categories=self.categories,
            subcategories=self.subcategories,
            sentiments=self.sentiments,
            urgent_only=self.urgent_only,
            enrichment=self.enrichment,
            custom_fields=self.custom_fields,
        )

    def to_dict(self) -> dict[str, Any]:
        """JSON-serializable form (lists), accepted back by `from_mapping`.

        Only active dimensions are emitted, so a stored job selection names exactly
        what narrowed it.
        """
        out: dict[str, Any] = {
            key: list(values)
            for (key, _), values in zip(_LIST_DIMENSIONS, self._list_values())
            if values
        }
        if self.urgent_only:
            out['urgent'] = True
        for name, values in self.enrichment:
            out[name] = list(values)
        if self.custom_fields:
            out['custom_fields'] = {key: list(values) for key, values in self.custom_fields}
        return out
