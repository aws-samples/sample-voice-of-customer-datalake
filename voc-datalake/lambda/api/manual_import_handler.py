"""
Manual Import API Lambda - Handles /scrapers/manual/*
Lets an admin paste raw review text and have it parsed by LLM, or upload CSV / JSON rows.

ADMIN ONLY, every route (owner decision 2026-10-08, #242 follow-up): each one writes
feedback content into the pipeline (the raw archive and the enrichment queue that
Bedrock drains) or reads a parse job of it, so importing data is an administrator's
action, like configuring a scraper. Enforced by one resolver middleware
(`shared.api.admins_only`), so a route added later is gated without having to remember the check.
"""

import csv
import hashlib
import io
import json
import os
import sys
import time
import unicodedata
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_sqs.type_defs import SendMessageBatchRequestEntryTypeDef

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.api import admins_only, api_handler, create_api_resolver, decimal_default
from shared.aws import get_dynamodb_resource, get_s3_client, get_sqs_client, invoke_lambda_async
from shared.csv_columns import ColumnPlan, bounded_metadata, plan_columns
from shared.csv_content_digest import csv_row_digest
from shared.csv_dataset_plan import CsvDatasetPlan, StoredRowsUnreadable, plan_dataset_rows, preview_view
from shared.csv_datasets import csv_row_id_v2, dataset_key
from shared.exceptions import (
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.import_runs import (
    ImportCounts,
    ImportRun,
    actor_from_event,
    get_import_run,
    list_import_runs,
    parse_limit,
    record_import_run,
)
from shared.ingest_archive import DEFAULT_UPLOAD_SOURCE, prepare_messages, stamp_file_archive, upload_profile
from shared.logging import logger, tracer
from shared.producer_labels import message_labels
from shared.radar_brands import radar_brand_setting, radar_stamp
from shared.request_body import json_object_body
from shared.timestamps import now_iso

dynamodb = get_dynamodb_resource()
sqs = get_sqs_client()
s3 = get_s3_client()

AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
# Read only by a CSV dataset upload (issue #411): BatchGetItem of the rows it names.
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None

app = create_api_resolver()


# Every manual-import route is admin-only (403 otherwise). See the module docstring.
app.use(middlewares=[admins_only])

MAX_CHARACTERS = 10000
JOB_TTL_SECONDS = 3600  # 1 hour

# Domain to source mapping for URL detection
DOMAIN_TO_SOURCE = {
    'g2.com': 'g2',
    'www.g2.com': 'g2',
    'capterra.com': 'capterra',
    'www.capterra.com': 'capterra',
}

MANUAL_IMPORT_PROCESSOR_FUNCTION = os.environ.get('MANUAL_IMPORT_PROCESSOR_FUNCTION', '')

# What an S3/SQS write raises. The archive and enqueue steps degrade on exactly
# these (the row is reported, the request still answers); anything else is a bug.
_AWS_WRITE_ERRORS = (ClientError, BotoCoreError)


def _caller_user_id() -> str:
    """The caller's Cognito subject (or username) off the authorizer claims; 'unknown' without one."""
    try:
        authorizer = app.current_event.request_context.authorizer
    except KeyError:
        # An event with no requestContext at all.
        return 'unknown'
    claims = authorizer.get('claims') or {}
    try:
        return claims.get('sub', claims.get('cognito:username', 'unknown'))
    except AttributeError:
        # Claims that are not a mapping.
        return 'unknown'


def _record_run(method: str, source: str, started_at: datetime, counts: ImportCounts, **fields: Any) -> None:
    """Write this request's import-history record (docs/import-history.md); never raises.

    The response is left unchanged: the run shows up in ``GET /scrapers/manual/history``.
    """
    actor, actor_email = actor_from_event(app.current_event.raw_event)
    record_import_run(aggregates_table, ImportRun(
        method=method, source=source, actor=actor, actor_email=actor_email,
        started_at=started_at.isoformat(), counts=counts, **fields,
    ))


def _radar_key(radar: dict[str, str] | None) -> str:
    """The Radar brand key of an upload's stamp ('' for our own feedback)."""
    return radar.get('radar_brand_key', '') if radar else ''


def _job_key(job_id: str) -> dict:
    """Generate DynamoDB key for a manual import job."""
    return {'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'}

def extract_source_from_url(url: str) -> str:
    """Extract source origin from URL domain."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        hostname = hostname.lower()

        # Return unknown for empty hostname (invalid URL)
        if not hostname:
            return "unknown"

        # Check direct mapping
        if hostname in DOMAIN_TO_SOURCE:
            return DOMAIN_TO_SOURCE[hostname]

        # Strip www. and check again
        if hostname.startswith('www.'):
            hostname = hostname[4:]
            if hostname in DOMAIN_TO_SOURCE:
                return DOMAIN_TO_SOURCE[hostname]

        # Return sanitized domain for unknown sources
        return hostname.replace('www.', '')
    except (ValueError, TypeError, AttributeError) as e:
        # ValueError: a malformed netloc (e.g. a bad IPv6 literal); the other two:
        # a non-string url.
        logger.warning(f"Failed to parse URL '{url}': {e}")
        return "unknown"


@app.post("/scrapers/manual/parse")
@tracer.capture_method
def start_parse():
    """Start async parse job."""
    if not aggregates_table:
        raise ConfigurationError('AGGREGATES_TABLE not configured')

    if not MANUAL_IMPORT_PROCESSOR_FUNCTION:
        raise ConfigurationError('MANUAL_IMPORT_PROCESSOR_FUNCTION not configured')

    body = json_object_body(app)
    source_url = body.get('source_url', '').strip()
    raw_text = body.get('raw_text', '').strip()

    if not source_url:
        raise ValidationError('Source URL is required')

    if not raw_text:
        raise ValidationError('Raw text is required')

    if len(raw_text) > MAX_CHARACTERS:
        raise ValidationError(f'Text exceeds maximum of {MAX_CHARACTERS} characters')

    source_origin = extract_source_from_url(source_url)
    job_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    ttl = int(time.time()) + JOB_TTL_SECONDS

    # Create job record
    aggregates_table.put_item(Item={
        'pk': _job_key(job_id)['pk'],
        'sk': 'JOB',
        'status': 'processing',
        'source_url': source_url,
        'source_origin': source_origin,
        'raw_text': raw_text,
        'reviews': [],
        'unparsed_sections': [],
        'error': None,
        'created_at': now.isoformat(),
        'ttl': ttl
    })

    # Invoke async processing
    try:
        invoke_lambda_async(MANUAL_IMPORT_PROCESSOR_FUNCTION, {'job_id': job_id})
    except Exception as e:
        logger.exception(f"Failed to invoke processor: {e}")
        # Update job status to failed
        aggregates_table.update_item(
            Key=_job_key(job_id),
            UpdateExpression='SET #status = :status, #error = :error',
            ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
            ExpressionAttributeValues={':status': 'failed', ':error': str(e)}
        )
        raise ServiceError('Failed to start processing') from e

    return {'success': True, 'job_id': job_id, 'source_origin': source_origin}


def _require_job(job_id: str, not_found_message: str) -> dict:
    """The job record for `job_id`; NotFoundError when there is none."""
    if aggregates_table is None:
        raise ConfigurationError('Table not configured')
    item = aggregates_table.get_item(Key=_job_key(job_id)).get('Item')
    if not item:
        raise NotFoundError(not_found_message)
    return item


def _parse_status_view(item: dict) -> dict:
    """What GET /scrapers/manual/parse/<job_id> reports about a job record."""
    result = {
        'status': item.get('status', 'unknown'),
        'source_origin': item.get('source_origin'),
        'source_url': item.get('source_url'),
    }
    if item.get('status') == 'completed':
        result['reviews'] = item.get('reviews', [])
        result['unparsed_sections'] = item.get('unparsed_sections', [])
    elif item.get('status') == 'failed':
        result['error'] = item.get('error', 'Unknown error')
    return result


@app.get("/scrapers/manual/parse/<job_id>")
@tracer.capture_method
def get_parse_status(job_id: str):
    """Get parse job status."""
    if not aggregates_table:
        raise ConfigurationError('Table not configured')

    try:
        result = _parse_status_view(_require_job(job_id, f'Job {job_id} not found'))
    except (ConfigurationError, NotFoundError):
        raise
    except Exception as e:
        logger.exception(f"Failed to get job status: {e}")
        raise ServiceError('Failed to retrieve job status') from e
    return result


def _validate_review_dates(reviews: list[dict]) -> None:
    """Every confirmed review must carry a date; name the ones that do not (1-based)."""
    missing = [idx for idx, review in enumerate(reviews, start=1) if not review.get('date')]
    if len(missing) == 1:
        raise ValidationError(f'Review {missing[0]} is missing a date. All reviews must have a date.')
    if missing:
        raise ValidationError(f'Reviews {", ".join(map(str, missing))} are missing dates. All reviews must have a date.')


def _archive_confirmed_import(job: dict, job_id: str, reviews: list[dict], user_id: str, now: datetime) -> str | None:
    """Store the job and the reviews as confirmed to S3; the object's URI, or None if not stored."""
    if not RAW_DATA_BUCKET:
        return None
    s3_key = f"raw/manual_import/{now.year}/{now.month:02d}/{now.day:02d}/{job_id}.json"
    s3_data = {
        'job_id': job_id,
        'source_url': job.get('source_url', ''),
        'source_origin': job.get('source_origin', 'unknown'),
        'raw_text': job.get('raw_text', ''),
        'llm_response': {'reviews': job.get('reviews', [])},
        'final_reviews': reviews,
        'imported_at': now.isoformat(),
        'imported_by': user_id
    }
    try:
        s3.put_object(
            Bucket=RAW_DATA_BUCKET,
            Key=s3_key,
            Body=json.dumps(s3_data, default=decimal_default),
            ContentType='application/json'
        )
    except _AWS_WRITE_ERRORS as e:
        logger.warning(f"Failed to store to S3: {e}")
        return None
    return f"s3://{RAW_DATA_BUCKET}/{s3_key}"


def _confirmed_review_message(review: dict, idx: int, job: dict, job_id: str, s3_uri: str | None) -> dict:
    """The processing-queue message for the `idx`-th confirmed review of a job."""
    source_origin = job.get('source_origin', 'unknown')
    source_url = job.get('source_url', '')
    return {
        'id': f"manual-{job_id}-{idx}",
        'source_platform': 'manual_import',
        'source_origin': source_origin,
        'source_channel': source_origin,  # Use detected source as channel
        'source_url': source_url,
        'url': source_url,  # Processor expects 'url' field
        'ingestion_method': 'manual',
        'manual_import_job_id': job_id,
        'text': review.get('text', ''),
        'rating': review.get('rating'),
        'author': review.get('author'),
        'title': review.get('title'),
        'created_at': review.get('date'),  # Processor expects 'created_at'
        's3_raw_uri': s3_uri,
    }


def _import_confirmed_reviews(job: dict, job_id: str, reviews: list[dict]) -> dict:
    """Apply the source policy, archive, enqueue one message per review, mark the job imported."""
    now = datetime.now(UTC)
    profile = upload_profile(aggregates_table, DEFAULT_UPLOAD_SOURCE)
    messages, mode = prepare_messages(
        s3, RAW_DATA_BUCKET,
        [_confirmed_review_message(review, idx, job, job_id, None) for idx, review in enumerate(reviews)],
        profile, now,
    )
    s3_uri = stamp_file_archive(
        messages, mode, lambda: _archive_confirmed_import(job, job_id, reviews, _caller_user_id(), now))

    imported_count = 0
    errors = []
    for idx, message in enumerate(messages):
        try:
            if PROCESSING_QUEUE_URL:
                sqs.send_message(
                    QueueUrl=PROCESSING_QUEUE_URL,
                    MessageBody=json.dumps(message)
                )
            imported_count += 1
        except _AWS_WRITE_ERRORS as e:
            logger.warning(f"Failed to send review {idx} to SQS: {e}")
            errors.append(f"Review {idx}: {e!s}")

    if aggregates_table is None:
        raise ConfigurationError('Table not configured')
    aggregates_table.update_item(
        Key=_job_key(job_id),
        UpdateExpression='SET #status = :status, imported_count = :count, imported_at = :at',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'imported',
            ':count': imported_count,
            ':at': now.isoformat()
        }
    )

    result = {
        'success': True,
        'imported_count': imported_count,
        's3_uri': s3_uri
    }
    if errors:
        result['errors'] = errors
    _record_run('paste', str(job.get('source_origin') or 'unknown'), now, ImportCounts(
        received=len(reviews), imported=imported_count,
        skipped=len(reviews) - len(messages), failed=len(messages) - imported_count,
    ), source_id=profile['id'], errors=errors, raw_s3_key=s3_uri)
    return result


