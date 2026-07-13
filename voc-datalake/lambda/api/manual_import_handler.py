"""
Manual Import API Lambda - Handles /scrapers/manual/*
Allows users to paste raw review text and have it parsed by LLM.
"""

import json
import os
import sys
import uuid
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_sqs_client, get_s3_client, invoke_lambda_async
from shared.api import create_api_resolver, api_handler, decimal_default
from shared.exceptions import ConfigurationError, ValidationError, NotFoundError, ServiceError

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


def _job_key(job_id: str) -> dict:
    """Generate DynamoDB key for a manual import job."""
    return {'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'}

PARSE_SYSTEM_PROMPT = """You are a review parser. Your job is to extract individual reviews from raw pasted text.

CRITICAL RULES:
1. Extract ONLY - do NOT paraphrase, rewrite, summarize, or modify the review text in any way
2. Preserve the EXACT original text for each review, character for character
3. If you cannot determine a field (rating, author, date), set it to null
4. If text cannot be parsed as reviews, return it in unparsed_sections

Output JSON only, no other text."""

PARSE_USER_PROMPT = """Parse the following raw text into individual reviews. The reviews are from: {source_origin}

Raw text:
```
{raw_text}
```

Return JSON in this exact format:
{{
  "reviews": [
    {{
      "text": "exact original review text",
      "rating": 5,
      "author": "Author Name",
      "date": "2026-01-05",
      "title": "Review Title"
    }}
  ],
  "unparsed_sections": ["any text that could not be parsed as reviews"]
}}

Remember: Do NOT modify the review text. Extract it exactly as written."""


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
    except Exception as e:
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
    
    body = app.current_event.json_body
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
    now = datetime.now(timezone.utc)
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
        raise ServiceError('Failed to start processing')
    
    return {'success': True, 'job_id': job_id, 'source_origin': source_origin}


@app.get("/scrapers/manual/parse/<job_id>")
@tracer.capture_method
def get_parse_status(job_id: str):
    """Get parse job status."""
    if not aggregates_table:
        raise ConfigurationError('Table not configured')
    
    try:
        response = aggregates_table.get_item(Key=_job_key(job_id))
        item = response.get('Item')
        
        if not item:
            raise NotFoundError(f'Job {job_id} not found')
        
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
    except (ConfigurationError, NotFoundError):
        raise
    except Exception as e:
        logger.exception(f"Failed to get job status: {e}")
        raise ServiceError('Failed to retrieve job status')


