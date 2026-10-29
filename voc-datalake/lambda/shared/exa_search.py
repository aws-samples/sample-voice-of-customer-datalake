"""Exa (exa.ai) web search: the Radar news scan's second index (docs/radar.md → "Exa").

Used only by ``voc-radar-scan``, and only when an admin stored an Exa API key
(``shared.radar_exa_key``). One request is ``POST https://api.exa.ai/search`` with the key in
``x-api-key`` and ``{query, numResults, type: 'auto', startPublishedDate, includeDomains?, excludeText?}``:
only the brand's name, the search words and its domains leave AWS. Pay-per-use (about $5 per
1,000 searches); every call counts against the scan's query cap.

Results are mapped to the shape ``shared.web_search.search_web`` returns
(``{title, url, text, published_date}``), so they go to the same extractor. Any failure raises
``ExaSearchError`` with a message that never contains the key.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, Final

import requests

from shared.logging import logger

__all__ = ['ExaSearchError', 'exa_search']

EXA_SEARCH_URL: Final = 'https://api.exa.ai/search'
RESULTS_PER_QUERY: Final = 8
TIMEOUT_SECONDS: Final = 20
MAX_QUERY_CHARS: Final = 200
MAX_TEXT_CHARS: Final = 1200


class ExaSearchError(Exception):
    """An Exa search failed (status, transport or answer shape); the caller logs and continues."""


def _text(raw: dict[str, Any]) -> str:
    for field in ('text', 'summary'):
        value = raw.get(field)
        if isinstance(value, str) and value.strip():
            return value[:MAX_TEXT_CHARS]
    highlights = raw.get('highlights')
    if isinstance(highlights, list):
        return ' '.join(str(each) for each in highlights)[:MAX_TEXT_CHARS]
    return ''


def _result(raw: object) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    url = str(raw.get('url') or '')
    if not url.startswith(('https://', 'http://')):
        return None
    title = str(raw.get('title') or '')
    return {'title': title, 'url': url, 'text': _text(raw) or title,
            'published_date': str(raw.get('publishedDate') or '')[:10]}


def _body(query: str, since: str, include_domains: Iterable[str] | None, exclude_text: str | None) -> dict[str, Any]:
    body: dict[str, Any] = {'query': query.strip()[:MAX_QUERY_CHARS], 'numResults': RESULTS_PER_QUERY, 'type': 'auto',
                            'startPublishedDate': f'{since}T00:00:00.000Z'}
    domains = list(include_domains or ())
    if domains:
        body['includeDomains'] = domains
    if exclude_text:
        # Exa takes ONE phrase here (up to five words): pages whose text holds it are left out.
        body['excludeText'] = [exclude_text]
    return body


def exa_search(api_key: str, query: str, *, since: str, include_domains: Iterable[str] | None = None,
               exclude_text: str | None = None, post: Callable[..., Any] = requests.post) -> list[dict[str, str]]:
    """One Exa search published since ``since`` (YYYY-MM-DD), optionally on ``include_domains`` only and
    without pages holding ``exclude_text``."""
    try:
        response = post(EXA_SEARCH_URL, json=_body(query, since, include_domains, exclude_text), timeout=TIMEOUT_SECONDS,
                        headers={'x-api-key': api_key, 'Content-Type': 'application/json'})
    except requests.RequestException as error:
        raise ExaSearchError(f'Exa search request failed ({type(error).__name__})') from None
    if response.status_code != 200:
        raise ExaSearchError(f'Exa search answered HTTP {response.status_code}')
    try:
        payload = response.json()
    except ValueError:
        raise ExaSearchError('Exa search answered non-JSON') from None
    raw = payload.get('results') if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        raise ExaSearchError('Exa search answered without results')
    results = [result for result in (_result(each) for each in raw) if result is not None]
    logger.info(f'Exa search returned {len(results)} results for a query of {len(query)} characters')
    return results
