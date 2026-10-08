"""
Manual Import Processor Lambda - Async LLM parsing of pasted reviews.
Invoked asynchronously by manual_import_handler.py
"""

import json
import os
import re
import sys
from datetime import UTC, date, datetime
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import get_bedrock_client, get_dynamodb_resource
from shared.converse import bedrock_call_with_retry
from shared.exceptions import ValidationError
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, tracer
from shared.model_config import get_active_model_id, uses_adaptive_thinking

dynamodb = get_dynamodb_resource()
bedrock = get_bedrock_client()

AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

PARSE_SYSTEM_PROMPT = """You are a review parser. Your job is to extract individual reviews from raw pasted text.

CRITICAL RULES:
1. Extract ONLY - do NOT paraphrase, rewrite, summarize, or modify the review text in any way
2. Preserve the EXACT original text for each review, character for character
3. If you cannot determine a field (rating, author, title, date), set it to null
4. If text cannot be parsed as reviews, return it in unparsed_sections
5. Ratings should be normalized to 1-5 scale if possible
6. Dates are YYYY-MM-DD. Resolve relative dates ("3 days ago", "last week") against the import date you are given; never invent a date the text does not imply

Output valid JSON only, no markdown code blocks, no other text."""

PARSE_USER_PROMPT = """Parse the following raw text into individual reviews. The reviews are from: {source_origin}
The import date is {import_date}. A review with no date in the text gets "date": null; the importer then uses the import date and shows the user that it did.

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


def _mark_job_failed(table: Any, job_id: str, error: str) -> None:
    """Record `error` on the job and set its status to failed."""
    table.update_item(
        Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'},
        UpdateExpression='SET #status = :status, #error = :error',
        ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
        ExpressionAttributeValues={':status': 'failed', ':error': error}
    )


def parse_llm_response(response_text: str) -> dict:
    """Parse LLM response, handling potential JSON extraction."""
    # Try direct JSON parse first
    try:
        return json.loads(response_text)
    except json.JSONDecodeError:
        pass

    # Try to extract JSON from markdown code block (greedy to capture nested objects)
    json_match = re.search(r'```(?:json)?\s*(\{.*\})\s*```', response_text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

    # Try to find JSON object starting with "reviews" key
    # Find the opening brace and match to the last closing brace
    json_match = re.search(r'(\{[^{}]*"reviews"\s*:\s*\[.*\].*\})', response_text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

    # Return empty result if parsing fails
    return {'reviews': [], 'unparsed_sections': [response_text]}


def _parse_request_body(model_id: str, user_prompt: str) -> dict:
    """The invoke_model body for the parse call, shaped for `model_id`'s capabilities."""
    request_body: dict[str, Any] = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 16000,
        "system": PARSE_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}]
    }
    if not uses_adaptive_thinking(model_id):
        request_body["thinking"] = {
            "type": "enabled",
            "budget_tokens": 5000
        }
    return request_body


def _first_text_block(response_body: dict) -> str:
    """The first text block of a Messages response (thinking blocks come first)."""
    for block in response_body.get('content', []):
        if block.get('type') == 'text':
            text = block.get('text', '')
            if text:
                return text
            break
    raise ValueError("No text response from Bedrock")


# A leading calendar date: "2026-01-05" or the date part of an ISO timestamp.
_ISO_DATE_PREFIX = re.compile(r'^\s*(\d{4}-\d{2}-\d{2})')


def import_date_of(job: dict) -> str:
    """The job's creation day (YYYY-MM-DD, UTC); today when the record has none."""
    created_at = job.get('created_at')
    if isinstance(created_at, str):
        try:
            return datetime.fromisoformat(created_at).astimezone(UTC).date().isoformat()
        except ValueError:
            pass
    return datetime.now(UTC).date().isoformat()


def _calendar_date(value: object) -> str | None:
    """`value` as YYYY-MM-DD when it starts with a real calendar date, else None."""
    if not isinstance(value, str):
        return None
    match = _ISO_DATE_PREFIX.match(value)
    if match is None:
        return None
    try:
        return date.fromisoformat(match.group(1)).isoformat()
    except ValueError:
        return None


