"""The Radar "All brands" view: every visible brand side by side, and one release feed (docs/radar.md).

``GET /radar/all?days=`` answers::

    {days, brands: [{...brand view, total, avg_sentiment, sentiment, releases_in_window, latest_release}],
     releases: [{...release, brand: {key, label}}], releases_total, releases_capped}

Each brand's totals are counted over ``days`` like the brand page's header (``counted_totals``).
Releases are the ones FILED within the window (``list_releases``), each brand read once and at
most ``MAX_ALL_RELEASES`` rows, so a request costs one query per brand (the list holds at most 25),
plus one ``Select='COUNT'`` query for a brand whose read reached the cap. The combined feed is newest
``release_date`` first and capped at ``MAX_ALL_RELEASES``; ``releases_total`` and each brand's
``releases_in_window`` are EXACT counts of the records filed in the window, whatever the cap.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from typing import Any, Final

from shared.category_access import CategoryScope
from shared.radar_brands import RadarBrand, brand_view
from shared.radar_releases import count_releases, list_releases
from shared.radar_views import counted_totals, window

__all__ = ['all_brands_view']

MAX_ALL_RELEASES: Final = 100


def _release_date(release: dict[str, Any]) -> str:
    return str(release.get('release_date', ''))


def _brand_row(table: Any, brand: RadarBrand, start: date, end: date, scope: CategoryScope,
               releases: list[dict[str, Any]], released: int) -> dict[str, Any]:
    return {
        **brand_view(brand),
        **counted_totals(table, brand.key, start, end, scope, with_trend=False),
        'releases_in_window': released,
        'latest_release': releases[0] if releases else None,
    }


def all_brands_view(table: Any, brands: Iterable[RadarBrand], scope: CategoryScope, days: int,
                    today: date) -> dict[str, Any]:
    """The All view over ``days`` for ``brands`` (already narrowed to what the caller may see, in order)."""
    start, end = window(days, today)
    cap = MAX_ALL_RELEASES
    rows: list[dict[str, Any]] = []
    feed: list[dict[str, Any]] = []
    total = 0
    for brand in brands:
        releases = list_releases(table, brand.key, start, cap)  # newest release_date first
        # Fewer than the cap is every row; at the cap, a COUNT query says how many there really are.
        released = len(releases) if len(releases) < cap else count_releases(table, brand.key, start)
        total += released
        rows.append(_brand_row(table, brand, start, end, scope, releases, released))
        tag = {'key': brand.key, 'label': brand.label}
        feed.extend({**release, 'brand': tag} for release in releases)
    feed.sort(key=_release_date, reverse=True)  # stable: a tie keeps the brands' order
    return {'days': days, 'brands': rows, 'releases': feed[:cap],
            'releases_total': total, 'releases_capped': total > cap}
