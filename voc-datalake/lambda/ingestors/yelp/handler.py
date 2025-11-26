"""
Yelp Fusion API Ingestor - Fetches business reviews via official Yelp API.
Uses the Yelp Fusion API which requires an API key from https://www.yelp.com/developers
"""
import os
import requests
from datetime import datetime, timezone
from typing import Generator
import sys

# Add parent directory to path for base_ingestor import
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class YelpIngestor(BaseIngestor):
    """Yelp Fusion API ingestor for business reviews."""

    YELP_API_BASE = "https://api.yelp.com/v3"

    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get('yelp_api_key', '')
        self.business_ids = self._parse_business_ids()
        self.headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Accept': 'application/json',
        }

    def _parse_business_ids(self) -> list[str]:
        """Parse business IDs from secrets."""
        ids_str = self.secrets.get('yelp_business_ids', '')
        if not ids_str:
            return []
        return [bid.strip() for bid in ids_str.split(',') if bid.strip()]

    def _get_business_reviews(self, business_id: str) -> list[dict]:
        """Fetch reviews for a specific business."""
        url = f"{self.YELP_API_BASE}/businesses/{business_id}/reviews"
        
        try:
            response = requests.get(url, headers=self.headers, timeout=30)
            response.raise_for_status()
            data = response.json()
            return data.get('reviews', [])
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 401:
                logger.error("Yelp API authentication failed - check API key")
            elif e.response.status_code == 404:
                logger.warning(f"Business not found: {business_id}")
            else:
                logger.error(f"Yelp API error for {business_id}: {e}")
            return []
        except requests.RequestException as e:
            logger.error(f"Request failed for {business_id}: {e}")
            return []

    def _get_business_info(self, business_id: str) -> dict | None:
        """Fetch business details for context."""
        url = f"{self.YELP_API_BASE}/businesses/{business_id}"
        
        try:
            response = requests.get(url, headers=self.headers, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            logger.warning(f"Could not fetch business info for {business_id}: {e}")
            return None

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from all configured Yelp businesses."""
        if not self.api_key:
            logger.error("Yelp API key not configured")
            return

        if not self.business_ids:
            logger.warning("No Yelp business IDs configured")
            return

        for business_id in self.business_ids:
            logger.info(f"Fetching reviews for Yelp business: {business_id}")
            
            # Get business info for context
            business_info = self._get_business_info(business_id)
            business_name = business_info.get('name', business_id) if business_info else business_id
            business_url = business_info.get('url', f'https://www.yelp.com/biz/{business_id}') if business_info else f'https://www.yelp.com/biz/{business_id}'
            
            # Get watermark for this business
            watermark_key = f'yelp_{business_id}_last_review'
            last_review_id = self.get_watermark(watermark_key)
            
            reviews = self._get_business_reviews(business_id)
            new_review_id = None
            items_found = 0
            
            for review in reviews:
                review_id = review.get('id', '')
                
                # Skip if we've already processed this review
                if last_review_id and review_id == last_review_id:
                    break
                
                if not new_review_id:
                    new_review_id = review_id
                
                # Extract review data
                user = review.get('user', {})
                
                yield {
                    'id': f"yelp_{business_id}_{review_id}",
                    'channel': 'yelp_api',
                    'url': review.get('url', business_url),
                    'text': review.get('text', ''),
                    'rating': review.get('rating'),
                    'created_at': review.get('time_created', datetime.now(timezone.utc).isoformat()),
                    'brand_handles_matched': [self.brand_name],
                    'author': user.get('name', 'Anonymous'),
                    'author_image': user.get('image_url', ''),
                    'business_id': business_id,
                    'business_name': business_name,
                }
                items_found += 1
            
            # Update watermark with newest review ID
            if new_review_id:
                self.set_watermark(watermark_key, new_review_id)
            
            metrics.add_metric(name=f"Yelp_{business_id}_Reviews", unit="Count", value=items_found)
            logger.info(f"Found {items_found} new reviews for {business_name}")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = YelpIngestor()
    return ingestor.run()
