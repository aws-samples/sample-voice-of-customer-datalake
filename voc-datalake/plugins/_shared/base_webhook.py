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
from shared.aws import clear_secret_cache, get_sqs_client, get_secret

from .audit import emit_audit_event
from .plugin_secrets import filter_plugin_secrets
from .sqs_utils import send_messages_to_queue

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
        """Load this plugin's secrets from the shared secret, prefix stripped.

        Same choke point as ``BaseIngestor._load_secrets`` — one implementation in
        ``_shared/plugin_secrets.py`` — so the webhook path cannot keep failing
        open after the ingestor path was fixed (issue #251). A webhook is the more
        exposed of the two: its Lambda is reachable from the internet with no
        Cognito authorizer in front of it.

        The identity comes from ``SOURCE_PLATFORM``, which ``createWebhookLambda``
        sets alongside ``PLUGIN_ID`` — it previously set only the latter, so this
        read saw ``''`` and every delivery would have died on a message about a
        malformed identity rather than the missing variable. Pinned by
        'SOURCE_PLATFORM' in ``lib/stacks/api-stack.test.ts``.
        """
        if not SECRETS_ARN:
            logger.warning("SECRETS_ARN not configured")
            return {}

        all_secrets = get_secret(SECRETS_ARN)
        if not all_secrets:
            # Evict the memoized empty payload before refusing on it — see the
            # same branch in `BaseIngestor._load_secrets` for why `get_secret`
            # caching a failed read would otherwise wedge the warm container. A
            # webhook has no manual "Run now" to clear the cache at all, so
            # without this the only recovery is a container recycle while the
            # provider's retries expire.
            clear_secret_cache()

        return filter_plugin_secrets(self.source_platform, all_secrets)

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

    def send_to_queue(self, items: list[dict]) -> int:
        """Send items to SQS processing queue.

        Delegates to the shared helper which checks the ``Failed`` list in every
        batch response, retries transient errors, and raises ``RuntimeError`` if
        any items cannot be enqueued — ensuring callers cannot silently lose
        feedback.  It also reconciles ``Successful`` + ``Failed`` against the
        submitted entries so an unaccounted entry is reported rather than
        dropped.  The ``WebhookItemsIngested`` metric reflects the actual
        enqueued count, not the attempted count.

        Returns:
            The number of items that SQS confirmed as enqueued.

        Note — partial-failure duplicate-delivery trade-off:
            If the helper raises ``RuntimeError`` after a partial success (some
            items were already enqueued before the failure occurred), ``handle()``
            catches it and returns HTTP 500.  Most webhook providers treat 500 as
            transient and re-deliver the *entire* original payload, so items that
            were already successfully enqueued will be sent a second time.  This
            PR chooses "duplicate over loss" as the safer trade-off; the
            downstream processor deduplicates on ``id`` via
            ``check_duplicate`` / ``@idempotent_function`` when
            ``IDEMPOTENCY_TABLE`` is configured.  Ensure ``IDEMPOTENCY_TABLE`` is
            set in all production deployments to prevent double-processing.
        """
        return send_messages_to_queue(
            self._sqs,
            PROCESSING_QUEUE_URL,
            items,
            metric_name="WebhookItemsIngested",
            log_label="webhook",
        )

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
            # Use the confirmed-enqueued count, not the attempted count, so the
            # audit event and HTTP response never report items SQS did not
            # acknowledge (mirrors BaseIngestor.run()).
            enqueued = self.send_to_queue(normalized_items)

            emit_audit_event("webhook.received", self.source_platform, True, {
                "items_processed": enqueued,
                "ip_address": client_ip,
            })

            return {
                "statusCode": 200,
                "body": json.dumps({
                    "status": "ok",
                    "items_processed": enqueued,
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
