"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered by S3 events when files are uploaded.
Folder name becomes the source: {folder}/file.csv -> source = "S3 - {folder}"
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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics

s3_client = boto3.client("s3")

MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024

# Maps canonical field names to common aliases found in CSV/JSON files
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
    """Generate a deterministic ID from text content."""
    content = text[:200] if text else ""
    return f"s3-{hashlib.sha256(content.encode(), usedforsecurity=False).hexdigest()[:16]}"


def _parse_rating(value) -> float | None:
    """Parse rating value to float, returning None for invalid values."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _get_source_from_key(key: str) -> str:
    """Extract source name from S3 key. Folder name becomes source."""
    parts = key.split("/")
    if len(parts) > 1:
        return f"S3 - {parts[0]}"
    return "S3 - Import"


def _normalize_row(row: dict, source_name: str, default_channel: str = "import") -> dict | None:
    """Normalize a row (from CSV or JSON) into the expected item format. Returns None if no text."""
    text = _resolve_field(row, "text")
    if not text:
        return None
    return {
        "id": _resolve_field(row, "id") or _generate_deterministic_id(text),
        "channel": _resolve_field(row, "channel", default_channel),
        "url": _resolve_field(row, "url"),
        "text": text,
        "rating": _parse_rating(_resolve_field(row, "rating", None)),
        "created_at": _resolve_field(row, "created_at"),
        "author": _resolve_field(row, "author"),
        "source_platform_override": source_name,
    }


def _parse_csv(stream, source_name: str) -> Generator[dict, None, None]:
    """Parse CSV content, yielding normalized items."""
    text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    reader = csv.DictReader(text_wrapper)

    if not reader.fieldnames:
        logger.error("CSV file has no headers")
        return

    headers = {h.strip().lower() for h in reader.fieldnames}
    text_aliases = {a.lower() for a in FIELD_ALIASES["text"]}
    if not headers.intersection(text_aliases):
        logger.error(f"CSV missing text column. Expected one of: {sorted(text_aliases)}. Found: {sorted(headers)}")
        return

    for row_num, row in enumerate(reader, start=2):
        try:
            item = _normalize_row(row, source_name, "csv_import")
            if item:
                yield item
            else:
                logger.debug(f"Row {row_num}: empty text, skipping")
        except Exception as e:
            logger.warning(f"Row {row_num}: parse error: {e}")


def _parse_jsonl(stream, source_name: str) -> Generator[dict, None, None]:
    """Parse JSONL (one JSON object per line)."""
    text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    for line_num, line in enumerate(text_wrapper, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            item = _normalize_row(row, source_name, "json_import")
            if item:
                yield item
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"JSONL line {line_num}: {e}")


def _parse_json(stream, source_name: str) -> Generator[dict, None, None]:
    """Parse a JSON array or single object."""
    try:
        data = json.loads(stream.read())
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON: {e}")
        return

    items = data if isinstance(data, list) else [data]
    for idx, row in enumerate(items):
        try:
            item = _normalize_row(row, source_name, "json_import")
            if item:
                yield item
        except Exception as e:
            logger.warning(f"JSON item {idx}: {e}")


def _get_parser(key: str):
    """Return the appropriate parser function for a file extension, or None."""
    if key.endswith(".csv"):
        return _parse_csv
    if key.endswith(".jsonl"):
        return _parse_jsonl
    if key.endswith(".json"):
        return _parse_json
    return None


class S3ImportIngestor(BaseIngestor):
    """Ingestor for importing feedback from S3 files."""

    def __init__(self):
        super().__init__()

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Not used — S3 import processes files directly via process_file."""
        return
        yield

    def process_file(self, bucket: str, key: str) -> int:
        """Process a single S3 file: validate, parse, normalize, and queue."""
        parser = _get_parser(key)
        if not parser:
            logger.warning(f"Unsupported file type: {key}")
            return 0

        # Validate file size
        head = s3_client.head_object(Bucket=bucket, Key=key)
        file_size = head["ContentLength"]

        if file_size == 0:
            logger.warning(f"{key}: empty file, skipping")
            return 0

        if file_size > MAX_FILE_SIZE_BYTES:
            logger.error(f"{key}: {file_size / 1024 / 1024:.1f} MB exceeds {MAX_FILE_SIZE_BYTES / 1024 / 1024:.0f} MB limit")
            return 0

        # Stream, parse, normalize, and send in batches
        source_name = _get_source_from_key(key)
        response = s3_client.get_object(Bucket=bucket, Key=key)
        stream = response["Body"]

        batch: list[dict] = []
        total = 0

        for item in parser(stream, source_name):
            normalized = self.normalize_item(item)
            batch.append(normalized)
            if len(batch) >= 100:
                self.send_to_queue(batch)
                total += len(batch)
                batch = []

        if batch:
            self.send_to_queue(batch)
            total += len(batch)

        logger.info(f"Processed {key}: {total} items")
        metrics.add_metric(name="ItemsImported", unit="Count", value=total)
        return total


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Handle S3 event notifications."""
    if "Records" not in event or not event["Records"]:
        logger.info("No S3 records in event, nothing to do")
        return {"status": "skipped", "reason": "no records"}

    ingestor = S3ImportIngestor()
    results = []

    for record in event["Records"]:
        if record.get("eventSource") != "aws:s3":
            continue
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        logger.info(f"Processing s3://{bucket}/{key}")

        count = ingestor.process_file(bucket, key)
        results.append({"file": key, "items_processed": count})

    total = sum(r["items_processed"] for r in results)
    return {
        "status": "success",
        "files_processed": len(results),
        "items_processed": total,
        "results": results,
    }
