"""
Android App Reviews Ingestor - Collects reviews from the Google Play Store.

Uses google-play-scraper to fetch reviews across multiple countries,
deduplicates by review ID, and yields to the base ingestor pipeline.
"""

import random

from countries import ANDROID_COUNTRIES
from models import AndroidAppConfig
from play_client import fetch_reviews_for_country

from _shared.app_reviews_utils import (
    AppReviewsIngestor,
    load_app_configs,
    merge_reviews_by_composite_id,
    newest_first,
    parse_int,
    review_created_at,
)
from _shared.base_ingestor import logger, metrics, tracer
from shared.invocation_cost import measure_invocation_cost


class AndroidAppReviewsIngestor(AppReviewsIngestor[AndroidAppConfig]):
    """Ingestor for Google Play Store reviews."""

    PLATFORM_LABEL = "Android"
    DATE_FIELD = "at"
    DEFAULT_SORT_BY = "newest"

    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)
        # Android Play Store returns the same global reviews regardless of country.
        # Multiple countries just fetch duplicates, so we hardcode to 1 to avoid
        # wasted API calls. The library paginates internally to get all available
        # reviews (typically ~1000-2000 per app).
        self.max_countries = 1

    def app_identifier(self, app: AndroidAppConfig) -> str:
        return app.package_name

    def _load_app_configs(self) -> list[AndroidAppConfig]:
        """Load app configurations from JSON array or legacy flat keys."""
        return load_app_configs(
            self.secrets,
            platform_label="Android",
            legacy_id_key="package_name",
            from_entry=lambda cfg: AndroidAppConfig(
                name=cfg.get("app_name", "").strip(),
                package_name=cfg.get("package_name", "").strip(),
                enabled=cfg.get("enabled", True),
                # An absent cap stringifies to "None", which parse_int rejects → 500.
                max_reviews_per_run=parse_int(str(cfg.get("max_reviews_per_run")), 500),
                lang=str(cfg.get("lang", "") or "").strip(),
                country=str(cfg.get("country", "") or "").strip(),
            ),
            from_legacy=lambda app_name, package_name, max_reviews: AndroidAppConfig(
                name=app_name,
                package_name=package_name,
                enabled=True,
                max_reviews_per_run=max_reviews,
            ),
        )

    def _collect_reviews_for_app(self, app: AndroidAppConfig) -> list[dict]:
        """
        Collect reviews for a single app, deduplicating by review ID and
        capping at max_reviews_per_run.

        Google Play filters reviews BY LANGUAGE (lang="en" returns only
        English-written reviews). When the app config sets lang/country
        (e.g. ko/kr for a Korean app), we target that locale directly to get
        the full review set. Otherwise we fall back to the country sweep with
        the default lang.
        """
        if app.lang or app.country:
            # Targeted single-locale fetch — paginates fully via play_client.
            locales = [(app.lang or "en", app.country or "us")]
        else:
            countries = list(ANDROID_COUNTRIES)
            random.shuffle(countries)
            locales = [("en", c) for c in countries[: self.max_countries]]

        all_reviews: dict[str, dict] = {}

        def composite_id_for(review: dict) -> str | None:
            review_id = review.get("reviewId", "")
            if not review_id:
                return None
            return f"android_{app.package_name}_{review_id}"

        for lang, country in locales:
            reviews = fetch_reviews_for_country(
                package_name=app.package_name,
                country=country,
                count=app.max_reviews_per_run,
                sort_by=self.sort_by,
                lang=lang,
            )
            merge_reviews_by_composite_id(
                all_reviews, reviews, country=country, composite_id_for=composite_id_for
            )

        return newest_first(
            all_reviews.values(), date_field="at", cap=app.max_reviews_per_run
        )

    def _format_review(self, review: dict, app: AndroidAppConfig) -> dict:
        """Format a raw review into the VoC pipeline schema."""
        text = review.get("content", "")
        dev_response = review.get("replyContent")
        dev_response_date = review.get("repliedAt")

        return {
            "id": review["composite_id"],
            "channel": "app_review_android",
            "text": text,
            "title": "",
            "rating": review.get("score"),
            "created_at": review_created_at(review.get("at")),
            "url": f"https://play.google.com/store/apps/details?id={app.package_name}",
            "author": review.get("userName", "Anonymous"),
            "brand_handles_matched": [self.brand_name] if self.brand_name else [],
            "source_platform_override": f"{app.name}_Android",
            "app_name": app.name,
            "app_identifier": app.package_name,
            "country": review.get("country", ""),
            "app_version": review.get("reviewCreatedVersion"),
            "developer_response": dev_response or None,
            "developer_response_date": (
                dev_response_date.isoformat()
                if dev_response_date and hasattr(dev_response_date, "isoformat")
                else None
            ),
            "thumbs_up_count": review.get("thumbsUpCount", 0),
        }


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Lambda entry point. Optionally filters to a single app via event['app_id']."""
    return AndroidAppReviewsIngestor.run_for_event(event)
