"""
Settings API Lambda - Handles /settings/*
Manages brand configuration and categories.
"""

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Category reprocess routes (see the section at the end of this module).
from aws_lambda_powertools.event_handler import Response, content_types

from shared import (
    appearance_routes,
    assist_jobs,
    briefing_prefs,
    briefing_requests,
    briefing_store,
    briefing_subscription,
    category_access,
    company_context,
    design_assets,
    design_icons,
    design_logo,
    design_references,
    extracted_design,
    image_model_quota,
    image_model_status,
    model_agreements,
    model_capacity,
    onboarding,
    reference_urls,
    reprocess_jobs,
    reprocess_slices,
)
from shared import email_intake_settings as inbox
from shared.api import (
    ALL_TIME_DAYS,
    MAX_FEEDBACK_WINDOW_DAYS,
    api_handler,
    create_api_resolver,
    get_caller_subject,
    is_admin,
    require_admin,
    validate_bool,
)
from shared.aws import (
    get_dynamodb_resource,
    get_s3_client,
    get_secrets_client,
    invoke_lambda_async,
    is_action_event,
    put_secret_json,
)
from shared.caller_claims import first_claim
from shared.categories_key import CATEGORIES_SETTINGS_KEY
from shared.category_access import CategoryScope
from shared.category_config import validate_categories
from shared.category_gate import CATEGORIES_KIND, scope_for_caller
from shared.data_version import bump_config_version
from shared.delete_audit import actor_from_event, record_delete
from shared.design_references import DESIGN_CAPTURE_ACTION
from shared.digests import sha256_hex
from shared.dimension_config import (
    DIMENSIONS_KIND,
    DIMENSIONS_SETTINGS_KEY,
    load_dimensions_config,
    validate_dimensions,
    with_builtin_dimensions,
)
from shared.engagement_config import BRAND_KEY
from shared.erasure_scope import (
    fail_unstarted_job,
    job_event,
    listed_jobs,
    no_platform_admin_entry,
    put_job_row,
    refuse_field_in_workspace,
    require_erasure_admin,
    scoped_job_row,
)
from shared.exceptions import (
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ServiceUnavailableError,
    ValidationError,
)
from shared.legal_basis import required_legal_basis
from shared.logging import logger, tracer
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    ALLOWED_MODELS,
    MODEL_DEFAULT_KEY,
    MODEL_SETTINGS_PK,
    MODEL_SETTINGS_SK,
    PICKER_SURFACES,
    SURFACE_DEFAULTS,
    clear_model_cache,
)
from shared.model_profile import payload_fields
from shared.project_gate import caller_from_event
from shared.request_body import json_body_value, json_object_body, reject_unknown_fields
from shared.request_workspace import request_workspace, require_settings_admin, require_workspace_writer
from shared.retention import (
    ERASE_FIELDS,
    ERASURE_JOB_COUNTERS,
    ERASURE_JOB_PK,
    ERASURE_JOB_PREFIX,
    ERASURE_OPTIONAL_COUNTERS,
    SOURCE_FIELD,
)
from shared.scope_names import (
    HiddenNames,
    component_names_hidden,
    hidden_names_for,
    scoped_company_context,
    scoped_design_system,
)
from shared.source_erasure import (
    SourceLocked,
    acquire_source_lock,
    blocking_job,
    known_sources,
    release_source_lock,
)
from shared.source_profiles import (
    SOURCE_ID_RE,
    SOURCES_KIND,
    SOURCES_SETTINGS_KEY,
    clear_source_profiles_cache,
    load_source_profiles,
    profile_for,
    validate_source_profiles,
    workspace_profiles_problem,
)
from shared.timestamps import now_iso, parse_iso
from shared.url_policy import validate_url
from shared.workspace import WorkspaceContext, is_workspace_admin
from shared.workspace_config import get_config_item, put_config_item
from shared.workspace_request import RequestWorkspace
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope, scope_of

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
CATEGORY_REPROCESS_FUNCTION = os.environ.get("CATEGORY_REPROCESS_FUNCTION", "")
# The retention / erasure worker (`voc-retention`), started by POST /settings/erasure.
RETENTION_FUNCTION = os.environ.get("RETENTION_FUNCTION", "")

# The brand is a workspace's (decision 6): its row is under the workspace the request names; a request that names
# none keeps the deployment's row, as before (shared/request_workspace.py), the one engagement_config reads.
BRAND_KIND = "brand"
FAILED_BRAND_READ = 'Failed to retrieve brand settings'
FAILED_BRAND_SAVE = 'Failed to save brand settings'
# The resolved problems are a workspace's (docs/multi-workspace.md, "Per-workspace configuration"): their row is
# under the workspace the request names (shared/request_workspace.py), keyed by shared/workspace_settings.py. A request
# that names none keeps the deployment's row, as before.
RESOLVED_PROBLEMS_KIND = "resolved_problems"
DEPLOYMENT_RESOLVED_PROBLEMS_KEY: Final = {'pk': "SETTINGS#resolved_problems", 'sk': "config"}
FAILED_RESOLVED_READ = "Failed to retrieve resolved problems"
FAILED_RESOLVED_WRITE = "Failed to update problem resolution"
# The categories, the dimensions and the source profiles are a workspace's (docs/multi-workspace.md, since 7.08.00):
# with `X-Workspace-Id` the six routes read and write `WS#{ws}#SETTINGS#{kind}` (shared/workspace_config.py), any
# member reads and the workspace's admins write (`require_settings_admin`); without it, the deployment's rows and its
# `admins`, as before. A workspace that saved none of a kind has none (the deployment's row is never its default).
FAILED_CATEGORIES_READ = 'Failed to retrieve categories'
FAILED_CATEGORIES_SAVE = 'Failed to save categories'
FAILED_DIMENSIONS_READ = 'Failed to retrieve dimensions'
FAILED_DIMENSIONS_SAVE = 'Failed to save dimensions'
FAILED_SOURCES_READ = 'Failed to retrieve source profiles'
FAILED_SOURCES_SAVE = 'Failed to save source profiles'

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
RESOLVED_PROBLEMS_TTL_DAYS = 180
# REMOVE-expression chunk size when pruning (bounded so the update
# expression stays far below DynamoDB's 4KB expression limit).
_PRUNE_CHUNK_SIZE = 20

