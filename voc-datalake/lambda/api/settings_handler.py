"""
Settings API Lambda - Handles /settings/*
Manages brand configuration and categories.
"""

import hashlib
import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Category reprocess routes (see the section at the end of this module).
from aws_lambda_powertools.event_handler import Response, content_types

from shared import category_access, company_context, design_references, model_capacity, onboarding, reprocess_jobs
from shared.api import (
    ALL_TIME_DAYS,
    MAX_FEEDBACK_WINDOW_DAYS,
    api_handler,
    create_api_resolver,
    get_caller_groups,
    get_caller_subject,
    require_admin,
    validate_bool,
)
from shared.aws import get_dynamodb_resource, get_s3_client, get_secrets_client, invoke_lambda_async, put_secret_json
from shared.category_access import CategoryScope
from shared.category_config import validate_categories
from shared.category_gate import scope_for_caller
from shared.dimension_config import DIMENSIONS_SETTINGS_KEY, load_dimensions_config, validate_dimensions
from shared.exceptions import ConfigurationError, ConflictError, NotFoundError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    ALLOWED_MODELS,
    MODEL_SETTINGS_PK,
    MODEL_SETTINGS_SK,
    PICKER_SURFACES,
    SURFACE_DEFAULTS,
    clear_model_cache,
)
from shared.project_gate import caller_from_event
from shared.request_body import json_body_value, json_object_body
from shared.source_profiles import (
    SOURCE_ID_RE,
    SOURCES_SETTINGS_KEY,
    clear_source_profiles_cache,
    load_source_profiles,
    validate_source_profiles,
)

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
CATEGORY_REPROCESS_FUNCTION = os.environ.get("CATEGORY_REPROCESS_FUNCTION", "")
# The retention / erasure worker (`voc-retention`), started by POST /settings/erasure.
RETENTION_FUNCTION = os.environ.get("RETENTION_FUNCTION", "")

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
_DEFAULT_TTL_DAYS = 180


def _parse_ttl_days(raw: str | None) -> int:
    """Parse the TTL env var defensively: the Lambda environment is a system
    boundary, and a console typo ("180d") must degrade to the default with a
    warning — not crash the whole settings Lambda at import."""
    if raw is not None:
        try:
            return int(raw)
        except ValueError:
            pass
    logger.warning(
        "Invalid RESOLVED_PROBLEMS_TTL_DAYS; falling back to default",
        extra={"raw_value": raw, "default_days": _DEFAULT_TTL_DAYS},
    )
    return _DEFAULT_TTL_DAYS


RESOLVED_PROBLEMS_TTL_DAYS = _parse_ttl_days(os.environ.get('RESOLVED_PROBLEMS_TTL_DAYS', str(_DEFAULT_TTL_DAYS)))
# REMOVE-expression chunk size when pruning (bounded so the update
# expression stays far below DynamoDB's 4KB expression limit).
_PRUNE_CHUNK_SIZE = 20

app = create_api_resolver()


