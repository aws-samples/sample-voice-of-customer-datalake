"""Backfill across runs: where a target's read stopped early, so the next run continues there.

A target whose read stopped because the run ran out of time (``time``) or reached
its review cap (``reviews``, while the target's own review limit was not reached),
with a page left to read, gets a cursor watermark ``{prefix}_resume`` =
``{"url", "page", "reviews"}``: the page to read next, the pages read so far and
the reviews taken so far by this backfill. The next run (manual or scheduled)
starts the target at the cursor, counts pages and reviews from it, treats every
review as new and does not stop on a page with nothing new. Any other ending
(a limit reached, no next page, blocked, off-host, an error) clears the cursor.
"""

import json
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Final

from page_reader import same_origin
from target_reader import TargetResult
from web_items import WebTarget

from shared.web_review_targets import TargetError, checked_url

#: The stops a later run may continue from.
RESUMABLE_STOPS: Final = frozenset({'time', 'reviews'})


@dataclass(frozen=True)
class ResumeCursor:
    url: str
    page: int
    reviews: int


def _count(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def parsed_cursor(stored: str | None, target: WebTarget) -> ResumeCursor | None:
    """The stored cursor when it is well formed and still applies to *target*, else ``None``.

    It must name a URL on the target's origin the outbound policy allows, and the
    target's limits (perhaps lowered since) must not be reached already.
    """
    if not stored:
        return None
    try:
        data = json.loads(stored)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    url, page, reviews = data.get('url'), _count(data.get('page')), _count(data.get('reviews'))
    if not isinstance(url, str) or page is None or reviews is None or not same_origin(url, target.url):
        return None
    try:
        checked_url(url)
    except TargetError:
        return None
    limit = target.review_limit
    if page >= target.page_limit or (limit is not None and reviews >= limit):
        return None
    return ResumeCursor(url=url, page=page, reviews=reviews)


def next_cursor(cursor: ResumeCursor | None, result: TargetResult, *, target_limit_left: int | None) -> ResumeCursor | None:
    """Where the next run continues the target, or ``None`` when its read is finished.

    *target_limit_left* is what the target's own review limit allowed this read (``None``:
    no limit); reaching it ends the backfill, while the run's cap does not.
    """
    if result.stop not in RESUMABLE_STOPS or result.resume_url is None:
        return None
    if result.stop == 'reviews' and target_limit_left is not None and len(result.reviews) >= target_limit_left:
        return None
    carried = cursor.reviews if cursor else 0
    return ResumeCursor(url=result.resume_url, page=result.resume_page, reviews=carried + len(result.reviews))


class ResumeStore:
    """Every target's cursor, read through *get* and written through *put* (the watermarks).

    A cursor is written only when it changes; clearing writes ``''`` only over a stored value.
    """

    def __init__(self, get: Callable[[str], str | None], put: Callable[[str, str], None]):
        self._get = get
        self._put = put
        self._stored: dict[str, str] = {}

    @staticmethod
    def key(target: WebTarget) -> str:
        return f'{target.watermark_prefix}_resume'

    def load(self, target: WebTarget) -> ResumeCursor | None:
        key = self.key(target)
        stored = self._get(key) or ''
        self._stored[key] = stored
        return parsed_cursor(stored, target)

    def save(self, target: WebTarget, cursor: ResumeCursor | None) -> None:
        key = self.key(target)
        value = json.dumps(asdict(cursor), separators=(',', ':')) if cursor else ''
        if self._stored.get(key, '') != value:
            self._put(key, value)
            self._stored[key] = value
