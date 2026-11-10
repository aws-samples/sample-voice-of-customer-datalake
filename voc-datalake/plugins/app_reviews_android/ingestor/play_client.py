"""
Google Play Store review client using google-play-scraper.

Wraps the library with pagination, error handling, and structured output.
"""

import functools

from google_play_scraper import Sort, reviews

from _shared.app_reviews_health import StorefrontFetch, failure_cause
from _shared.base_ingestor import logger

SORT_MAP = {
    "newest": Sort.NEWEST,
    "rating": Sort.MOST_RELEVANT,
}

# Per-request page size. The library returns reviews in pages and hands back a
# continuation_token to fetch the next page. 200 is a safe page size; we loop
# until we hit `count` or the token runs out (i.e. all text reviews collected).
_PAGE_SIZE = 200
# Backstop so a runaway token loop can't spin forever (well above any real
# app's text-review count; a large app has a few thousand in one storefront).
_MAX_ROUNDS = 200


def fetch_reviews_for_country(
    package_name: str,
    country: str,
    count: int,
    sort_by: str,
    lang: str,
) -> StorefrontFetch:
    """
    Fetch up to `count` reviews for a single app in a single country.

    Paginates with the library's continuation_token until `count` is reached or
    Google Play returns no more reviews. A single reviews() call only returns one
    page (~200), so without this loop large apps were silently truncated.

    `reviews` holds dicts with keys: reviewId, at, userName, score, content,
    reviewCreatedVersion, replyContent, repliedAt, thumbsUpCount. `failure` is the
    short cause (exception type / HTTP status) when the locale raised before any
    review was collected; a partial result is kept and is not a failure.
    """
    fetch_page = functools.partial(reviews, package_name, lang=lang, country=country,
                                   sort=SORT_MAP.get(sort_by, Sort.NEWEST))
    collected: list[dict] = []
    # The library's own token type (inferred from `reviews`), or None before the first page.
    token = None

    try:
        for _ in range(_MAX_ROUNDS):
            remaining = count - len(collected)
            if remaining <= 0:
                # `continue` here would only idle out the remaining rounds; same result.
                break  # pragma: no mutate
            page_size = min(_PAGE_SIZE, remaining)
            # The first page is asked without a token: the library's parameter is typed as its token
            # class with a None default, so None is its first-page value but not a value of its type.
            result, token = (fetch_page(count=page_size) if token is None
                             else fetch_page(count=page_size, continuation_token=token))
            if not result:
                break
            collected.extend(result)
            # No further pages: the library hands back a token whose own `token` is None.
            if token.token is None:
                break
        return StorefrontFetch(reviews=collected[:count])
    except Exception as e:
        # Log text is not behaviour; the mutant that rewrites it is equivalent.
        logger.exception(
            f"Failed to fetch Android reviews for {package_name} in {country}: {e}"  # pragma: no mutate
        )
        # Return whatever we managed to collect before the error rather than
        # dropping a partial-but-useful result.
        return StorefrontFetch(
            reviews=collected[:count], failure=None if collected else failure_cause(e),
        )
