"""
Projects API endpoints for VoC Analytics.
Handles projects, personas, PRDs, PR/FAQs with multi-step LLM orchestration.
"""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client
from shared.model_config import get_active_model_id
from shared.api import validate_days, MAX_PERSONAS_PER_GENERATION
from shared.converse import converse_chain
from shared.exceptions import (
    ConfigurationError,
    NotFoundError,
    ValidationError,
    ServiceError,
)
from shared.prompts import (
    PERSONA_SYNTHESIS_STEP,
    count_persona_sample_records,
    get_persona_generation_steps,
    get_prd_generation_steps,
    get_prfaq_generation_steps,
    get_research_analysis_steps,
)
from shared.feedback import (
    get_feedback_context as _get_feedback_context,
    feedback_char_budget,
    feedback_item_limit,
    format_feedback_for_llm,
    get_feedback_statistics,
    truncate_feedback_context,
)
from shared.model_config import surface_context_window_tokens
from shared.avatar import (
    generate_persona_avatar as _generate_persona_avatar,
    get_avatar_cdn_url,
)

from shared.prototypes import prototype_signed_url
from shared.tables import get_projects_table, get_feedback_table
from shared.indexes import PROJECTS_BY_TYPE_INDEX

# Default instructions used when a project has not set its own kiro_export_prompt.
# Kept here — ONE definition only — so both _build_steering_file and the
# get_project response agree on the wording. Do not duplicate this text in any
# other file (backend or frontend). The frontend reads it from the API response
# via the kiro_default_export_prompt field.
#
# Refers to the material by PRESENCE, never by file path. This text is delivered
# three ways and only one of them has files: autoseed writes it to
# .kiro/steering/, but the Export card concatenates file *contents* into a single
# clipboard blob (paths discarded) and "Copy to Kiro" on a document pastes it
# ahead of that one document with no personas at all. A path reference is a
# dangling pointer in the latter two. The autoseed prompt describes the layout;
# this text describes the content.
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
# generate_personas). The PRD, PR/FAQ, and research surfaces named in #231 run
# through their own Lambdas with their own independent fetches and caps
# (lambda/jobs/document_generator/handler.py,
# lambda/research/research_step_handler.py) and are NOT fixed here; see the
# LEGACY note on generate_prd below.
#
# Both numbers below are DERIVED from one measurement rather than chosen
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


# Import-time snapshot of the pair above, resolved against the DEFAULT context
# window rather than the live model. These are the documented defaults and what
# the budget-consistency tests pin; the persona path itself calls
# persona_context_budget() so it follows the resolved model instead of these.
MAX_PERSONA_CONTEXT_CHARS: int = (
    _env_positive_int(ENV_MAX_PERSONA_CONTEXT_CHARS) or feedback_char_budget()
)

# Item-fetch limit for persona generation. "Item" = one DynamoDB feedback
# record. Derived from MAX_PERSONA_CONTEXT_CHARS and the measured worst-case
# per-item formatted size, so a FULL corpus fits and the character cap is a
# genuine backstop for unusually long records rather than the operative limit.
# TestBudgetConstantsAreConsistent pins that relationship.
FEEDBACK_LIMIT_PERSONA: int = (
    _env_positive_int(ENV_FEEDBACK_LIMIT_PERSONA)
    or feedback_item_limit(MAX_PERSONA_CONTEXT_CHARS)
)

# Item-fetch limits for the remaining surfaces in this module. Left at their
# historical values ON PURPOSE — see the LEGACY note on generate_prd: nothing
# in a real deployment reaches these functions, so raising them would be a
# change with no user-visible effect that reads in the diff as if #231's
# PRD/PR-FAQ/research half had been addressed. They are named rather than bare
# so the values are at least visible to a reader.
FEEDBACK_LIMIT_PRD: int = 50        # LEGACY path — see generate_prd
FEEDBACK_LIMIT_PRFAQ: int = 30      # LEGACY path — see generate_prfaq
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

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

# Ceiling on parallel avatar generations inside one persona generation. Derived from the
# shared persona ceiling rather than repeating the number, so today every persona in a
# batch gets its own worker and raising that ceiling cannot silently halve the fan-out
# benefit while every test still passes — which is what a matching comment allowed.
AVATAR_MAX_CONCURRENCY = MAX_PERSONAS_PER_GENERATION
# Stamped into every persona's llm_metadata so a stored persona stays attributable to the
# prompt chain that produced it. Bumped 2.0.0 -> 2.1.0 with the removal of the third
# ('validation') chain step: 2.0.0 personas came from a three-step chain, and leaving the
# version alone would make two different chains claim one version. Minor, not major — the
# persona object's own shape is unchanged, only the chain that fills it.
# Must equal persona-generation.json's "version"; a lockstep test pins the pair, since this
# is a literal in the house style of processor/handler.py's PROMPT_VERSION rather than a
# value read back out of the file.
PERSONA_PROMPT_VERSION = '2.1.0'


def generate_persona_avatar(persona_data: dict, s3_bucket: str | None = None) -> dict:
    """Wrapper for shared avatar generation that provides the bedrock client.
    
    Args:
        persona_data: Dict with persona info (name, tagline, identity, persona_id)
        s3_bucket: Optional S3 bucket override
        
    Returns:
        dict with 'avatar_url' and 'avatar_prompt'
    """
    bedrock_client = get_bedrock_client()
    return _generate_persona_avatar(persona_data, bedrock_client, s3_bucket)