@app.post("/scrapers/manual/confirm")
@tracer.capture_method
def confirm_import():
    """Confirm and import parsed reviews."""
    body = json_object_body(app)
    job_id = body.get('job_id')
    reviews = body.get('reviews', [])

    if not job_id:
        raise ValidationError('Job ID is required')

    if not reviews:
        raise ValidationError('No reviews to import')

    _validate_review_dates(reviews)

    # Get job details
    if not aggregates_table:
        raise ConfigurationError('Table not configured')

    try:
        result = _import_confirmed_reviews(_require_job(job_id, 'Job not found'), job_id, reviews)
    except (ValidationError, ConfigurationError, NotFoundError):
        raise
    except Exception as e:
        logger.exception(f"Failed to confirm import: {e}")
        raise ServiceError('Failed to import reviews') from e
    return result


# Max rows per CSV/JSON upload. Rows are pushed to SQS in batches of 10 (see
# _send_items_to_sqs), so even tens of thousands send well within the API
# Gateway 29s / Lambda timeout. Bumped from 500 once batch-send was added.
# Practical sync-path ceiling is ~9k rows (measured ~15.7s for 5k) — beyond
# that, use the S3 import path.
MAX_JSON_UPLOAD_ITEMS = 50000

MAX_CSV_BYTES = 10 * 1024 * 1024  # 10 MB

