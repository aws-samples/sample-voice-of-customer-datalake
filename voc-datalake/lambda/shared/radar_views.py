"""What the Radar page and the ``get_radar`` assistant tool read (docs/radar.md).

Every view is computed from the ``voc-radar`` table, except the "us" side of
the comparison, which comes from OUR aggregates (``METRIC#category_sentiment#…`` per
category, ``METRIC#daily_sentiment#…`` for the overall row) and only for categories
the caller may see. A caller whose source access hides
one of OUR sources gets no "us" side at all (``ours_visible``): the aggregates
are not split by source, so they could not be narrowed honestly.

Quotes are PII-redacted again on the way out (pattern redaction) and clipped.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Final

from shared import category_access
from shared.category_access import CategoryScope
from shared.metric_keys import SENTIMENT_PREFIX
from shared.pii_redaction import redact_text
from shared.radar_counts import ReviewCounts, review_counts, side_view
from shared.radar_reviews import same_review_key
from shared.radar_store import (
    SENTIMENT_LABELS,
    THEME_POLARITIES,
    counter_pk,
    daily_rows,
    recent_items,
    sum_counter,
)

MAX_THEME_ITEMS: Final = 1000
MAX_THEMES: Final = 8
MAX_QUOTES: Final = 3
MAX_QUOTE_CHARS: Final = 280
MAX_COMPARE_CATEGORIES: Final = 12
OTHER_CATEGORY: Final = 'other'
# A category is "better" for one side when its positive share leads by this much.
BETTER_MARGIN: Final = Decimal('0.1')
#: Fewer of THEIR reviews than this in a category is too few to call a winner: the row says
#: ``too_few`` and has no verdict ("They are better" from two reviews was a coin toss).
MIN_COMPARE_REVIEWS: Final = 10


def window(days: int, today: date) -> tuple[date, date]:
    """The inclusive ``(start, end)`` of a ``days``-long window ending ``today``."""
    return today - timedelta(days=days - 1), today


def sentiment_trend(table: Any, brand: str, start: date, end: date) -> list[dict[str, Any]]:
    """One point per day with reviews: ``{date, count, avg_sentiment}``."""
    points = []
    for row in daily_rows(table, counter_pk(brand, 'daily_total'), start, end):
        count = int(row.get('count') or 0)
        if count:
            average = Decimal(str(row.get('sentiment_sum') or 0)) / count
            points.append({'date': row['sk'], 'count': count, 'avg_sentiment': _rounded(average)})
    return points


def brand_totals(table: Any, brand: str, start: date, end: date) -> dict[str, Any]:
    """``{total, avg_sentiment, sentiment: {label: count}}`` over the window."""
    rows = daily_rows(table, counter_pk(brand, 'daily_total'), start, end)
    total = sum(int(row.get('count') or 0) for row in rows)
    score = sum((Decimal(str(row.get('sentiment_sum') or 0)) for row in rows), Decimal(0))
    sentiment = {label: int(sum_counter(table, counter_pk(brand, f'daily_sentiment#{label}'), start, end))
                 for label in SENTIMENT_LABELS}
    return {
        'total': total,
        'avg_sentiment': _rounded(score / total) if total else None,
        'sentiment': sentiment,
    }


def counted_totals(table: Any, brand: str, start: date, end: date, scope: CategoryScope, *,
                   with_trend: bool) -> dict[str, Any]:
    """``{total, avg_sentiment, sentiment}`` (+ ``trend``) from the distinct reviews the list shows.

    The daily counters count every stored COPY (a file imported twice counted twice), so the
    header said 12 while "Read all reviews" listed 6. Counted from the list's own walk and the
    caller's scope instead; only a window too large to walk falls back to the counters.
    """
    counts = review_counts(table, brand, start, end, scope)
    if counts.complete:
        view = counts.totals()
        return {**view, 'trend': counts.trend()} if with_trend else view
    view = brand_totals(table, brand, start, end)
    return {**view, 'trend': sentiment_trend(table, brand, start, end)} if with_trend else view


def _quote(item: Mapping[str, Any]) -> str | None:
    raw = item.get('direct_customer_quote')
    if not isinstance(raw, str) or not raw.strip():
        return None
    return redact_text(raw).text[:MAX_QUOTE_CHARS]


def _theme_label(item: Mapping[str, Any]) -> tuple[str, str | None]:
    return str(item.get('category') or OTHER_CATEGORY), item.get('subcategory') or None


def themes(table: Any, brand: str, start: date, end: date, scope: CategoryScope) -> dict[str, Any]:
    """``{love: [...], hate: [...], sampled}``: the top praise and complaint themes with counts and quotes.

    A theme is a (category, subcategory) pair. Read from at most
    ``MAX_THEME_ITEMS`` of the newest reviews (``sampled`` says when the window
    held more); categories the caller may not see are left out.
    """
    items = recent_items(table, brand, start, end, MAX_THEME_ITEMS)
    counts: dict[str, Counter[tuple[str, str | None]]] = {polarity: Counter() for polarity in THEME_POLARITIES}
    quotes: dict[tuple[str, tuple[str, str | None]], list[str]] = defaultdict(list)
    seen: set[tuple[str, tuple[str, str | None], tuple[str, str]]] = set()
    for item in items:
        polarity = item.get('sentiment_label')
        label = _theme_label(item)
        if polarity not in counts or not category_access.admits(scope, label[0]):
            continue
        # Counted like the review list behind the theme reads it: a second stored copy of one
        # review (a file imported twice) is one review, so "Read the 2 reviews" opens 2.
        copy = (str(polarity), label, same_review_key(item))
        if copy in seen:
            continue
        seen.add(copy)
        counts[polarity][label] += 1
        quote = _quote(item)
        bucket = quotes[(polarity, label)]
        # The same text reviewed twice (a repost, a second import) is one quote, not two. Every
        # distinct quote is kept here: ``_ranked`` may skip some already shown under a higher theme.
        if quote and quote not in bucket:
            bucket.append(quote)
    return {'love': _ranked(counts['positive'], quotes, 'positive'),
            'hate': _ranked(counts['negative'], quotes, 'negative'), 'sampled': len(items) >= MAX_THEME_ITEMS}


def _ranked(counts: Counter[tuple[str, str | None]], quotes: Mapping[tuple[str, tuple[str, str | None]], list[str]],
            polarity: str) -> list[dict[str, Any]]:
    """The top ``MAX_THEMES`` themes of one column, each with at most ``MAX_QUOTES`` quotes.

    A quote is shown once per column: two stored copies of one text filed under different
    subcategories made it appear under two themes, so a later (lower-ranked) theme skips a quote
    an earlier one already shows.
    """
    shown: set[str] = set()
    out: list[dict[str, Any]] = []
    for (category, subcategory), count in counts.most_common(MAX_THEMES):
        picked = [quote for quote in quotes.get((polarity, (category, subcategory)), []) if quote not in shown][:MAX_QUOTES]
        shown.update(picked)
        out.append({'category': category, 'subcategory': subcategory, 'count': count, 'quotes': picked})
    return out


def _rounded(value: Decimal | None) -> float | None:
    return None if value is None else float(round(value, 3))


def _side(table: Any, pk_of: Callable[[str], str], start: date, end: date) -> dict[str, Any]:
    """``{volume, positive_share, negative_share}`` from one side's per-sentiment daily counters."""
    return side_view({label: int(sum_counter(table, pk_of(label), start, end)) for label in SENTIMENT_LABELS})


