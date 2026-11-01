"""Radar release records: what another brand shipped, from OUR web search (docs/radar.md).

One record per feature, however many articles repeat it::

    RELEASE#{brand} / {first_date}#{release_id}
    {release_id, brand, brand_label, feature, release_date, date_approximate,
     summary, urls[], titles[], source_kind: official|third_party, mentions,
     first_seen, last_seen, embedding, kind, found_via[]}

``kind`` (5.42, news): ``release`` | ``announcement`` | ``promotion`` | ``partnership`` | ``news``;
``found_via``: the sources that found it, ``web`` | ``exa`` | ``feed``. A record stored before
5.42 has neither and reads as ``release`` found via ``["web"]``. A merge keeps the earlier
kind (unless it had none) and unions ``found_via``.

``urls``/``titles`` are aligned by index and cleaned by ``shared.radar_citations``
(one per page, https first, never a machine feed) when stored and again when read.
``summary`` is the extractor model's own words; no search snippet is stored
(AgentCore web search acceptable use: keep the citations, never bulk-store
results). A new candidate first merges into a record of the brand with the SAME feature name, at
any date (``radar_release_merge.feature_key``), and otherwise into an existing record of the same brand
within ``MERGE_WINDOW_DAYS`` of its date (an undated candidate is matched against
every record of the brand) when that record already cites the SAME PAGE as one
of the candidate's citations (``radar_citations.page_key``: two sources wording
one story differently; never a listing / index page or a page two records already
cite, ``radar_listing_pages``), or else when their feature embeddings (Titan V2) have a
cosine of at least ``MERGE_COSINE``: the citations are unioned (and cleaned) and
``mentions`` grows. An OFFICIAL source (the URL is on
one of the brand's own domains) wins on the feature name and the release date.
The sort key keeps the date the record was first filed under, so the record
never moves; ``release_date`` is the attribute to read.

On the way out (``list_releases``) records of one feature name read as one (rows stored before the
name rule), citations that neither are official nor name the brand are left out
(``radar_brand_citations``) and an index page's citation has an empty title (``radar_listing_pages``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import Binary

from shared import dynamo_paging
from shared.memory_store import cosine, decode_embedding, encode_embedding
from shared.radar_brand_citations import BrandMatch, brand_citations, on_domains
from shared.radar_citations import clean_citations, page_key
from shared.radar_listing_pages import HUB_MIN_RECORDS, hub_pages, index_titles, is_listing_page
from shared.radar_release_merge import OFFICIAL, collapse, feature_key, padded_titles, same_name
from shared.radar_store import query_all

__all__ = [
    'ReleaseCandidate',
    'count_releases',
    'list_releases',
    'news_kind',
    'source_kind',
    'store_candidate',
]

MERGE_COSINE: Final = 0.86
MERGE_WINDOW_DAYS: Final = 60
THIRD_PARTY: Final = 'third_party'
#: What a news item is. ``news`` is the catch-all (an unknown kind from the model lands there).
NEWS_KINDS: Final = ('release', 'announcement', 'promotion', 'partnership', 'news')
LEGACY_KIND: Final = 'release'
FOUND_VIA: Final = ('web', 'exa', 'feed')
LEGACY_FOUND_VIA: Final = ('web',)
# What the API returns of a record: never the embedding, never the keys.
PUBLIC_FIELDS: Final = (
    'release_id', 'brand', 'brand_label', 'feature', 'release_date', 'date_approximate', 'summary',
    'urls', 'titles', 'source_kind', 'mentions', 'first_seen', 'last_seen', 'kind', 'found_via',
)


@dataclass(frozen=True)
class ReleaseCandidate:
    """One release the extractor found in a step's search results."""

    brand: str
    brand_label: str
    feature: str
    summary: str
    release_date: str | None
    urls: tuple[str, ...] = ()
    titles: tuple[str, ...] = ()
    source_kind: str = THIRD_PARTY
    kind: str = LEGACY_KIND
    found_via: tuple[str, ...] = LEGACY_FOUND_VIA


def news_kind(value: object) -> str:
    """``value`` when it is one of ``NEWS_KINDS``, else ``news``."""
    text = str(value or '').strip().lower()
    return text if text in NEWS_KINDS else 'news'


def _found_via(*sources: object) -> list[str]:
    """The known sources among ``sources`` (lists), in ``FOUND_VIA`` order; ``["web"]`` when none."""
    seen = {str(via) for each in sources if isinstance(each, list | tuple) for via in each}
    return [via for via in FOUND_VIA if via in seen] or list(LEGACY_FOUND_VIA)