# Longest assistant-reported `source_label` kept on an import-history record.
MAX_SOURCE_LABEL_CHARS = 120

# Bound on the informational copy of a row's own identifier. Mirrors
# `IngestMessage.csv_row_id`'s max_length: this Lambda's bundle does not include
# the plugin schema package, so the value is restated rather than imported. Keep
# the two in step — exceeding the model's bound would reject the whole message.
MAX_CSV_ROW_ID_LENGTH = 256


# ── CSV row identity ────────────────────────────────────────────────────────
#
# The processor derives BOTH its idempotency key and its DynamoDB item key from
# `source_platform + id`, and `source_platform` is the constant 'manual_import'
# for every CSV upload. The id emitted here is therefore the only thing that
# separates one imported row from another — including rows in a different file
# that reuse the same `id` column value, which is what made two files numbered
# 1..400 collapse into a single 400-row set.
#
# Identity is a SHA-256 over the version tag followed by these fields, in this
# order. Both the order and the normalization are a PERSISTED CONTRACT: rows
# already stored were keyed with this recipe, so changing it re-keys them and
# every prior upload would re-import as new records. Add a new version tag
# instead of editing v1.
CSV_ROW_ID_VERSION = 'csv-row-v1'
CSV_ROW_ID_FIELDS = (
    'source_id',   # the row's own id/review_id column; '' when absent
    'row_index',   # 1-based position; '' when the row HAS an id
    'text',
    'rating',
    'created_at',  # the row's own date column, NOT the import-time default
    'author',
    'title',
    'url',
    'source',      # the row's own source column, NOT the request default_source
)