def _verdict(theirs: Mapping[str, Any], ours: Mapping[str, Any] | None) -> str | None:
    if ours is None or theirs['positive_share'] is None or ours['positive_share'] is None:
        return None
    lead = Decimal(str(theirs['positive_share'])) - Decimal(str(ours['positive_share']))
    if lead >= BETTER_MARGIN:
        return 'they_are_better'
    if -lead >= BETTER_MARGIN:
        return 'we_are_better'
    return 'even'


def ours_visible(scope: CategoryScope, radar_source_ids: Iterable[str]) -> bool:
    """Whether our aggregates may be shown to ``scope`` unsplit by source.

    True when its source rule hides nothing, or hides only Radar sources (whose
    reviews never reach our aggregates anyway). An explicit grant list hides
    sources the aggregates do count, so it gets no "us" side.
    """
    if scope.sources_all:
        return True
    return scope.source_allow is None and scope.source_deny <= frozenset(radar_source_ids)


def _their_sides(radar_table: Any, brand: str, categories: list[str], start: date, end: date,
                 counted: ReviewCounts | None) -> dict[str, dict[str, Any]]:
    """Their side per visible category: from the distinct reviews when ``counted`` is given, else the counters.

    The counters are bumped once per STORED copy, so a review imported twice read as two
    ("2 reviews" → "4", wave-9 finding); ``counted`` is the list's own deduped walk.
    """
    if counted is not None:
        sides = counted.category_sides()
        return {category: sides[category] for category in categories if category in sides}
    return {
        category: _side(radar_table, lambda label, c=category: counter_pk(brand, f'category_sentiment#{c}#{label}'),
                        start, end)
        for category in categories
        if sum_counter(radar_table, counter_pk(brand, f'daily_category#{category}'), start, end)
    }


