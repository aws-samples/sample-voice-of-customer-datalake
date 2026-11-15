"""A target read through Amazon Bedrock web search (``method: bedrock_web_search``, docs/web-reviews.md → Methods).

Nothing loads the page here. An OpenAI GPT model on the Responses API of the ``bedrock-mantle``
endpoint opens it from the Amazon Bedrock web index and cache with the ``web_search`` tool and
returns the reviews it shows, as JSON:

* the request is SigV4-signed for the ``bedrock-mantle`` service with the Lambda's own role (no
  API key); IAM: lib/stacks/ingestion-roles.ts (``bedrock-mantle:CreateInference`` on the default
  project, ``bedrock-websearch:InvokeSearch`` / ``InvokeFetch`` in the region, never
  ``ExternalWebAccess``);
* cache only (``external_web_access: false``): Amazon's copy of the page, which may be older than
  the live page; ``search_context_size: low``; held to the target's site (``allowed_domains``);
* ONE request per target per run, for the target's own page (never the next pages), asking for at
  most ``MAX_WEB_SEARCH_REVIEWS`` reviews (fewer when the target or the run allows fewer).

What comes back is the model's reading, so it is checked before anything is queued: a review must
be marked ``review`` (the model marks a page's own summary, an AI digest or a rating overview
``summary``) and must not read like one (``SUMMARY_PHRASES``); its body is cleaned and bounded
like every other path (``extract.validated_review``: 1-5,000 characters), the rating brought to 1-5
by its own scale (a TrustRadius 8/10 is 4.0), the date kept only as an ISO date; a review read
twice is kept once. Each read keeps its attribution: the page asked for, when, the model, and the
URLs the model opened and cited (``WebSearchRead``), which the handler stores on every item.

Acceptable use (the Web Search terms): Search Results may not be extracted, stored or reproduced in
bulk, nor used to build a competing index or database, and citations and links must be kept. So
this method reads only the review pages an administrator configured, one page per run, a few
reviews at a time, and every stored review carries its source URL and the method.
"""

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Final
from urllib.parse import urlparse

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from extract import ExtractedReview, validated_review

#: The service the Responses API requests are signed for, and its OpenAI-compatible path.
SIGNING_SERVICE: Final = 'bedrock-mantle'
RESPONSES_PATH: Final = '/openai/v1/responses'
#: Reviews asked for per target per run, at most.
MAX_WEB_SEARCH_REVIEWS: Final = 20
#: Seconds one request may take (a page is typically read in 13-21 s).
REQUEST_TIMEOUT_SECONDS: Final = 180
#: First HTTP status that is the API's refusal.
HTTP_ERROR_FROM: Final = 400
#: Characters of an error answer kept in the client-safe message.
ERROR_DETAIL_CHARS: Final = 160
#: Phrases of a summary of many reviews, not one customer's review (lower-cased).
SUMMARY_PHRASES: Final = (
    'users find', 'users say', 'users mention', 'users report', 'reviewers say', 'reviewers mention',
    'reviewers find', 'receives positive feedback', 'receives mixed feedback', 'receives negative feedback',
    'overall, users', 'many users', 'most users', 'customers generally', 'according to reviews',
)
_FENCE_RE: Final = re.compile(r'^\s*```(?:json)?\s*|\s*```\s*$')

#: The answer's shape: the model must fill every field (null when the page does not show it).
REVIEWS_SCHEMA: Final = {
    'type': 'object', 'additionalProperties': False, 'required': ['fetched', 'reason', 'reviews'],
    'properties': {
        'fetched': {'type': 'boolean'},
        'reason': {'type': ['string', 'null']},
        'reviews': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False,
            'required': ['review_kind', 'author', 'rating', 'rating_scale', 'date', 'title', 'body'],
            'properties': {
                'review_kind': {'type': 'string', 'enum': ['review', 'summary']},
                'author': {'type': ['string', 'null']},
                'rating': {'type': ['number', 'null']},
                'rating_scale': {'type': ['number', 'null']},
                'date': {'type': ['string', 'null']},
                'title': {'type': ['string', 'null']},
                'body': {'type': 'string'},
            },
        }},
    },
}

#: ``(url, body, headers, timeout) -> (status, response body)``; the handler passes ``_urlopen``.
Post = Callable[[str, bytes, dict[str, str], float], tuple[int, bytes]]  # pragma: no mutate  an alias read only as an annotation