def _configured_table():
    """The aggregates table, or a ConfigurationError when the Lambda has none."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    return aggregates_table


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
        result = {
            'available_models': ALLOWED_MODELS,
            'surfaces': surfaces,
            'model_id': legacy_global if legacy_global in ALLOWED_MODEL_IDS else None,
        }
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get model settings: {e}")
        raise ServiceError('Failed to retrieve model settings') from e
    else:
        return result


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
    body = json_object_body(app)
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
    except Exception as e:
        logger.exception(f"Failed to save model settings: {e}")
        raise ServiceError('Failed to save model settings') from e
    else:
        return {'success': True, 'surface': surface, 'model_id': model_id}


@app.post("/settings/model/test")
@tracer.capture_method
def run_model_test():
    """Send ONE minimal request to exactly one allowlisted model and report the outcome.

    Admin-only (it spends a model call). No fallback and no retry: the answer is
    about the model named in the body, never a stand-in (shared/model_capacity.py).
    """
    require_admin(app.current_event.raw_event)
    body = json_object_body(app)
    model_id = body.get('model_id')
    if not isinstance(model_id, str) or model_id not in ALLOWED_MODEL_IDS:
        raise ValidationError(f"model_id must be one of: {', '.join(sorted(ALLOWED_MODEL_IDS))}")
    return model_capacity.probe_model(model_id)


@app.get("/settings/model/capacity")
@tracer.capture_method
def get_model_capacity():
    """Every allowlisted model with its tokens-per-minute quota (no model call). Admin-only."""
    require_admin(app.current_event.raw_event)
    return {'models': model_capacity.capacity_overview()}


def _load_model_item() -> dict:
    """Read the model-settings item as a dict with a guaranteed surfaces map.

    Config writes are a rare admin action, so read-modify-write is simpler and
    safer than nested-map update expressions (which ValidationException when
    the parent map doesn't exist yet).
    """
    response = _configured_table().get_item(
        Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}
    )
    item = response.get('Item') or {}
    if not isinstance(item.get('surfaces'), dict):
        item['surfaces'] = {}
    return item


def _put_model_item(item: dict) -> None:
    item['pk'] = MODEL_SETTINGS_PK
    item['sk'] = MODEL_SETTINGS_SK
    item['updated_at'] = datetime.now(UTC).isoformat()
    # Keep the item tidy: drop an empty surfaces map and a null legacy global.
    if not item.get('surfaces'):
        item.pop('surfaces', None)
    if item.get('model_id') is None:
        item.pop('model_id', None)
    _configured_table().put_item(Item=item)


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
    return (datetime.now(UTC) - timedelta(days=RESOLVED_PROBLEMS_TTL_DAYS)).isoformat()


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
    body = json_object_body(app)

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
    except ValidationError:
        raise
    except Exception as e:
        logger.exception("Failed to update problem resolution")
        raise ServiceError('Failed to update problem resolution') from e
    else:
        return {'success': True, 'key': key, 'resolved': resolved}


def _error_code(error: ClientError) -> str | None:
    """The service error code of a boto failure (None when the response carries none)."""
    return error.response.get('Error', {}).get('Code')


def _set_resolved_entry(key: str) -> None:
    """Single conditional write: overwrite is always allowed; NEW entries
    only while the map is under the cap. Atomic — two concurrent resolves
    at the cap can't both slip through (review feedback on #153)."""
    _configured_table().update_item(
        Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
        UpdateExpression='SET #r.#k = :entry',
        ConditionExpression='attribute_exists(#r.#k) OR size(#r) < :max',
        ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        ExpressionAttributeValues={
            ':entry': {'resolved_at': datetime.now(UTC).isoformat()},
            ':max': MAX_RESOLVED_ENTRIES,
        },
    )


def _ensure_resolved_map() -> None:
    _configured_table().update_item(
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
    response = _configured_table().get_item(
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
        _configured_table().update_item(
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


def _attempt_resolve(key: str, tolerated_codes: tuple[str, ...]) -> ClientError | None:
    """One conditional resolve write: None on success, the error when its code
    is one of ``tolerated_codes``; any other failure propagates."""
    try:
        _set_resolved_entry(key)
    except ClientError as e:
        if _error_code(e) not in tolerated_codes:
            raise
        return e
    return None


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
    if _attempt_resolve(key, ('ConditionalCheckFailedException', 'ValidationException')) is None:
        return
    _ensure_resolved_map()
    cap_error = _attempt_resolve(key, ('ConditionalCheckFailedException',))
    if cap_error is None:
        return
    # Cap reached: reclaim slots held by expired (often orphaned) entries.
    if _prune_expired_entries() > 0:
        cap_error = _attempt_resolve(key, ('ConditionalCheckFailedException',))
        if cap_error is None:
            return
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
        _configured_table().update_item(
            Key={'pk': RESOLVED_PROBLEMS_PK, 'sk': RESOLVED_PROBLEMS_SK},
            UpdateExpression='REMOVE #r.#k',
            ConditionExpression='attribute_exists(#r)',
            ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        )
    except ClientError as e:
        if _error_code(e) != 'ConditionalCheckFailedException':
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
        result = {'brand_name': item.get('brand_name', ''), 'brand_handles': item.get('brand_handles', []),
                  'hashtags': item.get('hashtags', []), 'urls_to_track': item.get('urls_to_track', [])}
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        raise ServiceError('Failed to retrieve brand settings') from e
    else:
        return result


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save brand configuration to DynamoDB."""
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = json_object_body(app)
    try:
        item = {'pk': SETTINGS_PK, 'sk': SETTINGS_SK, 'brand_name': body.get('brand_name', ''),
                'brand_handles': body.get('brand_handles', []), 'hashtags': body.get('hashtags', []),
                'urls_to_track': body.get('urls_to_track', []), 'updated_at': datetime.now(UTC).isoformat()}
        aggregates_table.put_item(Item=item)
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        raise ServiceError('Failed to save brand settings') from e
    else:
        return {'success': True, 'message': 'Brand settings saved', 'settings': {k: item[k] for k in ['brand_name', 'brand_handles', 'hashtags', 'urls_to_track']}}


@app.get("/settings/categories")
@tracer.capture_method
def get_categories_config():
    """Get the categories configuration.

    Admins get the stored config verbatim (they edit it). Everyone else gets
    only the categories in their category-access scope, with each owner reduced
    to ``{username}`` — owner subs and emails are admin-only data.
    """
    if not aggregates_table:
        return {'categories': [], 'error': 'Aggregates table not configured'}
    caller = caller_from_event(app.current_event.raw_event)
    try:
        response = aggregates_table.get_item(Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK})
    except Exception as e:
        logger.exception(f"Failed to get categories config: {e}")
        return {'categories': [], 'error': 'Failed to retrieve categories'}
    item = response.get('Item')
    if not item:
        return {'categories': [], 'updated_at': None}
    categories = item.get('categories', [])
    if not (caller.is_admin and not caller.delegated):
        scope = scope_for_caller(caller, aggregates_table)
        categories = _redacted_categories(categories, scope)
    return {'categories': categories, 'updated_at': item.get('updated_at')}


def _public_owners(owners: object) -> list[dict]:
    """Owners as ``[{username}]`` (no sub/email); malformed entries dropped."""
    if not isinstance(owners, list):
        return []
    return [{'username': o.get('username') if isinstance(o.get('username'), str) else ''}
            for o in owners if isinstance(o, dict)]


def _redacted_categories(categories: object, scope: CategoryScope) -> list[dict]:
    """The categories ``scope`` may see, with owner identities reduced to usernames."""
    if not isinstance(categories, list):
        return []
    visible = []
    for category in categories:
        if not isinstance(category, dict) or not category_access.admits(scope, category.get('name')):
            continue
        entry = dict(category)
        if 'owners' in entry:
            entry['owners'] = _public_owners(entry['owners'])
        visible.append(entry)
    return visible


@app.put("/settings/categories")
@tracer.capture_method
def save_categories_config():
    """Save the categories configuration (admin only).

    Categories decide how every review is classified, map to the product they
    belong to and its product owners, and drive per-user category access
    (owners see their categories), so only admins may change them. The body is
    validated and normalised by `shared.category_config.validate_categories`.
    """
    require_admin(app.current_event.raw_event)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = json_body_value(app)
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    try:
        categories = validate_categories(body.get('categories', []))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    try:
        item = {'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': categories, 'updated_at': datetime.now(UTC).isoformat()}
        aggregates_table.put_item(Item=item)
    except Exception as e:
        logger.exception(f"Failed to save categories config: {e}")
        raise ServiceError('Failed to save categories') from e
    else:
        return {'success': True, 'message': f'Saved {len(categories)} categories'}


@app.post("/settings/categories/generate")
@tracer.capture_method
def generate_categories():
    """Use LLM to generate category suggestions based on company description."""
    body = json_object_body(app)
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
        categories = _categories_from_response(response_text)
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        raise ServiceError('Failed to generate categories') from e
    else:
        return {"success": True, "categories": categories}


def _categories_from_response(response_text: str) -> object:
    """The ``categories`` of the first JSON object in the model reply (ServiceError when there is none)."""
    json_match = re.search(r"\{[\s\S]*\}", response_text)
    if not json_match:
        raise ServiceError("Could not parse categories from response")
    return json.loads(json_match.group()).get("categories", [])


# ============================================
# Category reprocess jobs (worker: lambda/jobs/category_reprocess)
# ============================================

def _reprocess_days(value: object) -> int:
    """``days`` must be an explicit integer 0-9999 (0 = all time): a missing or
    coerced value would silently pick how much billed work to start."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError('days must be an integer (0 = all time)')
    if not ALL_TIME_DAYS <= value <= MAX_FEEDBACK_WINDOW_DAYS:
        raise ValidationError(f'days must be between {ALL_TIME_DAYS} and {MAX_FEEDBACK_WINDOW_DAYS}')
    return value


def _caller_label(event: dict) -> str:
    """Who started a job, for the admin-only job view (username, else email, else sub)."""
    claims = (event.get('requestContext') or {}).get('authorizer', {}).get('claims', {})
    for claim in ('cognito:username', 'username', 'email'):
        value = claims.get(claim) if isinstance(claims, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return get_caller_subject(event)


def _job_or_404(job_id: str) -> dict:
    job = reprocess_jobs.get_job(_configured_table(), job_id) if reprocess_jobs.is_job_id(job_id) else None
    if not job:
        raise NotFoundError('Reprocess job not found')
    return job


@app.post("/settings/categories/reprocess")
@tracer.capture_method
def start_category_reprocess():
    """Start re-categorising stored feedback (admin). 202 ``{job}``; 409 while one is active."""
    event = app.current_event.raw_event
    require_admin(event)
    table = _configured_table()
    if not CATEGORY_REPROCESS_FUNCTION:
        raise ConfigurationError('Category reprocess worker not configured')
    # Its own refusal wording is pinned, so only the parse comes from the helper;
    # `is None` (not `or {}`) so `[]`/`false` are refused rather than read as "no body".
    body = json_body_value(app)
    if body is None:
        body = {}
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    mode = body.get('mode')
    if mode not in reprocess_jobs.MODES:
        raise ValidationError(f"mode must be one of: {', '.join(reprocess_jobs.MODES)}")
    days = _reprocess_days(body.get('days'))
    include_manual = validate_bool(body.get('include_manual'), False, 'include_manual')

    job = reprocess_jobs.start_job(
        table, mode=mode, days=days, include_manual=include_manual,
        started_by=_caller_label(event), now=datetime.now(UTC),
    )
    if job is None:
        raise ConflictError('A reprocess job is already queued or running')
    try:
        invoke_lambda_async(CATEGORY_REPROCESS_FUNCTION, {'job_id': job['sk']})
    except Exception as e:
        logger.exception("Failed to start category reprocess worker")
        reprocess_jobs.finish_job(table, job['sk'], reprocess_jobs.STATUS_FAILED,
                                  error='Could not start the reprocess worker')
        raise ServiceError('Failed to start reprocess job') from e
    logger.info("Category reprocess started", extra={'job_id': job['sk'], 'mode': mode, 'days': days})
    return Response(
        status_code=202,
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({'job': reprocess_jobs.job_view(job)}),
    )


@app.get("/settings/categories/reprocess")
@tracer.capture_method
def get_latest_category_reprocess():
    """Latest reprocess job (admin) — ``{job: Job | null}``."""
    require_admin(app.current_event.raw_event)
    job = reprocess_jobs.get_latest_job(_configured_table())
    return {'job': reprocess_jobs.job_view(job) if job else None}


@app.get("/settings/categories/reprocess/<job_id>")
@tracer.capture_method
def get_category_reprocess(job_id: str):
    """One reprocess job (admin)."""
    require_admin(app.current_event.raw_event)
    return {'job': reprocess_jobs.job_view(_job_or_404(job_id))}


@app.post("/settings/categories/reprocess/<job_id>/cancel")
@tracer.capture_method
def cancel_category_reprocess(job_id: str):
    """Cancel a queued/running job (admin); a finished job is returned unchanged."""
    require_admin(app.current_event.raw_event)
    job = reprocess_jobs.cancel_job(_configured_table(), job_id) if reprocess_jobs.is_job_id(job_id) else None
    if not job:
        raise NotFoundError('Reprocess job not found')
    return {'job': reprocess_jobs.job_view(job)}


# ============================================
# Company context, personal context and the design system
# (storage + validation + prompt blocks: shared/company_context.py;
#  reference fetching: shared/design_references.py)
# ============================================

RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
DESIGN_INTEGRATIONS_SECRET_ARN = os.environ.get('DESIGN_INTEGRATIONS_SECRET_ARN', '')
# Direct (non-API Gateway) invocation this Lambda sends ITSELF to refresh a
# design reference off the 29 s request path. An API Gateway event always
# carries `httpMethod`, so it can never take this branch.
DESIGN_REFRESH_ACTION = 'design_reference_refresh'
UPLOAD_URL_TTL_SECONDS = 600
INTEGRATION_FIELDS = {'figma_token': 'figma', 'github_token': 'github'}
MAX_INTEGRATION_TOKEN_CHARS = 1_000


def _caller_username(event: dict) -> str | None:
    """Display username of the caller (never the sub or the email)."""
    claims = (event.get('requestContext') or {}).get('authorizer', {}).get('claims', {})
    for claim in ('cognito:username', 'username'):
        value = claims.get(claim) if isinstance(claims, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@app.get("/settings/company-context")
@tracer.capture_method
def get_company_context_route():
    """Company vision + objectives — readable by every signed-in user."""
    return company_context.get_company_context(_configured_table())


@app.put("/settings/company-context")
@tracer.capture_method
def put_company_context_route():
    """Replace the company vision + objectives (admin only)."""
    event = app.current_event.raw_event
    require_admin(event)
    table = _configured_table()
    clean = company_context.validate_company_context(json_object_body(app))
    table.put_item(Item={
        'pk': company_context.COMPANY_CONTEXT_PK, 'sk': company_context.CONFIG_SK,
        **clean, 'updated_at': _now_iso(), 'updated_by_username': _caller_username(event),
    })
    logger.info('Company context saved', extra={'objectives': len(clean['objectives'])})
    return company_context.get_company_context(table)


@app.get("/settings/my-context")
@tracer.capture_method
def get_my_context_route():
    """The caller's own objectives and KPIs."""
    sub = get_caller_subject(app.current_event.raw_event)
    return company_context.get_my_context(_configured_table(), sub)


@app.put("/settings/my-context")
@tracer.capture_method
def put_my_context_route():
    """Replace the caller's own objectives and KPIs (self only — keyed by the caller's sub)."""
    sub = get_caller_subject(app.current_event.raw_event)
    table = _configured_table()
    clean = company_context.validate_my_context(json_object_body(app))
    table.put_item(Item={
        'pk': company_context.user_context_pk(sub), 'sk': company_context.CONFIG_SK,
        **clean, 'updated_at': _now_iso(),
    })
    return company_context.get_my_context(table, sub)


@app.get("/settings/my-onboarding")
@tracer.capture_method
def get_my_onboarding_route():
    """The caller's onboarding-buddy preference + first-run signals (self only)."""
    sub = get_caller_subject(app.current_event.raw_event)
    return onboarding.get_onboarding(_configured_table(), sub)


@app.put("/settings/my-onboarding")
@tracer.capture_method
def put_my_onboarding_route():
    """Set the caller's own buddy state and/or start page (``{state?, start_page?}``)."""
    sub = get_caller_subject(app.current_event.raw_event)
    changes = onboarding.validate_preference(json_object_body(app))
    return onboarding.put_onboarding(_configured_table(), sub, changes)


# ── Design integrations secret (write-only through the API) ──────────────────

def _read_integration_secret() -> dict:
    """The integrations secret, read fresh (never cached: a token just saved by
    another container must be what the next refresh uses). {} when unset."""
    if not DESIGN_INTEGRATIONS_SECRET_ARN:
        return {}
    try:
        raw = get_secrets_client().get_secret_value(SecretId=DESIGN_INTEGRATIONS_SECRET_ARN).get('SecretString')
        value = json.loads(raw) if raw else {}
    except ClientError as e:
        if _error_code(e) == 'ResourceNotFoundException':
            return {}
        logger.warning('Design integrations secret unreadable')
        return {}
    except ValueError:
        logger.warning('Design integrations secret is not JSON')
        return {}
    return value if isinstance(value, dict) else {}


def _integrations_status(secret: dict) -> dict:
    """``{figma: bool, github: bool}`` — whether a token is set, never the token."""
    return {flag: bool(isinstance(secret.get(key), str) and secret.get(key))
            for key, flag in INTEGRATION_FIELDS.items()}


@app.put("/settings/design-system/integrations")
@tracer.capture_method
def put_design_integrations_route():
    """Set (string) or clear (null / '') the Figma and GitHub tokens (admin, write-only)."""
    require_admin(app.current_event.raw_event)
    if not DESIGN_INTEGRATIONS_SECRET_ARN:
        raise ConfigurationError('Design integrations secret not configured')
    body = json_object_body(app)
    unknown = set(body) - set(INTEGRATION_FIELDS)
    if unknown:
        raise ValidationError(f'Unknown field(s): {", ".join(sorted(unknown))}')
    secret = _read_integration_secret()
    for key in INTEGRATION_FIELDS:
        if key not in body:
            continue
        value = body[key]
        if value in (None, ''):
            secret.pop(key, None)
        elif isinstance(value, str) and len(value.strip()) <= MAX_INTEGRATION_TOKEN_CHARS and value.strip():
            secret[key] = value.strip()
        else:
            raise ValidationError(f'{key} must be a string of at most {MAX_INTEGRATION_TOKEN_CHARS} characters, or null')
    put_secret_json(get_secrets_client(), DESIGN_INTEGRATIONS_SECRET_ARN, secret)
    logger.info('Design integrations updated', extra={'fields': sorted(k for k in body if k in INTEGRATION_FIELDS)})
    return {'integrations': _integrations_status(secret)}


# ── Design system + references ───────────────────────────────────────────────

def _design_view(table, *, include_archived: bool = False) -> dict:
    view = company_context.get_design_system(table, include_archived=include_archived)
    view['integrations'] = _integrations_status(_read_integration_secret())
    logo_key = _current_logo_key(table)
    if logo_key:
        view['logo_url'] = _signed_logo_url(logo_key)
    return view


# ── Company logo ─────────────────────────────────────────────────────────────
# An uploaded logo lives at company-context/design/logo-*.{png,jpg,webp}; the
# bucket and that prefix are private, so it is served as a short-lived presigned
# GET minted on every read. A new upload is recorded as PENDING and replaces the
# current logo only once the object exists, so an abandoned or failed upload
# never blanks the logo everyone sees.
LOGO_URL_TTL_SECONDS = 3600
LOGO_KEY_ATTR = 'logo_s3_key'
LOGO_PENDING_KEY_ATTR = 'logo_pending_s3_key'
# Every logo object key starts with this (company_context.new_id('logo') → logo_…).
LOGO_KEY_PREFIX = design_references.UPLOAD_PREFIX + 'logo_'


def _design_system_key() -> dict:
    return {'pk': company_context.DESIGN_SYSTEM_PK, 'sk': company_context.CONFIG_SK}


def _logo_key_or_none(value: object) -> str | None:
    if isinstance(value, str) and value.startswith(LOGO_KEY_PREFIX):
        return value
    return None


def _uploaded(key: str) -> bool:
    try:
        get_s3_client().head_object(Bucket=RAW_DATA_BUCKET, Key=key)
    except ClientError:
        return False
    return True


def _current_logo_key(table) -> str | None:
    """The logo object to show, promoting a pending upload that has landed."""
    if not RAW_DATA_BUCKET:
        return None
    item = table.get_item(Key=_design_system_key()).get('Item') or {}
    current = _logo_key_or_none(item.get(LOGO_KEY_ATTR))
    pending = _logo_key_or_none(item.get(LOGO_PENDING_KEY_ATTR))
    if pending and _uploaded(pending):
        try:
            table.update_item(
                Key=_design_system_key(),
                UpdateExpression='SET #k = :p REMOVE #pk',
                ConditionExpression='#pk = :p',
                ExpressionAttributeNames={'#k': LOGO_KEY_ATTR, '#pk': LOGO_PENDING_KEY_ATTR},
                ExpressionAttributeValues={':p': pending},
            )
        except ClientError as e:
            if _error_code(e) != 'ConditionalCheckFailedException':
                raise
        return pending
    return current


def _signed_logo_url(key: str) -> str:
    return get_s3_client().generate_presigned_url(
        ClientMethod='get_object', Params={'Bucket': RAW_DATA_BUCKET, 'Key': key},
        ExpiresIn=LOGO_URL_TTL_SECONDS,
    )


@app.post("/settings/design-system/logo")
@tracer.capture_method
def create_logo_upload_route():
    """Start a logo upload (admin): ``{content_type, size_bytes}`` → 201 ``{upload}``.

    PNG, JPEG or WebP up to 5 MB (no SVG — it can carry script). The presigned
    PUT is signed with the declared type and size, so S3 enforces both.
    """
    require_admin(app.current_event.raw_event)
    if not RAW_DATA_BUCKET:
        raise ConfigurationError('Raw data bucket not configured')
    body = json_object_body(app)
    try:
        ext, size_bytes = design_references.upload_spec('logo', body.get('content_type'), body.get('size_bytes'))
    except ValueError as e:
        raise ValidationError(str(e)) from e
    target = {'s3_key': design_references.upload_key(company_context.new_id('logo'), ext),
              'content_type': body['content_type']}
    _configured_table().update_item(
        Key=_design_system_key(),
        UpdateExpression='SET #pk = :key, updated_at = :now',
        ExpressionAttributeNames={'#pk': LOGO_PENDING_KEY_ATTR},
        ExpressionAttributeValues={':key': target['s3_key'], ':now': _now_iso()},
    )
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'upload': _upload_target(target, size_bytes)}))


@app.get("/settings/design-system")
@tracer.capture_method
def get_design_system_route():
    """Tokens, guidelines, references and integration status — every signed-in user.

    ``?include_archived=true`` adds archived references (admins only; others
    get the default view).
    """
    event = app.current_event.raw_event
    params = app.current_event.query_string_parameters or {}
    include_archived = params.get('include_archived') == 'true' and 'admins' in get_caller_groups(event)
    return _design_view(_configured_table(), include_archived=include_archived)


@app.put("/settings/design-system")
@tracer.capture_method
def put_design_system_route():
    """Replace tokens, guidelines and logo URL (admin). References are separate rows."""
    event = app.current_event.raw_event
    require_admin(event)
    table = _configured_table()
    clean = company_context.validate_design_system(json_object_body(app))
    # The uploaded logo is not part of the PUT body: carry it over, so saving
    # tokens never drops the company logo.
    existing = table.get_item(Key=_design_system_key()).get('Item') or {}
    kept = {attr: existing[attr] for attr in (LOGO_KEY_ATTR, LOGO_PENDING_KEY_ATTR)
            if _logo_key_or_none(existing.get(attr))}
    table.put_item(Item={
        'pk': company_context.DESIGN_SYSTEM_PK, 'sk': company_context.CONFIG_SK,
        **clean, **kept, 'updated_at': _now_iso(), 'updated_by_username': _caller_username(event),
    })
    return _design_view(table)


def _reference_key(ref_id: str) -> dict:
    return {'pk': company_context.DESIGN_SYSTEM_PK, 'sk': f'{company_context.REFERENCE_SK_PREFIX}{ref_id}'}


def _reference_or_404(table, ref_id: str) -> dict:
    item = company_context.get_reference(table, ref_id)
    if not item:
        raise NotFoundError('Design reference not found')
    return item


def _start_reference_refresh(table, ref_id: str) -> None:
    """Hand the fetch + summary to an async self-invocation (it can outlast 29 s).

    A failure to START is recorded on the reference — never a 500.
    """
    function_name = os.environ.get('AWS_LAMBDA_FUNCTION_NAME', '')
    if not function_name:
        _record_refresh_start_failure(table, ref_id, RuntimeError.__name__)
        return
    try:
        invoke_lambda_async(function_name, {'action': DESIGN_REFRESH_ACTION, 'ref_id': ref_id})
    except Exception as e:  # noqa: BLE001 - recorded on the reference instead of failing the request
        _record_refresh_start_failure(table, ref_id, type(e).__name__)


def _record_refresh_start_failure(table, ref_id: str, error_type: str) -> None:
    """Log the failure TYPE only (a message would never be read) and record it on the reference."""
    logger.warning(f'Could not start design reference refresh: {error_type}')
    design_references.record_outcome(
        table, ref_id, {'status': 'error', 'error': 'Could not start the refresh; try again'}, _now_iso())


def _upload_target(item: dict, size_bytes: int) -> dict:
    url = get_s3_client().generate_presigned_url(
        ClientMethod='put_object',
        Params={
            'Bucket': RAW_DATA_BUCKET, 'Key': item['s3_key'],
            'ContentType': item['content_type'],
            # Signed so S3 enforces the declared (validated) size.
            'ContentLength': size_bytes,
        },
        ExpiresIn=UPLOAD_URL_TTL_SECONDS,
    )
    return {'url': url, 'method': 'PUT', 'headers': {'Content-Type': item['content_type']},
            'expires_in': UPLOAD_URL_TTL_SECONDS}


def _attach_upload(item: dict, body: dict) -> int:
    """Validate a declared upload, put its object key and type on the reference row,
    and return the declared size (the presigned PUT is signed with it)."""
    if not RAW_DATA_BUCKET:
        raise ConfigurationError('Raw data bucket not configured')
    try:
        ext, size_bytes = design_references.upload_spec(
            item['kind'], body.get('content_type'), body.get('size_bytes'))
    except ValueError as e:
        raise ValidationError(str(e)) from e
    item['s3_key'] = design_references.upload_key(item['id'], ext)
    item['content_type'] = body['content_type']
    return size_bytes


@app.post("/settings/design-system/references")
@tracer.capture_method
def create_design_reference_route():
    """Add a reference (admin). Uploads → 201 ``{reference, upload}`` (presigned PUT;
    call ``…/refresh`` once uploaded). Figma/GitHub → 201 ``{reference}`` with the
    fetch + AI summary started in the background (poll GET /settings/design-system)."""
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    body = json_object_body(app)
    request = company_context.validate_reference_request(body)
    if len(company_context.list_references(table)) >= company_context.MAX_REFERENCES:
        raise ValidationError(f'At most {company_context.MAX_REFERENCES} active references; archive one first')
    ref_id = company_context.new_id('ref')
    now = _now_iso()
    item = {**_reference_key(ref_id), 'id': ref_id, **request, 'status': 'pending',
            'created_at': now, 'updated_at': now}
    upload_bytes = _attach_upload(item, body) if request['kind'] in company_context.UPLOAD_KINDS else None
    table.put_item(Item=item)
    result: dict = {}
    if upload_bytes is None:
        _start_reference_refresh(table, ref_id)
    else:
        result['upload'] = _upload_target(item, upload_bytes)
    result['reference'] = company_context.reference_view(_reference_or_404(table, ref_id))
    return Response(status_code=201, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps(result, default=str))


@app.post("/settings/design-system/references/<ref_id>/refresh")
@tracer.capture_method
def refresh_design_reference_route(ref_id: str):
    """Re-fetch + re-summarise a reference in the background (admin) → 202 ``{reference}``."""
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    item = _reference_or_404(table, ref_id)
    if item.get('status') == 'archived':
        raise ConflictError('Restore is not supported; add the reference again')
    table.update_item(
        Key=_reference_key(ref_id),
        UpdateExpression='SET #st = :pending, #u = :u REMOVE #e',
        ExpressionAttributeNames={'#st': 'status', '#u': 'updated_at', '#e': 'error'},
        ExpressionAttributeValues={':pending': 'pending', ':u': _now_iso()},
    )
    _start_reference_refresh(table, ref_id)
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(
        {'reference': company_context.reference_view(_reference_or_404(table, ref_id))}, default=str))


@app.delete("/settings/design-system/references/<ref_id>")
@tracer.capture_method
def archive_design_reference_route(ref_id: str):
    """Archive a reference (admin). The row and any uploaded object are kept (keep-all)."""
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    _reference_or_404(table, ref_id)
    table.update_item(
        Key=_reference_key(ref_id),
        UpdateExpression='SET #st = :archived, #u = :u',
        ExpressionAttributeNames={'#st': 'status', '#u': 'updated_at'},
        ExpressionAttributeValues={':archived': 'archived', ':u': _now_iso()},
    )
    return {'reference': company_context.reference_view(_reference_or_404(table, ref_id))}


def _process_reference_event(event: dict) -> dict:
    """Async worker branch: fetch + summarise one reference, record the outcome."""
    table = _configured_table()
    ref_id = event.get('ref_id')
    item = company_context.get_reference(table, ref_id) if isinstance(ref_id, str) else None
    if not item or item.get('status') == 'archived':
        logger.info('Design reference refresh skipped (missing or archived)')
        return {'status': 'skipped'}
    deps = design_references.ProcessDeps(
        s3=get_s3_client(), bucket=RAW_DATA_BUCKET, secrets=_read_integration_secret(),
        summarise=design_references.summarise_text, summarise_image=design_references.summarise_image,
    )
    outcome = design_references.process_reference(table, item, deps)
    logger.info('Design reference processed', extra={'kind': item.get('kind'), 'status': outcome['status']})
    return {'status': outcome['status']}


# ============================================
# Dimensions, source profiles and erasure jobs (docs/dimensions.md, docs/source-policies.md)
# ============================================

def _is_full_admin(event: dict) -> bool:
    caller = caller_from_event(event)
    return caller.is_admin and not caller.delegated


def _settings_row(key: dict) -> dict:
    return _configured_table().get_item(Key=key, ConsistentRead=True).get('Item') or {}


def _put_settings_row(key: dict, field: str, value: list, event: dict) -> None:
    _configured_table().put_item(Item={
        **key, field: value, 'updated_at': _now_iso(), 'updated_by': _caller_label(event),
    })


def _validated_list(body_field: str, validate) -> list:
    """``validate(body[body_field])`` for an admin PUT; 400 with the validator's message."""
    body = json_object_body(app)
    try:
        return validate(body.get(body_field))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _stored_dimensions_or_500() -> list[dict]:
    """The dimensions config on a write path: a corrupt stored row is a 500, never "no dimensions"."""
    try:
        return load_dimensions_config(_configured_table())
    except ValueError as exc:
        logger.warning('Stored dimensions config is invalid')
        raise ServiceError('The stored dimensions configuration is invalid; save it again first') from exc


@app.get("/settings/dimensions")
@tracer.capture_method
def get_dimensions_route():
    """The configured dimensions — any signed-in user (filters and chips need them)."""
    item = _settings_row(DIMENSIONS_SETTINGS_KEY)
    try:
        dimensions = validate_dimensions(item.get('dimensions'))
    except ValueError:
        logger.warning('Stored dimensions config is invalid; answering with none')
        dimensions = []
    return {'dimensions': dimensions, 'updated_at': item.get('updated_at')}


@app.put("/settings/dimensions")
@tracer.capture_method
def put_dimensions_route():
    """Replace the dimensions (admin). Body ``{dimensions}``, validated by ``shared.dimension_config``."""
    event = app.current_event.raw_event
    require_admin(event)
    dimensions = _validated_list('dimensions', validate_dimensions)
    _put_settings_row(DIMENSIONS_SETTINGS_KEY, 'dimensions', dimensions, event)
    logger.info('Dimensions saved', extra={'dimensions': len(dimensions)})
    return {'success': True, 'dimensions': dimensions}


@app.get("/settings/sources")
@tracer.capture_method
def get_sources_route():
    """Source profiles: in full for an admin, ``{id, label, restricted}`` for everyone else."""
    try:
        profiles = load_source_profiles(_configured_table())
    except ValueError:
        logger.warning('Stored source profiles are invalid; answering with none')
        profiles = []
    if _is_full_admin(app.current_event.raw_event):
        return {'sources': profiles}
    return {'sources': [{key: p[key] for key in ('id', 'label', 'restricted')} for p in profiles]}


@app.put("/settings/sources")
@tracer.capture_method
def put_sources_route():
    """Replace the source profiles (admin). ``dimension_defaults`` must name configured dimensions/values."""
    event = app.current_event.raw_event
    require_admin(event)
    dimensions = _stored_dimensions_or_500()
    sources = _validated_list('sources', lambda value: validate_source_profiles(value, dimensions))
    _put_settings_row(SOURCES_SETTINGS_KEY, 'sources', sources, event)
    clear_source_profiles_cache()
    logger.info('Source profiles saved', extra={'sources': len(sources)})
    return {'success': True, 'sources': sources}


ERASURE_JOB_PK = 'JOB#erasure'
ERASURE_JOB_PREFIX = 'er_'
ERASURE_FIELDS = ('author', 'source_id', 'csv_row_id', 'email')
MAX_ERASURE_VALUE_CHARS = 1_000
MAX_LISTED_ERASURE_JOBS = 20
ERASURE_VIEW_FIELDS = (
    'job_id', 'status', 'field', 'source', 'value_hash', 'deleted_items', 'deleted_objects',
    'started_by', 'created_at', 'finished_at', 'error',
)


SOURCE_SCOPED_ERASURE_FIELDS: Final = frozenset({'source_id', 'csv_row_id'})


def _erasure_request(body: dict) -> tuple[str, str, str | None]:
    """``(field, value, source)`` from a POST body, or 400. The value is never echoed."""
    field = body.get('field')
    if field not in ERASURE_FIELDS:
        raise ValidationError(f"field must be one of: {', '.join(ERASURE_FIELDS)}")
    value = body.get('value')
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_ERASURE_VALUE_CHARS:
        raise ValidationError(f'value must be a non-empty string of at most {MAX_ERASURE_VALUE_CHARS} characters')
    source = body.get('source')
    if source is not None and (not isinstance(source, str) or not SOURCE_ID_RE.match(source)):
        raise ValidationError('source must be a source id')
    # An item id or CSV row id is only unique WITHIN a source: erasing it across
    # every source could delete another source's unrelated item.
    if field in SOURCE_SCOPED_ERASURE_FIELDS and not source:
        raise ValidationError(f'source is required when field is {field}')
    return field, value.strip(), source


def erasure_job_view(item: dict) -> dict:
    """The API's erasure ``Job`` (no keys; the erased value is never stored, only its hash)."""
    view = {field: item.get(field) for field in ERASURE_VIEW_FIELDS if item.get(field) is not None}
    for counter in ('deleted_items', 'deleted_objects'):
        view[counter] = int(item.get(counter) or 0)
    return view


def _new_erasure_job(field: str, value: str, source: str | None, event: dict) -> dict:
    now = datetime.now(UTC)
    job_id = f'{ERASURE_JOB_PREFIX}{int(now.timestamp() * 1000):012x}'
    item = {
        'pk': ERASURE_JOB_PK, 'sk': job_id, 'job_id': job_id, 'status': 'queued', 'field': field,
        'value_hash': hashlib.sha256(value.encode('utf-8')).hexdigest(), 'deleted_items': 0,
        'deleted_objects': 0, 'started_by': _caller_label(event), 'created_at': now.isoformat(),
    }
    if source:
        item['source'] = source
    try:
        _configured_table().put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
    except ClientError as exc:
        if _error_code(exc) == 'ConditionalCheckFailedException':
            raise ConflictError('An erasure job was started at the same moment; retry') from exc
        raise
    return item


@app.post("/settings/erasure")
@tracer.capture_method
def start_erasure_route():
    """Erase every item matching ``field == value`` (admin): 202 ``{job}``.

    The retention worker (``RETENTION_FUNCTION``) does the deleting; the value
    travels in its async event only — the job row keeps a SHA-256 of it, and
    nothing here logs it.
    """
    event = app.current_event.raw_event
    require_admin(event)
    if not RETENTION_FUNCTION:
        raise ConfigurationError('Retention worker not configured')
    field, value, source = _erasure_request(json_object_body(app))
    job = _new_erasure_job(field, value, source, event)
    try:
        invoke_lambda_async(RETENTION_FUNCTION, {'mode': 'erase', 'job_id': job['job_id'], 'value': value})
    except Exception as e:
        logger.warning('Failed to start the erasure worker', extra={'error_type': type(e).__name__})
        _configured_table().update_item(
            Key={'pk': ERASURE_JOB_PK, 'sk': job['job_id']},
            UpdateExpression='SET #s = :failed, finished_at = :now, #e = :error',
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':failed': 'failed', ':now': _now_iso(),
                                       ':error': 'Could not start the erasure worker'},
        )
        raise ServiceError('Failed to start the erasure job') from e
    logger.info('Erasure job started', extra={'job_id': job['job_id'], 'field': field})
    return Response(
        status_code=202,
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({'job': erasure_job_view(job)}),
    )


@app.get("/settings/erasure")
@tracer.capture_method
def list_erasure_route():
    """The newest erasure jobs (admin), at most 20."""
    require_admin(app.current_event.raw_event)
    response = _configured_table().query(
        KeyConditionExpression=Key('pk').eq(ERASURE_JOB_PK) & Key('sk').begins_with(ERASURE_JOB_PREFIX),
        ScanIndexForward=False,
        Limit=MAX_LISTED_ERASURE_JOBS,
    )
    return {'jobs': [erasure_job_view(item) for item in response.get('Items', [])]}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    if event.get('action') == DESIGN_REFRESH_ACTION and 'httpMethod' not in event:
        return _process_reference_event(event)
    return app.resolve(event, context)
