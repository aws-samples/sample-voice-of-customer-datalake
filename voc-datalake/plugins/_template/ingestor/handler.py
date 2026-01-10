"""
Template Ingestor - Starting point for new plugins.

Copy this folder to plugins/{your_source_id}/ and customize.
"""

from typing import Generator

# Import from shared plugin modules
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics


class MySourceIngestor(BaseIngestor):
    """Ingestor for My Source API."""

    def __init__(self):
        super().__init__()
        # Access your secrets (prefixed keys are stripped automatically)
        self.api_key = self.secrets.get("api_key", "")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """
        Fetch new items from the data source.
        
        This method should:
        1. Use watermarks to track progress (get_watermark/set_watermark)
        2. Yield items one at a time for memory efficiency
        3. Handle pagination if the API supports it
        4. Return items in the expected format (see below)
        
        Expected item format:
        {
            "id": "unique_id_from_source",
            "text": "The feedback content",
            "rating": 4.5,  # Optional, 1-5 scale
            "created_at": "2026-01-08T10:30:00Z",  # ISO 8601
            "url": "https://source.com/review/123",  # Optional
            "channel": "review",  # Optional: review, comment, mention, etc.
            "author": "John D.",  # Optional
            "title": "Great product!",  # Optional
        }
        """
        if not self.api_key:
            logger.warning("No API key configured for My Source")
            return

        # Get watermark for incremental fetching
        last_id = self.get_watermark("last_id")
        logger.info(f"Fetching items since last_id: {last_id}")

        # TODO: Implement your API fetching logic here
        # Example:
        #
        # import requests
        # 
        # response = requests.get(
        #     "https://api.mysource.com/reviews",
        #     headers={"Authorization": f"Bearer {self.api_key}"},
        #     params={"since_id": last_id} if last_id else {}
        # )
        # response.raise_for_status()
        # 
        # for item in response.json().get("reviews", []):
        #     yield {
        #         "id": item["id"],
        #         "text": item["content"],
        #         "rating": item.get("score"),
        #         "created_at": item["created_at"],
        #         "url": item.get("url"),
        #         "channel": "review",
        #         "author": item.get("author_name"),
        #     }

        # Placeholder - remove this when implementing
        logger.info("Template ingestor - no items to fetch")
        return
        yield  # Makes this a generator


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Lambda entry point."""
    ingestor = MySourceIngestor()
    return ingestor.run()