def get_feedback_context(filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context."""
    return _get_feedback_context(feedback_table, filters, limit)


projects_table = get_projects_table()
feedback_table = get_feedback_table()


def fix_persona_name(name: str) -> str:
    """Fix persona names that may be missing spaces between words.
    
    LLMs sometimes generate names like "VeronicaChen" instead of "Veronica Chen".
    This function adds spaces between lowercase and uppercase letter transitions.
    """
    return re.sub(r'([a-z])([A-Z])', r'\1 \2', name)


@tracer.capture_method
def list_projects() -> dict:
    """List all projects with accurate persona/document counts."""
    if not projects_table:
        return {'projects': []}
    
    response = projects_table.query(
        IndexName=PROJECTS_BY_TYPE_INDEX,
        KeyConditionExpression=Key('gsi1pk').eq('TYPE#PROJECT'),
        ScanIndexForward=False
    )
    
    projects = []
    for item in response.get('Items', []):
        project_id = item.get('project_id')
        
        # Query actual items to get accurate counts
        items_response = projects_table.query(
            KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
            ProjectionExpression='sk'
        )
        
        persona_count = 0
        document_count = 0
        for proj_item in items_response.get('Items', []):
            sk = proj_item.get('sk', '')
            if sk.startswith('PERSONA#'):
                persona_count += 1
            elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#') or sk.startswith('PRODUCT_REPORT#') or sk.startswith('PROTOTYPE#'):
                document_count += 1
        
        projects.append({
            'project_id': project_id,
            'name': item.get('name'),
            'description': item.get('description'),
            'status': item.get('status', 'active'),
            'created_at': item.get('created_at'),
            'updated_at': item.get('updated_at'),
            'persona_count': persona_count,
            'document_count': document_count,
        })
    
    return {'projects': projects}


@tracer.capture_method
def create_project(body: dict) -> dict:
    """Create a new project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    project_id = f"proj_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    now = datetime.now(timezone.utc).isoformat()
    
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': 'META',
        'gsi1pk': 'TYPE#PROJECT',
        'gsi1sk': now,
        'project_id': project_id,
        'name': body.get('name', 'New Project'),
        'description': body.get('description', ''),
        'status': 'active',
        'created_at': now,
        'updated_at': now,
        'persona_count': 0,
        'document_count': 0,
        'filters': body.get('filters', {}),
        'kiro_export_prompt': body.get('kiro_export_prompt', ''),
    }
    
    projects_table.put_item(Item=item)
    
    return {'success': True, 'project': item}


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


@tracer.capture_method
def get_project(project_id: str) -> dict:
    """Get a project with all its data."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Project not found')
    
    project = None
    personas = []
    documents = []
    
    for item in items:
        sk = item.get('sk', '')
        if sk == 'META':
            project = item
        elif sk.startswith('PERSONA#'):
            # Convert S3 URI to a signed CloudFront CDN URL for the avatar
            if item.get('avatar_url') and item['avatar_url'].startswith('s3://'):
                item['avatar_url'] = get_avatar_cdn_url(item['avatar_url'])
            personas.append(item)
        elif sk.startswith('PRD#') or sk.startswith('PRFAQ#') or sk.startswith('RESEARCH#') or sk.startswith('DOC#') or sk.startswith('PRODUCT_REPORT#') or sk.startswith('PROTOTYPE#'):
            documents.append(_with_signed_prototype_url(item, project_id))
    
    if not project:
        raise NotFoundError('Project metadata not found')

    # Inject the default at read time so both consumers (the steering-file editor
    # and the per-document "Copy to Kiro" action) always agree on the fallback
    # text without duplicating the constant in the frontend bundle.
    # NOTE: this field is COMPUTED, not stored in DynamoDB. Do not include it in
    # any update expression or treat it as a persisted attribute.
    project['kiro_default_export_prompt'] = KIRO_DEFAULT_EXPORT_PROMPT

    return {
        'project': project,
        'personas': personas,
        'documents': documents
    }


@tracer.capture_method
def update_project(project_id: str, body: dict) -> dict:
    """Update a project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    if 'name' in body:
        update_expr += ', #name = :name'
        expr_values[':name'] = body['name']
        expr_names['#name'] = 'name'
    if 'description' in body:
        update_expr += ', description = :desc'
        expr_values[':desc'] = body['description']
    if 'status' in body:
        update_expr += ', #status = :status'
        expr_values[':status'] = body['status']
        expr_names['#status'] = 'status'
    if 'filters' in body:
        update_expr += ', filters = :filters'
        expr_values[':filters'] = body['filters']
    if 'kiro_export_prompt' in body:
        update_expr += ', kiro_export_prompt = :kiro_prompt'
        expr_values[':kiro_prompt'] = body['kiro_export_prompt']
    
    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    projects_table.update_item(**update_params)
    
    return {'success': True}


