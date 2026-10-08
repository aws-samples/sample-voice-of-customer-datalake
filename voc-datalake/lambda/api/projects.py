"""
Projects API endpoints for VoC Analytics.
Handles projects, personas, PRDs, PR/FAQs with multi-step LLM orchestration.
"""
import hashlib
import json
import os
import re
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import category_access, project_access
from shared.api import MAX_PERSONAS_PER_GENERATION, validate_days
from shared.avatar import (
    avatar_key_from_uri,
    avatar_object_owner,
    delete_superseded_avatars,
    get_avatar_cdn_url,
    persona_avatar_keys,
)
from shared.avatar import (
    generate_persona_avatar as _generate_persona_avatar,
)
from shared.aws import get_s3_client
from shared.batch_get import batch_get_all
from shared.converse import ConverseResult, converse_chain, converse_chain_detailed
from shared.document_history import (
    delete_document_revisions,
    edit_document,
    list_document_versions,
    restore_document_version,
)
from shared.document_versions import (
    VERSIONED_DOCUMENT_TYPES,
    get_versioned_document_by_allocation,
    managed_document_type,
    normalize_document_versions,
    normalized_base_title,
    persist_legacy_document_versions,
    persist_versioned_document,
    preserve_versioned_document_allocation,
    split_versioned_title,
    version_partition_key,
    versioned_document_id,
)
from shared.exceptions import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.feedback import (
    feedback_char_budget,
    feedback_item_limit,
    format_feedback_for_llm,
    get_feedback_statistics,
    truncate_feedback_context,
    validate_date_basis,
)
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
)
from shared.ids import timestamped_id, write_with_fresh_id
from shared.indexes import PROJECTS_BY_TYPE_INDEX

# Shared module imports
from shared.logging import logger, metrics, tracer
from shared.model_config import get_active_model_id, surface_context_window_tokens
from shared.persona_context import personas_prompt_context
from shared.project_access import Caller
from shared.project_writes import (
    PROJECT_DELETION_ATTRIBUTE,
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
    create_counted_project_child,
    is_project_tombstone,
    is_verification_fixture,
    project_meta_key,
    projects_table_name,
    put_project_item,
    put_project_item_and_increment,
)
from shared.prompt_safety import neutralise_tags
from shared.prompts import (
    PERSONA_SYNTHESIS_STEP,
    count_persona_sample_records,
    get_persona_generation_steps,
    get_research_analysis_steps,
)
from shared.prototypes import prototype_s3_key, prototype_signed_url
from shared.tables import get_feedback_table, get_jobs_table, get_projects_table

# The instructions "Copy to Kiro" on a document pastes ahead of that document.
# ONE definition only: the frontend reads it from the get_project response's
# kiro_default_export_prompt field, so do not duplicate this text elsewhere.
#
# Since 3.00.00 it is the ONLY prompt: a project's stored kiro_export_prompt (set
# through the removed Export / MCP tab, no longer editable) is never read, and is
# not returned by get_project. The stored attribute is left in place, unused.
#
# Refers to the material by PRESENCE, never by file path: the clipboard payload is
# this text plus one document's markdown, with no files around it.
KIRO_DEFAULT_EXPORT_PROMPT = """\
Build against the project material provided here rather than from assumptions.

- The personas described here are the audience. Check each decision against their goals and frustrations, and say which persona a change serves.
- PRDs carry scope and acceptance criteria. Treat them as the contract for what "done" means, and flag anything you cannot satisfy rather than narrowing it silently.
- PR/FAQs carry customer-facing language. Reuse their wording in UI copy so the product says what was promised.
- Research documents carry the evidence. Cite them when a tradeoff is contested.
- If a requirement is missing, ask rather than inventing one. If two documents disagree, surface the conflict instead of picking one.\
"""

# ---------------------------------------------------------------------------
# Persona-generation input budget (issue #231)
#
# Scope note: this block governs the PERSONA path only — the one live surface
# reached from here (lambda/jobs/persona_generator/handler.py imports
# generate_personas). The PRD and PR/FAQ surfaces named in #231 are bounded in
# lambda/jobs/document_generator/handler.py (`_feedback_context`), which derives
# its budget from the same shared helpers (shared/feedback.py) for the
# 'documents' model surface; research (lambda/research/research_step_handler.py)
# runs its own fetch and caps. Neither is governed by this block.
#
# Both numbers persona_context_budget() returns — the character budget and
# the item-fetch limit — are DERIVED from one measurement rather than chosen
# independently, because independently chosen caps drift: the previous pairing
# of a 500-item limit with a 200 000-char cap meant any corpus over ~245 items
# truncated on the default path, discarding more than half of what DynamoDB had
# just been paid to read, while reporting nothing. shared/feedback.py owns the
# derivation (feedback_char_budget / feedback_item_limit) so the persona,
# prompt-builder, and any future path cannot disagree about the numbers.
#
# What bounds them:
#   - Bedrock input token budget. Derived from the context window of the model
#     actually resolved for the 'documents' surface at runtime, not a literal:
#     shared/model_config.py lets an admin repoint a surface at a
#     smaller-window model, and a literal tuned for 200 K tokens would overflow
#     it as a hard ValidationException — strictly worse than the soft
#     truncation it replaced. feedback_char_budget() reserves overhead for
#     prompts, chaining, and output, then fills half of what remains.
#   - DynamoDB read cost, which is AMPLIFIED well past the item limit:
#     shared/feedback.py derives fetch_ceiling = limit * 3 and applies it as a
#     PER-PARTITION page cap. With post-filters active (sources/sentiments set,
#     or date_basis='review') the early break is disabled and every date
#     partition pages to that cap, so a 30-day window can read up to
#     limit * 3 * 30 items. Budget from that number, not from the item limit.
#   - Latency: prefill scales roughly linearly in input tokens. The persona job
#     runs on a 15-minute Lambda, so it has room — but the read amplification
#     above lands in the same wall clock.
#
# Both are env-overridable so an operator hitting cost or latency trouble can
# tune a deployment without a code change and a redeploy. Neither variable is
# declared in api-stack.ts: unset, the Lambda gets the derived default, and a
# CDK entry restating that default would be one more place for the number to
# drift. Tuning one therefore means setting it on the deployed function (or
# adding it to the stack at that point) — it is not a knob that already exists
# in the template.
ENV_MAX_PERSONA_CONTEXT_CHARS = 'MAX_PERSONA_CONTEXT_CHARS'
ENV_FEEDBACK_LIMIT_PERSONA = 'FEEDBACK_LIMIT_PERSONA'


def _env_positive_int(name: str) -> int | None:
    """A positive int from the environment, or ``None`` when unusable.

    Parsed defensively, and never at import time, because both failure modes are
    severe. A non-numeric value passed to a bare ``int()`` at module scope raises
    during import and takes down every route in the projects Lambda, not just
    persona generation. And a non-positive value would be worse than ignored:
    ``truncate_feedback_context`` reads ``<= 0`` as "no limit", so an operator
    setting ``0`` to *lower* the budget would get an unbounded prompt — the
    opposite of the request, and an immediate Bedrock ValidationException.

    Both cases log and fall back to the derived default.
    """
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            f"Ignoring non-numeric {name}={raw!r}; using the derived default"
        )
        return None
    if value <= 0:
        logger.warning(
            f"Ignoring non-positive {name}={value}; using the derived default "
            f"(a non-positive character budget would mean 'no limit')"
        )
        return None
    return value


def persona_context_budget() -> tuple[int, int]:
    """``(char_budget, item_limit)`` for one persona generation.

    Resolved together, at call time, from the SAME context window. Deriving the
    fetch limit at import from the 200 K default while trimming at runtime to
    whatever model the 'documents' surface resolves to is exactly how the two
    drift: repoint that surface at a narrower model and the fetch stays sized
    for 200 K while the budget shrinks, so truncation is once again the default
    path — the blindness #231 is about, reintroduced by the fix for it.

    Env overrides are honoured independently, so an operator can pin either the
    budget or the fetch limit and leave the other derived.
    """
    budget = _env_positive_int(ENV_MAX_PERSONA_CONTEXT_CHARS) or feedback_char_budget(
        window_tokens=surface_context_window_tokens('documents')
    )
    limit = _env_positive_int(ENV_FEEDBACK_LIMIT_PERSONA) or feedback_item_limit(budget)
    return budget, limit


# Item-fetch limit for the research fallback. Left at its historical value ON
# PURPOSE: a real deployment reaches the Step Functions workflow instead (see
# run_research), so raising it would be a change with no user-visible effect
# that reads in the diff as if #231's research half had been addressed. Named
# rather than bare so the value is at least visible to a reader.
FEEDBACK_LIMIT_RESEARCH: int = 100  # fallback path only — see run_research
# Quick single-call helpers. These ARE live (imported by projects_handler.py)
# but run synchronously behind API Gateway, whose 29 s timeout — not the token
# budget — is what bounds them. Unchanged: #231 is about corpus loss in
# generated artifacts, and trading interactive latency for a bigger sample in a
# suggestion box is a different tradeoff that deserves its own measurement.
FEEDBACK_LIMIT_AUTOFILL: int = 20   # bounded by API Gateway 29 s timeout
FEEDBACK_LIMIT_BRIEF: int = 40      # bounded by API Gateway 29 s timeout
FEEDBACK_LIMIT_RESEARCH_SUGGEST: int = 40  # bounded by API Gateway 29 s timeout
# ---------------------------------------------------------------------------

# Ceiling on parallel avatar generations inside one persona generation. Derived from the
# shared persona ceiling rather than repeating the number, so today every persona in a
# batch gets its own worker and raising that ceiling cannot silently halve the fan-out
# benefit while every test still passes — which is what a matching comment allowed.
AVATAR_MAX_CONCURRENCY = MAX_PERSONAS_PER_GENERATION
# Stamped into every persona's llm_metadata so a stored persona stays attributable to the
# prompt chain that produced it. Bumped 2.0.0 -> 2.1.0 with the removal of the third
# ('validation') chain step: 2.0.0 personas came from a three-step chain, and leaving the
# version alone would make two different chains claim one version. Minor, not major — the
# persona object's own shape is unchanged, only the chain that fills it. 2.2.0 adds the
# varied-names instruction and the project's names-to-avoid block (#240).
# Must equal persona-generation.json's "version"; a lockstep test pins the pair, since this
# is a literal in the house style of processor/handler.py's PROMPT_VERSION rather than a
# value read back out of the file.
PERSONA_PROMPT_VERSION = '2.2.0'

# The AI surface (shared/model_config.py) persona generation's chain runs on. The
# provenance stamp (`llm_metadata.model`) does NOT re-resolve it: it is the model the
# synthesis step itself reported (ConverseResult.model_id), so a picker change during a
# run cannot mislabel the personas (#273).
PERSONA_SURFACE = 'documents'


def generate_persona_avatar(
    persona_data: dict, s3_bucket: str | None = None, project_id: str | None = None,
) -> dict:
    """Generate a persona avatar via shared.avatar (the patch point jobs and tests use).

    Args:
        persona_data: Dict with persona info (name, tagline, identity, persona_id)
        s3_bucket: Optional S3 bucket override
        project_id: The owning project, stamped on the S3 object so a project
            delete can tell its own avatars from a neighbour's (the key space is
            flat and persona ids are not globally unique)

    Returns:
        dict with 'avatar_url' and 'avatar_prompt'
    """
    return _generate_persona_avatar(persona_data, s3_bucket, project_id)


def get_feedback_context(filters: dict, limit: int) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    return _get_feedback_context(feedback_table, filters, limit)


def get_scoped_feedback_context(
    filters: object, limit: int, category_scope: dict | None,
) -> list[dict]:
    """Feedback for a SYNCHRONOUS request, read under the caller's category scope.

    ``filters`` may come from the request body, so a client-supplied scope key is
    discarded and replaced by ``category_scope`` (the caller's scope as
    ``category_access.scope_to_config`` stores it; None reads unrestricted), and
    ``date_basis`` is validated here — the one boundary every synchronous
    feedback read (PR-FAQ autofill, document brief, research questions,
    research fallback) crosses — so ``'REVIEW'`` windows by review date rather
    than silently falling back to import date (#258).
    """
    scoped = {
        key: value for key, value in (filters if isinstance(filters, dict) else {}).items()
        if key != category_access.SCOPE_CONFIG_KEY
    }
    scoped['date_basis'] = validate_date_basis(scoped.get('date_basis'))
    if category_scope is not None:
        scoped[category_access.SCOPE_CONFIG_KEY] = category_scope
    return get_feedback_context(scoped, limit=limit)


projects_table = get_projects_table()
feedback_table = get_feedback_table()


def fix_persona_name(name: str) -> str:
    """Fix persona names that may be missing spaces between words.

    LLMs sometimes generate names like "VeronicaChen" instead of "Veronica Chen".
    This function adds spaces between lowercase and uppercase letter transitions.
    """
    return re.sub(r'([a-z])([A-Z])', r'\1 \2', name)


@tracer.capture_method
def list_projects(caller: Caller) -> dict:
    """List the projects ``caller`` can view, with accurate counts.

    Filtering happens before the per-project count query, so a private project
    the caller cannot see costs nothing beyond its index row.
    """
    if not projects_table:
        return {'projects': []}

    projects = []
    for item in _iter_project_index_rows():
        if is_project_tombstone(item):
            continue
        # Verification fixtures are indexed like real projects on purpose, so the
        # fixture exercises the real read paths. Hide them from the LIST only —
        # excluding them from the by-id reads below would defeat that purpose.
        if is_verification_fixture(item):
            continue
        if not project_access.resolve_access(item, caller).can_view:
            continue
        project_id = item.get('project_id')
        persona_count, document_count = _count_project_children(project_id)

        projects.append(_without_emails_unless_manager({
            'project_id': project_id,
            'name': item.get('name'),
            'description': item.get('description'),
            'purpose': item.get('purpose', ''),
            'status': item.get('status', 'active'),
            'created_at': item.get('created_at'),
            'updated_at': item.get('updated_at'),
            'persona_count': persona_count,
            'document_count': document_count,
            **({'created_by_agent': item['created_by_agent']}
               if isinstance(item.get('created_by_agent'), str) else {}),
            **project_access.sharing_summary(item, caller),
        }, item, caller))

    return {'projects': projects}


def _paginated_items(query: dict) -> Iterator[dict]:
    """Yield every item of a projects-table query, following LastEvaluatedKey.

    Normalised at the boundary — non-dict items and malformed pages are
    skipped — and lazy, so a caller that stops early reads no further page.
    The ONE place the projects module pages a query.
    """
    query = dict(query)
    while True:
        response = projects_table.query(**query)
        if not isinstance(response, dict):
            return
        page_items = response.get('Items')
        if isinstance(page_items, list):
            yield from (item for item in page_items if isinstance(item, dict))
        cursor = response.get('LastEvaluatedKey')
        if not isinstance(cursor, dict) or not cursor:
            return
        query['ExclusiveStartKey'] = cursor


def _iter_project_index_rows() -> Iterator[dict]:
    """Every project META row on the by-type index, newest first, all pages."""
    return _paginated_items({
        'IndexName': PROJECTS_BY_TYPE_INDEX,
        'KeyConditionExpression': Key('gsi1pk').eq('TYPE#PROJECT'),
        'ScanIndexForward': False,
    })


def _count_project_children(project_id: object) -> tuple[int, int]:
    """(persona_count, document_count) over the project's whole partition."""
    persona_count = 0
    document_count = 0
    for child in _paginated_items({
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ProjectionExpression': 'sk',
    }):
        sk = child.get('sk')
        if not isinstance(sk, str):
            continue
        if sk.startswith('PERSONA#'):
            persona_count += 1
        elif sk.startswith(_DOCUMENT_SORT_KEY_PREFIXES):
            document_count += 1
    return persona_count, document_count


