"""
S3 Import Ingestor - Imports feedback from S3 bucket files (CSV, JSON, JSONL).
Triggered by S3 events when files are uploaded.
Folder name becomes the source: {folder}/file.csv -> source = "S3 - {folder}"

A run is in the workspace an event names in ``workspace_id`` (``_shared/base_ingestor.py run_in_workspace``: a
malformed id, or a workspace that is not active, is refused), and deployment-wide when the event names none (the S3
import API's reprocess without ``X-Workspace-Id``, and Run now; the operator API refuses Run now of s3_import in a workspace,
lambda/api/integrations_handler.py), as always. The bucket's own upload notification names no workspace: its records
are run where their keys put them (``lambda_handler``): a key ``ws/{ws}/...`` with a well-formed ``{ws}`` in that
workspace (an event of its records plus ``workspace_id``, through ``run_in_workspace``), every other record in one
deployment-wide run as before. The key is trusted for this because only the S3 import API (for a member of the
workspace: a presigned, create-only PUT for one exact key it built from the resolved membership) and the
deployment's own IAM principals write under ``ws/{ws}/``. An event that carries ``workspace_id``, ``execution_id`` or
``reprocess`` is never routed by its keys.
A workspace's files sit under its own ``ws/{ws}/`` in the import bucket (``ws/{ws}/{folder}/file.csv``, the folder
rule read after that prefix); a run in a workspace refuses any other key unread, and any key with an empty, ``.`` or
``..`` segment after the prefix (``process_file``). A deployment-wide run refuses unread any key of three or more
segments whose first is ``ws`` (an upload's such key reaches it only when its ``{ws}`` is malformed; a reprocess's
whenever it names one); the deployment's own keys are ``<source>/<file>``, so none is refused. A refused file's
history row names the neutral source ``S3 - Import`` and no raw file (``raw_s3_key`` None); its file name goes into
the error only when it has a supported extension.

Raw copies: the staged file as uploaded goes to ``raw/s3_import/...`` (a workspace run: ``ws/{ws}/raw/s3_import/...``)
before it is read
(``_shared/raw_original.py``, only when the s3_import source keeps whole files), and each item's
own archive carries its source row (the CSV row / JSON object, ``raw_content``).
"""

import csv
import hashlib
import io
import json
import os
import urllib.parse
from collections.abc import Generator, Mapping
from dataclasses import dataclass, field

import boto3

from _shared.base_ingestor import BaseIngestor, logger, metrics, run_in_workspace, tracer
from _shared.raw_original import archive_original
from _shared.raw_source import RAW_SOURCE_KEY
from shared import job_notices
from shared.import_runs import MAX_MESSAGES, S3_UPLOAD_ACTOR, ImportCounts, ImportRun, record_import_run
from shared.invocation_cost import measure_invocation_cost
from shared.timestamps import now_iso
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, s3_prefix

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
# The source of a file at the bucket's root, and of every refused file (never derived from a key that was refused).
DEFAULT_SOURCE = "S3 - Import"
# The first segment of a workspace's import folder (``ws/{ws}/...``, shared/ws_repo.py ``s3_prefix``).
WORKSPACE_FOLDER = "ws"
# Segments a workspace's staged key never holds after its prefix.
_BAD_SEGMENTS = frozenset({"", ".", ".."})
# Why a key was refused unread, and the metric counting it: in a workspace run, and in a deployment-wide one.
OUTSIDE_WORKSPACE = ("file is not in this workspace's import folder", "ImportFileOutsideWorkspace")
IN_A_WORKSPACE_FOLDER = ("file is in a workspace's import folder", "ImportFileInWorkspaceFolder")

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
    """What parsing one file dropped, for its import-history record (docs/import-history.md).

    At most ``MAX_MESSAGES`` warnings are kept in memory (the record stores no more); the rest are only counted.
    """

    skipped: int = 0
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings_not_kept: int = 0

    def skip(self, note: str) -> None:
        self.skipped += 1
        if len(self.warnings) < MAX_MESSAGES:
            self.warnings.append(note)
        else:
            self.warnings_not_kept += 1


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
    return DEFAULT_SOURCE


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