@tracer.capture_method
def delete_project(project_id: str) -> dict:
    """Delete a project and all its data."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    # Delete all items
    with projects_table.batch_writer() as batch:
        for item in response.get('Items', []):
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    
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
    message = str(error.get('Message', '')).lower()
    return any(
        phrase in message
        for phrase in ('too long', 'too many tokens', 'input is too', 'context window',
                       'maximum context', 'exceeds the maximum')
    )


@tracer.capture_method
def generate_personas(project_id: str, filters: dict, progress_callback: callable = None) -> dict:
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
    
    def update_progress(progress: int, step: str):
        """Update progress if callback provided."""
        logger.info(f"[PERSONA] Progress update: {progress}% - step: {step}")
        if progress_callback:
            try:
                progress_callback(progress, step)
                logger.info("[PERSONA] Progress callback succeeded")
            except Exception as e:
                logger.warning(f"[PERSONA] Progress callback failed: {e}")
    
    if not projects_table:
        logger.error("[PERSONA] Projects table not configured")
        raise ConfigurationError('Projects table not configured')
    
    # Extract filter parameters
    persona_count = filters.get('persona_count', 3)
    custom_instructions = filters.get('custom_instructions', '')
    generate_avatars = filters.get('generate_avatars', True)
    logger.info(f"[PERSONA] Config: persona_count={persona_count}, generate_avatars={generate_avatars}")
    
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

    # Get feedback data
    try:
        feedback_items = get_feedback_context(filters, limit=fetch_limit)
        logger.info(f"[PERSONA] Fetched {len(feedback_items) if feedback_items else 0} feedback items")
    except Exception as e:
        logger.error(f"[PERSONA] Failed to fetch feedback: {e}")
        raise
    
    if not feedback_items:
        logger.warning("[PERSONA] No feedback data found for filters")
        raise ValidationError('No feedback data found for the given filters')
    
    logger.info("[PERSONA] Step 2/6: Formatting feedback data for LLM...")
    update_progress(10, 'formatting_data')
    
    try:
        feedback_context = format_feedback_for_llm(feedback_items)
        feedback_stats = get_feedback_statistics(feedback_items)
        logger.info(f"[PERSONA] Formatted context: {len(feedback_context)} chars")
        logger.info(f"[PERSONA] Stats: {feedback_stats}")
    except Exception as e:
        logger.error(f"[PERSONA] Failed to format feedback: {e}")
        raise

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

    try:
        llm_start_time = time.time()

        logger.info("[PERSONA] Step 3/6: Building LLM chain steps from prompts...")
        update_progress(15, 'building_prompts')

        # Build chain steps from external prompt files
        try:
            chain_steps = get_persona_generation_steps(
                persona_count=persona_count,
                feedback_stats=feedback_stats,
                feedback_context=feedback_context,
                custom_instructions=custom_instructions,
                response_language=filters.get('response_language'),
                sample_chars=context_budget,
            )
            logger.info(f"[PERSONA] Built {len(chain_steps)} chain steps")
        except Exception as e:
            logger.error(f"[PERSONA] Failed to build chain steps: {e}")
            raise

        # Count what reached the step that WRITES the personas, off the built
        # prompt. Every cap between DynamoDB and the model is baked into this
        # number — the fetch limit, the budget above, and the {feedback_sample}
        # slot the synthesis step reads. Reporting the fetched count instead
        # would claim a full corpus while a narrower downstream cap had quietly
        # discarded most of it, which is the exact blindness #231 is about.
        feedback_items_used = count_persona_sample_records(chain_steps)
        context_truncated = feedback_items_used < len(feedback_items)
        if context_truncated:
            logger.warning(
                "[PERSONA] Personas synthesised from fewer items than were fetched",
                extra={
                    'items_fetched': len(feedback_items),
                    'items_used': feedback_items_used,
                    'corpus_chars': corpus_chars,
                    'budget_chars': context_budget,
                    'char_cap_applied': char_cap_applied,
                },
            )
        
        logger.info("[PERSONA] Step 4/6: Executing LLM chain (this may take several minutes)...")
        update_progress(20, 'executing_llm_chain')
        
        try:
            results = converse_chain(chain_steps, progress_callback=lambda p, s: update_progress(p, s), surface='documents')
            logger.info(f"[PERSONA] LLM chain returned {len(results)} results")
        except Exception as e:
            logger.error(f"[PERSONA] LLM chain execution failed: {e}")
            raise
        
        llm_time = int((time.time() - llm_start_time) * 1000)
        logger.info(f"[PERSONA] LLM chain completed in {llm_time}ms")
        
        logger.info("[PERSONA] Step 5/6: Parsing personas from LLM output...")
        # Locate the synthesis output BY STEP NAME, from the chain that was actually
        # built. Indexing positionally (results[-1]) was correct only while
        # get_persona_generation_steps happens to end on persona_synthesis: that
        # invariant lives in another file, and appending any trailing step there — a
        # re-added validation pass, a translation step — would silently make this parse
        # the wrong text and surface as the generic "failed to parse" error.
        #
        # Chain ordering still matters for a different reason, recorded in
        # get_persona_generation_steps: converse_chain keeps its results list local and
        # re-raises, so any step AFTER the one whose output is saved is a window where
        # finished, already-billed personas get discarded. Reading by name does not
        # weaken that — it just stops this line depending on it silently.
        personas_data = []
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
        synthesis_text = results[synthesis_index]
        logger.info(
            f"[PERSONA] Parsing '{PERSONA_SYNTHESIS_STEP}' output "
            f"(step {synthesis_index + 1}/{len(step_names)}), length: {len(synthesis_text)} chars"
        )
        json_match = re.search(r'\[\s*\{[\s\S]*\}\s*\]', synthesis_text)
        if json_match:
            try:
                parsed = json.loads(json_match.group())
                if isinstance(parsed, list) and len(parsed) > 0:
                    personas_data = parsed
                    logger.info(f"[PERSONA] Successfully parsed {len(personas_data)} personas")
            except json.JSONDecodeError as e:
                logger.warning(f"[PERSONA] JSON parse failed for persona_synthesis output: {e}")
        else:
            logger.warning("[PERSONA] No JSON array found in persona_synthesis output")

        if not personas_data:
            logger.error("[PERSONA] Failed to parse personas from any LLM output")
            raise ServiceError('Failed to parse persona data from LLM response')
        
        logger.info("[PERSONA] Step 6/6: Saving personas to database...")
        update_progress(80, 'saving_personas')

        # Replace semantics: delete any existing personas for this project first,
        # so re-running generation doesn't accumulate duplicates (e.g. "김지수" x2).
        # Without this, each generation appended a fresh set and @all roundtable
        # chat would have the same persona answer multiple times.
        existing_count = 0
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
                existing_count = len(existing)
                logger.info(f"[PERSONA] Cleared {existing_count} existing persona(s) before regeneration")
        except Exception as e:
            logger.warning(f"[PERSONA] Failed to clear existing personas (continuing): {e}")

        # Calculate source breakdown
        source_breakdown = {}
        for item in feedback_items:
            src = item.get('source_platform', 'unknown')
            source_breakdown[src] = source_breakdown.get(src, 0) + 1
        
        # Save personas to project. One tz-aware reading drives BOTH the stored
        # timestamps and the id stamp, so a persona id can never disagree with its own
        # created_at about which day it is. The id stamp previously came from a naive
        # datetime.now() (container-local) while created_at was UTC — and the id names
        # the S3 avatar key and sorts, so the skew was user-visible.
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        saved_personas = []

        # One id stamp for the whole batch: the per-persona index already makes
        # each id unique, and the avatar seed is derived from the id, so a stable
        # id keeps the same persona reproducing the same image.
        id_stamp = now_dt.strftime('%Y%m%d%H%M%S')

        # Build every persona item first, in parsed order. Avatars are attached
        # afterwards (concurrently) and the writes then follow this same order,
        # so which avatar call finishes first cannot reorder the personas.
        persona_items = []
        for i, persona in enumerate(personas_data):
            persona_id = f"persona_{id_stamp}_{i}"

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
                'avatar_url': None,
                'avatar_prompt': None,
                'created_at': now,
                'updated_at': now,
                'llm_metadata': {
                    'model': get_active_model_id('documents'),
                    'prompt_version': PERSONA_PROMPT_VERSION,
                    'generation_time_ms': llm_time
                },
            }
            
            persona_items.append((persona_id, persona, item))

        # Avatars: one unit of work per persona, run concurrently. Each call is
        # ~5s of waiting on Bedrock (prompt writer + image model) and they don't
        # touch each other, so a sequential loop just added 5s per persona — up
        # to 50s at the 10-persona ceiling validate_persona_count allows.
        # Failure stays isolated per persona: a persona whose avatar call raises
        # is still saved, with avatar_url/avatar_prompt left at None.
        if generate_avatars and persona_items:
            logger.info(f"[PERSONA] Generating {len(persona_items)} avatar(s) concurrently...")
            # One step for the whole batch, replacing the per-persona
            # 'generating_avatar_{i}' steps — they were sequential progress and the work
            # no longer is. No locale keys to add: the jobs panel renders the raw step
            # with `current_step.replaceAll('_', ' ')` (JobsSection.tsx) rather than
            # keying translations off it, so step names are not part of the i18n surface.
            update_progress(85, 'generating_avatars')

            # On tracing across the fan-out: `generate_persona_avatar` and its Bedrock legs
            # are @tracer-decorated, and under a Lambda context aws-xray-sdk's
            # put_subsegment re-resolves the segment per thread from _X_AMZN_TRACE_ID, so
            # worker subsegments should attach to the invocation with the right trace and
            # parent ids. A reviewer confirmed that empirically across three threads; it is
            # not pinned by a test here, because a test would be asserting aws-xray-sdk's
            # own context behaviour rather than anything this repo controls. If the avatar
            # leg ever goes missing from X-Ray after an sdk upgrade, this is the reason to
            # check first. Recorded because "subsegments on non-main threads are dropped"
            # is true of some X-Ray setups and has been raised against this block
            # repeatedly.
            def _avatar_for(persona_id: str, persona: dict) -> dict:
                return generate_persona_avatar({'persona_id': persona_id, **persona})

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

            with ThreadPoolExecutor(max_workers=min(len(persona_items), AVATAR_MAX_CONCURRENCY)) as pool:
                # Submitted in a guarded loop rather than a dict comprehension: a
                # comprehension puts pool.submit outside the per-future try, so a
                # RuntimeError("can't start new thread") would propagate and discard
                # EVERY persona — the same "billed work thrown away" shape this change
                # set out to remove, just relocated from the chain to the executor.
                futures = {}
                for persona_id, persona, item in persona_items:
                    try:
                        futures[pool.submit(_avatar_for, persona_id, persona)] = item
                    except RuntimeError as e:
                        _count_avatar_failure(item['persona_id'], f'could not start a worker: {e}')

                for future, item in futures.items():
                    try:
                        avatar_result = future.result()
                        item['avatar_url'] = avatar_result.get('avatar_url')
                        item['avatar_prompt'] = avatar_result.get('avatar_prompt')
                        # Count the EFFECTIVE outcome, not just the exception. Most
                        # failures never raise here: shared.avatar.generate_persona_avatar
                        # catches throttling, AccessDenied, ValidationException and the
                        # empty-images case itself and RETURNS avatar_url=None. A counter
                        # placed only in the except branch would therefore read zero
                        # during exactly the outage it exists to catch.
                        if item['avatar_url']:
                            metrics.add_metric(name='AvatarGenerationSucceeded', unit='Count', value=1)
                            logger.info(
                                f"[PERSONA] Avatar generated for {item['persona_id']}: {item['avatar_url']}"
                            )
                        else:
                            _count_avatar_failure(
                                item['persona_id'], 'the generator returned no avatar URL'
                            )
                    except Exception as e:
                        _count_avatar_failure(item['persona_id'], str(e))

        # Write in parsed order so the stored order and the response order match
        # the LLM's order regardless of avatar completion order.
        for i, (persona_id, persona, item) in enumerate(persona_items):
            logger.info(f"[PERSONA] Saving persona {i+1}/{len(persona_items)}: {persona.get('name', 'unnamed')}")
            projects_table.put_item(Item=item)
            saved_personas.append(item)
            logger.info(f"[PERSONA] Saved persona: {persona.get('name')}")

        # Set persona count to the new total (we cleared the old set above, so
        # this is a replace, not an increment — keeps the count accurate).
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = :count, updated_at = :now',
            ExpressionAttributeValues={':count': len(saved_personas), ':now': now}
        )
        
        overall_elapsed = time.time() - overall_start
        logger.info("[PERSONA] ========== PERSONA GENERATION COMPLETE ==========")
        logger.info(f"[PERSONA] Total time: {overall_elapsed:.2f}s, Personas created: {len(saved_personas)}")
        
        return {
            'success': True,
            'personas': saved_personas,
            # No 'validation' key: the chain's third step is gone (it was the
            # single largest cost in the job and nothing read its output — this
            # response shape's only consumer, the jobs panel, reads persona_id,
            # document_id and title).
            'analysis': {
                'research': results[0],
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
                'fetch_limit_reached': fetch_limit_reached,
                'fetch_limit': fetch_limit,
                'source_breakdown': source_breakdown,
                'generation_time_ms': llm_time
            }
        }

    except Exception as e:
        overall_elapsed = time.time() - overall_start
        logger.exception(f"[PERSONA] FAILED after {overall_elapsed:.2f}s: {type(e).__name__}: {e}")
        # Bedrock reports an oversized prompt as a ValidationException. Name the
        # knob in that case instead of the generic "try again", which sends an
        # operator into an identical retry: a context that does not fit will not
        # fit on the second attempt either.
        if _is_oversized_input_error(e):
            # The operator-facing half — which internal knob to turn — goes to
            # the log, where an operator is. The message returned to the API
            # reaches an end user in the browser, who can act on filters and the
            # model picker but cannot set a Lambda environment variable, and for
            # whom an env-var name is an internal detail leaking into the UI.
            logger.error(
                "[PERSONA] Corpus exceeded the resolved model's context window",
                extra={
                    'budget_chars': context_budget,
                    'fetch_limit': fetch_limit,
                    'items_fetched': len(feedback_items),
                    'tuning_env_vars': [
                        ENV_MAX_PERSONA_CONTEXT_CHARS,
                        ENV_FEEDBACK_LIMIT_PERSONA,
                    ],
                },
            )
            raise ServiceError(
                'The selected feedback was too large for the configured model. '
                'Narrow the filters — a shorter date range, or fewer sources — '
                'or choose a model with a larger context window in Settings.'
            )
        raise ServiceError('Failed to generate personas. Please try again.')


@tracer.capture_method
def generate_prd(project_id: str, body: dict) -> dict:
    """Generate a Product Requirements Document using multi-step LLM chain.

    LEGACY — NOT REACHED IN A DEPLOYED SYSTEM. ``projects_handler.py`` does not
    import this function, and ``POST /projects/{id}/document`` routes document
    generation to ``lambda/jobs/document_generator/handler.py``, which performs
    its own independent fetch and applies its own caps (``limit=100``, then
    ``feedback_items[:30]`` and ``original_text[:300]``).

    Consequently the issue-#231 fix deliberately does NOT touch the limit here:
    changing it would have no user-visible effect while reading in the diff as
    if the PRD surface had been fixed. Fixing the live document path — and the
    research path in ``lambda/research/research_step_handler.py``, which still
    caps at ``limit=50`` and a bare 50 000-char slice — is left to a follow-up
    that can carry the shared constants into those Lambdas. Do not delete this
    function as part of that work without checking the MCP handler and any
    plugin entry points first.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get project data including personas - exceptions will propagate
    project_data = get_project(project_id)
    
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})
    
    # Get feedback context
    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_PRD)
    feedback_context = format_feedback_for_llm(feedback_items)

    # Format personas for context
    personas_context = ""
    for p in personas:
        personas_context += f"""
**{p.get('name')}** - {p.get('tagline', '')}
- Quote: "{p.get('quote', '')}"
- Goals: {', '.join(p.get('goals', [])[:3])}
- Frustrations: {', '.join(p.get('frustrations', [])[:3])}
"""

    feature_idea = body.get('feature_idea', 'Improve customer experience based on feedback')

    # Inject the per-project product/service context (structured fields + uploaded internal docs).
    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    # Build chain steps from external prompt files
    chain_steps = get_prd_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')
        
        # Save PRD
        now = datetime.now(timezone.utc).isoformat()
        prd_id = f"prd_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRD#{prd_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': prd_id,
            'document_type': 'prd',
            'title': body.get('title', f'PRD: {feature_idea[:50]}'),
            'feature_idea': feature_idea,
            'content': results[2],
            'analysis': {
                'problem': results[0],
                'solution': results[1]
            },
            'created_at': now,
        }
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"PRD generation failed: {e}")
        raise ServiceError('Failed to generate PRD. Please try again.')