@tracer.capture_method
def create_project(body: dict, caller: Caller) -> dict:
    """Create a new project owned by ``caller`` (private unless asked otherwise).

    An autonomous-agent principal creates it for the run's handoff target
    (``project_access.agent_project_owner_sub``) with its invited editors, and
    the project records which agent created it.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    if caller.agent_id:
        sharing = _agent_created_sharing(caller)
    elif caller.delegated or not caller.subject:
        # An MCP credential acts for its minter but never owns anything.
        raise AuthorizationError('Only a signed-in user can create a project')
    else:
        sharing = {**project_access.owner_attributes(caller), 'members': {}}
    visibility = _validated_visibility(
        body.get('visibility', project_access.DEFAULT_NEW_PROJECT_VISIBILITY)
    )
    purpose = _validated_purpose(body.get('purpose', ''))

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()

    def put_project(project_id: str) -> dict:
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': 'META',
            'gsi1pk': 'TYPE#PROJECT',
            'gsi1sk': now,
            'project_id': project_id,
            'name': body.get('name', 'New Project'),
            'description': body.get('description', ''),
            'purpose': purpose,
            'status': 'active',
            'created_at': now,
            'updated_at': now,
            'persona_count': 0,
            'document_count': 0,
            'filters': body.get('filters', {}),
            **sharing,
            'visibility': visibility,
        }
        projects_table.put_item(
            Item=item,
            ConditionExpression='attribute_not_exists(pk) AND attribute_not_exists(sk)',
        )
        return item

    # Two creates in the same second used to mint the same `proj_<stamp>` and
    # the second one 500'd on this condition (shared/ids.py).
    item = write_with_fresh_id('proj', put_project, now=now_dt)
    return {'success': True, 'project': _with_sharing_fields(item, caller)}


# What an agent maintains about a project so later runs can match issues to it.
MAX_PROJECT_PURPOSE_CHARS = 2000


def _validated_name(value: object) -> str:
    """A project name on update: a string that is not blank once trimmed.

    The Projects list's Edit dialog is the first UI that renames a project, so a
    blank or non-string name is refused here rather than stored as an untitled card.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValidationError('Project name must be a non-empty string')
    return value.strip()


def _validated_description(value: object) -> str:
    if not isinstance(value, str):
        raise ValidationError('Project description must be a string')
    return value


def _validated_purpose(value: object) -> str:
    if not isinstance(value, str):
        raise ValidationError('purpose must be a string')
    purpose = value.strip()
    if len(purpose) > MAX_PROJECT_PURPOSE_CHARS:
        raise ValidationError(f'purpose must be at most {MAX_PROJECT_PURPOSE_CHARS} characters')
    return purpose


def _agent_created_sharing(caller: Caller) -> dict:
    """Owner identity, editor members and provenance for an agent-created project.

    Every identity is resolved through Cognito (enabled users only), never
    taken from a claim's display fields. An unresolvable editor is skipped —
    one departed category owner must not fail the run — but an unresolvable
    OWNER refuses the create, since ownership must land on a real user.
    """
    try:
        owner_sub = project_access.agent_project_owner_sub(caller)
    except ValueError as exc:
        raise AuthorizationError('This agent has no owner to create a project for') from exc
    try:
        owner = _new_owner_identity(owner_sub)
    except NotFoundError as exc:
        raise ValidationError('The project owner is not an active user') from exc
    now = _now_iso()
    added_by = f'{project_access.AGENT_SUBJECT_PREFIX}{caller.agent_id}'
    members: dict[str, dict] = {}
    for sub in caller.agent_editor_subs:
        if sub == owner_sub:
            continue
        try:
            editor = _resolve_user(sub)
        except NotFoundError:
            logger.warning('Skipping an inactive editor for an agent-created project')
            continue
        members[sub] = {
            'role': project_access.ROLE_EDITOR, 'username': editor['username'],
            'email': editor['email'], 'added_by': added_by, 'added_at': now,
        }
    return {
        'owner_sub': owner_sub,
        'owner_username': owner['username'],
        'owner_email': owner['email'],
        'members': members,
        project_access.CREATED_BY_AGENT_ATTRIBUTE: caller.agent_id,
    }


def _validated_visibility(value: object) -> str:
    try:
        return project_access.validate_visibility(value)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _with_sharing_fields(meta: dict, caller: Caller) -> dict:
    """A response copy of META with the computed sharing fields attached.

    The stored ``members`` map is replaced by the client-facing list. These
    fields are COMPUTED, never written back (update_project is allowlisted).
    """
    return _without_emails_unless_manager({
        **meta,
        **project_access.sharing_summary(meta, caller),
        'members': project_access.public_members(meta),
    }, meta, caller)


def _without_email(entry: object) -> object:
    """``entry`` minus its ``email`` key when it is a dict (anything else as-is)."""
    if not isinstance(entry, dict):
        return entry
    return {key: value for key, value in entry.items() if key != 'email'}


def _without_emails_unless_manager(payload: dict, meta: dict, caller: Caller) -> dict:
    """`payload` with every owner/member email removed unless `caller` can manage.

    An email is a contact detail, needed only by whoever manages membership (the
    owner and admins); a viewer or editor gets the same owner and member entries
    without it. Covers the raw `owner_email` a META copy carries, the computed
    `owner`, and each entry of a `members` list.
    """
    if project_access.resolve_access(meta, caller).can_manage:
        return payload
    redacted = {key: value for key, value in payload.items() if key != 'owner_email'}
    if 'owner' in redacted:
        redacted['owner'] = _without_email(redacted['owner'])
    if isinstance(redacted.get('members'), list):
        redacted['members'] = [_without_email(entry) for entry in redacted['members']]
    return redacted


def _without_stored_emails(meta: dict) -> dict:
    """A copy of stored META with every contact email removed.

    The caller-less (internal) read of a project: with no caller there is nobody
    who may manage it, so — as for a viewer — no owner or member email is
    returned. Covers ``owner_email`` and each entry of the stored ``members`` map.
    """
    redacted = {key: value for key, value in meta.items() if key != 'owner_email'}
    members = redacted.get('members')
    if isinstance(members, dict):
        redacted['members'] = {sub: _without_email(entry) for sub, entry in members.items()}
    return redacted


def _with_signed_prototype_url(item: dict, project_id: str) -> dict:
    """Attach a freshly signed `prototype_url` to a prototype document.

    Only HTML prototypes have one; PRDs, PR-FAQs and legacy JSON-spec
    prototypes are returned untouched.

    Any persisted `prototype_url` is OVERWRITTEN, never trusted. Prototypes
    generated before issue #229 stored an unsigned absolute URL, which now 403s
    against the restricted `/prototypes/*` behavior — passing it through would
    render a broken iframe. The key is derivable from the ids, so the stored
    string is not needed at all.

    Only S3-BACKED prototypes get a URL. The oldest ones stored their HTML
    inline in `content` and have no S3 object at all, so a URL for them would
    resolve to nothing; worse, the frontend prefers `prototype_url` over
    `content`, so inventing one would swap a working inline render for a broken
    iframe. Presence of `content` is the discriminator (S3-only storage stopped
    writing it), NOT `prototype_format`, which is 'html' in both cases.
    """
    if item.get('document_type') != 'prototype':
        return item
    doc_id = item.get('document_id')
    if not doc_id:
        return item
    if item.get('content'):
        # Legacy inline prototype: leave it for the frontend's `srcDoc` path.
        item.pop('prototype_url', None)
        return item
    signed = prototype_signed_url(project_id, doc_id)
    if signed:
        item['prototype_url'] = signed
    else:
        # Drop rather than leave a stale unsigned URL: the frontend treats a
        # missing prototype_url as "fall back to legacy inline content".
        item.pop('prototype_url', None)
    return item


def _query_partition_items(partition_key: str) -> list[dict]:
    """Read one complete projects-table partition, following every page."""
    return list(_paginated_items({
        'KeyConditionExpression': Key('pk').eq(partition_key),
        'ConsistentRead': True,
    }))


def _find_document(project_id: str, document_id: str) -> dict | None:
    """Find one document using projected pages and stop at the first match."""
    query = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ConsistentRead': True,
        'ProjectionExpression': (
            'pk, sk, document_id, #type, #title, base_title, #version'
        ),
        'ExpressionAttributeNames': {
            '#type': 'document_type',
            '#title': 'title',
            '#version': 'version',
        },
    }
    return next(
        (item for item in _paginated_items(query) if item.get('document_id') == document_id),
        None,
    )


def _iter_partition_keys(partition_key: str) -> Iterator[dict[str, str]]:
    """Yield only primary keys from a complete partition query."""
    query = {
        'KeyConditionExpression': Key('pk').eq(partition_key),
        'ConsistentRead': True,
        'ProjectionExpression': 'pk, sk',
    }
    for item in _paginated_items(query):
        if isinstance(item.get('pk'), str) and isinstance(item.get('sk'), str):
            yield {'pk': item['pk'], 'sk': item['sk']}


MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS = 20
MAX_CHAT_CONTEXT_ID_LENGTH = 128
DOCUMENT_DELETE_ATTEMPTS = 4
PROJECT_DELETE_FENCE_ATTEMPTS = 4
def _product_context_or_placeholder(project_id: str) -> str:
    """The project's product-context block for a prompt, or the placeholder when it cannot be built."""
    try:
        from product_context import build_product_context_block
        return build_product_context_block(project_id)
    except Exception:
        # Best effort: the prompt degrades to the placeholder, logged with its traceback.
        logger.exception("Failed to build product context")
        return "(No product context provided.)"


def _without_code_fence(text: str) -> str:
    """``text`` minus its ``` fence lines when it opens with a fence (else unchanged)."""
    if not text.startswith('```'):
        return text
    return '\n'.join(ln for ln in text.splitlines() if not ln.strip().startswith('```')).strip()


def _fenced_json(raw: str | None, failure_message: str) -> dict:
    """Parse a model's JSON object answer, tolerating ``` fences.

    `{}` (logged) when it is not JSON or not a JSON object — every caller reads
    named keys, so an array or scalar reply is as unusable as unparseable text
    (it used to reach `.get` and fail the request).
    """
    text = _without_code_fence((raw or '').strip())
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"{failure_message} raw={text[:200]}")
        return {}
    if not isinstance(parsed, dict):
        logger.warning(f"{failure_message} (not a JSON object) raw={text[:200]}")
        return {}
    return parsed


def _stored_persona(project_id: str, persona_id: str) -> dict:
    """The persona record, or a 404."""
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    return item


def _persona_note_index(persona: dict, note_id: str) -> int:
    """Position of `note_id` in the persona's research notes, or a 404."""
    for i, note in enumerate(persona.get('research_notes', [])):
        if note.get('note_id') == note_id:
            return i
    raise NotFoundError('Note not found')


_DOCUMENT_SORT_KEY_PREFIXES = (
    'PRD#',
    'PRFAQ#',
    'RESEARCH#',
    'DOC#',
    'PRODUCT_REPORT#',
    'PROTOTYPE#',
)


def _require_document(document: dict | None) -> dict:
    """The found document, or 404 when it was not found."""
    if document is None:
        raise NotFoundError('Document not found')
    return document


def _stored_document_sort_key(document: dict | None) -> str:
    """The sort key of a found document, or 404 when it was not found / 500 when the key is malformed."""
    sk = _require_document(document).get('sk')
    if (
        not isinstance(sk, str)
        or not sk.startswith(_DOCUMENT_SORT_KEY_PREFIXES)
    ):
        raise ServiceError('Stored document has an invalid sort key')
    return sk
_CHAT_CONTEXT_PROJECT_FIELDS = ('sk', 'name')
_CHAT_CONTEXT_PERSONA_FIELDS = (
    'sk',
    'persona_id',
    'name',
    'tagline',
    'quotes',
    'goals_motivations',
    'pain_points',
    'avatar_url',
)
_CHAT_CONTEXT_DOCUMENT_FIELDS = (
    'sk',
    'document_id',
    'document_type',
    'title',
    'base_title',
    'version',
)


def feedback_filters_from_body(body: dict) -> dict:
    """The feedback-selection filters a research / persona request carries.

    ``sources``/``categories``/``sentiments`` default to "all" (empty lists) and
    ``days`` is validated with a 30-day default. Routes add their own extra fields.
    """
    return {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30),
    }


@tracer.capture_method
def get_project(project_id: str, caller: Caller | None = None, *, include_personas: bool = True) -> dict:
    """Get a project with all its data.

    With ``caller`` (the HTTP route) the response carries the computed sharing
    fields and a caller without view gets the same 404 as a missing project.
    Internal callers (generation pipelines already behind the route gate) omit it
    and get META with every owner/member email removed — redaction is the
    default, so no route that forgets to pass a caller can leak a contact detail;
    emails reach only a ``can_manage`` caller.

    ``include_personas=False`` (the batch read) leaves ``personas`` out, and with
    them the avatar URL signing nobody on that page displays.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    # Read the complete partition before assigning legacy versions. A partial
    # collection can give two same-title documents the same apparent position.
    items = _query_partition_items(f'PROJECT#{project_id}')
    if not items:
        raise NotFoundError('Project not found')

    project = None  # pragma: no mutate  only ever read as a truth value; any falsy start behaves identically
    personas = []
    documents = []

    for item in items:
        sk = item.get('sk', '')  # pragma: no mutate  the default is only compared with 'META' and the document prefixes; any prefix-free default behaves identically
        if sk == 'META':
            project = item
        elif sk.startswith('PERSONA#'):
            personas.append(item)
        elif sk.startswith(_DOCUMENT_SORT_KEY_PREFIXES):
            documents.append(item)

    if not project or is_project_tombstone(project):
        raise NotFoundError('Project metadata not found')
    # Decide access BEFORE any URL signing: a refused caller must cost no
    # signing work and never have signed URLs minted on its behalf.
    if caller is None:
        project = _without_stored_emails(project)
    else:
        if not project_access.resolve_access(project, caller).can_view:
            raise NotFoundError('Project not found')
        project = _with_sharing_fields(project, caller)

    documents = [_with_signed_prototype_url(item, project_id) for item in documents]

    # Normalize copies for this response only. GET must remain read-only and
    # latency-bounded; durable legacy assignment happens on managed mutations.
    documents = normalize_document_versions(documents)

    # "Copy to Kiro" reads the prompt from here, so the constant is not duplicated
    # in the frontend bundle. COMPUTED, never stored: keep it out of every update
    # expression. A stored per-project kiro_export_prompt (pre-3.00.00, no longer
    # editable) is unused and not returned.
    project.pop('kiro_export_prompt', None)
    project['kiro_default_export_prompt'] = KIRO_DEFAULT_EXPORT_PROMPT

    if not include_personas:
        return {'project': project, 'documents': documents}
    return {
        'project': project,
        'personas': _with_signed_avatars(personas),
        'documents': documents
    }


def _with_signed_avatars(personas: list[dict]) -> list[dict]:
    """Each persona's S3 avatar URI swapped for a signed CloudFront CDN URL (in place)."""
    for persona in personas:
        if persona.get('avatar_url') and persona['avatar_url'].startswith('s3://'):
            persona['avatar_url'] = get_avatar_cdn_url(persona['avatar_url'])
    return personas


# The batch detail read (`GET /projects?ids=…`, the Prioritization board). Bounded so
# one request cannot fan out without limit: the ids are BatchGetItem'd (chunks of
# 100) and then one partition is read per VIEWABLE project.
MAX_PROJECT_DETAIL_BATCH = 200
_PROJECT_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def parse_project_detail_ids(raw: str) -> list[str]:
    """The distinct ids of ``?ids=a,b,c`` in request order, or a 400."""
    ids = list(dict.fromkeys(part.strip() for part in raw.split(',') if part.strip()))
    if not ids or len(ids) > MAX_PROJECT_DETAIL_BATCH:
        raise ValidationError(f'ids must list between 1 and {MAX_PROJECT_DETAIL_BATCH} project ids')
    if not all(_PROJECT_ID_PATTERN.fullmatch(project_id) for project_id in ids):
        raise ValidationError('ids contains an invalid project id')
    return ids


def _viewable_ids(project_ids: list[str], caller: Caller) -> set[str]:
    """Which ids name a live project ``caller`` may VIEW — decided on META alone,
    before any partition read or URL signing on the caller's behalf."""
    keys = [{'pk': f'PROJECT#{project_id}', 'sk': 'META'} for project_id in project_ids]
    metas = batch_get_all(projects_table, keys, failure=ServiceError('Failed to read projects'))
    return {
        str(meta['pk'])[len('PROJECT#'):] for meta in metas
        if isinstance(meta.get('pk'), str) and not is_project_tombstone(meta)
        and project_access.resolve_access(meta, caller).can_view
    }


