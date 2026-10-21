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

from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.api import create_api_resolver, api_handler, require_admin, get_caller_subject
from shared.exceptions import (
    ConfigurationError, ConflictError, NotFoundError, ValidationError, ServiceError,
)
from shared import data_quality as dq
from shared.enrichment_fields import (
    ENRICHMENT_FIELDS,
    field_names as enrichment_field_names,
    get_field as get_enrichment_field,
)
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
CUSTOM_FILTERS_PK = "SETTINGS#custom_filters"
CUSTOM_FILTERS_SK = "config"

# Admins may expose at most this many custom-field filters on the feedback UI.
# A hard cap (not just UI advice) because each one is an in-memory post-filter
# over the candidate window on three read endpoints — the ceiling bounds that
# cost and keeps the filter bar legible.
MAX_CUSTOM_FILTERS = 3
# A custom-filter key is a custom_fields map key; mirror the processor's
# MAX_CUSTOM_FIELD_KEY_LENGTH (64) so a configured key can actually match a
# stored one. Restated rather than imported — the settings bundle does not
# include the processor module.
MAX_CUSTOM_FILTER_KEY_LENGTH = 64
MAX_CUSTOM_FILTER_LABEL_LENGTH = 64
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


@app.get("/settings/custom-filters")
@tracer.capture_method
def get_custom_filters():
    """Get the admin-chosen custom-field filters exposed on the feedback UI.

    Shape: ``{'custom_filters': [{'key': str, 'label': str}, ...]}`` — up to
    MAX_CUSTOM_FILTERS entries. Readable by any authenticated user: the filter
    UI is for everyone; only CHOOSING the filters is admin-gated (the PUT).
    """
    if not aggregates_table:
        return {'custom_filters': []}
    try:
        response = aggregates_table.get_item(Key={'pk': CUSTOM_FILTERS_PK, 'sk': CUSTOM_FILTERS_SK})
        item = response.get('Item')
        if not item:
            return {'custom_filters': [], 'updated_at': None}
        return {
            'custom_filters': item.get('custom_filters', []),
            'updated_at': item.get('updated_at'),
        }
    except Exception as e:
        logger.exception(f"Failed to get custom filters: {e}")
        return {'custom_filters': [], 'error': 'Failed to retrieve custom filters'}


def _validate_custom_filters(raw) -> list[dict]:
    """Validate and normalize a custom-filters payload into stored shape.

    Accepts a list of entries, each an object with a non-empty ``key`` (a
    custom_fields map key) and an optional ``label``. Enforces the count cap,
    bounds the key/label lengths, trims, drops blanks, and de-duplicates by key
    (first wins). Raises ValidationError on a malformed payload so a bad admin
    request is a 400, not a silently-stored broken config.
    """
    if not isinstance(raw, list):
        raise ValidationError('custom_filters must be a list')
    if len(raw) > MAX_CUSTOM_FILTERS:
        raise ValidationError(f'At most {MAX_CUSTOM_FILTERS} custom filters are allowed')

    cleaned: list[dict] = []
    seen_keys: set[str] = set()
    for idx, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValidationError(f'custom_filters[{idx}] must be an object')
        key = entry.get('key')
        if not isinstance(key, str) or not key.strip():
            raise ValidationError(f'custom_filters[{idx}].key is required')
        key = key.strip()
        if len(key) > MAX_CUSTOM_FILTER_KEY_LENGTH:
            raise ValidationError(
                f'custom_filters[{idx}].key exceeds {MAX_CUSTOM_FILTER_KEY_LENGTH} characters'
            )
        if key in seen_keys:
            continue  # Duplicate key — first occurrence wins.
        seen_keys.add(key)
        # Label is a display name; default to the key when absent.
        label = entry.get('label')
        label = label.strip() if isinstance(label, str) and label.strip() else key
        cleaned.append({'key': key, 'label': label[:MAX_CUSTOM_FILTER_LABEL_LENGTH]})
    return cleaned


