"""
Android App Reviews Ingestor - Collects reviews from the Google Play Store.

Uses google-play-scraper to fetch reviews across multiple countries,
deduplicates by review ID, and yields to the base ingestor pipeline.
"""

import json
import random
from datetime import datetime, timezone
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from _shared.app_reviews_utils import parse_int, process_app_reviews
from countries import ANDROID_COUNTRIES
from play_client import fetch_reviews_for_country
from models import AndroidAppConfig


class AndroidAppReviewsIngestor(BaseIngestor):
    """Ingestor for Google Play Store reviews."""

    def __init__(self):
        super().__init__()
        self.app_configs = self._load_app_configs()
        self.sort_by = self.secrets.get("sort_by", "newest")
        self.max_countries = parse_int(
            self.secrets.get("max_countries_per_run", "20"), 20
        )
        self.frequency_minutes = parse_int(
            self.secrets.get("frequency_minutes", "60"), 60
        )

    def _load_app_configs(self) -> list[AndroidAppConfig]:
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
                            result.append(AndroidAppConfig(
                                name=cfg.get("app_name", "").strip(),
                                package_name=cfg.get("package_name", "").strip(),
                                enabled=cfg.get("enabled", True),
                                max_reviews_per_run=parse_int(str(cfg.get("max_reviews_per_run", "500")), 500),
                            ))
                        except (ValueError, TypeError) as e:
                            logger.warning(f"Skipping invalid Android app config: {e}")
                    if result:
                        return result
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning(f"Failed to parse Android configs array: {e}")

        # Fallback to legacy single-app flat keys
        app_name = self.secrets.get("app_name", "").strip()
        package_name = self.secrets.get("package_name", "").strip()
        max_reviews = parse_int(
            self.secrets.get("max_reviews_per_run", "500"), 500
        )

        if not app_name or not package_name:
            return []

        try:
            config = AndroidAppConfig(
                name=app_name,
                package_name=package_name,
                enabled=True,
                max_reviews_per_run=max_reviews,
            )
            return [config]
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid Android app config: {e}")
            return []

    def _collect_reviews_for_app(self, app: AndroidAppConfig) -> list[dict]:
        """
        Collect reviews across countries for a single app.

        Shuffles countries for fair coverage, deduplicates by review ID,
        and caps at max_reviews_per_run.
        """
        countries = list(ANDROID_COUNTRIES)
        random.shuffle(countries)
        if self.max_countries and self.max_countries < len(countries):
            countries = countries[: self.max_countries]

        all_reviews: dict[str, dict] = {}

        for country in countries:
            reviews = fetch_reviews_for_country(
                package_name=app.package_name,
                country=country,
                count=100,
                sort_by=self.sort_by,
            )
            for review in reviews:
                review_id = review.get("reviewId", "")
                if not review_id:
                    continue
                composite_id = f"android_{app.package_name}_{review_id}"
                if composite_id not in all_reviews:
                    all_reviews[composite_id] = {
                        **review,
                        "composite_id": composite_id,
                        "country": country,
                    }

        # Sort by date descending and cap
        sorted_reviews = sorted(
            all_reviews.values(),
            key=lambda r: r.get("at") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return sorted_reviews[: app.max_reviews_per_run]

    def _format_review(self, review: dict, app: AndroidAppConfig) -> dict:
        """Format a raw review into the VoC pipeline schema."""
        date = review.get("at")
        if date and hasattr(date, "isoformat"):
            created_at = date.isoformat()
        elif isinstance(date, str):
            created_at = date
        else:
            created_at = datetime.now(timezone.utc).isoformat()

        text = review.get("content", "")
        dev_response = review.get("replyContent")
        dev_response_date = review.get("repliedAt")

        return {
            "id": review["composite_id"],
            "channel": "app_review_android",
            "text": text,
            "title": "",
            "rating": review.get("score"),
            "created_at": created_at,
            "url": f"https://play.google.com/store/apps/details?id={app.package_name}",
            "author": review.get("userName", "Anonymous"),
            "brand_handles_matched": [self.brand_name] if self.brand_name else [],
            "source_platform_override": f"{app.name}_android",
            "app_name": app.name,
            "app_identifier": app.package_name,
            "country": review.get("country", ""),
            "app_version": review.get("reviewCreatedVersion"),
            "developer_response": dev_response if dev_response else None,
            "developer_response_date": (
                dev_response_date.isoformat()
                if dev_response_date and hasattr(dev_response_date, "isoformat")
                else None
            ),
            "thumbs_up_count": review.get("thumbsUpCount", 0),
        }

    @tracer.capture_method
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from all configured Android apps."""
        if not self.app_configs:
            logger.warning("No Android app configurations found")
            return

        for app in self.app_configs:
            yield from process_app_reviews(
                app_config=app,
                app_name=app.name,
                platform_label="Android",
                date_field="at",
                get_watermark_fn=self.get_watermark,
                set_watermark_fn=self.set_watermark,
                frequency_minutes=self.frequency_minutes,
                collect_fn=self._collect_reviews_for_app,
                format_fn=self._format_review,
            )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point. Optionally filters to a single app via event['app_id']."""
    ingestor = AndroidAppReviewsIngestor()
    app_id = event.get("app_id") if isinstance(event, dict) else None
    if app_id:
        ingestor.app_configs = [c for c in ingestor.app_configs if c.package_name == app_id]
    return ingestor.run()
