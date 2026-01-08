"""
Base Webhook Handler - Common functionality for webhook-based data ingestion.
"""

import json
import os
import sys
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_sqs_client, get_secret

from .audit import emit_audit_event

__all__ = ["BaseWebhook", "logger", "tracer", "metrics"]

# Configuration from environment
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
BRAND_NAME = os.environ.get("BRAND_NAME", "")
SOURCE_PLATFORM = os.environ.get("SOURCE_PLATFORM", "")


class BaseWebhook(ABC):
    """Base class for webhook handlers."""

    def __init__(self):
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.secrets = self._load_secrets()
        self._sqs = get_sqs_client()

    def _load_secrets(self) -> dict:
        """Load secrets from Secrets Manager with plugin prefix filtering."""
        if not SECRETS_ARN:
            logger.warning("SECRETS_ARN not configured")
            return {}
        
        all_secrets = get_secret(SECRETS_ARN)
        
        # Filter to only keys prefixed with this plugin's ID
        prefix = f"{self.source_platform}_"
        filtered = {}
        for key, value in all_secrets.items():
            if key.startswith(prefix):
                clean_key = key[len(prefix):]
                filtered[clean_key] = value
        
        return filtered if filtered else all_secrets

    @abstractmethod
    def parse_webhook_payload(self, body: dict, headers: dict) -> list[dict]:
        """
        Parse the webhook payload and return a list of items to process.
        
        Must be implemented by subclasses.
        
        Args:
            body: The parsed JSON body of the webhook request
            headers: The request headers
            
        Returns:
            List of normalized items ready for the processing queue
        """
        pass

    def normalize_item(self, item: dict) -> dict:
        """Normalize item to common schema."""
        return {
            "id": item.get("id", ""),
            "source_platform": self.source_platform,
            "source_channel": item.get("channel", "webhook"),
            "url": item.get("url", ""),
            "text": item.get("text", ""),
            "rating": item.get("rating"),
            "created_at": item.get(
                "created_at", datetime.now(timezone.utc).isoformat()
            ),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
            "brand_name": self.brand_name,
            "brand_handles_matched": item.get("brand_handles_matched", []),
            "is_webhook": True,
            "raw_data": item,
        }

    def send_to_queue(self, items: list[dict]):
        """Send items to SQS processing queue."""
        if not items:
            return

        for i in range(0, len(items), 10):
            batch = items[i : i + 10]
            entries = [
                {"Id": str(idx), "MessageBody": json.dumps(item, default=str)}
                for idx, item in enumerate(batch)
            ]

            self._sqs.send_message_batch(QueueUrl=PROCESSING_QUEUE_URL, Entries=entries)

        logger.info(f"Sent {len(items)} webhook items to processing queue")
        metrics.add_metric(name="WebhookItemsIngested", unit="Count", value=len(items))

    def _extract_client_ip(self, event: dict) -> str:
        """Extract client IP from API Gateway event."""
        request_context = event.get("requestContext", {})
        identity = request_context.get("identity", {})
        return identity.get("sourceIp", "unknown")

    @tracer.capture_method
    def handle(self, event: dict, context: Any) -> dict:
        """
        Main webhook handler method.
        
        This should be called from the Lambda handler after signature verification.
        """
        client_ip = self._extract_client_ip(event)
        
        emit_audit_event("webhook.received", self.source_platform, True, {
            "ip_address": client_ip,
        })

        try:
            # Parse body
            body = event.get("body", "{}")
            if event.get("isBase64Encoded"):
                import base64
                body = base64.b64decode(body).decode("utf-8")
            
            if isinstance(body, str):
                body = json.loads(body)

            headers = event.get("headers", {})

            # Parse webhook payload
            items = self.parse_webhook_payload(body, headers)
            
            if not items:
                logger.info("No items to process from webhook")
                return {
                    "statusCode": 200,
                    "body": json.dumps({"status": "ok", "items_processed": 0}),
                }

            # Normalize and send to queue
            normalized_items = [self.normalize_item(item) for item in items]
            self.send_to_queue(normalized_items)

            emit_audit_event("webhook.received", self.source_platform, True, {
                "items_processed": len(normalized_items),
                "ip_address": client_ip,
            })

            return {
                "statusCode": 200,
                "body": json.dumps({
                    "status": "ok",
                    "items_processed": len(normalized_items),
                }),
            }

        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in webhook body: {e}")
            emit_audit_event("webhook.rejected", self.source_platform, False, {
                "reason": "invalid_json",
                "ip_address": client_ip,
            })
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Invalid JSON"}),
            }
        except Exception as e:
            logger.exception(f"Webhook processing failed: {e}")
            metrics.add_metric(name="WebhookErrors", unit="Count", value=1)
            emit_audit_event("webhook.rejected", self.source_platform, False, {
                "reason": str(e),
                "ip_address": client_ip,
            })
            return {
                "statusCode": 500,
                "body": json.dumps({"error": "Internal server error"}),
            }