def get_project_details(project_ids: list[str], caller: Caller) -> dict:
    """``{'details': [{project, documents}, …]}`` for the ids ``caller`` can view.

    Same answer per project as ``GET /projects/{id}`` minus personas. An id that is
    missing, deleted or not viewable is simply absent — the reply never says which,
    so it leaks no existence.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    viewable = _viewable_ids(project_ids, caller)
    details = []
    for project_id in (pid for pid in project_ids if pid in viewable):
        try:
            details.append(get_project(project_id, caller, include_personas=False))
        except NotFoundError:
            continue  # deleted or unshared between the two reads
    return {'details': details}


def _validated_chat_context_document_ids(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise ValidationError('selected_document_ids must be an array')
    if len(raw) > MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS:
        raise ValidationError(
            f'Select at most {MAX_CHAT_CONTEXT_SELECTED_DOCUMENTS} documents'
        )

    selected: list[str] = []
    seen: set[str] = set()
    for value in raw:
        if (
            not isinstance(value, str)
            or not value
            or value != value.strip()
            or len(value) > MAX_CHAT_CONTEXT_ID_LENGTH
        ):
            raise ValidationError(
                'Each selected document id must be a non-empty string of at most '
                f'{MAX_CHAT_CONTEXT_ID_LENGTH} characters'
            )
        if value not in seen:
            seen.add(value)
            selected.append(value)
    return selected


@tracer.capture_method
def _query_project_chat_items(project_id: str) -> list[dict]:
    # `created_at` is load-bearing for normalize_document_versions; `status`
    # preserves compatibility with status-only historical tombstones.
    query = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ConsistentRead': True,
        'ProjectionExpression': (
            'pk, sk, project_id, #name, #status, #deleting, persona_id, '
            'tagline, quotes, goals_motivations, pain_points, avatar_url, '
            'document_id, #type, #title, base_title, #version, created_at, '
            # Read for the access decision only; never copied into the summary.
            'owner_sub, owner_username, owner_email, #visibility, #members, '
            f'{project_access.CREATED_BY_AGENT_ATTRIBUTE}'
        ),
        'ExpressionAttributeNames': {
            '#name': 'name',
            '#status': 'status',
            '#deleting': PROJECT_DELETION_ATTRIBUTE,
            '#type': 'document_type',
            '#title': 'title',
            '#version': 'version',
            '#visibility': 'visibility',
            '#members': 'members',
        },
    }
    items = []
    while True:
        response = projects_table.query(**query)
        page_items = response.get('Items') if isinstance(response, dict) else None
        if isinstance(page_items, list):
            items.extend(item for item in page_items if isinstance(item, dict))
        cursor = response.get('LastEvaluatedKey') if isinstance(response, dict) else None
        if not isinstance(cursor, dict) or not cursor:
            return items
        query['ExclusiveStartKey'] = cursor


@tracer.capture_method
def get_project_chat_context(
    project_id: object, selected_document_ids: object, caller: Caller,
) -> dict:
    """Canonical project context bounded for synchronous Lambda transport.

    The top-level ``access`` tells the streaming assistant what the person it
    is acting for may do, so it never offers an edit that would be refused.
    """
    if (
        not isinstance(project_id, str)
        or not project_id
        or project_id != project_id.strip()
        or len(project_id) > MAX_CHAT_CONTEXT_ID_LENGTH
    ):
        raise ValidationError(
            f'project_id must be 1-{MAX_CHAT_CONTEXT_ID_LENGTH} characters'
        )

    selected_ids = set(
        _validated_chat_context_document_ids(selected_document_ids)
    )
    items = _query_project_chat_items(project_id)
    project = next(
        (item for item in items if item.get('sk') == 'META'),
        None,
    )
    if project is None or is_project_tombstone(project):
        raise NotFoundError('Project not found')
    access = project_access.resolve_access(project, caller)
    if not access.can_view:
        raise NotFoundError('Project not found')
    personas = [
        item for item in items
        if isinstance(item.get('sk'), str)
        and item['sk'].startswith('PERSONA#')
    ]
    documents = normalize_document_versions([
        item for item in items
        if isinstance(item.get('sk'), str)
        and item['sk'].startswith(_DOCUMENT_SORT_KEY_PREFIXES)
    ])

    project_summary = {
        field: project[field]
        for field in _CHAT_CONTEXT_PROJECT_FIELDS
        if field in project
    }
    persona_summaries = [
        {
            field: persona[field]
            for field in _CHAT_CONTEXT_PERSONA_FIELDS
            if field in persona
        }
        for persona in personas
    ]

    document_summaries = []
    for document in documents:
        summary = {
            field: document[field]
            for field in _CHAT_CONTEXT_DOCUMENT_FIELDS
            if field in document
        }
        document_id = document.get('document_id')
        document_sk = document.get('sk')
        is_prototype = (
            document.get('document_type') == 'prototype'
            or (
                isinstance(document_sk, str)
                and document_sk.startswith('PROTOTYPE#')
            )
        )
        if (
            not is_prototype
            and isinstance(document_id, str)
            and document_id in selected_ids
            and isinstance(document_sk, str)
        ):
            response = projects_table.get_item(
                Key={'pk': f'PROJECT#{project_id}', 'sk': document_sk},
                ConsistentRead=True,
                ProjectionExpression='document_id, content',
            )
            selected = response.get('Item') if isinstance(response, dict) else None
            if (
                isinstance(selected, dict)
                and selected.get('document_id') == document_id
                and isinstance(selected.get('content'), str)
            ):
                summary['content'] = selected['content']
        document_summaries.append(summary)

    return {
        'project': project_summary,
        'personas': persona_summaries,
        'documents': document_summaries,
        'access': access.to_dict(),
    }


@tracer.capture_method
def update_project(project_id: str, body: dict) -> dict:
    """Update a project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    status = body.get('status')
    if 'status' in body and (
        not isinstance(status, str) or status not in {'active', 'archived'}
    ):
        raise ValidationError('Project status must be active or archived')

    now = datetime.now(UTC).isoformat()

    update_expr = 'SET updated_at = :now'
    expr_values: dict[str, Any] = {
        **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
        ':now': now,
    }
    expr_names = dict(PROJECT_WRITABLE_ATTRIBUTE_NAMES)

    if 'name' in body:
        update_expr += ', #name = :name'
        expr_values[':name'] = _validated_name(body['name'])
        expr_names['#name'] = 'name'
    if 'description' in body:
        update_expr += ', description = :desc'
        expr_values[':desc'] = _validated_description(body['description'])
    if 'purpose' in body:
        update_expr += ', purpose = :purpose'
        expr_values[':purpose'] = _validated_purpose(body['purpose'])
    if 'status' in body:
        update_expr += ', #status = :status'
        expr_values[':status'] = status
    if 'filters' in body:
        update_expr += ', filters = :filters'
        expr_values[':filters'] = body['filters']

    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        'UpdateExpression': update_expr,
        'ConditionExpression': PROJECT_WRITABLE_CONDITION,
        'ExpressionAttributeValues': expr_values,
        'ExpressionAttributeNames': expr_names,
    }

    projects_table.update_item(**update_params)

    return {'success': True}


def _conditional_write(write: Callable[[], object]) -> bool:
    """Run one conditional DynamoDB write: True when it landed, False when its
    condition failed; any other error propagates."""
    try:
        write()
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise
        return False
    return True


@tracer.capture_method
def _start_project_deletion(
    project_id: str, meta_key: dict[str, str], now: str,
) -> None:
    """Atomically install the deletion marker before any destructive sweep.

    Marks an existing META, or — when META vanished in between — creates the
    marker row; the pair is retried while the two conditions race each other.
    """
    def mark_existing() -> object:
        return projects_table.update_item(
            Key=meta_key,
            UpdateExpression=(
                'SET #deleting = if_not_exists(#deleting, :now), '
                '#status = :deleting_status '
                'REMOVE gsi1pk, gsi1sk'
            ),
            ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
            ExpressionAttributeNames={
                '#deleting': PROJECT_DELETION_ATTRIBUTE,
                '#status': 'status',
            },
            ExpressionAttributeValues={
                ':now': now,
                ':deleting_status': 'deleting',
            },
        )

    def create_marker() -> object:
        return projects_table.put_item(
            Item={
                **meta_key,
                'project_id': project_id,
                'status': 'deleting',
                PROJECT_DELETION_ATTRIBUTE: now,
            },
            ConditionExpression=(
                'attribute_not_exists(pk) AND attribute_not_exists(sk)'
            ),
        )

    for _attempt in range(PROJECT_DELETE_FENCE_ATTEMPTS):
        if _conditional_write(mark_existing) or _conditional_write(create_marker):
            return
    raise ServiceError('Could not establish the project deletion fence. Please retry.')


#: S3's hard cap on keys per `delete_objects` request. The prefix sweeps never
#: reach it (a `list_objects_v2` page is at most 1000 keys), but the avatar sweep
#: builds its own key list and has to chunk.
S3_DELETE_BATCH_SIZE = 1000


def prototype_project_prefix(project_id: str) -> str:
    """Every prototype object one project owns, and nothing another owns.

    The trailing slash is load-bearing: `prototypes/proj_1` alone also matches
    `prototypes/proj_10/...`. Pinned to `prototype_s3_key` by a lockstep test.
    """
    return f'prototypes/{project_id}/'


def product_docs_project_prefix(project_id: str) -> str:
    """Every product-doc object (raw upload and extracted text) one project owns.

    Trailing slash for the same reason as `prototype_project_prefix`. Pinned to
    product_context / product_doc_extractor's key builders by a lockstep test.
    """
    return f'projects/{project_id}/product_docs/'


@tracer.capture_method
def _delete_project_job_rows(project_id: str) -> None:
    """Remove every job row this project owns, page by page.

    Jobs live in their OWN table, so the partition sweep never reached them: a
    deleted project's rows sat there until their TTL, and a recreated project id
    showed a stranger's job history. Absent JOBS_TABLE is logged, not fatal — the
    rest of the lifecycle still has to run.
    """
    jobs_table = get_jobs_table()
    if jobs_table is None:
        logger.warning(
            'JOBS_TABLE is not configured; project job rows were not deleted',
            extra={'project_id': project_id},
        )
        return
    query: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        'ConsistentRead': True,
        'ProjectionExpression': 'pk, sk',
    }
    with jobs_table.batch_writer() as batch:
        while True:
            response = jobs_table.query(**query)
            for item in response.get('Items') or []:
                pk, sk = item.get('pk'), item.get('sk')
                if isinstance(pk, str) and isinstance(sk, str):
                    batch.delete_item(Key={'pk': pk, 'sk': sk})
            cursor = response.get('LastEvaluatedKey')
            if not cursor:
                return
            query['ExclusiveStartKey'] = cursor


def _report_failed_deletes(response: object, project_id: str, what: str) -> None:
    """Log a partial `delete_objects` failure; never raise.

    Partial failure is normal under throttling. The durable work has committed
    and the tombstone must still be finalized; a retried delete resumes from
    whatever is still there.
    """
    errors = response.get('Errors') if isinstance(response, dict) else None
    if errors:
        logger.warning(
            f'Some {what} could not be deleted; retry the delete',
            extra={'project_id': project_id, 'failed_object_count': len(errors)},
        )


@tracer.capture_method
def _delete_objects_under_prefix(project_id: str, bucket: str, prefix: str) -> None:
    """Empty one S3 prefix a project owns, page by page.

    Lists the PREFIX rather than deriving keys from surviving rows, so an object
    whose row an earlier partial failure already removed is still found, and a
    retry resumes from what remains. Paginated (1000 keys per page = one legal
    delete batch). Callers pass a prefix ending in `/`.
    """
    client = get_s3_client()
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        keys = [key for entry in page.get('Contents') or [] if (key := entry.get('Key'))]
        if keys:
            response = client.delete_objects(
                Bucket=bucket, Delete={'Objects': [{'Key': key} for key in keys], 'Quiet': True},
            )
            _report_failed_deletes(response, project_id, f'objects under {prefix}')


def _owned_avatar_keys(client: Any, bucket: str, project_id: str, persona_ids: list[str]) -> list[str]:
    """The avatar keys of these personas whose stamped owner IS this project.

    The `avatars/` keys carry no project and persona ids are not globally unique,
    so an id alone does not say whose object it is. Both layouts are covered: the
    legacy flat `avatars/{id}.{ext}` and every image under `avatars/{id}/`. An
    object that cannot answer (absent, or written before the owner stamp) is left
    alone: the other reading of "cannot tell" is deleting a surviving project's
    avatar.
    """
    owned: list[str] = []
    foreign = 0
    for persona_id in persona_ids:
        for key in persona_avatar_keys(client, bucket, persona_id):
            owner = avatar_object_owner(client, bucket, key)
            if owner == project_id:
                owned.append(key)
            elif owner is not None:
                foreign += 1
    if foreign:
        logger.warning(
            'Some avatar objects are owned by another project and were kept',
            extra={'project_id': project_id, 'foreign_object_count': foreign},
        )
    return owned


@tracer.capture_method
def _delete_project_avatar_objects(project_id: str, bucket: str, persona_ids: list[str]) -> None:
    """Remove the avatar objects of this project's personas — only those it owns."""
    if not persona_ids:
        return
    client = get_s3_client()
    owned = _owned_avatar_keys(client, bucket, project_id, persona_ids)
    for start in range(0, len(owned), S3_DELETE_BATCH_SIZE):
        response = client.delete_objects(
            Bucket=bucket,
            Delete={
                'Objects': [{'Key': key} for key in owned[start:start + S3_DELETE_BATCH_SIZE]],
                'Quiet': True,
            },
        )
        _report_failed_deletes(response, project_id, 'persona avatars')


def _persona_id_from_sort_key(sk: str) -> str | None:
    """The persona id an exact `PERSONA#{id}` sort key names, else None.

    Exact shape rather than a bare prefix strip, so a future `PERSONA#{id}#...`
    sub-row cannot yield a bogus id that buys HEADs for keys that cannot exist.
    """
    persona_id = sk.removeprefix('PERSONA#')
    if persona_id == sk or not persona_id or '#' in persona_id:
        return None
    return persona_id


def _sweep_project_objects(project_id: str, persona_ids: list[str]) -> None:
    """Every S3 object the project owns: prototypes, product docs, its own avatars.

    The raw-data bucket has no lifecycle expiration, so an object missed here is
    billed forever and stays reachable through any signed URL until it expires.
    Ported from PR #407 (perrozzi).
    """
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    if not bucket:
        logger.warning(
            'RAW_DATA_BUCKET is not configured; project objects were not deleted',
            extra={'project_id': project_id},
        )
        return
    _delete_objects_under_prefix(project_id, bucket, prototype_project_prefix(project_id))
    _delete_objects_under_prefix(project_id, bucket, product_docs_project_prefix(project_id))
    _delete_project_avatar_objects(project_id, bucket, persona_ids)