def release_pk(brand: str) -> str:
    return f'RELEASE#{brand}'


def source_kind(urls: Iterable[str], domains: Iterable[str]) -> str:
    """``official`` when any URL's host is one of the brand's domains (or a subdomain of one)."""
    own = tuple(domains)
    return OFFICIAL if any(on_domains(url, own) for url in urls) else THIRD_PARTY


def _citations(row: dict[str, Any], candidate: ReleaseCandidate | None = None) -> dict[str, list[str]]:
    """The row's citations (plus the candidate's), cleaned: one per page, https first, no feeds."""
    urls, titles = list(row.get('urls') or []), list(row.get('titles') or [])
    if candidate is not None:
        # Pad so the candidate's titles stay beside their URLs.
        titles = [*padded_titles(urls, titles), *candidate.titles]
        urls = [*urls, *candidate.urls]
    clean_urls, clean_titles = clean_citations(urls, titles)
    return {'urls': clean_urls, 'titles': clean_titles}


def _nearby(rows: list[dict[str, Any]], day: date) -> list[dict[str, Any]]:
    """The records of ``rows`` filed within ``MERGE_WINDOW_DAYS`` of ``day`` (by their sort key)."""
    low = (day - timedelta(days=MERGE_WINDOW_DAYS)).isoformat()
    high = f'{(day + timedelta(days=MERGE_WINDOW_DAYS)).isoformat()}#~'
    return [row for row in rows if low <= str(row.get('sk') or '') <= high]


def _pages(urls: Iterable[object]) -> set[str]:
    return {key for url in urls if (key := page_key(url)) is not None}


def _story_pages(urls: Iterable[object]) -> set[str]:
    """The pages of ``urls`` that are one story: listing / index / category pages left out (radar_listing_pages)."""
    return _pages(url for url in urls if not is_listing_page(url))


def _same_page(rows: list[dict[str, Any]], candidate: ReleaseCandidate) -> dict[str, Any] | None:
    """The first record citing a story page the candidate cites (however each spells it), or None.

    A listing page never matches, and neither does a hub: a page ``HUB_MIN_RECORDS`` records already cite.
    """
    pages = _story_pages(candidate.urls)
    if not pages:
        return None
    cited = [(row, _pages(row.get('urls') or [])) for row in rows]
    hubs = {page for page in pages if sum(page in row_pages for _, row_pages in cited) >= HUB_MIN_RECORDS}
    pages -= hubs
    return next((row for row, row_pages in cited if pages & row_pages), None) if pages else None


def _best_match(rows: list[dict[str, Any]], vector: list[float]) -> dict[str, Any] | None:
    scored = [(cosine(stored, vector), row) for row in rows
              if (stored := decode_embedding(row.get('embedding'))) is not None]
    best = max(scored, key=lambda pair: pair[0], default=None)
    return best[1] if best is not None and best[0] >= MERGE_COSINE else None


def _merged(row: dict[str, Any], candidate: ReleaseCandidate, now_iso: str) -> dict[str, Any]:
    official_wins = candidate.source_kind == OFFICIAL and row.get('source_kind') != OFFICIAL
    merged = {
        **row,
        **_citations(row, candidate),
        'mentions': int(row.get('mentions') or 1) + 1,
        'last_seen': now_iso,
        'kind': row.get('kind') or candidate.kind,
        'found_via': _found_via(row.get('found_via') or LEGACY_FOUND_VIA, candidate.found_via),
    }
    if official_wins:
        merged.update({'feature': candidate.feature, 'source_kind': OFFICIAL})
    if candidate.release_date and (official_wins or row.get('date_approximate')):
        merged.update({'release_date': candidate.release_date, 'date_approximate': False})
    return merged


def _new_record(candidate: ReleaseCandidate, vector: list[float], day: date, now_iso: str) -> dict[str, Any]:
    digest = hashlib.sha256(f'{candidate.brand}\n{candidate.feature}\n{day.isoformat()}'.encode()).hexdigest()[:16]
    return {
        'pk': release_pk(candidate.brand), 'sk': f'{day.isoformat()}#{digest}',
        'release_id': digest, 'brand': candidate.brand, 'brand_label': candidate.brand_label,
        'feature': candidate.feature, 'summary': candidate.summary,
        'release_date': day.isoformat(), 'date_approximate': candidate.release_date is None,
        **_citations({}, candidate),
        'source_kind': candidate.source_kind, 'mentions': 1,
        'first_seen': now_iso, 'last_seen': now_iso,
        'kind': news_kind(candidate.kind), 'found_via': _found_via(candidate.found_via),
        'embedding': Binary(encode_embedding(vector)),
    }


