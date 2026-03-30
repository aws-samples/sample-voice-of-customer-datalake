"""
iOS App Reviews Ingestor - Collects reviews from the Apple App Store.

Uses app-store-web-scraper to fetch reviews across multiple countries,
deduplicates by review ID, and yields to the base ingestor pipeline.
"""

import json
import random
from datetime import datetime, timezone
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from _shared.app_reviews_utils import parse_int, process_app_reviews
from countries import IOS_COUNTRIES
from itunes_client import create_session, fetch_reviews_for_country
from models import IOSAppConfig


class IOSAppReviewsIngestor(BaseIngestor):
    """Ingestor for Apple App Store reviews."""

    def __init__(self):
        super().__init__()
        self.app_configs = self._load_app_configs()
        self.sort_by = self.secrets.get("sort_by", "most_recent")
        # iOS App Store returns different reviews per country storefront (500 cap each).
        # Unlike Android, countries provide unique coverage, so we use all available
        # countries from the curated list (40 high-traffic storefronts) to maximize
        # review collection. No need to expose this as a user config.
        self.max_countries = None  # None = use all countries in the list
        self.frequency_minutes = parse_int(
            self.secrets.get("frequency_minutes", "60"), 60, allow_zero=True
        )
        self.session = create_session()

    def _load_app_configs(self) -> list[IOSAppConfig]:
        """Load app configurations from JSON array or legacy flat keys."""
        # Try new multi-app format first
        configs_json = self.secrets.get("configs", "")
        if configs_json:
            try:
                configs_list = json.loads(configs_json) if isinstance(configs_json, str) else configs_json
                if isinstance(configs_list, list) and len(configs_list) > 0:
                    result = []
                    for cfg in configs_list:
                        try:
                            result.append(IOSAppConfig(
                                name=cfg.get("app_name", "").strip(),
                                app_id=str(cfg.get("app_id", "")).strip(),
                                enabled=cfg.get("enabled", True),
                                max_reviews_per_run=parse_int(str(cfg.get("max_reviews_per_run", "500")), 500),
                            ))
                        except (ValueError, TypeError) as e:
                            logger.warning(f"Skipping invalid iOS app config: {e}")
                    if result:
                        return result
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning(f"Failed to parse iOS configs array: {e}")

        # Fallback to legacy single-app flat keys
        app_name = self.secrets.get("app_name", "").strip()
        app_id = self.secrets.get("app_id", "").strip()
        max_reviews = parse_int(
            self.secrets.get("max_reviews_per_run", "500"), 500
        )

        if not app_name or not app_id:
            return []

        try:
            config = IOSAppConfig(
                name=app_name,
                app_id=app_id,
                enabled=True,
                max_reviews_per_run=max_reviews,
            )
            return [config]
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid iOS app config: {e}")
            return []

    def _collect_reviews_for_app(self, app: IOSAppConfig) -> list[dict]:
        """
        Collect reviews across countries for a single app.

        Shuffles countries for fair coverage, deduplicates by review ID,
        and caps at max_reviews_per_run.
        """
        countries = list(IOS_COUNTRIES)
        random.shuffle(countries)
        if self.max_countries and self.max_countries < len(countries):
            countries = countries[: self.max_countries]

        all_reviews: dict[str, dict] = {}

        for country in countries:
            reviews = fetch_reviews_for_country(
                app_id=app.app_id,
                country=country,
                session=self.session,
                limit=app.max_reviews_per_run,
                sort_by=self.sort_by,
            )
            for review in reviews:
                review_id = review["id"]
                composite_id = f"ios_{app.app_id}_{review_id}"
                if composite_id not in all_reviews:
                    all_reviews[composite_id] = {
                        **review,
                        "composite_id": composite_id,
                        "country": country,
                    }

        # Sort by date descending and cap
        sorted_reviews = sorted(
            all_reviews.values(),
            key=lambda r: r.get("date") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return sorted_reviews[: app.max_reviews_per_run]

    def _format_review(self, review: dict, app: IOSAppConfig) -> dict:
        """Format a raw review into the VoC pipeline schema."""
        date = review.get("date")
        if date and hasattr(date, "isoformat"):
            created_at = date.isoformat()
        elif isinstance(date, str):
            created_at = date
        else:
            created_at = datetime.now(timezone.utc).isoformat()

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
            "created_at": created_at,
            "url": f"https://apps.apple.com/app/id{app.app_id}",
            "author": review.get("user_name", "Anonymous"),
            "brand_handles_matched": [self.brand_name] if self.brand_name else [],
            "source_platform_override": f"{app.name}_iOS",
            "app_name": app.name,
            "app_identifier": app.app_id,
            "country": review.get("country", ""),
            "developer_response": dev_response if dev_response else None,
        }

    @tracer.capture_method
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from all configured iOS apps."""
        if not self.app_configs:
            logger.warning("No iOS app configurations found")
            return

        for app in self.app_configs:
            yield from process_app_reviews(
                app_config=app,
                app_name=app.name,
                platform_label="iOS",
                date_field="date",
                get_watermark_fn=self.get_watermark,
                set_watermark_fn=self.set_watermark,
                frequency_minutes=self.frequency_minutes,
                collect_fn=self._collect_reviews_for_app,
                format_fn=self._format_review,
                execution_id=self.execution_id,
            )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point. Optionally filters to a single app via event['app_id']."""
    # Clear secret cache on manual runs to pick up newly added app configs
    if isinstance(event, dict) and event.get("execution_id"):
        from shared.aws import clear_secret_cache
        clear_secret_cache()

    ingestor = IOSAppReviewsIngestor()
    if isinstance(event, dict):
        app_id = event.get("app_id")
        if app_id:
            ingestor.app_configs = [c for c in ingestor.app_configs if c.app_id == app_id]
        if event.get("execution_id"):
            ingestor.execution_id = event["execution_id"]
    return ingestor.run()
