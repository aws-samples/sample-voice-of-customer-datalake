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


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
