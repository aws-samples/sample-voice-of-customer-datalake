"""
Facebook Ingestor - Fetches page reviews and comments using Meta Graph API.
"""
import requests
from datetime import datetime, timezone, timedelta
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class FacebookIngestor(BaseIngestor):
    """Ingestor for Facebook Page reviews via Meta Graph API."""
    
    BASE_URL = "https://graph.facebook.com/v18.0"
    
    def __init__(self):
        super().__init__()
        self.access_token = self.secrets.get('meta_access_token', '')
        self.page_id = self.secrets.get('meta_page_id', '')
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.access_token or not self.page_id:
            logger.warning("Meta access token or page ID not configured")
            return
        
        params = {'access_token': self.access_token}
        yield from self._fetch_ratings(params)
        yield from self._fetch_post_comments(params)
    
    def _fetch_ratings(self, params: dict) -> Generator[dict, None, None]:
        last_timestamp = self.get_watermark('ratings_last_timestamp')
        since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00')) if last_timestamp else datetime.now(timezone.utc) - timedelta(days=7)
        
        url = f"{self.BASE_URL}/{self.page_id}/ratings"
        params_with_fields = {**params, 'fields': 'created_time,reviewer,review_text,recommendation_type,rating', 'limit': 100}
        newest_timestamp = None
        
        while url:
            try:
                response = requests.get(url, params=params_with_fields)
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Facebook ratings API error: {e}")
                break
            
            for rating in data.get('data', []):
                created_at = rating.get('created_time', '')
                if created_at:
                    created_dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                    if created_dt <= since:
                        continue
                    if not newest_timestamp or created_at > newest_timestamp:
                        newest_timestamp = created_at
                
                rec_type = rating.get('recommendation_type', '')
                numeric_rating = 5 if rec_type == 'positive' else (1 if rec_type == 'negative' else 3)
                
                yield {
                    'id': rating.get('open_graph_story', {}).get('id', f"fb_rating_{created_at}"),
                    'channel': 'review',
                    'url': f"https://facebook.com/{self.page_id}/reviews",
                    'text': rating.get('review_text', ''),
                    'rating': numeric_rating,
                    'created_at': created_at,
                    'brand_handles_matched': [self.brand_name]
                }
            
            url = data.get('paging', {}).get('next')
            params_with_fields = {}
        
        if newest_timestamp:
            self.set_watermark('ratings_last_timestamp', newest_timestamp)
    
    def _fetch_post_comments(self, params: dict) -> Generator[dict, None, None]:
        last_timestamp = self.get_watermark('comments_last_timestamp')
        since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00')) if last_timestamp else datetime.now(timezone.utc) - timedelta(days=3)
        
        posts_url = f"{self.BASE_URL}/{self.page_id}/posts"
        posts_params = {**params, 'fields': 'id,created_time', 'limit': 25, 'since': int(since.timestamp())}
        
        try:
            response = requests.get(posts_url, params=posts_params)
            response.raise_for_status()
            posts_data = response.json()
        except requests.RequestException as e:
            logger.error(f"Facebook posts API error: {e}")
            return
        
        newest_timestamp = None
        
        for post in posts_data.get('data', []):
            post_id = post.get('id')
            comments_url = f"{self.BASE_URL}/{post_id}/comments"
            comments_params = {**params, 'fields': 'id,created_time,from,message', 'limit': 100}
            
            try:
                response = requests.get(comments_url, params=comments_params)
                response.raise_for_status()
                comments_data = response.json()
            except requests.RequestException:
                continue
            
            for comment in comments_data.get('data', []):
                created_at = comment.get('created_time', '')
                if not newest_timestamp or created_at > newest_timestamp:
                    newest_timestamp = created_at
                
                yield {
                    'id': comment.get('id', ''),
                    'channel': 'comment',
                    'url': f"https://facebook.com/{post_id}",
                    'text': comment.get('message', ''),
                    'rating': None,
                    'created_at': created_at,
                    'brand_handles_matched': [self.brand_name]
                }
        
        if newest_timestamp:
            self.set_watermark('comments_last_timestamp', newest_timestamp)


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = FacebookIngestor()
    return ingestor.run()
