"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered by S3 events when files are uploaded.
Folder name becomes the source: {folder}/file.csv -> source = "S3 - {folder}"
"""

import csv
import hashlib
import io
import json
import os
import urllib.parse
from collections.abc import Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime

import boto3

from _shared.base_ingestor import BaseIngestor, logger, metrics, tracer
from shared.import_runs import S3_UPLOAD_ACTOR, ImportCounts, ImportRun, record_import_run
from shared.invocation_cost import measure_invocation_cost
from shared.timestamps import now_iso

s3_client = boto3.client("s3")

# The import bucket this ingestor serves (VocIngestionStack sets it next to the S3 trigger).
# A record naming any other bucket is skipped unread: the API invokes this function
# directly (`POST /s3-import/reprocess`), so the bucket in an event is not trusted.
# Unset = no bucket is trusted, and every record is skipped.
IMPORT_BUCKET = os.environ.get("S3_IMPORT_BUCKET", "")

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


@dataclass
class FileReport:
    """What parsing one file dropped, for its import-history record (docs/import-history.md)."""

    skipped: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def skip(self, note: str) -> None:
        self.skipped += 1
        self.warnings.append(note)


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


def _parse_csv(stream, source_name: str, report: FileReport | None = None) -> Generator[dict, None, None]:
    """Parse CSV content, yielding normalized items (dropped rows are noted on ``report``)."""
    report = report if report is not None else FileReport()
    text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    reader = csv.DictReader(text_wrapper)

    if not reader.fieldnames:
        logger.error("CSV file has no headers")
        report.errors.append("CSV file has no headers")
        return

    headers = {h.strip().lower() for h in reader.fieldnames}
    text_aliases = {a.lower() for a in FIELD_ALIASES["text"]}
    if not headers.intersection(text_aliases):
        logger.error(f"CSV missing text column. Expected one of: {sorted(text_aliases)}. Found: {sorted(headers)}")
        report.errors.append(f"CSV missing text column. Expected one of: {', '.join(sorted(text_aliases))}")
        return

    for row_num, row in enumerate(reader, start=2):
        try:
            item = _normalize_row(row, source_name, "csv_import")
            if item:
                yield item
            else:
                logger.debug(f"Row {row_num}: empty text, skipping")
                report.skip(f"row {row_num}: empty text — skipped")
        except _ROW_ERRORS as e:
            logger.warning(f"Row {row_num}: parse error: {e}")
            report.skip(f"row {row_num}: parse error — skipped: {e}")


def _parse_jsonl(stream, source_name: str, report: FileReport | None = None) -> Generator[dict, None, None]:
    """Parse JSONL (one JSON object per line)."""
    report = report if report is not None else FileReport()
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
            else:
                report.skip(f"line {line_num}: empty text — skipped")
        except (*_ROW_ERRORS, RecursionError) as e:
            # ValueError covers json.JSONDecodeError; RecursionError is what
            # json.loads raises for a pathologically nested line.
            logger.warning(f"JSONL line {line_num}: {e}")
            report.skip(f"line {line_num}: not valid JSON — skipped: {e}")


def _parse_json(stream, source_name: str, report: FileReport | None = None) -> Generator[dict, None, None]:
    """Parse a JSON array or single object."""
    report = report if report is not None else FileReport()
    try:
        data = json.loads(stream.read())
    except json.JSONDecodeError as e:
        logger.exception(f"Invalid JSON: {e}")
        report.errors.append(f"Invalid JSON: {e}")
        return

    items = data if isinstance(data, list) else [data]
    for idx, row in enumerate(items):
        try:
            item = _normalize_row(row, source_name, "json_import")
            if item:
                yield item
            else:
                report.skip(f"item {idx}: empty text — skipped")
        except _ROW_ERRORS as e:
            logger.warning(f"JSON item {idx}: {e}")
            report.skip(f"item {idx}: not an object — skipped: {e}")


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

    def _record_file_run(self, bucket: str, key: str, started_at: str, counts: ImportCounts, report: FileReport) -> None:
        """One import-history record for this file (docs/import-history.md); never raises."""
        record_import_run(self.aggregates_table, ImportRun(
            method="s3", source=_get_source_from_key(key), actor=S3_UPLOAD_ACTOR, started_at=started_at,
            counts=counts, source_id=self.source_platform, warnings=report.warnings, errors=report.errors,
            raw_s3_key=f"s3://{bucket}/{key}",
        ))

    def _refuse_file(self, bucket: str, key: str, started_at: str, reason: str) -> int:
        """Record a file that was not read at all (empty or over the size limit) as a failed run; 0 imported."""
        self._record_file_run(bucket, key, started_at, ImportCounts(received=0, imported=0), FileReport(errors=[reason]))
        return 0

    def process_file(self, bucket: str, key: str, *, reprocess: bool = False) -> int:
        """Process a single S3 file: validate, parse, normalize, and queue."""
        parser = _get_parser(key)
        if not parser:
            logger.warning(f"Unsupported file type: {key}")
            return 0
        started_at = datetime.now(UTC).isoformat()

        # Validate file size
        head = s3_client.head_object(Bucket=bucket, Key=key)
        file_size = head["ContentLength"]

        if file_size == 0:
            logger.warning(f"{key}: empty file, skipping")
            return self._refuse_file(bucket, key, started_at, "empty file")

        if file_size > MAX_FILE_SIZE_BYTES:
            logger.error(f"{key}: {file_size / 1024 / 1024:.1f} MB exceeds {MAX_FILE_SIZE_MB} MB limit")
            return self._refuse_file(bucket, key, started_at, f"{file_size / 1024 / 1024:.1f} MB exceeds the {MAX_FILE_SIZE_MB} MB limit")

        # Stream, parse, normalize, and send in batches
        source_name = _get_source_from_key(key, reprocess=reprocess)
        response = s3_client.get_object(Bucket=bucket, Key=key)
        stream = response["Body"]

        report = FileReport()
        batch: list[dict] = []
        total = 0
        parsed = 0
        sent_all = False

        try:
            for item in parser(stream, source_name, report):
                parsed += 1
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
            sent_all = True
        except Exception as e:
            report.errors.append(f"stopped after {total} items: {e}")
            raise
        finally:
            # Emit in a finally for the same reason the shared helper does: when
            # send_to_queue raises, the batches already accepted must still be
            # recorded, otherwise what landed on the queue is unrecoverable from
            # metrics.  The exception is not swallowed.
            logger.info(f"Processed {key}: {total} items")
            metrics.add_metric(name="ItemsImported", unit="Count", value=total)
            self._record_file_run(bucket, key, started_at, _file_counts(parsed, total, report, sent_all=sent_all), report)

        return total


class NoImportFileRead(Exception):
    """A reprocess run whose event named no record this ingestor reads (another bucket, or no S3 record).

    Its type name is what the run row's `errors` shows; without it the run would read
    `completed` with 0 rows, the same as an empty file.
    """


def _read_records(ingestor: S3ImportIngestor, records: list, results: list[dict], *, reprocess: bool) -> None:
    """Process each S3 record of the import bucket, appending `{file, items_processed}` to *results* as it goes."""
    for record in records:
        if record.get("eventSource") != "aws:s3":
            continue
        bucket = record["s3"]["bucket"]["name"]
        if not IMPORT_BUCKET or bucket != IMPORT_BUCKET:
            logger.warning("Skipping a record for a bucket other than the import bucket",
                           extra={"bucket": bucket})
            continue
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        logger.info(f"Processing s3://{bucket}/{key}")
        count = ingestor.process_file(bucket, key, reprocess=reprocess)
        results.append({"file": key, "items_processed": count})
    if reprocess and not results:
        raise NoImportFileRead("The reprocess event named no file in the import bucket")


def _process_records(ingestor: S3ImportIngestor, records: list, *, reprocess: bool) -> list[dict]:
    """Process every S3 record of an event; the run's row ends `completed`, or `error` and the error is re-raised.

    A reprocess that reads no record ends `error` (`NoImportFileRead`), raised like any other failure.
    """
    ingestor.record_run_started()
    results: list[dict] = []
    try:
        _read_records(ingestor, records, results, reprocess=reprocess)
    except Exception as e:
        ingestor.record_run_finished(sum(r["items_processed"] for r in results), e)
        raise
    ingestor.record_run_finished(sum(r["items_processed"] for r in results))
    return results


def _failed_reprocess(error: Exception) -> dict:
    """The answer to a reprocess whose run row was closed as `error`."""
    logger.exception(f"Reprocess failed: {type(error).__name__}")
    metrics.add_metric(name="ReprocessFailed", unit="Count", value=1)
    return {"status": "error", "error": type(error).__name__}


def _file_counts(parsed: int, imported: int, report: FileReport, *, sent_all: bool) -> ImportCounts:
    """A file's counts. After a complete send, parsed rows the queue did not take were dropped by the
    source policy (skipped); after a send that raised they failed."""
    not_imported = max(0, parsed - imported)
    return ImportCounts(
        received=parsed + report.skipped, imported=imported,
        skipped=report.skipped + (not_imported if sent_all else 0),
        failed=0 if sent_all else not_imported,
    )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@measure_invocation_cost
def lambda_handler(event, context):
    """Handle S3 event notifications, and the API's reprocess input (an S3-shaped event).

    `execution_id` (a run the API recorded) and `reprocess: True` (a re-run of one
    file, issue #144) are the only additions to the trigger's event shape. A failed
    reprocess answers `{"status": "error", "error": <type>}` instead of raising, so
    Lambda does not retry it.
    """
    execution_id = event.get("execution_id") if isinstance(event.get("execution_id"), str) else None
    records = event.get("Records") or []
    if not records and not execution_id:
        logger.info("No S3 records in event, nothing to do")
        return {"status": "skipped", "reason": "no records"}

    reprocess = event.get("reprocess") is True
    ingestor = S3ImportIngestor(execution_id=execution_id)
    # A run with no file (`POST /sources/s3_import/run`) still closes its row, as completed with 0 items.
    try:
        results = _process_records(ingestor, records, reprocess=reprocess)
    except Exception as e:
        # An upload's S3 event is raised again, so Lambda retries it (its only recovery). A
        # reprocess's `error` is final: a retry would move the row back to `running` after the
        # explorer stopped polling it. The admin presses Reprocess again (duplicates are skipped).
        if not reprocess:
            raise
        return _failed_reprocess(e)

    total = sum(r["items_processed"] for r in results)
    return {
        "status": "success",
        "files_processed": len(results),
        "items_processed": total,
        "results": results,
    }
