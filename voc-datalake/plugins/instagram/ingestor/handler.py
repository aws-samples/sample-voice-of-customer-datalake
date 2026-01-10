"""
Instagram Ingestor - Fetches mentions and comments using Instagram Graph API.
"""
from datetime import datetime, timezone, timedelta
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class InstagramIngestor(BaseIngestor):
    """Ingestor for Instagram mentions via Meta Graph API."""
    
    BASE_URL = "https://graph.facebook.com/v18.0"
    
    def __init__(self):
        super().__init__()
        self.access_token = self.secrets.get('meta_access_token', '')
        self.instagram_account_id = self.secrets.get('meta_instagram_account_id', '')
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.access_token or not self.instagram_account_id:
            logger.warning("Meta access token or Instagram account ID not configured")
            return
        
        params = {'access_token': self.access_token}
        yield from self._fetch_mentions(params)
        yield from self._fetch_media_comments(params)
    
    def _fetch_mentions(self, params: dict) -> Generator[dict, None, None]:
        last_timestamp = self.get_watermark('mentions_last_timestamp')
        since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00')) if last_timestamp else datetime.now(timezone.utc) - timedelta(days=7)
        
        url = f"{self.BASE_URL}/{self.instagram_account_id}/tags"
        params_with_fields = {**params, 'fields': 'id,caption,timestamp,permalink,username,media_type', 'limit': 50}
        newest_timestamp = None
        
        while url:
            try:
                response = fetch_with_retry(url, params=params_with_fields)
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Instagram mentions API error: {e}")
                break
            
            for mention in data.get('data', []):
                timestamp = mention.get('timestamp', '')
                if timestamp:
                    created_dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    if created_dt <= since:
                        continue
                    if not newest_timestamp or timestamp > newest_timestamp:
                        newest_timestamp = timestamp
                
                yield {
                    'id': mention.get('id', ''),
                    'channel': 'mention',
                    'url': mention.get('permalink', ''),
                    'text': mention.get('caption', ''),
                    'rating': None,
                    'created_at': timestamp,
                    'brand_handles_matched': self.brand_handles
                }
            
            url = data.get('paging', {}).get('next')
            params_with_fields = {}
        
        if newest_timestamp:
            self.set_watermark('mentions_last_timestamp', newest_timestamp)
    
    def _fetch_media_comments(self, params: dict) -> Generator[dict, None, None]:
        last_timestamp = self.get_watermark('comments_last_timestamp')
        since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00')) if last_timestamp else datetime.now(timezone.utc) - timedelta(days=3)
        
        media_url = f"{self.BASE_URL}/{self.instagram_account_id}/media"
        media_params = {**params, 'fields': 'id,timestamp,permalink', 'limit': 25}
        
        try:
            response = fetch_with_retry(media_url, params=media_params)
            response.raise_for_status()
            media_data = response.json()
        except requests.RequestException as e:
            logger.error(f"Instagram media API error: {e}")
            return
        
        newest_timestamp = None
        
        for media in media_data.get('data', []):
            media_id = media.get('id')
            media_permalink = media.get('permalink', '')
            
            comments_url = f"{self.BASE_URL}/{media_id}/comments"
            comments_params = {**params, 'fields': 'id,text,timestamp,username', 'limit': 100}
            
            try:
                response = fetch_with_retry(comments_url, params=comments_params)
                response.raise_for_status()
                comments_data = response.json()
            except requests.RequestException:
                continue
            
            for comment in comments_data.get('data', []):
                timestamp = comment.get('timestamp', '')
                if timestamp:
                    created_dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    if created_dt <= since:
                        continue
                if not newest_timestamp or timestamp > newest_timestamp:
                    newest_timestamp = timestamp
                
                yield {
                    'id': comment.get('id', ''),
                    'channel': 'comment',
                    'url': media_permalink,
                    'text': comment.get('text', ''),
                    'rating': None,
                    'created_at': timestamp,
                    'brand_handles_matched': [self.brand_name]
                }
        
        if newest_timestamp:
            self.set_watermark('comments_last_timestamp', newest_timestamp)


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = InstagramIngestor()
    return ingestor.run()
