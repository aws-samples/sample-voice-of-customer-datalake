"""
Chrome Extension API Lambda - Handles /extension/*
Receives scraped reviews from the Chrome extension and sends them to the processing pipeline.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from shared.logging import logger, tracer, metrics
from shared.aws import get_s3_client, get_sqs_client
from shared.api import create_api_resolver, api_handler, decimal_default
from shared.exceptions import ValidationError, ConfigurationError, ServiceError

s3 = get_s3_client()
sqs = get_sqs_client()

RAW_DATA_BUCKET = os.environ.get("RAW_DATA_BUCKET", "")
PROCESSING_QUEUE_URL = os.environ.get("PROCESSING_QUEUE_URL", "")

app = create_api_resolver()

MAX_TEXT_LENGTH = 50000  # 50KB max for selected text
MAX_REVIEWS = 100  # Max reviews per submission


def _get_user_id() -> str:
    """Extract user ID from Cognito claims."""
    try:
        claims = app.current_event.request_context.authorizer.get('claims', {})
        return claims.get('sub', claims.get('cognito:username', 'unknown'))
    except Exception:
        return 'unknown'


@app.post("/extension/reviews")
@tracer.capture_method
def submit_reviews():
    """
    Receive reviews from the Chrome extension.

    Accepts either:
    - Pre-parsed reviews (items array with text, rating, author, etc.)
    - Raw selected text (raw_text field) which gets sent to the processor as-is

    The processor Lambda handles all enrichment (Bedrock, Comprehend, etc.).
    """
    body = app.current_event.json_body

    source_url = body.get('source_url', '').strip()
    page_title = body.get('page_title', '').strip()
    raw_text = body.get('raw_text', '').strip()
    items = body.get('items', [])

    if not source_url:
        raise ValidationError('source_url is required')

    if not raw_text and not items:
        raise ValidationError('Either raw_text or items array is required')

    if raw_text and len(raw_text) > MAX_TEXT_LENGTH:
        raise ValidationError(f'raw_text exceeds maximum of {MAX_TEXT_LENGTH} characters')

    if items and len(items) > MAX_REVIEWS:
        raise ValidationError(f'Maximum {MAX_REVIEWS} items per submission')

    user_id = _get_user_id()
    now = datetime.now(timezone.utc)
    batch_id = str(uuid.uuid4())

    # Store raw submission to S3
    s3_uri = _store_raw_to_s3(batch_id, body, user_id, now)

    # If raw_text is provided, send as a single item for the processor to handle
    if raw_text and not items:
        items = [{
            'text': raw_text,
            'id': f"ext-{batch_id}-0",
        }]

    # Send each item to SQS for processing
    imported_count = 0
    errors = []

    for idx, item in enumerate(items):
        text = item.get('text', '').strip() if isinstance(item, dict) else ''
        if not text:
            continue

        source_id = item.get('id', f"ext-{batch_id}-{idx}")

        message = {
            'id': source_id,
            'source_platform': 'chrome_extension',
            'source_channel': 'review',
            'source_url': source_url,
            'url': source_url,
            'page_title': page_title,
            'ingestion_method': 'chrome_extension',
            'chrome_extension_batch_id': batch_id,
            'text': text,
            'rating': item.get('rating') if isinstance(item, dict) else None,
            'author': item.get('author') if isinstance(item, dict) else None,
            'title': item.get('title') if isinstance(item, dict) else None,
            'created_at': item.get('date') if isinstance(item, dict) else None,
            's3_raw_uri': s3_uri,
        }

        try:
            if PROCESSING_QUEUE_URL:
                sqs.send_message(
                    QueueUrl=PROCESSING_QUEUE_URL,
                    MessageBody=json.dumps(message),
                )
            imported_count += 1
        except Exception as e:
            logger.warning(f"Failed to send item {idx} to SQS: {e}")
            errors.append(f"Item {idx}: {str(e)}")

    result = {
        'success': True,
        'batch_id': batch_id,
        'imported_count': imported_count,
        'total_items': len(items),
        's3_uri': s3_uri,
    }

    if errors:
        result['errors'] = errors

    return result


@app.get("/extension/status")
@tracer.capture_method
def get_status():
    """Health check and user info for the extension."""
    user_id = _get_user_id()
    return {
        'success': True,
        'user_id': user_id,
        'configured': bool(PROCESSING_QUEUE_URL),
    }


def _store_raw_to_s3(
    batch_id: str,
    body: dict,
    user_id: str,
    now: datetime,
) -> str | None:
    """Store raw extension submission to S3."""
    if not RAW_DATA_BUCKET:
        return None

    s3_key = f"raw/chrome_extension/{now.year}/{now.month:02d}/{now.day:02d}/{batch_id}.json"
    try:
        s3.put_object(
            Bucket=RAW_DATA_BUCKET,
            Key=s3_key,
            Body=json.dumps({
                'batch_id': batch_id,
                'source_url': body.get('source_url', ''),
                'page_title': body.get('page_title', ''),
                'raw_text': body.get('raw_text', ''),
                'items': body.get('items', []),
                'submitted_at': now.isoformat(),
                'submitted_by': user_id,
            }, default=decimal_default),
            ContentType='application/json',
        )
        return f"s3://{RAW_DATA_BUCKET}/{s3_key}"
    except Exception as e:
        logger.warning(f"Failed to store raw data to S3: {e}")
        return None


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