@tracer.capture_method
def autofill_prfaq_questions(project_id: str, body: dict) -> dict:
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

    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_AUTOFILL)
    feedback_context = format_feedback_for_llm(feedback_items)

    personas_context = ""
    for p in personas:
        personas_context += (
            f"\n**{p.get('name')}** — {p.get('tagline', '')}\n"
            f"Quote: \"{p.get('quote', '')}\"\n"
            f"Goals: {', '.join(p.get('goals', [])[:3])}\n"
            f"Frustrations: {', '.join(p.get('frustrations', [])[:3])}\n"
        )

    feature_idea = (body or {}).get('feature_idea', '').strip()
    title = (body or {}).get('title', '').strip()
    response_language = (body or {}).get('response_language')

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

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

    # Parse JSON, tolerating fences if the model includes them.
    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
        answers = parsed.get('answers', [])
    except json.JSONDecodeError:
        logger.warning(f"Autofill JSON parse failed; returning best-effort. raw={text[:200]}")
        answers = []

    if not isinstance(answers, list):
        answers = []
    cleaned = [(a if isinstance(a, str) else '').strip() for a in answers]
    while len(cleaned) < 5:
        cleaned.append('')
    return {'answers': cleaned[:5]}


@tracer.capture_method
def suggest_document_brief(project_id: str, body: dict) -> dict:
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

    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_BRIEF)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    doc_type = (body or {}).get('doc_type', 'prd')
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

    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"Document-brief JSON parse failed; raw={text[:200]}")
        parsed = {}

    title = (parsed.get('title') or '').strip() if isinstance(parsed, dict) else ''
    feature_idea = (parsed.get('feature_idea') or '').strip() if isinstance(parsed, dict) else ''
    return {'title': title, 'feature_idea': feature_idea}


