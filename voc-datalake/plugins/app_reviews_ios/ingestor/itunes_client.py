"""
Apple App Store review client using app-store-web-scraper.

Wraps the library with connection pooling, rate limiting, and error handling.
"""

from app_store_web_scraper import AppStoreEntry, AppStoreSession
from _shared.base_ingestor import logger


def create_session(delay: float = 0.5, jitter: float = 0.2, retries: int = 3) -> AppStoreSession:
    """Create a shared session with connection pooling and rate limiting."""
    return AppStoreSession(
        delay=delay,
        delay_jitter=jitter,
        retries=retries,
        retries_backoff_factor=2,
        retries_backoff_max=10,
    )


def fetch_reviews_for_country(
    app_id: str,
    country: str,
    session: AppStoreSession,
    limit: int = 50,
    sort_by: str = "most_recent",
) -> list[dict]:
    """
    Fetch reviews for a single app in a single country.

    Returns list of dicts with keys: id, date, user_name, rating, title, review,
    developer_response.
    """
    try:
        sort_map = {
            "most_recent": "mostrecent",
            "most_critical": "mosthelpful",
        }
        app = AppStoreEntry(
            app_id=int(app_id),
            country=country,
            session=session,
        )
        reviews = []
        for review in app.reviews(limit=limit):
            reviews.append({
                "id": str(review.id),
                "date": review.date,
                "user_name": review.user_name,
                "rating": review.rating,
                "title": review.title,
                "review": review.review,
                "developer_response": getattr(review, "developer_response", None),
            })
        return reviews
    except Exception as e:
        logger.warning(f"Failed to fetch iOS reviews for app {app_id} in {country}: {e}")
        return []