def store_candidate(table: Any, candidate: ReleaseCandidate, vector: list[float], today: date, now_iso: str) -> str:
    """File ``candidate`` (its feature's unit ``vector``): ``'merged'`` into a record of the same feature name
    (any date), else one citing the same page, else a near-duplicate; else ``'added'``."""
    day = date.fromisoformat(candidate.release_date) if candidate.release_date else today
    # The brand's whole timeline (a few hundred rows at most), read once: a record of the SAME
    # NAME is the feature at any date (radar_release_merge), so it is matched first.
    timeline = query_all(table, Key('pk').eq(release_pk(candidate.brand)))
    named = same_name(timeline, candidate.feature)
    # An undated candidate has no day to window on: "today" is only when we found
    # it, so it is matched against the brand's whole timeline and joins the dated
    # record of the same feature instead of filing a scan-day duplicate.
    rows = _nearby(timeline, day) if candidate.release_date else timeline
    match = dict(named) if named is not None else (_same_page(rows, candidate) or _best_match(rows, vector))
    if match is not None:
        table.put_item(Item=_merged(match, candidate, now_iso))
        return 'merged'
    table.put_item(Item=_new_record(candidate, vector, day, now_iso))
    return 'added'


def public_release(row: dict[str, Any], match: BrandMatch | None = None) -> dict[str, Any]:
    """The API view of one record (no embedding, no keys).

    With ``match`` (the brand), a citation that is neither official nor names the brand is left out
    (``radar_brand_citations``; the record stays, with no citation when none passes), and a listing
    page's citation reads with an empty title (``radar_listing_pages.index_titles``).
    """
    view = {key: row[key] for key in PUBLIC_FIELDS if key in row}
    view['mentions'] = int(view.get('mentions') or 1)
    view['kind'] = news_kind(view['kind']) if view.get('kind') else LEGACY_KIND
    view['found_via'] = _found_via(view.get('found_via') or LEGACY_FOUND_VIA)
    citations = _citations(row)  # rows stored before the cleaning render clean too
    if match is not None:
        urls, titles = brand_citations(citations['urls'], citations['titles'], match)
        citations = {'urls': urls, 'titles': index_titles(urls, titles)}
    view.update(citations)
    return view


def _without_hub_titles(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``views`` with an empty title on every citation of a page ``HUB_MIN_RECORDS`` of them cite (an index)."""
    hubs = hub_pages(view.get('urls') or [] for view in views)
    if not hubs:
        return views
    return [{**view, 'titles': index_titles(view.get('urls') or [], view.get('titles') or [], hubs)} for view in views]


def list_releases(table: Any, brand: str, start: date, limit: int, match: BrandMatch | None = None) -> list[dict[str, Any]]:
    """``brand``'s records filed since ``start``, one per feature name, newest release first, at most ``limit``.

    Every record since ``start`` is read (a brand files a few hundred a year at most), so two
    records of one name collapse wherever they sit in the timeline and ``limit`` counts the
    collapsed rows. ``match``: see ``public_release``; index titles (listing pages and hubs among
    the collapsed rows) are blanked only with it.
    """
    rows = query_all(table, Key('pk').eq(release_pk(brand)) & Key('sk').gte(start.isoformat()))
    rows.sort(key=lambda row: str(row.get('sk') or ''), reverse=True)  # the newest-filed record leads a tie
    views = collapse((public_release(row, match) for row in rows), _found_via)
    if match is not None:
        views = _without_hub_titles(views)
    return sorted(views, key=lambda view: str(view.get('release_date', '')), reverse=True)[:limit]


def count_releases(table: Any, brand: str, start: date) -> int:
    """How many rows ``list_releases`` would return for ``start`` without its cap: one per feature name.

    Only the ``feature`` attribute is read (``ProjectionExpression``), so the count follows the
    read-time collapse (``radar_release_merge``) without moving any citation or embedding.
    """
    rows = dynamo_paging.query_all(table, {
        'KeyConditionExpression': Key('pk').eq(release_pk(brand)) & Key('sk').gte(start.isoformat()),
        'ProjectionExpression': '#f', 'ExpressionAttributeNames': {'#f': 'feature'},
    })
    keys = [feature_key(row.get('feature')) for row in rows]
    return len({key for key in keys if key}) + sum(1 for key in keys if not key)