def _csv_row_id(fields: dict[str, str]) -> str:
    """
    Return the identity of one CSV row from its normalized column values.

    Raises KeyError when a field named in the contract is missing, so a partial
    call fails at the first test rather than silently keying rows differently.
    """
    payload = json.dumps(
        [CSV_ROW_ID_VERSION, *(fields[name] for name in CSV_ROW_ID_FIELDS)],
        ensure_ascii=False,
        separators=(',', ':'),  # pragma: no mutate  the payload is a list, so the key separator is never emitted
    )
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()[:32]


def _send_items_to_sqs(messages: list[dict], label: str = 'row') -> tuple[int, list[str]]:
    """
    Push messages to the processing queue using SendMessageBatch (10 per call).

    Batching cuts the number of SQS round-trips ~10x vs one send_message per
    row, so tens of thousands of rows enqueue within the API Gateway 29s window.
    When no queue is configured (local/test), this is a no-op that reports all
    messages as imported — matching the pre-batching json-upload behavior.
    Returns (imported_count, errors).
    """
    if not PROCESSING_QUEUE_URL:
        return len(messages), []

    imported = 0
    errors: list[str] = []
    for start in range(0, len(messages), 10):
        chunk = messages[start:start + 10]
        entries: list[SendMessageBatchRequestEntryTypeDef] = [
            {'Id': str(i), 'MessageBody': json.dumps(msg)}
            for i, msg in enumerate(chunk)
        ]
        try:
            resp = sqs.send_message_batch(QueueUrl=PROCESSING_QUEUE_URL, Entries=entries)
            imported += len(resp.get('Successful', []))
            for failed in resp.get('Failed', []):
                row = start + int(failed.get('Id', 0))
                errors.append(f"{label} {row}: {failed.get('Message', 'send failed')}")
        except _AWS_WRITE_ERRORS as e:
            logger.warning(f"Failed to send SQS batch at {label} {start}: {e}")
            errors.append(f"{label}s {start}-{start + len(chunk) - 1}: {e!s}")
    return imported, errors



def _csv_column(row: dict, headers: list[str]) -> str:
    """The first non-blank value, stripped, among the actual CSV columns `headers`."""
    for actual in headers:
        value = row.get(actual)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ''


def _row_extras(row: dict, plan: ColumnPlan, idx: int, warnings: list[str]) -> dict:
    """A row's metadata (unmapped columns), dimension columns and tags, ready for its message."""
    metadata, dropped = bounded_metadata({header: row.get(header) or '' for header in plan.metadata})
    if dropped:
        warnings.append(f'row {idx}: {len(dropped)} extra column(s) over the metadata limits — not kept')
    tags = ','.join(str(row.get(header) or '') for header in plan.single.get('tags', []))
    labels = message_labels({key: row.get(header) or '' for key, header in plan.dimensions.items()}, tags)
    return {**({'metadata': metadata} if metadata else {}), **labels}


@dataclass
class CsvRowDrops:
    """The rows ``_parse_csv_to_items`` dropped, counted where it drops them (the import-history counts)."""

    skipped: int = 0
    duplicate: int = 0


