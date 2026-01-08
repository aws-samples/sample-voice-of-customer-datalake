"""
Reddit Ingestor - Fetches brand mentions from Reddit Data API.
"""
from datetime import datetime, timezone, timedelta
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class RedditIngestor(BaseIngestor):
    """Ingestor for Reddit Data API."""
    
    BASE_URL = "https://oauth.reddit.com"
    AUTH_URL = "https://www.reddit.com/api/v1/access_token"
    
    def __init__(self):
        super().__init__()
        self.client_id = self.secrets.get('reddit_client_id', '')
        self.client_secret = self.secrets.get('reddit_client_secret', '')
        self.access_token = None
        self.subreddits = self.secrets.get('reddit_subreddits', 'all').split(',')
    
    def _get_access_token(self) -> str:
        if self.access_token:
            return self.access_token
        
        auth = (self.client_id, self.client_secret)
        headers = {'User-Agent': 'VoC-DataLake/1.0'}
        data = {'grant_type': 'client_credentials'}
        
        response = fetch_with_retry(
            self.AUTH_URL, 
            method='POST',
            headers=headers, 
            data=data,
            auth=auth
        )
        response.raise_for_status()
        self.access_token = response.json()['access_token']
        return self.access_token
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.client_id or not self.client_secret:
            logger.warning("Reddit credentials not configured")
            return
        
        token = self._get_access_token()
        headers = {'Authorization': f'Bearer {token}', 'User-Agent': 'VoC-DataLake/1.0'}
        
        search_terms = [f'"{self.brand_name}"'] + [f'"{h.lstrip("@")}"' for h in self.brand_handles]
        query = ' OR '.join(search_terms)
        
        last_timestamp = self.get_watermark('last_timestamp')
        since = float(last_timestamp) if last_timestamp else (datetime.now(timezone.utc) - timedelta(days=7)).timestamp()
        newest_timestamp = None
        
        for subreddit in self.subreddits:
            subreddit = subreddit.strip()
            after = None
            
            while True:
                url = f"{self.BASE_URL}/r/{subreddit}/search"
                params = {'q': query, 'sort': 'new', 'limit': 100, 't': 'week'}
                if after:
                    params['after'] = after
                
                try:
                    response = fetch_with_retry(url, headers=headers, params=params)
                    if response.status_code == 429:
                        break
                    response.raise_for_status()
                    data = response.json()
                except requests.RequestException as e:
                    logger.error(f"Reddit API error: {e}")
                    break
                
                posts = data.get('data', {}).get('children', [])
                if not posts:
                    break
                
                for post in posts:
                    post_data = post.get('data', {})
                    created_utc = post_data.get('created_utc', 0)
                    
                    if created_utc <= since:
                        continue
                    
                    if not newest_timestamp or created_utc > newest_timestamp:
                        newest_timestamp = created_utc
                    
                    is_comment = post.get('kind') == 't1'
                    text = post_data.get('body', '') if is_comment else post_data.get('selftext', '')
                    title = '' if is_comment else post_data.get('title', '')
                    
                    yield {
                        'id': post_data.get('id', ''),
                        'channel': 'comment' if is_comment else 'post',
                        'url': f"https://reddit.com{post_data.get('permalink', '')}",
                        'text': f"{title}\n\n{text}".strip() if title else text,
                        'rating': None,
                        'created_at': datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat(),
                        'brand_handles_matched': [self.brand_name]
                    }
                
                after = data.get('data', {}).get('after')
                if not after:
                    break
        
        if newest_timestamp:
            self.set_watermark('last_timestamp', str(newest_timestamp))


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = RedditIngestor()
    return ingestor.run()