@tracer.capture_method
def delete_project(project_id: str) -> dict:
    """Retain a tombstone while deleting every project-owned artifact.

    The project partition, the version partition, the job rows in their own
    table, and the project's S3 objects (prototypes, product docs, and the
    avatars it owns). The fence goes down first; every sweep then deletes only
    what it still finds, so a retry resumes after a partial failure.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    project_key = f'PROJECT#{project_id}'
    meta_key = project_meta_key(project_id)
    now = datetime.now(UTC).isoformat()
    _start_project_deletion(project_id, meta_key, now)

    # Keep tombstoned META forever. Guarded writers either committed before the
    # fence (and are visible to these strongly consistent scans) or fail after
    # it; retries repeat both idempotent sweeps. Avatar keys carry no project, so
    # their persona ids are collected from this pass — the only one that sees them.
    persona_ids: list[str] = []
    with projects_table.batch_writer() as batch:
        for key in _iter_partition_keys(project_key):
            if key == meta_key:
                continue
            persona_id = _persona_id_from_sort_key(key['sk'])
            if persona_id is not None:
                persona_ids.append(persona_id)
            batch.delete_item(Key=key)

    with projects_table.batch_writer() as batch:
        for key in _iter_partition_keys(version_partition_key(project_id)):
            batch.delete_item(Key=key)

    _delete_project_job_rows(project_id)
    _sweep_project_objects(project_id, persona_ids)

    projects_table.update_item(
        Key=meta_key,
        UpdateExpression=(
            'SET #status = :deleted, deleted_at = if_not_exists(deleted_at, :now)'
        ),
        ConditionExpression='attribute_exists(#deleting)',
        ExpressionAttributeNames={
            '#deleting': PROJECT_DELETION_ATTRIBUTE,
            '#status': 'status',
        },
        ExpressionAttributeValues={
            ':deleted': 'deleted',
            ':now': now,
        },
    )

    return {'success': True}



def _is_oversized_input_error(exc: Exception) -> bool:
    """True when a Bedrock failure looks like "the prompt was too long".

    Bedrock signals this as a ValidationException whose message mentions the
    input length or the token limit. Matched on the message because there is no
    distinct error code for it, and kept deliberately narrow so an unrelated
    ValidationException still gets the generic message.
    """
    if not isinstance(exc, ClientError):
        return False
    error = exc.response.get('Error', {})
    if error.get('Code') != 'ValidationException':
        return False
    message = str(error.get('Message', '')).lower()  # pragma: no mutate  the default is only searched for the phrases below; any phrase-free default behaves identically
    return any(
        phrase in message
        for phrase in ('too long', 'too many tokens', 'input is too', 'context window',
                       'maximum context', 'exceeds the maximum')
    )


PersonaProgress = Callable[[int, str], None]


@dataclass(frozen=True)
class _PersonaCorpus:
    """The feedback one persona generation reads, and the caps that shaped it."""

    items: list[dict]
    context: str
    stats: str
    context_budget: int
    fetch_limit: int
    fetch_limit_reached: bool
    corpus_chars: int
    char_cap_applied: bool


def _persona_progress_reporter(progress_callback: Callable[[int, str], object] | None) -> PersonaProgress:
    """A progress hook that logs each update; a failing callback never breaks generation."""
    def update_progress(progress: int, step: str) -> None:
        """Update progress if callback provided."""
        logger.info(f"[PERSONA] Progress update: {progress}% - step: {step}")
        if progress_callback:
            try:
                progress_callback(progress, step)
                logger.info("[PERSONA] Progress callback succeeded")
            except Exception:
                logger.exception("[PERSONA] Progress callback failed")

    return update_progress


def _fetch_persona_feedback(filters: dict, fetch_limit: int) -> list[dict]:
    """The feedback matching ``filters`` (at most ``fetch_limit``); 400 when there is none."""
    try:
        feedback_items = get_feedback_context(filters, limit=fetch_limit)
    except Exception:
        logger.exception("[PERSONA] Failed to fetch feedback")
        raise
    logger.info(f"[PERSONA] Fetched {len(feedback_items) if feedback_items else 0} feedback items")
    if not feedback_items:
        logger.warning("[PERSONA] No feedback data found for filters")
        raise ValidationError(PERSONA_NO_FEEDBACK_MESSAGE)
    return feedback_items


PERSONA_NO_FEEDBACK_MESSAGE = 'No feedback data found for the given filters'

# One item answers "is there any?": the walk stops at the first match, so the
# pre-check costs one bounded per-day Query walk, never a scan.
FEEDBACK_EXISTS_PROBE_LIMIT = 1


def ensure_persona_feedback(filters: dict) -> None:
    """Synchronous pre-check for ``POST /projects/{id}/personas/generate`` (F1).

    The SAME read the persona job makes (``_fetch_persona_feedback`` with the
    job's own filters, including the caller's category scope), capped at one
    item, so the route answers 400 with the job's own message before a job row
    exists or the generator is invoked. The job keeps its check: feedback can
    vanish between the two reads, and a replayed invoke never passes here.
    """
    _fetch_persona_feedback(filters, FEEDBACK_EXISTS_PROBE_LIMIT)


RESEARCH_NO_FEEDBACK_MESSAGE = (
    'No feedback data found matching the filters. Try adjusting your filter criteria.'
)


def ensure_research_feedback(research_config: dict) -> None:
    """Synchronous pre-check for ``POST /projects/{id}/research`` (F1).

    Reads with exactly the filters the Step Functions research step builds from
    the same config (``research/research_step_handler.py``: sources, categories,
    sentiments, days, date_basis and the captured category scope), capped at one
    item. That step fails the whole execution on an empty read, so the route
    answers 400 first with the message the synchronous fallback already uses.
    """
    filters = {
        'sources': research_config.get('sources', []),
        'categories': research_config.get('categories', []),
        'sentiments': research_config.get('sentiments', []),
        'days': research_config.get('days', 30),
        'date_basis': validate_date_basis(research_config.get('date_basis')),
        category_access.SCOPE_CONFIG_KEY: research_config.get(category_access.SCOPE_CONFIG_KEY),
    }
    if not get_feedback_context(filters, limit=FEEDBACK_EXISTS_PROBE_LIMIT):
        logger.warning("[RESEARCH] No feedback data found for filters")
        raise ValidationError(RESEARCH_NO_FEEDBACK_MESSAGE)


def _format_persona_feedback(feedback_items: list[dict]) -> tuple[str, str]:
    """(LLM-formatted feedback context, statistics block) for the persona prompts."""
    try:
        feedback_context = format_feedback_for_llm(feedback_items)
        feedback_stats = get_feedback_statistics(feedback_items)
    except Exception:
        logger.exception("[PERSONA] Failed to format feedback")
        raise
    logger.info(f"[PERSONA] Formatted context: {len(feedback_context)} chars")
    logger.info(f"[PERSONA] Stats: {feedback_stats}")
    return feedback_context, feedback_stats


def _load_persona_corpus(filters: dict, update_progress: PersonaProgress) -> _PersonaCorpus:
    """Steps 1-2: fetch the feedback, format it, and trim it to the model's budget."""
    logger.info("[PERSONA] Step 1/6: Fetching feedback data...")
    update_progress(5, 'fetching_feedback')

    # Resolve the character budget and the fetch limit TOGETHER, before the
    # fetch, so both follow the model actually resolved for this surface. Sizing
    # the fetch from the import-time default and then trimming to a narrower
    # runtime budget is how the two drift back apart.
    context_budget, fetch_limit = persona_context_budget()
    logger.info(
        f"[PERSONA] Context budget: {context_budget} chars, fetch limit: {fetch_limit} items"
    )

    feedback_items = _fetch_persona_feedback(filters, fetch_limit)

    logger.info("[PERSONA] Step 2/6: Formatting feedback data for LLM...")
    update_progress(10, 'formatting_data')
    feedback_context, feedback_stats = _format_persona_feedback(feedback_items)

    # The fetch limit is a cap in its own right, and the one that bounds a large
    # project: filters matching thousands of records yield exactly fetch_limit of
    # them, with the rest never read. That loss is invisible to the truncation
    # signal below (which compares what reached the model against what was
    # FETCHED), so report it separately rather than letting "N of N items" imply
    # N was the whole corpus.
    fetch_limit_reached = len(feedback_items) >= fetch_limit
    if fetch_limit_reached:
        logger.warning(
            "[PERSONA] Fetch limit reached — more feedback may match the filters "
            "than one generation reads",
            extra={'fetch_limit': fetch_limit, 'items_fetched': len(feedback_items)},
        )

    # Trim on a record boundary so the model never receives half a review, and
    # so the survivors can be counted rather than estimated.
    corpus_chars = len(feedback_context)
    feedback_context, _, char_cap_applied = truncate_feedback_context(
        feedback_context, context_budget
    )
    if char_cap_applied:
        logger.warning(
            "[PERSONA] Corpus exceeded the input budget and was trimmed",
            extra={
                'max_chars': context_budget,
                'actual_chars': corpus_chars,
                'items_fetched': len(feedback_items),
            },
        )
    return _PersonaCorpus(
        items=feedback_items, context=feedback_context, stats=feedback_stats,
        context_budget=context_budget, fetch_limit=fetch_limit,
        fetch_limit_reached=fetch_limit_reached, corpus_chars=corpus_chars,
        char_cap_applied=char_cap_applied,
    )


def _build_persona_chain(
    corpus: _PersonaCorpus, filters: dict, persona_count: int, avoid_names: list[str],
) -> list[dict]:
    """Step 3: the chain steps, built from the external prompt files.

    ``avoid_names`` (the project's current persona names) is appended to the
    synthesis step, so a regeneration does not hand back the same names (#240).
    """
    try:
        chain_steps = get_persona_generation_steps(
            persona_count=persona_count,
            feedback_stats=corpus.stats,
            feedback_context=corpus.context,
            custom_instructions=filters.get('custom_instructions', ''),
            response_language=filters.get('response_language'),
            sample_chars=corpus.context_budget,
        )
    except Exception:
        logger.exception("[PERSONA] Failed to build chain steps")
        raise
    logger.info(f"[PERSONA] Built {len(chain_steps)} chain steps")
    section = _avoid_names_section(avoid_names)
    return [
        {**step, 'user': step.get('user', '') + section}
        if section and step.get('step_name') == PERSONA_SYNTHESIS_STEP else step
        for step in chain_steps
    ]


# Bounds on the names-to-avoid list (#240): the newest names only, each cut to a
# plausible name length, so a project regenerated many times cannot grow the
# synthesis prompt without limit.
MAX_AVOID_PERSONA_NAMES = 30
MAX_AVOID_NAME_CHARS = 60


def _existing_persona_names(project_id: str) -> list[str]:
    """The project's current persona names, newest last, de-duplicated and bounded.

    Read BEFORE generation clears them (replace semantics), which is the only
    moment they exist. Best effort: a failed read just means no avoid list.
    """
    try:
        items = projects_table.query(
            KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
            & Key('sk').begins_with('PERSONA#'),
            ProjectionExpression='#name',
            ExpressionAttributeNames={'#name': 'name'},
        ).get('Items', [])
    except Exception:
        logger.exception("[PERSONA] Could not read existing persona names (continuing)")
        return []
    unique: dict[str, None] = {}
    for item in items:
        name = _one_line_name(item.get('name'))
        if name:
            unique[name] = None  # pragma: no mutate  the dict is an ordered set; its values are never read
    return list(unique)[-MAX_AVOID_PERSONA_NAMES:]


def _one_line_name(value: object) -> str:
    """A stored persona name as one bounded line ('' for a non-string)."""
    if not isinstance(value, str):
        return ''
    return ' '.join(value.split())[:MAX_AVOID_NAME_CHARS]


def _avoid_names_section(names: list[str]) -> str:
    """The synthesis-prompt block listing names not to reuse ('' when none).

    Rendered as a JSON list with any DATA-block tag defanged: names are
    user-editable, so they are quoted data, never free prompt text.
    """
    if not names:
        return ''
    listed = neutralise_tags(json.dumps(names, ensure_ascii=False))
    return (
        '\n\n## NAMES ALREADY USED IN THIS PROJECT\n'
        'These personas exist from an earlier generation. Give every new persona a '
        'different full name, and do not reuse any of these first names or surnames:\n'
        f'{listed}\n'
    )


def _items_reaching_synthesis(chain_steps: list[dict], corpus: _PersonaCorpus) -> tuple[int, bool]:
    """(items the persona-writing step sees, whether that is fewer than were fetched).

    Counted off the built prompt. Every cap between DynamoDB and the model is
    baked into this number — the fetch limit, the budget, and the
    {feedback_sample} slot the synthesis step reads. Reporting the fetched count
    instead would claim a full corpus while a narrower downstream cap had quietly
    discarded most of it, which is the exact blindness #231 is about.
    """
    feedback_items_used = count_persona_sample_records(chain_steps)
    context_truncated = feedback_items_used < len(corpus.items)
    if context_truncated:
        logger.warning(
            "[PERSONA] Personas synthesised from fewer items than were fetched",
            extra={
                'items_fetched': len(corpus.items),
                'items_used': feedback_items_used,
                'corpus_chars': corpus.corpus_chars,
                'budget_chars': corpus.context_budget,
                'char_cap_applied': corpus.char_cap_applied,
            },
        )
    return feedback_items_used, context_truncated


def _run_persona_chain(chain_steps: list[dict], update_progress: PersonaProgress) -> list[ConverseResult]:
    """Step 4: execute the chain (several minutes), forwarding its progress.

    Detailed results, not texts: each carries the model its step ran on, which
    the provenance stamp reads from the synthesis step (see _persona_model_id).
    """
    try:
        results = converse_chain_detailed(chain_steps, progress_callback=update_progress, surface=PERSONA_SURFACE)
    except Exception:
        logger.exception("[PERSONA] LLM chain execution failed")
        raise
    logger.info(f"[PERSONA] LLM chain returned {len(results)} results")
    return results


def _persona_model_id(synthesis: ConverseResult) -> str:
    """The model the persona-synthesis step reported running on.

    Re-resolving the picker after the chain is wrong: it caches per container
    (~60 s), so an admin switching the AI model during a multi-minute run would
    make the stamp name a model that never wrote these personas. The picker is
    consulted only when the result carries no model (a stand-in that does not
    report one); converse_detailed always sets it.
    """
    return synthesis.model_id or get_active_model_id(PERSONA_SURFACE)


def _persona_synthesis_result(chain_steps: list[dict], results: list[ConverseResult]) -> ConverseResult:
    """The persona-synthesis step's output, located BY STEP NAME.

    Indexing positionally (results[-1]) was correct only while
    get_persona_generation_steps happens to end on persona_synthesis: that
    invariant lives in another file, and appending any trailing step there — a
    re-added validation pass, a translation step — would silently make this parse
    the wrong text and surface as the generic "failed to parse" error.

    Chain ordering still matters for a different reason, recorded in
    get_persona_generation_steps: the chain keeps its results list local and
    re-raises, so any step AFTER the one whose output is saved is a window where
    finished, already-billed personas get discarded. Reading by name does not
    weaken that — it just stops this line depending on it silently.
    """
    step_names = [step.get('step_name') for step in chain_steps]
    if PERSONA_SYNTHESIS_STEP not in step_names:
        raise ServiceError(
            f"persona chain has no '{PERSONA_SYNTHESIS_STEP}' step "
            f"(built: {step_names}) — cannot locate the persona JSON"
        )
    synthesis_index = step_names.index(PERSONA_SYNTHESIS_STEP)
    if synthesis_index >= len(results):
        raise ServiceError(
            f"persona chain returned {len(results)} result(s) but "
            f"'{PERSONA_SYNTHESIS_STEP}' is step {synthesis_index + 1}"
        )
    synthesis = results[synthesis_index]
    logger.info(
        f"[PERSONA] Parsing '{PERSONA_SYNTHESIS_STEP}' output "
        f"(step {synthesis_index + 1}/{len(step_names)}), length: {len(synthesis.text)} chars"
    )
    return synthesis


@dataclass(frozen=True)
class _ParsedPersonas:
    """The personas recovered from the synthesis output, and how they were found.

    ``tier`` names the parse that succeeded (strict, fenced, array, salvage);
    ``dropped`` counts top-level persona objects the salvage tier saw but could
    not decode (a trailing comma, an unterminated string, a truncated final
    object). Zero on every tier but salvage.
    """

    personas: list[dict]
    tier: str
    dropped: int = 0


_FENCED_BLOCK = re.compile(r'```(?:json)?\s*(.*?)```', re.DOTALL | re.IGNORECASE)
_ARRAY_OF_OBJECTS_START = re.compile(r'\[\s*\{')


