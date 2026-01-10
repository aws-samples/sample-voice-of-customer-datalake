"""
Base Ingestor - Common functionality for all VoC data source ingestors.
Uses DynamoDB for watermarks and SQS for processing queue.

This is the plugin version that supports per-plugin secrets isolation.
"""

import json
import os
import sys
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Generator
import hashlib

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.http import fetch_with_retry
from shared.aws import (
    get_dynamodb_resource,
    get_s3_client,
    get_sqs_client,
    get_secret,
)
from .circuit_breaker import CircuitBreaker
from .audit import emit_audit_event

# Re-export for backwards compatibility with existing handlers
__all__ = ["BaseIngestor", "logger", "tracer", "metrics", "fetch_with_retry"]

# Configuration from environment
WATERMARKS_TABLE = os.environ.get("WATERMARKS_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
BRAND_NAME = os.environ.get("BRAND_NAME", "")
BRAND_HANDLES = json.loads(os.environ.get("BRAND_HANDLES", "[]"))
SOURCE_PLATFORM = os.environ.get("SOURCE_PLATFORM", "")


class BaseIngestor(ABC):
    """Base class for all data source ingestors."""

    def __init__(self):
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.brand_handles = BRAND_HANDLES
        self.secrets = self._load_secrets()
        self.watermarks_table = get_dynamodb_resource().Table(WATERMARKS_TABLE)
        self._s3 = get_s3_client()
        self._sqs = get_sqs_client()
        self.circuit_breaker = CircuitBreaker(self.source_platform)

    def _load_secrets(self) -> dict:
        """
        Load API credentials from Secrets Manager.
        
        With per-plugin secrets isolation, each plugin has its own secret.
        The secret keys are prefixed with the plugin ID, which we strip here.
        """
        if not SECRETS_ARN:
            logger.warning("SECRETS_ARN not configured")
            return {}
        
        all_secrets = get_secret(SECRETS_ARN)
        
        # Filter to only keys prefixed with this plugin's ID
        prefix = f"{self.source_platform}_"
        filtered = {}
        for key, value in all_secrets.items():
            if key.startswith(prefix):
                # Strip the prefix for cleaner access
                clean_key = key[len(prefix):]
                filtered[clean_key] = value
            elif not any(key.startswith(f"{p}_") for p in self._get_known_prefixes()):
                # Include keys without any known prefix (legacy/shared keys)
                filtered[key] = value
        
        return filtered if filtered else all_secrets

    def _get_known_prefixes(self) -> list[str]:
        """Get list of known plugin prefixes for secret filtering."""
        # This could be loaded from environment or manifest
        return [
            "trustpilot", "yelp", "google_reviews", "twitter", "instagram",
            "facebook", "reddit", "tavily", "appstore_apple", "appstore_google",
            "appstore_huawei", "webscraper", "youtube", "tiktok", "linkedin",
            "s3_import", "manual_import"
        ]

    def get_watermark(self, key: str, default: str = None) -> str:
        """Get watermark for a specific source/key from DynamoDB."""
        try:
            response = self.watermarks_table.get_item(
                Key={"source": f"{self.source_platform}#{key}"}
            )
            return response.get("Item", {}).get("value", default)
        except Exception as e:
            logger.warning(f"Failed to get watermark: {e}")
            return default

    def set_watermark(self, key: str, value: str):
        """Set watermark for a specific source/key in DynamoDB."""
        try:
            self.watermarks_table.put_item(
                Item={
                    "source": f"{self.source_platform}#{key}",
                    "value": value,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        except Exception as e:
            logger.error(f"Failed to save watermark: {e}")

    @abstractmethod
    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Fetch new items from the data source. Must be implemented by subclasses."""
        pass

    def _generate_deterministic_id(self, item: dict) -> str:
        """
        Generate a deterministic ID for S3 filename to prevent duplicates.
        
        Uses the same logic as processor deduplication:
        1. source_id if available (most reliable)
        2. hash of created_at + text + url (fallback for scraped content)
        """
        source_id = item.get("id", "")
        if source_id:
            # Sanitize source_id for use as filename (remove special chars)
            safe_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(source_id))
            return safe_id[:64]  # Limit length
        
        # Fallback: generate from content signature
        text = item.get("text", "")
        created_at = item.get("created_at", "")
        url = item.get("url", "")
        
        text_hash = hashlib.md5(text[:500].encode()).hexdigest()[:16] if text else ""
        content = f"{created_at}:{text_hash}:{url}"
        return hashlib.sha256(content.encode()).hexdigest()[:32]

    def store_raw_to_s3(self, item: dict, raw_content: str = None) -> str | None:
        """Store raw data to S3 with partitioned structure."""
        if not RAW_DATA_BUCKET:
            logger.warning("RAW_DATA_BUCKET not configured, skipping S3 storage")
            return None

        try:
            now = datetime.now(timezone.utc)
            source_platform = (
                item.get("source_platform_override") or self.source_platform
            )
            
            item_id = self._generate_deterministic_id(item)

            # Use review's created_at date for partitioning
            created_at = item.get("created_at")
            if created_at:
                try:
                    if isinstance(created_at, str):
                        date_str = created_at.replace('Z', '+00:00').replace(' ', 'T')
                        if 'T' in date_str and '+' not in date_str and '-' not in date_str.split('T')[1]:
                            date_str += '+00:00'
                        partition_date = datetime.fromisoformat(date_str)
                    else:
                        partition_date = now
                except (ValueError, TypeError) as e:
                    logger.debug(f"Could not parse created_at '{created_at}': {e}")
                    partition_date = now
            else:
                partition_date = now

            # Build S3 key - scoped to plugin prefix for isolation
            s3_key = f"raw/{source_platform}/{partition_date.year}/{partition_date.month:02d}/{partition_date.day:02d}/{item_id}.json"

            raw_payload = {
                "item_id": item_id,
                "source_platform": source_platform,
                "ingested_at": now.isoformat(),
                "partition_date": partition_date.strftime('%Y-%m-%d'),
                "raw_content": raw_content,
                "raw_item": item,
            }

            self._s3.put_object(
                Bucket=RAW_DATA_BUCKET,
                Key=s3_key,
                Body=json.dumps(raw_payload, default=str),
                ContentType="application/json",
            )

            logger.info(f"Stored raw data to s3://{RAW_DATA_BUCKET}/{s3_key}")
            return f"s3://{RAW_DATA_BUCKET}/{s3_key}"
        except Exception as e:
            logger.error(f"Failed to store raw data to S3: {e}")
            return None

    def normalize_item(self, item: dict, raw_content: str = None) -> dict:
        """Normalize item to common raw schema and store raw data to S3."""
        source_platform = (
            item.get("source_platform_override") or self.source_platform
        )

        s3_raw_uri = self.store_raw_to_s3(item, raw_content)

        return {
            "id": item.get("id", ""),
            "source_platform": source_platform,
            "source_channel": item.get("channel", "unknown"),
            "url": item.get("url", ""),
            "text": item.get("text", ""),
            "rating": item.get("rating"),
            "created_at": item.get(
                "created_at", datetime.now(timezone.utc).isoformat()
            ),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
            "brand_name": self.brand_name,
            "brand_handles_matched": item.get("brand_handles_matched", []),
            "s3_raw_uri": s3_raw_uri,
            "raw_data": item if not s3_raw_uri else None,
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

        logger.info(f"Sent {len(items)} items to processing queue")
        metrics.add_metric(name="ItemsIngested", unit="Count", value=len(items))

    @tracer.capture_method
    def run(self) -> dict:
        """Main execution method with circuit breaker support."""
        # Check circuit breaker before running
        if self.circuit_breaker.is_open():
            logger.warning(f"Circuit breaker open for {self.source_platform}, skipping")
            return {"status": "skipped", "reason": "circuit_breaker_open"}

        emit_audit_event("plugin.invoked", self.source_platform, True)
        
        items = []
        last_id = None
        total_processed = 0

        try:
            for item in self.fetch_new_items():
                normalized = self.normalize_item(item)
                items.append(normalized)
                last_id = item.get("id")

                emit_audit_event("message.ingested", self.source_platform, True, {
                    "message_id": item.get("id"),
                })

                # Batch send every 100 items
                if len(items) >= 100:
                    self.send_to_queue(items)
                    total_processed += len(items)
                    items = []

            # Send remaining items
            if items:
                self.send_to_queue(items)
                total_processed += len(items)

            # Update watermark
            if last_id:
                self.set_watermark("last_id", str(last_id))

            # Record success
            self.circuit_breaker.record_success()
            
            emit_audit_event("plugin.completed", self.source_platform, True, {
                "items_processed": total_processed,
            })

            return {"status": "success", "items_processed": total_processed}

        except Exception as e:
            logger.exception(f"Ingestion failed: {e}")
            metrics.add_metric(name="IngestionErrors", unit="Count", value=1)
            
            # Record failure for circuit breaker
            self.circuit_breaker.record_failure(str(e))
            
            emit_audit_event("plugin.failed", self.source_platform, False, {
                "error": str(e),
                "error_type": type(e).__name__,
            })
            raise
