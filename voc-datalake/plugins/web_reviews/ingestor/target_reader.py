"""Read one target: its first page (or a resume cursor's page), then the next pages.

Stops at the first of (``TargetResult.stop``):

- ``off_host``: the browser ended up reading a page on another host (a redirect: its
  reviews would be imported under the target's source id); nothing from it is kept.
  ``error_page`` when that page is an error page (Chrome's ``chrome-error://chromewebdata/``,
  an HTTP 4xx/5xx answer or a bot wall), which ``auto`` reads as a block.
- ``blocked``: the site blocked the page (``blocked by <vendor>``); what was read is kept.
- ``no_new``: a page that yields no new review (an incremental read only; a backfill
  reading older pages after a resume never stops on it).
- ``reviews``: ``max_reviews`` reviews read (a page cut at the cap resumes AT that page).
- ``pages``: ``max_pages`` pages read (counted from the cursor's page on a resume).
- ``no_next``: no next page.
- ``time``: the run's time budget is spent.

``resume_url`` / ``resume_page`` say where a read stopped by ``reviews`` or ``time``
would continue; the handler decides whether to store them (docs/web-reviews.md).
``extracted`` counts every review the pages held (new or not), ``title`` is the first page's
title and ``declares_reviews`` whether its JSON-LD gives a review count above 0: what ``auto``
needs to tell "this page has no reviews" from "the browser could not read them".
The next page is the page's own next link, else its page-number parameter plus one;
it must keep the target's origin (scheme, host and port) and pass the outbound URL
policy.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol
from urllib.parse import urlparse

from block_detection import BLOCKED_STATUS_FROM, blocked_by
from extract import ExtractedReview, declared_review_count
from page_reader import PageSnapshot, page_parameter_successor, same_origin

from shared.http_statuses import NOT_FOUND_STATUSES
from shared.web_review_targets import TargetError, checked_url

Stop = Literal['pages', 'reviews', 'no_next', 'no_new', 'time', 'blocked', 'off_host']  # pragma: no mutate  an alias read only as an annotation
# A NEXT page answered with NOT_FOUND_STATUSES (404 / 410) does not exist: the list ended (``no_next``).
# The page-number fallback guesses ``?page=N+1`` past the last page, and Trustpilot answers 404;
# that used to end the target as "blocked by HTTP 404". On the first page it is still a block.


class Tab(Protocol):
    """What reading a target needs of a browser tab (``page_reader.BrowserTab``)."""

    def load(self, url: str) -> PageSnapshot: ...
    def fetch(self, url: str) -> PageSnapshot: ...


#: Where Chrome shows its own error page (a navigation that failed: ``chrome-error://chromewebdata/``).
CHROME_ERROR_SCHEME = 'chrome-error'
CHROME_ERROR_HOST = 'chromewebdata'


@dataclass(frozen=True)
class ReadReview:
    review: ExtractedReview
    page: int
    page_url: str
    #: Metadata of this review alone, beside its read's (an AgentCore Web Search snippet's URL, title, text).
    attribution: dict[str, object] | None = None


@dataclass
class TargetResult:
    reviews: list[ReadReview] = field(default_factory=list)
    #: Pages read in total, the resume cursor's pages included.
    pages_read: int = 0
    blocked: str | None = None
    #: The browser was redirected to another host; nothing from that page is kept.
    off_host: bool = False
    #: That other host's page was an error page (``is_error_page``).
    error_page: bool = False
    #: Reviews the pages held, new or not, and what page 1 said of itself.
    extracted: int = 0
    title: str = ''
    declares_reviews: bool = False
    stop: Stop = 'no_next'
    #: Where a read stopped by ``reviews`` or ``time`` continues, and the pages read before it.
    resume_url: str | None = None
    resume_page: int = 0


def _no_op(_snapshot: PageSnapshot) -> None:
    return None


@dataclass(frozen=True)
class ReadLimits:
    max_pages: int
    max_reviews: int
    #: Whether time is left to read one more page.
    has_time: Callable[[], bool]
    #: Whether a review is new enough to send (the target's watermark).
    is_new: Callable[[ExtractedReview], bool]
    #: Pages already read by the backfill this read resumes (0 = a fresh read).
    start_page: int = 0
    #: Whether a page without a new review ends the read (False while backfilling).
    stop_when_nothing_new: bool = True
    #: Called with every page whose reviews were all taken (the page cache records it).
    after_page: Callable[[PageSnapshot], None] = field(default_factory=lambda: _no_op)


def is_error_page(snapshot: PageSnapshot) -> bool:
    """Whether *snapshot* is an error page: Chrome's own, an HTTP 4xx/5xx answer, or a bot wall."""
    parts = urlparse(snapshot.url)
    return (parts.scheme == CHROME_ERROR_SCHEME or parts.hostname == CHROME_ERROR_HOST
            or snapshot.status >= BLOCKED_STATUS_FROM or blocked_by(snapshot.signals()) is not None)