def compare(radar_table: Any, aggregates_table: Any, brand: str, categories: Iterable[str],
            start: date, end: date, scope: CategoryScope, *, ours_available: bool) -> dict[str, Any]:
    """Per category, their sentiment and volume against ours: ``{categories: [...], ours_available, overall}``.

    Only the categories the brand has reviews in (at most ``MAX_COMPARE_CATEGORIES``,
    busiest first) and the caller may see. ``verdict`` is ``they_are_better`` /
    ``we_are_better`` / ``even`` by positive share (``BETTER_MARGIN``), or None
    when either side has no reviews or the row is ``too_few`` (fewer than
    ``MIN_COMPARE_REVIEWS`` of theirs). Their side counts DISTINCT reviews (the list's
    own walk, ``review_counts``), as the header and the list do; a window too large
    to walk, or a walk that found no stored review (counters older than the review
    rows), keeps the counters. ``overall`` is ``{theirs, ours}``: the whole window as
    one side each (same counting as the rows; ``ours`` None without ``ours_available``).
    """
    counts = review_counts(radar_table, brand, start, end, scope)
    counted = counts if counts.complete and counts.items else None
    visible = [category for category in categories if category_access.admits(scope, category)]
    theirs_by_category = {
        category: side for category, side in _their_sides(radar_table, brand, visible, start, end, counted).items()
        if side['volume']
    }
    busiest = sorted(theirs_by_category, key=lambda c: theirs_by_category[c]['volume'], reverse=True)
    rows = []
    for category in busiest[:MAX_COMPARE_CATEGORIES]:
        theirs = theirs_by_category[category]
        ours = _side(aggregates_table, lambda label, c=category: _our_category_pk(c, label),
                     start, end) if ours_available else None
        too_few = int(theirs['volume']) < MIN_COMPARE_REVIEWS
        rows.append({'category': category, 'theirs': theirs, 'ours': ours, 'too_few': too_few,
                     'verdict': None if too_few else _verdict(theirs, ours)})
    overall = {'theirs': _their_overall(radar_table, brand, visible, start, end, scope, counted),
               'ours': _our_overall(aggregates_table, visible, start, end, scope) if ours_available else None}
    return {'categories': rows, 'ours_available': ours_available, 'overall': overall}


def _our_category_pk(category: str, label: str) -> str:
    return f'METRIC#category_sentiment#{category}#{label}'


def _category_sum(table: Any, pk_of: Callable[[str, str], str], categories: Iterable[str], start: date,
                  end: date) -> dict[str, Any]:
    """One side summed over ``categories``' per-category sentiment counters (``pk_of(category, label)``)."""
    names = list(categories)
    return side_view({label: sum(int(sum_counter(table, pk_of(category, label), start, end)) for category in names)
                      for label in SENTIMENT_LABELS})


def _their_overall(radar_table: Any, brand: str, visible: list[str], start: date, end: date, scope: CategoryScope,
                   counted: ReviewCounts | None) -> dict[str, Any]:
    """The brand's whole window as one side: the distinct reviews when walked (as the rows), else its counters.

    A caller with a category restriction gets only the ``visible`` categories, from the
    per-category counters, so the total never counts reviews it cannot open.
    """
    if counted is not None:
        return side_view(counted.totals()['sentiment'])
    if scope.categories_all:
        return _side(radar_table, lambda label: counter_pk(brand, f'daily_sentiment#{label}'), start, end)
    return _category_sum(radar_table, lambda c, label: counter_pk(brand, f'category_sentiment#{c}#{label}'),
                         visible, start, end)


def _our_overall(aggregates_table: Any, visible: list[str], start: date, end: date,
                 scope: CategoryScope) -> dict[str, Any]:
    """OUR feedback's whole window as one side (the ``SENTIMENT_PREFIX`` daily counters).

    A caller with a category restriction gets the sum of the ``visible`` categories instead
    (``METRIC#category_sentiment#…``), as the metrics API narrows every number to that scope.
    """
    if scope.categories_all:
        return _side(aggregates_table, lambda label: f'{SENTIMENT_PREFIX}{label}', start, end)
    return _category_sum(aggregates_table, _our_category_pk, visible, start, end)


def configured_category_names(categories_config: Iterable[Any]) -> list[str]:
    """Our taxonomy's category names plus ``other`` (the processor's fallback), de-duplicated."""
    names = [str(entry.get('name')) for entry in categories_config if isinstance(entry, Mapping) and entry.get('name')]
    return list(dict.fromkeys([*names, OTHER_CATEGORY]))