@tracer.capture_method
def suggest_research_questions(project_id: str, body: dict) -> dict:
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
    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_RESEARCH_SUGGEST)
    feedback_context = format_feedback_for_llm(feedback_items)
    feedback_stats = get_feedback_statistics(feedback_items) if feedback_items else "(no feedback yet)"

    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

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

    text = (raw or '').strip()
    if text.startswith('```'):
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    try:
        parsed = json.loads(text)
        suggestions = parsed.get('suggestions', [])
    except json.JSONDecodeError:
        logger.warning(f"Research-suggest JSON parse failed; raw={text[:200]}")
        suggestions = []

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
def generate_prfaq(project_id: str, body: dict) -> dict:
    """Generate an Amazon-style PR/FAQ document using multi-step LLM chain.

    LEGACY — NOT REACHED IN A DEPLOYED SYSTEM; see :func:`generate_prd` for why
    ``FEEDBACK_LIMIT_PRFAQ`` is left at its historical value.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get project data including personas - exceptions will propagate
    project_data = get_project(project_id)
    
    personas = project_data.get('personas', [])
    filters = project_data.get('project', {}).get('filters', {})
    
    # Get feedback context
    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_PRFAQ)
    feedback_context = format_feedback_for_llm(feedback_items)

    # Format personas
    personas_context = ""
    for p in personas:
        personas_context += f"""