def _parse_csv_to_items(
    csv_text: str, default_source: str, column_map: object = None, dataset: str | None = None,
    profile: Mapping[str, Any] | None = None,
    drops: CsvRowDrops | None = None,
) -> tuple[list[dict], list[str]]:
    """Parse CSV text into the same item shape as json_upload. Returns (items, warnings).

    With a ``dataset`` (``shared.csv_datasets.dataset_key``), a row carrying its own id is
    keyed ``csv-row-v2`` and gets a ``content_hash`` under the upload's source ``profile``
    (``shared.csv_content_digest``; no profile = ``allow``); every other row keeps ``csv-row-v1``.
    ``drops``, when given, counts the rows left out (empty text, duplicate), so callers never parse warning text.
    """
    items: list[dict] = []
    drops = drops if drops is not None else CsvRowDrops()

    # csv.DictReader handles quoted commas, embedded newlines, and BOM.
    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames:
        raise ValidationError('CSV is empty or has no header row')

    try:
        plan, warnings = plan_columns([h for h in reader.fieldnames if h], column_map)
    except ValueError as e:
        raise ValidationError(str(e)) from e

    def col(row: dict, target: str) -> str:
        return _csv_column(row, plan.single.get(target, []))

    if 'text' not in plan.single:
        raise ValidationError(
            'CSV must include a "text" column (also accepted: review / comment / feedback)'
        )

    seen_row_ids: set[str] = set()
    for idx, row in enumerate(reader, start=1):
        text = col(row, 'text')
        if not text:
            warnings.append(f'row {idx}: empty text — skipped')
            drops.skipped += 1
            continue

        source_id = col(row, 'id')
        rating_raw = col(row, 'rating')
        created_at_raw = col(row, 'date')
        author = col(row, 'author')
        title = col(row, 'title')
        url = col(row, 'url')
        source_column = col(row, 'channel')

        v1_id = _csv_row_id({
            'source_id': source_id,
            # A row carrying an id is identified by it, so the file can be
            # reordered without re-keying. A row without one has nothing but
            # its position to distinguish it, so two rows reading "Good" stay
            # two rows instead of collapsing into one.
            'row_index': '' if source_id else str(idx),
            'text': text,
            'rating': rating_raw,
            'created_at': created_at_raw,
            'author': author,
            'title': title,
            'url': url,
            'source': source_column,
        })
        feedback_id = csv_row_id_v2(dataset, source_id) if dataset and source_id else v1_id

        if feedback_id in seen_row_ids:
            warnings.append(f'row {idx}: duplicate row — skipped' if feedback_id == v1_id
                            else f'row {idx}: its id appears again in this dataset — skipped')
            drops.duplicate += 1
            continue
        seen_row_ids.add(feedback_id)

        rating = None
        if rating_raw:
            try:
                rating = int(float(rating_raw))
            except (ValueError, TypeError):
                warnings.append(f'row {idx}: rating is not a number — left blank')

        created_at = created_at_raw or now_iso()

        # The customer's own row identifier, kept so an operator can still answer
        # "find the record for review_id 4711". It is deliberately NOT the item
        # id: it is unique only within one file. The fingerprint above consumed
        # it at full length; this carried copy is informational and has to fit
        # the message schema's bound. An over-long value is dropped rather than
        # truncated, because a truncated identifier would not match what an
        # operator searches for — and dropping it must not cost us the row.
        csv_row_id = source_id
        if len(csv_row_id) > MAX_CSV_ROW_ID_LENGTH:
            warnings.append(
                f'row {idx}: id exceeds {MAX_CSV_ROW_ID_LENGTH} characters — '
                'not kept for lookup, row imported'
            )
            csv_row_id = ''

        item = {
            'id': feedback_id,
            'row': idx,
            'csv_row_id': csv_row_id,
            'text': text,
            'rating': rating,
            'author': author,
            'title': title,
            'url': url,
            'timestamp': created_at,
            'source': source_column or default_source,
            **_row_extras(row, plan, idx, warnings),
        }
        if feedback_id != v1_id and dataset:
            item.update(_dataset_stamp(item, dataset, created_at_raw, profile or {}))
        items.append(item)

    return items, warnings


def _dataset_stamp(item: dict, dataset: str, created_at_raw: str, profile: Mapping[str, Any]) -> dict:
    """``csv_dataset`` + ``content_hash`` of a ``csv-row-v2`` row (``shared.csv_content_digest``)."""
    return {
        'csv_dataset': dataset,
        'dated': bool(created_at_raw),
        'content_hash': csv_row_digest({
            'text': item['text'],
            'rating': item['rating'],
            # The file's own date: a dateless row's import-time default must not read as an edit.
            'created_at': created_at_raw,
            'author': item['author'],
            'title': item['title'],
            'url': item['url'],
            'channel': item['source'],
            'metadata': item.get('metadata') or {},
        }, profile),
    }


def _upload_context(body: dict) -> tuple[dict, str, datetime, str]:
    """``(source profile, caller, now, job id)`` for one CSV / JSON upload."""
    profile = upload_profile(aggregates_table, body.get('source_id'))
    return profile, _caller_user_id(), datetime.now(UTC), str(uuid.uuid4())