def _row_item(row: dict, source_name: str, default_channel: str) -> dict | None:
    """``_normalize_row`` plus the source row, for its raw archive (``_shared/raw_source.py``); None without text."""
    item = _normalize_row(row, source_name, default_channel)
    if item is not None:
        item[RAW_SOURCE_KEY] = row
    return item


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

    # The logs number by file line (the header is line 1); the history record numbers data rows from 1,
    # as the CSV upload route does, so one Import history table means one thing.
    for row_num, row in enumerate(reader, start=2):
        data_row = row_num - 1
        try:
            item = _row_item(row, source_name, "csv_import")
            if item:
                yield item
            else:
                logger.debug(f"Row {row_num}: empty text, skipping")
                report.skip(f"row {data_row}: empty text — skipped")
        except _ROW_ERRORS as e:
            logger.warning(f"Row {row_num}: parse error: {e}")
            report.skip(f"row {data_row}: parse error ({type(e).__name__}) — skipped")


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
            item = _row_item(row, source_name, "json_import")
            if item:
                yield item
            else:
                report.skip(f"line {line_num}: empty text — skipped")
        except (*_ROW_ERRORS, RecursionError) as e:
            # ValueError covers json.JSONDecodeError; RecursionError is what
            # json.loads raises for a pathologically nested line.
            logger.warning(f"JSONL line {line_num}: {e}")
            report.skip(f"line {line_num}: not valid JSON — skipped")


def _parse_json(stream, source_name: str, report: FileReport | None = None) -> Generator[dict, None, None]:
    """Parse a JSON array or single object."""
    report = report if report is not None else FileReport()
    try:
        data = json.loads(stream.read())
    except json.JSONDecodeError as e:
        logger.exception(f"Invalid JSON: {e}")
        # The position only, like the row paths' error class: never text from the file.
        report.errors.append(f"Invalid JSON at line {e.lineno}, column {e.colno}")
        return

    items = data if isinstance(data, list) else [data]
    for idx, row in enumerate(items):
        try:
            item = _row_item(row, source_name, "json_import")
            if item:
                yield item
            else:
                report.skip(f"item {idx}: empty text — skipped")
        except _ROW_ERRORS as e:
            logger.warning(f"JSON item {idx}: {e}")
            reason = "not an object" if isinstance(e, AttributeError) else f"parse error ({type(e).__name__})"
            report.skip(f"item {idx}: {reason} — skipped")


def _get_parser(key: str):
    """Return the appropriate parser function for a file extension, or None."""
    if key.endswith(".csv"):
        return _parse_csv
    if key.endswith(".jsonl"):
        return _parse_jsonl
    if key.endswith(".json"):
        return _parse_json
    return None


#: The notice's ``job_type`` for an API-started run (shared/job_notices.py): the S3 import explorer listens for it.
REPROCESS_JOB_TYPE = "s3_import_reprocess"