app = create_api_resolver()
# The deployment's start theme (shared/appearance_routes.py); reads the table at call time.
appearance_routes.bind_aggregates_table(lambda: aggregates_table)
app.include_router(appearance_routes.app)


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
            # The deployment's default, pinned at deploy (SETTINGS#model_default): what a surface on Automatic uses
            # when no global pick is set (shared/model_config.py).
            'deployment_default': _deployment_default_model(),
            # The persona-avatar image model: fixed, not a picker choice (shared/image_model_status.py).
            'image_model': image_model_status.image_model_info(),
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
        bump_config_version(aggregates_table)
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
    The persona-avatar image model is accepted too: ONE minimal image call, nothing
    stored (shared/image_model_status.py).
    """
    require_admin(app.current_event.raw_event)
    body = json_object_body(app)
    model_id = body.get('model_id')
    image_model_id = image_model_status.image_model_info()['id']
    if model_id == image_model_id:
        return image_model_status.probe_image_model()
    if not isinstance(model_id, str) or model_id not in ALLOWED_MODEL_IDS:
        allowed = ', '.join([*sorted(ALLOWED_MODEL_IDS), image_model_id])
        raise ValidationError(f"model_id must be one of: {allowed}")
    return model_capacity.probe_model(model_id)


@app.get("/settings/model/capacity")
@tracer.capture_method
def get_model_capacity():
    """Every allowlisted model with its tokens-per-minute quota and agreement access
    (shared/model_agreements.py), plus the image model's access and requests-per-minute quota
    (no model call). Admin-only."""
    require_admin(app.current_event.raw_event)
    models = model_agreements.with_access(model_capacity.capacity_overview())
    return {'models': models, 'image': image_model_status.image_capacity()}


def _deployment_default_model() -> str | None:
    """The deployment's default model id (custom_resources/model_pin.py), or None when unset or not allowlisted."""
    try:
        item = _configured_table().get_item(Key=MODEL_DEFAULT_KEY).get('Item') or {}
    except (ClientError, BotoCoreError):
        # The picks still answer; the page labels Automatic without the default until the next read.
        logger.exception("Failed to read the deployment's default model")
        return None
    model_id = item.get('model_id')
    return model_id if isinstance(model_id, str) and model_id in ALLOWED_MODEL_IDS else None


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
    item['updated_at'] = now_iso()
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
    by the workspace's members by design (issue #66) — resolving a problem
    clears it from their working view; another workspace has its own (a
    request that names no workspace: the deployment's, as before). Entries older than
    RESOLVED_PROBLEMS_TTL_DAYS are filtered out (issue #159): the problem
    resurfaces for re-review, and the stored entry is reclaimed the next
    time the entry cap is under pressure.
    """
    context = request_workspace(app.current_event.raw_event, FAILED_RESOLVED_READ)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(Key=_resolved_key(context))
        resolved = _without_expired(response.get('Item', {}).get('resolved', {}))
    except Exception as e:
        logger.exception("Failed to get resolved problems")
        raise ServiceError(FAILED_RESOLVED_READ) from e
    return {'resolved': _resolved_in_scope(resolved, _config_scope(context))}


def _resolved_key(context: WorkspaceContext | None) -> dict[str, str]:
    """The workspace's resolved-problems row; the deployment's when the request names no workspace."""
    if context is None:
        return dict(DEPLOYMENT_RESOLVED_PROBLEMS_KEY)
    return settings_key(context.ws, RESOLVED_PROBLEMS_KIND)


def _resolved_in_scope(resolved: dict, workspace: WorkspaceScope | None = None) -> dict:
    """Only the problems whose category the caller may see: a key is ``category:subcategory:problem``,
    so a hidden category's key would name it (owner rule 2026-10-21). Judged against the categories of the
    request's workspace (``workspace``; the deployment's without one), whose problems these are."""
    caller = caller_from_event(app.current_event.raw_event)
    if caller.is_admin and not caller.delegated:
        return resolved
    scope = scope_for_caller(caller, aggregates_table, workspace)
    if scope.categories_all:
        return resolved
    return {key: entry for key, entry in resolved.items()
            if category_access.admits(scope, str(key).split(':', 1)[0])}


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
    # A write: the caller's role from the table, not the warm cache (a member removed a moment ago cannot write).
    context = request_workspace(app.current_event.raw_event, FAILED_RESOLVED_WRITE, fresh=True)
    if context is not None:
        # A viewer reads the workspace; marking a problem resolved is an editor's or an admin's (without a workspace,
        # every signed-in user, as before).
        require_workspace_writer(context)
    row = _resolved_key(context)

    try:
        if resolved:
            _resolve_problem_key(row, key)
        else:
            _unresolve_problem_key(row, key)
    except ValidationError:
        raise
    except Exception as e:
        logger.exception("Failed to update problem resolution")
        raise ServiceError(FAILED_RESOLVED_WRITE) from e
    else:
        return {'success': True, 'key': key, 'resolved': resolved}


def _error_code(error: ClientError) -> str | None:
    """The service error code of a boto failure (None when the response carries none)."""
    return error.response.get('Error', {}).get('Code')


def _set_resolved_entry(row: dict[str, str], key: str) -> None:
    """Single conditional write: overwrite is always allowed; NEW entries
    only while the map is under the cap. Atomic — two concurrent resolves
    at the cap can't both slip through (review feedback on #153)."""
    _configured_table().update_item(
        Key=row,
        UpdateExpression='SET #r.#k = :entry',
        ConditionExpression='attribute_exists(#r.#k) OR size(#r) < :max',
        ExpressionAttributeNames={'#r': 'resolved', '#k': key},
        ExpressionAttributeValues={
            ':entry': {'resolved_at': now_iso()},
            ':max': MAX_RESOLVED_ENTRIES,
        },
    )


def _ensure_resolved_map(row: dict[str, str]) -> None:
    _configured_table().update_item(
        Key=row,
        UpdateExpression='SET #r = if_not_exists(#r, :empty)',
        ExpressionAttributeNames={'#r': 'resolved'},
        ExpressionAttributeValues={':empty': {}},
    )


@tracer.capture_method
def _prune_expired_entries(row: dict[str, str]) -> int:
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
        Key=row
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
            Key=row,
            UpdateExpression='REMOVE ' + ', '.join(f'#r.{alias}' for alias in names),
            ExpressionAttributeNames={'#r': 'resolved', **names},
        )
    if stale:
        logger.info(
            "Pruned expired resolved-problem entries under cap pressure",
            extra={"count": len(stale)},
        )
    return len(stale)


def _attempt_resolve(row: dict[str, str], key: str, tolerated_codes: tuple[str, ...]) -> ClientError | None:
    """One conditional resolve write: None on success, the error when its code
    is one of ``tolerated_codes``; any other failure propagates."""
    try:
        _set_resolved_entry(row, key)
    except ClientError as e:
        if _error_code(e) not in tolerated_codes:
            raise
        return e
    return None


def _resolve_problem_key(row: dict[str, str], key: str) -> None:
    """Conditionally set the entry, materializing the parent map on first use.

    DynamoDB reports a missing parent map either as a document-path
    ValidationException or as a failed condition (functions on missing
    attributes evaluate false), depending on evaluation order — so both
    first-attempt failures fall through to ensure-parent + one retry, and
    only a retry failure means the cap was genuinely reached. At that point
    expired entries are pruned (issue #159) and the write retried once more;
    the cap error only surfaces when the map is full of LIVE entries.
    """
    if _attempt_resolve(row, key, ('ConditionalCheckFailedException', 'ValidationException')) is None:
        return
    _ensure_resolved_map(row)
    cap_error = _attempt_resolve(row, key, ('ConditionalCheckFailedException',))
    if cap_error is None:
        return
    # Cap reached: reclaim slots held by expired (often orphaned) entries.
    if _prune_expired_entries(row) > 0:
        cap_error = _attempt_resolve(row, key, ('ConditionalCheckFailedException',))
        if cap_error is None:
            return
    raise ValidationError(
        f'Resolved-problem limit reached ({MAX_RESOLVED_ENTRIES}). '
        'Unresolve entries you no longer need first.'
    ) from cap_error