def _upload_radar_stamp(body: dict) -> dict[str, str]:
    """The optional ``radar_brand`` of a CSV / JSON upload (a Radar brand key, docs/radar.md) as a message stamp; 400 when malformed."""
    try:
        return radar_stamp(radar_brand_setting(body.get('radar_brand')))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _csv_message(item: dict, source_id: str, radar: dict[str, str] | None = None) -> dict:
    """The processing-queue message for one parsed CSV row filed under ``source_id``.

    ``radar`` (``shared.radar_brands.radar_stamp``) sends the row to a Radar brand instead of our feedback.
    """
    message = {
        'id': item['id'],
        'csv_row_id': item.get('csv_row_id') or None,
        'source_platform': source_id,
        'source_channel': item['source'],
        'ingestion_method': 'csv_upload',
        'text': item['text'],
        'rating': item.get('rating'),
        'author': item.get('author'),
        'title': item.get('title'),
        'url': item.get('url'),
        'created_at': item['timestamp'],
        's3_raw_uri': None,
        **(radar or {}),
    }
    for key in ('metadata', 'dimensions', 'tags'):
        if item.get(key):
            message[key] = item[key]
    if item.get('content_hash'):
        message['csv_dataset'] = item['csv_dataset']
        message['csv_content_hash'] = item['content_hash']
    if item.get('csv_replace'):
        message['csv_replace'] = True
    return message


def _upload_dataset(body: dict, radar: dict[str, str]) -> str | None:
    """The upload's normalised dataset key (``shared.csv_datasets.dataset_key``); 400 when malformed."""
    try:
        dataset = dataset_key(body.get('dataset_name'))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if dataset and radar:
        # Radar rows live in voc-radar, which has no update path: refuse rather than half-apply.
        raise ValidationError('dataset_name cannot be combined with radar_brand')
    return dataset


def _dataset_plan(source_id: str, items: list[dict]) -> CsvDatasetPlan:
    """The upload's rows by new / changed / unchanged / v1 (``shared.csv_dataset_plan``); 503 when unreadable."""
    if feedback_table is None:
        raise ConfigurationError('FEEDBACK_TABLE not configured')
    try:
        return plan_dataset_rows(feedback_table, source_id, items)
    except (StoredRowsUnreadable, *_AWS_WRITE_ERRORS) as e:
        logger.warning(f"CSV dataset rows could not be read: {e}")
        raise ServiceUnavailableError('Stored rows could not be read; try the upload again') from e


def _confirmed_update(item: dict, stored: dict) -> dict:
    """A changed row as queued: marked ``csv_replace``; a dateless row keeps the stored review date."""
    update = {**item, 'csv_replace': True}
    if not item.get('dated') and stored.get('source_created_at'):
        update['timestamp'] = stored['source_created_at']
    return update


def _rows_to_queue(plan: CsvDatasetPlan) -> list[dict]:
    """v1 + new rows as ever, confirmed updates marked, unchanged rows left out; in file order."""
    rows = [*plan.v1_rows, *plan.new, *(_confirmed_update(item, stored) for item, stored in plan.changed)]
    return sorted(rows, key=lambda item: item.get('row') or 0)


def _archive_csv_file(
    csv_text: str, job_id: str, user_id: str, default_source: str, source_id: str, now: datetime,
) -> str | None:
    """Keep the whole uploaded file (allow + keep-forever sources only); its URI, or None."""
    if not RAW_DATA_BUCKET:
        return None
    s3_key = f"raw/csv_upload/{now.year}/{now.month:02d}/{now.day:02d}/{job_id}.csv"
    try:
        s3.put_object(
            Bucket=RAW_DATA_BUCKET,
            Key=s3_key,
            Body=csv_text.encode('utf-8'),
            ContentType='text/csv; charset=utf-8',
            Metadata={'uploaded_by': user_id, 'default_source': default_source, 'source_id': source_id},
        )
    except _AWS_WRITE_ERRORS as e:
        logger.warning(f"Failed to store CSV upload to S3: {e}")
        return None
    return f"s3://{RAW_DATA_BUCKET}/{s3_key}"