class S3ImportIngestor(BaseIngestor):
    """Ingestor for importing feedback from S3 files.

    *execution_id* is set on a run started by the API (`POST /s3-import/reprocess`,
    or `POST /sources/s3_import/run`); `record_run_started` / `record_run_finished`
    then move that run's `SOURCE_RUN#s3_import` row (`WS#{ws}#SOURCE_RUN#s3_import` for a run in a
    workspace, whose import-history records go under it too). An S3 trigger event has none, and no
    row is written. *started_by* (the API's caller) is told when that run ends (docs/realtime.md).
    """

    def __init__(self, scope: WorkspaceScope | None, execution_id: str | None = None, started_by: str | None = None):
        super().__init__(scope, execution_id=execution_id)
        self.started_by = started_by

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
        # Best effort, never raises: the explorer re-reads the run now (its poll stays the fallback).
        job_notices.notify(self.started_by, self.execution_id, updates['status'], job_type=REPROCESS_JOB_TYPE)

    def _record_file_run(self, started_at: str, counts: ImportCounts, report: FileReport, *, source: str,
                         raw_s3_key: str | None) -> None:
        """One import-history record for a file (docs/import-history.md) under *source*, the label ``process_file``
        worked out; *raw_s3_key* the file's ``s3://`` URI, or None for a refused file (no raw file). Never raises.

        Called from ``process_file``'s ``finally``: anything raised here would replace the import's own
        exception, so every failure is logged and dropped, not only the write errors the shared writer catches.
        """
        try:
            record_import_run(self.aggregates_table, ImportRun(
                method="s3", source=source, actor=S3_UPLOAD_ACTOR, started_at=started_at,
                counts=counts, source_id=self.source_platform, warnings=report.warnings, errors=report.errors,
                raw_s3_key=raw_s3_key, warnings_not_kept=report.warnings_not_kept,
            ))
        except Exception:
            # Unexpected (the writer already absorbs write errors at warning level), so logged as an error.
            logger.exception("Import run record not written", extra={"source": source})

    def _refuse_file(self, started_at: str, reason: str, *, source: str, raw_s3_key: str | None) -> int:
        """Record a file that was not read at all (outside the run's folder, empty or over the size limit) as a
        failed run; 0 imported."""
        self._record_file_run(started_at, ImportCounts(received=0, imported=0), FileReport(errors=[reason]),
                              source=source, raw_s3_key=raw_s3_key)
        return 0

    def _refuse_unread_key(self, key: str, started_at: str) -> int:
        """A key ``_staged_key`` refused: logged, counted and recorded, never read. Its history row names the neutral
        ``DEFAULT_SOURCE`` and no raw file; the file name goes into the reason only when it has a supported
        extension. Nothing of the folder, which may be another workspace's, is kept."""
        if self.scope is None:
            (reason, metric), message = IN_A_WORKSPACE_FOLDER, "Refusing a workspace's import file in a deployment-wide run"
        else:
            (reason, metric), message = OUTSIDE_WORKSPACE, "Refusing an import file outside the run's workspace"
        logger.warning(message, extra={"key": key})
        metrics.add_metric(name=metric, unit="Count", value=1)
        name = key.rsplit("/", 1)[-1]
        if _get_parser(name):
            reason = f"{name}: {reason}"
        return self._refuse_file(started_at, reason, source=DEFAULT_SOURCE, raw_s3_key=None)

    def _staged_key(self, key: str) -> str | None:
        """The import-bucket key as the source rules read it (``{folder}/file`` or ``processed/{folder}/file``), or
        None for a key the run never reads.

        Deployment-wide (no scope) the key itself, as always, but for a key of three or more segments under
        ``ws/`` (a workspace's folder; an upload's reaches this run only when its id is malformed, ``lambda_handler``
        routing the rest to their workspace; the deployment's keys are ``<source>/<file>``). In a workspace only a key
        under the workspace's own ``ws/{ws}/`` (``ws_repo.s3_prefix``) whose segments after it are none empty,
        ``.`` or ``..``, read without that prefix; any other key, another workspace's or the deployment's, is None.
        """
        if self.scope is None:
            segments = key.split("/")
            return None if segments[0] == WORKSPACE_FOLDER and len(segments) >= 3 else key
        prefix = s3_prefix(self.scope)
        if not key.startswith(prefix):
            return None
        staged = key[len(prefix):]
        return None if _BAD_SEGMENTS.intersection(staged.split("/")) else staged

    def process_file(self, bucket: str, key: str, *, reprocess: bool = False) -> int:
        """Process a single S3 file: validate, parse, normalize, and queue.

        A key the run never reads (``_staged_key``) is refused before any S3 call.
        """
        started_at = now_iso()
        staged = self._staged_key(key)
        if staged is None:
            return self._refuse_unread_key(key, started_at)
        parser = _get_parser(key)
        if not parser:
            logger.warning(f"Unsupported file type: {key}")
            return 0
        source_name = _get_source_from_key(staged, reprocess=reprocess)
        raw_s3_key = f"s3://{bucket}/{key}"

        # Validate file size
        head = s3_client.head_object(Bucket=bucket, Key=key)
        file_size = head["ContentLength"]

        if file_size == 0:
            logger.warning(f"{key}: empty file, skipping")
            return self._refuse_file(started_at, "empty file", source=source_name, raw_s3_key=raw_s3_key)

        if file_size > MAX_FILE_SIZE_BYTES:
            logger.error(f"{key}: {file_size / 1024 / 1024:.1f} MB exceeds {MAX_FILE_SIZE_MB} MB limit")
            return self._refuse_file(started_at, f"{file_size / 1024 / 1024:.1f} MB exceeds the {MAX_FILE_SIZE_MB} MB limit",
                                     source=source_name, raw_s3_key=raw_s3_key)

        # Stream, parse, normalize, and send in batches
        response = s3_client.get_object(Bucket=bucket, Key=key)
        # Read whole (at most MAX_FILE_SIZE_MB): the original goes to the raw lake before parsing. Under its staged
        # key: in a workspace the copy is already under ws/{ws}/raw/, and a reprocess maps to the same folder.
        body = response["Body"].read()
        archive_original(s3_client, os.environ.get("RAW_DATA_BUCKET", ""), staged, body, scope=self.scope)
        stream = io.BytesIO(body)

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
            # The error class only: an exception message can quote a row value.
            report.errors.append(f"stopped after {total} items: {type(e).__name__}")
            raise
        finally:
            # Emit in a finally for the same reason the shared helper does: when
            # send_to_queue raises, the batches already accepted must still be
            # recorded, otherwise what landed on the queue is unrecoverable from
            # metrics.  The exception is not swallowed.
            logger.info(f"Processed {key}: {total} items")
            metrics.add_metric(name="ItemsImported", unit="Count", value=total)
            self._record_file_run(started_at, _file_counts(parsed, total, report, sent_all=sent_all), report,
                                  source=source_name, raw_s3_key=raw_s3_key)

        return total


