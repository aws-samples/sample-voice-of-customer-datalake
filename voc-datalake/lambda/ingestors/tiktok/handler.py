"""
TikTok Ingestor - Fetches comments and mentions using TikTok API for Business.
Note: TikTok's API is restricted - requires approved business account access.
"""
import requests
from datetime import datetime, timezone
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class TikTokIngestor(BaseIngestor):
    """Ingestor for TikTok API for Business."""
    
    BASE_URL = "https://open.tiktokapis.com/v2"
    
    def __init__(self):
        super().__init__()
        self.access_token = self.secrets.get('tiktok_access_token', '')
        self.business_id = self.secrets.get('tiktok_business_id', '')
        # Video IDs to monitor (comma-separated)
        self.video_ids = [v.strip() for v in self.secrets.get('tiktok_video_ids', '').split(',') if v.strip()]
    
    def _refresh_token_if_needed(self):
        """Refresh access token if expired (TikTok tokens expire in 24h)."""
        refresh_token = self.secrets.get('tiktok_refresh_token', '')
        client_key = self.secrets.get('tiktok_client_key', '')
        client_secret = self.secrets.get('tiktok_client_secret', '')
        
        if not all([refresh_token, client_key, client_secret]):
            return
        
        # Check if token needs refresh (stored expiry time)
        token_expiry = self.get_watermark('token_expiry')
        if token_expiry:
            expiry_time = datetime.fromisoformat(token_expiry.replace('Z', '+00:00'))
            if datetime.now(timezone.utc) < expiry_time:
                return  # Token still valid
        
        try:
            response = requests.post(
                "https://open.tiktokapis.com/v2/oauth/token/",
                data={
                    'client_key': client_key,
                    'client_secret': client_secret,
                    'grant_type': 'refresh_token',
                    'refresh_token': refresh_token
                }
            )
            response.raise_for_status()
            data = response.json()
            
            self.access_token = data.get('access_token', self.access_token)
            # Store new expiry (tokens last 24 hours, refresh 1 hour early)
            from datetime import timedelta
            new_expiry = datetime.now(timezone.utc) + timedelta(hours=23)
            self.set_watermark('token_expiry', new_expiry.isoformat())
            
            logger.info("TikTok access token refreshed")
        except Exception as e:
            logger.error(f"Failed to refresh TikTok token: {e}")
    
    def _get_headers(self) -> dict:
        """Get API request headers."""
        return {
            'Authorization': f'Bearer {self.access_token}',
            'Content-Type': 'application/json'
        }
    
    def _get_business_videos(self) -> list[str]:
        """Get recent videos from business account."""
        if not self.business_id:
            return []
        
        video_ids = []
        try:
            response = requests.post(
                f"{self.BASE_URL}/business/video/list/",
                headers=self._get_headers(),
                json={
                    'business_id': self.business_id,
                    'max_count': 20,
                    'fields': ['id', 'create_time', 'title']
                }
            )
            response.raise_for_status()
            data = response.json()
            
            for video in data.get('data', {}).get('videos', []):
                video_ids.append(video['id'])
                
        except Exception as e:
            logger.error(f"Failed to get business videos: {e}")
        
        return video_ids
    
    def _get_video_comments(self, video_id: str) -> Generator[dict, None, None]:
        """Get comments for a specific video."""
        cursor = 0
        last_comment_time = self.get_watermark(f'video_{video_id}_last_time')
        
        while True:
            try:
                response = requests.post(
                    f"{self.BASE_URL}/business/comment/list/",
                    headers=self._get_headers(),
                    json={
                        'business_id': self.business_id,
                        'video_id': video_id,
                        'cursor': cursor,
                        'max_count': 50,
                        'fields': ['id', 'text', 'create_time', 'user', 'like_count']
                    }
                )
                
                if response.status_code == 403:
                    logger.warning(f"Comments access denied for video {video_id}")
                    break
                response.raise_for_status()
                data = response.json()
                
            except requests.RequestException as e:
                logger.error(f"TikTok API error for video {video_id}: {e}")
                break
            
            comments = data.get('data', {}).get('comments', [])
            if not comments:
                break
            
            newest_time = None
            for comment in comments:
                comment_time = comment.get('create_time', 0)
                
                # Skip if we've seen this comment before (by timestamp)
                if last_comment_time and comment_time <= int(last_comment_time):
                    continue
                
                if not newest_time or comment_time > newest_time:
                    newest_time = comment_time
                
                user = comment.get('user', {})
                created_at = datetime.fromtimestamp(comment_time, tz=timezone.utc).isoformat()
                
                yield {
                    'id': comment.get('id', f"tiktok-{video_id}-{comment_time}"),
                    'channel': 'tiktok_comment',
                    'url': f"https://www.tiktok.com/@{user.get('unique_id', 'user')}/video/{video_id}",
                    'text': comment.get('text', ''),
                    'rating': None,
                    'created_at': created_at,
                    'author': user.get('display_name', user.get('unique_id', '')),
                    'video_id': video_id,
                    'like_count': comment.get('like_count', 0),
                }
            
            if newest_time:
                self.set_watermark(f'video_{video_id}_last_time', str(newest_time))
            
            if not data.get('data', {}).get('has_more', False):
                break
            cursor = data.get('data', {}).get('cursor', cursor + 50)
    
    def _search_mentions(self) -> Generator[dict, None, None]:
        """Search for brand mentions (requires Research API access)."""
        # Note: TikTok Research API requires special approval
        # This is a placeholder for when access is granted
        research_enabled = self.secrets.get('tiktok_research_enabled', 'false').lower() == 'true'
        
        if not research_enabled:
            return
        
        try:
            # Build search query
            query = f'"{self.brand_name}"'
            for handle in self.brand_handles[:3]:  # Limit handles
                query += f' OR "{handle}"'
            
            response = requests.post(
                f"{self.BASE_URL}/research/video/query/",
                headers=self._get_headers(),
                json={
                    'query': {'and': [{'operation': 'IN', 'field_name': 'keyword', 'field_values': [self.brand_name] + self.brand_handles}]},
                    'max_count': 100,
                    'start_date': self.get_watermark('search_start', '20240101'),
                    'end_date': datetime.now(timezone.utc).strftime('%Y%m%d')
                }
            )
            response.raise_for_status()
            data = response.json()
            
            for video in data.get('data', {}).get('videos', []):
                # Get comments for mentioned videos
                for comment in self._get_video_comments(video['id']):
                    yield comment
                    
        except Exception as e:
            logger.error(f"TikTok search error: {e}")
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new TikTok comments and mentions."""
        if not self.access_token:
            logger.warning("TikTok access token not configured")
            return
        
        # Refresh token if needed
        self._refresh_token_if_needed()
        
        # Collect video IDs
        all_video_ids = set(self.video_ids)
        
        if self.business_id:
            all_video_ids.update(self._get_business_videos())
        
        logger.info(f"Processing {len(all_video_ids)} TikTok videos")
        
        for video_id in all_video_ids:
            for comment in self._get_video_comments(video_id):
                # Check for brand mention
                text_lower = comment.get('text', '').lower()
                matched = [h for h in self.brand_handles if h.lower().lstrip('@') in text_lower]
                if matched or self.brand_name.lower() in text_lower:
                    comment['brand_handles_matched'] = matched or [self.brand_name]
                yield comment
        
        # Search for mentions (if Research API enabled)
        for item in self._search_mentions():
            yield item


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = TikTokIngestor()
    return ingestor.run()
