"""Why a live page could not be read, in words the admin can act on (pure; no AWS).

Block detection (the web_reviews plugin's ``block_detection.blocked_by``) answers a vendor name
(``'Cloudflare'``), ``'access denied'``, or ``'HTTP <status>'`` for ANY main-document status ≥ 400 —
it reads a 404 as a refusal because, for a review crawl, every non-page is "not readable". A design
reference needs the difference, because the next step differs:

* a bot challenge, or HTTP 401 / 403 / 429 → the site **blocked** the secure browser: upload a
  screenshot or the HTML instead;
* HTTP 404 / 410 → the page was **not found**: check the address;
* HTTP 5xx → the site **errored**: try again later;
* any other 4xx (400, 405, 451…) → the site **refused the request**: check the address.

Every ``CaptureError`` carries a short ``reason`` code (and the HTTP status when there is one) for
the capture log, so a failure is diagnosable without the page's URL.
"""
from __future__ import annotations

from typing import Final

from shared.http_statuses import NOT_FOUND_STATUSES

BLOCKED_STATUSES: Final = frozenset({401, 403, 429})
CLIENT_ERROR_FROM: Final = 400
SERVER_ERROR_FROM: Final = 500
_HTTP_LABEL_PREFIX: Final = 'HTTP '


class CaptureError(Exception):
    """A user-safe reason the page could not be read (stored as the reference's ``error``).

    ``reason`` is a short code for the log (``not_found``, ``blocked``, ``site_error``…), and
    ``http_status`` the main document's status when that is what failed (0 otherwise).
    """

    def __init__(self, message: str, *, reason: str = 'capture_error', http_status: int = 0):
        super().__init__(message)
        self.reason = reason
        self.http_status = http_status


def _blocked(label: str, status: int) -> CaptureError:
    return CaptureError(f'The site blocked the secure browser ({label}); upload a screenshot or the HTML instead',
                        reason='blocked', http_status=status)


def _by_status(status: int) -> CaptureError | None:
    label = f'{_HTTP_LABEL_PREFIX}{status}'
    if status in NOT_FOUND_STATUSES:
        return CaptureError(f'The page was not found ({label}); check the address, then Fetch again',
                            reason='not_found', http_status=status)
    if status in BLOCKED_STATUSES:
        return _blocked(label, status)
    if status >= SERVER_ERROR_FROM:
        return CaptureError(f'The site answered with an error ({label}); try Fetch again later',
                            reason='site_error', http_status=status)
    if status >= CLIENT_ERROR_FROM:
        return CaptureError(f'The site refused the request ({label}); check the address, then Fetch again',
                            reason='refused', http_status=status)
    return None


def page_problem(status: int, blocker: str | None) -> CaptureError | None:
    """The error for a page whose main document answered *status* and that block detection judged
    *blocker* (``None`` = readable), or ``None`` when the page can be read.

    A vendor's challenge wins over the status (a Cloudflare wall answers 403 or 503 alike); a bare
    ``'HTTP <n>'`` verdict is replaced by what that status means.
    """
    if blocker is not None and not blocker.startswith(_HTTP_LABEL_PREFIX):
        return _blocked(blocker, status)
    return _by_status(status)
