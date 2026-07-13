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

from app_store_web_scraper import AppStoreEntry, AppStoreSession
from app_store_web_scraper._errors import AppStoreError
from app_store_web_scraper._utils import fromisoformat_utc
from _shared.base_ingestor import logger

# Apple's RSS customer-reviews feed exposes at most 10 pages (~50 each).
_MAX_PAGES = 10
# Stop only after this many consecutive empty pages — tolerates the
# intermittent empty page Apple sometimes returns mid-feed.
_MAX_CONSECUTIVE_EMPTY = 3


def create_session(delay: float = 0.5, jitter: float = 0.2, retries: int = 3) -> AppStoreSession:
    """Create a shared session with connection pooling and rate limiting."""
    return AppStoreSession(
        delay=delay,
        delay_jitter=jitter,
        retries=retries,
        retries_backoff_factor=2,
        retries_backoff_max=10,
    )


def _parse_entry(entry: dict) -> dict:
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


def fetch_reviews_for_country(
    app_id: str,
    country: str,
    session: AppStoreSession,
    limit: int = 50,
    sort_by: str = "most_recent",
) -> list[dict]:
    """
    Fetch reviews for a single app in a single country.

    Pages through the RSS feed directly, skipping intermittent empty pages
    (the library would stop at the first one). Returns list of dicts with keys:
    id, date, user_name, rating, title, review, developer_response.
    """
    reviews: list[dict] = []
    consecutive_empty = 0

    try:
        for page in range(1, _MAX_PAGES + 1):
            if len(reviews) >= limit:
                break
            path = (
                f"/{country}/rss/customerreviews/page={page}"
                f"/id={app_id}/sortby=mostrecent/json"
            )
            try:
                data = session._get(path)
            except AppStoreError as e:
                # Transient HTTP error on one page — skip it, keep paging.
                logger.warning(
                    f"iOS RSS page {page} failed for app {app_id} in {country}: {e}"
                )
                consecutive_empty += 1
                if consecutive_empty >= _MAX_CONSECUTIVE_EMPTY:
                    break
                continue

            feed = data.get("feed", {})
            entries = feed.get("entry")
            if not entries:
                # Empty page — could be the real end OR an intermittent blank.
                # Keep going until we've seen several empties in a row.
                consecutive_empty += 1
                if consecutive_empty >= _MAX_CONSECUTIVE_EMPTY:
                    break
                continue

            consecutive_empty = 0
            for entry in entries:
                parsed = _parse_entry(entry)
                if parsed:
                    reviews.append(parsed)
                if len(reviews) >= limit:
                    break

        return reviews
    except Exception as e:
        logger.warning(f"Failed to fetch iOS reviews for app {app_id} in {country}: {e}")
        return reviews
