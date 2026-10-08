"""
Manual Import API Lambda - Handles /scrapers/manual/*
Allows users to paste raw review text and have it parsed by LLM.
"""

import csv
import hashlib
import io
import json
import os
import sys
import time
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_sqs.type_defs import SendMessageBatchRequestEntryTypeDef

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.api import api_handler, create_api_resolver, decimal_default
from shared.aws import get_dynamodb_resource, get_s3_client, get_sqs_client, invoke_lambda_async
from shared.csv_columns import ColumnPlan, bounded_metadata, plan_columns
from shared.exceptions import ConfigurationError, NotFoundError, ServiceError, ValidationError
from shared.ingest_archive import DEFAULT_UPLOAD_SOURCE, prepare_messages, stamp_file_archive, upload_profile
from shared.logging import logger, tracer
from shared.producer_labels import message_labels
from shared.request_body import json_object_body

dynamodb = get_dynamodb_resource()
sqs = get_sqs_client()
s3 = get_s3_client()

AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")
RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")

aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

app = create_api_resolver()

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


def _parse_csv_to_items(
    csv_text: str, default_source: str, column_map: object = None,
) -> tuple[list[dict], list[str]]:
    """Parse CSV text into the same item shape as json_upload. Returns (items, warnings)."""
    items: list[dict] = []

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
            continue

        source_id = col(row, 'id')
        rating_raw = col(row, 'rating')
        created_at_raw = col(row, 'date')
        author = col(row, 'author')
        title = col(row, 'title')
        url = col(row, 'url')
        source_column = col(row, 'channel')

        feedback_id = _csv_row_id({
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

        if feedback_id in seen_row_ids:
            warnings.append(f'row {idx}: duplicate row — skipped')
            continue
        seen_row_ids.add(feedback_id)

        rating = None
        if rating_raw:
            try:
                rating = int(float(rating_raw))
            except (ValueError, TypeError):
                warnings.append(f'row {idx}: rating "{rating_raw}" is not a number — left blank')

        created_at = created_at_raw or datetime.now(UTC).isoformat()

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

        items.append({
            'id': feedback_id,
            'csv_row_id': csv_row_id,
            'text': text,
            'rating': rating,
            'author': author,
            'title': title,
            'url': url,
            'timestamp': created_at,
            'source': source_column or default_source,
            **_row_extras(row, plan, idx, warnings),
        })

    return items, warnings


def _upload_context(body: dict) -> tuple[dict, str, datetime, str]:
    """``(source profile, caller, now, job id)`` for one CSV / JSON upload."""
    profile = upload_profile(aggregates_table, body.get('source_id'))
    return profile, _caller_user_id(), datetime.now(UTC), str(uuid.uuid4())


def _csv_message(item: dict, source_id: str) -> dict:
    """The processing-queue message for one parsed CSV row filed under ``source_id``."""
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
    }
    for key in ('metadata', 'dimensions', 'tags'):
        if item.get(key):
            message[key] = item[key]
    return message


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

    if not isinstance(csv_text, str) or not csv_text.strip():
        raise ValidationError('csv_text is required')
    if len(csv_text.encode('utf-8')) > MAX_CSV_BYTES:
        raise ValidationError(f'CSV exceeds {MAX_CSV_BYTES // (1024 * 1024)} MB limit')

    items, warnings = _parse_csv_to_items(csv_text, default_source, body.get('column_map'))
    if not items:
        raise ValidationError('CSV produced no valid rows. ' + '; '.join(warnings[:5]))
    if len(items) > MAX_JSON_UPLOAD_ITEMS:
        raise ValidationError(
            f'Maximum {MAX_JSON_UPLOAD_ITEMS} rows per upload (got {len(items)}). '
            'Split the file and try again.'
        )
    profile, user_id, now, job_id = _upload_context(body)

    messages, mode = prepare_messages(s3, RAW_DATA_BUCKET, [_csv_message(item, profile['id']) for item in items],
                                      profile, now)
    s3_uri = stamp_file_archive(
        messages, mode, lambda: _archive_csv_file(csv_text, job_id, user_id, default_source, profile['id'], now))
    imported_count, send_errors = _send_items_to_sqs(messages)

    result: dict = {
        'success': True,
        'imported_count': imported_count,
        'total_rows': len(items),
        's3_uri': s3_uri,
    }
    if warnings:
        result['warnings'] = warnings[:20]
    if send_errors:
        result['errors'] = send_errors
    return result


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


def _json_upload_message(item: dict, s3_uri: str | None, source_id: str = DEFAULT_UPLOAD_SOURCE) -> dict:
    """The processing-queue message for one validated json-upload item."""
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
        s3, RAW_DATA_BUCKET, [_json_upload_message(item, None, profile['id']) for item in items], profile, now)
    s3_uri = stamp_file_archive(messages, mode, lambda: _archive_json_file(items, job_id, user_id, now))

    imported_count, send_errors = _send_items_to_sqs(messages, label='item')

    result = {
        'success': True,
        'imported_count': imported_count,
        'total_items': len(items),
        's3_uri': s3_uri,
    }

    if send_errors:
        result['errors'] = send_errors

    return result


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
