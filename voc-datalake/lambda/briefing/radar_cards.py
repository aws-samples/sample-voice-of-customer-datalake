"""Radar on Home: at most three code-only cards about the brands we track (docs/briefing.md → "Radar cards").

1. ``radar_release`` — what one tracked brand shipped since the scope group's previous brief
   (feature, brand, release day, the cited URLs in ``card.urls``).
2. ``radar_complaints`` — the brand whose share of negative reviews rose the most, and clearly
   (``SHIFT_POINTS``, with ``MIN_REVIEWS`` on each side), with the counts and its top complaint theme.
3. ``radar_beats_us`` — "where they beat us": the categories where a brand's positive share leads
   ours (``shared.radar_views.compare``, the Radar page's own verdict).

Everything reads ``voc-radar`` (read-only) and, for "us", our aggregates; nothing calls a model.
Visibility is the Radar API's: a brand is shown only when the scope may see EVERY source tracking
it, themes and comparisons only name categories the scope may see, and the "us" side is left out
when the scope's source rule hides one of our sources (``ours_visible``). A deployment without a
Radar table, or without brands, gets no card.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Key

from shared import briefing_store as store
from shared import category_access
from shared.api import get_raw_categories_config
from shared.brief_cards import BriefCard, BriefContext, card_id
from shared.category_access import CategoryScope
from shared.display_labels import category_label, subcategory_label
from shared.logging import logger
from shared.memory_policy import parse_datetime
from shared.radar_brands import RadarBrand, load_brand_list
from shared.radar_brands import effective_brands as merged_brands
from shared.radar_releases import list_releases
from shared.radar_store import counter_pk, sum_counter
from shared.radar_views import compare, configured_category_names, ours_visible, themes
from shared.source_profiles import load_source_profiles

KIND_RELEASE: Final = 'radar_release'
KIND_COMPLAINTS: Final = 'radar_complaints'
KIND_BEATS_US: Final = 'radar_beats_us'
MAX_RADAR_CARDS: Final = 3
#: Without a previous brief, "new" means filed in the last this many days (also the longest look-back).
RELEASE_LOOKBACK_DAYS: Final = 7
#: Releases are read from records filed (by release day) this far back: a late find of an older release still counts.
RELEASE_QUERY_DAYS: Final = 90
MAX_RELEASES_READ: Final = 50
MAX_CARD_RELEASES: Final = 5
#: Complaint share: two windows of this many days (today inclusive) ...
COMPLAINT_WINDOW_DAYS: Final = 7
#: ... at least this many reviews in each, and a rise of at least this many points.
MIN_REVIEWS: Final = 10
SHIFT_POINTS: Final = 10.0
#: "Where they beat us": the comparison window, and the brand's own reviews it needs in a category.
COMPARE_DAYS: Final = 30
MIN_COMPARE_VOLUME: Final = 10
MAX_BEATS_CATEGORIES: Final = 3
#: The comparison reads many counters: only the busiest brands of the window are compared.
MAX_COMPARED_BRANDS: Final = 10


@dataclass(frozen=True)
class RadarRead:
    """What every Radar card reads: the table, the visible brands and every Radar source id."""

    table: Any
    brands: tuple[RadarBrand, ...]
    radar_sources: tuple[str, ...]


def effective_brands(aggregates_table: Any, radar_table: Any) -> list[RadarBrand]:
    """Every tracked brand. The ONE place the brief learns the brand list.

    The stored list (voc-radar ``SETTINGS#radar/brands``) merged with the legacy
    source-profile brands by key (docs/radar.md). A malformed stored list must not
    fail the whole brief: it reads as empty, so only the legacy brands remain.
    """
    try:
        listed = load_brand_list(radar_table)
    except ValueError:
        logger.warning('The stored Radar brand list is malformed; the brief uses the legacy profile brands only')
        listed = []
    return merged_brands(listed, load_source_profiles(aggregates_table))


def visible_brands(brands: Sequence[RadarBrand], scope: CategoryScope) -> list[RadarBrand]:
    """The radar_handler rule: a brand is visible only when the scope admits every source tracking it."""
    return [brand for brand in brands if all(category_access.admits_source(scope, s) for s in brand.sources)]


def radar_read(ctx: BriefContext) -> RadarRead | None:
    """The build's Radar read (once per build), or None when the deployment has no Radar table."""
    cached = ctx.extra.get('radar')
    if isinstance(cached, RadarRead):
        return cached
    table = ctx.extra.get('radar_table')
    if table is None:
        return None
    brands = effective_brands(ctx.aggregates_table, table)
    read = RadarRead(table=table, brands=tuple(visible_brands(brands, ctx.scope)),
                     radar_sources=tuple(source for brand in brands for source in brand.sources))
    ctx.extra['radar'] = read
    return read


def _today(ctx: BriefContext) -> date:
    return ctx.now.astimezone(UTC).date()


def previous_brief_at(ctx: BriefContext) -> datetime:
    """When this scope group's previous brief (an earlier UTC day's org layer) was built.

    Never further back than ``RELEASE_LOOKBACK_DAYS``; that is also the answer when there is none.
    """
    floor = ctx.now - timedelta(days=RELEASE_LOOKBACK_DAYS)
    page = ctx.aggregates_table.query(
        KeyConditionExpression=Key('pk').eq(f'{store.ORG_PK_PREFIX}{store.scope_hash(ctx.scope)}')
        & Key('sk').lt(_today(ctx).isoformat()),
        ScanIndexForward=False, Limit=1, ProjectionExpression='generated_at',
    )
    rows = page.get('Items') or []
    generated = parse_datetime(rows[0].get('generated_at')) if rows else None
    return max(generated, floor) if generated is not None else floor


def _is_web_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ('http', 'https') and bool(parsed.netloc)


def safe_urls(raw: object) -> tuple[str, ...]:
    """The http(s) URLs of a list, in order (anything else is dropped)."""
    if not isinstance(raw, list):
        return ()
    return tuple(url for url in raw if isinstance(url, str) and _is_web_url(url))


def _new_releases(read: RadarRead, brand: RadarBrand, since: datetime, today: date) -> list[dict[str, Any]]:
    rows = list_releases(read.table, brand.key, today - timedelta(days=RELEASE_QUERY_DAYS), MAX_RELEASES_READ)
    fresh = []
    for row in rows:
        seen = parse_datetime(row.get('first_seen'))
        if seen is not None and seen > since and isinstance(row.get('feature'), str):
            fresh.append(row)
    return fresh


def _release_fact(row: Mapping[str, Any]) -> dict[str, Any]:
    return {'feature': str(row['feature']), 'release_date': str(row.get('release_date') or ''),
            'date_approximate': bool(row.get('date_approximate')), 'source_kind': str(row.get('source_kind') or '')}


def release_cards(ctx: BriefContext) -> list[BriefCard]:
    """One card: the brand with the newest release since the previous brief, its new releases and citations."""
    read = radar_read(ctx)
    if read is None or not read.brands:
        return []
    since, today = previous_brief_at(ctx), _today(ctx)
    found = [(brand, rows) for brand in read.brands if (rows := _new_releases(read, brand, since, today))]
    if not found:
        return []
    brand, rows = max(found, key=lambda pair: str(pair[1][0].get('release_date') or ''))
    shown = rows[:MAX_CARD_RELEASES]
    newest = shown[0]
    urls = tuple(dict.fromkeys(url for row in shown for url in safe_urls(row.get('urls'))))
    day = str(newest.get('release_date') or '')
    return [BriefCard(
        id=card_id(KIND_RELEASE, today.isoformat(), brand.key, *(str(r.get('release_id', '')) for r in shown)),
        kind=KIND_RELEASE, layer='org', severity='info',
        title=f"{brand.label} shipped {newest['feature']} ({day})",
        facts={'brand': brand.label, 'brand_key': brand.key, 'releases': [_release_fact(r) for r in shown],
               'new_releases': len(rows), 'other_brands': len(found) - 1, 'since': since.isoformat()},
        urls=urls,
    )]


@dataclass(frozen=True)
class ShareShift:
    brand: RadarBrand
    current: int
    previous: int
    negative_current: int
    negative_previous: int

    @property
    def now_pct(self) -> float:
        return self.negative_current * 100 / self.current

    @property
    def before_pct(self) -> float:
        return self.negative_previous * 100 / self.previous

    @property
    def shift(self) -> float:
        return self.now_pct - self.before_pct


def _count(read: RadarRead, brand: str, metric: str, start: date, end: date) -> int:
    return int(sum_counter(read.table, counter_pk(brand, metric), start, end))


def share_shift(read: RadarRead, brand: RadarBrand, today: date) -> ShareShift | None:
    """The brand's negative share this window against the window before, None without enough reviews."""
    start = today - timedelta(days=COMPLAINT_WINDOW_DAYS - 1)
    before_end = start - timedelta(days=1)
    before_start = before_end - timedelta(days=COMPLAINT_WINDOW_DAYS - 1)
    current = _count(read, brand.key, 'daily_total', start, today)
    previous = _count(read, brand.key, 'daily_total', before_start, before_end)
    if current < MIN_REVIEWS or previous < MIN_REVIEWS:
        return None
    return ShareShift(brand, current, previous,
                      _count(read, brand.key, 'daily_sentiment#negative', start, today),
                      _count(read, brand.key, 'daily_sentiment#negative', before_start, before_end))


def _top_complaint(read: RadarRead, brand: str, today: date, scope: CategoryScope,
                   config: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    start = today - timedelta(days=COMPLAINT_WINDOW_DAYS - 1)
    hate = themes(read.table, brand, start, today, scope)['hate']
    if not hate:
        return None
    top = hate[0]
    sub = top['subcategory'] if isinstance(top.get('subcategory'), str) and top['subcategory'] else None
    return {'category': top['category'], 'category_label': category_label(top['category'], config),
            'subcategory': top['subcategory'],
            'subcategory_label': subcategory_label(sub, top['category'], config) if sub else None,
            'count': int(top['count'])}


def complaint_cards(ctx: BriefContext) -> list[BriefCard]:
    """One warn card: the brand whose negative share rose the most, by at least ``SHIFT_POINTS``."""
    read = radar_read(ctx)
    if read is None:
        return []
    today = _today(ctx)
    shifts = [s for brand in read.brands if (s := share_shift(read, brand, today)) is not None
              and s.shift >= SHIFT_POINTS]
    if not shifts:
        return []
    top = max(shifts, key=lambda s: s.shift)
    complaint = _top_complaint(read, top.brand.key, today, ctx.scope,
                               get_raw_categories_config(ctx.aggregates_table))
    facts: dict[str, Any] = {
        'brand': top.brand.label, 'brand_key': top.brand.key, 'window_days': COMPLAINT_WINDOW_DAYS,
        'reviews': top.current, 'previous_reviews': top.previous,
        'negative': top.negative_current, 'previous_negative': top.negative_previous,
        'negative_pct': round(top.now_pct), 'previous_negative_pct': round(top.before_pct),
        'shift_points': round(top.shift),
    }
    if complaint is not None:
        # `category` lets the brief's scope check (within_scope) see it too.
        facts.update({'category': complaint['category'], 'category_label': complaint['category_label'],
                      'top_complaint': complaint})
    return [BriefCard(
        id=card_id(KIND_COMPLAINTS, today.isoformat(), top.brand.key), kind=KIND_COMPLAINTS, layer='org',
        severity='warn',
        title=(f'Complaints about {top.brand.label} rose to {round(top.now_pct)}% '
               f'(from {round(top.before_pct)}%)'),
        facts=facts,
    )]


def _lead(row: Mapping[str, Any]) -> Decimal:
    return Decimal(str(row['theirs']['positive_share'])) - Decimal(str(row['ours']['positive_share']))


def beats_us_rows(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The categories they clearly win (the compare verdict) on enough of their reviews, biggest lead first."""
    wins = [row for row in rows if row.get('verdict') == 'they_are_better'
            and int(row['theirs']['volume']) >= MIN_COMPARE_VOLUME]
    return sorted(wins, key=_lead, reverse=True)


def _busiest(read: RadarRead, start: date, end: date) -> list[RadarBrand]:
    volumes = {brand.key: _count(read, brand.key, 'daily_total', start, end) for brand in read.brands}
    ranked = sorted((b for b in read.brands if volumes[b.key] >= MIN_COMPARE_VOLUME),
                    key=lambda b: volumes[b.key], reverse=True)
    return ranked[:MAX_COMPARED_BRANDS]


def _beats_fact(row: Mapping[str, Any], config: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    theirs, ours = row['theirs'], row['ours']
    return {'category': row['category'], 'category_label': category_label(row['category'], config),
            'their_positive_pct': round(float(theirs['positive_share']) * 100),
            'our_positive_pct': round(float(ours['positive_share']) * 100),
            'their_reviews': int(theirs['volume']), 'our_reviews': int(ours['volume'])}


def beats_us_cards(ctx: BriefContext) -> list[BriefCard]:
    """One card: the brand with the biggest lead over us in a category we may compare."""
    read = radar_read(ctx)
    if read is None or not read.brands or not ours_visible(ctx.scope, read.radar_sources):
        return []
    today = _today(ctx)
    start = today - timedelta(days=COMPARE_DAYS - 1)
    config = get_raw_categories_config(ctx.aggregates_table)
    categories = configured_category_names(config)
    best: tuple[Decimal, RadarBrand, list[Mapping[str, Any]]] | None = None
    for brand in _busiest(read, start, today):
        result = compare(read.table, ctx.aggregates_table, brand.key, categories, start, today, ctx.scope,
                         ours_available=True)
        wins = beats_us_rows(result['categories'])
        if wins and (best is None or _lead(wins[0]) > best[0]):
            best = (_lead(wins[0]), brand, wins)
    if best is None:
        return []
    _, brand, wins = best
    shown = [_beats_fact(row, config) for row in wins[:MAX_BEATS_CATEGORIES]]
    top = shown[0]
    return [BriefCard(
        id=card_id(KIND_BEATS_US, today.isoformat(), brand.key, *(row['category'] for row in shown)),
        kind=KIND_BEATS_US, layer='org', severity='info',
        title=(f"{brand.label} beats us on {top['category_label']}: {top['their_positive_pct']}% positive "
               f"(us: {top['our_positive_pct']}%)"),
        facts={'brand': brand.label, 'brand_key': brand.key, 'window_days': COMPARE_DAYS,
               'categories': [row['category'] for row in shown],
               'category_labels': [row['category_label'] for row in shown], 'comparison': shown},
    )]


RADAR_PROVIDERS: Final = (release_cards, complaint_cards, beats_us_cards)


def radar_cards(ctx: BriefContext) -> list[BriefCard]:
    """The Radar provider: at most ``MAX_RADAR_CARDS`` cards, one of each kind, in that order."""
    cards: list[BriefCard] = []
    for provider in RADAR_PROVIDERS:
        cards.extend(provider(ctx))
    return cards[:MAX_RADAR_CARDS]