def _unresolve_problem_key(row: dict[str, str], key: str) -> None:
    """REMOVE the entry; a missing parent map just means nothing to remove.

    The no-op is detected by a ConditionExpression on the parent map —
    ConditionalCheckFailedException is a stable error CODE, unlike the
    document-path ValidationException message text, which is not
    contractual across SDK/service versions.
    """
    try:
        _configured_table().update_item(
            Key=row,
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
    """The brand of the workspace the request names (any member), or the deployment's when it names none."""
    context = request_workspace(app.current_event.raw_event, FAILED_BRAND_READ)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    try:
        response = aggregates_table.get_item(Key=_brand_key(context))
        item = response.get('Item')
        if not item:
            return {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []}
        result = {'brand_name': item.get('brand_name', ''), 'brand_handles': item.get('brand_handles', []),
                  'hashtags': item.get('hashtags', []), 'urls_to_track': item.get('urls_to_track', [])}
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        raise ServiceError(FAILED_BRAND_READ) from e
    else:
        return result


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save the brand (an admin's).

    The brand name, handles, hashtags and tracked URLs are the configuration
    every AI surface of the workspace reads, so only its admins may change
    them (#242; with no workspace, the deployment's admins, as before). The
    gate runs before the body is parsed or anything is written. GET
    /settings/brand stays open to every member.
    """
    event = app.current_event.raw_event
    # A write: the caller's role from the table, not the warm cache.
    context = request_workspace(event, FAILED_BRAND_SAVE, fresh=True)
    require_settings_admin(event, context)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')
    body = json_object_body(app)
    try:
        item = {**_brand_key(context), 'brand_name': body.get('brand_name', ''),
                'brand_handles': body.get('brand_handles', []), 'hashtags': body.get('hashtags', []),
                'urls_to_track': body.get('urls_to_track', []), 'updated_at': now_iso()}
        aggregates_table.put_item(Item=item)
        bump_config_version(aggregates_table)
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        raise ServiceError(FAILED_BRAND_SAVE) from e
    else:
        return {'success': True, 'message': 'Brand settings saved', 'settings': {k: item[k] for k in ['brand_name', 'brand_handles', 'hashtags', 'urls_to_track']}}


def _brand_key(context: WorkspaceContext | None) -> dict[str, str]:
    """The workspace's brand row; the deployment's when the request names no workspace."""
    if context is None:
        return dict(BRAND_KEY)
    return settings_key(context.ws, BRAND_KIND)


def _config_scope(context: WorkspaceContext | None) -> WorkspaceScope | None:
    """The workspace whose categories, dimensions and source profiles the request reads or writes (shared/
    workspace_config.py); None for a request that names none (the deployment's rows, as before)."""
    return None if context is None else scope_of(context)


def _sees_full_config(event: dict, context: WorkspaceContext | None) -> bool:
    """Whether the caller gets a configuration in full (category owners' subs and emails, every profile field): its
    editors. Without a workspace the deployment's ``admins`` (not delegated), as before; inside one the workspace's
    admins (``require_settings_admin``'s rule; the deployment's group grants nothing there), not delegated."""
    caller = caller_from_event(event)
    if context is None:
        return caller.is_admin and not caller.delegated
    return is_workspace_admin(context) and not caller.delegated


@app.get("/settings/categories")
@tracer.capture_method
def get_categories_config():
    """Get the categories configuration: the workspace's own with ``X-Workspace-Id`` (any member; a workspace that
    saved none has none), the deployment's without it.

    Its editors get the stored config verbatim (they edit it: the deployment's
    admins, or the workspace's). Everyone else gets only the categories in their
    category-access scope, with each owner reduced to ``{username}`` — owner subs
    and emails are admin-only data.
    """
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_CATEGORIES_READ)
    if not aggregates_table:
        return {'categories': [], 'error': 'Aggregates table not configured'}
    scope = _config_scope(context)
    caller = caller_from_event(event)
    try:
        item = get_config_item(aggregates_table, CATEGORIES_KIND, CATEGORIES_SETTINGS_KEY, scope, consistent=False)
    except Exception as e:
        logger.exception(f"Failed to get categories config: {e}")
        return {'categories': [], 'error': FAILED_CATEGORIES_READ}
    if not item:
        return {'categories': [], 'updated_at': None}
    categories = item.get('categories', [])
    if not _sees_full_config(event, context):
        access = scope_for_caller(caller, aggregates_table, scope)
        categories = _redacted_categories(categories, access)
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
    """Save the categories configuration (an admin's): the workspace's own with ``X-Workspace-Id`` (its admins,
    ``require_settings_admin``), the deployment's without it (the deployment's ``admins``, as before).

    Categories decide how every review is classified, map to the product they
    belong to and its product owners, and drive per-user category access
    (owners see their categories), so only admins may change them. The body is
    validated and normalised by `shared.category_config.validate_categories`.
    """
    event = app.current_event.raw_event
    # A write: the caller's role from the table, not the warm cache.
    context = request_workspace(event, FAILED_CATEGORIES_SAVE, fresh=True)
    require_settings_admin(event, context)
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
        _put_config_row(CATEGORIES_KIND, CATEGORIES_SETTINGS_KEY, _config_scope(context), 'categories', categories,
                        event)
    except Exception as e:
        logger.exception(f"Failed to save categories config: {e}")
        raise ServiceError(FAILED_CATEGORIES_SAVE) from e
    else:
        return {'success': True, 'message': f'Saved {len(categories)} categories'}


@app.post("/settings/categories/generate")
@tracer.capture_method
def generate_categories():
    """Start generating category suggestions from a company description (admin only) → 202.

    Each call spends Bedrock, and the suggestions only feed the admin-only
    categories editor, so only admins may run it
    (#242). The gate and the required-field check answer synchronously, before
    any job exists; the model call runs in the settings worker
    (``generate_categories_work``) and the caller polls
    ``GET /settings/jobs/{job_id}`` for the old body.
    """
    require_admin(app.current_event.raw_event)
    body = json_object_body(app)
    company_description = body.get('company_description', '')
    if not company_description:
        raise ValidationError('Company description is required')
    subject = get_caller_subject(app.current_event.raw_event)
    return assist_jobs.accepted(assist_jobs.start_owned(
        subject, CATEGORIES_JOB, {'company_description': company_description}))


@app.get("/settings/jobs/<job_id>")
@tracer.capture_method
def get_settings_assist_job(job_id: str):
    """Poll one of the caller's own settings assists (404 for anyone else's)."""
    return assist_jobs.get(assist_jobs.owner_pk(get_caller_subject(app.current_event.raw_event)), job_id)


# ============================================
# Assist work, run by the settings worker twin (voc-settings-assist; shared/assist_jobs.py).
# Each work function gets the job's `config` (never the request) and returns
# exactly the body its route used to answer synchronously.
# ============================================

CATEGORIES_JOB: Final = 'assist_categories'
CATEGORIES_FAILURE: Final = 'Failed to generate categories'


def _categories_prompt(company_description: object) -> str:
    return f"""Based on the following company/product description, generate a comprehensive list of feedback categories and subcategories.

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


def _categories_from_response(response_text: str) -> object:
    """The ``categories`` of the first JSON object in the model reply (ServiceError when there is none)."""
    json_match = re.search(r"\{[\s\S]*\}", response_text)
    if not json_match:
        raise ServiceError("Could not parse categories from response")
    return json.loads(json_match.group()).get("categories", [])


def generate_categories_work(config: dict) -> dict:
    """Ask the model for categories for ``config['company_description']``; the route's old 200 body."""
    company_description = config.get('company_description')
    if not company_description:
        raise ValidationError('Company description is required')
    try:
        from shared.converse import converse
        # 4096: strict-JSON output must fit ONE call (see the strict-JSON
        # doctrine in shared/converse.py).
        response_text = converse(prompt=_categories_prompt(company_description), max_tokens=4096,
                                 temperature=0.3, surface='utility', step_name='generate_categories')
        categories = _categories_from_response(response_text)
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        raise ServiceError(CATEGORIES_FAILURE) from e
    return {"success": True, "categories": categories}


ASSIST_WORK: Final = {  # job_type → the work the settings worker (ASSIST_WORKER_FUNCTION) runs
    CATEGORIES_JOB: assist_jobs.Work(generate_categories_work, CATEGORIES_FAILURE),
}


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
    return first_claim(event, ('cognito:username', 'username', 'email')) or get_caller_subject(event)


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
    job = _resume_reprocess(table, body, event) if 'resume' in body else _new_reprocess(table, body, event)
    if job is None:
        raise ConflictError('A reprocess job is already queued or running')
    mode, days = job.get('mode'), job.get('days')
    try:
        invoke_lambda_async(CATEGORY_REPROCESS_FUNCTION, {'job_id': job['sk'], **payload_fields()})
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


def _new_reprocess(table: Any, body: dict, event: dict) -> dict | None:
    """A new job for the body's mode and slice (``shared/reprocess_slices.py``); None while one is active."""
    mode = body.get('mode')
    if mode not in reprocess_jobs.MODES:
        raise ValidationError(f"mode must be one of: {', '.join(reprocess_jobs.MODES)}")
    try:
        job_slice = reprocess_slices.parse_slice(body, _reprocess_days)
    except ValueError as e:
        raise ValidationError(str(e)) from e
    include_manual = validate_bool(body.get('include_manual'), False, 'include_manual')
    return reprocess_jobs.start_job(
        table, mode=mode, days=job_slice.days or 0, include_manual=include_manual,
        started_by=_caller_label(event), now=datetime.now(UTC), job_slice=job_slice,
        started_by_sub=get_caller_subject(event),
    )


def _resume_reprocess(table: Any, body: dict, event: dict) -> dict | None:
    """``{resume: <job_id>}``: a new job continuing a partial one at its cursor, with its mode and slice.

    400 for other fields or a malformed id, 404 for an unknown job, 409 unless the job
    is partial and not resumed yet. None while another job is active.
    """
    if set(body) != {'resume'}:
        raise ValidationError('resume takes no other fields: the resumed job keeps its mode and slice')
    job_id = body.get('resume')
    if not reprocess_jobs.is_job_id(job_id):
        raise ValidationError('resume must be a reprocess job id')
    previous = reprocess_jobs.get_job(table, str(job_id))
    if previous is None:
        raise NotFoundError('Reprocess job not found')
    resume = reprocess_jobs.resume_point(previous)
    if resume is None:
        raise ConflictError('Only a partial job that has not been resumed yet can be resumed')
    job_slice = reprocess_slices.slice_from_job(previous).pinned_at(_started_at(previous))
    try:
        return reprocess_jobs.start_job(
            table, mode=str(previous.get('mode')), days=job_slice.days or 0,
            include_manual=previous.get('include_manual') is True, started_by=_caller_label(event),
            now=datetime.now(UTC), job_slice=job_slice,
            started_by_sub=get_caller_subject(event), resume=resume,
        )
    except reprocess_jobs.ResumeRefused as e:
        raise ConflictError('This job was resumed already') from e


def _started_at(job: dict) -> datetime:
    """When ``job`` was created (its ``created_at``); now when that is missing or unreadable."""
    started = parse_iso(job.get('created_at'))
    if started is None:
        # A job row without a readable created_at: the resumed days window counts back from now instead.
        logger.warning('Reprocess job has no readable created_at; its resume window starts today',
                       extra={'job_id': job.get('sk')})
        return datetime.now(UTC)
    return started


@app.get("/settings/categories/reprocess")
@tracer.capture_method
def get_latest_category_reprocess():
    """Latest reprocess job (admin) — ``{job: Job | null}``."""
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    job = reprocess_jobs.get_latest_job(table)
    if not job:
        return {'job': None}
    view = reprocess_jobs.job_view(job)
    # A resumer that was cancelled or failed handed its partial job back: name it, so the SPA can offer Resume.
    handed_back = reprocess_jobs.handed_back_job(table, job)
    if handed_back is not None:
        view['resumable_job_id'] = handed_back
    return {'job': view}


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
# Direct (non-API Gateway) invocation this Lambda sends its worker twin
# (ASSIST_WORKER_FUNCTION) to refresh a design reference off the 29 s request path. An API Gateway event always
# carries `httpMethod`, so it can never take this branch.
DESIGN_REFRESH_ACTION = 'design_reference_refresh'
# Live-website references are read by `voc-design-capture` (VocIngestionStack, lambda/design_capture), which
# runs the AgentCore managed browser; this Lambda only starts it (async invoke by name).
DESIGN_CAPTURE_FUNCTION = os.environ.get('DESIGN_CAPTURE_FUNCTION', '')
UPLOAD_URL_TTL_SECONDS = 600
INTEGRATION_FIELDS = {'figma_token': 'figma', 'github_token': 'github'}
MAX_INTEGRATION_TOKEN_CHARS = 1_000


def _caller_username(event: dict) -> str | None:
    """Display username of the caller (never the sub or the email)."""
    return first_claim(event, ('cognito:username', 'username'))


@app.get("/settings/company-context")
@tracer.capture_method
def get_company_context_route():
    """Company vision + objectives — readable by every signed-in user.

    A reader restricted to some categories gets it without the vision paragraphs and the
    objectives that name a category they cannot see (``shared.scope_names``, owner rule
    2026-10-21); the assistant, MCP and the Company page all read it here.
    """
    table = _configured_table()
    return scoped_company_context(company_context.get_company_context(table), _hidden_category_names(table))


def _hidden_category_names(table: Any) -> HiddenNames | None:
    """The category names the caller may not see (None for admins and unrestricted callers)."""
    caller = caller_from_event(app.current_event.raw_event)
    if caller.is_admin and not caller.delegated:
        return None
    return hidden_names_for(scope_for_caller(caller, table), table)


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
        **clean, 'updated_at': now_iso(), 'updated_by_username': _caller_username(event),
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
        **clean, 'updated_at': now_iso(),
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
    """Set the caller's own buddy state, start page, guide and/or Home dismissals.

    ``{state?, start_page?, guide?, subscribe_prompt?, dismiss_decision_run?}`` (shared/onboarding.py).
    """
    sub = get_caller_subject(app.current_event.raw_event)
    changes = onboarding.validate_preference(json_object_body(app))
    return onboarding.put_onboarding(_configured_table(), sub, changes)


# ── Morning brief (docs/briefing.md): the caller's own preferences, brief and card states ──

@app.get("/settings/my-briefing")
@tracer.capture_method
def get_my_briefing_route():
    """The caller's brief preferences (self only); a pending email confirmation is re-checked."""
    sub = get_caller_subject(app.current_event.raw_event)
    return briefing_subscription.get_preferences(_configured_table(), sub)


@app.put("/settings/my-briefing")
@tracer.capture_method
def put_my_briefing_route():
    """Set the caller's own brief preferences; email goes only to their own verified Cognito address."""
    caller = caller_from_event(app.current_event.raw_event)
    changes = briefing_prefs.validate_changes(json_object_body(app))
    return briefing_subscription.put_preferences(_configured_table(), caller, changes, datetime.now(UTC))


@app.get("/settings/my-briefing/brief")
@tracer.capture_method
def get_my_brief_route():
    """The caller's newest brief (``status: none`` before the first one)."""
    sub = get_caller_subject(app.current_event.raw_event)
    return briefing_requests.get_brief(_configured_table(), sub, datetime.now(UTC))


@app.post("/settings/my-briefing/refresh")
@tracer.capture_method
def refresh_my_brief_route():
    """Rebuild the caller's own brief now (anyone, no cap; ``up_to_date`` when nothing changed).

    Optional body ``{language}``: the reader's UI language, used unless they chose a brief language.
    """
    caller = caller_from_event(app.current_event.raw_event)
    ui_language = briefing_prefs.validate_refresh(json_object_body(app))
    return briefing_requests.refresh(_configured_table(), caller, datetime.now(UTC), ui_language)


@app.put("/settings/my-briefing/cards")
@tracer.capture_method
def put_my_brief_cards_route():
    """Mark cards of the caller's own brief seen / dismissed / acted (``{day, states}``)."""
    sub = get_caller_subject(app.current_event.raw_event)
    day, states = briefing_store.validate_card_states(json_object_body(app))
    return {'day': day, 'card_state': briefing_store.set_card_states(_configured_table(), sub, day, states)}


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
    reject_unknown_fields(body, INTEGRATION_FIELDS)
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
    # Scoped like GET /settings/company-context: a reader restricted to some categories
    # gets it without the guideline paragraphs, tokens and references that name a
    # category they cannot see (``shared.scope_names.scoped_design_system``).
    hidden = _hidden_category_names(table)
    view = scoped_design_system(company_context.get_design_system(table, include_archived=include_archived), hidden)
    if hidden is not None and not hidden.hides_nothing:
        view['references'] = [r for r in view.get('references', []) if not _design_names_hidden(r, hidden)]
    if isinstance(view.get('references'), list):
        view['references'] = [_with_logo_preview(r) for r in view['references']]
    view['integrations'] = _integrations_status(_read_integration_secret())
    logo_key = _current_logo_key(table)
    if logo_key:
        view['logo_url'] = _signed_logo_url(logo_key)
    return view


def _with_logo_preview(reference: dict) -> dict:
    """Every stored key of a reference's ``extracted_design`` → a short-lived signed GET, like ``logo_url``:
    ``logo.preview_url``, ``logo.svg_preview_url`` (download-only: the URL pins ``image/svg+xml`` and
    ``attachment``), ``icons[].url`` / ``icons[].svg_url`` (``shared.design_assets.with_asset_urls``).

    The keys never leave the API; without a bucket, or for a key outside its prefix, there is no URL.
    """
    return design_assets.with_asset_urls(
        reference, _signed_asset_url if RAW_DATA_BUCKET else None,
        preview_prefix=extracted_design.LOGO_PREVIEW_PREFIX, icons_prefix=extracted_design.ICONS_PREFIX)


def _signed_asset_url(key: str, as_svg_attachment: bool) -> str:
    return get_s3_client().generate_presigned_url(
        ClientMethod='get_object', Params=design_assets.signed_params(RAW_DATA_BUCKET, key, as_svg_attachment),
        ExpiresIn=LOGO_URL_TTL_SECONDS,
    )


def _design_names_hidden(reference: dict, hidden: HiddenNames) -> bool:
    """Whether a reference's ``extracted_design`` text (guidelines, components) names a hidden category."""
    design = reference.get('extracted_design')
    if not isinstance(design, dict):
        return False
    guidelines = design.get('guidelines_md')
    if isinstance(guidelines, str) and hidden.named_in(guidelines):
        return True
    return any(component_names_hidden(c, hidden) for c in design.get('components') or [])


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
# The logo "Use this logo" stores for the draft: what a PUT may name as ``logo_id``.
DRAFT_LOGO_ID_RE = re.compile(r'logo_[0-9a-f]{12}\.(png|jpg|webp)')


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
        ExpressionAttributeValues={':key': target['s3_key'], ':now': now_iso()},
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
    include_archived = params.get('include_archived') == 'true' and is_admin(event)
    return _design_view(_configured_table(), include_archived=include_archived)


@app.put("/settings/design-system")
@tracer.capture_method
def put_design_system_route():
    """Replace tokens, guidelines and logo URL (admin). References are separate rows."""
    event = app.current_event.raw_event
    require_admin(event)
    table = _configured_table()
    body = json_object_body(app)
    clean = company_context.validate_design_system(body)
    drafted_logo = _drafted_logo_key(body.get('logo_id'))
    # The uploaded logo is not part of the PUT body: carry it over, so saving
    # tokens never drops the company logo — unless the draft carries a reference's logo.
    existing = table.get_item(Key=_design_system_key()).get('Item') or {}
    kept = {attr: existing[attr] for attr in (LOGO_KEY_ATTR, LOGO_PENDING_KEY_ATTR)
            if _logo_key_or_none(existing.get(attr))}
    if drafted_logo:
        kept = {LOGO_KEY_ATTR: drafted_logo}
    table.put_item(Item={
        'pk': company_context.DESIGN_SYSTEM_PK, 'sk': company_context.CONFIG_SK,
        **clean, **kept, 'updated_at': now_iso(), 'updated_by_username': _caller_username(event),
    })
    return _design_view(table)


def _drafted_logo_key(logo_id: object) -> str | None:
    """The object key of a ``logo_id`` from "Use this logo" (``logo_<12 hex>.<png|jpg|webp>``), or None when absent.

    400 when it is malformed or its object does not exist (only the logo route writes one).
    """
    if logo_id in (None, ''):
        return None
    if not isinstance(logo_id, str) or not DRAFT_LOGO_ID_RE.fullmatch(logo_id):
        raise ValidationError('logo_id is not a logo from "Use this logo"')
    key = f'{design_references.UPLOAD_PREFIX}{logo_id}'
    if not RAW_DATA_BUCKET or not _uploaded(key):
        raise ValidationError('logo_id: that logo file was not found; use the logo again')
    return key


def _reference_key(ref_id: str) -> dict:
    return {'pk': company_context.DESIGN_SYSTEM_PK, 'sk': f'{company_context.REFERENCE_SK_PREFIX}{ref_id}'}


def _reference_or_404(table, ref_id: str) -> dict:
    item = company_context.get_reference(table, ref_id)
    if not item:
        raise NotFoundError('Design reference not found')
    return item


def _start_reference_refresh(table, ref_id: str, kind: object = None) -> None:
    """Hand the fetch + extraction to a worker (it can outlast the 29 s request).

    A live website goes to ``voc-design-capture`` (``DESIGN_CAPTURE_FUNCTION``); everything else
    to the settings worker twin (``ASSIST_WORKER_FUNCTION`` runs this same handler, so
    ``_process_reference_event`` runs there; unset, the API function invokes itself).
    A failure to START is recorded on the reference — never a 500.
    """
    if kind == 'website':
        if not DESIGN_CAPTURE_FUNCTION:
            design_references.record_outcome(table, ref_id, {
                'status': 'error', 'error': 'Reading live websites is not available in this deployment'}, now_iso())
            return
        function_name, payload = DESIGN_CAPTURE_FUNCTION, {'action': DESIGN_CAPTURE_ACTION, 'ref_id': ref_id, **payload_fields()}
    else:
        function_name = os.environ.get('ASSIST_WORKER_FUNCTION') or os.environ.get('AWS_LAMBDA_FUNCTION_NAME', '')
        payload = {'action': DESIGN_REFRESH_ACTION, 'ref_id': ref_id, **payload_fields()}
    if not function_name:
        _record_refresh_start_failure(table, ref_id, RuntimeError.__name__)
        return
    try:
        invoke_lambda_async(function_name, payload)
    except Exception as e:  # noqa: BLE001 - recorded on the reference instead of failing the request
        _record_refresh_start_failure(table, ref_id, type(e).__name__)


def _record_refresh_start_failure(table, ref_id: str, error_type: str) -> None:
    """Log the failure TYPE only (a message would never be read) and record it on the reference."""
    logger.warning(f'Could not start design reference refresh: {error_type}')
    design_references.record_outcome(
        table, ref_id, {'status': 'error', 'error': 'Could not start the refresh; try again'}, now_iso())


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


def _require_public_url(url: str) -> None:
    """The SSRF guard (``shared.url_policy``) on a website reference's URL, at create time."""
    is_valid, error = validate_url(url)
    if not is_valid:
        raise ValidationError(f'url: {error}')


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
    if request['kind'] == 'website':
        _require_public_url(request['url'])
    active = company_context.list_references(table)
    duplicate = reference_urls.duplicate_reference(active, request['url']) if request.get('url') else None
    if duplicate is not None:
        raise ConflictError(reference_urls.duplicate_message(duplicate))
    if len(active) >= company_context.MAX_REFERENCES:
        raise ValidationError(f'At most {company_context.MAX_REFERENCES} active references; archive one first')
    ref_id = company_context.new_id('ref')
    now = now_iso()
    item = {**_reference_key(ref_id), 'id': ref_id, **request, 'status': 'pending',
            'created_at': now, 'updated_at': now}
    upload_bytes = _attach_upload(item, body) if request['kind'] in company_context.UPLOAD_KINDS else None
    table.put_item(Item=item)
    result: dict = {}
    if upload_bytes is None:
        _start_reference_refresh(table, ref_id, request['kind'])
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
        ExpressionAttributeValues={':pending': 'pending', ':u': now_iso()},
    )
    _start_reference_refresh(table, ref_id, item.get('kind'))
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(
        {'reference': company_context.reference_view(_reference_or_404(table, ref_id))}, default=str))


@app.delete("/settings/design-system/references/<ref_id>")
@tracer.capture_method
def archive_design_reference_route(ref_id: str):
    """Archive a reference (admin). The row and any uploaded object are kept (keep-all); the copies made when
    it was read — the logo PREVIEW (``logo_preview_<ref id>.*``, its sanitised SVG included) and the copied
    icons (everything under ``icons_<ref id>/``) — are deleted and their keys dropped from the row. Repeating
    the call is safe: an already archived reference is archived again and its (absent) copies deleted again,
    so a 503 from the S3 step is fixed by retrying."""
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    item = _reference_or_404(table, ref_id)
    table.update_item(Key=_reference_key(ref_id), **_archive_update(item))
    if RAW_DATA_BUCKET:
        try:
            s3 = get_s3_client()
            design_logo.delete_previews(s3, RAW_DATA_BUCKET, ref_id,
                                        design_icons.stored_icon_keys(s3, RAW_DATA_BUCKET, ref_id))
        except design_logo.LogoPreviewDeleteError as e:
            raise ServiceUnavailableError('The reference is archived, but its logo preview could not be '
                                          'removed; try again') from e
    record_delete(table, kind='design_reference_copies', target={'ref_id': ref_id},
                  actor=actor_from_event(app.current_event.raw_event))
    return {'reference': company_context.reference_view(_reference_or_404(table, ref_id))}


def _archive_update(item: dict) -> dict:
    """The archive ``update_item`` arguments: status + time, and REMOVE of ``extracted_design.logo.preview_key``
    / ``svg_preview_key`` and ``extracted_design.icons`` when the row has them (a REMOVE on a path whose parent
    is not a map would be refused, so each is only sent when its parent is a map carrying the key)."""
    names = {'#st': 'status', '#u': 'updated_at'}
    removes: list[str] = []
    design = item.get('extracted_design')
    logo = design.get('logo') if isinstance(design, dict) else None
    for attr in ('preview_key', 'svg_preview_key'):
        if isinstance(logo, dict) and attr in logo:
            names.update({'#d': 'extracted_design', '#l': 'logo', f'#{attr}': attr})
            removes.append(f'#d.#l.#{attr}')
    if isinstance(design, dict) and 'icons' in design:
        names.update({'#d': 'extracted_design', '#icons': 'icons'})
        removes.append('#d.#icons')
    expression = 'SET #st = :archived, #u = :u' + (' REMOVE ' + ', '.join(removes) if removes else '')
    return {'UpdateExpression': expression, 'ExpressionAttributeNames': names,
            'ExpressionAttributeValues': {':archived': 'archived', ':u': now_iso()}}


def _extracted_design_or_409(item: dict) -> dict:
    if item.get('status') == 'archived':
        raise ConflictError('This reference is archived')
    design = item.get('extracted_design')
    if not isinstance(design, dict):
        raise ConflictError('This reference has no extracted design yet; fetch it again')
    return design


@app.post("/settings/design-system/references/<ref_id>/apply")
@tracer.capture_method
def apply_design_reference_route(ref_id: str):
    """The current design system merged with a reference's ``extracted_design`` (admin), NOT saved.

    → 200 ``{draft: {tokens, guidelines, logo_candidate}, changes}``. A token with the same
    name / role is replaced, new ones are appended (≤ 40 per group); the guidelines gain a
    "## From <title>" section (or take the reference's as is when empty). The admin reviews the
    draft in the editor and saves it with ``PUT /settings/design-system``.
    """
    require_admin(app.current_event.raw_event)
    table = _configured_table()
    item = _reference_or_404(table, ref_id)
    design = _extracted_design_or_409(item)
    title = item.get('title') or item.get('url')
    return extracted_design.apply_to_draft(company_context.get_design_system(table), design, title)


@app.post("/settings/design-system/references/<ref_id>/logo")
@tracer.capture_method
def use_reference_logo_route(ref_id: str):
    """Put a reference's logo candidate into the draft (admin) → 200 ``{logo_id, logo_url}``; NOTHING is saved.

    The candidate is downloaded server-side through the SSRF guard (``shared.design_logo``:
    https, every hop re-validated, ≤ 2 MB, PNG/JPEG/WebP by its bytes) and stored as an object
    under ``company-context/design/logo_*``. The design-system row is untouched: the editor shows
    ``logo_url`` (a signed GET) and the admin's ``PUT /settings/design-system`` with ``logo_id``
    makes it the company logo; a discarded draft leaves the object unused (kept, like uploads).
    A RENDERED candidate (an SVG logo the capture worker drew as a PNG) is not downloaded: its stored
    preview PNG is copied (checked again by its bytes, ≤ 2 MB); 409 when that preview is gone.
    """
    require_admin(app.current_event.raw_event)
    if not RAW_DATA_BUCKET:
        raise ConfigurationError('Raw data bucket not configured')
    table = _configured_table()
    candidate = extracted_design.clean_logo(_extracted_design_or_409(_reference_or_404(table, ref_id)).get('logo'))
    if candidate is None:
        raise ConflictError('This reference has no logo to use')
    data, content_type = _reference_logo_bytes(candidate)
    key = design_references.upload_key(company_context.new_id('logo'), design_logo.LOGO_EXTENSIONS[content_type])
    get_s3_client().put_object(Bucket=RAW_DATA_BUCKET, Key=key, Body=data, ContentType=content_type)
    logger.info('Design reference logo drafted', extra={'content_type': content_type, 'bytes': len(data)})
    return {'logo_id': key.removeprefix(design_references.UPLOAD_PREFIX), 'logo_url': _signed_logo_url(key)}


def _reference_logo_bytes(candidate: dict) -> tuple[bytes, str]:
    """A rendered SVG logo's stored PNG preview (never downloaded: its source is an SVG), else the download."""
    try:
        if candidate.get('rendered') is True:
            png = design_logo.read_rendered_preview(get_s3_client(), RAW_DATA_BUCKET, candidate.get('preview_key'))
            return png, design_logo.PNG_TYPE
        return design_logo.fetch_logo(candidate['source_url'])
    except design_logo.LogoPreviewMissing as e:
        raise ConflictError('Refresh the reference to read its logo again') from e
    except design_logo.LogoFetchError as e:
        raise ValidationError(str(e)) from e


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
        start_logo_render=_start_logo_render if DESIGN_CAPTURE_FUNCTION else None,
    )
    outcome = design_references.process_reference(table, item, deps)
    logger.info('Design reference processed', extra={'kind': item.get('kind'), 'status': outcome['status']})
    return {'status': outcome['status']}


