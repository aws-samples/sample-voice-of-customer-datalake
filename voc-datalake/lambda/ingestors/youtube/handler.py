"""
YouTube Ingestor - Fetches video comments using YouTube Data API v3.
"""
import requests
from datetime import datetime, timezone
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class YouTubeIngestor(BaseIngestor):
    """Ingestor for YouTube Data API v3 comments."""
    
    BASE_URL = "https://www.googleapis.com/youtube/v3"
    
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get('youtube_api_key', '')
        self.channel_id = self.secrets.get('youtube_channel_id', '')
        self.video_ids = [v.strip() for v in self.secrets.get('youtube_video_ids', '').split(',') if v.strip()]
        self.search_terms = self.secrets.get('youtube_search_terms', '')
    
    def _get_channel_videos(self) -> list[str]:
        """Get recent video IDs from channel."""
        if not self.channel_id:
            return []
        
        video_ids = []
        try:
            # Get uploads playlist
            response = requests.get(
                f"{self.BASE_URL}/channels",
                params={
                    'key': self.api_key,
                    'id': self.channel_id,
                    'part': 'contentDetails'
                }
            )
            response.raise_for_status()
            data = response.json()
            
            uploads_playlist = data['items'][0]['contentDetails']['relatedPlaylists']['uploads']
            
            # Get recent videos from uploads playlist
            response = requests.get(
                f"{self.BASE_URL}/playlistItems",
                params={
                    'key': self.api_key,
                    'playlistId': uploads_playlist,
                    'part': 'contentDetails',
                    'maxResults': 20
                }
            )
            response.raise_for_status()
            data = response.json()
            
            for item in data.get('items', []):
                video_ids.append(item['contentDetails']['videoId'])
                
        except Exception as e:
            logger.error(f"Failed to get channel videos: {e}")
        
        return video_ids
    
    def _search_videos(self) -> list[str]:
        """Search for videos mentioning the brand."""
        if not self.search_terms:
            # Build search from brand name and handles
            terms = [self.brand_name] + self.brand_handles
            search_query = ' | '.join(terms)
        else:
            search_query = self.search_terms
        
        video_ids = []
        try:
            response = requests.get(
                f"{self.BASE_URL}/search",
                params={
                    'key': self.api_key,
                    'q': search_query,
                    'type': 'video',
                    'part': 'id',
                    'maxResults': 25,
                    'order': 'date',
                    'publishedAfter': self.get_watermark('search_after', '2024-01-01T00:00:00Z')
                }
            )
            response.raise_for_status()
            data = response.json()
            
            for item in data.get('items', []):
                video_ids.append(item['id']['videoId'])
                
        except Exception as e:
            logger.error(f"Failed to search videos: {e}")
        
        return video_ids
    
    def _get_video_comments(self, video_id: str) -> Generator[dict, None, None]:
        """Get comments for a specific video."""
        page_token = None
        last_comment_id = self.get_watermark(f'video_{video_id}_last')
        
        while True:
            try:
                params = {
                    'key': self.api_key,
                    'videoId': video_id,
                    'part': 'snippet',
                    'maxResults': 100,
                    'order': 'time',
                    'textFormat': 'plainText'
                }
                if page_token:
                    params['pageToken'] = page_token
                
                response = requests.get(f"{self.BASE_URL}/commentThreads", params=params)
                
                if response.status_code == 403:
                    logger.warning(f"Comments disabled for video {video_id}")
                    break
                response.raise_for_status()
                data = response.json()
                
            except requests.RequestException as e:
                logger.error(f"YouTube API error for video {video_id}: {e}")
                break
            
            items = data.get('items', [])
            if not items:
                break
            
            newest_id = None
            for item in items:
                comment_id = item['id']
                
                # Skip if we've seen this comment before
                if last_comment_id and comment_id == last_comment_id:
                    return
                
                if not newest_id:
                    newest_id = comment_id
                
                snippet = item['snippet']['topLevelComment']['snippet']
                
                yield {
                    'id': comment_id,
                    'channel': 'youtube_comment',
                    'url': f"https://www.youtube.com/watch?v={video_id}&lc={comment_id}",
                    'text': snippet.get('textDisplay', ''),
                    'rating': None,
                    'created_at': snippet.get('publishedAt', ''),
                    'author': snippet.get('authorDisplayName', ''),
                    'video_id': video_id,
                    'like_count': snippet.get('likeCount', 0),
                }
            
            if newest_id:
                self.set_watermark(f'video_{video_id}_last', newest_id)
            
            page_token = data.get('nextPageToken')
            if not page_token:
                break
    
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new YouTube comments."""
        if not self.api_key:
            logger.warning("YouTube API key not configured")
            return
        
        # Collect video IDs from all sources
        all_video_ids = set(self.video_ids)
        
        if self.channel_id:
            all_video_ids.update(self._get_channel_videos())
        
        # Search for brand mentions
        all_video_ids.update(self._search_videos())
        
        logger.info(f"Processing {len(all_video_ids)} videos")
        
        for video_id in all_video_ids:
            for comment in self._get_video_comments(video_id):
                # Check for brand mention in comment
                text_lower = comment.get('text', '').lower()
                matched = [h for h in self.brand_handles if h.lower().lstrip('@') in text_lower]
                if matched or self.brand_name.lower() in text_lower:
                    comment['brand_handles_matched'] = matched or [self.brand_name]
                yield comment
        
        # Update search watermark
        self.set_watermark('search_after', datetime.now(timezone.utc).isoformat())


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = YouTubeIngestor()
    return ingestor.run()
