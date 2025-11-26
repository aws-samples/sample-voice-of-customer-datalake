"""
Apple App Store Ingestor - Fetches app reviews from Apple App Store RSS feed.
Uses the public RSS feed which doesn't require authentication.
"""
import requests
from datetime import datetime, timezone, timedelta
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class AppStoreAppleIngestor(BaseIngestor):
    """Ingestor for Apple App Store reviews via RSS feed."""

    def __init__(self):
        super().__init__()
        self.app_id = self.secrets.get('apple_app_id', '')
        self.country_codes = self.secrets.get('apple_country_codes', 'us').split(',')

    def _parse_rating(self, entry: dict) -> int:
        """Extract rating from RSS entry."""
        rating = entry.get('im:rating', {})
        if isinstance(rating, dict):
            return int(rating.get('label', 0))
        return int(rating) if rating else 0

    def _fetch_reviews_for_country(self, country: str) -> Generator[dict, None, None]:
        """Fetch reviews for a specific country."""
        url = f"https://itunes.apple.com/{country}/rss/customerreviews/id={self.app_id}/sortBy=mostRecent/json"
        
        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            data = response.json()

            entries = data.get('feed', {}).get('entry', [])
            if not entries:
                return

            # First entry is app info, skip it
            reviews = entries[1:] if len(entries) > 1 else []

            for entry in reviews:
                review_id = entry.get('id', {}).get('label', '')
                author = entry.get('author', {}).get('name', {}).get('label', 'Anonymous')
                title = entry.get('title', {}).get('label', '')
                content = entry.get('content', {}).get('label', '')
                rating = self._parse_rating(entry)
                updated = entry.get('updated', {}).get('label', '')
                version = entry.get('im:version', {}).get('label', '')

                yield {
                    'id': f"apple_{country}_{review_id}",
                    'channel': 'app_review',
                    'url': f"https://apps.apple.com/{country}/app/id{self.app_id}",
                    'text': f"{title}\n\n{content}" if title else content,
                    'rating': rating,
                    'created_at': updated,
                    'brand_handles_matched': [self.brand_name],
                    'author': author,
                    'app_version': version,
                    'country': country,
                    'store': 'apple',
                }

        except requests.RequestException as e:
            logger.warning(f"Failed to fetch Apple reviews for {country}: {e}")
        except Exception as e:
            logger.error(f"Error parsing Apple reviews for {country}: {e}")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from Apple App Store."""
        if not self.app_id:
            logger.warning("No Apple App ID configured")
            return

        last_timestamp = self.get_watermark('last_timestamp')
        if last_timestamp:
            since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
        else:
            since = datetime.now(timezone.utc) - timedelta(days=7)

        newest_timestamp = None

        for country in self.country_codes:
            country = country.strip().lower()
            for item in self._fetch_reviews_for_country(country):
                try:
                    item_time = datetime.fromisoformat(item['created_at'].replace('Z', '+00:00'))
                    if item_time <= since:
                        continue
                    if not newest_timestamp or item_time > newest_timestamp:
                        newest_timestamp = item_time
                    yield item
                except (ValueError, KeyError):
                    yield item

        if newest_timestamp:
            self.set_watermark('last_timestamp', newest_timestamp.isoformat())


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = AppStoreAppleIngestor()
    return ingestor.run()
