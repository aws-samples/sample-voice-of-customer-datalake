"""
Twitter/X Ingestor - Fetches brand mentions using Twitter API v2 Recent Search.
"""
from datetime import datetime, timezone
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class TwitterIngestor(BaseIngestor):
    """Ingestor for Twitter/X API v2 Recent Search."""
    
    BASE_URL = "https://api.twitter.com/2"
    
    def __init__(self):
        super().__init__()
        self.bearer_token = self.secrets.get('twitter_bearer_token', '')
    
    def _build_query(self) -> str:
        """Build Twitter search query from brand handles and name."""
        terms = []
        for handle in self.brand_handles:
            terms.append(f"@{handle.lstrip('@')}")
            terms.append(f"#{handle.lstrip('@')}")
        terms.append(f'"{self.brand_name}"')
        query = f"({' OR '.join(terms)}) -is:retweet lang:en"
        return query[:512]
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch recent tweets mentioning the brand."""
        if not self.bearer_token:
            logger.warning("Twitter bearer token not configured")
            return
        
        headers = {'Authorization': f'Bearer {self.bearer_token}'}
        since_id = self.get_watermark('since_id')
        query = self._build_query()
        newest_id = None
        next_token = None
        
        while True:
            url = f"{self.BASE_URL}/tweets/search/recent"
            params = {
                'query': query,
                'max_results': 100,
                'tweet.fields': 'created_at,author_id,public_metrics,lang',
                'expansions': 'author_id',
                'user.fields': 'username,name'
            }
            
            if since_id:
                params['since_id'] = since_id
            if next_token:
                params['next_token'] = next_token
            
            try:
                response = fetch_with_retry(url, headers=headers, params=params)
                if response.status_code == 429:
                    logger.warning("Twitter rate limit reached")
                    break
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Twitter API error: {e}")
                break
            
            tweets = data.get('data', [])
            if not tweets:
                break
            
            users = {u['id']: u for u in data.get('includes', {}).get('users', [])}
            
            for tweet in tweets:
                if not newest_id:
                    newest_id = tweet['id']
                
                author = users.get(tweet.get('author_id'), {})
                text_lower = tweet.get('text', '').lower()
                matched = [h for h in self.brand_handles if h.lower().lstrip('@') in text_lower]
                
                yield {
                    'id': tweet['id'],
                    'channel': 'tweet',
                    'url': f"https://twitter.com/{author.get('username', 'i')}/status/{tweet['id']}",
                    'text': tweet.get('text', ''),
                    'rating': None,
                    'created_at': tweet.get('created_at', ''),
                    'brand_handles_matched': matched or [self.brand_name]
                }
            
            next_token = data.get('meta', {}).get('next_token')
            if not next_token:
                break
        
        if newest_id:
            self.set_watermark('since_id', newest_id)


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = TwitterIngestor()
    return ingestor.run()
