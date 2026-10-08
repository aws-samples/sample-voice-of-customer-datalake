"""
Google Play Store review client using google-play-scraper.

Wraps the library with pagination, error handling, and structured output.
"""

from typing import TYPE_CHECKING, cast

from google_play_scraper import Sort, reviews

from _shared.base_ingestor import logger

if TYPE_CHECKING:
    from google_play_scraper.features.reviews import _ContinuationToken

SORT_MAP = {
    "newest": Sort.NEWEST,
    "rating": Sort.MOST_RELEVANT,
}

# Per-request page size. The library returns reviews in pages and hands back a
# continuation_token to fetch the next page. 200 is a safe page size; we loop
# until we hit `count` or the token runs out (i.e. all text reviews collected).
_PAGE_SIZE = 200
# Backstop so a runaway token loop can't spin forever (well above any real
# app's text-review count; e.g. Gangnamunni has ~2,376 in ko/kr).
_MAX_ROUNDS = 200


def _fetch_page(
    package_name: str,
    *,
    lang: str,
    country: str,
    sort_order: Sort,
    count: int,
    token: "_ContinuationToken | None",
) -> "tuple[list[dict], _ContinuationToken | None]":
    """One `reviews()` page; *token* None requests the first page."""
    return reviews(
        package_name,
        lang=lang,
        country=country,
        sort=sort_order,
        count=count,
        # The library declares `continuation_token: _ContinuationToken = None`
        # (an implicit Optional) — None is its documented first-page value.
        # A string first argument to cast() is never evaluated, so mutating it is equivalent.
        continuation_token=cast("_ContinuationToken", token),  # pragma: no mutate
    )


def fetch_reviews_for_country(
    package_name: str,
    country: str,
    count: int,
    sort_by: str,
    lang: str,
) -> list[dict]:
    """
    Fetch up to `count` reviews for a single app in a single country.

    Paginates with the library's continuation_token until `count` is reached or
    Google Play returns no more reviews. A single reviews() call only returns one
    page (~200), so without this loop large apps were silently truncated.

    Returns list of dicts with keys: reviewId, at, userName, score, content,
    reviewCreatedVersion, replyContent, repliedAt, thumbsUpCount.
    """
    sort_order = SORT_MAP.get(sort_by, Sort.NEWEST)
    collected: list[dict] = []
    # A local annotation is never evaluated at runtime, so its mutant is equivalent.
    token: _ContinuationToken | None = None  # pragma: no mutate

    try:
        for _ in range(_MAX_ROUNDS):
            remaining = count - len(collected)
            if remaining <= 0:
                # `continue` here would only idle out the remaining rounds; same result.
                break  # pragma: no mutate
            result, token = _fetch_page(
                package_name,
                lang=lang,
                country=country,
                sort_order=sort_order,
                count=min(_PAGE_SIZE, remaining),
                token=token,
            )
            if not result:
                break
            collected.extend(result)
            # No further pages — all available reviews collected.
            if token is None:
                break
        return collected[:count]
    except Exception as e:
        # Log text is not behaviour; the mutant that rewrites it is equivalent.
        logger.exception(
            f"Failed to fetch Android reviews for {package_name} in {country}: {e}"  # pragma: no mutate
        )
        # Return whatever we managed to collect before the error rather than
        # dropping a partial-but-useful result.
        return collected[:count]