def _persona_list(text: str) -> list[dict] | None:
    """``text`` as a JSON array of persona objects, or None if it is not one."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    personas = [entry for entry in parsed if isinstance(entry, dict)]
    return personas or None


@dataclass
class _TopLevelScan:
    """Where a JSON array's closing bracket and its top-level objects are.

    ``objects`` holds (start, end) per object directly inside the array; ``end``
    is None for an object the text ends inside (a truncated generation).
    """

    array_end: int | None = None
    objects: list[tuple[int, int | None]] = dataclass_field(default_factory=list)


def _scan_array(text: str, start: int) -> _TopLevelScan:
    """Bracket-match the array opening at ``text[start]``, string-aware.

    One pass that tracks string/escape state so a bracket inside a quote never
    counts, which is what a greedy regex cannot do.
    """
    scan = _TopLevelScan()
    depth = 0
    in_string = False  # pragma: no mutate  only ever read as a truth value; None behaves identically
    escaped = False  # pragma: no mutate  as above
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False  # pragma: no mutate  as above
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False  # pragma: no mutate  as above
            continue
        if char == '"':
            in_string = True
        elif char in '[{':
            depth += 1
            if char == '{' and depth == 2:
                scan.objects.append((index, None))
        elif char in ']}':
            depth -= 1
            if char == '}' and depth == 1 and scan.objects:
                scan.objects[-1] = (scan.objects[-1][0], index)
            if depth == 0:
                scan.array_end = index
                return scan
    return scan


def _salvage_objects(text: str, scan: _TopLevelScan) -> _ParsedPersonas | None:
    """Decode each top-level object on its own; keep the ones that parse."""
    personas: list[dict] = []
    for start, end in scan.objects:
        if end is None:
            continue
        try:
            candidate = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            personas.append(candidate)
    if not personas:
        return None
    return _ParsedPersonas(personas, 'salvage', dropped=len(scan.objects) - len(personas))


def _parse_persona_tiers(text: str) -> _ParsedPersonas | None:
    """Strict JSON → fenced block → first balanced array → per-object salvage (#235).

    Each tier is tried only when the previous one found nothing, so a clean
    response is never second-guessed and one malformed persona no longer
    discards the rest of a multi-minute, already-billed generation.
    """
    strict = _persona_list(text.strip())
    if strict:
        return _ParsedPersonas(strict, 'strict')
    for block in _FENCED_BLOCK.findall(text):
        fenced = _persona_list(block.strip())
        if fenced:
            return _ParsedPersonas(fenced, 'fenced')
    opening = _ARRAY_OF_OBJECTS_START.search(text)
    if opening is None:
        return None
    scan = _scan_array(text, opening.start())
    if scan.array_end is not None:
        balanced = _persona_list(text[opening.start():scan.array_end + 1])
        if balanced:
            return _ParsedPersonas(balanced, 'array')
    return _salvage_objects(text, scan)


def _parse_personas(synthesis_text: str) -> _ParsedPersonas:
    """The persona objects in the synthesis output; ServiceError only when none survive."""
    parsed = _parse_persona_tiers(synthesis_text)
    if parsed is None:
        logger.error("[PERSONA] No persona could be parsed from the persona_synthesis output")
        raise ServiceError('Failed to parse persona data from LLM response')
    logger.info(
        f"[PERSONA] Parsed {len(parsed.personas)} persona(s) via the '{parsed.tier}' tier",
        extra={'parse_tier': parsed.tier, 'personas_dropped': parsed.dropped},
    )
    if parsed.dropped:
        metrics.add_metric(name='PersonasDroppedAtParse', unit='Count', value=parsed.dropped)
        logger.warning(
            f"[PERSONA] {parsed.dropped} malformed persona(s) dropped; keeping the "
            f"{len(parsed.personas)} that parsed"
        )
    return parsed


def _persona_ids_of(keys: list[dict]) -> list[str]:
    """Persona ids named by `PERSONA#{id}` sort keys (other shapes skipped)."""
    ids = (_persona_id_from_sort_key(str(key.get('sk', ''))) for key in keys)
    return [persona_id for persona_id in ids if persona_id is not None]


def _sweep_removed_persona_avatars(project_id: str, persona_ids: list[str]) -> None:
    """Best effort: delete the avatar objects of personas whose rows were just removed.

    Without this a persona removed by regeneration or by delete_persona leaves its
    avatar in the raw-data bucket for good: the project delete sweep finds avatar
    keys only through the PERSONA# rows that still exist, and the bucket has no
    lifecycle expiration. Only objects stamped with this project are touched
    (``_owned_avatar_keys``). A failure is logged, never raised: the row deletion
    it follows has already succeeded.
    """
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    if not bucket or not persona_ids:
        return
    try:
        _delete_project_avatar_objects(project_id, bucket, persona_ids)
    except Exception:
        logger.exception(
            '[PERSONA] Failed to delete the avatars of removed personas (continuing)',
            extra={'project_id': project_id, 'persona_count': len(persona_ids)},
        )


def _clear_existing_personas(project_id: str) -> None:
    """Replace semantics: delete the project's existing personas before saving new ones.

    Re-running generation must not accumulate duplicates (e.g. "김지수" x2): each
    generation used to append a fresh set, and @all roundtable chat would have the
    same persona answer multiple times. Best effort — a failure is logged and the
    generation continues. The removed personas' avatar objects go with them.
    """
    try:
        existing = projects_table.query(
            KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
            & Key('sk').begins_with('PERSONA#'),
            ProjectionExpression='pk, sk',
        ).get('Items', [])
        if existing:
            with projects_table.batch_writer() as batch:
                for it in existing:
                    batch.delete_item(Key={'pk': it['pk'], 'sk': it['sk']})
            logger.info(f"[PERSONA] Cleared {len(existing)} existing persona(s) before regeneration")
            _sweep_removed_persona_avatars(project_id, _persona_ids_of(existing))
    except Exception:
        logger.exception("[PERSONA] Failed to clear existing personas (continuing)")


def _source_breakdown(feedback_items: list[dict]) -> dict[str, int]:
    """How many of the feedback items came from each source platform."""
    breakdown: dict[str, int] = {}
    for item in feedback_items:
        src = item.get('source_platform', 'unknown')
        breakdown[src] = breakdown.get(src, 0) + 1
    return breakdown


def _build_persona_items(
    project_id: str, personas_data: list, feedback_items: list[dict], *,
    persona_count: int, source_breakdown: dict[str, int], llm_time: int, now_dt: datetime,
    model_id: str, date_basis: str,
) -> list[tuple[str, dict, dict]]:
    """``(persona_id, parsed persona, item to store)`` per persona, in parsed order.

    One tz-aware reading drives BOTH the stored timestamps and the id stamp, so a
    persona id can never disagree with its own created_at about which day it is.
    The id stamp previously came from a naive datetime.now() (container-local)
    while created_at was UTC — and the id names the S3 avatar key and sorts, so
    the skew was user-visible.

    One id stamp for the whole batch: the per-persona index already makes each id
    unique within it, and a random batch suffix (shared/ids.py) keeps two batches
    started in the same second apart. The avatar seed is derived from the id, so a
    stable id keeps the same persona reproducing the same image. No collision
    retry here: the avatar's S3 key is the id, minted before the write. Avatars are
    attached afterwards (concurrently) and the writes then follow this same order,
    so which avatar call finishes first cannot reorder the personas.
    """
    now = now_dt.isoformat()
    batch_id = timestamped_id('persona', now_dt)
    persona_items = []
    for i, persona in enumerate(personas_data):
        persona_id = f"{batch_id}_{i}"

        # Build the full persona item with all 8 sections
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PERSONA#{persona_id}',
            'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
            'gsi1sk': now,
            'persona_id': persona_id,
            'name': fix_persona_name(persona.get('name', f'Persona {i+1}')),
            'tagline': persona.get('tagline', ''),
            'confidence': persona.get('confidence', 'medium'),
            'feedback_count': persona.get('feedback_count', len(feedback_items) // persona_count),
            'identity': persona.get('identity', {}),
            'goals_motivations': persona.get('goals_motivations', {}),
            'pain_points': persona.get('pain_points', {}),
            'behaviors': persona.get('behaviors', {}),
            'context_environment': persona.get('context_environment', {}),
            'quotes': persona.get('quotes', []),
            'scenario': persona.get('scenario', {}),
            'research_notes': [],
            'supporting_evidence': persona.get('supporting_evidence', []),
            'source_breakdown': source_breakdown,
            'source_feedback_ids': [item.get('feedback_id', '') for item in feedback_items[:20]],
            # Which dates the corpus window applied to, so two generations of one
            # project that differ only by basis can be told apart (#258).
            'date_basis': date_basis,
            'avatar_url': None,
            'avatar_prompt': None,
            'created_at': now,
            'updated_at': now,
            'llm_metadata': {
                'model': model_id,
                'prompt_version': PERSONA_PROMPT_VERSION,
                'generation_time_ms': llm_time
            },
        }

        persona_items.append((persona_id, persona, item))
    return persona_items


def _avatar_for(project_id: str, persona_id: str, persona: dict) -> dict:
    return generate_persona_avatar({'persona_id': persona_id, **persona}, project_id=project_id)


def _count_avatar_failure(persona_id: str, reason: str) -> None:
    """Record one persona ending up without an avatar.

    One place so the metric can't be emitted from some paths and not others —
    a partially-instrumented counter is worse than none, because it reads as
    a healthy number during a real outage. The persona is still saved; only
    its avatar is missing, which is why this warns rather than raising.

    These counters do reach CloudWatch: `generate_personas` has exactly one
    production caller, jobs/persona_generator/handler.py, whose lambda_handler
    carries @metrics.log_metrics and imports this same shared `metrics`
    singleton, so the store is flushed when that handler returns. The namespace
    comes from Metrics(namespace="VoC") in shared/logging.py, not from a
    per-function POWERTOOLS_METRICS_NAMESPACE. Called on the main thread only
    (the result loop), so no cross-thread store access.
    """
    metrics.add_metric(name='AvatarGenerationFailed', unit='Count', value=1)
    logger.warning(
        f"[PERSONA] No avatar for {persona_id} "
        f"(saving persona without one): {reason}"
    )


def _record_avatar(item: dict, avatar_result: dict) -> None:
    """Attach one avatar result to its persona item and count the outcome.

    Count the EFFECTIVE outcome, not just the exception. Most failures never
    raise: shared.avatar.generate_persona_avatar catches throttling,
    AccessDenied, ValidationException and the empty-images case itself and
    RETURNS avatar_url=None. A counter placed only in the except branch would
    therefore read zero during exactly the outage it exists to catch.
    """
    item['avatar_url'] = avatar_result.get('avatar_url')
    item['avatar_prompt'] = avatar_result.get('avatar_prompt')
    if item['avatar_url']:
        metrics.add_metric(name='AvatarGenerationSucceeded', unit='Count', value=1)
        logger.info(
            f"[PERSONA] Avatar generated for {item['persona_id']}: {item['avatar_url']}"
        )
    else:
        _count_avatar_failure(
            item['persona_id'], 'the generator returned no avatar URL'
        )


def _attach_avatars(
    project_id: str, persona_items: list[tuple[str, dict, dict]], update_progress: PersonaProgress,
) -> None:
    """Generate every persona's avatar concurrently, attaching each to its item.

    One unit of work per persona. Each call is ~5s of waiting on Bedrock (prompt
    writer + image model) and they don't touch each other, so a sequential loop
    just added 5s per persona — up to 50s at the 10-persona ceiling
    validate_persona_count allows. Failure stays isolated per persona: a persona
    whose avatar call raises is still saved, with avatar_url/avatar_prompt None.

    On tracing across the fan-out: `generate_persona_avatar` and its Bedrock legs
    are @tracer-decorated, and under a Lambda context aws-xray-sdk's
    put_subsegment re-resolves the segment per thread from _X_AMZN_TRACE_ID, so
    worker subsegments should attach to the invocation with the right trace and
    parent ids. A reviewer confirmed that empirically across three threads; it is
    not pinned by a test here, because a test would be asserting aws-xray-sdk's
    own context behaviour rather than anything this repo controls. If the avatar
    leg ever goes missing from X-Ray after an sdk upgrade, this is the reason to
    check first. Recorded because "subsegments on non-main threads are dropped"
    is true of some X-Ray setups and has been raised against this block
    repeatedly.
    """
    logger.info(f"[PERSONA] Generating {len(persona_items)} avatar(s) concurrently...")
    # One step for the whole batch, replacing the per-persona
    # 'generating_avatar_{i}' steps — they were sequential progress and the work
    # no longer is. No locale keys to add: the jobs panel renders the raw step
    # with `current_step.replaceAll('_', ' ')` (JobsSection.tsx) rather than
    # keying translations off it, so step names are not part of the i18n surface.
    update_progress(85, 'generating_avatars')

    with ThreadPoolExecutor(max_workers=min(len(persona_items), AVATAR_MAX_CONCURRENCY)) as pool:
        # Submitted in a guarded loop rather than a dict comprehension: a
        # comprehension puts pool.submit outside the per-future try, so a
        # RuntimeError("can't start new thread") would propagate and discard
        # EVERY persona — the same "billed work thrown away" shape this change
        # set out to remove, just relocated from the chain to the executor.
        futures = {}
        for persona_id, persona, item in persona_items:
            try:
                futures[pool.submit(_avatar_for, project_id, persona_id, persona)] = item
            except RuntimeError as e:
                _count_avatar_failure(item['persona_id'], f'could not start a worker: {e}')

        for future, item in futures.items():
            try:
                _record_avatar(item, future.result())
            except Exception as e:
                # Unexpected (the generator handles its known failures itself):
                # keep the traceback, and still save the persona without an avatar.
                logger.exception(f"[PERSONA] Avatar worker for {item['persona_id']} raised")
                _count_avatar_failure(item['persona_id'], str(e))


def _save_personas(project_id: str, persona_items: list[tuple[str, dict, dict]], now: str) -> list[dict]:
    """Write the personas and set the project's persona count; the saved items.

    Written in parsed order so the stored order and the response order match the
    LLM's order regardless of avatar completion order.
    """
    saved_personas = []
    for i, (_persona_id, persona, item) in enumerate(persona_items):
        logger.info(f"[PERSONA] Saving persona {i+1}/{len(persona_items)}: {persona.get('name', 'unnamed')}")
        put_project_item(projects_table, project_id, item)
        saved_personas.append(item)
        logger.info(f"[PERSONA] Saved persona: {persona.get('name')}")

    # Set persona count to the new total (the old set was cleared first, so
    # this is a replace, not an increment — keeps the count accurate).
    projects_table.update_item(
        Key=project_meta_key(project_id),
        UpdateExpression='SET persona_count = :count, updated_at = :now',
        ConditionExpression=PROJECT_WRITABLE_CONDITION,
        ExpressionAttributeNames=dict(
            PROJECT_WRITABLE_ATTRIBUTE_NAMES,
        ),
        ExpressionAttributeValues={
            **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
            ':count': len(saved_personas),
            ':now': now,
        },
    )
    return saved_personas


@tracer.capture_method
def generate_personas(
    project_id: str, filters: dict, progress_callback: Callable[[int, str], object] | None = None,
) -> dict:
    """Generate full UX research personas from feedback data using multi-step LLM chain.

    Creates comprehensive personas with 8 sections:
    1. Identity & Demographics
    2. Goals & Motivations
    3. Pain Points & Frustrations
    4. Behaviors & Habits
    5. Context & Environment
    6. Representative Quotes
    7. Scenario/User Story
    8. Research Notes (empty, for user to fill)
    """
    import time

    logger.info("[PERSONA] ========== STARTING PERSONA GENERATION ==========")
    logger.info(f"[PERSONA] Project: {project_id}")
    logger.info(f"[PERSONA] Filters: {filters}")
    overall_start = time.time()
    update_progress = _persona_progress_reporter(progress_callback)

    if not projects_table:
        logger.error("[PERSONA] Projects table not configured")
        raise ConfigurationError('Projects table not configured')

    # Extract filter parameters
    persona_count = filters.get('persona_count', 3)
    generate_avatars = filters.get('generate_avatars', True)
    logger.info(f"[PERSONA] Config: persona_count={persona_count}, generate_avatars={generate_avatars}")

    corpus = _load_persona_corpus(filters, update_progress)
    feedback_items = corpus.items

    try:
        llm_start_time = time.time()

        logger.info("[PERSONA] Step 3/6: Building LLM chain steps from prompts...")
        update_progress(15, 'building_prompts')
        chain_steps = _build_persona_chain(
            corpus, filters, persona_count, _existing_persona_names(project_id),
        )
        feedback_items_used, context_truncated = _items_reaching_synthesis(chain_steps, corpus)

        logger.info("[PERSONA] Step 4/6: Executing LLM chain (this may take several minutes)...")
        update_progress(20, 'executing_llm_chain')
        results = _run_persona_chain(chain_steps, update_progress)

        llm_time = int((time.time() - llm_start_time) * 1000)
        synthesis = _persona_synthesis_result(chain_steps, results)
        model_id = _persona_model_id(synthesis)
        logger.info(f"[PERSONA] LLM chain completed in {llm_time}ms on {model_id}")

        logger.info("[PERSONA] Step 5/6: Parsing personas from LLM output...")
        parsed = _parse_personas(synthesis.text)

        logger.info("[PERSONA] Step 6/6: Saving personas to database...")
        update_progress(80, 'saving_personas')
        _clear_existing_personas(project_id)

        source_breakdown = _source_breakdown(feedback_items)

        # One tz-aware reading drives BOTH the stored timestamps and the id stamp
        # (see _build_persona_items).
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat()
        persona_items = _build_persona_items(
            project_id, parsed.personas, feedback_items,
            persona_count=persona_count, source_breakdown=source_breakdown,
            llm_time=llm_time, now_dt=now_dt, model_id=model_id,
            date_basis=validate_date_basis(filters.get('date_basis')),
        )

        if generate_avatars and persona_items:
            _attach_avatars(project_id, persona_items, update_progress)

        saved_personas = _save_personas(project_id, persona_items, now)
        overall_elapsed = time.time() - overall_start
        logger.info("[PERSONA] ========== PERSONA GENERATION COMPLETE ==========")
        logger.info(f"[PERSONA] Total time: {overall_elapsed:.2f}s, Personas created: {len(saved_personas)}")

    except Exception as e:
        raise _persona_generation_failure(e, corpus, time.time() - overall_start) from e

    return {
        'success': True,
        'personas': saved_personas,
        # No 'validation' key: the chain's third step is gone (it was the
        # single largest cost in the job and nothing read its output — this
        # response shape's only consumer, the jobs panel, reads persona_id,
        # document_id and title).
        'analysis': {
            'research': results[0].text,
        },
        'metadata': {
            # Items FETCHED from DynamoDB. Kept because the frontend and
            # older job records already read it; prefer feedback_items_used
            # for "what the personas are actually based on".
            'feedback_count': len(feedback_items),
            # Items that reached the persona-writing step. Equals
            # feedback_count unless a cap dropped records, in which case
            # context_truncated is True and this is the smaller, true number.
            'feedback_items_used': feedback_items_used,
            'context_truncated': context_truncated,
            # The fetch itself hit its ceiling, so feedback_count is a floor
            # on the matched corpus rather than its size. Reported separately
            # because context_truncated cannot see this loss: it compares
            # what the model saw against what was READ, and everything the
            # limit excluded was never read.
            'fetch_limit_reached': corpus.fetch_limit_reached,
            'fetch_limit': corpus.fetch_limit,
            # Which parse tier recovered the personas, and how many malformed
            # ones the salvage tier had to drop (#235). Non-zero means the run
            # kept a partial set rather than failing outright.
            'parse_tier': parsed.tier,
            'personas_dropped': parsed.dropped,
            'source_breakdown': source_breakdown,
            'generation_time_ms': llm_time
        }
    }


def _persona_generation_failure(error: Exception, corpus: _PersonaCorpus, elapsed: float) -> ServiceError:
    """The user-facing error for a failed generation (logged with its traceback)."""
    logger.exception(f"[PERSONA] FAILED after {elapsed:.2f}s: {type(error).__name__}: {error}")
    # Bedrock reports an oversized prompt as a ValidationException. Name the
    # knob in that case instead of the generic "try again", which sends an
    # operator into an identical retry: a context that does not fit will not
    # fit on the second attempt either.
    if _is_oversized_input_error(error):
        # The operator-facing half — which internal knob to turn — goes to
        # the log, where an operator is. The message returned to the API
        # reaches an end user in the browser, who can act on filters and the
        # model picker but cannot set a Lambda environment variable, and for
        # whom an env-var name is an internal detail leaking into the UI.
        logger.error(
            "[PERSONA] Corpus exceeded the resolved model's context window",
            extra={
                'budget_chars': corpus.context_budget,
                'fetch_limit': corpus.fetch_limit,
                'items_fetched': len(corpus.items),
                'tuning_env_vars': [
                    ENV_MAX_PERSONA_CONTEXT_CHARS,
                    ENV_FEEDBACK_LIMIT_PERSONA,
                ],
            },
        )
        return ServiceError(
            'The selected feedback was too large for the configured model. '
            'Narrow the filters — a shorter date range, or fewer sources — '
            'or choose a model with a larger context window in Settings.'
        )
    return ServiceError('Failed to generate personas. Please try again.')


@tracer.capture_method
def autofill_prfaq_questions(project_id: str, body: dict, *, category_scope: dict | None) -> dict:
    """
    Pre-populate the 5 Working-Backwards customer questions from existing project
    context (personas, feedback, uploaded product context). Synchronous because
    the user is interactively waiting in the wizard; runs in well under 30s.

    Returns: {"answers": [str, str, str, str, str]} — empty strings for any
    field the model can't reasonably draft.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})

    feedback_items = get_scoped_feedback_context(filters, FEEDBACK_LIMIT_AUTOFILL, category_scope)
    feedback_context = format_feedback_for_llm(feedback_items)

    # `goals`, `frustrations` and singular `quote` are keys no writer produces, so
    # this block used to reach the model with every label present and every value
    # empty. Worse than omitting the persona: `Goals: ` with nothing after it reads
    # as an assertion that the persona has none. Field paths now live in
    # shared/persona_context.py.
    personas_context = personas_prompt_context(personas)

    feature_idea = (body or {}).get('feature_idea', '').strip()
    title = (body or {}).get('title', '').strip()
    response_language = (body or {}).get('response_language')

    product_context = _product_context_or_placeholder(project_id)

    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior product manager drafting answers to Amazon's 5 "
        "Working-Backwards customer questions for a PR/FAQ. Use the provided "
        "personas, customer feedback, and product context — DO NOT invent "
        "details that aren't supported. If a question can't be answered from "
        "the available context, return an empty string for that question.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"answers": ["...", "...", "...", "...", "..."]}\n'
        "Each answer should be 2-5 sentences, concrete, and grounded in the inputs.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"FEATURE TITLE: {title or '(unspecified)'}\n"
        f"FEATURE IDEA: {feature_idea or '(unspecified)'}\n\n"
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"PERSONAS:\n{personas_context or '(none)'}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE:\n{feedback_context or '(none)'}\n\n"
        "Draft answers (in order) for these 5 questions:\n"
        "1. Who is the customer?\n"
        "2. What is the customer problem or opportunity?\n"
        "3. What is the most important customer benefit?\n"
        "4. How do you know what customers need or want? (cite the feedback/personas above)\n"
        "5. What does the customer experience look like?"
    )

    # 4096: strict-JSON output must fit ONE call (see the strict-JSON
    # doctrine in shared/converse.py).
    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=4096,
        temperature=0.3,
        surface='documents',
        step_name='prfaq_autofill',
    )

    parsed = _fenced_json(raw, 'Autofill JSON parse failed; returning best-effort.')
    answers = parsed.get('answers', [])

    if not isinstance(answers, list):
        answers = []
    cleaned = [(a if isinstance(a, str) else '').strip() for a in answers]
    while len(cleaned) < 5:  # pragma: no mutate  padding past five is cut by the [:5] below; only the lower bound is observable
        cleaned.append('')
    return {'answers': cleaned[:5]}