def _start_logo_render(event: dict) -> bool:
    """Hand a GitHub reference's sanitised SVG logo to ``voc-design-capture`` (async) → whether it started.

    The settings role already may invoke that function (website references); a failure is logged by type
    and the reference gets the "upload a PNG export" note instead (``design_references``).
    """
    try:
        invoke_lambda_async(DESIGN_CAPTURE_FUNCTION, event)
    except Exception as e:  # noqa: BLE001 - the reference stays usable; the caller records the note
        logger.warning(f'Could not start the SVG logo render: {type(e).__name__}')
        return False
    return True


# ============================================
# Dimensions, source profiles and erasure jobs (docs/dimensions.md, docs/source-policies.md)
# ============================================

def _settings_row(key: dict) -> dict:
    return _configured_table().get_item(Key=key, ConsistentRead=True).get('Item') or {}


def _put_config_row(kind: str, deployment_key: dict, scope: WorkspaceScope | None, field: str, value: list,
                    event: dict) -> None:
    """Save a dimensions / source-profiles row (``scope``'s workspace's, the deployment's without one), then bump
    config_version (cached reads depend on both; the one counter, so a workspace's save refreshes every cached
    read, which over-invalidates and never serves a stale one)."""
    table = _configured_table()
    put_config_item(table, kind, deployment_key, scope,
                    {field: value, 'updated_at': now_iso(), 'updated_by': _caller_label(event)})
    bump_config_version(table)


