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

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client
from shared.api import create_api_resolver, api_handler, require_admin
from shared.exceptions import ConfigurationError, ValidationError, ServiceError
from shared.model_config import (
    ALLOWED_MODELS, ALLOWED_MODEL_IDS, MODEL_SETTINGS_PK, MODEL_SETTINGS_SK,
    clear_model_cache,
)

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

SETTINGS_PK = "SETTINGS#brand"
SETTINGS_SK = "config"
CATEGORIES_PK = "SETTINGS#categories"
CATEGORIES_SK = "config"

app = create_api_resolver()


@app.get("/settings/model")
@tracer.capture_method
def get_model_settings():
    """Get the model override and the curated allowlist (issue #96).

    ``model_id`` is null when no override is set — each surface then uses
    its own default (Python Lambdas: Sonnet 4.5; streaming chat: its env
    default). The allowlist is fixed server-side: prompts in this project
    are tuned for Claude, and entries are covered by the BedrockAccessStack
    model agreements.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(
            Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
        )
        item = response.get('Item')
        configured = item.get('model_id') if item else None
        return {
            'model_id': configured if configured in ALLOWED_MODEL_IDS else None,
            'available_models': ALLOWED_MODELS,
        }
    except Exception as e:
        logger.exception(f"Failed to get model settings: {e}")
        raise ServiceError('Failed to retrieve model settings')


@app.put("/settings/model")
@tracer.capture_method
def save_model_settings():
    """Set or clear the Bedrock model override.

    Body: {'model_id': <allowlisted id>} to pin every AI feature to one
    model, or {'model_id': null} to restore per-feature defaults.
    Admin-only: this changes inference cost/quality for the whole org.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    require_admin(app.current_event.raw_event)
    body = app.current_event.json_body or {}

    if 'model_id' not in body:
        raise ValidationError('model_id is required (an allowlisted id, or null to clear)')
    model_id = body.get('model_id')
    if model_id is not None and model_id not in ALLOWED_MODEL_IDS:
        raise ValidationError(
            f"model_id must be null or one of: {', '.join(sorted(ALLOWED_MODEL_IDS))}"
        )

    try:
        if model_id is None:
            aggregates_table.delete_item(
                Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
            )
        else:
            aggregates_table.put_item(Item={
                'pk': MODEL_SETTINGS_PK,
                'sk': MODEL_SETTINGS_SK,
                'model_id': model_id,
                'updated_at': datetime.now(timezone.utc).isoformat(),
            })
        # Settings Lambda's own cache; other containers refresh within the TTL.
        clear_model_cache()
        return {'success': True, 'model_id': model_id}
    except Exception as e:
        logger.exception(f"Failed to save model settings: {e}")
        raise ServiceError('Failed to save model settings')


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
