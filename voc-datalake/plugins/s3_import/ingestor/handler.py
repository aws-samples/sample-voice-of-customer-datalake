"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered by S3 events when files are uploaded.
Folder name becomes the source: {folder}/file.csv -> source = "S3 - {folder}"
"""

import csv
import hashlib
import io
import json
import urllib.parse
from collections.abc import Generator

import boto3

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.invocation_cost import measure_invocation_cost
from shared.timestamps import now_iso

s3_client = boto3.client("s3")

MAX_FILE_SIZE_MB = 50
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
# Where an operator archives ingested files by hand (`processed/<folder>/<file>`).
PROCESSED_FOLDER = "processed"

# What normalizing one parsed row can raise: AttributeError for a JSON row that is
# not an object (no `.get`), TypeError/ValueError for a value of an unexpected
# shape. Every value is stringified before use, so nothing else is reachable.
_ROW_ERRORS = (AttributeError, TypeError, ValueError)

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


def _resolve_field(row: dict, canonical: str, default: str | None = "") -> str | None:
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
    """Parse rating value to float, returning None for invalid values (None and "" included)."""
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _get_source_from_key(key: str, *, reprocess: bool = False) -> str:
    """Extract source name from S3 key. Folder name becomes source.

    On a reprocess (`POST /s3-import/reprocess`, issue #144) a file archived as
    `processed/<folder>/<file>` keeps the source of its original upload,
    `S3 - <folder>`: the processor's duplicate check keys on that label, so naming
    it `S3 - processed` would import every row again as new data. An S3 trigger
    event keeps the plain folder rule.
    """
    parts = key.split("/")
    if reprocess and len(parts) > 2 and parts[0] == PROCESSED_FOLDER:
        parts = parts[1:]
    if len(parts) > 1:
        return f"S3 - {parts[0]}"
    return "S3 - Import"


def _normalize_row(row: dict, source_name: str, default_channel: str) -> dict | None:
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
        except _ROW_ERRORS as e:
            logger.warning(f"Row {row_num}: parse error: {e}")


def _parse_jsonl(stream, source_name: str) -> Generator[dict, None, None]:
    """Parse JSONL (one JSON object per line)."""
    text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    for line_num, raw_line in enumerate(text_wrapper, start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            item = _normalize_row(row, source_name, "json_import")
            if item:
                yield item
        except (*_ROW_ERRORS, RecursionError) as e:
            # ValueError covers json.JSONDecodeError; RecursionError is what
            # json.loads raises for a pathologically nested line.
            logger.warning(f"JSONL line {line_num}: {e}")


def _parse_json(stream, source_name: str) -> Generator[dict, None, None]:
    """Parse a JSON array or single object."""
    try:
        data = json.loads(stream.read())
    except json.JSONDecodeError as e:
        logger.exception(f"Invalid JSON: {e}")
        return

    items = data if isinstance(data, list) else [data]
    for idx, row in enumerate(items):
        try:
            item = _normalize_row(row, source_name, "json_import")
            if item:
                yield item
        except _ROW_ERRORS as e:
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
    """Ingestor for importing feedback from S3 files.

    *execution_id* is set on a run started by the API (`POST /s3-import/reprocess`,
    or `POST /sources/s3_import/run`); `record_run_started` / `record_run_finished`
    then move that run's `SOURCE_RUN#s3_import` row. An S3 trigger event has none,
    and no row is written.
    """

    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)

    def fetch_new_items(self) -> Generator[dict, None, None]:
        """Not used — S3 import processes files directly via process_file."""
        yield from ()

    def record_run_started(self) -> None:
        """Mark this run's row `running` (a no-op without an execution id)."""
        self._update_source_run_status({'status': 'running', 'items_found': 0, 'started_at': now_iso()})

    def record_run_finished(self, items_found: int, error: Exception | None = None) -> None:
        """Move this run's row to `completed`, or `error` with the exception TYPE only (#263, as `BaseIngestor.run`)."""
        updates: dict = {'status': 'completed', 'items_found': items_found, 'completed_at': now_iso()}
        if error is not None:
            updates.update(status='error', errors=[type(error).__name__])
        self._update_source_run_status(updates)

    def process_file(self, bucket: str, key: str, *, reprocess: bool = False) -> int:
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
            logger.error(f"{key}: {file_size / 1024 / 1024:.1f} MB exceeds {MAX_FILE_SIZE_MB} MB limit")
            return 0

        # Stream, parse, normalize, and send in batches
        source_name = _get_source_from_key(key, reprocess=reprocess)
        response = s3_client.get_object(Bucket=bucket, Key=key)
        stream = response["Body"]

        batch: list[dict] = []
        total = 0

        try:
            for item in parser(stream, source_name):
                normalized = self.normalize_item(item)
                batch.append(normalized)
                if len(batch) >= 100:
                    # Count what SQS confirmed, not what was attempted:
                    # send_to_queue raises rather than losing items, so the
                    # returned count is the only honest input to ItemsImported.
                    total += self.send_to_queue(batch)
                    batch = []

            if batch:
                total += self.send_to_queue(batch)
        finally:
            # Emit in a finally for the same reason the shared helper does: when
            # send_to_queue raises, the batches already accepted must still be
            # recorded, otherwise what landed on the queue is unrecoverable from
            # metrics.  The exception is not swallowed.
            logger.info(f"Processed {key}: {total} items")
            metrics.add_metric(name="ItemsImported", unit="Count", value=total)

        return total


def _process_records(ingestor: S3ImportIngestor, records: list, *, reprocess: bool) -> list[dict]:
    """Process every S3 record of an event; the run's row ends `completed`, or `error` and the error is re-raised."""
    ingestor.record_run_started()
    results: list[dict] = []
    try:
        for record in records:
            if record.get("eventSource") != "aws:s3":
                continue
            bucket = record["s3"]["bucket"]["name"]
            key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
            logger.info(f"Processing s3://{bucket}/{key}")
            count = ingestor.process_file(bucket, key, reprocess=reprocess)
            results.append({"file": key, "items_processed": count})
    except Exception as e:
        ingestor.record_run_finished(sum(r["items_processed"] for r in results), e)
        raise
    ingestor.record_run_finished(sum(r["items_processed"] for r in results))
    return results


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Handle S3 event notifications, and the API's reprocess input (an S3-shaped event).

    `execution_id` (a run the API recorded) and `reprocess: True` (a re-run of one
    file, issue #144) are the only additions to the trigger's event shape.
    """
    execution_id = event.get("execution_id") if isinstance(event.get("execution_id"), str) else None
    records = event.get("Records") or []
    if not records and not execution_id:
        logger.info("No S3 records in event, nothing to do")
        return {"status": "skipped", "reason": "no records"}

    ingestor = S3ImportIngestor(execution_id=execution_id)
    # A run with no file (`POST /sources/s3_import/run`) still closes its row, as completed with 0 items.
    results = _process_records(ingestor, records, reprocess=event.get("reprocess") is True)

    total = sum(r["items_processed"] for r in results)
    return {
        "status": "success",
        "files_processed": len(results),
        "items_processed": total,
        "results": results,
    }