def _sanitize_review(review: dict, import_date: str) -> dict:
    """A parsed review in DynamoDB-safe form, with a date the preview can show.

    The rating becomes an int (no floats) or None. A review the model gave no
    usable date (null, empty, prose like "a while ago") gets the import date and
    `date_defaulted: True`, so the preview can say so: POST /scrapers/manual/confirm
    refuses any review without a date, and the user can still edit it there.
    """
    rating = review.get('rating')
    try:
        sanitized_rating = None if rating is None else round(float(rating))
    except (ValueError, TypeError):
        sanitized_rating = None
    parsed_date = _calendar_date(review.get('date'))
    return {
        'text': review.get('text', ''),
        'author': review.get('author'),
        'date': parsed_date or import_date,
        'date_defaulted': parsed_date is None,
        'title': review.get('title'),
        'rating': sanitized_rating,
    }


@tracer.capture_method
def process_job(job_id: str) -> None:
    """Process a manual import job with LLM parsing."""
    table = aggregates_table
    if not table:
        logger.error("Aggregates table not configured")
        return

    # Get job details
    try:
        response = table.get_item(
            Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'}
        )
        job = response.get('Item')

        if not job:
            logger.error(f"Job {job_id} not found")
            return

        raw_text = job.get('raw_text', '')
        source_origin = job.get('source_origin', 'unknown')

        if not raw_text:
            _mark_job_failed(table, job_id, 'No raw text to parse')
            return

        # Build prompt
        import_date = import_date_of(job)
        user_prompt = PARSE_USER_PROMPT.format(
            source_origin=source_origin,
            import_date=import_date,
            raw_text=raw_text
        )

        # Call Bedrock with extended thinking. Parsing pasted reviews is a
        # utility workload, so it follows the utility-surface model pick.
        #
        # Capability-aware body: adaptive-thinking models (Sonnet 5, Opus 5)
        # reject an explicit `thinking` budget, and temperature is omitted
        # everywhere — it defaults to 1, which is also the only accepted value
        # with thinking enabled, while temperature-restricted models (Sonnet 5,
        # Opus 5) reject the parameter outright when sent explicitly.
        #
        # This raw invoke_model path bypasses converse() and has NO
        # auto-continuation, so the strict-JSON doctrine (shared/converse.py)
        # applies in its single-call form: max_tokens=16000 must fit the whole
        # JSON answer in one call; a truncated response falls through
        # parse_llm_response() into unparsed_sections rather than corrupting.
        model_id = get_active_model_id('utility')
        logger.info(f"Invoking Bedrock for job {job_id} with model {model_id}")

        # Through the shared retry policy: this raw invoke_model path does not go
        # through converse(), and the shared client makes one botocore attempt by
        # design (see BEDROCK_READ_TIMEOUT_SECONDS), so without this a single
        # throttle would fail the whole import job.
        bedrock_response = bedrock_call_with_retry(
            lambda: bedrock.invoke_model(
                modelId=model_id,
                body=json.dumps(_parse_request_body(model_id, user_prompt)),
                contentType="application/json",
                accept="application/json"
            ),
            step_name=f'manual_import_parse_{job_id}',
            call_label='client.invoke_model()',
        )

        response_text = _first_text_block(json.loads(bedrock_response['body'].read()))

        # Parse the response
        parsed = parse_llm_response(response_text)
        # Sanitize reviews for DynamoDB (convert floats to ints, handle None values)
        sanitized_reviews = [_sanitize_review(review, import_date) for review in parsed.get('reviews', [])]
        unparsed_sections = parsed.get('unparsed_sections', [])

        logger.info(f"Job {job_id}: Parsed {len(sanitized_reviews)} reviews, {len(unparsed_sections)} unparsed sections")

        # Update job with results
        table.update_item(
            Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'},
            UpdateExpression='SET #status = :status, reviews = :reviews, unparsed_sections = :unparsed',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':status': 'completed',
                ':reviews': sanitized_reviews,
                ':unparsed': unparsed_sections
            }
        )

    except Exception as e:
        logger.exception(f"Failed to process job {job_id}: {e}")

        try:
            _mark_job_failed(table, job_id, str(e))
        except (ClientError, BotoCoreError) as mark_error:
            # The job stays 'processing' and expires with its TTL.
            logger.warning(f"Could not mark job {job_id} failed: {mark_error}")


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Handle async invocation to process manual import job."""
    job_id = event.get('job_id')

    if not job_id:
        logger.error("No job_id in event")
        raise ValidationError('No job_id provided')

    process_job(job_id)

    return {'success': True, 'job_id': job_id}
