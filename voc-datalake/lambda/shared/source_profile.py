"""The per-source data-quality profile `GET /metrics/data-quality` answers (docs/data-quality.md).

Three facets per source, each a count per value:

* ``rating``: whole stars ``1``-``5`` (half up), ``none`` for an unrated review or a value
  outside (0, 5];
* ``sentiment``: ``positive`` / ``neutral`` / ``negative`` / ``mixed``, ``other`` for any other label
  (``neutral`` when the item has none, the aggregator's default);
* ``length``: the stored text's length in characters (after the source's privacy policy):
  ``short`` < 50, ``medium`` < 200, ``long`` < 1000, ``very_long`` otherwise.

The same bucketing feeds the aggregator's daily counters (``profile_counter_pks``) and the
item path (``from_items``). Every profiled review has exactly one value per facet, so
``profiled`` is the sum of its rating counts; days before the counters existed have no rows,
and their reviews are the source's total minus ``profiled``. Ported from PR #429 by @aws-bryan
(the per-source profile of his data-quality job), on the counters instead of a scan.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Final

from shared.item_facets import SENTIMENT_VALUES as ITEM_SENTIMENT_VALUES
from shared.metric_keys import (
    PROFILE_LENGTH_PREFIX,
    PROFILE_METRIC_TYPES,
    PROFILE_RATING_PREFIX,
    PROFILE_SENTIMENT_PREFIX,
    source_keyed_counts,
)

RATING_VALUES: Final = ('1', '2', '3', '4', '5', 'none')
KNOWN_SENTIMENTS: Final = ITEM_SENTIMENT_VALUES
SENTIMENT_VALUES: Final = (*KNOWN_SENTIMENTS, 'other')
LENGTH_VALUES: Final = ('short', 'medium', 'long', 'very_long')
#: Upper bounds (exclusive, characters) of every length bucket but the last.
LENGTH_BOUNDS: Final = ((50, 'short'), (200, 'medium'), (1000, 'long'))
MAX_STARS: Final = 5
FACETS: Final = {'rating': RATING_VALUES, 'sentiment': SENTIMENT_VALUES, 'length': LENGTH_VALUES}
FACET_PREFIXES: Final = {
    'rating': PROFILE_RATING_PREFIX, 'sentiment': PROFILE_SENTIMENT_PREFIX, 'length': PROFILE_LENGTH_PREFIX,
}
TEXT_FIELD: Final = 'original_text'
#: The stored fields the item path reads (the route adds them to its slim read).
ITEM_FIELDS: Final = ('rating', 'sentiment_label', TEXT_FIELD)

__all__ = ['FACET_PREFIXES', 'ITEM_FIELDS', 'PROFILE_METRIC_TYPES', 'attach', 'from_counter_rows', 'from_items',
           'profile_counter_pks']


def rating_bucket(raw: object) -> str:
    if isinstance(raw, bool) or not isinstance(raw, int | float | str | Decimal):
        return 'none'
    try:
        value = Decimal(str(raw))
    except InvalidOperation:
        return 'none'
    if not value.is_finite() or value <= 0 or value > MAX_STARS:
        return 'none'
    return str(max(int(value.to_integral_value(rounding=ROUND_HALF_UP)), 1))


def sentiment_bucket(label: object) -> str:
    if label is None:
        return 'neutral'
    return label if isinstance(label, str) and label in KNOWN_SENTIMENTS else 'other'


def length_bucket(text: object) -> str:
    size = len(text) if isinstance(text, str) else 0
    return next((name for bound, name in LENGTH_BOUNDS if size < bound), LENGTH_VALUES[-1])


def profile_values(item: Mapping[str, Any]) -> dict[str, str]:
    return {'rating': rating_bucket(item.get('rating')),
            'sentiment': sentiment_bucket(item.get('sentiment_label')),
            'length': length_bucket(item.get(TEXT_FIELD))}


def profile_counter_pks(item: Mapping[str, Any]) -> list[str]:
    """The item's three daily counter rows, under the same source (and default) as the source row."""
    source = item.get('source_platform', 'unknown')
    return [f'{FACET_PREFIXES[facet]}{source}#{value}' for facet, value in profile_values(item).items()]


def empty_profile() -> dict[str, Any]:
    return {'profiled': 0, **{facet: dict.fromkeys(values, 0) for facet, values in FACETS.items()}}


def _add(profiles: dict[str, dict[str, Any]], source: str, facet: str, value: str, count: int) -> None:
    profile = profiles.setdefault(source, empty_profile())
    if value in profile[facet]:
        profile[facet][value] += max(count, 0)
        if facet == 'rating':
            profile['profiled'] += max(count, 0)


def from_counter_rows(rows: Mapping[str, Mapping[str, int]]) -> dict[str, dict[str, Any]]:
    """Profiles per source from summed counters: ``rows[facet]`` is keyed ``<source>#<value>``.

    The value is the LAST ``#`` segment, so a source name containing ``#`` still parses; an
    unknown value is ignored.
    """
    profiles: dict[str, dict[str, Any]] = {}
    for facet, counts in rows.items():
        if facet not in FACETS:
            continue
        for source, value, count in source_keyed_counts(counts):
            _add(profiles, source, facet, value, count)
    return profiles


def from_items(items: Iterable[Mapping[str, Any]], source_of: Callable[[Mapping[str, Any]], str]) -> dict[str, dict[str, Any]]:
    """Profiles per source of the window's (visible) items; ``source_of`` names an item's source."""
    profiles: dict[str, dict[str, Any]] = {}
    for item in items:
        for facet, value in profile_values(item).items():
            _add(profiles, source_of(item), facet, value, 1)
    return profiles


def _summed(profiles: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    total = empty_profile()
    for profile in profiles:
        total['profiled'] += profile['profiled']
        for facet in FACETS:
            for value, count in profile[facet].items():
                total[facet][value] += count
    return total


def attach(result: dict[str, Any], profiles: Mapping[str, dict[str, Any]]) -> dict[str, Any]:
    """``result`` (the usefulness distribution) with a ``profile`` on every source row and on ``overall``."""
    rows = [{**row, 'profile': profiles.get(row['source'], empty_profile())} for row in result['sources']]
    return {**result, 'sources': rows,
            'overall': {**result['overall'], 'profile': _summed(row['profile'] for row in rows)}}
