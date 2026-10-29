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
results). A new candidate merges into an existing record of the same brand
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
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import Binary

from shared.dynamo_paging import count_query
from shared.memory_store import cosine, decode_embedding, encode_embedding
from shared.radar_citations import clean_citations, page_key
from shared.radar_listing_pages import HUB_MIN_RECORDS, is_listing_page
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
OFFICIAL: Final = 'official'
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


def _host(url: str) -> str:
    try:
        host = urlparse(url).hostname or ''
    except ValueError:
        return ''
    return host.lower().removeprefix('www.')


def source_kind(urls: Iterable[str], domains: Iterable[str]) -> str:
    """``official`` when any URL's host is one of the brand's domains (or a subdomain of one)."""
    own = tuple(domains)
    for url in urls:
        host = _host(url)
        if host and any(host == domain or host.endswith(f'.{domain}') for domain in own):
            return OFFICIAL
    return THIRD_PARTY


def _citations(row: dict[str, Any], candidate: ReleaseCandidate | None = None) -> dict[str, list[str]]:
    """The row's citations (plus the candidate's), cleaned: one per page, https first, no feeds."""
    urls, titles = list(row.get('urls') or []), list(row.get('titles') or [])
    if candidate is not None:
        # Pad so the candidate's titles stay beside their URLs.
        titles = [*titles[:len(urls)], *([''] * (len(urls) - len(titles))), *candidate.titles]
        urls = [*urls, *candidate.urls]
    clean_urls, clean_titles = clean_citations(urls, titles)
    return {'urls': clean_urls, 'titles': clean_titles}


def _nearby(table: Any, brand: str, day: date) -> list[dict[str, Any]]:
    low = (day - timedelta(days=MERGE_WINDOW_DAYS)).isoformat()
    high = f'{(day + timedelta(days=MERGE_WINDOW_DAYS)).isoformat()}#~'
    return query_all(table, Key('pk').eq(release_pk(brand)) & Key('sk').between(low, high))


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
    """File ``candidate`` (its feature's unit ``vector``): ``'merged'`` into a record citing the same page or a
    near-duplicate (the same page wins), else ``'added'``."""
    day = date.fromisoformat(candidate.release_date) if candidate.release_date else today
    # An undated candidate has no day to window on: "today" is only when we found
    # it, so it is matched against the brand's whole timeline and joins the dated
    # record of the same feature instead of filing a scan-day duplicate.
    rows = (_nearby(table, candidate.brand, day) if candidate.release_date
            else query_all(table, Key('pk').eq(release_pk(candidate.brand))))
    match = _same_page(rows, candidate) or _best_match(rows, vector)
    if match is not None:
        table.put_item(Item=_merged(match, candidate, now_iso))
        return 'merged'
    table.put_item(Item=_new_record(candidate, vector, day, now_iso))
    return 'added'


def public_release(row: dict[str, Any]) -> dict[str, Any]:
    """The API view of one record (no embedding, no keys)."""
    view = {key: row[key] for key in PUBLIC_FIELDS if key in row}
    view['mentions'] = int(view.get('mentions') or 1)
    view['kind'] = news_kind(view['kind']) if view.get('kind') else LEGACY_KIND
    view['found_via'] = _found_via(view.get('found_via') or LEGACY_FOUND_VIA)
    view.update(_citations(row))  # rows stored before the cleaning render clean too
    return view


def list_releases(table: Any, brand: str, start: date, limit: int) -> list[dict[str, Any]]:
    """``brand``'s records filed since ``start``, newest release first, at most ``limit``."""
    rows: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(release_pk(brand)) & Key('sk').gte(start.isoformat()),
        'ScanIndexForward': False,
    }
    while len(rows) < limit:
        page = table.query(**kwargs)
        rows.extend(page.get('Items', []))
        if 'LastEvaluatedKey' not in page:
            break
        kwargs['ExclusiveStartKey'] = page['LastEvaluatedKey']
    views = [public_release(row) for row in rows]
    return sorted(views, key=lambda view: str(view.get('release_date', '')), reverse=True)[:limit]


def count_releases(table: Any, brand: str, start: date) -> int:
    """How many of ``brand``'s records were filed since ``start`` (``list_releases``' rows, uncapped).

    A ``Select='COUNT'`` query on the same key condition (``shared.dynamo_paging.count_query``): no item is returned.
    """
    return count_query(table, {'KeyConditionExpression': Key('pk').eq(release_pk(brand)) & Key('sk').gte(start.isoformat())})