**{p.get('name')}**: {p.get('tagline', '')}
Quote: "{p.get('quote', '')}"
"""
    
    feature_idea = body.get('feature_idea', 'New feature based on customer feedback')

    # Inject the per-project product/service context (structured fields + uploaded internal docs).
    try:
        from product_context import build_product_context_block
        product_context = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context = "(No product context provided.)"

    # Build chain steps from external prompt files
    chain_steps = get_prfaq_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=body.get('response_language'),
    )

    try:
        results = converse_chain(chain_steps, surface='documents')
        
        # Combine into final document
        full_document = f"""# PR/FAQ: {feature_idea}

## Press Release

{results[1]}

---

## Frequently Asked Questions

### Customer FAQ

{results[2]}

### Internal FAQ

{results[3]}
"""
        
        # Save PR/FAQ
        now = datetime.now(timezone.utc).isoformat()
        prfaq_id = f"prfaq_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        item = {
            'pk': f'PROJECT#{project_id}',
            'sk': f'PRFAQ#{prfaq_id}',
            'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
            'gsi1sk': now,
            'document_id': prfaq_id,
            'document_type': 'prfaq',
            'title': body.get('title', f'PR/FAQ: {feature_idea[:50]}'),
            'feature_idea': feature_idea,
            'content': full_document,
            'sections': {
                'customer_insights': results[0],
                'press_release': results[1],
                'customer_faq': results[2],
                'internal_faq': results[3]
            },
            'created_at': now,
        }
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"PR/FAQ generation failed: {e}")
        raise ServiceError('Failed to generate PR/FAQ. Please try again.')


@tracer.capture_method
def create_document(project_id: str, body: dict) -> dict:
    """Create a custom document in the project."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    title = body.get('title', 'Untitled Document')
    content = body.get('content', '')
    document_type = body.get('document_type', 'custom')
    
    if not content:
        raise ValidationError('Content is required')
    
    now = datetime.now(timezone.utc).isoformat()
    doc_id = f"doc_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    item = {
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
    
    projects_table.put_item(Item=item)
    
    # Update document count
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True, 'document': item}


@tracer.capture_method
def update_document(project_id: str, document_id: str, body: dict) -> dict:
    """Update a document."""
    from boto3.dynamodb.conditions import Attr
    
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET updated_at = :now'
    expr_values = {':now': now}
    expr_names = {}
    
    if 'title' in body:
        update_expr += ', title = :title'
        expr_values[':title'] = body['title']
    if 'content' in body:
        update_expr += ', #content = :content'
        expr_values[':content'] = body['content']
        expr_names['#content'] = 'content'
    
    # Find the SK for this document
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        FilterExpression=Attr('document_id').eq(document_id)
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Document not found')
    
    sk = items[0].get('sk')
    
    update_params = {
        'Key': {'pk': f'PROJECT#{project_id}', 'sk': sk},
        'UpdateExpression': update_expr,
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    projects_table.update_item(**update_params)
    
    return {'success': True}


@tracer.capture_method
def delete_document(project_id: str, document_id: str) -> dict:
    """Delete a document."""
    from boto3.dynamodb.conditions import Attr
    
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Find the SK for this document
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        FilterExpression=Attr('document_id').eq(document_id)
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError('Document not found')
    
    sk = items[0].get('sk')
    
    projects_table.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': sk})
    
    # Update document count
    now = datetime.now(timezone.utc).isoformat()
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = document_count - :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True}


# ============================================================================
# Persona CRUD Operations
# ============================================================================

@tracer.capture_method
def create_persona(project_id: str, body: dict) -> dict:
    """Create a new persona manually."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    name = body.get('name', 'New Persona')
    
    now = datetime.now(timezone.utc).isoformat()
    persona_id = f"persona_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    item = {
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
    
    projects_table.put_item(Item=item)
    
    # Update persona count
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET persona_count = persona_count + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':now': now}
    )
    
    return {'success': True, 'persona': item}


@tracer.capture_method
def update_persona(project_id: str, persona_id: str, body: dict) -> dict:
    """Update a persona with support for all 8 sections."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Fix persona name if provided
    if 'name' in body and body['name']:
        body['name'] = fix_persona_name(body['name'])
    
    now = datetime.now(timezone.utc).isoformat()
    
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
        'ExpressionAttributeValues': expr_values,
    }
    if expr_names:
        update_params['ExpressionAttributeNames'] = expr_names
    
    try:
        projects_table.update_item(**update_params)
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update persona: {e}")
        raise ServiceError('Failed to update persona')


@tracer.capture_method
def add_persona_note(project_id: str, persona_id: str, body: dict) -> dict:
    """Add a research note to a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    note_text = body.get('text', '')
    if not note_text:
        raise ValidationError('Note text is required')
    
    now = datetime.now(timezone.utc).isoformat()
    note_id = f"note_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
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
            ExpressionAttributeValues={
                ':note': [new_note],
                ':empty': [],
                ':now': now
            }
        )
        return {'success': True, 'note': new_note}
    except Exception as e:
        logger.exception(f"Failed to add persona note: {e}")
        raise ServiceError('Failed to add note')


@tracer.capture_method
def update_persona_note(project_id: str, persona_id: str, note_id: str, body: dict) -> dict:
    """Update a research note on a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        raise NotFoundError('Note not found')
    
    now = datetime.now(timezone.utc).isoformat()
    
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
        
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names if expr_names else None
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update persona note: {e}")
        raise ServiceError('Failed to update note')


