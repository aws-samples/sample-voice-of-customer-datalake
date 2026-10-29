"""The per-source usefulness distribution `GET /metrics/data-quality` answers (docs/data-quality.md).

Two inputs give the same shape: the aggregator's daily counters (the source totals and the
``METRIC#daily_usefulness#<source>#<band>`` rows, summed over the window) or the window's
items (a restricted caller, the review-date basis). Unrated = a source's total minus its
banded reviews, so reviews stored before the band existed (no row, no attribute) are counted
as unrated, never dropped.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from shared.usefulness import USEFULNESS_BANDS, USEFULNESS_UNRATED, stored_band

__all__ = ['from_counters', 'from_items']

#: Every count a source (and the overall row) carries, in display order.
QUALITY_FIELDS: Final = (*USEFULNESS_BANDS, USEFULNESS_UNRATED, 'total')


def _row(source: str, bands: Mapping[str, int], total: int) -> dict[str, Any]:
    counts = {band: max(int(bands.get(band, 0)), 0) for band in USEFULNESS_BANDS}
    rated = sum(counts.values())
    # The counters are written by separate updates, so a band row can briefly run ahead of
    # its source row: never answer a negative unrated, and never a total below the bands.
    total = max(total, rated)
    return {'source': source, **counts, USEFULNESS_UNRATED: total - rated, 'total': total}


def _add(bands: dict[str, dict[str, int]], source: str, band: str, count: int) -> None:
    per_source = bands.setdefault(source, {})
    per_source[band] = per_source.get(band, 0) + count


def _source_of(item: Mapping[str, Any]) -> str:
    source = item.get('source_platform')
    return source if isinstance(source, str) and source else 'unknown'


def distribution(
    source_totals: Mapping[str, int], band_totals: Mapping[str, Mapping[str, int]],
) -> dict[str, Any]:
    """``{sources: [row, ...], overall: row}``: the busiest source first, ties by name.

    A source with only banded rows still gets a row; a source with no reviews in the
    window (total 0) is left out.
    """
    names = set(source_totals) | set(band_totals)
    rows = [_row(name, band_totals.get(name, {}), int(source_totals.get(name, 0))) for name in names]
    rows = sorted((row for row in rows if row['total'] > 0), key=lambda row: (-row['total'], row['source']))
    overall = {field: sum(row[field] for row in rows) for field in QUALITY_FIELDS}
    return {'sources': rows, 'overall': overall}


def from_counters(source_totals: Mapping[str, int], band_rows: Mapping[str, int]) -> dict[str, Any]:
    """The distribution from summed counters: ``band_rows`` is keyed ``<source>#<band>``.

    The band is the LAST ``#`` segment, so a source name containing ``#`` still parses; a
    row whose last segment is not a band is ignored.
    """
    bands: dict[str, dict[str, int]] = {}
    for key, count in band_rows.items():
        source, _, band = key.rpartition('#')
        if source and band in USEFULNESS_BANDS:
            _add(bands, source, band, int(count))
    return distribution(source_totals, bands)


def from_items(items: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The distribution of the window's (visible) items; a missing ``source_platform`` is ``unknown``."""
    totals: dict[str, int] = {}
    bands: dict[str, dict[str, int]] = {}
    for item in items:
        source = _source_of(item)
        totals[source] = totals.get(source, 0) + 1
        band = stored_band(item)
        if band != USEFULNESS_UNRATED:
            _add(bands, source, band, 1)
    return distribution(totals, bands)
