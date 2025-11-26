"""
Huawei AppGallery Ingestor - Fetches app reviews from Huawei AppGallery Connect API.
Requires AppGallery Connect API credentials.
"""
import requests
from datetime import datetime, timezone, timedelta
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics


class AppStoreHuaweiIngestor(BaseIngestor):
    """Ingestor for Huawei AppGallery reviews via Connect API."""

    BASE_URL = "https://connect-api.cloud.huawei.com/api"

    def __init__(self):
        super().__init__()
        self.client_id = self.secrets.get('huawei_client_id', '')
        self.client_secret = self.secrets.get('huawei_client_secret', '')
        self.app_id = self.secrets.get('huawei_app_id', '')
        self.access_token = None

    def _get_access_token(self) -> str:
        """Get OAuth access token from Huawei."""
        if self.access_token:
            return self.access_token

        try:
            response = requests.post(
                f"{self.BASE_URL}/oauth2/v1/token",
                json={
                    'grant_type': 'client_credentials',
                    'client_id': self.client_id,
                    'client_secret': self.client_secret
                },
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
            response.raise_for_status()
            self.access_token = response.json().get('access_token', '')
            return self.access_token
        except Exception as e:
            logger.error(f"Failed to get Huawei access token: {e}")
            return ''

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from Huawei AppGallery."""
        if not all([self.client_id, self.client_secret, self.app_id]):
            logger.warning("Huawei AppGallery credentials not configured")
            return

        token = self._get_access_token()
        if not token:
            return

        headers = {
            'Authorization': f'Bearer {token}',
            'client_id': self.client_id,
            'Content-Type': 'application/json'
        }

        last_timestamp = self.get_watermark('last_timestamp')
        if last_timestamp:
            since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
        else:
            since = datetime.now(timezone.utc) - timedelta(days=7)

        newest_timestamp = None
        page = 1
        page_size = 100

        while True:
            url = f"{self.BASE_URL}/publish/v2/app-comment-list"
            params = {
                'appId': self.app_id,
                'pageNum': page,
                'pageSize': page_size,
                'orderType': 1,  # Sort by time descending
            }

            try:
                response = requests.get(url, headers=headers, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Failed to fetch Huawei reviews: {e}")
                break

            if data.get('ret', {}).get('code') != 0:
                logger.error(f"Huawei API error: {data.get('ret', {}).get('msg')}")
                break

            comments = data.get('commentList', [])
            if not comments:
                break

            for comment in comments:
                comment_id = comment.get('commentId', '')
                text = comment.get('content', '')
                rating = comment.get('rating', 0)
                create_time = comment.get('createTime', 0)

                # Huawei uses milliseconds timestamp
                review_time = datetime.fromtimestamp(create_time / 1000, tz=timezone.utc)

                if review_time <= since:
                    if newest_timestamp:
                        self.set_watermark('last_timestamp', newest_timestamp.isoformat())
                    return

                if not newest_timestamp or review_time > newest_timestamp:
                    newest_timestamp = review_time

                yield {
                    'id': f"huawei_{comment_id}",
                    'channel': 'app_review',
                    'url': f"https://appgallery.huawei.com/app/{self.app_id}",
                    'text': text,
                    'rating': rating,
                    'created_at': review_time.isoformat(),
                    'brand_handles_matched': [self.brand_name],
                    'author': comment.get('nickName', 'Anonymous'),
                    'app_version': comment.get('versionName', ''),
                    'country': comment.get('countryCode', ''),
                    'store': 'huawei',
                }

            if len(comments) < page_size:
                break
            page += 1

        if newest_timestamp:
            self.set_watermark('last_timestamp', newest_timestamp.isoformat())


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = AppStoreHuaweiIngestor()
    return ingestor.run()
