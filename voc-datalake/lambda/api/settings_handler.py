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
REVIEW_PK = "SETTINGS#review"
REVIEW_SK = "config"

# AWS Translate supported languages (75 languages)
SUPPORTED_LANGUAGES = {
    'af', 'sq', 'am', 'ar', 'hy', 'az', 'bn', 'bs', 'bg', 'ca',
    'zh', 'zh-TW', 'hr', 'cs', 'da', 'fa-AF', 'nl', 'en', 'et', 'fa',
    'tl', 'fi', 'fr', 'fr-CA', 'ka', 'de', 'el', 'gu', 'ht', 'ha',
    'he', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'kk',
    'ko', 'lv', 'lt', 'mk', 'ms', 'ml', 'mt', 'mr', 'mn', 'no',
    'ps', 'pl', 'pt', 'pt-PT', 'pa', 'ro', 'ru', 'sr', 'si', 'sk',
    'sl', 'so', 'es', 'es-MX', 'sw', 'sv', 'ta', 'te', 'th', 'tr',
    'uk', 'ur', 'uz', 'vi', 'cy',
}

app = create_api_resolver()


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


@app.get("/settings/review")
@tracer.capture_method
def get_review_settings():
    """Get review configuration (primary language, etc.) from DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(Key={'pk': REVIEW_PK, 'sk': REVIEW_SK})
        item = response.get('Item')
        if not item:
            return {'primary_language': 'en'}
        return {'primary_language': item.get('primary_language', 'en')}
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get review settings: {e}")
        raise ServiceError('Failed to retrieve review settings')


@app.put("/settings/review")
@tracer.capture_method
def save_review_settings():
    """Save review configuration to DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = app.current_event.json_body
    primary_language = body.get('primary_language', 'en')

    if primary_language not in SUPPORTED_LANGUAGES:
        raise ValidationError(f'Unsupported language code: {primary_language}')

    try:
        item = {
            'pk': REVIEW_PK, 'sk': REVIEW_SK,
            'primary_language': primary_language,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': 'Review settings saved', 'settings': {'primary_language': primary_language}}
    except Exception as e:
        logger.exception(f"Failed to save review settings: {e}")
        raise ServiceError('Failed to save review settings')


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
