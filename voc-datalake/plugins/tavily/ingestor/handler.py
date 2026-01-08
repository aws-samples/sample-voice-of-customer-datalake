"""
Tavily Ingestor - Fetches brand mentions from web search using Tavily API.
"""
import hashlib
from datetime import datetime, timezone
from typing import Generator

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class TavilyIngestor(BaseIngestor):
    """Ingestor for Tavily Search API."""
    
    BASE_URL = "https://api.tavily.com"
    
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get('tavily_api_key', '')
        self.search_queries = [
            f'"{self.brand_name}" review',
            f'"{self.brand_name}" experience',
            f'"{self.brand_name}" complaint',
            f'"{self.brand_name}" feedback',
        ]
    
    def _generate_url_hash(self, url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()[:16]
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key:
            logger.warning("Tavily API key not configured")
            return
        
        seen_urls_str = self.get_watermark('seen_urls', '[]')
        try:
            seen_urls = set(eval(seen_urls_str)) if seen_urls_str else set()
        except Exception:
            seen_urls = set()
        
        for query in self.search_queries:
            try:
                response = fetch_with_retry(
                    f"{self.BASE_URL}/search",
                    method='POST',
                    json={
                        'api_key': self.api_key,
                        'query': query,
                        'search_depth': 'advanced',
                        'include_answer': False,
                        'include_raw_content': True,
                        'max_results': 20,
                        'exclude_domains': ['facebook.com', 'twitter.com', 'instagram.com', 'reddit.com']
                    },
                    timeout=30
                )
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Tavily API error: {e}")
                continue
            
            for result in data.get('results', []):
                url = result.get('url', '')
                url_hash = self._generate_url_hash(url)
                
                if url_hash in seen_urls:
                    continue
                
                seen_urls.add(url_hash)
                content = result.get('raw_content', '') or result.get('content', '')
                
                if len(content) < 100:
                    continue
                
                yield {
                    'id': url_hash,
                    'channel': 'web',
                    'url': url,
                    'text': f"{result.get('title', '')}\n\n{content}".strip(),
                    'rating': None,
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'brand_handles_matched': [self.brand_name]
                }
        
        all_seen = list(seen_urls)[-10000:]
        self.set_watermark('seen_urls', str(all_seen))


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = TavilyIngestor()
    return ingestor.run()