@app.post("/scrapers/manual/csv-upload")
@tracer.capture_method
def csv_upload():
    """
    Import customer feedback rows from a CSV file. The frontend posts the raw CSV
    text in `csv_text` plus an optional `default_source` label; we parse it, save
    the original to S3 for archival, then push each row to the same SQS queue
    that downstream Bedrock enrichment + DynamoDB storage already drains. End
    result: rows show up in the feedback table the same way iOS/Android reviews do.
    """
    body = json_object_body(app)
    csv_text = body.get('csv_text', '')
    default_source = (body.get('default_source') or 'csv_upload').strip() or 'csv_upload'
    radar = _upload_radar_stamp(body)
    dataset = _upload_dataset(body, radar)

    if not isinstance(csv_text, str) or not csv_text.strip():
        raise ValidationError('csv_text is required')
    if len(csv_text.encode('utf-8')) > MAX_CSV_BYTES:
        raise ValidationError(f'CSV exceeds {MAX_CSV_BYTES // (1024 * 1024)} MB limit')

    # The profile first: a dataset row's digest is computed under its PII policy (shared.csv_content_digest).
    profile, user_id, now, job_id = _upload_context(body)
    drops = CsvRowDrops()
    items, warnings = _parse_csv_to_items(csv_text, default_source, body.get('column_map'),
                                          dataset=dataset, profile=profile, drops=drops)
    if not items:
        raise ValidationError('CSV produced no valid rows. ' + '; '.join(warnings[:5]))
    if len(items) > MAX_JSON_UPLOAD_ITEMS:
        raise ValidationError(
            f'Maximum {MAX_JSON_UPLOAD_ITEMS} rows per upload (got {len(items)}). '
            'Split the file and try again.'
        )
    plan = _dataset_plan(profile['id'], items) if dataset else CsvDatasetPlan(v1_rows=items)
    if body.get('dry_run') is True:
        return _csv_preview(plan, len(items), warnings)
    if plan.changed and body.get('apply_updates') is not True:
        raise ConflictError(
            f'This upload changes {len(plan.changed)} stored row(s): preview it (dry_run) '
            'and confirm the updates (apply_updates) to apply them')
    queued = _rows_to_queue(plan)

    messages, mode = prepare_messages(s3, RAW_DATA_BUCKET,
                                      [_csv_message(item, profile['id'], radar) for item in queued], profile, now,
                                      plan.archive_rewrites())
    s3_uri = stamp_file_archive(
        messages, mode, lambda: _archive_csv_file(csv_text, job_id, user_id, default_source, profile['id'], now))
    imported_count, send_errors = _send_items_to_sqs(messages)

    result: dict = {
        'success': True,
        'imported_count': imported_count,
        'total_rows': len(items),
        's3_uri': s3_uri,
        **({'radar_brand': radar['radar_brand_key']} if radar else {}),
        **({'counts': plan.counts()} if dataset else {}),
    }
    if warnings:
        result['warnings'] = warnings[:20]
    if send_errors:
        result['errors'] = send_errors
    _record_run('csv', default_source, now, _csv_counts(items, messages, drops, imported_count),
                run_id=job_id, source_id=profile['id'], warnings=warnings, errors=send_errors,
                raw_s3_key=s3_uri, radar_brand=_radar_key(radar))
    return result


def _csv_counts(items: list[dict], messages: list[dict], drops: CsvRowDrops, imported: int) -> ImportCounts:
    """An upload's counts: the parser's skipped / duplicate rows, policy drops, and send failures."""
    return ImportCounts(received=len(items) + drops.skipped + drops.duplicate, imported=imported,
                        skipped=drops.skipped + len(items) - len(messages), duplicate=drops.duplicate,
                        failed=len(messages) - imported)


def _csv_preview(plan: CsvDatasetPlan, total_rows: int, warnings: list[str]) -> dict:
    """The dry-run answer: nothing archived or queued, only what the upload would do."""
    view = preview_view(feedback_table, plan) if plan.changed else {
        'counts': plan.counts(), 'changed_rows': [], 'changed_rows_truncated': False}
    return {'success': True, 'dry_run': True, 'total_rows': total_rows, **view,
            **({'warnings': warnings[:20]} if warnings else {})}


def _json_upload_item_errors(items: list) -> list[str]:
    """One message per missing/invalid required field (text, id, source, timestamp)."""
    errors = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f'Item {idx}: must be an object')
            continue
        text = item.get('text', '')
        if not isinstance(text, str) or not text.strip():
            errors.append(f'Item {idx}: "text" is required and must be a non-empty string')
        if not item.get('id'):
            errors.append(f'Item {idx}: "id" is required for deduplication')
        if not (item.get('source') or item.get('source_channel')):
            errors.append(f'Item {idx}: "source" is required')
        if not (item.get('timestamp') or item.get('created_at')):
            errors.append(f'Item {idx}: "timestamp" is required (ISO 8601 format)')
    return errors


def _json_upload_message(item: dict, s3_uri: str | None, source_id: str = DEFAULT_UPLOAD_SOURCE,
                         radar: dict[str, str] | None = None) -> dict:
    """The processing-queue message for one validated json-upload item.

    ``radar`` (``shared.radar_brands.radar_stamp``) sends the item to a Radar brand instead of our feedback.
    """
    message = {
        'id': item.get('id', ''),
        'source_platform': source_id,
        'source_channel': item.get('source') or item.get('source_channel'),
        'ingestion_method': 'json_upload',
        'text': item.get('text', '').strip(),
        'rating': item.get('rating'),
        'author': item.get('user_id') or item.get('author'),
        'title': item.get('title'),
        'url': item.get('url'),
        'created_at': item.get('timestamp') or item.get('created_at'),
        's3_raw_uri': s3_uri,
        **(radar or {}),
    }
    # Pass through metadata if present
    if item.get('metadata') and isinstance(item['metadata'], dict):
        message['metadata'] = item['metadata']
    message.update(message_labels(item.get('dimensions'), item.get('tags')))
    return message