@app.put("/settings/custom-filters")
@tracer.capture_method
def save_custom_filters():
    """Save the custom-field filters exposed on the feedback UI.

    Admin-only: this is an org-wide configuration (every user sees the same
    filters), so it is gated on the ``admins`` Cognito group server-side,
    matching the model-picker handler — not the un-gated brand/categories ones.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    require_admin(app.current_event.raw_event)
    body = app.current_event.json_body or {}
    custom_filters = _validate_custom_filters(body.get('custom_filters', []))
    try:
        item = {
            'pk': CUSTOM_FILTERS_PK,
            'sk': CUSTOM_FILTERS_SK,
            'custom_filters': custom_filters,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }
        aggregates_table.put_item(Item=item)
        return {'success': True, 'custom_filters': custom_filters}
    except Exception as e:
        logger.exception(f"Failed to save custom filters: {e}")
        raise ServiceError('Failed to save custom filters')


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

        # 4096: strict-JSON output must fit ONE call (see the strict-JSON
        # doctrine in shared/converse.py).
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


# ============================================
# Data Quality (async profile + enrichment jobs)
# ============================================
#
# The routes only record a job and enqueue its first message; the
# voc-data-quality-worker Lambda does the scanning and the Bedrock calls (see
# shared/data_quality.py). Admin-only: a recalculation spends one model call per
# row of a source.

DATA_QUALITY_QUEUE_URL = os.environ.get('DATA_QUALITY_QUEUE_URL', '')
_DATA_QUALITY_JOB_ID = re.compile(r'^dq_\d{14}_[0-9a-f]{8}$')
_JOB_COUNTERS = ('total', 'processed', 'updated', 'skipped', 'failed')


def _public_job(item: dict) -> dict:
    """A job record as the UI reads it: counters as ints, no table keys."""
    job = {
        key: item.get(key)
        for key in ('job_id', 'kind', 'source', 'field', 'mode', 'status',
                    'created_at', 'updated_at', 'completed_at', 'error')
        if item.get(key) is not None
    }
    job.update({key: int(item.get(key, 0) or 0) for key in _JOB_COUNTERS})
    job['planned'] = bool(item.get('planned'))
    return job


def _require_data_quality_backend() -> None:
    if not aggregates_table or not DATA_QUALITY_QUEUE_URL:
        raise ConfigurationError('Data quality jobs are not configured')


def _validated_job_request(body: dict) -> dict:
    """The job description to store, or a ValidationError naming the bad field."""
    kind = body.get('kind')
    if kind == dq.KIND_PROFILE:
        return {'kind': dq.KIND_PROFILE}
    if kind != dq.KIND_ENRICH:
        raise ValidationError(f'kind must be one of: {dq.KIND_PROFILE}, {dq.KIND_ENRICH}')
    field = body.get('field')
    if not isinstance(field, str) or get_enrichment_field(field) is None:
        raise ValidationError(f'field must be one of: {", ".join(enrichment_field_names())}')
    mode = body.get('mode')
    if mode not in dq.ENRICH_MODES:
        raise ValidationError(f'mode must be one of: {", ".join(dq.ENRICH_MODES)}')
    source = body.get('source')
    if not isinstance(source, str) or not source.strip() or len(source) > dq.MAX_SOURCE_LENGTH:
        raise ValidationError(f'source must be a non-empty string of at most {dq.MAX_SOURCE_LENGTH} characters')
    return {'kind': dq.KIND_ENRICH, 'field': field, 'mode': mode, 'source': source}


def _first_message(job: dict) -> dict:
    if job['kind'] == dq.KIND_PROFILE:
        return {'type': dq.MSG_PROFILE_SCAN, 'job_id': job['job_id']}
    return {
        'type': dq.MSG_ENRICH_PLAN, 'job_id': job['job_id'],
        'source': job['source'], 'field': job['field'], 'mode': job['mode'],
    }


@app.get("/settings/data-quality")
@tracer.capture_method
def get_data_quality():
    """The last profile snapshot, the registry fields, and recent jobs."""
    require_admin(app.current_event.raw_event)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    snapshot = aggregates_table.get_item(Key={'pk': dq.STATS_PK, 'sk': dq.STATS_SK}).get('Item')
    return {
        'fields': [{'name': f.name, 'values': list(f.values)} for f in ENRICHMENT_FIELDS],
        'stats': dq.to_plain({
            'generated_at': snapshot.get('generated_at'),
            'scanned': snapshot.get('scanned', 0),
            'sources': snapshot.get('sources', []),
        }) if snapshot else None,
        'jobs': [_public_job(item) for item in dq.list_recent_jobs(aggregates_table)],
    }


@app.post("/settings/data-quality/jobs")
@tracer.capture_method
def start_data_quality_job():
    """Start a profile or an enrichment job; 409 when one already runs for the target."""
    event = app.current_event.raw_event
    require_admin(event)
    _require_data_quality_backend()
    body = app.current_event.json_body
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    request = _validated_job_request(body)

    job = {**request, 'job_id': dq.new_job_id(), 'started_by': get_caller_subject(event)}
    lock = dq.job_lock_sk(job)
    if not dq.acquire_lock(aggregates_table, lock, job['job_id']):
        raise ConflictError('A data quality job is already running for this target')
    try:
        record = dq.create_job_record(aggregates_table, job)
        get_sqs_client().send_message(
            QueueUrl=DATA_QUALITY_QUEUE_URL, MessageBody=dq.to_json(_first_message(job)),
        )
    except ClientError as e:
        logger.exception(f"Failed to start data quality job: {e}")
        _abandon_unstarted_job(job, lock)
        raise ServiceError('Failed to start data quality job')
    return {'success': True, 'job': _public_job(record)}


def _abandon_unstarted_job(job: dict, lock: str) -> None:
    """Undo a start that failed after taking the lock, so the target is not blocked.

    `finish_job` releases the lock when it moves an existing record to failed;
    when the record was never written there is nothing to transition, so the lock
    is released directly.
    """
    try:
        if not dq.finish_job(aggregates_table, job, dq.STATUS_FAILED, 'Could not enqueue the job'):
            dq.release_lock(aggregates_table, lock, job['job_id'])
    except ClientError:
        logger.warning("Could not clean up the unstarted data quality job; its lock expires on its own")


@app.post("/settings/data-quality/jobs/<job_id>/cancel")
@tracer.capture_method
def cancel_data_quality_job(job_id: str):
    """Stop a running job; queued messages for it are dropped by the worker."""
    require_admin(app.current_event.raw_event)
    _require_data_quality_backend()
    if not _DATA_QUALITY_JOB_ID.match(job_id):
        raise ValidationError('Invalid job id')
    job = dq.get_job(aggregates_table, job_id)
    if not job:
        raise NotFoundError('Job not found')
    if not dq.finish_job(aggregates_table, job, dq.STATUS_CANCELLED):
        raise ConflictError('Job is not running')
    return {'success': True, 'job': _public_job({**job, 'status': dq.STATUS_CANCELLED})}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
