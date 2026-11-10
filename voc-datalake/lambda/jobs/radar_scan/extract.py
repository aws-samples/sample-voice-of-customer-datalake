"""Turn one step's search results (web search, Exa or a brand's feeds) into news candidates (docs/radar.md).

A candidate is one piece of NEWS of the brand itself, with a ``kind``: ``release`` (a product
release, new feature or version), ``announcement`` (a product announcement, launch, roadmap,
beta), ``promotion`` (prices, discounts, campaigns), ``partnership`` (partners, integrations
announced as a partnership, acquisitions) or ``news`` (other company news); an unknown kind is
``news``. The results may be in any language; the summary is in English.

One model call per step (``utilities`` surface, resolved by ``shared.model_config``):
the results go to the model ONLY inside a ``web_results`` DATA block in the
user prompt, and it answers JSON. The summary is the model's own words; the
snippets themselves are never stored.

A candidate without a date takes its first cited result's published date, then a
date written in a cited URL's path (``/changelog/2026-07-30-…``); when that is
missing too, the cited article page is fetched ONCE through the
SSRF-guarded opener (``shared.http_utils.fetch_public_url``) and its own
publication date is read from the page metadata (code, no model call).

Citations go through ``shared.radar_citations.clean_citations``: one per page, https
first, never a machine feed. A release whose only sources are feeds is not filed.
Before anything else, a cited result that is neither on the brand's own domains nor names the
brand (label or search terms) in its title or URL is dropped (``shared.radar_brand_citations``):
it neither dates the release nor is shown, and a release left with no source is not filed.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

import requests

from shared.converse import converse
from shared.http_utils import UnsafeURLError
from shared.logging import logger
from shared.prompt_safety import data_block
from shared.radar_brand_citations import BrandMatch, keeps_citation
from shared.radar_citations import clean_citations
from shared.radar_releases import ReleaseCandidate, news_kind, source_kind
from shared.web_search import format_web_results_for_llm

MAX_FEATURE_CHARS: Final = 120
MAX_SUMMARY_CHARS: Final = 400
MAX_CANDIDATES: Final = 10
MAX_PAGE_BYTES: Final = 300_000
PAGE_TIMEOUT_SECONDS: Final = 10
_ISO_DAY: Final = re.compile(r'(\d{4}-\d{2}-\d{2})')
_PAGE_DATE_PATTERNS: Final = (
    re.compile(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})'),
    re.compile(r'article:published_time"\s+content="(\d{4}-\d{2}-\d{2})'),
    # The same meta tag with its attributes the other way round.
    re.compile(r'content="(\d{4}-\d{2}-\d{2})[^"]*"\s+(?:property|name)="article:published_time"'),
    re.compile(r'<time[^>]*\bdatetime="(\d{4}-\d{2}-\d{2})'),
)
# A dated article path: ``/changelog/2026-07-30-loops`` or ``/blog/2026/07/30/loops``.
_URL_DATE: Final = re.compile(r'/(\d{4})[-/](\d{2})[-/](\d{2})(?=[-/._]|\Z)')

SYSTEM_PROMPT: Final = (
    'You extract the NEWS of ONE company from search results: its product releases and new features, '
    'product announcements and launches, promotions, partnerships, and company news. '
    'Only news of that company itself: ignore rumours, opinion pieces without news, other companies, job posts, '
    'and generic articles about the topic its name or products are about (for a company called "Example Air", '
    'an article about air quality in general is not its news). '
    'The results may be in any language; write the feature and the summary in English. '
    'Answer with JSON only: {"releases": [{"feature": "<short headline>", '
    '"kind": "release" | "announcement" | "promotion" | "partnership" | "news", '
    '"release_date": "YYYY-MM-DD" or null, "summary": "<one or two sentences in your own words>", '
    '"sources": [<result numbers>]}]}. kind: release = a product release, new feature or version; '
    'announcement = a product announcement, launch, roadmap or beta; promotion = prices, discounts, campaigns; '
    'partnership = partners, integrations announced as a partnership, acquisitions; news = other company news '
    '(results, awards, people, events). Use a date only when a result states it. '
    'Never copy sentences from the results. Answer {"releases": []} when there is none.'
)


def _prompt(brand_label: str, results: list[dict[str, Any]]) -> str:
    return (
        f'Company: {brand_label}\n'
        f'List the news of {brand_label} found in these numbered results.\n\n'
        + data_block('web_results', format_web_results_for_llm(results))
    )


def _json_object(text: str) -> dict[str, Any]:
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end <= start:
        return {}
    try:
        parsed = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _valid_day(value: object, today: date) -> str | None:
    match = _ISO_DAY.search(str(value or ''))
    if not match:
        return None
    try:
        day = date.fromisoformat(match.group(1))
    except ValueError:
        return None
    return day.isoformat() if day <= today + timedelta(days=1) else None


def url_date(urls: Iterable[str], today: date) -> str | None:
    """The first publication date written in a cited article's URL path, or None.

    Changelogs and blogs put the day in the path; it dates the release for free
    (no page fetch) when neither the model nor the search result did.
    """
    for url in urls:
        path = urlparse(url).path if '://' in url else ''
        match = _URL_DATE.search(path)
        if match and (day := _valid_day('-'.join(match.groups()), today)):
            return day
    return None


def _cited(entry: dict[str, Any], results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    raw = entry.get('sources')
    numbers: list[Any] = raw if isinstance(raw, list) else []
    picked = [results[n - 1] for n in numbers if isinstance(n, int) and not isinstance(n, bool) and 0 < n <= len(results)]
    return [result for result in picked if result.get('url')]


def page_date(url: str, today: date, fetch: Callable[..., Any]) -> str | None:
    """The article's own publication date from its page metadata, or None (never raises)."""
    try:
        response = fetch(url, timeout=PAGE_TIMEOUT_SECONDS, max_bytes=MAX_PAGE_BYTES)
        html = response.text[:MAX_PAGE_BYTES] if response.status_code == 200 else ''
    except (requests.RequestException, UnsafeURLError, OSError):
        # Any fetch failure only means "no date from the page".
        logger.info('Radar: article page fetch failed; the release date stays approximate')
        return None
    for pattern in _PAGE_DATE_PATTERNS:
        match = pattern.search(html)
        if match:
            return _valid_day(match.group(1), today)
    return None


