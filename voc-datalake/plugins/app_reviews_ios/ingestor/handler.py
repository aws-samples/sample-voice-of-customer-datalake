"""
iOS App Reviews Ingestor - Collects reviews from the Apple App Store.

Uses app-store-web-scraper to fetch reviews across multiple countries,
deduplicates by review ID, and yields to the base ingestor pipeline.
"""

import random

from countries import IOS_COUNTRIES
from itunes_client import create_session, fetch_reviews_for_country
from models import IOSAppConfig

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


class IOSAppReviewsIngestor(AppReviewsIngestor[IOSAppConfig]):
    """Ingestor for Apple App Store reviews."""

    PLATFORM_LABEL = "iOS"
    DATE_FIELD = "date"
    DEFAULT_SORT_BY = "most_recent"

    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)
        self.session = create_session()

    def app_identifier(self, app: IOSAppConfig) -> str:
        return app.app_id

    def _load_app_configs(self) -> list[IOSAppConfig]:
        """Load app configurations from JSON array or legacy flat keys."""
        return load_app_configs(
            self.secrets,
            platform_label="iOS",
            legacy_id_key="app_id",
            from_entry=lambda cfg: IOSAppConfig(
                name=cfg.get("app_name", "").strip(),
                app_id=str(cfg.get("app_id", "")).strip(),
                enabled=cfg.get("enabled", True),
                max_reviews_per_run=parse_int(str(cfg.get("max_reviews_per_run", 500)), 500),
            ),
            from_legacy=lambda app_name, app_id, max_reviews: IOSAppConfig(
                name=app_name,
                app_id=app_id,
                enabled=True,
                max_reviews_per_run=max_reviews,
            ),
        )

    def _collect_reviews_for_app(self, app: IOSAppConfig) -> list[dict]:
        """
        Collect reviews across countries for a single app.

        Shuffles countries for fair coverage, deduplicates by review ID,
        and caps at max_reviews_per_run.

        Every storefront in the curated list is fetched: unlike Android, each
        iOS storefront serves its own reviews (500 cap each), so countries add
        unique coverage rather than duplicates.
        """
        countries = list(IOS_COUNTRIES)
        random.shuffle(countries)

        all_reviews: dict[str, dict] = {}

        for country in countries:
            reviews = fetch_reviews_for_country(
                app_id=app.app_id,
                country=country,
                session=self.session,
                limit=app.max_reviews_per_run,
                sort_by=self.sort_by,
            )
            merge_reviews_by_composite_id(
                all_reviews,
                reviews,
                country=country,
                composite_id_for=lambda review: f"ios_{app.app_id}_{review['id']}",
            )

        return newest_first(
            all_reviews.values(), date_field="date", cap=app.max_reviews_per_run
        )

    def _format_review(self, review: dict, app: IOSAppConfig) -> dict:
        """Format a raw review into the VoC pipeline schema."""
        title = review.get("title", "")
        body = review.get("review", "")
        text = f"{title}\n\n{body}" if title else body

        dev_response = review.get("developer_response")

        return {
            "id": review["composite_id"],
            "channel": "app_review_ios",
            "text": text,
            "title": title,
            "rating": review.get("rating"),
            "created_at": review_created_at(review.get("date")),
            "url": f"https://apps.apple.com/app/id{app.app_id}",
            "author": review.get("user_name", "Anonymous"),
            "brand_handles_matched": [self.brand_name] if self.brand_name else [],
            "source_platform_override": f"{app.name}_iOS",
            "app_name": app.name,
            "app_identifier": app.app_id,
            "country": review.get("country", ""),
            "developer_response": dev_response or None,
        }


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Lambda entry point. Optionally filters to a single app via event['app_id']."""
    return IOSAppReviewsIngestor.run_for_event(event)
