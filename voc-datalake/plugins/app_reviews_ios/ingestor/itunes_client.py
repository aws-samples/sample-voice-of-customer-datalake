"""
Apple App Store review client using app-store-web-scraper.

Wraps the library with connection pooling, rate limiting, and error handling.

We page through the RSS customer-reviews feed ourselves (via the library's
session) instead of using AppStoreEntry.reviews(), because that method STOPS at
the first page with no "entry" key. Apple's RSS intermittently returns an empty
page in the middle of a populated feed (e.g. kr page 4 is empty while pages
5-10 have reviews), so the library terminates early and we lose most reviews.
We instead skip empty pages and only stop after several consecutive empties.
"""

import urllib3
from app_store_web_scraper import AppStoreSession
from app_store_web_scraper._errors import AppStoreError
from app_store_web_scraper._utils import fromisoformat_utc

from _shared.base_ingestor import logger

# Apple's RSS customer-reviews feed exposes at most 10 pages (~50 each).
_MAX_PAGES = 10
# Stop only after this many consecutive empty pages — tolerates the
# intermittent empty page Apple sometimes returns mid-feed.
_MAX_CONSECUTIVE_EMPTY = 3

# The plugin's `sort_by` values (manifest.json, offered in the UI) mapped to the
# RSS feed's `sortby=` path segment. Anything else falls back to the default,
# so a misconfigured value degrades to "most recent" rather than to an error feed.
#
# There is deliberately no "most critical" option. Checked against the live
# public feed (app 284882215, us, page 1, JSON): `sortby=mostrecent` and
# `sortby=mosthelpful` answer 200 with entries, while `sortby=mostcritical`
# answers HTTP 500 exactly like a made-up value (`sortby=bogusvalue`) — Apple
# does not support it. Configs saved with the old `most_critical` value fall
# back to the default below instead of failing every page.
_DEFAULT_SORT_BY = "most_recent"
_RSS_SORT_BY = {
    "most_recent": "mostrecent",
}


def rss_sort_segment(sort_by: str) -> str:
    """The `sortby=` value of the RSS path for a manifest `sort_by` option."""
    return _RSS_SORT_BY.get(sort_by, _RSS_SORT_BY[_DEFAULT_SORT_BY])


def create_session(delay: float = 0.5, jitter: float = 0.2, retries: int = 3) -> AppStoreSession:
    """Create a shared session with connection pooling and rate limiting."""
    return AppStoreSession(
        delay=delay,
        delay_jitter=jitter,
        retries=retries,
        retries_backoff_factor=2,
        retries_backoff_max=10,
    )


def _parse_entry(entry: dict) -> dict | None:
    """Parse one RSS feed entry into our review dict. Returns None on bad shape."""
    try:
        return {
            "id": str(entry["id"]["label"]),
            "date": fromisoformat_utc(entry["updated"]["label"]),
            "user_name": entry["author"]["name"]["label"],
            "rating": int(entry["im:rating"]["label"]),
            "title": entry["title"]["label"],
            "review": entry["content"]["label"],
            "developer_response": None,
        }
    except (KeyError, TypeError, ValueError):
        return None


def _page_entries(data: object) -> list | None:
    """The `feed.entry` list of one RSS page, or None for an empty/blank page.

    A page whose `entry` is present but not a list yields no reviews yet still
    counts as a non-empty page (it resets the consecutive-empty counter).
    """
    feed = data.get("feed") if isinstance(data, dict) else None
    entries = feed.get("entry") if isinstance(feed, dict) else None
    if not entries:
        return None
    return entries if isinstance(entries, list) else []


def _rss_path(country: str, app_id: str, page: int, sort_segment: str) -> str:
    return f"/{country}/rss/customerreviews/page={page}/id={app_id}/sortby={sort_segment}/json"


def _collect_pages(
    app_id: str,
    country: str,
    session: AppStoreSession,
    limit: int,
    sort_segment: str,
    reviews: list[dict],
) -> None:
    """Append parsed reviews to *reviews* page by page until *limit*, the last
    page, or `_MAX_CONSECUTIVE_EMPTY` blank/failed pages in a row."""
    consecutive_empty = 0
    for page in range(1, _MAX_PAGES + 1):
        if len(reviews) >= limit or consecutive_empty >= _MAX_CONSECUTIVE_EMPTY:
            return
        try:
            entries = _page_entries(session._get(_rss_path(country, app_id, page, sort_segment)))
        except AppStoreError as e:
            # Transient HTTP error on one page — skip it, keep paging.
            logger.warning(f"iOS RSS page {page} failed for app {app_id} in {country}: {e}")
            entries = None
        if entries is None:
            # Empty or failed page — could be the real end OR an intermittent
            # blank. Keep going until we've seen several in a row.
            consecutive_empty += 1
            continue
        consecutive_empty = 0
        for entry in entries:
            parsed = _parse_entry(entry)
            if parsed:
                reviews.append(parsed)
            if len(reviews) >= limit:
                return


def fetch_reviews_for_country(
    app_id: str,
    country: str,
    session: AppStoreSession,
    limit: int = 50,
    sort_by: str = _DEFAULT_SORT_BY,
) -> list[dict]:
    """
    Fetch reviews for a single app in a single country.

    Pages through the RSS feed directly, skipping intermittent empty pages
    (the library would stop at the first one). `sort_by` is the plugin's
    `sort_by` option and selects the feed's sort order (see `_RSS_SORT_BY`).
    Returns list of dicts with keys: id, date, user_name, rating, title, review,
    developer_response. A connection failure (after the session's retries) or
    an undecodable page ends the country early with what was collected so far.
    """
    reviews: list[dict] = []
    try:
        _collect_pages(app_id, country, session, limit, rss_sort_segment(sort_by), reviews)
    except (urllib3.exceptions.HTTPError, ValueError) as e:
        logger.warning(f"Failed to fetch iOS reviews for app {app_id} in {country}: {e}")
    return reviews
