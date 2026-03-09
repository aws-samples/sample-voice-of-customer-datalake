"""
Android App Reviews Ingestor - Collects reviews from the Google Play Store.

Uses google-play-scraper to fetch reviews across multiple countries,
deduplicates by review ID, and yields to the base ingestor pipeline.
"""

import random
from datetime import datetime, timezone
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from countries import ANDROID_COUNTRIES
from play_client import fetch_reviews_for_country
from models import AndroidAppConfig


class AndroidAppReviewsIngestor(BaseIngestor):
    """Ingestor for Google Play Store reviews."""

    def __init__(self):
        super().__init__()
        self.app_configs = self._load_app_configs()
        self.sort_by = self.secrets.get("sort_by", "newest")
        self.max_countries = self._parse_int(
            self.secrets.get("max_countries_per_run", "20"), 20
        )
        self.frequency_minutes = self._parse_int(
            self.secrets.get("frequency_minutes", "60"), 60
        )

    def _parse_int(self, value: str, default: int) -> int:
        """Safely parse an integer from string."""
        try:
            parsed = int(value)
            return parsed if parsed > 0 else default
        except (ValueError, TypeError):
            return default

    def _load_app_configs(self) -> list[AndroidAppConfig]:
        """Load app configuration from individual secret fields."""
        app_name = self.secrets.get("app_name", "").strip()
        package_name = self.secrets.get("package_name", "").strip()
        max_reviews = self._parse_int(
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
            # Check frequency-based throttling
            last_run = self.get_watermark(f"{app.name}_last_run")
            if last_run:
                try:
                    from datetime import timedelta
                    last_run_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
                    next_run = last_run_dt + timedelta(minutes=self.frequency_minutes)
                    if datetime.now(timezone.utc) < next_run:
                        logger.info(f"Skipping Android {app.name} - not due yet (frequency: {self.frequency_minutes}m)")
                        continue
                except (ValueError, TypeError):
                    pass

            logger.info(
                f"Collecting Android reviews for {app.name} "
                f"(package={app.package_name})"
            )

            # Load watermark
            watermark_key = f"{app.name}_last_published_at"
            last_published = self.get_watermark(watermark_key)
            watermark_dt = None
            if last_published:
                try:
                    watermark_dt = datetime.fromisoformat(
                        last_published.replace("Z", "+00:00")
                    )
                except (ValueError, TypeError):
                    watermark_dt = None

            try:
                reviews = self._collect_reviews_for_app(app)
            except Exception as e:
                logger.error(f"Failed to collect reviews for {app.name}: {e}")
                metrics.add_metric(
                    name=f"Android_{app.name}_Errors", unit="Count", value=1
                )
                continue

            newest_date = watermark_dt
            yielded = 0

            for review in reviews:
                review_date = review.get("at")
                if review_date and hasattr(review_date, "isoformat"):
                    review_dt = review_date
                else:
                    review_dt = None

                # Skip reviews older than watermark
                if watermark_dt and review_dt and review_dt <= watermark_dt:
                    continue

                formatted = self._format_review(review, app)
                yield formatted
                yielded += 1

                # Track newest date for watermark update
                if review_dt and (newest_date is None or review_dt > newest_date):
                    newest_date = review_dt

            # Update watermark
            if newest_date and newest_date != watermark_dt:
                self.set_watermark(watermark_key, newest_date.isoformat())

            self.set_watermark(
                f"{app.name}_last_run", datetime.now(timezone.utc).isoformat()
            )

            metrics.add_metric(
                name=f"Android_{app.name}_Reviews", unit="Count", value=yielded
            )
            logger.info(
                f"Android {app.name}: yielded {yielded} new reviews "
                f"(from {len(reviews)} candidates)"
            )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = AndroidAppReviewsIngestor()
    return ingestor.run()
