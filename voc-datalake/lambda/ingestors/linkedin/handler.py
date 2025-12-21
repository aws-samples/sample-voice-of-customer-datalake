"""
LinkedIn Ingestor - Fetches company page comments and mentions using LinkedIn API.
Note: LinkedIn API is restricted - requires approved Marketing Developer Platform access.
"""
from datetime import datetime, timezone
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class LinkedInIngestor(BaseIngestor):
    """Ingestor for LinkedIn Marketing API."""
    
    BASE_URL = "https://api.linkedin.com/v2"
    
    def __init__(self):
        super().__init__()
        self.access_token = self.secrets.get('linkedin_access_token', '')
        self.organization_id = self.secrets.get('linkedin_organization_id', '')
    
    def _get_headers(self) -> dict:
        return {
            'Authorization': f'Bearer {self.access_token}',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202401'
        }

    def _get_organization_posts(self) -> list[str]:
        """Get recent posts from organization page."""
        if not self.organization_id:
            return []
        
        post_urns = []
        try:
            response = fetch_with_retry(
                f"{self.BASE_URL}/shares",
                headers=self._get_headers(),
                params={
                    'q': 'owners',
                    'owners': f'urn:li:organization:{self.organization_id}',
                    'count': 20,
                    'sortBy': 'LAST_MODIFIED'
                }
            )
            response.raise_for_status()
            data = response.json()
            
            for share in data.get('elements', []):
                post_urns.append(share.get('activity', share.get('id')))
        except Exception as e:
            logger.error(f"Failed to get organization posts: {e}")
        
        return post_urns
    
    def _get_post_comments(self, post_urn: str) -> Generator[dict, None, None]:
        """Get comments for a specific post."""
        start = 0
        last_comment_time = self.get_watermark(f'post_{post_urn}_last_time')
        
        while True:
            try:
                response = fetch_with_retry(
                    f"{self.BASE_URL}/socialActions/{post_urn}/comments",
                    headers=self._get_headers(),
                    params={'start': start, 'count': 50}
                )
                
                if response.status_code == 403:
                    logger.warning(f"Comments access denied for post {post_urn}")
                    break
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"LinkedIn API error for post {post_urn}: {e}")
                break
            
            comments = data.get('elements', [])
            if not comments:
                break
            
            newest_time = None
            for comment in comments:
                created_time = comment.get('created', {}).get('time', 0)
                
                if last_comment_time and created_time <= int(last_comment_time):
                    continue
                
                if not newest_time or created_time > newest_time:
                    newest_time = created_time
                
                actor = comment.get('actor', '')
                created_at = datetime.fromtimestamp(created_time / 1000, tz=timezone.utc).isoformat()
                
                yield {
                    'id': comment.get('$URN', f"linkedin-{post_urn}-{created_time}"),
                    'channel': 'linkedin_comment',
                    'url': f"https://www.linkedin.com/feed/update/{post_urn}",
                    'text': comment.get('message', {}).get('text', ''),
                    'rating': None,
                    'created_at': created_at,
                    'author': actor,
                    'post_urn': post_urn,
                }
            
            if newest_time:
                self.set_watermark(f'post_{post_urn}_last_time', str(newest_time))
            
            paging = data.get('paging', {})
            if start + len(comments) >= paging.get('total', 0):
                break
            start += 50

    def _search_mentions(self) -> Generator[dict, None, None]:
        """Search for brand mentions in posts (requires Content Search API access)."""
        # Note: LinkedIn Content Search API requires special partnership access
        # This searches organization mentions via the UGC API
        try:
            response = fetch_with_retry(
                f"{self.BASE_URL}/organizationalEntityShareStatistics",
                headers=self._get_headers(),
                params={
                    'q': 'organizationalEntity',
                    'organizationalEntity': f'urn:li:organization:{self.organization_id}'
                }
            )
            response.raise_for_status()
            # Process mentions from share statistics
        except Exception as e:
            logger.warning(f"LinkedIn mentions search not available: {e}")
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new LinkedIn comments and mentions."""
        if not self.access_token:
            logger.warning("LinkedIn access token not configured")
            return
        
        if not self.organization_id:
            logger.warning("LinkedIn organization ID not configured")
            return
        
        # Get posts from organization page
        post_urns = self._get_organization_posts()
        logger.info(f"Processing {len(post_urns)} LinkedIn posts")
        
        for post_urn in post_urns:
            for comment in self._get_post_comments(post_urn):
                text_lower = comment.get('text', '').lower()
                matched = [h for h in self.brand_handles if h.lower().lstrip('@') in text_lower]
                if matched or self.brand_name.lower() in text_lower:
                    comment['brand_handles_matched'] = matched or [self.brand_name]
                yield comment


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = LinkedInIngestor()
    return ingestor.run()