def _archive_json_file(items: list, job_id: str, user_id: str, now: datetime) -> str | None:
    """Keep the whole uploaded JSON (allow + keep-forever sources only); its URI, or None."""
    if not RAW_DATA_BUCKET:
        return None
    s3_key = f"raw/json_upload/{now.year}/{now.month:02d}/{now.day:02d}/{job_id}.json"
    try:
        s3.put_object(
            Bucket=RAW_DATA_BUCKET,
            Key=s3_key,
            Body=json.dumps({
                'job_id': job_id,
                'items': items,
                'uploaded_at': now.isoformat(),
                'uploaded_by': user_id,
            }, default=decimal_default),
            ContentType='application/json',
        )
    except (*_AWS_WRITE_ERRORS, TypeError, ValueError) as e:
        # TypeError/ValueError: an item json.dumps cannot serialise.
        logger.warning(f"Failed to store JSON upload to S3: {e}")
        return None
    return f"s3://{RAW_DATA_BUCKET}/{s3_key}"


@app.post("/scrapers/manual/json-upload")
@tracer.capture_method
def json_upload():
    """Import pre-structured JSON feedback items directly into the pipeline."""
    body = json_object_body(app)
    items = body.get('items', [])
    radar = _upload_radar_stamp(body)

    if not isinstance(items, list) or len(items) == 0:
        raise ValidationError('Request must contain a non-empty "items" array')

    if len(items) > MAX_JSON_UPLOAD_ITEMS:
        raise ValidationError(f'Maximum {MAX_JSON_UPLOAD_ITEMS} items per upload')

    # Validate required fields: text, id, source, timestamp
    errors = _json_upload_item_errors(items)
    if errors:
        raise ValidationError(f'Validation failed: {"; ".join(errors[:10])}')
    profile, user_id, now, job_id = _upload_context(body)

    # Send items to SQS in batches of 10. With the 50k cap, per-item
    # send_message would exceed the API Gateway 29s window; batching keeps
    # large uploads inside it.
    messages, mode = prepare_messages(
        s3, RAW_DATA_BUCKET, [_json_upload_message(item, None, profile['id'], radar) for item in items], profile, now)
    s3_uri = stamp_file_archive(messages, mode, lambda: _archive_json_file(items, job_id, user_id, now))

    imported_count, send_errors = _send_items_to_sqs(messages, label='item')

    result = {
        'success': True,
        'imported_count': imported_count,
        'total_items': len(items),
        's3_uri': s3_uri,
        **({'radar_brand': radar['radar_brand_key']} if radar else {}),
    }

    if send_errors:
        result['errors'] = send_errors

    method, source = _json_run_origin(body, profile['id'])
    _record_run(method, source, now, ImportCounts(
        received=len(items), imported=imported_count,
        skipped=len(items) - len(messages), failed=len(messages) - imported_count,
    ), run_id=job_id, source_id=profile['id'], errors=send_errors, raw_s3_key=s3_uri,
        radar_brand=_radar_key(radar))
    return result


def _json_run_origin(body: dict, source_id: str) -> tuple[str, str]:
    """``(method, source label)`` of a JSON upload's history record.

    The assistant's ``import_reviews`` sends ``import_origin: 'assistant'`` and the
    ``source_label`` the user named; any other caller is a plain ``json`` upload
    labelled with the source profile id. Both fields are client-reported (an audit
    hint, not proof), so the label is honoured only for the assistant origin, with
    control/format characters removed and at most ``MAX_SOURCE_LABEL_CHARS`` kept.
    """
    if body.get('import_origin') != 'assistant':
        return 'json', source_id
    label = body.get('source_label')
    if not isinstance(label, str):
        return 'assistant', source_id
    cleaned = ''.join(ch for ch in label if unicodedata.category(ch) not in ('Cc', 'Cf')).strip()
    return 'assistant', cleaned[:MAX_SOURCE_LABEL_CHARS].strip() or source_id


@app.get("/scrapers/manual/history")
@tracer.capture_method
def list_import_history():
    """Import runs, newest first (docs/import-history.md): ``?limit=`` (1-100, default 25), ``?cursor=``."""
    if aggregates_table is None:
        raise ConfigurationError('Table not configured')
    params = app.current_event.query_string_parameters or {}
    try:
        limit = parse_limit(params.get('limit'))
        runs, next_cursor = list_import_runs(aggregates_table, limit=limit, cursor=params.get('cursor') or None)
    except ValueError as e:
        raise ValidationError('limit or cursor is not valid') from e
    return {'runs': runs, 'next_cursor': next_cursor}


@app.get("/scrapers/manual/history/<run_id>")
@tracer.capture_method
def get_import_history_run(run_id: str):
    """One import run with its warnings and errors; 404 when unknown or expired."""
    if aggregates_table is None:
        raise ConfigurationError('Table not configured')
    run = get_import_run(aggregates_table, run_id)
    if run is None:
        raise NotFoundError('Import run not found')
    return {'run': run}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
