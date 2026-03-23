"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered automatically by S3 events when files are uploaded.
Folder name becomes the source name: {source_name}/file.csv -> source = "S3 - {source_name}"
"""

import json
import csv
import io
import hashlib
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

# File size limit: 50 MB. Lambda has 512 MB memory; streaming keeps usage low,
# but we still cap to avoid 15-min timeout on very large files.
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

# Batch size for sending items to SQS
BATCH_SIZE = 100

# Aliases for common CSV/JSON column names that map to our canonical fields
FIELD_ALIASES: dict[str, list[str]] = {
    "text": ["text", "content", "feedback", "comment", "review", "message", "body"],
    "rating": ["rating", "score", "stars"],
    "created_at": ["created_at", "date", "timestamp", "time", "created"],
    "author": ["author", "user", "username", "name", "reviewer"],
    "channel": ["channel", "source", "platform", "type"],
    "url": ["url", "link", "href"],
    "id": ["id", "review_id", "feedback_id", "item_id"],
}


def _resolve_field(row: dict, canonical: str, default: str = "") -> str:
    """Resolve a field value by trying canonical name then aliases."""
    for alias in FIELD_ALIASES.get(canonical, [canonical]):
        value = row.get(alias)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def _generate_deterministic_id(text: str) -> str:
    """Generate a deterministic ID from text content using SHA-256."""
    content = text[:200] if text else ""
    return f"s3-{hashlib.sha256(content.encode(), usedforsecurity=False).hexdigest()[:16]}"


class S3ImportIngestor(BaseIngestor):
    """Ingestor for importing feedback from S3 files."""

    def __init__(self, bucket: str = None, key: str = None):
        super().__init__()
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

    def _validate_csv_headers(self, fieldnames: list[str] | None) -> tuple[bool, str]:
        """Validate that CSV has at least a text-like column."""
        if not fieldnames:
            return False, "CSV file has no headers"

        headers = {h.strip().lower() for h in fieldnames}
        text_aliases = {a.lower() for a in FIELD_ALIASES["text"]}

        if not headers.intersection(text_aliases):
            return False, (
                f"CSV missing a text column. Expected one of: {', '.join(sorted(text_aliases))}. "
                f"Found columns: {', '.join(sorted(headers))}"
            )
        return True, ""

    def _parse_csv_stream(
        self, stream, source_name: str
    ) -> Generator[dict, None, None]:
        """Parse CSV content from a stream, yielding items row by row."""
        text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
        reader = csv.DictReader(text_wrapper)

        valid, error_msg = self._validate_csv_headers(reader.fieldnames)
        if not valid:
            logger.error(error_msg)
            metrics.add_metric(name="SchemaValidationErrors", unit="Count", value=1)
            return

        for row_num, row in enumerate(reader, start=2):
            try:
                text = _resolve_field(row, "text")
                if not text:
                    logger.warning(f"Row {row_num}: empty text field, skipping")
                    metrics.add_metric(name="RowsSkippedEmpty", unit="Count", value=1)
                    continue

                yield {
                    "id": _resolve_field(row, "id") or _generate_deterministic_id(text),
                    "channel": _resolve_field(row, "channel", "csv_import"),
                    "url": _resolve_field(row, "url"),
                    "text": text,
                    "rating": self._parse_rating(_resolve_field(row, "rating", None)),
                    "created_at": _resolve_field(row, "created_at"),
                    "author": _resolve_field(row, "author"),
                    "source_platform_override": source_name,
                }
            except Exception as e:
                logger.warning(f"Row {row_num}: parse error: {e}")
                metrics.add_metric(name="RowParseErrors", unit="Count", value=1)
                continue

    def _parse_json_stream(
        self, stream, key: str, source_name: str
    ) -> Generator[dict, None, None]:
        """Parse JSON or JSONL content from a stream."""
        if key.endswith(".jsonl"):
            yield from self._parse_jsonl_stream(stream, source_name)
        else:
            yield from self._parse_json_content(stream, source_name)

    def _parse_jsonl_stream(
        self, stream, source_name: str
    ) -> Generator[dict, None, None]:
        """Parse JSONL (one JSON object per line) from a stream."""
        text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
        for line_num, line in enumerate(text_wrapper, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                normalized = self._normalize_json_item(item, source_name)
                if not normalized.get("text"):
                    logger.warning(f"JSONL line {line_num}: empty text, skipping")
                    metrics.add_metric(name="RowsSkippedEmpty", unit="Count", value=1)
                    continue
                yield normalized
            except json.JSONDecodeError as e:
                logger.warning(f"JSONL line {line_num}: invalid JSON: {e}")
                metrics.add_metric(name="RowParseErrors", unit="Count", value=1)
                continue
            except Exception as e:
                logger.warning(f"JSONL line {line_num}: parse error: {e}")
                metrics.add_metric(name="RowParseErrors", unit="Count", value=1)
                continue

    def _parse_json_content(
        self, stream, source_name: str
    ) -> Generator[dict, None, None]:
        """Parse a JSON array or single object from a stream."""
        try:
            raw = stream.read()
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON file: {e}")
            metrics.add_metric(name="FileParseErrors", unit="Count", value=1)
            return

        items = data if isinstance(data, list) else [data]
        for idx, item in enumerate(items):
            try:
                normalized = self._normalize_json_item(item, source_name)
                if not normalized.get("text"):
                    logger.warning(f"JSON item {idx}: empty text, skipping")
                    metrics.add_metric(name="RowsSkippedEmpty", unit="Count", value=1)
                    continue
                yield normalized
            except Exception as e:
                logger.warning(f"JSON item {idx}: parse error: {e}")
                metrics.add_metric(name="RowParseErrors", unit="Count", value=1)
                continue

    def _normalize_json_item(self, item: dict, source_name: str) -> dict:
        """Normalize a JSON item to expected format."""
        text = _resolve_field(item, "text")
        return {
            "id": _resolve_field(item, "id") or _generate_deterministic_id(text),
            "channel": _resolve_field(item, "channel", "json_import"),
            "url": _resolve_field(item, "url"),
            "text": text,
            "rating": self._parse_rating(
                _resolve_field(item, "rating", None)
            ),
            "created_at": _resolve_field(item, "created_at"),
            "author": _resolve_field(item, "author"),
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

    def _move_to_error(self, bucket: str, key: str, error_msg: str):
        """Move a file that failed processing to an error prefix."""
        try:
            filename = key.split("/")[-1]
            source_folder = key.split("/")[0] if "/" in key else "default"
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            new_key = f"error/{source_folder}/{timestamp}_{filename}"

            s3_client.copy_object(
                Bucket=bucket,
                CopySource={"Bucket": bucket, "Key": key},
                Key=new_key,
            )
            s3_client.delete_object(Bucket=bucket, Key=key)
            logger.info(f"Moved failed file {key} to {new_key} (reason: {error_msg})")
        except Exception as e:
            logger.error(f"Failed to move error file {key}: {e}")

    def _acquire_file_lock(self, bucket: str, key: str) -> bool:
        """Try to acquire a processing lock for a file using DynamoDB conditional write."""
        import time

        try:
            self.watermarks_table.put_item(
                Item={
                    "source": f"s3_import_lock#{bucket}#{key}",
                    "value": "locked",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "ttl": int(time.time()) + 600,  # 10-minute TTL
                },
                ConditionExpression="attribute_not_exists(#src)",
                ExpressionAttributeNames={"#src": "source"},
            )
            return True
        except Exception as e:
            error_code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
            if error_code == "ConditionalCheckFailedException":
                logger.info(f"File {key} already being processed (lock held)")
                return False
            # For other errors, log but allow processing to proceed
            logger.warning(f"Lock acquisition error for {key}: {e}")
            return True

    def _release_file_lock(self, bucket: str, key: str):
        """Release the processing lock for a file."""
        try:
            self.watermarks_table.delete_item(
                Key={"source": f"s3_import_lock#{bucket}#{key}"}
            )
        except Exception as e:
            logger.warning(f"Failed to release lock for {key}: {e}")

    def _process_file(self, bucket: str, key: str) -> int:
        """Process a single S3 file with streaming, batching, and row-level error handling."""
        if key.startswith(self.processed_prefix) or key.startswith("error/"):
            logger.info(f"Skipping non-pending file: {key}")
            return 0

        # Acquire distributed lock to prevent duplicate processing
        if not self._acquire_file_lock(bucket, key):
            return 0

        source_name = self._get_source_from_key(key)
        logger.info(f"Processing file: {key} as source: {source_name}")

        try:
            # Check file size before downloading
            head = s3_client.head_object(Bucket=bucket, Key=key)
            file_size = head["ContentLength"]

            if file_size > MAX_FILE_SIZE_BYTES:
                size_mb = file_size / (1024 * 1024)
                limit_mb = MAX_FILE_SIZE_BYTES / (1024 * 1024)
                error_msg = f"File too large: {size_mb:.1f} MB (limit: {limit_mb:.0f} MB)"
                logger.error(f"{key}: {error_msg}")
                metrics.add_metric(name="FileTooLarge", unit="Count", value=1)
                self._move_to_error(bucket, key, error_msg)
                return 0

            if file_size == 0:
                logger.warning(f"{key}: empty file, skipping")
                self._move_to_error(bucket, key, "Empty file")
                return 0

            # Stream the file content
            response = s3_client.get_object(Bucket=bucket, Key=key)
            stream = response["Body"]

            # Parse and send in batches
            batch: list[dict] = []
            total_count = 0

            if key.endswith(".csv"):
                item_iter = self._parse_csv_stream(stream, source_name)
            elif key.endswith((".json", ".jsonl")):
                item_iter = self._parse_json_stream(stream, key, source_name)
            else:
                logger.warning(f"Unsupported file type: {key}")
                return 0

            for item in item_iter:
                normalized = self.normalize_item(item)
                batch.append(normalized)

                if len(batch) >= BATCH_SIZE:
                    self.send_to_queue(batch)
                    total_count += len(batch)
                    batch = []

            # Send remaining items
            if batch:
                self.send_to_queue(batch)
                total_count += len(batch)

            if total_count == 0:
                logger.warning(f"{key}: no valid items found")
                metrics.add_metric(name="FilesEmpty", unit="Count", value=1)
            else:
                metrics.add_metric(name="FilesProcessed", unit="Count", value=1)
                metrics.add_metric(name="ItemsImported", unit="Count", value=total_count)

            self._move_to_processed(bucket, key)
            return total_count

        except Exception as e:
            logger.error(f"Failed to process file {key}: {e}")
            metrics.add_metric(name="FileErrors", unit="Count", value=1)
            # Don't move to processed on error — leave for retry or manual inspection
            return 0
        finally:
            self._release_file_lock(bucket, key)

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
                if key.startswith(self.processed_prefix) or key.startswith("error/"):
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
        results = []
        for record in event["Records"]:
            if record.get("eventSource") == "aws:s3":
                bucket = record["s3"]["bucket"]["name"]
                key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

                logger.info(f"S3 event triggered for: s3://{bucket}/{key}")
                ingestor = S3ImportIngestor(bucket=bucket, key=key)
                result = ingestor.run_for_event(bucket, key)
                results.append(result)

        total = sum(r.get("items_processed", 0) for r in results)
        return {
            "status": "success",
            "files_processed": len(results),
            "items_processed": total,
            "results": results,
        }

    # Scheduled invocation - scan for any missed files
    ingestor = S3ImportIngestor()
    return ingestor.run_scheduled()
