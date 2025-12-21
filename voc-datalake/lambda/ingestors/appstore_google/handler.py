"""
Google Play Store Ingestor - Fetches app reviews from Google Play Developer API.
Requires Google Play Developer API credentials with access to reviews.
"""
from datetime import datetime, timezone, timedelta
from typing import Generator
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics, fetch_with_retry
import requests


class AppStoreGoogleIngestor(BaseIngestor):
    """Ingestor for Google Play Store reviews via Play Developer API."""

    BASE_URL = "https://androidpublisher.googleapis.com/androidpublisher/v3"

    def __init__(self):
        super().__init__()
        self.package_name = self.secrets.get('google_play_package_name', '')
        self.service_account_json = self.secrets.get('google_play_service_account', '')
        self.access_token = None

    def _get_access_token(self) -> str:
        """Get OAuth access token using service account credentials."""
        if self.access_token:
            return self.access_token

        import json
        import time

        try:
            sa_info = json.loads(self.service_account_json)
        except (json.JSONDecodeError, TypeError):
            logger.error("Invalid service account JSON")
            return ''

        # For production, use google-auth library in the layer
        # This is a simplified JWT creation for the service account
        try:
            import jwt

            now = int(time.time())
            payload = {
                'iss': sa_info['client_email'],
                'scope': 'https://www.googleapis.com/auth/androidpublisher',
                'aud': 'https://oauth2.googleapis.com/token',
                'iat': now,
                'exp': now + 3600,
            }
            signed_jwt = jwt.encode(payload, sa_info['private_key'], algorithm='RS256')

            response = fetch_with_retry(
                'https://oauth2.googleapis.com/token',
                method='POST',
                data={
                    'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    'assertion': signed_jwt
                },
                timeout=10
            )
            response.raise_for_status()
            self.access_token = response.json()['access_token']
            return self.access_token

        except ImportError:
            logger.error("PyJWT not available - add to layer")
            return ''
        except Exception as e:
            logger.error(f"Failed to get Google access token: {e}")
            return ''

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new reviews from Google Play Store."""
        if not self.package_name or not self.service_account_json:
            logger.warning("Google Play credentials not configured")
            return

        token = self._get_access_token()
        if not token:
            return

        headers = {'Authorization': f'Bearer {token}'}

        last_timestamp = self.get_watermark('last_timestamp')
        if last_timestamp:
            since = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
        else:
            since = datetime.now(timezone.utc) - timedelta(days=7)

        newest_timestamp = None
        next_page_token = None

        while True:
            url = f"{self.BASE_URL}/applications/{self.package_name}/reviews"
            params = {'maxResults': 100}
            if next_page_token:
                params['token'] = next_page_token

            try:
                response = fetch_with_retry(url, headers=headers, params=params, timeout=30)
                response.raise_for_status()
                data = response.json()
            except requests.RequestException as e:
                logger.error(f"Failed to fetch Google Play reviews: {e}")
                break

            reviews = data.get('reviews', [])
            if not reviews:
                break

            for review in reviews:
                review_id = review.get('reviewId', '')
                comments = review.get('comments', [])
                if not comments:
                    continue

                user_comment = comments[0].get('userComment', {})
                text = user_comment.get('text', '')
                rating = user_comment.get('starRating', 0)
                last_modified = user_comment.get('lastModified', {})
                timestamp_seconds = int(last_modified.get('seconds', 0))
                review_time = datetime.fromtimestamp(timestamp_seconds, tz=timezone.utc)

                if review_time <= since:
                    continue

                if not newest_timestamp or review_time > newest_timestamp:
                    newest_timestamp = review_time

                yield {
                    'id': f"google_{review_id}",
                    'channel': 'app_review',
                    'url': f"https://play.google.com/store/apps/details?id={self.package_name}",
                    'text': text,
                    'rating': rating,
                    'created_at': review_time.isoformat(),
                    'brand_handles_matched': [self.brand_name],
                    'author': review.get('authorName', 'Anonymous'),
                    'app_version': user_comment.get('appVersionName', ''),
                    'device': user_comment.get('device', ''),
                    'store': 'google_play',
                }

            next_page_token = data.get('tokenPagination', {}).get('nextPageToken')
            if not next_page_token:
                break

        if newest_timestamp:
            self.set_watermark('last_timestamp', newest_timestamp.isoformat())


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = AppStoreGoogleIngestor()
    return ingestor.run()
