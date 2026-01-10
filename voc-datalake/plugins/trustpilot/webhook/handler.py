"""
Trustpilot Webhook Handler - Receives real-time review events.
"""

import sys
import os
from typing import Any

# Add plugin shared modules to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from _shared.base_webhook import BaseWebhook, logger, tracer, metrics
from _shared.webhook_auth import require_webhook_signature


class TrustpilotWebhook(BaseWebhook):
    """Webhook handler for Trustpilot events."""

    def parse_webhook_payload(self, body: dict, headers: dict) -> list[dict]:
        """
        Parse Trustpilot webhook payload.
        
        Trustpilot sends events like:
        - service-review-created
        - service-review-updated
        - service-review-deleted
        """
        event_type = body.get("eventType", "")
        review_data = body.get("review", {})

        if not review_data:
            logger.warning(f"No review data in webhook payload for event: {event_type}")
            return []

        # Handle deletion events
        if event_type == "service-review-deleted":
            return [{
                "id": review_data.get("id", ""),
                "text": "",
                "channel": "review",
                "created_at": review_data.get("createdAt", ""),
                "is_deleted": True,
            }]

        # Handle create/update events
        return [{
            "id": review_data.get("id", ""),
            "text": review_data.get("text", ""),
            "rating": review_data.get("stars"),
            "created_at": review_data.get("createdAt", ""),
            "url": review_data.get("links", [{}])[0].get("href", ""),
            "channel": "review",
            "author": review_data.get("consumer", {}).get("displayName", ""),
            "title": review_data.get("title", ""),
            "is_update": event_type == "service-review-updated",
        }]


# Create webhook handler instance
webhook_handler = TrustpilotWebhook()


@require_webhook_signature("trustpilot", "X-Trustpilot-Signature")
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Lambda entry point with signature verification."""
    return webhook_handler.handle(event, context)
