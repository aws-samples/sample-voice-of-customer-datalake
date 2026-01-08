"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered automatically by S3 events when files are uploaded.
Folder name becomes the source name: {source_name}/file.csv -> source = "S3 - {source_name}"
"""

import json
import csv
import io
import boto3
import urllib.parse
from datetime import datetime, timezone
from typing import Generator
import sys
import os

# Add plugin shared modules to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics

s3_client = boto3.client("s3")


class S3ImportIngestor(BaseIngestor):
    """Ingestor for importing feedback from S3 files."""

    def __init__(self, bucket: str = None, key: str = None):
        super().__init__()
        # Can be triggered by S3 event (bucket/key provided) or scheduled (uses secrets config)
        self.event_bucket = bucket
        self.event_key = key
        self.import_bucket = bucket or self.secrets.get("bucket_name", "")
        self.processed_prefix = self.secrets.get("processed_prefix", "processed/")

    def _get_source_from_key(self, key: str) -> str:
        """Extract source name from S3 key. Folder name becomes source."""
        parts = key.split("/")
        if len(parts) > 1 and parts[0] != "processed":
            return f"S3 - {parts[0]}"
        return "S3 - Import"

    def _parse_csv(self, content: str, source_name: str) -> Generator[dict, None, None]:
        """Parse CSV content into feedback items."""
        reader = csv.DictReader(io.StringIO(content))
        for row in reader:
            yield {
                "id": row.get("id") or f"s3-{hash(row.get('text', '')[:100])}",
                "channel": row.get("channel", row.get("source", "csv_import")),
                "url": row.get("url", ""),
                "text": row.get("text", row.get("content", row.get("feedback", ""))),
                "rating": self._parse_rating(row.get("rating")),
                "created_at": row.get(
                    "created_at", row.get("date", row.get("timestamp", ""))
                ),
                "author": row.get("author", row.get("user", "")),
                "source_platform_override": source_name,
            }

    def _parse_json(
        self, content: str, source_name: str
    ) -> Generator[dict, None, None]:
        """Parse JSON/JSONL content into feedback items."""
        lines = content.strip().split("\n")
        if len(lines) > 1 and lines[0].strip().startswith("{"):
            for line in lines:
                if line.strip():
                    try:
                        item = json.loads(line)
                        yield self._normalize_json_item(item, source_name)
                    except json.JSONDecodeError:
                        continue
        else:
            data = json.loads(content)
            items = data if isinstance(data, list) else [data]
            for item in items:
                yield self._normalize_json_item(item, source_name)

    def _normalize_json_item(self, item: dict, source_name: str) -> dict:
        """Normalize a JSON item to expected format."""
        return {
            "id": item.get("id") or f"s3-{hash(str(item)[:100])}",
            "channel": item.get("channel", item.get("source", "json_import")),
            "url": item.get("url", ""),
            "text": item.get(
                "text",
                item.get("content", item.get("feedback", item.get("review", ""))),
            ),
            "rating": self._parse_rating(item.get("rating", item.get("score"))),
            "created_at": item.get(
                "created_at", item.get("date", item.get("timestamp", ""))
            ),
            "author": item.get("author", item.get("user", item.get("username", ""))),
            "source_platform_override": source_name,
        }

    def _parse_rating(self, value) -> float | None:
        """Parse rating value to float."""
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None

    def _move_to_processed(self, bucket: str, key: str):
        """Move processed file to processed prefix."""
        try:
            filename = key.split("/")[-1]
            source_folder = key.split("/")[0] if "/" in key else "default"
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            new_key = f"{self.processed_prefix}{source_folder}/{timestamp}_{filename}"

            s3_client.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": key},
                Key=new_key,
            )
            s3_client.delete_object(Bucket=bucket, Key=key)
            logger.info(f"Moved {key} to {new_key}")
        except Exception as e:
            logger.error(f"Failed to move file {key}: {e}")

    def _process_file(self, bucket: str, key: str) -> int:
        """Process a single S3 file and return item count."""
        if key.startswith(self.processed_prefix):
            logger.info(f"Skipping already processed file: {key}")
            return 0

        source_name = self._get_source_from_key(key)
        logger.info(f"Processing file: {key} as source: {source_name}")

        items = []
        try:
            response = s3_client.get_object(Bucket=bucket, Key=key)
            content = response["Body"].read().decode("utf-8")

            if key.endswith(".csv"):
                for item in self._parse_csv(content, source_name):
                    normalized = self.normalize_item(item)
                    items.append(normalized)
            elif key.endswith((".json", ".jsonl")):
                for item in self._parse_json(content, source_name):
                    normalized = self.normalize_item(item)
                    items.append(normalized)

            if items:
                self.send_to_queue(items)

            self._move_to_processed(bucket, key)
            metrics.add_metric(name="FilesProcessed", unit="Count", value=1)
            metrics.add_metric(name="ItemsImported", unit="Count", value=len(items))

            return len(items)
        except Exception as e:
            logger.error(f"Failed to process file {key}: {e}")
            metrics.add_metric(name="FileErrors", unit="Count", value=1)
            return 0

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Not used for S3 import - we process files directly."""
        return
        yield  # Make this a generator

    def run_for_event(self, bucket: str, key: str) -> dict:
        """Process a single file from S3 event."""
        count = self._process_file(bucket, key)
        return {"status": "success", "items_processed": count, "file": key}

    def run_scheduled(self) -> dict:
        """Scan bucket for unprocessed files (fallback for missed events)."""
        if not self.import_bucket:
            logger.warning("S3 import bucket not configured")
            return {"status": "skipped", "reason": "no bucket configured"}

        total_items = 0
        files_processed = 0

        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.import_bucket):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.startswith(self.processed_prefix):
                    continue
                if key.endswith((".csv", ".json", ".jsonl")):
                    count = self._process_file(self.import_bucket, key)
                    total_items += count
                    files_processed += 1

        return {
            "status": "success",
            "files_processed": files_processed,
            "items_processed": total_items,
        }


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Handle both S3 events and scheduled invocations."""

    # Check if this is an S3 event
    if "Records" in event and event["Records"]:
        record = event["Records"][0]
        if record.get("eventSource") == "aws:s3":
            bucket = record["s3"]["bucket"]["name"]
            key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

            logger.info(f"S3 event triggered for: s3://{bucket}/{key}")
            ingestor = S3ImportIngestor(bucket=bucket, key=key)
            return ingestor.run_for_event(bucket, key)

    # Scheduled invocation - scan for any missed files
    ingestor = S3ImportIngestor()
    return ingestor.run_scheduled()