@tracer.capture_method
def suggest_document_brief(project_id: str, body: dict, *, category_scope: dict | None) -> dict:
    """Draft a feature title + description for a PRD/PR-FAQ from project context.

    A single fast LLM call (within API Gateway's 29s budget). Looks at the
    project's product context and a sample of its customer feedback, then
    proposes a concise feature/product title and a 2-4 sentence description so
    the user doesn't have to write the PRD/PR-FAQ brief from scratch.
    Returns {"title": str, "feature_idea": str}.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    filters = (body or {}).get('filters') or project_data.get('project', {}).get('filters', {})

    feedback_items = get_scoped_feedback_context(filters, FEEDBACK_LIMIT_BRIEF, category_scope)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    product_context = _product_context_or_placeholder(project_id)

    doc_type = (body or {}).get('doc_type', 'prd')  # pragma: no mutate  only ever compared with 'prfaq'; any other default behaves the same
    doc_label = 'PR-FAQ' if doc_type == 'prfaq' else 'PRD'
    response_language = (body or {}).get('response_language')
    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        f"You are a senior product manager about to write a {doc_label}. Based on "
        "the product context and the most salient customer feedback, propose ONE "
        "concrete feature or product improvement worth documenting. The title "
        "should name the feature crisply; the description should explain what it "
        "is and the customer problem it solves, grounded in the feedback. Do not "
        "invent problems that aren't supported by the feedback.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"title": "feature/product title", "feature_idea": "2-4 sentence description"}\n'
        "Title <= 10 words. Description 2-4 sentences.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"FEEDBACK STATISTICS:\n{feedback_stats}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE ({len(feedback_items)} reviews):\n{feedback_context or '(none)'}\n\n"
        f"Propose one feature worth writing a {doc_label} for."
    )

    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=2048,  # strict JSON: fit ONE call (doctrine in shared/converse.py)
        temperature=0.4,
        surface='documents',
        step_name='document_brief_suggest',
    )

    parsed = _fenced_json(raw, 'Document-brief JSON parse failed;')

    title = (parsed.get('title') or '').strip()
    feature_idea = (parsed.get('feature_idea') or '').strip()
    return {'title': title, 'feature_idea': feature_idea}


@tracer.capture_method
def suggest_research_questions(project_id: str, body: dict, *, category_scope: dict | None) -> dict:
    """Suggest research questions tailored to this project's feedback + context.

    A single fast LLM call (well within API Gateway's 29s budget) that looks at
    the project's product context and a sample of its actual customer feedback,
    then proposes 3 concrete, decision-oriented research questions. Used by the
    "AI suggest" button in the Research wizard so users don't start from a blank
    box. Returns {"suggestions": [{"title": str, "question": str}, ...]}.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    from shared.converse import converse

    project_data = get_project(project_id)
    project = project_data.get('project', {})
    filters = (body or {}).get('filters') or project.get('filters', {})

    # Sample real feedback so suggestions are grounded in what was actually said.
    feedback_items = get_scoped_feedback_context(filters, FEEDBACK_LIMIT_RESEARCH_SUGGEST, category_scope)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    product_context = _product_context_or_placeholder(project_id)

    response_language = (body or {}).get('response_language')
    from shared.prompts import get_response_language_instruction
    language_instruction = get_response_language_instruction(response_language)

    system_prompt = (
        "You are a senior UX researcher helping a PM frame a research study on "
        "their product's customer feedback. Propose research questions that are "
        "specific, decision-oriented, and answerable from the customer feedback "
        "provided — favor questions about root causes, priorities, frequency/"
        "severity, and opportunities for new features. Avoid vague questions "
        "like 'what do customers think?'. Ground every suggestion in the actual "
        "feedback themes and product context provided; do not invent topics that "
        "aren't supported by the data.\n\n"
        "Return STRICT JSON in this exact shape (no prose, no markdown fences):\n"
        '{"suggestions": [{"title": "short report title", "question": "the research question"}, ...]}\n'
        "Provide exactly 3 suggestions. Titles <= 8 words. Questions 1-2 sentences.\n\n"
        + (language_instruction or "")
    ).strip()

    user_prompt = (
        f"PRODUCT CONTEXT:\n{product_context}\n\n"
        f"FEEDBACK STATISTICS:\n{feedback_stats}\n\n"
        f"CUSTOMER FEEDBACK SAMPLE ({len(feedback_items)} reviews):\n{feedback_context or '(none)'}\n\n"
        "Based on the above, propose 3 research questions worth running on this feedback."
    )

    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        max_tokens=2048,  # strict JSON: fit ONE call (doctrine in shared/converse.py)
        temperature=0.4,
        surface='documents',
        step_name='research_suggest',
    )

    parsed = _fenced_json(raw, 'Research-suggest JSON parse failed;')
    suggestions = parsed.get('suggestions', [])

    cleaned = []
    if isinstance(suggestions, list):
        for s in suggestions:
            if not isinstance(s, dict):
                continue
            q = (s.get('question') or '').strip()
            t = (s.get('title') or '').strip()
            if q:
                cleaned.append({'title': t, 'question': q})
    return {'suggestions': cleaned[:3]}


@tracer.capture_method
def create_document(project_id: str, body: dict) -> dict:
    """Create a custom document in the project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    title = body.get('title', 'Untitled Document')
    content = body.get('content', '')
    document_type = body.get('document_type', 'custom')

    if document_type != 'custom':
        raise ValidationError(
            'Only custom documents can be created directly. Every managed or '
            'workflow document type must use its dedicated route.'
        )
    if not content:
        raise ValidationError('Content is required')

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()

    def build(doc_id: str) -> dict:
        return {
            'pk': f'PROJECT#{project_id}',
            'sk': f'DOC#{doc_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': doc_id,
            'document_type': document_type,
            'title': title,
            'content': content,
            'created_at': now,
            'updated_at': now,
        }

    item = create_counted_project_child(
        projects_table, project_id, 'doc', build, 'document_count', now=now_dt,
    )
    return {'success': True, 'document': item}


def _is_prototype(document: dict) -> bool:
    return document.get('document_type') == 'prototype' or str(document.get('sk', '')).startswith('PROTOTYPE#')


@tracer.capture_method
def update_document(project_id: str, document_id: str, body: dict) -> dict:
    """Save an edit as a NEW version; the previous content stays retrievable.

    A PRD / PR/FAQ edit is the next version of its series (a new document, like a
    regeneration); a research / custom edit keeps its id and saves what it replaces
    as a revision. See ``shared.document_history``. Answers the saved document.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    document = _source_document_item(project_id, document_id)
    document_type = managed_document_type(document)
    title: str | None = None
    if 'title' in body:
        if document_type is not None:
            stored_title = document.get('base_title') or document.get('title') or 'Untitled'
            if (
                normalized_base_title(body['title'], document_type)
                != normalized_base_title(stored_title, document_type)
            ):
                raise ValidationError(
                    'Managed PRD, PR/FAQ, and prototype titles cannot change '
                    'series. Use the dedicated workflow to create a new series.'
                )
        elif not isinstance(body['title'], str) or not body['title'].strip():
            raise ValidationError('title must be a non-empty string')
        else:
            title = body['title']
    if 'content' in body and _is_prototype(document):
        raise ValidationError(
            'Prototype content is stored in S3 and cannot be updated through '
            'generic document CRUD. Use the prototype revision workflow.'
        )
    return edit_document(projects_table, project_id, document, body, now=datetime.now(UTC).isoformat(), title=title)


@tracer.capture_method
def get_document_versions(project_id: str, document_id: str) -> dict:
    """The document's versions, newest first (content included, for open / compare)."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    return {'success': True, **list_document_versions(projects_table, project_id, _source_document_item(project_id, document_id))}


@tracer.capture_method
def restore_document(project_id: str, document_id: str, version_id: str, body: dict) -> dict:
    """Restore = a new version with an earlier version's content."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    document = _source_document_item(project_id, document_id)
    return restore_document_version(projects_table, project_id, document, version_id, body,
                                    now=datetime.now(UTC).isoformat())