class WebSearchError(RuntimeError):
    """The Responses API refused the request or did not answer; the message is client-safe."""


@dataclass(frozen=True)
class WebSearchRead:
    """One target's page as the model read it from the Bedrock web search cache."""

    reviews: list[ExtractedReview]
    model: str
    #: Whether the model says it opened the page (``reason`` when it did not).
    fetched: bool
    reason: str | None = None
    #: The URLs the model's ``web_search`` calls opened, and those its answer cited.
    opened_urls: list[str] = field(default_factory=list)
    cited_urls: list[str] = field(default_factory=list)
    #: Reviews the checks dropped: marked or reading like a summary, or invalid.
    dropped: int = 0


def responses_url(region: str) -> str:
    return f'https://bedrock-mantle.{region}.api.aws{RESPONSES_PATH}'


def site_domain(url: str) -> str:
    """The domain the tool is held to: the page's host without ``www.`` (its subdomains match too)."""
    host = (urlparse(url).hostname or '').lower()
    return host.removeprefix('www.')


def prompt_for(url: str, max_reviews: int) -> str:
    return (
        f'Open this exact page with the web search tool: {url}\n'
        f'Return ONLY the customer reviews that appear on that page, at most {max_reviews}. Copy each review body '
        'verbatim: never summarise, merge or paraphrase it. Mark a review written by one customer review_kind '
        '"review"; mark a summary of many reviews, an AI-generated summary, a pros and cons digest or a rating '
        'overview review_kind "summary". Use null for any field the page does not show (author; rating; '
        'rating_scale, such as 5 or 10; date as YYYY-MM-DD; title): never invent one. If you could not open the '
        'page, set fetched to false and give the reason.'
    )


def request_body(url: str, model: str, max_reviews: int, *, structured: bool = True) -> dict[str, Any]:
    """The Responses API request; ``structured`` asks for the JSON schema (a model that refuses it is asked
    again without it, the prompt still asking for the same JSON)."""
    body: dict[str, Any] = {
        'model': model,
        'input': prompt_for(url, max_reviews),
        'tools': [{
            'type': 'web_search', 'external_web_access': False, 'search_context_size': 'low',
            'filters': {'allowed_domains': [site_domain(url)]},
        }],
    }
    if structured:
        body['text'] = {'format': {'type': 'json_schema', 'name': 'page_reviews', 'strict': True,
                                   'schema': REVIEWS_SCHEMA}}
    return body


def _urlopen(url: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method='POST')  # noqa: S310  an https URL built here
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310  same
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def signed_post(url: str, payload: dict[str, Any], region: str, credentials: Any, post: Post) -> dict[str, Any]:
    """POST *payload* SigV4-signed for ``bedrock-mantle``; the JSON answer, or ``WebSearchError``."""
    data = json.dumps(payload).encode()
    request = AWSRequest(method='POST', url=url, data=data, headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, SIGNING_SERVICE, region).add_auth(request)
    try:
        status, raw = post(url, data, dict(request.headers.items()), REQUEST_TIMEOUT_SECONDS)
    except (OSError, ValueError) as error:  # URLError and timeouts are OSErrors
        raise WebSearchError(f'no answer ({type(error).__name__})') from error
    if status >= HTTP_ERROR_FROM:
        detail = raw.decode('utf-8', 'replace')[:ERROR_DETAIL_CHARS]
        raise WebSearchError(f'HTTP {status}: {detail}')
    try:
        answer = json.loads(raw)
    except ValueError as error:
        raise WebSearchError('an unreadable answer') from error
    if not isinstance(answer, dict):
        raise WebSearchError('an unreadable answer')
    return answer


def _refuses_the_schema(error: WebSearchError) -> bool:
    text = str(error).lower()
    return text.startswith('http 400') and any(word in text for word in ('format', 'json_schema', 'schema'))


def _output_items(answer: dict[str, Any]) -> list[dict[str, Any]]:
    output = answer.get('output')
    return [item for item in output if isinstance(item, dict)] if isinstance(output, list) else []


def answer_text(answer: dict[str, Any]) -> str:
    """The text of the answer's message items."""
    return ''.join(
        str(part.get('text') or '')
        for item in _output_items(answer) if item.get('type') == 'message'
        for part in item.get('content') or [] if isinstance(part, dict) and part.get('type') == 'output_text'
    )


