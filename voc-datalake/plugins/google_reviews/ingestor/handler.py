"""
Google Reviews Ingestor - Fetches reviews from Google Business Profile API.
"""
from datetime import datetime, timezone, timedelta
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class GoogleReviewsIngestor(BaseIngestor):
    """Ingestor for Google Business Profile API."""
    
    BASE_URL = "https://mybusiness.googleapis.com/v4"
    
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get('google_api_key', '')
        self.location_ids = self.secrets.get('google_location_ids', '').split(',')
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key or not self.location_ids:
            logger.warning("Google API key or location IDs not configured")
            return
        
        headers = {'Authorization': f'Bearer {self.api_key}'}
        
        for location_id in self.location_ids:
            location_id = location_id.strip()
            if not location_id:
                continue
            
            last_timestamp = self.get_watermark(f'last_timestamp_{location_id}')
            since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00')) if last_timestamp else datetime.now(timezone.utc) - timedelta(days=7)
            
            page_token = None
            newest_timestamp = None
            
            while True:
                url = f"{self.BASE_URL}/{location_id}/reviews"
                params = {'pageSize': 50}
                if page_token:
                    params['pageToken'] = page_token
                
                try:
                    response = fetch_with_retry(url, headers=headers, params=params)
                    response.raise_for_status()
                    data = response.json()
                except requests.RequestException as e:
                    logger.error(f"Google reviews API error: {e}")
                    break
                
                for review in data.get('reviews', []):
                    created_at_str = review.get('createTime', '')
                    if created_at_str:
                        created_at = datetime.fromisoformat(created_at_str.replace('Z', '+00:00'))
                        if created_at <= since:
                            continue
                        if not newest_timestamp or created_at_str > newest_timestamp:
                            newest_timestamp = created_at_str
                    
                    star_map = {'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5}
                    
                    yield {
                        'id': review.get('reviewId', ''),
                        'channel': 'review',
                        'url': review.get('name', ''),
                        'text': review.get('comment', ''),
                        'rating': star_map.get(review.get('starRating')),
                        'created_at': created_at_str,
                        'brand_handles_matched': [self.brand_name]
                    }
                
                page_token = data.get('nextPageToken')
                if not page_token:
                    break
            
            if newest_timestamp:
                self.set_watermark(f'last_timestamp_{location_id}', newest_timestamp)


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = GoogleReviewsIngestor()
    return ingestor.run()
