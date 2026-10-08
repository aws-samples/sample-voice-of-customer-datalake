"""
A small GitHub REST client for the github_issues ingestor.

Deliberately not ``shared.http_utils.fetch_with_retry``: that retries a 429 with
exponential back-off, i.e. it SLEEPS, and a rate-limited GitHub token is not a
transient fault — the reset can be up to an hour away, far past any Lambda's
budget. Here a rate limit, a nearly-spent quota or a nearly-spent Lambda budget
raise :class:`StopRun` instead; the ingestor catches it, keeps what it already
fetched, and the next scheduled run resumes from the watermark.

The token travels only in the ``Authorization`` header. It is never logged and
never part of an exception message (``GitHubError`` names the status and path).
"""

import time
from collections.abc import Callable, Generator
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

__all__ = ["GITHUB_API", "GitHubClient", "GitHubError", "GitHubNotFound", "GitHubPage", "StopRun"]

GITHUB_API = "https://api.github.com"
API_VERSION = "2022-11-28"
REQUEST_TIMEOUT_SECONDS = 15
#: Stop while a few requests of quota remain, so an operator's own use of the
#: token (or the webhook-triggered UI) is not starved to zero by the poller.
MIN_REMAINING_QUOTA = 25
#: Never start a request with less than this much Lambda time left: the run
#: still has to enqueue what it fetched and commit its watermarks.
MIN_SECONDS_PER_REQUEST = REQUEST_TIMEOUT_SECONDS + 5


class StopRun(Exception):
    """End the run early but successfully — progress so far is kept."""

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        super().__init__(f"{reason}{': ' + detail if detail else ''}")


class GitHubError(Exception):
    """A response that is a real failure (bad token, server error). Counts against the breaker."""


class GitHubNotFound(GitHubError):
    """404: the repo does not exist, or the token cannot see it (GitHub answers both alike)."""


@dataclass
class GitHubPage:
    """One response: its JSON body, ETag, next-page URL, and whether it was a 304."""
    body: object = None
    etag: str | None = None
    next_url: str | None = None
    not_modified: bool = False


def _http_get(url: str, headers: dict, params: dict | None, timeout: int) -> requests.Response:
    """The network seam. Tests patch this; nothing else in the plugin opens a socket."""
    return requests.get(url, headers=headers, params=params, timeout=timeout)


def _next_link(link_header: str | None) -> str | None:
    """The ``rel="next"`` URL of a ``Link`` header, if any."""
    if not link_header:
        return None
    for part in link_header.split(","):
        segments = part.split(";")
        url = segments[0].strip()
        if url.startswith("<") and url.endswith(">") and any(s.strip() == 'rel="next"' for s in segments[1:]):
            return url[1:-1]
    return None


def _int_header(headers: dict[str, str], name: str) -> int | None:
    value = headers.get(name)
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


class GitHubClient:
    """GET-only, rate-limit-aware access to ``api.github.com`` with one token."""

    def __init__(
        self,
        token: str,
        deadline: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._token = token
        self._deadline = deadline
        self._clock = clock
        self._quota_spent = False  # pragma: no mutate  only ever read as a truth value; None behaves identically
        self.requests_made = 0

    def _headers(self, etag: str | None) -> dict:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self._token}",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "voc-datalake-github-issues",
        }
        if etag:
            headers["If-None-Match"] = etag
        return headers

    def _check_budget(self) -> None:
        if self._quota_spent:
            raise StopRun("rate_limited", "quota floor reached")
        if self._deadline is not None and self._deadline - self._clock() < MIN_SECONDS_PER_REQUEST:
            raise StopRun("time_budget")

    def get(self, url: str, params: dict | None = None, etag: str | None = None) -> GitHubPage:
        """One GET. Raises StopRun (rate limit / budget), GitHubNotFound or GitHubError."""
        if urlsplit(url).netloc != urlsplit(GITHUB_API).netloc:
            # A Link header is server data; never send the token anywhere else.
            raise GitHubError(f"refusing to follow a link off {GITHUB_API}")
        self._check_budget()
        response = _http_get(url, self._headers(etag), params, REQUEST_TIMEOUT_SECONDS)
        self.requests_made += 1
        headers = {k.lower(): v for k, v in response.headers.items()}
        remaining = _int_header(headers, "x-ratelimit-remaining")
        if remaining is not None and remaining <= MIN_REMAINING_QUOTA:
            self._quota_spent = True
        path = urlsplit(url).path
        status = response.status_code

        if status == 304:
            return GitHubPage(etag=etag, not_modified=True)
        if status in (403, 429) and (headers.get("retry-after") or remaining == 0):
            raise StopRun("rate_limited", f"retry after {headers.get('retry-after') or headers.get('x-ratelimit-reset')}")
        if status == 404:
            raise GitHubNotFound(f"GitHub {status} for {path}")
        if status >= 400:
            raise GitHubError(f"GitHub {status} for {path}")
        return GitHubPage(
            body=response.json(),
            etag=headers.get("etag"),
            next_url=_next_link(headers.get("link")),
        )

    def paginate(
        self, url: str, params: dict | None = None, etag: str | None = None,
    ) -> Generator[GitHubPage, None, None]:
        """Every page, following ``Link: rel="next"`` (which already carries the query).

        The ETag goes on the FIRST request only; a 304 there ends the listing.
        """
        page = self.get(url, params=params, etag=etag)
        yield page
        while page.next_url and not page.not_modified:
            page = self.get(page.next_url)
            yield page