def opened_urls(answer: dict[str, Any]) -> list[str]:
    """The URLs the model's ``web_search`` calls opened (``action.url``), in order, each once."""
    urls: list[str] = []
    for item in _output_items(answer):
        action = item.get('action') if item.get('type') == 'web_search_call' else None
        url = action.get('url') if isinstance(action, dict) else None
        if isinstance(url, str) and url and url not in urls:
            urls.append(url)
    return urls


def cited_urls(answer: dict[str, Any]) -> list[str]:
    """The ``url_citation`` annotations' URLs, in order, each once."""
    urls: list[str] = []
    for item in _output_items(answer):
        if item.get('type') != 'message':
            continue
        for part in item.get('content') or []:
            for note in (part.get('annotations') or []) if isinstance(part, dict) else []:
                url = note.get('url') if isinstance(note, dict) and note.get('type') == 'url_citation' else None
                if isinstance(url, str) and url and url not in urls:
                    urls.append(url)
    return urls


def reads_like_a_summary(body: str) -> bool:
    lowered = body.lower()
    return any(phrase in lowered for phrase in SUMMARY_PHRASES)


def _rating(value: object, scale: object) -> float | None:
    """*value* on a 1-5 scale, divided by its own *scale* (5 assumed when none); ``None`` when it is not a
    rating or falls outside 1-5 (the review is kept without one)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    out_of = scale if isinstance(scale, int | float) and not isinstance(scale, bool) and scale > 0 else 5
    rating = round(float(value) * 5 / out_of, 1)
    return rating if 1 <= rating <= 5 else None


def _iso_day(value: object) -> str | None:
    """*value* when it is a ``YYYY-MM-DD`` date; any other date the page shows is dropped (the review is kept)."""
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        return None


def _parsed(text: str) -> object:
    try:
        return json.loads(_FENCE_RE.sub('', text))
    except ValueError:
        return None


def page_reviews(text: str, max_reviews: int) -> tuple[bool, str | None, list[ExtractedReview], int]:
    """``(fetched, reason, reviews, dropped)`` of the model's answer *text*; a bare list is read as the reviews."""
    parsed = _parsed(text)
    if isinstance(parsed, list):
        parsed = {'fetched': True, 'reason': None, 'reviews': parsed}
    if not isinstance(parsed, dict):
        return False, 'the answer was not the JSON asked for', [], 0
    raw_reason = parsed.get('reason')
    reason = raw_reason if isinstance(raw_reason, str) and raw_reason else None
    listed = parsed.get('reviews')
    items: list[object] = listed if isinstance(listed, list) else []
    reviews: list[ExtractedReview] = []
    seen: set[tuple[str, str | None]] = set()
    dropped = 0
    for item in items:
        review = _review(item)
        if review is None:
            dropped += 1
            continue
        if (review.text, review.date) in seen:
            continue
        seen.add((review.text, review.date))
        if len(reviews) < max_reviews:
            reviews.append(review)
    return parsed.get('fetched') is not False, reason, reviews, dropped


def _review(item: object) -> ExtractedReview | None:
    if not isinstance(item, dict) or item.get('review_kind', 'review') != 'review':
        return None
    body = item.get('body')
    if not isinstance(body, str) or reads_like_a_summary(body):
        return None
    return validated_review(body, _rating(item.get('rating'), item.get('rating_scale')), _iso_day(item.get('date')),
                            item.get('title'), item.get('author'))


def read_web_search_target(
    url: str, model: str, max_reviews: int, *, region: str, credentials: Any, post: Post = _urlopen,
) -> WebSearchRead:
    """*url*'s reviews as *model* reads them from the web search cache (one request, two when the model refuses
    the JSON schema)."""
    endpoint = responses_url(region)
    try:
        answer = signed_post(endpoint, request_body(url, model, max_reviews), region, credentials, post)
    except WebSearchError as error:
        if not _refuses_the_schema(error):
            raise
        answer = signed_post(endpoint, request_body(url, model, max_reviews, structured=False), region, credentials, post)
    fetched, reason, reviews, dropped = page_reviews(answer_text(answer), max_reviews)
    return WebSearchRead(reviews=reviews, model=model, fetched=fetched, reason=reason,
                         opened_urls=opened_urls(answer), cited_urls=cited_urls(answer), dropped=dropped)