@tracer.capture_method
def delete_persona_note(project_id: str, persona_id: str, note_id: str) -> dict:
    """Delete a research note from a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get current persona to find the note index
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    notes = item.get('research_notes', [])
    note_index = None
    
    for i, note in enumerate(notes):
        if note.get('note_id') == note_id:
            note_index = i
            break
    
    if note_index is None:
        raise NotFoundError('Note not found')
    
    now = datetime.now(timezone.utc).isoformat()
    
    try:
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression=f'REMOVE research_notes[{note_index}] SET updated_at = :now',
            ExpressionAttributeValues={':now': now}
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete persona note: {e}")
        raise ServiceError('Failed to delete note')


@tracer.capture_method
def regenerate_persona_avatar(project_id: str, persona_id: str) -> dict:
    """Regenerate the avatar for a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    # Get persona data
    response = projects_table.get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
    )
    
    item = response.get('Item')
    if not item:
        raise NotFoundError('Persona not found')
    
    # Generate new avatar
    avatar_result = generate_persona_avatar(item)
    
    if not avatar_result.get('avatar_url'):
        raise ServiceError('Avatar generation failed')
    
    # Update persona with new avatar
    now = datetime.now(timezone.utc).isoformat()
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'},
        UpdateExpression='SET avatar_url = :url, avatar_prompt = :prompt, updated_at = :now',
        ExpressionAttributeValues={
            ':url': avatar_result['avatar_url'],
            ':prompt': avatar_result['avatar_prompt'],
            ':now': now
        }
    )
    
    return {
        'success': True,
        'avatar_url': avatar_result['avatar_url'],
        'avatar_prompt': avatar_result['avatar_prompt']
    }


@tracer.capture_method
def delete_persona(project_id: str, persona_id: str) -> dict:
    """Delete a persona."""
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    try:
        projects_table.delete_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'PERSONA#{persona_id}'}
        )
        
        # Update persona count
        now = datetime.now(timezone.utc).isoformat()
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET persona_count = persona_count - :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete persona: {e}")
        raise ServiceError('Failed to delete persona')


