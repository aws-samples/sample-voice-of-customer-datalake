"""A target read from AgentCore Web Search's snippets: the last step of ``auto`` (docs/web-reviews.md → Methods).

When the browser and Amazon Bedrock web search got nothing, one ``InvokeWebSearch`` request (AgentCore Web Search,
the AWS-managed tool ``web-search.v1``; no model in the retrieval) searches the target's site for its page:

* a SigV4-signed POST (service ``bedrock-agentcore``, the Lambda's own role) to
  ``https://bedrock-agentcore.<region>.amazonaws.com/web-search/web-search.v1/invoke``, the REST path of the
  operation in the AWS SDK model (the Lambda runtime's boto3 may not know the operation yet); IAM:
  ``bedrock-agentcore:InvokeWebSearch`` on ``arn:<partition>:bedrock-agentcore:<region>:aws:tool/web-search.v1``
  only (lib/stacks/ingestion-roles.ts); offered in ``SEARCH_REGIONS``;
* the query is the page's product name or title plus "reviews" (``query_for``), held to the page's domain
  (``filters.domainFilter.include``), ``MAX_RESULTS`` results;
* only the results on the page itself are read (``on_page``): the same path on the site (any subdomain, a trailing
  slash ignored), with the same query once the page-number parameters are left out. A result on another page of the
  site is another business's or product's (a comparison, an "alternatives" list, a neighbour's listing), so when
  none is on the page the step reads nothing;
* the ``enrichment`` model (extract.py ``llm_reviews``, the same call the browser path makes) reads those snippets,
  as data, and a review is kept only when its body is in one snippet, whitespace collapsed (``snippet_reviews``):
  nothing the snippets do not hold is stored. Its title is kept only when the snippet holds it too, its rating and
  date only when the snippet shows them, and never an author (a snippet does not say whose words they are).

Every review it yields is an EXCERPT: the search engine's extract of the page, possibly cut (``cut`` when the snippet
starts or ends with an ellipsis). The handler stores ``excerpt: true`` on it with the snippet, its URL, title and
publication time, the query and when it was read. AgentCore Web Search's acceptable use is Amazon Bedrock Web
Search's: keep the citations and links, never extract or store Search Results in bulk; so the step runs only for a
page an administrator configured, after the other steps failed, once per run, at most ``MAX_SNIPPET_REVIEWS``.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Final
from urllib.parse import parse_qsl, urlparse

from agentcore_browser import SIGNING_SERVICE
from extract import Completion, ExtractedReview, llm_reviews
from page_reader import PAGE_PARAMETERS

from shared.mantle_responses import Post, ResponsesError, signed_post, urlopen_post

#: The AWS-managed tool and the regions that offer it (AgentCore devguide, web-search-api.html → Regions); its
#: requests are signed for ``bedrock-agentcore`` (agentcore_browser.py ``SIGNING_SERVICE``, the browser's too).
SEARCH_TOOL_ID: Final = 'web-search.v1'
SEARCH_REGIONS: Final = frozenset({'us-east-1', 'us-east-2', 'us-west-2', 'ap-southeast-2', 'ap-northeast-1',
                                   'eu-west-1'})
MAX_RESULTS: Final = 10
MAX_QUERY_CHARS: Final = 200
REQUEST_TIMEOUT_SECONDS: Final = 60
#: Reviews one step keeps at most (as many as a Bedrock web search read).
MAX_SNIPPET_REVIEWS: Final = 20
#: How the snippets are joined for the model, one passage each.
SNIPPET_SEPARATOR: Final = '\n\n---\n\n'
_MONTHS: Final = ('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                  'November', 'December')
_ELLIPSES: Final = ('...', '…')


class SnippetSearchError(ResponsesError):
    """InvokeWebSearch refused the request or did not answer readably; the message is client-safe."""


@dataclass(frozen=True)
class SearchResult:
    url: str
    title: str | None
    text: str
    published_at: str | None


@dataclass(frozen=True)
class SnippetReview:
    """A review found in one snippet, and the result it is in; ``cut`` when that snippet is a cut passage."""

    review: ExtractedReview
    source: SearchResult
    cut: bool


def search_url(region: str) -> str:
    """InvokeWebSearch's REST endpoint: the operation's request URI in the AWS SDK model, for the managed tool."""
    return f'https://bedrock-agentcore.{region}.amazonaws.com/web-search/{SEARCH_TOOL_ID}/invoke'


def query_for(subject: str) -> str:
    """The search for a page about *subject*: ``"<subject> reviews"`` (as it is when it says "review" already)."""
    cleaned = ' '.join(subject.split())
    query = cleaned if 'review' in cleaned.lower() else f'{cleaned} reviews'
    return query[:MAX_QUERY_CHARS]


def search_request(query: str, domain: str, max_results: int = MAX_RESULTS) -> dict[str, Any]:
    return {'searchQuery': query, 'maxResults': max_results, 'filters': {'domainFilter': {'include': [domain]}}}


def _result(item: object) -> SearchResult | None:
    if not isinstance(item, dict) or not isinstance(item.get('text'), str) or not isinstance(item.get('url'), str):
        return None
    title, published = item.get('title'), item.get('publishedAt')
    return SearchResult(url=item['url'], title=title if isinstance(title, str) else None, text=item['text'],
                        published_at=published if isinstance(published, str) else None)


def invoke_web_search(query: str, domain: str, *, region: str, credentials: Any, post: Post = urlopen_post,
                      max_results: int = MAX_RESULTS) -> list[SearchResult]:
    """One InvokeWebSearch: its results that carry a URL and text, in ranked order."""
    try:
        answer = signed_post(search_url(region), search_request(query, domain, max_results), region, credentials, post,
                             REQUEST_TIMEOUT_SECONDS, service=SIGNING_SERVICE)
    except ResponsesError as error:
        raise SnippetSearchError(str(error), error.status) from error
    results = answer.get('results')
    if not isinstance(results, list):
        raise SnippetSearchError('an answer without results')
    return [result for item in results if (result := _result(item)) is not None]


def _page_identity(url: str) -> tuple[str, str, frozenset[tuple[str, str]]] | None:
    """The site, the path (no trailing slash) and the query without page numbers that say which page *url* is."""
    parts = urlparse(url)
    host = (parts.hostname or '').lower()
    if not host:
        return None
    query = frozenset((key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                      if key.lower() not in PAGE_PARAMETERS)
    return host, parts.path.rstrip('/') or '/', query


def _same_site(host: str, page_host: str) -> bool:
    """*host* is *page_host*'s site: its domain (the host without ``www.``, which the search is held to) or a
    subdomain of it (``www.``, a locale's ``it.``)."""
    domain = page_host.removeprefix('www.')
    return host == domain or host.endswith(f'.{domain}')


def on_page(results: Sequence[SearchResult], page_url: str) -> list[SearchResult]:
    """The results that are *page_url* itself (the module docstring): same site, same path, same query (page-number
    parameters aside)."""
    page = _page_identity(page_url)
    if page is None:
        return []
    kept = []
    for result in results:
        found = _page_identity(result.url)
        if found is not None and _same_site(found[0], page[0]) and found[1:] == page[1:]:
            kept.append(result)
    return kept


def _collapsed(text: str) -> str:
    return ' '.join(text.split())


def _shows_rating(snippet: str, rating: float) -> bool:
    """Whether *snippet* shows *rating* as a rating out of 5 ("4/5", "4.0 out of 5", "4 stars")."""
    values = '|'.join(re.escape(value) for value in {f'{rating:g}', f'{rating:.1f}'})
    pattern = rf'(?<![\d.])(?:{values})\s*(?:/\s*5\b|out of 5\b|-?stars?\b|★)'
    return re.search(pattern, snippet, re.IGNORECASE) is not None


def _shows_date(snippet: str, iso: str) -> bool:
    """Whether *snippet* shows *iso* (as written, or "October 1, 2026" / "Oct 1, 2026" / "1 October 2026")."""
    day = datetime.fromisoformat(iso)
    month = _MONTHS[day.month - 1]
    spellings = {iso, f'{month} {day.day}, {day.year}', f'{month[:3]} {day.day}, {day.year}',
                 f'{day.day} {month} {day.year}', f'{day.day} {month[:3]} {day.year}'}
    lowered = snippet.lower()
    return any(spelling.lower() in lowered for spelling in spellings)


def from_snippet(review: ExtractedReview, snippet: str) -> ExtractedReview:
    """*review* with only what *snippet* shows: its title, rating and date when written there, never an author."""
    title = review.title if review.title and _collapsed(review.title).lower() in snippet.lower() else None
    rating = review.rating if review.rating is not None and _shows_rating(snippet, review.rating) else None
    published = review.date if review.date is not None and _shows_date(snippet, review.date) else None
    return replace(review, title=title, rating=rating, date=published, author=None)


def is_cut(snippet: str) -> bool:
    return snippet.startswith(_ELLIPSES) or snippet.endswith(_ELLIPSES)


def snippet_reviews(results: Sequence[SearchResult], complete: Completion,
                    max_reviews: int = MAX_SNIPPET_REVIEWS) -> tuple[list[SnippetReview], int]:
    """``(the reviews whose body is in one snippet, at most max_reviews; how many the model gave that are not)``."""
    snippets = [_collapsed(result.text) for result in results]
    if not any(snippets):
        return [], 0
    kept: list[SnippetReview] = []
    dropped = 0
    for review in llm_reviews(SNIPPET_SEPARATOR.join(snippets), complete):
        body = _collapsed(review.text)
        index = next((i for i, snippet in enumerate(snippets) if body and body in snippet), None)
        if index is None:
            dropped += 1
            continue
        if len(kept) >= max_reviews:
            break
        snippet = snippets[index]
        kept.append(SnippetReview(from_snippet(review, snippet), results[index], is_cut(snippet)))
    return kept, dropped