@app.post("/scrapers/manual/confirm")
@tracer.capture_method
def confirm_import():
    """Confirm and import parsed reviews."""
    body = app.current_event.json_body
    job_id = body.get('job_id')
    reviews = body.get('reviews', [])
    
    if not job_id:
        raise ValidationError('Job ID is required')
    
    if not reviews:
        raise ValidationError('No reviews to import')
    
    # Validate all reviews have dates
    reviews_missing_dates = []
    for idx, review in enumerate(reviews):
        if not review.get('date'):
            reviews_missing_dates.append(idx + 1)
    
    if reviews_missing_dates:
        if len(reviews_missing_dates) == 1:
            raise ValidationError(f'Review {reviews_missing_dates[0]} is missing a date. All reviews must have a date.')
        else:
            raise ValidationError(f'Reviews {", ".join(map(str, reviews_missing_dates))} are missing dates. All reviews must have a date.')
    
    # Get job details
    if not aggregates_table:
        raise ConfigurationError('Table not configured')
    
    try:
        response = aggregates_table.get_item(Key=_job_key(job_id))
        job = response.get('Item')
        
        if not job:
            raise NotFoundError('Job not found')
        
        source_origin = job.get('source_origin', 'unknown')
        source_url = job.get('source_url', '')
        raw_text = job.get('raw_text', '')
        llm_reviews = job.get('reviews', [])
        
        # Get user from request context
        user_id = 'unknown'
        try:
            claims = app.current_event.request_context.authorizer.get('claims', {})
            user_id = claims.get('sub', claims.get('cognito:username', 'unknown'))
        except Exception:
            pass
        
        now = datetime.now(timezone.utc)
        
        # Store to S3
        s3_uri = None
        if RAW_DATA_BUCKET:
            s3_key = f"raw/manual_import/{now.year}/{now.month:02d}/{now.day:02d}/{job_id}.json"
            s3_data = {
                'job_id': job_id,
                'source_url': source_url,
                'source_origin': source_origin,
                'raw_text': raw_text,
                'llm_response': {'reviews': llm_reviews},
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
                s3_uri = f"s3://{RAW_DATA_BUCKET}/{s3_key}"
            except Exception as e:
                logger.warning(f"Failed to store to S3: {e}")
        
        # Send each review to SQS
        imported_count = 0
        errors = []
        
        for idx, review in enumerate(reviews):
            feedback_id = f"manual-{job_id}-{idx}"
            
            message = {
                'id': feedback_id,
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
            
            try:
                if PROCESSING_QUEUE_URL:
                    sqs.send_message(
                        QueueUrl=PROCESSING_QUEUE_URL,
                        MessageBody=json.dumps(message)
                    )
                imported_count += 1
            except Exception as e:
                logger.warning(f"Failed to send review {idx} to SQS: {e}")
                errors.append(f"Review {idx}: {str(e)}")
        
        # Update job status
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
        
    except (ValidationError, ConfigurationError, NotFoundError):
        raise
    except Exception as e:
        logger.exception(f"Failed to confirm import: {e}")
        raise ServiceError('Failed to import reviews')


# Max rows per CSV/JSON upload. Rows are pushed to SQS in batches of 10 (see
# _send_items_to_sqs), so even tens of thousands send well within the API
# Gateway 29s / Lambda timeout. Bumped from 500 once batch-send was added.
# Practical sync-path ceiling is ~9k rows (measured ~15.7s for 5k) — beyond
# that, use the S3 import path.
MAX_JSON_UPLOAD_ITEMS = 50000

MAX_CSV_BYTES = 10 * 1024 * 1024  # 10 MB


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
        entries = [
            {'Id': str(i), 'MessageBody': json.dumps(msg)}
            for i, msg in enumerate(chunk)
        ]
        try:
            resp = sqs.send_message_batch(QueueUrl=PROCESSING_QUEUE_URL, Entries=entries)
            imported += len(resp.get('Successful', []))
            for failed in resp.get('Failed', []):
                row = start + int(failed.get('Id', 0))
                errors.append(f"{label} {row}: {failed.get('Message', 'send failed')}")
        except Exception as e:
            logger.warning(f"Failed to send SQS batch at {label} {start}: {e}")
            errors.append(f"{label}s {start}-{start + len(chunk) - 1}: {str(e)}")
    return imported, errors


def _parse_csv_to_items(csv_text: str, default_source: str) -> tuple[list[dict], list[str]]:
    """Parse CSV text into the same item shape as json_upload. Returns (items, warnings)."""
    import csv as _csv
    import io
    import hashlib

    warnings: list[str] = []
    items: list[dict] = []

    # csv.DictReader handles quoted commas, embedded newlines, and BOM.
    reader = _csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames:
        raise ValidationError('CSV is empty or has no header row')

    # Case-insensitive lookup for required/optional columns.
    headers = {h.strip().lower(): h for h in reader.fieldnames if h}

    def col(row: dict, *names: str) -> str:
        for n in names:
            actual = headers.get(n)
            if actual is not None:
                v = row.get(actual)
                if v is not None and str(v).strip():
                    return str(v).strip()
        return ''

    if 'text' not in headers and 'review' not in headers and 'comment' not in headers and 'feedback' not in headers:
        raise ValidationError(
            'CSV must include a "text" column (also accepted: review / comment / feedback)'
        )

    seen_ids: set[str] = set()
    for idx, row in enumerate(reader, start=1):
        text = col(row, 'text', 'review', 'comment', 'feedback')
        if not text:
            warnings.append(f'row {idx}: empty text — skipped')
            continue

        # Synthesize a stable id when missing so the dedupe layer doesn't reject the row.
        source_id = col(row, 'id', 'review_id') or hashlib.sha1(
            f'{text[:200]}|{idx}'.encode()
        ).hexdigest()[:32]

        if source_id in seen_ids:
            warnings.append(f'row {idx}: duplicate id "{source_id}" — skipped')
            continue
        seen_ids.add(source_id)

        rating_raw = col(row, 'rating', 'stars', 'score')
        rating: int | None = None
        if rating_raw:
            try:
                rating = int(float(rating_raw))
            except (ValueError, TypeError):
                warnings.append(f'row {idx}: rating "{rating_raw}" is not a number — left blank')

        created_at = col(row, 'date', 'timestamp', 'created_at') or datetime.now(timezone.utc).isoformat()
        source = col(row, 'source', 'source_channel') or default_source

        items.append({
            'id': source_id,
            'text': text,
            'rating': rating,
            'author': col(row, 'author', 'user', 'user_id', 'name'),
            'title': col(row, 'title', 'subject'),
            'url': col(row, 'url', 'link'),
            'timestamp': created_at,
            'source': source,
        })

    return items, warnings


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
    body = app.current_event.json_body or {}
    csv_text = body.get('csv_text', '')
    default_source = (body.get('default_source') or 'csv_upload').strip() or 'csv_upload'

    if not isinstance(csv_text, str) or not csv_text.strip():
        raise ValidationError('csv_text is required')
    if len(csv_text.encode('utf-8')) > MAX_CSV_BYTES:
        raise ValidationError(f'CSV exceeds {MAX_CSV_BYTES // (1024 * 1024)} MB limit')

    items, warnings = _parse_csv_to_items(csv_text, default_source)
    if not items:
        raise ValidationError('CSV produced no valid rows. ' + '; '.join(warnings[:5]))
    if len(items) > MAX_JSON_UPLOAD_ITEMS:
        raise ValidationError(
            f'Maximum {MAX_JSON_UPLOAD_ITEMS} rows per upload (got {len(items)}). '
            'Split the file and try again.'
        )

    user_id = 'unknown'
    try:
        claims = app.current_event.request_context.authorizer.get('claims', {})
        user_id = claims.get('sub', claims.get('cognito:username', 'unknown'))
    except Exception:
        pass

    now = datetime.now(timezone.utc)
    job_id = str(uuid.uuid4())

    s3_uri = None
    if RAW_DATA_BUCKET:
        s3_key = f"raw/csv_upload/{now.year}/{now.month:02d}/{now.day:02d}/{job_id}.csv"
        try:
            s3.put_object(
                Bucket=RAW_DATA_BUCKET,
                Key=s3_key,
                Body=csv_text.encode('utf-8'),
                ContentType='text/csv; charset=utf-8',
                Metadata={'uploaded_by': user_id, 'default_source': default_source},
            )
            s3_uri = f"s3://{RAW_DATA_BUCKET}/{s3_key}"
        except Exception as e:
            logger.warning(f"Failed to store CSV upload to S3: {e}")

    messages = [
        {
            'id': item['id'],
            'source_platform': 'manual_import',
            'source_channel': item['source'],
            'ingestion_method': 'csv_upload',
            'text': item['text'],
            'rating': item.get('rating'),
            'author': item.get('author'),
            'title': item.get('title'),
            'url': item.get('url'),
            'created_at': item['timestamp'],
            's3_raw_uri': s3_uri,
        }
        for item in items
    ]
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


@app.post("/scrapers/manual/json-upload")
@tracer.capture_method
def json_upload():
    """Import pre-structured JSON feedback items directly into the pipeline."""
    body = app.current_event.json_body
    items = body.get('items', [])

    if not isinstance(items, list) or len(items) == 0:
        raise ValidationError('Request must contain a non-empty "items" array')

    if len(items) > MAX_JSON_UPLOAD_ITEMS:
        raise ValidationError(f'Maximum {MAX_JSON_UPLOAD_ITEMS} items per upload')

    # Validate required fields: text, id, source, timestamp
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

    if errors:
        raise ValidationError(f'Validation failed: {"; ".join(errors[:10])}')

    # Get user from request context
    user_id = 'unknown'
    try:
        claims = app.current_event.request_context.authorizer.get('claims', {})
        user_id = claims.get('sub', claims.get('cognito:username', 'unknown'))
    except Exception:
        pass

    now = datetime.now(timezone.utc)
    job_id = str(uuid.uuid4())

    # Store raw upload to S3
    s3_uri = None
    if RAW_DATA_BUCKET:
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
            s3_uri = f"s3://{RAW_DATA_BUCKET}/{s3_key}"
        except Exception as e:
            logger.warning(f"Failed to store JSON upload to S3: {e}")

    # Send items to SQS in batches of 10. With the 50k cap, per-item
    # send_message would exceed the API Gateway 29s window; batching keeps
    # large uploads inside it.
    messages = []
    for item in items:
        message = {
            'id': item.get('id', ''),
            'source_platform': 'manual_import',
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

        messages.append(message)

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