@tracer.capture_method
def delete_document(
    project_id: str, document_id: str, _attempt: int = 0,
) -> dict:
    """Delete one document without discarding version-allocation history."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    project_key = f'PROJECT#{project_id}'
    items = _query_partition_items(project_key)
    document = _require_document(next(
        (
            item for item in items
            if item.get('document_id') == document_id
        ),
        None,
    ))
    sk = _stored_document_sort_key(document)

    project_documents = [
        item for item in items
        if isinstance(item.get('sk'), str)
        and item['sk'].startswith(_DOCUMENT_SORT_KEY_PREFIXES)
    ]
    remaining_document_count = max(0, len(project_documents) - 1)
    project_meta = next(
        (
            item for item in items
            if item.get('sk') == 'META'
        ),
        {},
    )

    document_type = document.get('document_type')
    is_managed = (
        isinstance(document_type, str)
        and document_type in VERSIONED_DOCUMENT_TYPES
    ) or sk.startswith(('PRD#', 'PRFAQ#', 'PROTOTYPE#'))
    if is_managed:
        # Persist the complete snapshot before removing one managed row. This
        # keeps surviving legacy siblings on their assigned versions. Counters
        # and assignment rows intentionally remain as allocation history.
        persist_legacy_document_versions(
            projects_table, project_id, project_documents,
        )
        allocation_id = document.get('version_allocation_id')
        if isinstance(allocation_id, str) and allocation_id:
            preserve_versioned_document_allocation(
                projects_table, project_id, document,
            )

    try:
        table_name = projects_table_name(projects_table)
    except ValueError as error:
        raise ConfigurationError('Projects table name not configured') from error

    now = datetime.now(UTC).isoformat()
    count_condition = 'attribute_not_exists(document_count)'
    count_values = {
        **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
        ':remaining': remaining_document_count,
        ':now': now,
    }
    if 'document_count' in project_meta:
        count_condition = 'document_count = :observed_count'
        count_values[':observed_count'] = project_meta['document_count']

    transaction = [
        {
            'Delete': {
                'TableName': table_name,
                'Key': {'pk': project_key, 'sk': sk},
                'ConditionExpression': (
                    'attribute_exists(pk) AND attribute_exists(sk) '
                    'AND document_id = :document_id'
                ),
                'ExpressionAttributeValues': {':document_id': document_id},
            },
        },
        {
            'Update': {
                'TableName': table_name,
                'Key': {'pk': project_key, 'sk': 'META'},
                'UpdateExpression': (
                    'SET document_count = :remaining, updated_at = :now'
                ),
                'ConditionExpression': (
                    f'{PROJECT_WRITABLE_CONDITION} AND {count_condition}'
                ),
                'ExpressionAttributeNames': dict(
                    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
                ),
                'ExpressionAttributeValues': count_values,
            },
        },
    ]
    try:
        projects_table.meta.client.transact_write_items(
            TransactItems=transaction,
        )
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
            raise
        current = projects_table.get_item(
            Key={'pk': project_key, 'sk': sk},
            ConsistentRead=True,
        ).get('Item')
        if not current or current.get('document_id') != document_id:
            raise NotFoundError('Document no longer exists') from error
        current_meta_response = projects_table.get_item(
            Key=project_meta_key(project_id),
            ConsistentRead=True,
        )
        current_meta = (
            current_meta_response.get('Item')
            if isinstance(current_meta_response, dict)
            else None
        )
        if (
            not is_project_tombstone(current_meta)
            and _attempt + 1 < DOCUMENT_DELETE_ATTEMPTS
        ):
            # The retry re-runs managed preparation intentionally: legacy
            # migration is assignment/lease-idempotent and allocation-history
            # preservation is conditional winner-checked. Both have focused
            # replay tests in shared/test/test_document_versions.py.
            return delete_document(project_id, document_id, _attempt + 1)
        raise ServiceError(
            'Document could not be deleted because the project is being deleted '
            'or its document count changed repeatedly.'
        ) from error

    if not is_managed:
        _delete_saved_revisions(project_id, document_id)
    return {'success': True}


def _delete_saved_revisions(project_id: str, document_id: str) -> None:
    """Best effort: an unmanaged document's earlier versions go with it.

    The document is already gone, so a failure only leaves revision rows that the
    project delete sweeps with the version partition; it must not fail this call.
    """
    try:
        delete_document_revisions(projects_table, project_id, document_id)
    except Exception:
        logger.exception('Could not delete the saved revisions of a deleted document',
                         extra={'project_id': project_id, 'document_id': document_id})


# ============================================================================
# Document duplication (copy into another project — never move or delete)
# ============================================================================

# Identity, keys and storage pointers a copy must never inherit from its source.
_DUPLICATE_DROPPED_FIELDS = frozenset({
    'pk', 'sk', 'gsi1pk', 'gsi1sk', 'document_id', 'title', 'base_title', 'version',
    'version_allocation_id', 'prototype_etag', 'prototype_version_id', 'prototype_url',
    'created_at', 'updated_at', 'job_id',
})
_MANAGED_DUPLICATE_TYPES = {'PRD#': 'prd', 'PRFAQ#': 'prfaq', 'PROTOTYPE#': 'prototype'}


def _source_document_item(project_id: str, document_id: str) -> dict:
    sk = _stored_document_sort_key(_find_document(project_id, document_id))
    item = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': sk}, ConsistentRead=True,
    ).get('Item')
    if not isinstance(item, dict) or item.get('document_id') != document_id:
        raise NotFoundError('Document not found')
    return item


def _copy_prototype_html(source_project: str, source_doc: str,
                         target_project: str, target_doc: str) -> dict[str, str]:
    """Copy the prototype HTML object; the copy is a new object, the source is untouched."""
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    if not bucket:
        raise ConfigurationError('Prototype storage not configured')
    try:
        response = get_s3_client().copy_object(
            Bucket=bucket,
            Key=prototype_s3_key(target_project, target_doc),
            CopySource={'Bucket': bucket, 'Key': prototype_s3_key(source_project, source_doc)},
            ContentType='text/html; charset=utf-8',
            MetadataDirective='REPLACE',
        )
    except ClientError as error:
        logger.exception('Prototype copy failed')
        raise ServiceError('Could not copy the prototype. Please retry.') from error
    etag = (response.get('CopyObjectResult') or {}).get('ETag')
    identity = {'prototype_etag': etag} if etag else {}
    version_id = response.get('VersionId')
    if version_id:
        identity['prototype_version_id'] = version_id
    return identity


def _duplicate_summary(item: dict, target_project_id: str) -> dict:
    return {
        'project_id': target_project_id,
        'document_id': item.get('document_id'),
        'document_type': item.get('document_type'),
        'title': item.get('title'),
    }


@tracer.capture_method
def duplicate_document(project_id: str, document_id: str, target_project_id: str) -> dict:
    """Copy one document into ``target_project_id``.

    Access (edit on BOTH projects) is the route's job. The copy is idempotent:
    the target id derives from (source project, document, target), so a retry —
    or an agent re-running the same step — returns the existing copy instead of
    a second one. Managed types (PRD, PR/FAQ, prototype) join the target's
    version series for their title; the prototype HTML is copied to the
    target's own S3 key. The source document is never modified.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    if target_project_id == project_id:
        raise ValidationError('target_project_id must name a different project')
    source = _source_document_item(project_id, document_id)
    sk = str(source['sk'])
    allocation_id = f'duplicate:{project_id}:{document_id}'
    now = datetime.now(UTC).isoformat()
    fields = {key: value for key, value in source.items() if key not in _DUPLICATE_DROPPED_FIELDS}
    fields.update({
        'gsi1pk': f'PROJECT#{target_project_id}#DOCUMENTS',
        'gsi1sk': now,
        'created_at': now,
        'updated_at': now,
        'duplicated_from': {'project_id': project_id, 'document_id': document_id},
    })
    managed_type = next(
        (doc_type for prefix, doc_type in _MANAGED_DUPLICATE_TYPES.items() if sk.startswith(prefix)),
        None,
    )
    if managed_type is not None:
        title, _ = split_versioned_title(source.get('base_title') or source.get('title') or 'Untitled')
        if managed_type == 'prototype':
            existing = get_versioned_document_by_allocation(
                projects_table, target_project_id, 'prototype', allocation_id,
            )
            if existing is not None:
                return {'success': True, 'document': _duplicate_summary(existing, target_project_id)}
            target_doc = versioned_document_id(target_project_id, 'prototype', allocation_id)
            fields.update(_copy_prototype_html(project_id, document_id, target_project_id, target_doc))
        item = persist_versioned_document(
            projects_table, target_project_id, managed_type, title, allocation_id, fields,
        )
        return {'success': True, 'document': _duplicate_summary(item, target_project_id)}

    prefix = sk[: sk.index('#') + 1]
    digest = hashlib.sha256(f'{allocation_id}|{target_project_id}'.encode()).hexdigest()[:20]
    new_id = f'dup_{digest}'
    item = {
        **fields,
        'pk': f'PROJECT#{target_project_id}',
        'sk': f'{prefix}{new_id}',
        'document_id': new_id,
        'title': source.get('title') or 'Untitled',
    }
    try:
        put_project_item_and_increment(projects_table, target_project_id, item, 'document_count')
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
            raise
        existing = projects_table.get_item(
            Key={'pk': item['pk'], 'sk': item['sk']}, ConsistentRead=True,
        ).get('Item')
        if not existing:
            raise ServiceError('The target project is not accepting documents') from error
        item = existing
    return {'success': True, 'document': _duplicate_summary(item, target_project_id)}

@tracer.capture_method
def create_persona(project_id: str, body: dict) -> dict:
    """Create a new persona manually."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    name = body.get('name', 'New Persona')

    # One tz-aware reading for both the timestamps and the id stamp (as in
    # _build_persona_items), so the id cannot name a different day than created_at.
    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()

    def build(persona_id: str) -> dict:
        return {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PERSONA#{persona_id}',
            'gsi1pk': f'PROJECT#{project_id}#PERSONAS',
            'gsi1sk': now,
            'persona_id': persona_id,
            'name': name,
            'tagline': body.get('tagline', ''),
            'identity': body.get('identity', {}),
            'goals_motivations': body.get('goals_motivations', {}),
            'pain_points': body.get('pain_points', {}),
            'behaviors': body.get('behaviors', {}),
            'context_environment': body.get('context_environment', {}),
            'quotes': body.get('quotes', []),
            'scenario': body.get('scenario', {}),
            'research_notes': body.get('research_notes', []),
            'created_at': now,
            'updated_at': now,
        }

    item = create_counted_project_child(
        projects_table, project_id, 'persona', build, 'persona_count', now=now_dt,
    )
    return {'success': True, 'persona': item}


@tracer.capture_method
def update_persona(project_id: str, persona_id: str, body: dict) -> dict:
    """Update a persona with support for all 8 sections."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    # Fix persona name if provided
    if body.get('name'):
        body['name'] = fix_persona_name(body['name'])

    now = datetime.now(UTC).isoformat()

    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}

    # All updatable fields - use expression attribute names for ALL fields
    # to avoid DynamoDB reserved keyword issues (identity, name, etc.)
    updatable_fields = [
        'name', 'tagline', 'confidence',
        'identity', 'goals_motivations', 'pain_points', 'behaviors',
        'context_environment', 'quotes', 'scenario', 'research_notes',
        'avatar_url', 'avatar_prompt',
    ]

    for field in updatable_fields:
        if field in body:
            attr_name = f'#{field}'
            update_expr += f', {attr_name} = :{field}'
            expr_names[attr_name] = field
            expr_values[f':{field}'] = body[field]

    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
        'UpdateExpression': update_expr,
        'ConditionExpression': 'attribute_exists(pk) AND attribute_exists(sk)',
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names

    try:
        projects_table.update_item(**update_params)
    except Exception as e:
        logger.exception(f"Failed to update persona: {e}")
        raise ServiceError('Failed to update persona') from e
    return {'success': True}


@tracer.capture_method
def add_persona_note(project_id: str, persona_id: str, body: dict) -> dict:
    """Add a research note to a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    note_text = body.get('text', '')
    if not note_text:
        raise ValidationError('Note text is required')

    now_dt = datetime.now(UTC)
    now = now_dt.isoformat()
    note_id = timestamped_id('note', now_dt)

    new_note = {
        'note_id': note_id,
        'text': note_text,
        'author': body.get('author', 'anonymous'),
        'created_at': now,
        'updated_at': None,
        'tags': body.get('tags', [])
    }

    try:
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression='SET research_notes = list_append(if_not_exists(research_notes, :empty), :note), updated_at = :now',
            ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
            ExpressionAttributeValues={
                ':note': [new_note],
                ':empty': [],
                ':now': now
            }
        )
    except Exception as e:
        logger.exception(f"Failed to add persona note: {e}")
        raise ServiceError('Failed to add note') from e
    return {'success': True, 'note': new_note}


@tracer.capture_method
def update_persona_note(project_id: str, persona_id: str, note_id: str, body: dict) -> dict:
    """Update a research note on a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    note_index = _persona_note_index(_stored_persona(project_id, persona_id), note_id)

    now = datetime.now(UTC).isoformat()

    try:
        update_expr = f'SET research_notes[{note_index}].updated_at = :now'
        expr_values = {':now': now}
        expr_names = {}

        if 'text' in body:
            update_expr += f', research_notes[{note_index}].#text = :text'
            expr_values[':text'] = body['text']
            expr_names['#text'] = 'text'

        if 'tags' in body:
            update_expr += f', research_notes[{note_index}].tags = :tags'
            expr_values[':tags'] = body['tags']

        update_expr += ', updated_at = :persona_updated'
        expr_values[':persona_updated'] = now

        update_params: dict[str, Any] = {
            'Key': {'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            'UpdateExpression': update_expr,
            'ExpressionAttributeValues': expr_values,
        }
        # Omitted when empty: boto3 rejects ExpressionAttributeNames=None, which a
        # tags-only edit (no '#text' alias) used to send (#267 item 5).
        if expr_names:
            update_params['ExpressionAttributeNames'] = expr_names
        projects_table.update_item(**update_params)
    except Exception as e:
        logger.exception(f"Failed to update persona note: {e}")
        raise ServiceError('Failed to update note') from e
    return {'success': True}


@tracer.capture_method
def delete_persona_note(project_id: str, persona_id: str, note_id: str) -> dict:
    """Delete a research note from a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    note_index = _persona_note_index(_stored_persona(project_id, persona_id), note_id)

    now = datetime.now(UTC).isoformat()

    try:
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=f'REMOVE research_notes[{note_index}] SET updated_at = :now',
            ExpressionAttributeValues={':now': now}
        )
    except Exception as e:
        logger.exception(f"Failed to delete persona note: {e}")
        raise ServiceError('Failed to delete note') from e
    return {'success': True}


@tracer.capture_method
def regenerate_persona_avatar(project_id: str, persona_id: str) -> dict:
    """Regenerate the avatar for a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    item = _stored_persona(project_id, persona_id)

    # Generate new avatar, stamping the owner: a regeneration also re-stamps an
    # object written before ownership was recorded.
    avatar_result = generate_persona_avatar(item, project_id=project_id)

    if not avatar_result.get('avatar_url'):
        raise ServiceError('Avatar generation failed')

    # Update persona with new avatar (a new key per image, so the CDN cannot
    # serve the previous one), then sweep the images it no longer names.
    now = datetime.now(UTC).isoformat()
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
        UpdateExpression='SET avatar_url = :url, avatar_prompt = :prompt, updated_at = :now',
        ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
        ExpressionAttributeValues={
            ':url': avatar_result['avatar_url'],
            ':prompt': avatar_result['avatar_prompt'],
            ':now': now
        }
    )
    _sweep_superseded_avatar(project_id, persona_id, item.get('avatar_url'), avatar_result['avatar_url'])

    # Signed for the browser, like every persona read: the stored `s3://` URI is
    # not loadable, and the SPA shows the new image straight from this answer.
    return {
        'success': True,
        'avatar_url': get_avatar_cdn_url(avatar_result['avatar_url']),
        'avatar_prompt': avatar_result['avatar_prompt']
    }


def _sweep_superseded_avatar(project_id: str, persona_id: str, previous_url: object, current_url: str) -> None:
    """Best effort: remove the persona's earlier images now that ``current_url`` is saved."""
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    keep = avatar_key_from_uri(current_url, bucket) if bucket else None
    if keep is None:
        return
    delete_superseded_avatars(
        get_s3_client(), bucket, persona_id, keep=keep, project_id=project_id,
        previous_key=avatar_key_from_uri(previous_url, bucket),
    )