@tracer.capture_method
def run_research(project_id: str, body: dict) -> dict:
    """Run deep research analysis on feedback data.

    FALLBACK PATH ONLY. ``projects_handler.py`` prefers the Step Functions
    research workflow whenever ``RESEARCH_STATE_MACHINE_ARN`` is set, and
    ``lib/stacks/api-stack.ts`` sets it unconditionally — so in a real
    deployment the live path is ``lambda/research/research_step_handler.py``,
    which has its own ``limit=50`` and its own 50 000-char truncation. That is
    why ``FEEDBACK_LIMIT_RESEARCH`` is left at its historical value here; see
    :func:`generate_prd`.
    """
    if not projects_table:
        raise ConfigurationError('Projects table not configured')
    
    research_question = body.get('question', 'What are the main customer pain points?')
    
    # Get project data - exceptions will propagate
    project_data = get_project(project_id)
    
    # Use filters from request body, fallback to project filters
    filters = {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30)
    }
    # If no filters provided, use project defaults
    if not any([filters['sources'], filters['categories'], filters['sentiments']]):
        filters = project_data.get('project', {}).get('filters', filters)
    
    # Get feedback for research - this is the PRIMARY data source
    logger.info(f"Fetching feedback with filters: {filters}")
    feedback_items = get_feedback_context(filters, limit=FEEDBACK_LIMIT_RESEARCH)
    logger.info(f"Found {len(feedback_items)} feedback items for research")
    
    if not feedback_items:
        raise ValidationError('No feedback data found matching the filters. Try adjusting your filter criteria.')
    
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
        now = datetime.now(timezone.utc).isoformat()
        research_id = f"research_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        
        # Build comprehensive research report from all steps
        full_report = f"""# Research Report: {research_question}

**Generated:** {now[:10]}
**Feedback Analyzed:** {len(feedback_items)} items
**Filters:** Sources: {', '.join(filters.get('sources', [])) or 'All'} | Categories: {', '.join(filters.get('categories', [])) or 'All'} | Sentiments: {', '.join(filters.get('sentiments', [])) or 'All'} | Days: {filters.get('days', 30)}

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
        
        item = {
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
            'created_at': now,
        }
        
        logger.info(f"Saving research document, content size: {len(full_report)} chars, feedback items: {len(feedback_items)}")
        projects_table.put_item(Item=item)
        
        # Update document count
        projects_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
            UpdateExpression='SET document_count = document_count + :one, updated_at = :now',
            ExpressionAttributeValues={':one': 1, ':now': now}
        )
        
        return {'success': True, 'document': item}
        
    except Exception as e:
        logger.exception(f"Research failed: {e}")
        raise ServiceError('Failed to run research. Please try again.')


def _slugify(text: str) -> str:
    """Convert text to a URL/filename-safe slug."""
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    return slug.strip('-')[:80]


def _persona_to_markdown(persona: dict) -> str:
    """Format a persona dict as a standalone markdown document."""
    name = persona.get('name', 'Unknown')
    tagline = persona.get('tagline', '')
    lines = [f'# {name}', '']
    if tagline:
        lines.append(f'**{tagline}**')
        lines.append('')

    # Representative quotes
    quotes = persona.get('quotes', [])
    if quotes:
        for q in quotes[:3]:
            text = q.get('text', q) if isinstance(q, dict) else q
            lines.append(f'> "{text}"')
        lines.append('')

    # Identity & Demographics
    identity = persona.get('identity', {})
    if identity:
        lines.append('## Demographics')
        for key in ('age_range', 'location', 'occupation', 'income_bracket', 'education', 'family_status'):
            val = identity.get(key)
            if val:
                label = key.replace('_', ' ').title()
                lines.append(f'- **{label}:** {val}')
        bio = identity.get('bio')
        if bio:
            lines.extend(['', bio])
        lines.append('')

    # Goals & Motivations
    goals = persona.get('goals_motivations', {})
    if goals:
        lines.append('## Goals & Motivations')
        primary = goals.get('primary_goal')
        if primary:
            lines.append(f'- **Primary Goal:** {primary}')
        for g in goals.get('secondary_goals', []):
            lines.append(f'- {g}')
        success = goals.get('success_definition')
        if success:
            lines.append(f'- **Success:** {success}')
        lines.append('')

    # Pain Points
    pains = persona.get('pain_points', {})
    if pains:
        lines.append('## Pain Points & Frustrations')
        for p in pains.get('current_challenges', []):
            lines.append(f'- {p}')
        emotional = pains.get('emotional_impact')
        if emotional:
            lines.append(f'- **Emotional Impact:** {emotional}')
        lines.append('')

    # Behaviors
    behaviors = persona.get('behaviors', {})
    if behaviors:
        lines.append('## Behaviors & Habits')
        for key in ('activity_frequency', 'tech_savviness', 'decision_style'):
            val = behaviors.get(key)
            if val:
                label = key.replace('_', ' ').title()
                lines.append(f'- **{label}:** {val}')
        for tool in behaviors.get('tools_used', []):
            lines.append(f'- Uses: {tool}')
        lines.append('')

    # Scenario
    scenario = persona.get('scenario', {})
    if scenario:
        title = scenario.get('title')
        narrative = scenario.get('narrative')
        if title or narrative:
            lines.append('## Scenario')
            if title:
                lines.append(f'**{title}**')
                lines.append('')
            if narrative:
                lines.append(narrative)
            lines.append('')

    return '\n'.join(lines)


def _document_to_markdown(doc: dict) -> str:
    """Format a project document as markdown (content is already markdown)."""
    title = doc.get('title', 'Untitled')
    content = doc.get('content', '')
    # If content already starts with a heading, use it as-is
    if content.strip().startswith('#'):
        return content
    return f'# {title}\n\n{content}'


def _build_steering_file(project: dict, personas: list, documents: list) -> str:
    """Generate a Kiro steering file from project data."""
    name = project.get('name', 'Project')
    description = project.get('description', '')
    # Use `or ''` instead of a default arg so that a stored None (DynamoDB NULL)
    # is treated as absent rather than raising AttributeError on .strip().
    stored_prompt = (project.get('kiro_export_prompt') or '').strip()
    kiro_prompt = stored_prompt if stored_prompt else KIRO_DEFAULT_EXPORT_PROMPT

    lines = [f'# {name} — Implementation Context', '']
    if description:
        lines.extend([description, ''])

    # Personas section
    if personas:
        lines.append('## Personas')
        lines.append('')
        lines.append(f'This project has {len(personas)} personas. When building features:')
        lines.append('- Consider which persona the feature serves')
        lines.append('- Reference their goals, frustrations, and needs')
        lines.append('- Use their quotes to validate UX decisions')
        lines.append('')
        lines.append('Available personas:')
        for p in personas:
            pname = p.get('name', 'Unknown')
            tagline = p.get('tagline', '')
            lines.append(f'- **{pname}** — {tagline}')
        lines.append('')

    # Documents section
    if documents:
        lines.append('## Documents')
        lines.append('')
        lines.append('Project documents:')
        for d in documents:
            dtitle = d.get('title', 'Untitled')
            dtype = d.get('document_type', 'custom')
            lines.append(f'- {dtitle} ({dtype})')
        lines.append('')
        lines.append('Use PRDs for acceptance criteria and scope. Use PR/FAQs for customer-facing messaging.')
        lines.append('')

    # Custom instructions (always present: either the project's own or the default)
    lines.append('## Custom Instructions')
    lines.append('')
    lines.append(kiro_prompt)
    lines.append('')

    return '\n'.join(lines)


# Document types that must never appear in a Kiro export payload.
# Prototypes are generated HTML artifacts (or S3-backed rendered pages with no
# text content) — exporting them anchors the coding agent on stale output.
# DocumentExportMenu.tsx already returns null for S3-only prototypes; this
# exclusion makes the two export paths agree rather than contradict each other.
# This set is the backend authority; the frontend constant must match it
# (enforced by test_kiro_exportable_types_lockstep.py).
KIRO_EXPORT_EXCLUDED_TYPES: frozenset[str] = frozenset({'prototype'})


@tracer.capture_method
def autoseed_project(project_id: str, persona_ids: list[str] | None = None, document_ids: list[str] | None = None) -> dict:
    """Generate a Kiro autoseed payload with selected project context as files.

    Args:
        project_id: The project to export.
        persona_ids: Optional list of persona IDs to include. None means all.
        document_ids: Optional list of document IDs to include. None means all.

    Documents whose document_type is in KIRO_EXPORT_EXCLUDED_TYPES are always
    dropped, even if their ids appear in document_ids.
    """
    project_data = get_project(project_id)
    project = project_data['project']
    all_personas = project_data['personas']
    all_documents = project_data['documents']

    # Filter to selected items (None = include all), then strip excluded types.
    # The type filter is applied AFTER the id filter so an explicitly requested
    # prototype id is also dropped — callers cannot bypass the exclusion.
    personas = all_personas if persona_ids is None else [
        p for p in all_personas if p.get('persona_id') in persona_ids
    ]
    candidate_docs = all_documents if document_ids is None else [
        d for d in all_documents if d.get('document_id') in document_ids
    ]
    documents = [
        d for d in candidate_docs
        if d.get('document_type') not in KIRO_EXPORT_EXCLUDED_TYPES
    ]

    project_name = project.get('name', 'project')
    project_slug = _slugify(project_name)

    files = []

    # Persona files
    for persona in personas:
        persona_slug = _slugify(persona.get('name', 'unknown'))
        files.append({
            'path': f'.kiro/personas/{persona_slug}.md',
            'content': _persona_to_markdown(persona),
        })

    # Document files
    for doc in documents:
        doc_slug = _slugify(doc.get('title', 'untitled'))
        files.append({
            'path': f'.kiro/docs/{doc_slug}.md',
            'content': _document_to_markdown(doc),
        })

    # Steering file (generated last so it can reference the above)
    steering_content = _build_steering_file(project, personas, documents)
    files.insert(0, {
        'path': f'.kiro/steering/project-{project_slug}.md',
        'content': steering_content,
    })

    return {
        'project': {
            'name': project_name,
            'description': project.get('description', ''),
        },
        'files': files,
    }
