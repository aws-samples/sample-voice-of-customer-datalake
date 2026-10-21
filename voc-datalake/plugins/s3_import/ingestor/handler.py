"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered by S3 events when files are uploaded.
Folder name becomes the source: {folder}/file.csv -> source = "S3 - {folder}"
"""

import json
import csv
import io
import os
import hashlib
import itertools
import boto3
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Generator, Iterator
from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
from _shared.schemas import normalize_source_platform

s3_client = boto3.client("s3")
lambda_client = boto3.client("lambda")

# Ceiling for a single S3-staged import file. Raised from 50 MB to accommodate
# large bulk exports (observed real files: ~75 MB, 100k–500k rows). The ingestor
# streams the body and queues in batches of 100, so memory stays bounded
# regardless of file size; this cap guards against a pathological upload rather
# than a working-set limit. The browser uploads straight to S3 via a presigned
# URL, so the API Gateway 10 MB request-body limit does not apply on this path.
MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024

# Fan-out tuning (large-file import, 100k–500k rows).
#
# A single invocation cannot process a 500k-row file within Lambda's 900s hard
# cap because each row does a raw-S3 write plus an SQS send. So the S3-triggered
# invocation acts as a SPLITTER: it reads the file once, divides it into row
# ranges of CHUNK_SIZE, and async-invokes ITSELF (InvocationType='Event') once
# per range. Each chunk worker re-reads the file, processes only its range, and
# runs within the timeout. Dedup is write-side and content-addressed on
# source_platform:id (see processor/handler.py), so overlapping or retried
# chunks collapse to one feedback item — fan-out is safe.
CHUNK_SIZE = 2000
# Hard ceiling on fan-out breadth, so a pathological file can't spawn unbounded
# invocations. 500k rows / 2000 = 250 chunks; the cap leaves headroom and still
# refuses a file an order of magnitude past the stated target.
MAX_CHUNKS = 400
# Parallelism for the per-record raw-S3 writes WITHIN a chunk worker. The writes
# are I/O-bound (one put_object each), so threads cut a chunk's wall-clock
# sharply without needing more memory. Bounded to stay well under the S3
# request-rate and the worker's socket budget.
RAW_WRITE_WORKERS = 16

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


# source_platform fallback when a key/row yields no usable source label. It is
# the plugin's own already-valid source_platform.
DEFAULT_SOURCE_PLATFORM = "s3_import"


def _get_source_from_key(key: str) -> str:
    """Derive a VALID source_platform from an S3 key's folder.

    The folder name is normalized to the ``^[a-z][a-z0-9_]*$`` contract rather
    than wrapped as ``"S3 - {folder}"`` — the old form carried a space, a dash
    and uppercase and so was rejected at message validation, silently losing
    every row of a foldered import. ``sales/file.csv`` now becomes ``sales``;
    a file at the bucket root falls back to ``s3_import``.
    """
    parts = key.split("/")
    folder = parts[0] if len(parts) > 1 else ""
    return normalize_source_platform(folder, fallback=DEFAULT_SOURCE_PLATFORM)


def _normalize_row(
    row: dict, source_name: str, default_channel: str = "import",
    source_field: str | None = None,
) -> dict | None:
    """Normalize a row (from CSV or JSON) into the expected item format.

    Returns None if no text.

    Per-row source (Phase 3): when ``source_field`` names a column, that column's
    value — normalized to the source_platform contract — becomes this row's
    source, overriding the file-level ``source_name``. This is what lets a single
    large file carry a handful of distinct, filterable sources. A row whose
    ``source_field`` is absent or empty keeps ``source_name``.
    """
    text = _resolve_field(row, "text")
    if not text:
        return None

    row_source = source_name
    if source_field:
        raw_source = row.get(source_field)
        if raw_source is not None and str(raw_source).strip():
            # Fall back to the file-level source (already valid) rather than the
            # plugin default, so an unmappable cell stays with its file's batch.
            row_source = normalize_source_platform(str(raw_source), fallback=source_name)

    normalized = {
        "id": _resolve_field(row, "id") or _generate_deterministic_id(text),
        "channel": _resolve_field(row, "channel", default_channel),
        "url": _resolve_field(row, "url"),
        "text": text,
        "rating": _parse_rating(_resolve_field(row, "rating", None)),
        "created_at": _resolve_field(row, "created_at"),
        "author": _resolve_field(row, "author"),
        "source_platform_override": row_source,
    }

    # Carry an explicit `metadata` object through so its extra columns reach the
    # processor's custom_fields (the admin-pickable import filters). Only a dict
    # is forwarded; MessageMetadata validation (and _build_custom_fields) keep
    # only primitive values, so a stray non-primitive degrades gracefully rather
    # than dropping the row. Records with no metadata simply omit the key.
    metadata = row.get("metadata")
    if isinstance(metadata, dict) and metadata:
        normalized["metadata"] = metadata

    return normalized


def _parse_csv(stream, source_name: str, source_field: str | None = None) -> Generator[dict, None, None]:
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
            item = _normalize_row(row, source_name, "csv_import", source_field)
            if item:
                yield item
            else:
                logger.debug(f"Row {row_num}: empty text, skipping")
        except Exception as e:
            logger.warning(f"Row {row_num}: parse error: {e}")


def _parse_jsonl(stream, source_name: str, source_field: str | None = None) -> Generator[dict, None, None]:
    """Parse JSONL (one JSON object per line)."""
    text_wrapper = io.TextIOWrapper(stream, encoding="utf-8", errors="replace")
    for line_num, line in enumerate(text_wrapper, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            item = _normalize_row(row, source_name, "json_import", source_field)
            if item:
                yield item
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"JSONL line {line_num}: {e}")


def _parse_json(stream, source_name: str, source_field: str | None = None) -> Generator[dict, None, None]:
    """Parse a JSON array, an ``{"items": [...]}`` envelope, or a single object.

    The ``{"items": [...]}`` wrapper is the documented upload format (see the
    frontend template and ``parseJsonFeedback``'s ``isObjectWithItems``): a file
    may carry provenance keys like ``_source_notes`` alongside the records. Only
    the sync upload path unwrapped it before, so a large file in that shape fell
    through ``[data]`` here and was parsed as ONE row with no ``text`` — yielding
    zero items. Unwrap it the same way the sync path does so both paths accept
    the same files.
    """
    try:
        data = json.loads(stream.read())
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON: {e}")
        return

    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data["items"]
    else:
        items = [data]
    for idx, row in enumerate(items):
        try:
            item = _normalize_row(row, source_name, "json_import", source_field)
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

    def _open(self, bucket: str, key: str) -> tuple[str | None, int]:
        """Validate the file and return ``(source_field, file_size)``.

        Returns ``(source_field, 0)`` when the file is unusable (empty, oversize,
        or unsupported type) so callers short-circuit. ``source_field`` is the
        per-row source column from object metadata (Phase 3), or None.
        """
        if not _get_parser(key):
            logger.warning(f"Unsupported file type: {key}")
            return None, 0
        head = s3_client.head_object(Bucket=bucket, Key=key)
        file_size = head["ContentLength"]
        if file_size == 0:
            logger.warning(f"{key}: empty file, skipping")
            return None, 0
        if file_size > MAX_FILE_SIZE_BYTES:
            logger.error(
                f"{key}: {file_size / 1024 / 1024:.1f} MB exceeds "
                f"{MAX_FILE_SIZE_BYTES / 1024 / 1024:.0f} MB limit"
            )
            return None, 0
        # S3 lowercases x-amz-meta-* keys, so the key is `source-field`.
        source_field = (head.get("Metadata") or {}).get("source-field") or None
        return source_field, file_size

    def _normalized_items(self, bucket: str, key: str, source_field: str | None) -> Iterator[dict]:
        """Yield parser items (pre-normalize) for a file, newest-first by parse order.

        One read of the object; the parser streams (CSV/JSONL) or loads once
        (JSON). Shared by the splitter's row count and each chunk worker's slice.
        """
        parser = _get_parser(key)
        source_name = _get_source_from_key(key)
        response = s3_client.get_object(Bucket=bucket, Key=key)
        return parser(response["Body"], source_name, source_field)

    def split_file(self, bucket: str, key: str) -> int:
        """SPLITTER: read the file once, fan out one chunk invocation per range.

        Returns the number of chunk invocations dispatched. The actual item
        counts come from the chunk workers (each emits its own ItemsImported),
        so this does not itself queue feedback — it only divides the work.
        """
        source_field, file_size = self._open(bucket, key)
        if file_size == 0:
            return 0

        # Count parseable rows in one pass. For JSON this is already in memory
        # after json.loads; for CSV/JSONL it streams. We only need the count to
        # compute ranges — items are re-read per chunk.
        row_count = sum(1 for _ in self._normalized_items(bucket, key, source_field))
        if row_count == 0:
            logger.info(f"{key}: no parseable rows, nothing to import")
            return 0

        chunk_count = (row_count + CHUNK_SIZE - 1) // CHUNK_SIZE
        if chunk_count > MAX_CHUNKS:
            logger.error(
                f"{key}: {row_count} rows would need {chunk_count} chunks, "
                f"over the {MAX_CHUNKS} cap; refusing to fan out"
            )
            return 0

        self_fn = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
        for i in range(chunk_count):
            start = i * CHUNK_SIZE
            payload = {
                "chunk": {
                    "bucket": bucket,
                    "key": key,
                    "source_field": source_field,
                    "start": start,
                    "end": min(start + CHUNK_SIZE, row_count),
                }
            }
            lambda_client.invoke(
                FunctionName=self_fn,
                InvocationType="Event",  # async fire-and-forget
                Payload=json.dumps(payload).encode(),
            )
        logger.info(
            f"Split {key}: {row_count} rows into {chunk_count} chunks of {CHUNK_SIZE}"
        )
        metrics.add_metric(name="ImportChunksDispatched", unit="Count", value=chunk_count)
        return chunk_count

    def process_chunk(self, bucket: str, key: str, source_field: str | None,
                      start: int, end: int) -> int:
        """CHUNK WORKER: process rows ``[start, end)`` of the file.

        Re-reads the file and slices to the range with ``islice``. Normalizes
        with parallel raw-S3 writes, then queues in batches of 100. Dedup is
        write-side, so a range that overlaps a retried sibling is harmless.
        """
        rows = itertools.islice(
            self._normalized_items(bucket, key, source_field), start, end
        )
        total = 0
        try:
            for batch in _batched(rows, 100):
                normalized = self._normalize_batch(batch)
                total += self.send_to_queue(normalized)
        finally:
            logger.info(f"Chunk {key}[{start}:{end}]: {total} items")
            metrics.add_metric(name="ItemsImported", unit="Count", value=total)
        return total

    def _normalize_batch(self, items: list[dict]) -> list[dict]:
        """Normalize a batch, running the per-record raw-S3 writes in parallel.

        ``normalize_item`` does one S3 put_object per record (raw archival that
        the Data Explorer consumes). Serially that dominates a chunk's runtime,
        so the writes run on a bounded thread pool; order is preserved so the
        result matches a serial normalize.
        """
        with ThreadPoolExecutor(max_workers=RAW_WRITE_WORKERS) as pool:
            return list(pool.map(self.normalize_item, items))


def _batched(iterable: Iterator[dict], size: int) -> Iterator[list[dict]]:
    """Yield successive lists of up to ``size`` items (itertools.batched, py<3.12 safe)."""
    iterator = iter(iterable)
    while True:
        batch = list(itertools.islice(iterator, size))
        if not batch:
            return
        yield batch


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    """Dispatch between the two invocation shapes.

    - ``{"chunk": {...}}`` (async self-invoke): a chunk worker processing one
      row range.
    - S3 event notification (``{"Records": [...]}``): the splitter, which fans
      the file out into chunk invocations.
    """
    chunk = event.get("chunk")
    if chunk:
        count = S3ImportIngestor().process_chunk(
            chunk["bucket"], chunk["key"], chunk.get("source_field"),
            chunk["start"], chunk["end"],
        )
        return {"status": "success", "mode": "chunk", "items_processed": count}

    if not event.get("Records"):
        # Construct nothing on a no-op event: the ingestor's __init__ reads
        # plugin secrets and can raise, which would turn "nothing to do" into
        # an error.
        logger.info("No S3 records in event, nothing to do")
        return {"status": "skipped", "reason": "no records"}

    ingestor = S3ImportIngestor()
    results = []
    for record in event["Records"]:
        if record.get("eventSource") != "aws:s3":
            continue
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        logger.info(f"Splitting s3://{bucket}/{key}")
        chunks = ingestor.split_file(bucket, key)
        results.append({"file": key, "chunks_dispatched": chunks})

    return {
        "status": "success",
        "mode": "split",
        "files_processed": len(results),
        "results": results,
    }