@tracer.capture_method
def delete_persona(project_id: str, persona_id: str) -> dict:
    """Delete a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    try:
        now = datetime.now(UTC).isoformat()
        table_name = projects_table_name(projects_table)
        projects_table.meta.client.transact_write_items(TransactItems=[
            {
                'Delete': {
                    'TableName': table_name,
                    'Key': {
                        'pk': f'PROJECT#{project_id}',
                        'sk': f'PERSONA#{persona_id}',
                    },
                    'ConditionExpression': (
                        'attribute_exists(pk) AND attribute_exists(sk)'
                    ),
                },
            },
            {
                'Update': {
                    'TableName': table_name,
                    'Key': project_meta_key(project_id),
                    'UpdateExpression': (
                        'SET persona_count = persona_count - :one, '
                        'updated_at = :now'
                    ),
                    'ConditionExpression': (
                        f'{PROJECT_WRITABLE_CONDITION} '
                        'AND persona_count >= :one'
                    ),
                    'ExpressionAttributeNames': dict(
                        PROJECT_WRITABLE_ATTRIBUTE_NAMES,
                    ),
                    'ExpressionAttributeValues': {
                        **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
                        ':one': 1,
                        ':now': now,
                    },
                },
            },
        ])

    except Exception as e:
        logger.exception(f"Failed to delete persona: {e}")
        raise ServiceError('Failed to delete persona') from e
    _sweep_removed_persona_avatars(project_id, [persona_id])
    return {'success': True}


@tracer.capture_method
def run_research(project_id: str, body: dict, *, category_scope: dict | None) -> dict:
    """Run deep research analysis on feedback data.

    FALLBACK PATH ONLY. ``projects_handler.py`` prefers the Step Functions
    research workflow whenever ``RESEARCH_STATE_MACHINE_ARN`` is set, and
    ``lib/stacks/api-stack.ts`` sets it unconditionally — so in a real
    deployment the live path is ``lambda/research/research_step_handler.py``,
    which has its own ``limit=50`` and its own 50 000-char truncation. That is
    why ``FEEDBACK_LIMIT_RESEARCH`` is left at its historical value here.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')

    research_question = body.get('question', 'What are the main customer pain points?')

    # Get project data - exceptions will propagate
    project_data = get_project(project_id)

    # Use filters from request body, fallback to project filters. date_basis is
    # carried either way: it decides WHICH dates the window applies to, and the
    # Step Functions path already honours it (#258).
    date_basis = validate_date_basis(body.get('date_basis'))
    filters = feedback_filters_from_body(body)
    # If no filters provided, use project defaults
    if not any([filters['sources'], filters['categories'], filters['sentiments']]):
        filters = project_data.get('project', {}).get('filters', filters)
    filters = {**filters, 'date_basis': date_basis}

    # Get feedback for research - this is the PRIMARY data source
    logger.info(f"Fetching feedback with filters: {filters}")
    feedback_items = get_scoped_feedback_context(filters, FEEDBACK_LIMIT_RESEARCH, category_scope)
    logger.info(f"Found {len(feedback_items)} feedback items for research")

    if not feedback_items:
        raise ValidationError(RESEARCH_NO_FEEDBACK_MESSAGE)

    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items)

    # Build chain steps from external prompt files
    chain_steps = get_research_analysis_steps(
        research_question=research_question,
        feedback_stats=feedback_stats,
        feedback_context=feedback_context,
        feedback_count=len(feedback_items),
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')

        # Save research - combine all results into a comprehensive report
        now_dt = datetime.now(UTC)
        now = now_dt.isoformat()

        # Build comprehensive research report from all steps
        full_report = f"""# Research Report: {research_question}

**Generated:** {now[:10]}
**Feedback Analyzed:** {len(feedback_items)} items
**Filters:** Sources: {', '.join(filters.get('sources', [])) or 'All'} | Categories: {', '.join(filters.get('categories', [])) or 'All'} | Sentiments: {', '.join(filters.get('sentiments', [])) or 'All'} | Days: {filters.get('days', 30)} | Date basis: {date_basis}

---

## Executive Summary & Key Findings

{results[1]}

---

## Detailed Analysis

{results[0]}

---

## Validation & Confidence Assessment

{results[2]}
"""

        # DynamoDB has 400KB limit - truncate if needed
        max_content_size = 350000
        if len(full_report) > max_content_size:
            full_report = full_report[:max_content_size] + "\n\n---\n\n*[Report truncated due to size limits]*"
            logger.warning(f"Research report truncated from {len(full_report)} to {max_content_size} chars")

        def build(research_id: str) -> dict:
            return {
                'pk': f'PROJECT#{project_id}',
                'sk': f'RESEARCH#{research_id}',
                'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
                'gsi1sk': now,
                'document_id': research_id,
                'document_type': 'research',
                'title': body.get('title', f'Research: {research_question[:50]}'),
                'question': research_question,
                'content': full_report,
                'feedback_count': len(feedback_items),
                'date_basis': date_basis,
                'created_at': now,
            }

        logger.info(f"Saving research document, content size: {len(full_report)} chars, feedback items: {len(feedback_items)}")
        item = create_counted_project_child(
            projects_table, project_id, 'research', build, 'document_count', now=now_dt,
        )

    except Exception as e:
        logger.exception(f"Research failed: {e}")
        raise ServiceError('Failed to run research. Please try again.') from e
    return {'success': True, 'document': item}


# ============================================
# Project sharing: visibility, members, ownership
# ============================================
#
# Authorization (who may call these) is decided by the route gate in
# projects_handler.py; these functions validate input and perform guarded
# writes. Every write carries PROJECT_WRITABLE_CONDITION so a tombstoned
# project can never be re-shared, and member writes address `members.#sub`
# through ExpressionAttributeNames because a Cognito sub is not a legal bare
# attribute-path token.

MAX_CANDIDATE_QUERY_LENGTH = 64
MIN_CANDIDATE_QUERY_LENGTH = 3
MAX_CANDIDATE_RESULTS = 20
MAX_USER_SUB_LENGTH = 128
# Characters that would let a value escape the quoted Cognito ListUsers filter.
_COGNITO_FILTER_FORBIDDEN = ('"', '\\')

_cognito_client = None


def _get_cognito_client():
    """Lazily created so importing this module never needs Cognito config."""
    global _cognito_client
    if _cognito_client is None:
        _cognito_client = boto3.client('cognito-idp')
    return _cognito_client


def _user_pool_id() -> str:
    pool_id = os.environ.get('USER_POOL_ID', '').strip()
    if not pool_id:
        raise ConfigurationError('User pool not configured')
    return pool_id


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _error_code(error: ClientError) -> str:
    return str(error.response.get('Error', {}).get('Code') or '')


def _is_conditional_failure(error: ClientError) -> bool:
    return _error_code(error) == 'ConditionalCheckFailedException'


def _is_missing_member_failure(error: ClientError) -> bool:
    """A member-path write refused because the member (or the map) is absent.

    A nested path under a missing ``members`` map is a ValidationException
    rather than a condition failure, so both mean "not a member".
    """
    return _error_code(error) in ('ConditionalCheckFailedException', 'ValidationException')


def _member_limit_error() -> ValidationError:
    return ValidationError(
        f'A project can have at most {project_access.MAX_PROJECT_MEMBERS} members'
    )


@tracer.capture_method
def read_project_meta(project_id: str) -> dict:
    """Strongly consistent META read; missing or tombstoned -> 404."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    response = projects_table.get_item(
        Key=project_meta_key(project_id), ConsistentRead=True,
    )
    meta = response.get('Item') if isinstance(response, dict) else None
    if not isinstance(meta, dict) or is_project_tombstone(meta):
        raise NotFoundError('Project not found')
    return meta


def _guarded_meta_update(
    project_id: str,
    update_expression: str,
    *,
    condition: str = '',
    names: dict | None = None,
    values: dict | None = None,
    return_values: str = 'NONE',
) -> dict:
    """update_item on META under PROJECT_WRITABLE_CONDITION (+ ``condition``).

    Lets ClientError (including ConditionalCheckFailedException) propagate so
    each caller can classify its own failure.
    """
    full_condition = PROJECT_WRITABLE_CONDITION
    if condition:
        full_condition = f'({full_condition}) AND ({condition})'
    params = {
        'Key': project_meta_key(project_id),
        'UpdateExpression': update_expression,
        'ConditionExpression': full_condition,
        'ExpressionAttributeNames': {**PROJECT_WRITABLE_ATTRIBUTE_NAMES, **(names or {})},
        'ExpressionAttributeValues': {**PROJECT_WRITABLE_ATTRIBUTE_VALUES, **(values or {})},
        'ReturnValues': return_values,
    }
    return projects_table.update_item(**params)


def _ensure_members_map(project_id: str, meta: dict) -> None:
    """Legacy META has no ``members`` map, and `SET members.#sub` needs one."""
    if isinstance(meta.get('members'), dict):
        return
    try:
        _guarded_meta_update(
            project_id,
            'SET #members = :empty',
            condition='attribute_not_exists(#members)',
            names={'#members': 'members'},
            values={':empty': {}},
        )
    except ClientError as error:
        if not _is_conditional_failure(error):
            raise
        # Either a concurrent writer created the map (fine) or the project is
        # gone; the re-read distinguishes the two.
        read_project_meta(project_id)


# --------------------------------------------
# Visibility
# --------------------------------------------

@tracer.capture_method
def set_project_visibility(project_id: str, body: object) -> dict:
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    visibility = _validated_visibility(body.get('visibility'))
    try:
        _guarded_meta_update(
            project_id,
            'SET #visibility = :visibility, updated_at = :now',
            names={'#visibility': 'visibility'},
            values={':visibility': visibility, ':now': _now_iso()},
        )
    except ClientError as error:
        if _is_conditional_failure(error):
            raise NotFoundError('Project not found') from error
        raise
    return {'success': True, 'visibility': visibility}


# --------------------------------------------
# Cognito user lookup
# --------------------------------------------

def _validated_filter_value(raw: object, field: str, max_length: int) -> str:
    if not isinstance(raw, str):
        raise ValidationError(f'{field} must be a string')
    value = raw.strip()
    if len(value) > max_length:
        raise ValidationError(f'{field} must be at most {max_length} characters')
    if any(char in value for char in _COGNITO_FILTER_FORBIDDEN):
        raise ValidationError(f'{field} contains unsupported characters')
    return value


def _validated_user_sub(raw: object) -> str:
    sub = _validated_filter_value(raw, 'sub', MAX_USER_SUB_LENGTH)
    if not sub or project_access.is_synthetic_subject(sub):
        raise ValidationError('sub must identify a user')
    return sub


def _public_user(user: dict) -> dict | None:
    """Only sub/username/email/name ever leave this module; None if unusable."""
    if user.get('Enabled') is False:
        return None
    attributes = {
        attr.get('Name'): attr.get('Value')
        for attr in user.get('Attributes', [])
        if isinstance(attr, dict)
    }
    sub = attributes.get('sub')
    if not isinstance(sub, str) or not sub:
        return None
    return {
        'sub': sub,
        'username': str(user.get('Username') or ''),
        'email': str(attributes.get('email') or ''),
        'name': str(attributes.get('name') or ''),
    }


def _list_users(filter_expression: str | None, limit: int) -> list[dict]:
    params = {'UserPoolId': _user_pool_id(), 'Limit': limit}
    if filter_expression:
        params['Filter'] = filter_expression
    try:
        response = _get_cognito_client().list_users(**params)
    except ClientError as error:
        logger.exception('Cognito ListUsers failed')
        raise ServiceError('Could not look up users') from error
    users = [_public_user(user) for user in response.get('Users', [])]
    return [user for user in users if user]


def _resolve_user(sub: str) -> dict:
    users = [user for user in _list_users(f'sub = "{sub}"', 1) if user['sub'] == sub]
    if not users:
        raise NotFoundError('User not found')
    return users[0]


@tracer.capture_method
def search_member_candidates(project_id: str, query: object) -> dict:
    """Enabled users matching ``query`` by username or email prefix.

    Excludes the owner and existing members, so every row is invitable.
    """
    prefix = _validated_filter_value(
        query if query is not None else '', 'q', MAX_CANDIDATE_QUERY_LENGTH,
    )
    # A minimum prefix, and no "list everyone" path: anyone can create a project
    # and so hold manage on one, which makes this route reachable by every
    # signed-in user. Without the floor, 1-character prefixes page through the
    # whole user directory, which is otherwise admin-only (UsersApi).
    if len(prefix) < MIN_CANDIDATE_QUERY_LENGTH:
        raise ValidationError(
            f'Type at least {MIN_CANDIDATE_QUERY_LENGTH} characters to search for people'
        )
    meta = read_project_meta(project_id)
    excluded = set(project_access.project_members(meta))
    owner = meta.get('owner_sub')
    if isinstance(owner, str):
        excluded.add(owner)

    found = (
        _list_users(f'username ^= "{prefix}"', MAX_CANDIDATE_RESULTS)
        + _list_users(f'email ^= "{prefix}"', MAX_CANDIDATE_RESULTS)
    )

    users: dict[str, dict] = {}
    for user in found:
        if user['sub'] not in excluded and user['sub'] not in users:
            users[user['sub']] = user
    ordered = sorted(users.values(), key=lambda user: (user['username'].lower(), user['sub']))
    return {'users': ordered[:MAX_CANDIDATE_RESULTS]}


# --------------------------------------------
# Members
# --------------------------------------------

def _validated_role(value: object) -> str:
    try:
        return project_access.validate_member_role(value)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _public_member(sub: str, entry: dict) -> dict:
    rows = project_access.public_members({'members': {sub: entry}})
    return rows[0]


@tracer.capture_method
def get_project_members(project_id: str, caller: Caller) -> dict:
    meta = read_project_meta(project_id)
    return _without_emails_unless_manager({
        'visibility': project_access.project_visibility(meta),
        'owner': project_access.public_owner(meta),
        'members': project_access.public_members(meta),
        'access': project_access.resolve_access(meta, caller).to_dict(),
    }, meta, caller)


def _member_add_refusal(meta: dict, sub: str) -> None:
    """Raise the specific error for why ``sub`` cannot be added to ``meta``."""
    if meta.get('owner_sub') == sub:
        raise ConflictError('User already owns this project')
    members = project_access.project_members(meta)
    if sub in members:
        raise ConflictError('User is already a member of this project')
    if len(members) >= project_access.MAX_PROJECT_MEMBERS:
        raise _member_limit_error()


@tracer.capture_method
def add_project_member(project_id: str, body: object, caller: Caller) -> dict:
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    sub = _validated_user_sub(body.get('sub'))
    role = _validated_role(body.get('role'))

    meta = read_project_meta(project_id)
    _member_add_refusal(meta, sub)
    user = _resolve_user(sub)
    entry = {
        'role': role,
        'username': user['username'],
        'email': user['email'],
        'added_by': caller.subject,
        'added_at': _now_iso(),
    }
    _ensure_members_map(project_id, meta)
    try:
        _guarded_meta_update(
            project_id,
            'SET #members.#sub = :entry, updated_at = :now',
            condition=(
                'attribute_not_exists(#members.#sub) AND size(#members) < :max '
                'AND (attribute_not_exists(owner_sub) OR owner_sub <> :sub)'
            ),
            names={'#members': 'members', '#sub': sub},
            values={
                ':entry': entry,
                ':now': entry['added_at'],
                ':max': project_access.MAX_PROJECT_MEMBERS,
                ':sub': sub,
            },
        )
    except ClientError as error:
        if not _is_conditional_failure(error):
            raise
        # Lost a race: report the reason the current state gives.
        _member_add_refusal(read_project_meta(project_id), sub)
        raise ConflictError('Project changed while adding the member; please retry') from error
    return {'success': True, 'member': _public_member(sub, entry)}


@tracer.capture_method
def update_project_member(project_id: str, member_sub: str, body: object) -> dict:
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    role = _validated_role(body.get('role'))
    try:
        response = _guarded_meta_update(
            project_id,
            'SET #members.#sub.#role = :role, updated_at = :now',
            condition='attribute_exists(#members.#sub)',
            names={'#members': 'members', '#sub': member_sub, '#role': 'role'},
            values={':role': role, ':now': _now_iso()},
            return_values='ALL_NEW',
        )
    except ClientError as error:
        if _is_missing_member_failure(error):
            read_project_meta(project_id)  # 404s a missing project first
            raise NotFoundError('Member not found') from error
        raise
    attributes = response.get('Attributes')
    entry = project_access.project_members(attributes or {}).get(member_sub)
    if entry is None:
        raise NotFoundError('Member not found')
    return {'success': True, 'member': _public_member(member_sub, entry)}


@tracer.capture_method
def remove_project_member(
    project_id: str,
    member_sub: str,
    caller: Caller,
    access: project_access.ProjectAccess,
) -> dict:
    """Remove a member. Managers may remove anyone; a member may leave.

    The route gate only requires view here (see project_access); this function
    is where "manage, or yourself" is enforced. A delegated credential may not
    make its minter leave — that is a decision about a person, not a task.
    """
    leaving = (
        not caller.delegated and bool(caller.subject) and caller.subject == member_sub
    )
    if not leaving and not access.can_manage:
        raise AuthorizationError('You do not have permission to manage this project')
    try:
        _guarded_meta_update(
            project_id,
            'REMOVE #members.#sub SET updated_at = :now',
            condition='attribute_exists(#members.#sub)',
            names={'#members': 'members', '#sub': member_sub},
            values={':now': _now_iso()},
        )
    except ClientError as error:
        if _is_missing_member_failure(error):
            read_project_meta(project_id)
            raise NotFoundError('Member not found') from error
        raise
    return {'success': True}


# --------------------------------------------
# Ownership transfer
# --------------------------------------------

OWNERSHIP_CHANGED_MESSAGE = 'Project ownership changed; reload and retry'


def _new_owner_identity(sub: str) -> dict:
    """username/email for ``sub``, ALWAYS from Cognito.

    A stored member entry is not trusted: ownership must never land on a user
    who has since been disabled or deleted (``_resolve_user`` finds enabled
    users only and 404s otherwise).
    """
    user = _resolve_user(sub)
    return {'sub': sub, 'username': user['username'], 'email': user['email']}


def _owner_transfer_update(
    previous: dict | None, new_owner: dict, caller: Caller, now: str,
) -> tuple[str, str, dict, dict]:
    """(update expression, condition, names, values) for one ownership transfer.

    Every condition is evaluated against the item as stored, so the transfer
    is a compare-and-swap on the owner it was decided against:
      * ``owner_sub = :prev_sub`` (or no owner, for a legacy project);
      * a non-admin caller must STILL be the owner (``owner_sub = :caller_sub``)
        — the route gate read is stale by now, and a just-demoted owner must
        not race a second transfer through;
      * re-adding the previous owner as a member must respect the member cap,
        unless the new owner's entry (removed in the same write) frees a slot.
    """
    set_clauses = [
        'owner_sub = :new_sub', 'owner_username = :new_username',
        'owner_email = :new_email', 'updated_at = :now',
    ]
    names = {'#members': 'members', '#new': new_owner['sub']}
    values = {
        ':new_sub': new_owner['sub'],
        ':new_username': new_owner['username'],
        ':new_email': new_owner['email'],
        ':now': now,
    }
    conditions = []
    if previous is not None:
        set_clauses.append('#members.#prev = :prev_entry')
        names['#prev'] = previous['sub']
        values[':prev_entry'] = {
            'role': project_access.ROLE_EDITOR,
            'username': previous['username'],
            'email': previous['email'],
            'added_by': caller.subject,
            'added_at': now,
        }
        values[':prev_sub'] = previous['sub']
        values[':max'] = project_access.MAX_PROJECT_MEMBERS
        conditions.append('owner_sub = :prev_sub')
        conditions.append('(attribute_exists(#members.#new) OR size(#members) < :max)')
    else:
        conditions.append('attribute_not_exists(owner_sub)')
    if not caller.is_admin:
        values[':caller_sub'] = caller.subject
        conditions.append('owner_sub = :caller_sub')
    update = f'SET {", ".join(set_clauses)} REMOVE #members.#new'
    return update, ' AND '.join(conditions), names, values


@tracer.capture_method
def transfer_project_owner(project_id: str, body: object, caller: Caller) -> dict:
    """Make ``sub`` the owner; the previous owner (if any) becomes an editor."""
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    new_sub = _validated_user_sub(body.get('sub'))
    meta = read_project_meta(project_id)
    previous = project_access.public_owner(meta)
    if not caller.is_admin and (previous is None or previous['sub'] != caller.subject):
        # The gate passed on an earlier read; ownership has moved since.
        raise ConflictError(OWNERSHIP_CHANGED_MESSAGE)
    if previous and previous['sub'] == new_sub:
        return {'success': True, 'owner': previous}

    members = project_access.project_members(meta)
    grows = previous is not None and new_sub not in members
    if grows and len(members) >= project_access.MAX_PROJECT_MEMBERS:
        raise _member_limit_error()
    new_owner = _new_owner_identity(new_sub)
    update, condition, names, values = _owner_transfer_update(
        previous, new_owner, caller, _now_iso(),
    )

    _ensure_members_map(project_id, meta)
    try:
        _guarded_meta_update(
            project_id, update, condition=condition, names=names, values=values,
        )
    except ClientError as error:
        if _is_conditional_failure(error):
            read_project_meta(project_id)
            raise ConflictError(OWNERSHIP_CHANGED_MESSAGE) from error
        raise
    return {'success': True, 'owner': new_owner}
