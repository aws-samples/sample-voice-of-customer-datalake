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

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

SETTINGS_PK = "SETTINGS#brand"
SETTINGS_SK = "config"
CATEGORIES_PK = "SETTINGS#categories"
CATEGORIES_SK = "config"

# Configure CORS - restrict to CloudFront domain in production
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN, allow_headers=["Content-Type", "Authorization"], max_age=300
)
app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


@app.get("/settings/brand")
@tracer.capture_method
def get_brand_settings():
    """Get brand configuration from DynamoDB."""
    if not aggregates_table:
        return {'error': 'Aggregates table not configured'}
    try:
        response = aggregates_table.get_item(Key={'pk': SETTINGS_PK, 'sk': SETTINGS_SK})
        item = response.get('Item')
        if not item:
            return {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []}
        return {'brand_name': item.get('brand_name', ''), 'brand_handles': item.get('brand_handles', []),
                'hashtags': item.get('hashtags', []), 'urls_to_track': item.get('urls_to_track', [])}
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        return {'error': 'Failed to retrieve brand settings'}


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save brand configuration to DynamoDB."""
    if not aggregates_table:
        return {'success': False, 'message': 'Aggregates table not configured'}
    body = app.current_event.json_body
    try:
        item = {'pk': SETTINGS_PK, 'sk': SETTINGS_SK, 'brand_name': body.get('brand_name', ''),
                'brand_handles': body.get('brand_handles', []), 'hashtags': body.get('hashtags', []),
                'urls_to_track': body.get('urls_to_track', []), 'updated_at': datetime.now(timezone.utc).isoformat()}
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': 'Brand settings saved', 'settings': {k: item[k] for k in ['brand_name', 'brand_handles', 'hashtags', 'urls_to_track']}}
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        return {'success': False, 'message': 'Failed to save brand settings'}


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
        return {'success': False, 'message': 'Aggregates table not configured'}
    body = app.current_event.json_body
    categories = body.get('categories', [])
    try:
        item = {'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': categories, 'updated_at': datetime.now(timezone.utc).isoformat()}
        aggregates_table.put_item(Item=item)
        return {'success': True, 'message': f'Saved {len(categories)} categories'}
    except Exception as e:
        logger.exception(f"Failed to save categories config: {e}")
        return {'success': False, 'message': 'Failed to save categories'}


@app.post("/settings/categories/generate")
@tracer.capture_method
def generate_categories():
    """Use LLM to generate category suggestions based on company description."""
    body = app.current_event.json_body
    company_description = body.get('company_description', '')
    if not company_description:
        return {'success': False, 'message': 'Company description is required'}
    
    try:
        bedrock = get_bedrock_client()
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

        bedrock_response = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 2000,
                "temperature": 0.3,
                "messages": [{"role": "user", "content": prompt}],
            }),
        )
        
        result = json.loads(bedrock_response["body"].read())
        response_text = result["content"][0]["text"]

        json_match = re.search(r"\{[\s\S]*\}", response_text)
        if json_match:
            parsed = json.loads(json_match.group())
            return {"success": True, "categories": parsed.get("categories", [])}
        return {"success": False, "message": "Could not parse categories from response"}
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        return {'success': False, 'message': 'Failed to generate categories'}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
