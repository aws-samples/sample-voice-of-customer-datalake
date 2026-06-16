"""
Google Play Store review client using google-play-scraper.

Wraps the library with pagination, error handling, and structured output.
"""

from google_play_scraper import Sort, reviews
from _shared.base_ingestor import logger


SORT_MAP = {
    "newest": Sort.NEWEST,
    "rating": Sort.MOST_RELEVANT,
}


def fetch_reviews_for_country(
    package_name: str,
    country: str,
    count: int = 100,
    sort_by: str = "newest",
) -> list[dict]:
    """
    Fetch reviews for a single app in a single country.

    Returns list of dicts with keys: reviewId, at, userName, score, content,
    reviewCreatedVersion, replyContent, repliedAt, thumbsUpCount.
    """
    sort_order = SORT_MAP.get(sort_by, Sort.NEWEST)

    try:
        result, _ = reviews(
            package_name,
            lang="en",
            country=country,
            sort=sort_order,
            count=count,
        )
        return result or []
    except Exception as e:
        logger.warning(
            f"Failed to fetch Android reviews for {package_name} in {country}: {e}"
        )
        return []
