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
from shared.aws import get_dynamodb_resource
from shared.api import create_api_resolver, api_handler, require_admin
from shared.exceptions import ConfigurationError, ValidationError, ServiceError
from shared.model_config import (
    ALLOWED_MODELS, ALLOWED_MODEL_IDS, PICKER_SURFACES, SURFACE_DEFAULTS,
    MODEL_SETTINGS_PK, MODEL_SETTINGS_SK, clear_model_cache,
)

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


@app.get("/settings/model")
@tracer.capture_method
def get_model_settings():
    """Get the per-surface model overrides and the curated allowlist (issue #96).

    Returns the allowlist plus, for each pickable surface, its built-in
    default and the admin-selected override (``selected`` is null when the
    surface is on Automatic). ``model_id`` is a legacy global override kept
    for backward compatibility with the earlier single-model picker; when
    set it applies to any surface left on Automatic.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(
            Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
        )
        item = response.get('Item') or {}
        stored = item.get('surfaces')
        stored = stored if isinstance(stored, dict) else {}
        legacy_global = item.get('model_id')
        surfaces = [
            {
                'key': key,
                'default_id': SURFACE_DEFAULTS[key],
                # Ignore any stored value that has since left the allowlist.
                'selected': stored.get(key) if stored.get(key) in ALLOWED_MODEL_IDS else None,
            }
            for key in PICKER_SURFACES
        ]
        return {
            'available_models': ALLOWED_MODELS,
            'surfaces': surfaces,
            'model_id': legacy_global if legacy_global in ALLOWED_MODEL_IDS else None,
        }
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get model settings: {e}")
        raise ServiceError('Failed to retrieve model settings')


@app.put("/settings/model")
@tracer.capture_method
def save_model_settings():
    """Set or clear a per-surface Bedrock model override (issue #96).

    Body shapes:
      - ``{'surface': <picker surface>, 'model_id': <allowlisted id>}`` — pin
        that surface to a model.
      - ``{'surface': <picker surface>, 'model_id': null}`` — clear the
        surface (back to Automatic / its default).
      - ``{'model_id': <allowlisted id>|null}`` (no ``surface``) — set/clear
        the legacy global override that applies to every un-pinned surface.

    Admin-only: this changes inference cost/quality for the whole org, so it
    is gated on the ``admins`` Cognito group server-side (not just in the UI).
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
    surface = body.get('surface')
    if surface is not None and surface not in PICKER_SURFACES:
        raise ValidationError(
            f"surface must be null or one of: {', '.join(PICKER_SURFACES)}"
        )
    try:
        if surface is None:
            _save_global_model(model_id)
        else:
            _save_surface_model(surface, model_id)
        # Refresh this Lambda's own cache; other containers pick it up within the TTL.
        clear_model_cache()
        return {'success': True, 'surface': surface, 'model_id': model_id}
    except Exception as e:
        logger.exception(f"Failed to save model settings: {e}")
        raise ServiceError('Failed to save model settings')


def _load_model_item() -> dict:
    """Read the model-settings item as a dict with a guaranteed surfaces map.

    Config writes are a rare admin action, so read-modify-write is simpler and
    safer than nested-map update expressions (which ValidationException when
    the parent map doesn't exist yet).
    """
    response = aggregates_table.get_item(
        Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
    )
    item = response.get('Item') or {}
    if not isinstance(item.get('surfaces'), dict):
        item['surfaces'] = {}
    return item


def _put_model_item(item: dict) -> None:
    item['pk'] = MODEL_SETTINGS_PK
    item['sk'] = MODEL_SETTINGS_SK
    item['updated_at'] = datetime.now(timezone.utc).isoformat()
    # Keep the item tidy: drop an empty surfaces map and a null legacy global.
    if not item.get('surfaces'):
        item.pop('surfaces', None)
    if item.get('model_id') is None:
        item.pop('model_id', None)
    aggregates_table.put_item(Item=item)


def _save_surface_model(surface: str, model_id: str | None) -> None:
    item = _load_model_item()
    if model_id is None:
        item['surfaces'].pop(surface, None)
    else:
        item['surfaces'][surface] = model_id
    _put_model_item(item)


def _save_global_model(model_id: str | None) -> None:
    item = _load_model_item()
    if model_id is None:
        item.pop('model_id', None)
    else:
        item['model_id'] = model_id
    _put_model_item(item)


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
    try:
        # JSON happily carries unpaired surrogates ("\ud800"); encoding them
        # raises, which would 500 here and in the DynamoDB client. Reject
        # them as the client error they are.
        key_bytes = len(key.encode('utf-8'))
    except UnicodeEncodeError as encode_error:
        raise ValidationError(
            'key must be valid Unicode (no unpaired surrogates)'
        ) from encode_error
    if key_bytes > MAX_PROBLEM_KEY_BYTES:
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

    The no-op is detected by a ConditionExpression on the parent map —
    ConditionalCheckFailedException is a stable error CODE, unlike the
    document-path ValidationException message text, which is not
    contractual across SDK/service versions.
    """
    try:
        aggregates_table.update_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
            UpdateExpression='REMOVE #r.#k',
            ConditionExpression='attribute_exists(#r)',
            ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        )
    except ClientError as e:
        if e.response.get('Error', {}).get('Code', '') != 'ConditionalCheckFailedException':
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

        # 4096 (was 2000): Sonnet 5's always-on adaptive thinking counts
        # against maxTokens, and a truncated strict-JSON response can't be
        # stitched reliably by auto-continuation (live-caught: the resume seam
        # dropped a comma → JSONDecodeError). Headroom keeps it to one call.
        response_text = converse(prompt=prompt, max_tokens=4096, temperature=0.3, surface='utility')

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