@dataclass
class Budget:
    """A countdown of paid actions (web searches, article page fetches) a scan may still take."""

    remaining: int
    used: int = 0

    def take(self) -> bool:
        if self.remaining <= 0:
            return False
        self.remaining -= 1
        self.used += 1
        return True


@dataclass(frozen=True)
class ExtractContext:
    """What extraction needs to know about the brand being scanned."""

    brand: str
    brand_label: str
    domains: tuple[str, ...]
    today: date
    pages: Budget
    fetch: Callable[..., Any]
    #: The brand's search terms: a cited page naming one of them (or the label) is about the brand.
    search_terms: tuple[str, ...] = ()

    @property
    def match(self) -> BrandMatch:
        """The brand as ``keeps_citation`` reads it (the API's ``RadarBrand.citation_match``)."""
        return BrandMatch(label=self.brand_label, terms=self.search_terms, domains=self.domains)


def _candidate(entry: object, ctx: ExtractContext, results: list[dict[str, Any]], via: str) -> ReleaseCandidate | None:
    if not isinstance(entry, dict):
        return None
    feature = ' '.join(str(entry.get('feature') or '').split())[:MAX_FEATURE_CHARS]
    cited = _cited(entry, results)
    if not feature or not cited:
        return None
    cited = [result for result in cited if keeps_citation(result['url'], result.get('title'), ctx.match)]
    if not cited:
        logger.info('Radar: a release cited only pages that do not name the brand; it is not filed')
        return None
    today = ctx.today
    release_date = (_valid_day(entry.get('release_date'), today) or _valid_day(cited[0].get('published_date'), today)
                    or url_date((result['url'] for result in cited), today))
    if release_date is None and ctx.pages.take():
        release_date = page_date(cited[0]['url'], today, ctx.fetch)
    # A feed (`/rss/changelog.json`) may date the release or make it official, but is never shown.
    urls, titles = clean_citations((result['url'] for result in cited), (result.get('title') for result in cited))
    if not urls:
        logger.info('Radar: a release cited only machine feeds; it is not filed without a readable source')
        return None
    return ReleaseCandidate(
        brand=ctx.brand, brand_label=ctx.brand_label, feature=feature,
        summary=' '.join(str(entry.get('summary') or '').split())[:MAX_SUMMARY_CHARS],
        release_date=release_date, urls=tuple(urls), titles=tuple(titles),
        source_kind=source_kind((result['url'] for result in cited), ctx.domains),
        kind=news_kind(entry.get('kind')), found_via=(via,),
    )


def extract_candidates(results: list[dict[str, Any]], ctx: ExtractContext, via: str = 'web') -> list[ReleaseCandidate]:
    """The news one model call finds in ``results`` (``via``: the source that found them, web / exa / feed)."""
    if not results:
        return []
    answer = converse(
        prompt=_prompt(ctx.brand_label, results), system_prompt=SYSTEM_PROMPT,
        max_tokens=1500, surface='utilities', step_name='radar_release_extract',
    )
    entries = _json_object(answer).get('releases')
    if not isinstance(entries, list):
        return []
    found = (_candidate(entry, ctx, results, via) for entry in entries[:MAX_CANDIDATES])
    return [candidate for candidate in found if candidate is not None]
