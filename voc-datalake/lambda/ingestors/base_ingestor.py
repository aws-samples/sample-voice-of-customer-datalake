"""
Base Ingestor - Common functionality for all VoC data source ingestors.
Uses DynamoDB for watermarks and SQS for processing queue.
"""

import json
import os
import sys
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Generator

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
        self.secrets = self._load_secrets()
        self.watermarks_table = get_dynamodb_resource().Table(WATERMARKS_TABLE)
        self.source_platform = SOURCE_PLATFORM
        self.brand_name = BRAND_NAME
        self.brand_handles = BRAND_HANDLES
        self._s3 = get_s3_client()
        self._sqs = get_sqs_client()

    def _load_secrets(self) -> dict:
        """Load API credentials from Secrets Manager."""
        if not SECRETS_ARN:
            logger.warning("SECRETS_ARN not configured")
            return {}
        return get_secret(SECRETS_ARN)

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
        import hashlib
        
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
        """Store raw data to S3 with partitioned structure: raw/{source}/{year}/{month}/{day}/{id}.json
        
        Uses the review's created_at date for partitioning (not scrape date) to ensure
        the same review scraped on different days lands in the same S3 path.
        
        Filename is deterministic based on source_id or content hash to prevent duplicates.
        """
        if not RAW_DATA_BUCKET:
            logger.warning("RAW_DATA_BUCKET not configured, skipping S3 storage")
            return None

        try:
            now = datetime.now(timezone.utc)
            source_platform = (
                item.get("source_platform_override") or self.source_platform
            )
            
            # Generate deterministic filename to prevent duplicates
            item_id = self._generate_deterministic_id(item)

            # Use review's created_at date for partitioning, fallback to ingestion time
            created_at = item.get("created_at")
            if created_at:
                try:
                    # Handle various date formats
                    if isinstance(created_at, str):
                        # Normalize ISO format variations
                        date_str = created_at.replace('Z', '+00:00').replace(' ', 'T')
                        if 'T' in date_str and '+' not in date_str and '-' not in date_str.split('T')[1]:
                            date_str += '+00:00'
                        partition_date = datetime.fromisoformat(date_str)
                    else:
                        partition_date = now
                except (ValueError, TypeError) as e:
                    logger.debug(f"Could not parse created_at '{created_at}': {e}, using current time")
                    partition_date = now
            else:
                partition_date = now

            # Build S3 key with partitioned structure based on review date
            s3_key = f"raw/{source_platform}/{partition_date.year}/{partition_date.month:02d}/{partition_date.day:02d}/{item_id}.json"

            # Prepare raw data payload
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
        # Allow item to override source_platform (e.g., webscraper uses scraper name)
        source_platform = (
            item.get("source_platform_override") or self.source_platform
        )

        # Store raw data to S3 and get reference
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
            "raw_data": item
            if not s3_raw_uri
            else None,  # Only include raw_data if S3 storage failed
        }

    def send_to_queue(self, items: list[dict]):
        """Send items to SQS processing queue."""
        if not items:
            return

        # Send in batches of 10 (SQS limit)
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
        """Main execution method."""
        items = []
        last_id = None
        total_processed = 0

        try:
            for item in self.fetch_new_items():
                normalized = self.normalize_item(item)
                items.append(normalized)
                last_id = item.get("id")

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

            return {"status": "success", "items_processed": total_processed}

        except Exception as e:
            logger.exception(f"Ingestion failed: {e}")
            metrics.add_metric(name="IngestionErrors", unit="Count", value=1)
            raise
