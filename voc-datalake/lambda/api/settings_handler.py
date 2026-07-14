"""
Settings API Lambda - Handles /settings/*
Manages brand configuration and categories.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

from botocore.exceptions import ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID
from shared.api import create_api_resolver, api_handler
from shared.exceptions import ConfigurationError, ValidationError, ServiceError

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

SETTINGS_PK = "SETTINGS#brand"
SETTINGS_SK = "config"
CATEGORIES_PK = "SETTINGS#categories"
CATEGORIES_SK = "config"
RESOLVED_PROBLEMS_PK = "SETTINGS#resolved_problems"
RESOLVED_PROBLEMS_SK = "config"

# Problem keys are client-built as "category|subcategory|normalized problem
# text". Bound their size in characters AND UTF-8 bytes (CJK text triples
# the byte cost) plus the entry count. 255 bytes keeps every key safely
# inside DynamoDB's strictest name-length constraints (the documented
# 255-byte expression limit measures the alias token, but capping the real
# name too costs nothing and removes the ambiguity) and shrinks the item
# math: worst case 500 entries x ~295 bytes ≈ 148KB, far under the 400KB cap.
MAX_PROBLEM_KEY_LEN = 255
MAX_PROBLEM_KEY_BYTES = 255
MAX_RESOLVED_ENTRIES = 500

app = create_api_resolver()


@app.get("/settings/resolved-problems")
@tracer.capture_method
def get_resolved_problems():
    """Get the map of problems marked as resolved on the Problem Analysis page.

    Shape: {'resolved': {problem_key: {'resolved_at': iso8601}}}. Shared
    across all users by design (issue #66) — resolving a problem clears it
    from everyone's working view.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK}
        )
        return {'resolved': response.get('Item', {}).get('resolved', {})}
    except Exception as e:
        logger.exception("Failed to get resolved problems")
        raise ServiceError('Failed to retrieve resolved problems') from e


@app.put("/settings/resolved-problems")
@tracer.capture_method
def set_problem_resolution():
    """Mark a single problem group resolved or unresolved.

    Body: {'key': str, 'resolved': bool}. The entry cap is enforced
    atomically via a ConditionExpression on the same write (no
    read-then-write race), and the steady state is exactly one write per
    request: the parent map is only materialized on the first-ever resolve.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = app.current_event.json_body or {}

    key = body.get('key')
    if not isinstance(key, str) or not key.strip():
        raise ValidationError('key must be a non-empty string')
    if len(key) > MAX_PROBLEM_KEY_LEN:
        raise ValidationError(f'key must be at most {MAX_PROBLEM_KEY_LEN} characters')
    if len(key.encode('utf-8')) > MAX_PROBLEM_KEY_BYTES:
        raise ValidationError(f'key must be at most {MAX_PROBLEM_KEY_BYTES} bytes (UTF-8)')
    resolved = body.get('resolved')
    if not isinstance(resolved, bool):
        raise ValidationError('resolved must be a boolean')

    try:
        if resolved:
            _resolve_problem_key(key)
        else:
            _unresolve_problem_key(key)
        return {'success': True, 'key': key, 'resolved': resolved}
    except ValidationError:
        raise
    except Exception as e:
        logger.exception("Failed to update problem resolution")
        raise ServiceError('Failed to update problem resolution') from e


def _set_resolved_entry(key: str) -> None:
    """Single conditional write: overwrite is always allowed; NEW entries
    only while the map is under the cap. Atomic — two concurrent resolves
    at the cap can't both slip through (review feedback on #153)."""
    aggregates_table.update_item(
        Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
        UpdateExpression='SET #r.#k = :entry',
        ConditionExpression='attribute_exists(#r.#k) OR size(#r) < :max',
        ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        ExpressionAttributeValues={
            ':entry': {'resolved_at': datetime.now(timezone.utc).isoformat()},
            ':max': MAX_RESOLVED_ENTRIES,
        },
    )


def _ensure_resolved_map() -> None:
    aggregates_table.update_item(
        Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
        UpdateExpression='SET #r = if_not_exists(#r, :empty)',
        ExpressionAttributeNames={'#r': 'resolved'},
        ExpressionAttributeValues={':empty': {}},
    )