class NoImportFileRead(Exception):
    """A reprocess run whose event named no record this ingestor reads (another bucket, or no S3 record).

    Its type name is what the run row's `errors` shows; without it the run would read
    `completed` with 0 rows, the same as an empty file.
    """


def _record_key(record: Mapping) -> str:
    """A record's object key as S3 names it in a notification (URL-encoded, ``+`` for a space), decoded."""
    return urllib.parse.unquote_plus(record["s3"]["object"]["key"])


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
        key = _record_key(record)
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
    logger.exception(f"Reprocess failed: {type(error).__name__}")  # noqa: LOG004 — only called from an except handler, which supplies the traceback
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

    `workspace_id` (the workspace of the run), `execution_id` (a run the API recorded)
    and `reprocess: True` (a re-run of one file, issue #144) are the only additions to
    the trigger's event shape. An event that carries any of the three runs as it says (`run_in_workspace`): in the
    workspace it names (a malformed one refused), or deployment-wide without `workspace_id` (the API's reprocess),
    and its records' keys never move it. The bucket's own notification carries none of them: its records are run
    where their keys put them (``_upload_groups``): a key under ``ws/{ws}/`` in that workspace, every other record in
    one deployment-wide run of the event, as before workspaces (an event with no workspace key is that run itself).
    A failed reprocess answers `{"status": "error", "error": <type>}` instead of raising, so Lambda does not retry it.
    """
    groups = _upload_groups(event)
    if groups is None:
        return _run_event(event)
    return _run_upload_groups(event, groups)


def _run_event(event: Mapping) -> dict:
    """One run of *event* where it says (``run_in_workspace``)."""
    return run_in_workspace(event, lambda scope: _handle_in_workspace(scope, event))


#: The fields by which an event names its run: an event that carries any of them (whatever its value) is never routed
#: by its records' keys.
_RUN_FIELDS = (WORKSPACE_FIELD, "execution_id", "reprocess")


def _upload_workspace(record: object) -> str | None:
    """The workspace an upload record's key names, or None for the deployment.

    A workspace only for an S3 record of the import bucket whose decoded key (``_record_key``) is ``ws/{ws}/<more>``
    with ``{ws}`` a well-formed workspace id (``is_workspace_id``, the check ``WorkspaceScope`` and
    ``ws_repo.message_scope`` apply). Any other record, a malformed one included, is the deployment's: the
    deployment-wide run treats it exactly as before (skipped, read, or refused unread by ``_staged_key``).
    """
    if not isinstance(record, Mapping) or record.get("eventSource") != "aws:s3":
        return None
    try:
        if not IMPORT_BUCKET or record["s3"]["bucket"]["name"] != IMPORT_BUCKET:
            return None
        segments = _record_key(record).split("/")
    except (KeyError, TypeError, AttributeError):
        return None
    if len(segments) >= 3 and segments[0] == WORKSPACE_FOLDER and is_workspace_id(segments[1]):
        return segments[1]
    return None


def _upload_groups(event: object) -> list[tuple[str | None, list]] | None:
    """The records of the bucket's own notification by the place each runs in (a workspace id, or None for the
    deployment), the places in the order their first record comes, each one's records in the event's order.

    None (the event is run as it is, ``_run_event``) for an event that names its run (``_RUN_FIELDS``), has no
    record list, or has no record that names a workspace.

    Why a key may be trusted to name the workspace: only two writers put objects under ``ws/{ws}/`` in the import
    bucket. The S3 import API, for a member of that workspace (the key built from the request's resolved membership,
    never from its input; a presigned, create-only PUT for that one exact key), and the deployment's own IAM
    principals. Each run then goes through ``run_in_workspace``, so a workspace that is not active is refused there.
    """
    if not isinstance(event, Mapping) or any(name in event for name in _RUN_FIELDS):
        return None
    records = event.get("Records")
    if not isinstance(records, list):
        return None
    groups: dict[str | None, list] = {}
    for record in records:
        groups.setdefault(_upload_workspace(record), []).append(record)
    if all(ws is None for ws in groups):
        return None
    return list(groups.items())


def _run_upload_groups(event: Mapping, groups: list[tuple[str | None, list]]) -> dict:
    """Run each place's records (``_upload_groups``) as its own event, and answer as one.

    A workspace's event is its records plus ``workspace_id``; the deployment's is the event with only its records.
    With one place its answer is returned as it is (the not-active refusal included). With several: the success
    shape (``status``, ``files_processed``, ``items_processed``, ``results`` in the order the places ran) over the
    places that ran, ``refused`` (``workspace_id``, ``reason``, ``files``) for each place refused, and ``status``
    ``partial`` when some were refused, ``refused`` when all were.

    Errors: a place that raises does not stop the others: each runs in this attempt, and the first error is raised
    again afterwards (every one logged), so Lambda retries the S3 event as before. The retry runs every record
    again; that is safe, the feedback processor skips the duplicates (each re-read file gets one more history row).
    """
    events = [({**event, "Records": records} if ws is None else {"Records": records, WORKSPACE_FIELD: ws}, ws)
              for ws, records in groups]
    if len(events) == 1:
        return _run_event(events[0][0])
    results: list[dict] = []
    refused: list[dict] = []
    ran = 0
    first_error: Exception | None = None
    for group_event, ws in events:
        try:
            answer = _run_event(group_event)
        except Exception as error:
            logger.exception("An upload's records failed in one place; the other places still run",
                             extra={"place": ws or "deployment"})
            first_error = first_error or error
            continue
        if answer.get("status") == "success":
            ran += 1
            results.extend(answer["results"])
        else:
            refused.append({"workspace_id": ws, "reason": answer.get("reason") or answer.get("status"),
                            "files": [_record_key(r) for r in group_event["Records"]]})
    if first_error is not None:
        raise first_error
    combined: dict = {
        "status": "success" if not refused else ("partial" if ran else "refused"),
        "files_processed": len(results),
        "items_processed": sum(r["items_processed"] for r in results),
        "results": results,
    }
    if refused:
        combined["refused"] = refused
    return combined


def _handle_in_workspace(scope: WorkspaceScope | None, event: Mapping) -> dict:
    """``lambda_handler``'s body, in the workspace the event named, or deployment-wide (scope None)."""
    execution_id = event.get("execution_id") if isinstance(event.get("execution_id"), str) else None
    records = event.get("Records") or []
    if not records and not execution_id:
        logger.info("No S3 records in event, nothing to do")
        return {"status": "skipped", "reason": "no records"}

    reprocess = event.get("reprocess") is True
    started_by = event.get("started_by") if isinstance(event.get("started_by"), str) else None
    ingestor = S3ImportIngestor(scope, execution_id=execution_id, started_by=started_by)
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