def _review_key(review: ExtractedReview) -> tuple[str, str | None]:
    return review.text, review.date


def next_page_url(snapshot: PageSnapshot, target_url: str, seen: set[str]) -> str | None:
    """The page after *snapshot*, when there is one on *target_url*'s origin the policy lets the plugin read."""
    candidate = snapshot.next_url or page_parameter_successor(snapshot.url)
    if candidate is None or candidate in seen or not same_origin(candidate, target_url):
        return None
    try:
        return checked_url(candidate)
    except TargetError:
        return None


def _take(result: TargetResult, snapshot: PageSnapshot, reviews: list[ExtractedReview],
          limits: ReadLimits, seen: set[tuple[str, str | None]]) -> tuple[bool, bool]:
    """Add the new reviews of one page to *result* (within the cap).

    ``(any was new, every new review was taken)``: the second is false when the cap cut the page.
    """
    before = len(result.reviews)
    complete = True
    for review in reviews:
        key = _review_key(review)
        if key in seen or not limits.is_new(review):
            continue
        if len(result.reviews) >= limits.max_reviews:
            complete = False
            break
        seen.add(key)
        result.reviews.append(ReadReview(review, result.pages_read, snapshot.url))
    return len(result.reviews) > before, complete


def _stopped(result: TargetResult, stop: Stop, resume_url: str | None = None, resume_page: int = 0) -> TargetResult:
    result.stop = stop
    result.resume_url = resume_url
    result.resume_page = resume_page
    return result


def _limit_reached(result: TargetResult, snapshot: PageSnapshot, following: str | None, limits: ReadLimits,
                   any_new: bool, complete: bool) -> TargetResult | None:
    """The result when this page ends the read by a limit (cap, nothing new, pages), else ``None``."""
    if not complete:
        return _stopped(result, 'reviews', snapshot.url, result.pages_read - 1)
    if not any_new and limits.stop_when_nothing_new:
        return _stopped(result, 'no_new')
    if len(result.reviews) >= limits.max_reviews:
        return _stopped(result, 'reviews', following, result.pages_read)
    if result.pages_read >= limits.max_pages:
        return _stopped(result, 'pages')
    return None


def read_target(tab: Tab, url: str, extract: Callable[[PageSnapshot], list[ExtractedReview]],
                limits: ReadLimits) -> TargetResult:
    """*extract* returns the reviews on one page; *url* is the target's URL or its resume cursor's."""
    result = TargetResult(pages_read=limits.start_page)
    host = urlparse(url).hostname
    seen_pages = {url}
    seen_reviews = set[tuple[str, str | None]]()
    snapshot = tab.load(url)
    while True:
        if urlparse(snapshot.url).hostname != host:
            result.off_host = True
            result.error_page = is_error_page(snapshot)
            return _stopped(result, 'off_host')
        if result.pages_read > limits.start_page and snapshot.status in NOT_FOUND_STATUSES:
            # A guessed next page (`?page=N+1`) that does not exist: the list ended. Not a block.
            return _stopped(result, 'no_next')
        vendor = blocked_by(snapshot.signals())
        if vendor is not None:
            result.blocked = vendor
            return _stopped(result, 'blocked')
        if result.pages_read == limits.start_page:
            result.title = snapshot.title
            result.declares_reviews = declared_review_count(snapshot.jsonld) > 0
        result.pages_read += 1
        reviews = extract(snapshot)
        result.extracted += len(reviews)
        any_new, complete = _take(result, snapshot, reviews, limits, seen_reviews)
        if complete:
            limits.after_page(snapshot)
        following = next_page_url(snapshot, url, seen_pages)
        stopped = _limit_reached(result, snapshot, following, limits, any_new, complete)
        if stopped is not None:
            return stopped
        if following is None:
            return _stopped(result, 'no_next')
        if not limits.has_time():
            return _stopped(result, 'time', following, result.pages_read)
        seen_pages.add(following)
        snapshot = tab.fetch(following)
