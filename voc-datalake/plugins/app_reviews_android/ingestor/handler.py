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

    def __init__(self, execution_id: str | None = None):
        # execution_id flows to BaseIngestor, which clears the shared secret
        # cache on manual runs BEFORE app configs are read (issues #141/#215).
        super().__init__(execution_id=execution_id)
        self.app_configs = self._load_app_configs()
        self.sort_by = self.secrets.get("sort_by", "newest")
        # Android Play Store returns the same global reviews regardless of country.
        # Multiple countries just fetch duplicates, so we hardcode to 1 to avoid
        # wasted API calls. The library paginates internally to get all available
        # reviews (typically ~1000-2000 per app).
        self.max_countries = 1
        self.frequency_minutes = parse_int(
            self.secrets.get("frequency_minutes", "60"), 60, allow_zero=True
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
                                lang=str(cfg.get("lang", "") or "").strip(),
                                country=str(cfg.get("country", "") or "").strip(),
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
            if self.max_countries and self.max_countries < len(countries):
                countries = countries[: self.max_countries]
            locales = [("en", c) for c in countries]

        all_reviews: dict[str, dict] = {}

        for lang, country in locales:
            reviews = fetch_reviews_for_country(
                package_name=app.package_name,
                country=country,
                count=app.max_reviews_per_run,
                sort_by=self.sort_by,
                lang=lang,
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
            "source_platform_override": f"{app.name}_Android",
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
            if not app.enabled:
                logger.info(f"Skipping disabled Android app: {app.name} ({app.package_name})")
                continue
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
                execution_id=self.execution_id,
            )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point. Optionally filters to a single app via event['app_id']."""
    # Manual-run secret-cache clearing (issue #141) is centralized in
    # BaseIngestor.__init__ — passing execution_id below triggers it.
    execution_id = event.get("execution_id") if isinstance(event, dict) else None
    ingestor = AndroidAppReviewsIngestor(execution_id=execution_id)
    if isinstance(event, dict):
        app_id = event.get("app_id")
        if app_id:
            ingestor.app_configs = [c for c in ingestor.app_configs if c.package_name == app_id]
    return ingestor.run()
