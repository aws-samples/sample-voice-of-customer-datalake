"""Radar release records: what another brand shipped, from OUR web search (docs/radar.md).

One record per feature, however many articles repeat it::

    RELEASE#{brand} / {first_date}#{release_id}
    {release_id, brand, brand_label, feature, release_date, date_approximate,
     summary, urls[], titles[], source_kind: official|third_party, mentions,
     first_seen, last_seen, embedding}

``urls``/``titles`` are aligned by index and cleaned by ``shared.radar_citations``
(one per page, https first, never a machine feed) when stored and again when read.
``summary`` is the extractor model's own words; no search snippet is stored
(AgentCore web search acceptable use: keep the citations, never bulk-store
results). A new candidate merges into an existing record of the same brand
when their feature embeddings (Titan V2) have a cosine of at least
``MERGE_COSINE`` and their dates are within ``MERGE_WINDOW_DAYS``: the citations are
unioned (and cleaned) and ``mentions`` grows. An OFFICIAL source (the URL is on
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

from shared.memory_store import cosine, decode_embedding, encode_embedding
from shared.radar_citations import clean_citations
from shared.radar_store import query_all

__all__ = [
    'ReleaseCandidate',
    'list_releases',
    'source_kind',
    'store_candidate',
]

MERGE_COSINE: Final = 0.86
MERGE_WINDOW_DAYS: Final = 60
OFFICIAL: Final = 'official'
THIRD_PARTY: Final = 'third_party'
# What the API returns of a record: never the embedding, never the keys.
PUBLIC_FIELDS: Final = (
    'release_id', 'brand', 'brand_label', 'feature', 'release_date', 'date_approximate', 'summary',
    'urls', 'titles', 'source_kind', 'mentions', 'first_seen', 'last_seen',
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
        'embedding': Binary(encode_embedding(vector)),
    }


def store_candidate(table: Any, candidate: ReleaseCandidate, vector: list[float], today: date, now_iso: str) -> str:
    """File ``candidate`` (its feature's unit ``vector``): ``'merged'`` into a near-duplicate, else ``'added'``."""
    day = date.fromisoformat(candidate.release_date) if candidate.release_date else today
    match = _best_match(_nearby(table, candidate.brand, day), vector)
    if match is not None:
        table.put_item(Item=_merged(match, candidate, now_iso))
        return 'merged'
    table.put_item(Item=_new_record(candidate, vector, day, now_iso))
    return 'added'


def public_release(row: dict[str, Any]) -> dict[str, Any]:
    """The API view of one record (no embedding, no keys)."""
    view = {key: row[key] for key in PUBLIC_FIELDS if key in row}
    view['mentions'] = int(view.get('mentions') or 1)
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