def _validated_list(body_field: str, validate) -> list:
    """``validate(body[body_field])`` for an admin PUT; 400 with the validator's message."""
    body = json_object_body(app)
    try:
        return validate(body.get(body_field))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _stored_dimensions_or_500(scope: WorkspaceScope | None = None) -> list[dict]:
    """The dimensions config (``scope``'s workspace's, the deployment's without one) on a write path: a corrupt stored
    row is a 500, never "no dimensions"."""
    try:
        return load_dimensions_config(_configured_table(), scope)
    except ValueError as exc:
        logger.warning('Stored dimensions config is invalid')
        raise ServiceError('The stored dimensions configuration is invalid; save it again first') from exc


@app.get("/settings/dimensions")
@tracer.capture_method
def get_dimensions_route():
    """The built-in plus the configured dimensions — any signed-in user (filters and chips need them): the
    workspace's own with ``X-Workspace-Id`` (any member; only the built-ins until it saves some), the deployment's
    without it."""
    context = request_workspace(app.current_event.raw_event, FAILED_DIMENSIONS_READ)
    item = get_config_item(_configured_table(), DIMENSIONS_KIND, DIMENSIONS_SETTINGS_KEY, _config_scope(context))
    try:
        dimensions = validate_dimensions(item.get('dimensions'))
    except ValueError:
        logger.warning('Stored dimensions config is invalid; answering with the built-in ones only')
        dimensions = []
    return {'dimensions': with_builtin_dimensions(dimensions), 'updated_at': item.get('updated_at')}


