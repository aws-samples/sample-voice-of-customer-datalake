"""
Manual Import Processor Lambda - Async LLM parsing of pasted reviews.
Invoked asynchronously by manual_import_handler.py
"""

import json
import os
import re
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID

dynamodb = get_dynamodb_resource()
bedrock = get_bedrock_client()

AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

PARSE_SYSTEM_PROMPT = """You are a review parser. Your job is to extract individual reviews from raw pasted text.

CRITICAL RULES:
1. Extract ONLY - do NOT paraphrase, rewrite, summarize, or modify the review text in any way
2. Preserve the EXACT original text for each review, character for character
3. If you cannot determine a field (rating, author, date), set it to null
4. If text cannot be parsed as reviews, return it in unparsed_sections
5. Ratings should be normalized to 1-5 scale if possible

Output valid JSON only, no markdown code blocks, no other text."""

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


@tracer.capture_method
def process_job(job_id: str) -> None:
    """Process a manual import job with LLM parsing."""
    if not aggregates_table:
        logger.error("Aggregates table not configured")
        return
    
    # Get job details
    try:
        response = aggregates_table.get_item(
            Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'}
        )
        job = response.get('Item')
        
        if not job:
            logger.error(f"Job {job_id} not found")
            return
        
        raw_text = job.get('raw_text', '')
        source_origin = job.get('source_origin', 'unknown')
        
        if not raw_text:
            aggregates_table.update_item(
                Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'},
                UpdateExpression='SET #status = :status, #error = :error',
                ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
                ExpressionAttributeValues={':status': 'failed', ':error': 'No raw text to parse'}
            )
            return
        
        # Build prompt
        user_prompt = PARSE_USER_PROMPT.format(
            source_origin=source_origin,
            raw_text=raw_text
        )
        
        # Call Bedrock with extended thinking
        # Note: temperature must be 1 when extended thinking is enabled
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 16000,
            "temperature": 1,
            "thinking": {
                "type": "enabled",
                "budget_tokens": 5000
            },
            "system": PARSE_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_prompt}]
        }
        
        logger.info(f"Invoking Bedrock for job {job_id}")
        
        bedrock_response = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            body=json.dumps(request_body),
            contentType="application/json",
            accept="application/json"
        )
        
        response_body = json.loads(bedrock_response['body'].read())
        
        # Extract text from response (handle thinking blocks)
        response_text = ""
        for block in response_body.get('content', []):
            if block.get('type') == 'text':
                response_text = block.get('text', '')
                break
        
        if not response_text:
            raise ValueError("No text response from Bedrock")
        
        # Parse the response
        parsed = parse_llm_response(response_text)
        reviews = parsed.get('reviews', [])
        unparsed_sections = parsed.get('unparsed_sections', [])
        
        # Sanitize reviews for DynamoDB (convert floats to ints, handle None values)
        sanitized_reviews = []
        for review in reviews:
            sanitized = {
                'text': review.get('text', ''),
                'author': review.get('author'),
                'date': review.get('date'),
                'title': review.get('title'),
            }
            # Convert rating to int if present (DynamoDB doesn't support float)
            rating = review.get('rating')
            if rating is not None:
                try:
                    sanitized['rating'] = int(round(float(rating)))
                except (ValueError, TypeError):
                    sanitized['rating'] = None
            else:
                sanitized['rating'] = None
            sanitized_reviews.append(sanitized)
        
        logger.info(f"Job {job_id}: Parsed {len(sanitized_reviews)} reviews, {len(unparsed_sections)} unparsed sections")
        
        # Update job with results
        aggregates_table.update_item(
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
        
        # Update job status to failed
        if aggregates_table:
            try:
                aggregates_table.update_item(
                    Key={'pk': f'MANUAL_IMPORT#{job_id}', 'sk': 'JOB'},
                    UpdateExpression='SET #status = :status, #error = :error',
                    ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
                    ExpressionAttributeValues={':status': 'failed', ':error': str(e)}
                )
            except Exception:
                pass


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Handle async invocation to process manual import job."""
    job_id = event.get('job_id')
    
    if not job_id:
        logger.error("No job_id in event")
        return {'success': False, 'error': 'No job_id provided'}
    
    process_job(job_id)
    
    return {'success': True, 'job_id': job_id}