def _resolve_problem_key(key: str) -> None:
    """Conditionally set the entry, materializing the parent map on first use.

    DynamoDB reports a missing parent map either as a document-path
    ValidationException or as a failed condition (functions on missing
    attributes evaluate false), depending on evaluation order — so both
    first-attempt failures fall through to ensure-parent + one retry, and
    only a retry failure means the cap was genuinely reached.
    """
    try:
        _set_resolved_entry(key)
        return
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code not in ('ConditionalCheckFailedException', 'ValidationException'):
            raise
    _ensure_resolved_map()
    try:
        _set_resolved_entry(key)
    except ClientError as e:
        if e.response.get('Error', {}).get('Code', '') == 'ConditionalCheckFailedException':
            raise ValidationError(
                f'Resolved-problem limit reached ({MAX_RESOLVED_ENTRIES}). '
                'Unresolve entries you no longer need first.'
            ) from e
        raise


def _unresolve_problem_key(key: str) -> None:
    """REMOVE the entry; a missing parent map just means nothing to remove.

    Only the document-path variant of ValidationException is treated as a
    no-op — any other validation failure (malformed expression, oversized
    name) is a real error and must not be reported as success.
    """
    try:
        aggregates_table.update_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
            UpdateExpression='REMOVE #r.#k',
            ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        )
    except ClientError as e:
        error = e.response.get('Error', {})
        is_missing_path = (
            error.get('Code', '') == 'ValidationException'
            and 'document path' in error.get('Message', '').lower()
        )
        if not is_missing_path:
            raise


@app.get("/settings/brand")
@tracer.capture_method
def get_brand_settings():
    """Get brand configuration from DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(Key={'pk': SETTINGS_PK, 'sk': SETTINGS_SK})
        item = response.get('Item')
        if not item:
            return {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []}
        return {'brand_name': item.get('brand_name', ''), 'brand_handles': item.get('brand_handles', []),
                'hashtags': item.get('hashtags', []), 'urls_to_track': item.get('urls_to_track', [])}
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        raise ServiceError('Failed to retrieve brand settings')


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save brand configuration to DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = app.current_event.json_body
    try:
        item = {'pk': SETTINGS_PK, 'sk': SETTINGS_SK, 'brand_name': body.get('brand_name', ''),
                'brand_handles': body.get('brand_handles', []), 'hashtags': body.get('hashtags', []),
                'urls_to_track': body.get('urls_to_track', []), 'updated_at': datetime.now(timezone.utc).isoformat()}
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': 'Brand settings saved', 'settings': {k: item[k] for k in ['brand_name', 'brand_handles', 'hashtags', 'urls_to_track']}}
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        raise ServiceError('Failed to save brand settings')


@app.get("/settings/categories")
@tracer.capture_method
def get_categories_config():
    """Get categories configuration from DynamoDB."""
    if not aggregates_table:
        return {'categories': [], 'error': 'Aggregates table not configured'}
    try:
        response = aggregates_table.get_item(Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK})
        item = response.get('Item')
        if not item:
            return {'categories': [], 'updated_at': None}
        return {'categories': item.get('categories', []), 'updated_at': item.get('updated_at')}
    except Exception as e:
        logger.exception(f"Failed to get categories config: {e}")
        return {'categories': [], 'error': 'Failed to retrieve categories'}


@app.put("/settings/categories")
@tracer.capture_method
def save_categories_config():
    """Save categories configuration to DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = app.current_event.json_body
    categories = body.get('categories', [])
    try:
        item = {'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': categories, 'updated_at': datetime.now(timezone.utc).isoformat()}
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': f'Saved {len(categories)} categories'}
    except Exception as e:
        logger.exception(f"Failed to save categories config: {e}")
        raise ServiceError('Failed to save categories')


@app.post("/settings/categories/generate")
@tracer.capture_method
def generate_categories():
    """Use LLM to generate category suggestions based on company description."""
    body = app.current_event.json_body
    company_description = body.get('company_description', '')
    if not company_description:
        raise ValidationError('Company description is required')
    
    try:
        from shared.converse import converse
        prompt = f"""Based on the following company/product description, generate a comprehensive list of feedback categories and subcategories.

Company Description:
{company_description}

Generate 6-10 main categories, each with 3-5 relevant subcategories.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{{
  "categories": [
    {{
      "id": "category_id_snake_case",
      "name": "category_id_snake_case",
      "description": "Human Readable Category Name",
      "subcategories": [
        {{"id": "subcategory_id_snake_case", "name": "subcategory_id_snake_case", "description": "Human Readable Subcategory Name"}}
      ]
    }}
  ]
}}"""

        response_text = converse(prompt=prompt, max_tokens=2000, temperature=0.3)

        json_match = re.search(r"\{[\s\S]*\}", response_text)
        if json_match:
            parsed = json.loads(json_match.group())
            return {"success": True, "categories": parsed.get("categories", [])}
        raise ServiceError("Could not parse categories from response")
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        raise ServiceError('Failed to generate categories')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