@app.put("/settings/dimensions")
@tracer.capture_method
def put_dimensions_route():
    """Replace the dimensions (an admin's: the workspace's with ``X-Workspace-Id``, the deployment's without it).
    Body ``{dimensions}``, validated by ``shared.dimension_config``.

    Built-in dimensions in the body are ignored (never stored); the answer lists them first.
    """
    event = app.current_event.raw_event
    # A write: the caller's role from the table, not the warm cache.
    context = request_workspace(event, FAILED_DIMENSIONS_SAVE, fresh=True)
    require_settings_admin(event, context)
    dimensions = _validated_list('dimensions', validate_dimensions)
    _put_config_row(DIMENSIONS_KIND, DIMENSIONS_SETTINGS_KEY, _config_scope(context), 'dimensions', dimensions, event)
    logger.info('Dimensions saved', extra={'dimensions': len(dimensions)})
    return {'success': True, 'dimensions': with_builtin_dimensions(dimensions)}


@app.get("/settings/sources")
@tracer.capture_method
def get_sources_route():
    """Source profiles: the workspace's own with ``X-Workspace-Id`` (none until it saves some), the deployment's
    without it; in full for their editors (``_sees_full_config``), ``{id, label, restricted}`` for everyone else."""
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_SOURCES_READ)
    try:
        profiles = load_source_profiles(_configured_table(), _config_scope(context))
    except ValueError:
        logger.warning('Stored source profiles are invalid; answering with none')
        profiles = []
    if _sees_full_config(event, context):
        return {'sources': profiles}
    return {'sources': [{key: p[key] for key in ('id', 'label', 'restricted')} for p in profiles]}


