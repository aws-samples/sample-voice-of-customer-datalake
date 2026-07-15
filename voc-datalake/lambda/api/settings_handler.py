"""
Settings API Lambda - Handles /settings/*
Manages brand configuration and categories.
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
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

# Resolution keys are derived CLIENT-side from similarity groups, so a key
# can be orphaned forever when its group re-forms differently (issue #159):
# nothing would ever unresolve it and it would hold one of the 500 slots.
# Entries therefore expire after this many days: GET filters them out (an
# old resolution resurfaces for re-review) and hitting the entry cap prunes
# them from storage. 0 disables expiry entirely.
def _parse_ttl_days(raw: str | None) -> int:
    """Parse the TTL env var defensively: the Lambda environment is a system
    boundary, and a console typo ("180d") must degrade to the default with a
    warning — not crash the whole settings Lambda at import."""
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid RESOLVED_PROBLEMS_TTL_DAYS; falling back to default",
            extra={"raw_value": raw, "default_days": 180},
        )
        return 180


RESOLVED_PROBLEMS_TTL_DAYS = _parse_ttl_days(os.environ.get('RESOLVED_PROBLEMS_TTL_DAYS', '180'))
# REMOVE-expression chunk size when pruning (bounded so the update
# expression stays far below DynamoDB's 4KB expression limit).
_PRUNE_CHUNK_SIZE = 20

app = create_api_resolver()


def _resolution_expiry_cutoff() -> str | None:
    """ISO-8601 cutoff below which resolutions are expired, or None when
    expiry is disabled. Stored timestamps are UTC isoformat, so plain
    lexicographic comparison is correct."""
    if RESOLVED_PROBLEMS_TTL_DAYS <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=RESOLVED_PROBLEMS_TTL_DAYS)).isoformat()


def _is_expired_entry(entry: Any, cutoff: str) -> bool:
    """An entry is expired when its resolved_at predates the cutoff.
    Malformed entries (missing/non-string resolved_at) count as expired:
    they can't be compared, can't be displayed meaningfully, and would
    otherwise hold a cap slot forever."""
    if not isinstance(entry, dict):
        return True
    resolved_at = entry.get('resolved_at')
    if not isinstance(resolved_at, str) or not resolved_at:
        return True
    return resolved_at < cutoff


def _without_expired(resolved: Any) -> dict:
    # Same malformed-storage guard as _prune_expired_entries (symmetry):
    # a non-dict value degrades to "nothing resolved", not a 500.
    if not isinstance(resolved, dict):
        return {}
    cutoff = _resolution_expiry_cutoff()
    if cutoff is None:
        return resolved
    return {key: entry for key, entry in resolved.items() if not _is_expired_entry(entry, cutoff)}


@app.get("/settings/resolved-problems")
@tracer.capture_method
def get_resolved_problems():
    """Get the map of problems marked as resolved on the Problem Analysis page.

    Shape: {'resolved': {problem_key: {'resolved_at': iso8601}}}. Shared
    across all users by design (issue #66) — resolving a problem clears it
    from everyone's working view. Entries older than
    RESOLVED_PROBLEMS_TTL_DAYS are filtered out (issue #159): the problem
    resurfaces for re-review, and the stored entry is reclaimed the next
    time the entry cap is under pressure.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK}
        )
        return {'resolved': _without_expired(response.get('Item', {}).get('resolved', {}))}
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


@tracer.capture_method
def _prune_expired_entries() -> int:
    """Remove expired entries from storage; returns how many were removed.

    Called only under cap pressure (a resolve hit the entry cap), keeping
    the steady state at one write per request. Removals are chunked so the
    UpdateExpression stays small; each chunk is one atomic REMOVE.

    Known race, accepted: the stale list is a get_item snapshot, and GET
    already filters expired entries — so a user could re-resolve one of
    these keys (fresh resolved_at) between the snapshot and the REMOVE,
    losing the fresh entry. The window is milliseconds wide, requires the
    same key, and self-heals (resolving again just works); a per-key
    conditional REMOVE would trade that for N extra conditional writes.
    """
    cutoff = _resolution_expiry_cutoff()
    if cutoff is None:
        return 0
    response = aggregates_table.get_item(
        Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK}
    )
    resolved = response.get('Item', {}).get('resolved', {})
    if not isinstance(resolved, dict):
        # Malformed storage — nothing safely prunable.
        return 0
    stale = [key for key, entry in resolved.items() if _is_expired_entry(entry, cutoff)]
    for start in range(0, len(stale), _PRUNE_CHUNK_SIZE):
        chunk = stale[start:start + _PRUNE_CHUNK_SIZE]
        names = {f'#k{i}': key for i, key in enumerate(chunk)}
        aggregates_table.update_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
            UpdateExpression='REMOVE ' + ', '.join(f'#r.{alias}' for alias in names),
            ExpressionAttributeNames={'#r': 'resolved', **names},
        )
    if stale:
        logger.info(
            "Pruned expired resolved-problem entries under cap pressure",
            extra={"count": len(stale)},
        )
    return len(stale)


def _resolve_problem_key(key: str) -> None:
    """Conditionally set the entry, materializing the parent map on first use.

    DynamoDB reports a missing parent map either as a document-path
    ValidationException or as a failed condition (functions on missing
    attributes evaluate false), depending on evaluation order — so both
    first-attempt failures fall through to ensure-parent + one retry, and
    only a retry failure means the cap was genuinely reached. At that point
    expired entries are pruned (issue #159) and the write retried once more;
    the cap error only surfaces when the map is full of LIVE entries.
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
        return
    except ClientError as e:
        if e.response.get('Error', {}).get('Code', '') != 'ConditionalCheckFailedException':
            raise
        cap_error = e
    # Cap reached: reclaim slots held by expired (often orphaned) entries.
    if _prune_expired_entries() > 0:
        try:
            _set_resolved_entry(key)
            return
        except ClientError as e:
            if e.response.get('Error', {}).get('Code', '') != 'ConditionalCheckFailedException':
                raise
            cap_error = e
    raise ValidationError(
        f'Resolved-problem limit reached ({MAX_RESOLVED_ENTRIES}). '
        'Unresolve entries you no longer need first.'
    ) from cap_error


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
