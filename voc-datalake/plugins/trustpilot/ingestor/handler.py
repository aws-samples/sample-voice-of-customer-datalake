"""
Trustpilot Ingestor - Fetches reviews from Trustpilot Business API.
"""

from datetime import datetime, timezone, timedelta
from typing import Generator
import sys
import os

# Add plugin shared modules to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry


class TrustpilotIngestor(BaseIngestor):
    """Ingestor for Trustpilot Business API."""

    BASE_URL = "https://api.trustpilot.com/v1"

    def __init__(self):
        super().__init__()
        # Secrets are prefixed with plugin ID, but base class strips the prefix
        self.api_key = self.secrets.get("api_key", "")
        self.api_secret = self.secrets.get("api_secret", "")
        self.business_unit_id = self.secrets.get("business_unit_id", "")
        self.access_token = None

    def _get_access_token(self) -> str:
        """Get OAuth access token from Trustpilot."""
        if self.access_token:
            return self.access_token

        response = fetch_with_retry(
            url=f"{self.BASE_URL}/oauth/oauth-business-users-for-applications/accesstoken",
            method="POST",
            data={
                "grant_type": "client_credentials",
                "client_id": self.api_key,
                "client_secret": self.api_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        self.access_token = response.json()["access_token"]
        return self.access_token

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from Trustpilot since last watermark."""
        if not self.business_unit_id:
            logger.warning("No Trustpilot business_unit_id configured")
            return

        if not self.api_key or not self.api_secret:
            logger.warning("Trustpilot API credentials not configured")
            return

        token = self._get_access_token()
        headers = {"Authorization": f"Bearer {token}"}

        last_timestamp = self.get_watermark("last_timestamp")
        if last_timestamp:
            since = datetime.fromisoformat(last_timestamp.replace("Z", "+00:00"))
        else:
            since = datetime.now(timezone.utc) - timedelta(days=7)

        page = 1
        newest_timestamp = None

        while True:
            url = f"{self.BASE_URL}/business-units/{self.business_unit_id}/reviews"
            params = {"perPage": 100, "page": page, "orderBy": "createdat.desc"}

            response = fetch_with_retry(url, headers=headers, params=params)
            response.raise_for_status()
            data = response.json()

            reviews = data.get("reviews", [])
            if not reviews:
                break

            for review in reviews:
                created_at = datetime.fromisoformat(
                    review["createdAt"].replace("Z", "+00:00")
                )

                if created_at <= since:
                    if newest_timestamp:
                        self.set_watermark("last_timestamp", newest_timestamp)
                    return

                if not newest_timestamp:
                    newest_timestamp = review["createdAt"]

                yield {
                    "id": review["id"],
                    "channel": "review",
                    "url": review.get("links", [{}])[0].get("href", ""),
                    "text": review.get("text", ""),
                    "rating": review.get("stars"),
                    "created_at": review["createdAt"],
                    "author": review.get("consumer", {}).get("displayName", ""),
                    "title": review.get("title", ""),
                    "brand_handles_matched": [self.brand_name],
                }

            if len(reviews) < 100:
                break
            page += 1

        if newest_timestamp:
            self.set_watermark("last_timestamp", newest_timestamp)


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = TrustpilotIngestor()
    return ingestor.run()