@app.put("/settings/sources")
@tracer.capture_method
def put_sources_route():
    """Replace the source profiles (an admin's: the workspace's with ``X-Workspace-Id``, the deployment's without
    it). ``dimension_defaults`` must name configured dimensions/values (the same scope's). A workspace's profile sets
    no retention window and no Radar brand (400, shared/source_profiles.py ``workspace_profiles_problem``): the
    deployment's window binds every item, and Radar is not kept per workspace."""
    event = app.current_event.raw_event
    # A write: the caller's role from the table, not the warm cache.
    context = request_workspace(event, FAILED_SOURCES_SAVE, fresh=True)
    require_settings_admin(event, context)
    scope = _config_scope(context)
    if scope is not None:
        # Checked on the list as sent: normalising drops a legal basis or Radar domains sent without their field.
        problem = workspace_profiles_problem(json_object_body(app).get('sources'))
        if problem is not None:
            raise ValidationError(problem)
    dimensions = _stored_dimensions_or_500(scope)
    sources = _validated_list('sources', lambda value: validate_source_profiles(value, dimensions))
    _put_config_row(SOURCES_KIND, SOURCES_SETTINGS_KEY, scope, 'sources', sources, event)
    clear_source_profiles_cache()
    logger.info('Source profiles saved', extra={'sources': len(sources)})
    return {'success': True, 'sources': sources}


# Email inbox (docs/email-intake.md). The deploy flags reach this Lambda as env vars; an
# empty INBOUND_EMAIL_DOMAIN means the inbox is not deployed.
INBOUND_EMAIL_DOMAIN = os.environ.get('INBOUND_EMAIL_DOMAIN', '').strip().lower()
INBOUND_EMAIL_RULE_SET = os.environ.get('INBOUND_EMAIL_RULE_SET', '')
INBOUND_EMAIL_RULE_SET_OWNED = os.environ.get('INBOUND_EMAIL_RULE_SET_OWNED', '') == '1'


def _inbox_view() -> dict:
    table = _configured_table()
    caps_row = _settings_row(inbox.CONFIG_KEY)
    day = inbox.today()
    profiles = load_source_profiles(table)
    stored = next((p for p in profiles if p['id'] == inbox.EMAIL_INTAKE_SOURCE), None)
    return {
        'enabled': bool(INBOUND_EMAIL_DOMAIN),
        'domain': INBOUND_EMAIL_DOMAIN or None,
        'addresses': inbox.inbox_addresses(INBOUND_EMAIL_DOMAIN),
        'rule_set': INBOUND_EMAIL_RULE_SET or None,
        'rule_set_needs_activation': bool(INBOUND_EMAIL_DOMAIN) and INBOUND_EMAIL_RULE_SET_OWNED,
        'caps': inbox.caps_from_row(caps_row),
        'defaults': dict(inbox.DEFAULT_CAPS),
        'today': inbox.stats_view(day, _settings_row(inbox.stats_key(day))),
        'pii': (stored or profile_for([], inbox.EMAIL_INTAKE_SOURCE))['pii'],
        'profile_configured': stored is not None,
        # Built in since 5.45 (shared.feedback_types): always present.
        'feedback_type_dimension': True,
        'updated_at': caps_row.get('updated_at'),
    }


@app.get("/settings/email-inbox")
@tracer.capture_method
def get_email_inbox_route():
    """The inbox: deployed or not, its addresses, caps, today's counters (admin)."""
    require_admin(app.current_event.raw_event)
    return _inbox_view()


@app.put("/settings/email-inbox")
@tracer.capture_method
def put_email_inbox_route():
    """Set the caps ``{daily_cap, sender_daily_cap, daily_model_calls}`` (admin)."""
    event = app.current_event.raw_event
    require_admin(event)
    try:
        caps = inbox.validate_caps(json_object_body(app))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    _configured_table().put_item(Item={
        **inbox.CONFIG_KEY, **caps, 'updated_at': now_iso(), 'updated_by': _caller_label(event),
    })
    logger.info('Email inbox caps saved', extra=caps)
    return {'success': True, **_inbox_view()}


@app.post("/settings/email-inbox/feedback-type-dimension")
@tracer.capture_method
def create_feedback_type_dimension_route():
    """Kept for older SPAs: ``feedback_type`` is built in since 5.45, so nothing is ever created (admin)."""
    require_admin(app.current_event.raw_event)
    return {'success': True, 'created': False, 'dimensions': _stored_dimensions_or_500()}


MAX_ERASURE_VALUE_CHARS = 1_000
MAX_LISTED_ERASURE_JOBS = 20
ERASURE_VIEW_FIELDS = (
    'job_id', 'status', 'field', 'source', 'value_hash', 'legal_basis', 'deleted_items', 'deleted_objects',
    'started_by', 'created_at', 'finished_at', 'error', 'phase', 'progress_at',
    # The one workspace a job erases in (shared/erasure_scope.py), on its row only when it names one.
    'workspace_id',
)
# The erasure routes' workspace (shared/erasure_scope.py): read afresh per request, members only (no platform-admin
# entry, so nothing is written to voc-workspaces).
_erasure_workspace = RequestWorkspace(confirm_platform_admin=no_platform_admin_entry)


SOURCE_SCOPED_ERASURE_FIELDS: Final = frozenset({'source_id', 'csv_row_id'})


@dataclass(frozen=True)
class ErasureRequest:
    """A validated ``POST /settings/erasure`` body (the value is never echoed or stored)."""

    field: str
    value: str
    source: str | None
    legal_basis: str


