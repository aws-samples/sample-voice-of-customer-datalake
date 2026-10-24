"""Read one target: its first page (or a resume cursor's page), then the next pages.

Stops at the first of (``TargetResult.stop``):

- ``off_host``: the browser ended up reading a page on another host (a redirect: its
  reviews would be imported under the target's source id); nothing from it is kept.
- ``blocked``: the site blocked the page (``blocked by <vendor>``); what was read is kept.
- ``no_new``: a page that yields no new review (an incremental read only; a backfill
  reading older pages after a resume never stops on it).
- ``reviews``: ``max_reviews`` reviews read (a page cut at the cap resumes AT that page).
- ``pages``: ``max_pages`` pages read (counted from the cursor's page on a resume).
- ``no_next``: no next page.
- ``time``: the run's time budget is spent.

``resume_url`` / ``resume_page`` say where a read stopped by ``reviews`` or ``time``
would continue; the handler decides whether to store them (docs/web-reviews.md).
The next page is the page's own next link, else its page-number parameter plus one;
it must keep the target's origin (scheme, host and port) and pass the outbound URL
policy.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final, Literal, Protocol
from urllib.parse import urlparse

from block_detection import blocked_by
from extract import ExtractedReview
from page_reader import PageSnapshot, page_parameter_successor, same_origin

from shared.web_review_targets import TargetError, checked_url

Stop = Literal['pages', 'reviews', 'no_next', 'no_new', 'time', 'blocked', 'off_host']  # pragma: no mutate  an alias read only as an annotation
#: A NEXT page answered with one of these does not exist: the list ended (``no_next``). The
#: page-number fallback guesses ``?page=N+1`` past the last page, and Trustpilot answers 404;
#: that used to end the target as "blocked by HTTP 404". On the first page it is still a block.
PAST_THE_LAST_PAGE: Final = frozenset({404, 410})


class Tab(Protocol):
    """What reading a target needs of a browser tab (``page_reader.BrowserTab``)."""

    def load(self, url: str) -> PageSnapshot: ...
    def fetch(self, url: str) -> PageSnapshot: ...


@dataclass(frozen=True)
class ReadReview:
    review: ExtractedReview
    page: int
    page_url: str


@dataclass
class TargetResult:
    reviews: list[ReadReview] = field(default_factory=list)
    #: Pages read in total, the resume cursor's pages included.
    pages_read: int = 0
    blocked: str | None = None
    #: The browser was redirected to another host; nothing from that page is kept.
    off_host: bool = False
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
            return _stopped(result, 'off_host')
        if result.pages_read > limits.start_page and snapshot.status in PAST_THE_LAST_PAGE:
            # A guessed next page (`?page=N+1`) that does not exist: the list ended. Not a block.
            return _stopped(result, 'no_next')
        vendor = blocked_by(snapshot.signals())
        if vendor is not None:
            result.blocked = vendor
            return _stopped(result, 'blocked')
        result.pages_read += 1
        any_new, complete = _take(result, snapshot, extract(snapshot), limits, seen_reviews)
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