def _erasure_request(body: dict) -> ErasureRequest:
    """The request from a POST body, or 400. ``legal_basis`` is required (shared/legal_basis.py)."""
    try:
        legal_basis = required_legal_basis(body.get('legal_basis'))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    field, value, source = _erasure_target(body)
    return ErasureRequest(field, value, source, legal_basis)


def _erasure_target(body: dict) -> tuple[str, str, str | None]:
    """``(field, value, source)`` from a POST body, or 400."""
    field = body.get('field')
    if field not in ERASE_FIELDS:
        raise ValidationError(f"field must be one of: {', '.join(ERASE_FIELDS)}")
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
    if field == SOURCE_FIELD:
        source_value, source_id = _whole_source_request(body, value.strip(), source)
        return field, source_value, source_id
    return field, value.strip(), source


def _erasable_sources() -> list[str]:
    """The source ids a whole-source erasure may name (shared/source_erasure.py)."""
    try:
        profile_ids = [profile['id'] for profile in load_source_profiles(_configured_table())]
    except ValueError:
        logger.warning('Stored source profiles are invalid; listing counted sources only')
        profile_ids = []
    return known_sources(_configured_table(), profile_ids)


def _whole_source_request(body: dict, value: str, source: str | None) -> tuple[str, str]:
    """``(value, source)`` of a whole-source erasure: confirmed, known, and not already being erased."""
    if not SOURCE_ID_RE.match(value):
        raise ValidationError('value must be a source id when field is source')
    if source is not None and source != value:
        raise ValidationError('source must equal value when field is source')
    if body.get('confirm') != value:
        raise ValidationError('confirm must repeat the source id')
    if value not in _erasable_sources():
        raise ValidationError('Unknown source')
    if blocking_job(_configured_table(), value, datetime.now(UTC)) is not None:
        raise ConflictError('An erasure of this source is already running')
    return value, value


def erasure_job_view(item: dict) -> dict:
    """The API's erasure ``Job`` (no keys; the erased value is never stored, only its hash)."""
    view = {field: item.get(field) for field in ERASURE_VIEW_FIELDS if item.get(field) is not None}
    for counter in ERASURE_JOB_COUNTERS:
        view[counter] = int(item.get(counter) or 0)
    # An erasure by email's de-identified board rows and workspace membership rows, and how many of the deleted items
    # were a workspace's (shared/retention.py): on the job row only once above 0, so shown only then.
    for counter in ERASURE_OPTIONAL_COUNTERS:
        if item.get(counter):
            view[counter] = int(item[counter])
    review = item.get('files_needing_review')
    if isinstance(review, dict):
        # Whole-file uploads that hold erased rows AND others (keys only, never content).
        view['files_needing_review'] = {
            'count': int(review.get('count') or 0),
            'keys': [str(key) for key in review.get('keys') or []],
        }
    return view


def _new_erasure_job(request: ErasureRequest, event: dict, context: WorkspaceContext | None) -> dict:
    now = datetime.now(UTC)
    job_id = f'{ERASURE_JOB_PREFIX}{int(now.timestamp() * 1000):012x}'
    item = {
        'pk': ERASURE_JOB_PK, 'sk': job_id, 'job_id': job_id, 'status': 'queued', 'field': request.field,
        'value_hash': sha256_hex(request.value), 'legal_basis': request.legal_basis, 'deleted_items': 0,
        'deleted_objects': 0, 'started_by': _caller_label(event), 'created_at': now.isoformat(),
    }
    # Who to tell when the job ends (shared/job_notices.py); never in the job view (ERASURE_VIEW_FIELDS).
    starter_sub = get_caller_subject(event)
    if starter_sub:
        item['started_by_sub'] = starter_sub
    if request.source:
        item['source'] = request.source
    # The workspace the job erases in: the request's resolved membership only, never the body (shared/erasure_scope.py).
    item = scoped_job_row(item, context)
    if request.field == SOURCE_FIELD:
        # Closes the race the live-job check leaves open (shared/source_erasure.py).
        try:
            acquire_source_lock(_configured_table(), request.value, job_id, now)
        except SourceLocked as exc:
            raise ConflictError('An erasure of this source is already running') from exc
    try:
        # In a workspace: its own job partition and its one-live-erasure lock (409, shared/erasure_scope.py).
        put_job_row(_configured_table(), item, context, now)
    except ClientError as exc:
        _release_erasure_lock(item)
        if _error_code(exc) == 'ConditionalCheckFailedException':
            raise ConflictError('An erasure job was started at the same moment; retry') from exc
        raise
    return item


def _release_erasure_lock(job: dict) -> None:
    """Free a whole-source job's lock when the job never reaches the worker.

    Best effort on an error path: a failed release must not hide the original
    error, and an unreleased lock goes stale after ``STALE_AFTER`` anyway.
    """
    if job.get('field') != SOURCE_FIELD:
        return
    try:
        release_source_lock(_configured_table(), str(job.get('source')), job['job_id'], datetime.now(UTC))
    except ClientError as exc:
        logger.warning('Could not release the source erasure lock', extra={'error_type': type(exc).__name__})


@app.post("/settings/erasure")
@tracer.capture_method
def start_erasure_route():
    """Erase every item matching ``field == value`` (admin): 202 ``{job}``.

    The body states the request's ``legal_basis`` (required since 6.00.00, kept on
    the job row, its audit row and every tombstone).

    The retention worker (``RETENTION_FUNCTION``) does the deleting; the value
    travels in its async event only — the job row keeps a SHA-256 of it, and
    nothing here logs it.

    With ``X-Workspace-Id`` (shared/erasure_scope.py): the workspace's member admins, by author, source_id,
    csv_row_id or email; the job erases that workspace's items only. Without it the deployment's admins, as before.
    """
    event = app.current_event.raw_event
    context = require_erasure_admin(_erasure_workspace, event, write=True)
    if not RETENTION_FUNCTION:
        raise ConfigurationError('Retention worker not configured')
    body = json_object_body(app)
    refuse_field_in_workspace(body.get('field'), context)
    request = _erasure_request(body)
    job = _new_erasure_job(request, event, context)
    try:
        invoke_lambda_async(RETENTION_FUNCTION, job_event(job['job_id'], request.value, context))
    except Exception as e:
        logger.warning('Failed to start the erasure worker', extra={'error_type': type(e).__name__})
        fail_unstarted_job(_configured_table(), job, context, datetime.now(UTC))
        _release_erasure_lock(job)
        raise ServiceError('Failed to start the erasure job') from e
    logger.info('Erasure job started', extra={'job_id': job['job_id'], 'field': request.field})
    return Response(
        status_code=202,
        content_type=content_types.APPLICATION_JSON,
        body=json.dumps({'job': erasure_job_view(job)}),
    )


@app.get("/settings/erasure")
@tracer.capture_method
def list_erasure_route():
    """The newest erasure jobs (admin), at most 20, and the sources a whole-source erasure may name.

    With ``X-Workspace-Id`` the workspace's admins see that workspace's jobs only, and no source (a whole-source
    erasure is the deployment's); without it the deployment's admins see the jobs that name no workspace."""
    context = require_erasure_admin(_erasure_workspace, app.current_event.raw_event)
    jobs = listed_jobs(_configured_table(), context, MAX_LISTED_ERASURE_JOBS)
    return {'jobs': [erasure_job_view(item) for item in jobs],
            'sources': _erasable_sources() if context is None else []}


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    if assist_jobs.is_assist_event(event):
        return assist_jobs.run(event, ASSIST_WORK)
    if is_action_event(event, model_capacity.REFRESH_ACTION):
        return model_capacity.run_refresh_event()
    if is_action_event(event, image_model_quota.REFRESH_ACTION):
        return image_model_quota.run_refresh_event(event)
    if is_action_event(event, DESIGN_REFRESH_ACTION):
        return _process_reference_event(event)
    return app.resolve(event, context)
