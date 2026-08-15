"""
Projects API Lambda Handler
Separate Lambda to handle projects endpoints and avoid policy size limits.
"""

import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any

from shared.logging import logger, tracer
from shared.aws import invoke_lambda_async
from shared.api import (
    create_api_resolver,
    validate_days,
    validate_int,
    validate_bool,
    api_handler,
    validate_date_basis,
    MAX_PERSONAS_PER_GENERATION,
)
from shared.tables import get_jobs_table, get_aggregates_table, get_projects_table
from shared.jobs import create_job
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.persona_import import validate_import_config
from shared.tokens import hash_token

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
import boto3

from projects import (
    list_projects, create_project, get_project, update_project, delete_project,
    run_research,
    create_document, update_document, delete_document,
    create_persona, update_persona, delete_persona,
    add_persona_note, update_persona_note, delete_persona_note,
    regenerate_persona_avatar,
    autoseed_project,
    autofill_prfaq_questions,
    suggest_research_questions,
    suggest_document_brief,
)
from product_context import (
    get_context as pc_get_context,
    update_context as pc_update_context,
    interview_turn as pc_interview_turn,
    list_docs as pc_list_docs,
    create_upload_url as pc_create_upload_url,
    delete_doc as pc_delete_doc,
    # Imported rather than re-declared: the `sk` prefix a product doc is written
    # under is the same string that has to be read back to validate a selection,
    # and a second copy of the literal here would be a silent partition split.
    DOC_SK_PREFIX as PRODUCT_DOC_SK_PREFIX,
    # Same reasoning, and it earned it: this bound was declared here and the
    # visual-brief character budget was chosen independently over there, so the
    # budget silently refused the FOURTH visual the bound had already allowed.
    # The budget is now derived from this number, which is why the number lives
    # beside it.
    MAX_SELECTED_PRODUCT_DOC_IDS,
)

# API resolver with standard CORS
app = create_api_resolver()

# Environment - Job Lambda function names
PERSONA_GENERATOR_FUNCTION = os.environ.get('PERSONA_GENERATOR_FUNCTION', '')
DOCUMENT_GENERATOR_FUNCTION = os.environ.get('DOCUMENT_GENERATOR_FUNCTION', '')
DOCUMENT_MERGER_FUNCTION = os.environ.get('DOCUMENT_MERGER_FUNCTION', '')
PERSONA_IMPORTER_FUNCTION = os.environ.get('PERSONA_IMPORTER_FUNCTION', '')


def validate_persona_count(value, default=3):
    """Validate persona count parameter.

    The ceiling is shared: the avatar fan-out's worker count and the image-model client's
    connection pool both size themselves against it, so it cannot live here as a literal.
    """
    return validate_int(
        value, default=default, min_val=1, max_val=MAX_PERSONAS_PER_GENERATION
    )


# ============================================
# Project CRUD Routes
# ============================================

@app.get("/projects/config")
@tracer.capture_method
def api_get_config():
    return {'chat_stream_url': os.environ.get('CHAT_STREAM_URL', '')}


@app.get("/projects")
@tracer.capture_method
def api_list_projects():
    return list_projects()


@app.post("/projects")
@tracer.capture_method
def api_create_project():
    return create_project(app.current_event.json_body)


@app.get("/projects/<project_id>")
@tracer.capture_method
def api_get_project(project_id: str):
    return get_project(project_id)


@app.put("/projects/<project_id>")
@tracer.capture_method
def api_update_project(project_id: str):
    return update_project(project_id, app.current_event.json_body)


@app.delete("/projects/<project_id>")
@tracer.capture_method
def api_delete_project(project_id: str):
    return delete_project(project_id)


@app.get("/projects/<project_id>/autoseed")
@tracer.capture_method
def api_autoseed_project(project_id: str):
    params = app.current_event.query_string_parameters or {}
    persona_ids = params.get('persona_ids', '').split(',') if params.get('persona_ids') else None
    document_ids = params.get('document_ids', '').split(',') if params.get('document_ids') else None
    return autoseed_project(project_id, persona_ids=persona_ids, document_ids=document_ids)


# ============================================
# Persona Routes
# ============================================

@app.post("/projects/<project_id>/personas")
@tracer.capture_method
def api_create_persona(project_id: str):
    return create_persona(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/personas/import")
@tracer.capture_method
def api_import_persona(project_id: str):
    """Import a persona from an image or pasted text - runs as background job."""
    body = app.current_event.json_body or {}
    content = body.get('content', '')
    media_type = body.get('media_type', '')
    # INVARIANT (tested): validated BEFORE create_job, so a refused import leaves
    # no job row behind, no Lambda invoke and no Bedrock spend. Rejecting only
    # inside the job would still cost all three per attempt, and the user would
    # watch a job run and fail instead of being told at the click. The rules live
    # in shared/persona_import.py because the job checks them again.
    input_type = validate_import_config(body.get('input_type'), content, media_type)
    config = {
        'input_type': input_type,
        'content': content,
        'media_type': media_type
    }
    job_id, _ = create_job(project_id, 'import_persona', 'import_config', config)
    invoke_lambda_async(PERSONA_IMPORTER_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'import_config': config
    })
    return {'success': True, 'job_id': job_id, 'status': 'running', 'message': 'Persona import started.'}


@app.put("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_update_persona(project_id: str, persona_id: str):
    return update_persona(project_id, persona_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/personas/<persona_id>")
@tracer.capture_method
def api_delete_persona(project_id: str, persona_id: str):
    return delete_persona(project_id, persona_id)


@app.post("/projects/<project_id>/personas/<persona_id>/notes")
@tracer.capture_method
def api_add_persona_note(project_id: str, persona_id: str):
    return add_persona_note(project_id, persona_id, app.current_event.json_body)


@app.put("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_update_persona_note(project_id: str, persona_id: str, note_id: str):
    return update_persona_note(project_id, persona_id, note_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/personas/<persona_id>/notes/<note_id>")
@tracer.capture_method
def api_delete_persona_note(project_id: str, persona_id: str, note_id: str):
    return delete_persona_note(project_id, persona_id, note_id)


@app.post("/projects/<project_id>/personas/<persona_id>/regenerate-avatar")
@tracer.capture_method
def api_regenerate_persona_avatar(project_id: str, persona_id: str):
    return regenerate_persona_avatar(project_id, persona_id)


@app.post("/projects/<project_id>/personas/generate")
@tracer.capture_method
def api_generate_personas(project_id: str):
    """Start async persona generation."""
    body = app.current_event.json_body or {}
    filters = {
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30),
        'date_basis': validate_date_basis(body.get('date_basis')),
        'persona_count': validate_persona_count(body.get('persona_count')),
        'custom_instructions': body.get('custom_instructions', ''),
        # Forward the user's selected language so the persona generator's Bedrock
        # call emits Korean (or whatever locale) names + descriptions, matching
        # the rest of the project. Without this, generated personas were always
        # English even when Settings → Language was set to 한국어.
        'response_language': body.get('response_language'),
        # generate_personas already honoured this flag, but it never reached the filters
        # dict, so every request paid for the image model.
        #
        # Validated, not coerced. Every other field here is defaulted or validated, and
        # this one gates billed image-model calls: `"false"` from a form post or an
        # over-eager serialiser means "no avatars" to the caller, so accepting it as True
        # bills N image generations nobody asked for, silently. So an explicit
        # non-boolean is a 400, while an omitted field still means "avatars on" and no
        # existing client changes behaviour. (JSON `null` reads as absent — dict.get
        # cannot tell it from a missing key.)
        #
        # Deliberately API/script-only: no SPA caller sends it, and the frontend type
        # does not declare it. The dashboard always wants avatars, so there is no UI to
        # add; this exists for scripted and backfill callers that want personas without
        # paying for images. Not an oversight — if the SPA ever grows a "skip avatars"
        # toggle, that is when the field earns a place in the TS type.
        'generate_avatars': validate_bool(
            body.get('generate_avatars'), default=True, field='generate_avatars'
        ),
    }
    job_id, _ = create_job(project_id, 'generate_personas', 'filters', filters, ttl_minutes=30*24*60)
    invoke_lambda_async(PERSONA_GENERATOR_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'filters': filters
    })
    return {'success': True, 'job_id': job_id, 'status': 'running', 'message': 'Persona generation started.'}


# ============================================
# Document Routes
# ============================================

@app.post("/projects/<project_id>/research")
@tracer.capture_method
def api_run_research(project_id: str):
    """Start research via Step Functions."""
    body = app.current_event.json_body or {}
    research_config = {
        'question': body.get('question', 'What are the main customer pain points?'),
        'title': body.get('title', ''),
        'sources': body.get('sources', []),
        'categories': body.get('categories', []),
        'sentiments': body.get('sentiments', []),
        'days': validate_days(body.get('days'), default=30),
        'date_basis': validate_date_basis(body.get('date_basis')),
        'selected_persona_ids': body.get('selected_persona_ids', []),
        'selected_document_ids': body.get('selected_document_ids', []),
        'response_language': body.get('response_language'),
        # Strict boolean check (mirrors the stream side's Zod validation):
        # bool() coercion would turn the string "false" into True and
        # silently enable a billed feature.
        'use_web_search': body.get('use_web_search') is True,
        'filters': body
    }
    job_id, _ = create_job(project_id, 'research', 'research_config', research_config, status='pending')
    
    state_machine_arn = os.environ.get('RESEARCH_STATE_MACHINE_ARN', '')
    if state_machine_arn:
        boto3.client('stepfunctions').start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({'job_id': job_id, 'project_id': project_id, 'research_config': research_config})
        )
    else:
        return run_research(project_id, body)
    
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Research started.'}


@app.post("/projects/<project_id>/document")
@tracer.capture_method
def api_generate_document(project_id: str):
    """Generate PRD or PR-FAQ document.

    Runs as a Step Functions workflow when DOCUMENT_STATE_MACHINE_ARN is set:
    each LLM step is its own Lambda invocation, so long CJK documents don't
    overrun the 15-minute Lambda ceiling. Falls back to the legacy single-shot
    async Lambda invoke when the state machine isn't configured.

    `build_prototype` and `product_report` doc_types stay on the single-shot
    Lambda path (they aren't multi-step LLM chains).
    """
    body = app.current_event.json_body or {}
    doc_type = body.get('doc_type', 'prd')
    job_id, _ = create_job(project_id, f'generate_{doc_type}', 'doc_config', body, status='pending')

    state_machine_arn = os.environ.get('DOCUMENT_STATE_MACHINE_ARN', '')
    is_chain = doc_type in ('prd', 'prfaq')

    if state_machine_arn and is_chain:
        boto3.client('stepfunctions').start_execution(
            stateMachineArn=state_machine_arn,
            name=job_id,
            input=json.dumps({'job_id': job_id, 'project_id': project_id, 'doc_config': body})
        )
    else:
        invoke_lambda_async(DOCUMENT_GENERATOR_FUNCTION, {
            'project_id': project_id,
            'job_id': job_id,
            'doc_config': body
        })
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': f'{doc_type.upper()} generation started.'}


@app.post("/projects/<project_id>/documents")
@tracer.capture_method
def api_create_document(project_id: str):
    return create_document(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/documents/merge")
@tracer.capture_method
def api_merge_documents(project_id: str):
    """Merge multiple documents."""
    body = app.current_event.json_body or {}
    job_id, _ = create_job(project_id, 'merge_documents', 'merge_config', body, status='pending')
    invoke_lambda_async(DOCUMENT_MERGER_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'merge_config': body
    })
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Document merge started.'}


@app.put("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_update_document(project_id: str, document_id: str):
    return update_document(project_id, document_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/documents/<document_id>")
@tracer.capture_method
def api_delete_document(project_id: str, document_id: str):
    return delete_document(project_id, document_id)


# ============================================
# Job Routes
# ============================================

@app.get("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_get_job_status(project_id: str, job_id: str):
    response = get_jobs_table().get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'})
    item = response.get('Item')
    if not item:
        raise NotFoundError('Job not found')
    return {
        'success': True, 'job_id': job_id, 'status': item.get('status'),
        'progress': item.get('progress', 0), 'current_step': item.get('current_step'),
        'job_type': item.get('job_type'), 'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'), 'completed_at': item.get('completed_at'),
        'error': item.get('error'), 'result': item.get('result')
    }


@app.get("/projects/<project_id>/jobs")
@tracer.capture_method
def api_list_jobs(project_id: str):
    response = get_jobs_table().query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        ScanIndexForward=False, Limit=50
    )
    jobs = [{
        'job_id': i.get('job_id') or i.get('sk', '').removeprefix('JOB#') or None,
        'job_type': i.get('job_type'), 'status': i.get('status'),
        'progress': i.get('progress', 0), 'current_step': i.get('current_step'),
        'created_at': i.get('created_at'), 'updated_at': i.get('updated_at'),
        'completed_at': i.get('completed_at'), 'error': i.get('error'), 'result': i.get('result')
    } for i in response.get('Items', [])]
    return {'success': True, 'jobs': jobs}


@app.delete("/projects/<project_id>/jobs/<job_id>")
@tracer.capture_method
def api_delete_job(project_id: str, job_id: str):
    get_jobs_table().delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'})
    return {'success': True}


# ============================================
# Prioritization Routes
# ============================================
#
# One ballot per reviewer per document, not one shared score map.
#
# Storage lives in ONE partition, with the identity in the sort key:
#
#     pk = 'PRIORITIZATION'
#     sk = 'BALLOT#{document_id}#user:{cognito_sub}'
#
# Why this shape:
#   * A reviewer's save is a single `update_item` on its OWN key, so two
#     reviewers saving at the same moment cannot lose each other's edits. The
#     previous shape was a read-modify-write of one shared `scores` map, which
#     silently dropped the slower writer's numbers and recorded nobody's name.
#   * The page's read stays ONE paginated query on `pk = 'PRIORITIZATION'`,
#     which also returns the legacy `SCORES` item in the same call. Partitioning
#     per document would instead cost one read per document, on a page that
#     already fans out per project.
#   * The reviewer segment is namespaced by KIND ('user:' today) so that a later
#     anonymous ballot ('anon:') can never land on a signed-in reviewer's key.
#     Anonymous voting is deliberately NOT implemented here.
#
# Parsing assumption: document ids and Cognito subjects are both server-minted
# and contain no '#', which is what makes `BALLOT#{id}#{kind}:{subject}` safely
# splittable. Client-supplied document ids are checked against that assumption
# in `_validated_ballot_document_id` rather than trusted.
#
# Scale ceiling: ballots grow as documents x reviewers inside a single partition.
# That suits a team-sized backlog (tens of documents, tens of reviewers) and is
# read in one paginated query. A much larger deployment would need re-keying —
# e.g. a partition per period, or per document once the read is already fanned
# out — not a bigger page size.
PRIORITIZATION_PK = 'PRIORITIZATION'

# The pre-ballot item: one map of document_id -> score, written by every
# reviewer. Read through (INVARIANT: nothing looks lost) and migrated away entry
# by entry on first write, so there is no migration script to run.
LEGACY_SCORES_SK = 'SCORES'

BALLOT_SK_PREFIX = 'BALLOT#'
REVIEWER_KIND_USER = 'user'

# The four axes a reviewer scores, and the weights the composite score uses.
# The weights mirror `calculatePriorityScore` in the frontend's
# prioritizationUtils.ts — the aggregate's spread has to be in the same unit the
# page already sorts by, or "spread" would describe a different number than the
# one on screen.
SCORE_AXES = ('impact', 'time_to_market', 'confidence', 'strategic_fit')
COMPOSITE_WEIGHTS = {
    'impact': 0.4,
    'time_to_market': 0.3,
    'strategic_fit': 0.2,
    'confidence': 0.1,
}

# Sliders are 0-5. Out-of-range numbers are clamped rather than refused: the
# value is bounded either way and a clamp keeps a save from failing wholesale
# over one axis.
MIN_AXIS_VALUE = 0
MAX_AXIS_VALUE = 5

# A note is free text a reviewer types beside the sliders. Bounded because it is
# stored verbatim and read back on every page load.
MAX_BALLOT_NOTE_LEN = 2000


def _caller_subject() -> str:
    """Return the authenticated Cognito subject of the caller, or raise.

    Fails CLOSED on purpose. A placeholder such as 'unknown' would merge every
    reviewer without a readable subject into one bucket — precisely the defect
    per-reviewer ballots exist to remove — and it would do so silently, writing
    a ballot that claims to be someone.

    NOTE: this collapses onto `shared.api.get_caller_subject` once the open pull
    request introducing that helper merges; it is local here only to avoid
    editing shared/api.py while that change is in flight.
    """
    request_context = app.current_event.raw_event.get('requestContext') or {}
    claims = (request_context.get('authorizer') or {}).get('claims') or {}
    subject = claims.get('sub')
    if not isinstance(subject, str) or not subject.strip():
        raise AuthorizationError('Authenticated reviewer identity is required')
    return subject.strip()


def _reviewer_segment(subject: str) -> str:
    """The kind-namespaced reviewer half of a ballot sort key."""
    return f'{REVIEWER_KIND_USER}:{subject}'


def _ballot_sk(document_id: str, subject: str) -> str:
    return f'{BALLOT_SK_PREFIX}{document_id}#{_reviewer_segment(subject)}'


def _parse_ballot_sk(sk: str) -> tuple[str, str] | None:
    """Split a ballot sort key into (document_id, reviewer_segment).

    Returns None for anything that is not a ballot, so an unrelated item in the
    partition (the legacy SCORES map, or a future sibling record) is skipped
    rather than misread as a ballot. Safe because neither half contains '#'
    (see the module comment above).
    """
    if not sk.startswith(BALLOT_SK_PREFIX):
        return None
    remainder = sk[len(BALLOT_SK_PREFIX):]
    document_id, _, reviewer = remainder.rpartition('#')
    if not document_id or not reviewer:
        return None
    return document_id, reviewer


def _validated_ballot_document_id(raw: Any) -> str:
    """Check that a client-supplied score key can be a ballot sort key.

    '#' is refused rather than escaped: it is the sort-key delimiter, server-minted
    document ids never contain it, and an id carrying one would make the key
    ambiguous to `_parse_ballot_sk`. The length bound keeps an absurd id a 400
    naming the field instead of a DynamoDB ValidationException surfacing as a 500
    (a sort key is capped at 1024 bytes; MAX_SOURCE_DOCUMENT_ID_LEN is the same
    bound the aiming fields in this module already use).
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('scores keys must be document ids')
    document_id = raw.strip()
    if '#' in document_id:
        raise ValidationError('scores keys must be document ids')
    if len(document_id) > MAX_SOURCE_DOCUMENT_ID_LEN:
        raise ValidationError('scores keys must be document ids')
    return document_id


def _axis_value(entry: Any, axis: str) -> float:
    """Read one axis out of a stored ballot or a legacy score map entry.

    Values come back from DynamoDB as Decimal and may be absent (a legacy entry
    written before an axis existed), so this normalises to float and treats
    anything unreadable as 0.0 — the same "unscored" value the page shows.
    """
    if not isinstance(entry, dict):
        return 0.0
    try:
        return float(entry.get(axis) or 0)
    except (TypeError, ValueError):
        return 0.0


def _composite(entry: Any) -> float:
    """The weighted priority score of one ballot."""
    return sum(_axis_value(entry, axis) * weight for axis, weight in COMPOSITE_WEIGHTS.items())


def _score_payload(document_id: str, entry: Any) -> dict:
    """One entry of the `scores` map the deployed frontend consumes.

    Deliberately unchanged in shape: the frontend is NOT changing in this
    request, so the values it shows and edits are now the CALLER'S OWN ballot
    under exactly the keys it already reads.
    """
    notes = entry.get('notes') if isinstance(entry, dict) else None
    return {
        'document_id': document_id,
        'impact': _axis_value(entry, 'impact'),
        'time_to_market': _axis_value(entry, 'time_to_market'),
        'confidence': _axis_value(entry, 'confidence'),
        'strategic_fit': _axis_value(entry, 'strategic_fit'),
        'notes': notes if isinstance(notes, str) else '',
    }


def _read_prioritization_partition() -> list[dict]:
    """Every item under `pk = 'PRIORITIZATION'`, in ONE paginated query.

    Paginated because DynamoDB caps a query page at 1MB: without following
    LastEvaluatedKey a large-enough backlog would silently return only the
    reviewers whose ballots happened to sort first.
    """
    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')
    items: list[dict] = []
    query_kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(PRIORITIZATION_PK),
    }
    while True:
        response = table.query(**query_kwargs)
        items.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return items
        query_kwargs['ExclusiveStartKey'] = last_key


def _aggregate_scores(
    ballots_by_document: dict[str, list[dict]], legacy_scores: dict
) -> dict:
    """Per document: the mean of each axis, how many reviewers scored it, and the
    spread of the composite score.

    A surviving legacy entry counts as exactly ONE unattributed ballot. It cannot
    be double-counted with a real ballot for the same document, because the first
    save against a document removes its legacy entry in the same request (see
    `_drop_legacy_score`).
    """
    aggregates: dict[str, dict] = {}
    for document_id in set(ballots_by_document) | set(legacy_scores or {}):
        entries: list[Any] = list(ballots_by_document.get(document_id, []))
        if document_id in (legacy_scores or {}):
            entries.append(legacy_scores[document_id])
        if not entries:
            continue
        composites = [_composite(entry) for entry in entries]
        aggregates[document_id] = {
            **{
                axis: round(
                    sum(_axis_value(entry, axis) for entry in entries) / len(entries), 2
                )
                for axis in SCORE_AXES
            },
            'reviewer_count': len(entries),
            # Zero for a single reviewer, which is the honest reading: one ballot
            # cannot disagree with itself.
            'score_spread': round(max(composites) - min(composites), 2),
        }
    return aggregates


def _drop_legacy_score(table, document_id: str) -> None:
    """Remove one document's entry from the legacy shared map, if it is still there.

    Migrate-on-write, so no migration script and no window in which a legacy
    value and a real ballot are both counted. Conditional so that the common case
    (already migrated, or never present) is a no-op rather than a resurrection of
    an empty `scores` map.

    Attempted on every save rather than only when the caller's GET saw a legacy
    entry: the alternative is trusting a client-supplied "please migrate" flag, or
    reading the shared map first — which is the read-modify-write this change
    exists to remove. The steady-state cost is one refused conditional write per
    saved document, which is bounded by the documents in one save.
    """
    try:
        table.update_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': LEGACY_SCORES_SK},
            UpdateExpression='REMOVE #scores.#document',
            ConditionExpression='attribute_exists(#scores.#document)',
            ExpressionAttributeNames={'#scores': 'scores', '#document': document_id},
        )
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise


@app.get("/projects/prioritization")
@tracer.capture_method
def api_get_prioritization_scores():
    """Return the caller's own ballots plus the cross-reviewer aggregate.

    `scores` keeps the exact shape the deployed frontend consumes, holding the
    CALLER'S values (or a legacy value where the caller has no ballot yet), so
    the page keeps showing and editing the caller's own numbers with no frontend
    change. `aggregates` is new and additive, for a later frontend change.

    A failed read RAISES. Returning an empty map made "the read failed" and
    "nobody has scored anything" indistinguishable, so a transient DynamoDB error
    looked like an unscored backlog — and a save from that state would then
    persist zeros over real ballots.
    """
    subject = _caller_subject()
    try:
        items = _read_prioritization_partition()
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f"Failed to read prioritization ballots: {e}")
        raise ServiceError('Failed to read prioritization scores') from e

    caller_segment = _reviewer_segment(subject)
    legacy_scores: dict = {}
    ballots_by_document: dict[str, list[dict]] = {}
    caller_ballots: dict[str, dict] = {}

    for item in items:
        sk = item.get('sk') or ''
        if sk == LEGACY_SCORES_SK:
            stored = item.get('scores')
            legacy_scores = stored if isinstance(stored, dict) else {}
            continue
        parsed = _parse_ballot_sk(sk)
        if not parsed:
            continue
        document_id, reviewer = parsed
        ballots_by_document.setdefault(document_id, []).append(item)
        if reviewer == caller_segment:
            caller_ballots[document_id] = item

    scores = {
        document_id: _score_payload(document_id, ballot)
        for document_id, ballot in caller_ballots.items()
    }
    # Read-through: a document the caller has not scored, but which carries a
    # pre-ballot value, still shows that value rather than looking unscored.
    for document_id, entry in legacy_scores.items():
        if document_id not in scores:
            scores[document_id] = _score_payload(document_id, entry)

    return {
        'scores': scores,
        'aggregates': _aggregate_scores(ballots_by_document, legacy_scores),
    }


@app.patch("/projects/prioritization")
@tracer.capture_method
def api_patch_prioritization_scores():
    """Persist the caller's own ballot for each document in the request.

    Body shape is unchanged (`{'scores': {document_id: {...}}}`) because the
    deployed frontend is unchanged; every entry is written as the CALLER'S ballot.

    Each document is one `update_item` on the caller's own key — never a
    read-modify-write of a shared map — so concurrent reviewers cannot overwrite
    each other. No `ttl` attribute is ever written: the aggregates table expires
    anything carrying one, and a ballot is a durable decision record.
    """
    subject = _caller_subject()
    body = app.current_event.json_body or {}
    changed_scores = body.get('scores') or {}
    if not isinstance(changed_scores, dict):
        raise ValidationError('scores must be an object keyed by document id')
    if not changed_scores:
        return {'success': True, 'message': 'No changes to save'}

    # Validate every key BEFORE the first write, so a malformed id cannot leave
    # half the request persisted.
    validated = [
        (_validated_ballot_document_id(document_id), entry)
        for document_id, entry in changed_scores.items()
    ]

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')
    now = datetime.now(timezone.utc).isoformat()

    try:
        for document_id, entry in validated:
            notes = entry.get('notes') if isinstance(entry, dict) else ''
            if not isinstance(notes, str):
                notes = ''
            table.update_item(
                Key={'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(document_id, subject)},
                UpdateExpression=(
                    'SET #impact = :impact, #time_to_market = :time_to_market, '
                    '#confidence = :confidence, #strategic_fit = :strategic_fit, '
                    '#notes = :notes, #document_id = :document_id, '
                    '#reviewer = :reviewer, #updated_at = :updated_at'
                ),
                ExpressionAttributeNames={
                    '#impact': 'impact',
                    '#time_to_market': 'time_to_market',
                    '#confidence': 'confidence',
                    '#strategic_fit': 'strategic_fit',
                    '#notes': 'notes',
                    '#document_id': 'document_id',
                    '#reviewer': 'reviewer',
                    '#updated_at': 'updated_at',
                },
                ExpressionAttributeValues={
                    **{
                        f':{axis}': validate_int(
                            (entry or {}).get(axis) if isinstance(entry, dict) else None,
                            default=MIN_AXIS_VALUE,
                            min_val=MIN_AXIS_VALUE,
                            max_val=MAX_AXIS_VALUE,
                        )
                        for axis in SCORE_AXES
                    },
                    ':notes': notes[:MAX_BALLOT_NOTE_LEN],
                    ':document_id': document_id,
                    ':reviewer': _reviewer_segment(subject),
                    ':updated_at': now,
                },
            )
            # Same save: the pre-ballot value for this document goes away, so it
            # is never counted alongside the ballot that replaced it.
            _drop_legacy_score(table, document_id)
        return {'success': True, 'updated_count': len(validated)}
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f"Failed to save prioritization ballot: {e}")
        raise ServiceError('Failed to save prioritization scores') from e


# ============================================
# API Token Routes (MCP Access)
# ============================================

TOKEN_PREFIX = 'voc_'
TOKEN_BYTE_LENGTH = 32


@app.get("/projects/<project_id>/api-tokens")
@tracer.capture_method
def api_list_tokens(project_id: str):
    """List all API tokens for a project."""
    table = get_projects_table()
    if not table:
        raise ServiceError('Projects table not configured')

    response = table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('TOKEN#')
    )

    tokens = []
    for item in response.get('Items', []):
        tokens.append({
            'token_id': item['token_id'],
            'name': item['name'],
            'scope': item.get('scope', 'read'),
            'created_at': item['created_at'],
            'last_used_at': item.get('last_used_at'),
            'project_id': project_id,
        })

    return {'success': True, 'tokens': tokens}


@app.post("/projects/<project_id>/api-tokens")
@tracer.capture_method
def api_create_token(project_id: str):
    """Create a new API token for a project."""
    body = app.current_event.json_body or {}
    name = body.get('name', '').strip()
    scope = body.get('scope', 'read')

    if not name:
        raise ValidationError('Token name is required')
    if scope not in ('read', 'read-write'):
        raise ValidationError('Scope must be "read" or "read-write"')

    table = get_projects_table()
    if not table:
        raise ServiceError('Projects table not configured')

    # Verify project exists
    project_resp = table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'})
    if 'Item' not in project_resp:
        raise NotFoundError(f'Project {project_id} not found')

    # Generate secure token
    raw_token = TOKEN_PREFIX + secrets.token_hex(TOKEN_BYTE_LENGTH)
    token_id = f'tok_{secrets.token_hex(8)}'
    now = datetime.now(timezone.utc).isoformat()

    table.put_item(Item={
        'pk': f'PROJECT#{project_id}',
        'sk': f'TOKEN#{token_id}',
        'token_id': token_id,
        'name': name,
        'scope': scope,
        'token_hash': hash_token(raw_token),
        'created_at': now,
        'project_id': project_id,
    })

    logger.info(f"Created API token {token_id} for project {project_id}")

    return {
        'success': True,
        'token': raw_token,
        'token_id': token_id,
        'name': name,
    }


@app.delete("/projects/<project_id>/api-tokens/<token_id>")
@tracer.capture_method
def api_delete_token(project_id: str, token_id: str):
    """Revoke an API token."""
    table = get_projects_table()
    if not table:
        raise ServiceError('Projects table not configured')

    # Verify token exists
    resp = table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'TOKEN#{token_id}'})
    if 'Item' not in resp:
        raise NotFoundError(f'Token {token_id} not found')

    table.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'TOKEN#{token_id}'})

    logger.info(f"Deleted API token {token_id} from project {project_id}")

    return {'success': True, 'message': f'Token {token_id} revoked'}


# ============================================
# Product Context Routes
# ============================================

@app.get("/projects/<project_id>/product-context")
@tracer.capture_method
def api_get_product_context(project_id: str):
    return pc_get_context(project_id)


@app.put("/projects/<project_id>/product-context")
@tracer.capture_method
def api_update_product_context(project_id: str):
    return pc_update_context(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/product-context/interview")
@tracer.capture_method
def api_product_context_interview(project_id: str):
    return pc_interview_turn(project_id, app.current_event.json_body)


@app.get("/projects/<project_id>/product-docs")
@tracer.capture_method
def api_list_product_docs(project_id: str):
    return pc_list_docs(project_id)


@app.post("/projects/<project_id>/product-docs/upload-url")
@tracer.capture_method
def api_create_product_doc_upload_url(project_id: str):
    return pc_create_upload_url(project_id, app.current_event.json_body)


@app.delete("/projects/<project_id>/product-docs/<doc_id>")
@tracer.capture_method
def api_delete_product_doc(project_id: str, doc_id: str):
    return pc_delete_doc(project_id, doc_id)


@app.post("/projects/<project_id>/prfaq-autofill")
@tracer.capture_method
def api_autofill_prfaq_questions(project_id: str):
    """Synchronous: returns 5 drafted answers for the Amazon Working-Backwards questions."""
    return autofill_prfaq_questions(project_id, app.current_event.json_body)


@app.post("/projects/<project_id>/research/suggest-questions")
@tracer.capture_method
def api_suggest_research_questions(project_id: str):
    """Synchronous: returns up to 3 AI-suggested research questions for this project."""
    return suggest_research_questions(project_id, app.current_event.json_body or {})


@app.post("/projects/<project_id>/documents/suggest-brief")
@tracer.capture_method
def api_suggest_document_brief(project_id: str):
    """Synchronous: drafts a feature title + description for a PRD/PR-FAQ."""
    return suggest_document_brief(project_id, app.current_event.json_body or {})


# A DynamoDB sort key is capped at 1024 bytes. Bounding a source id well under
# that makes an absurd one a 400 naming the field rather than a DynamoDB
# ValidationException surfacing as a 500.
MAX_SOURCE_DOCUMENT_ID_LEN = 256


def _validated_source_id(project_id: str, sk_prefix: str, raw: Any, field: str) -> str | None:
    """
    Check that a client-supplied source document id names a document of the
    expected type in THIS project, and return it. Absent, null or blank means
    "not aimed, use the newest of this type" and is valid.

    This is a trust boundary, not a convenience check: the generator reads the
    named document's text straight into a Bedrock prompt, so an unvalidated id
    would pull another project's document into this project's generation.
    Ownership and type need no separate test — `pk` is the project and `sk` is
    `{TYPE}#{id}`, so an id from elsewhere, or a PR/FAQ id offered as a PRD,
    cannot resolve.

    Rejecting here as well as in the generator is deliberate: the generator's
    raise is what makes a build fail loudly instead of silently substituting the
    newest document, while this check is what keeps an unresolvable id from
    creating a job that bills a multi-minute Bedrock call in order to fail.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValidationError(f'{field} must be a document id string')
    document_id = raw.strip()
    if not document_id:
        return None
    if len(document_id) > MAX_SOURCE_DOCUMENT_ID_LEN:
        raise ValidationError(f'{field} is not a valid document id')
    item = get_projects_table().get_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': f'{sk_prefix}{document_id}'},
    ).get('Item')
    if not item:
        raise NotFoundError(f'{field}: no such document in this project')
    return document_id


# One request must not become an unbounded number of keyed reads. `_validated_source_id`
# needs no such bound — it checks one id — but a list does, and without it a 200-entry
# array is 200 round trips paid for by a single unauthenticated-cost request.
# Ten is well above any real selection (the whole point of the picker is choosing a
# few reports) and far below a list worth paginating.
MAX_SELECTED_RESEARCH_IDS = 10


def _validated_research_ids(project_id: str, raw: Any, field: str) -> list[str]:
    """
    Check that every client-supplied research id names a research report in THIS
    project, and return them in the order they were sent. Absent or empty means
    "read no research" and is valid.

    Reached only when `use_research` is on. A list sent with the switch off is
    ignored without a read and never stored — see the call site for why that is
    the honest reading rather than a rejection.

    Each id goes through `_validated_source_id` under the `RESEARCH#` prefix, so
    ownership, type and the length bound are all decided exactly as they are for
    `source_prd_id` — an id from another project, or a PRD id offered as research,
    does not resolve. Same trust boundary, same reason: the named document's text
    goes straight into a Bedrock prompt.

    Scoped to `RESEARCH#` on purpose rather than folded into a general document
    selection. The prototype build already reads a PRD and a PR/FAQ, and the shared
    reference-document path keeps only the first three of a selection — so research,
    which sorts last, is exactly what a general picker would drop. A research-only
    field cannot be capped out because nothing of another type is in its candidate
    set.

    The arity bound is checked BEFORE the first read, so an over-long list costs
    one 400 rather than N reads and then a 400. Duplicates are collapsed: a
    repeated id would otherwise be read twice and injected into the prompt twice.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError(f'{field} must be a list of document ids')
    if len(raw) > MAX_SELECTED_RESEARCH_IDS:
        raise ValidationError(
            f'{field} names more than {MAX_SELECTED_RESEARCH_IDS} documents'
        )
    document_ids: list[str] = []
    for entry in raw:
        document_id = _validated_source_id(project_id, 'RESEARCH#', entry, field)
        if document_id and document_id not in document_ids:
            document_ids.append(document_id)
    return document_ids


# MAX_SELECTED_PRODUCT_DOC_IDS is imported from product_context, not declared here.
# It reads much smaller than MAX_SELECTED_RESEARCH_IDS above and the reason is not
# budget — the full argument lives with the constant, beside the character budget
# that is derived from it.


def _validated_product_doc_ids(project_id: str, raw: Any, field: str) -> list[str]:
    """
    Check that every client-supplied product-doc id names an uploaded visual in
    THIS project, and return them in the order they were sent. Absent, null or
    empty means "no visuals selected" and is valid.

    There is no companion `use_visuals` switch, which is the one way this differs
    from `selected_research_ids`. A non-empty list IS the request: a flag beside a
    list admits a "flag on, empty list" state that means nothing, and a "flag off,
    ids present" state that has to be resolved by a documented convention nobody
    reading the request body can see. So this list is always validated when it is
    sent, and every id in it is a claim the caller made.

    Each id goes through `_validated_source_id` under the `PRODUCT_DOC#` prefix,
    so ownership, type and the per-entry length bound are decided exactly as they
    are for `source_prd_id` — an id from another project, or a PRD id offered as a
    visual, does not resolve. That keyed read IS the check: there is no separate
    ownership test to forget, because `pk` is the project and `sk` carries the
    type. Same trust boundary as the rest, and the same reason: the named doc's
    extracted description goes straight into a Bedrock prompt.

    The arity bound is checked BEFORE the first read, so a 500-entry list costs
    one 400 rather than 500 keyed reads and then a 400. Duplicates are collapsed
    after: the same mockup named twice would otherwise be read twice and its
    palette repeated in the prompt.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError(f'{field} must be a list of document ids')
    if len(raw) > MAX_SELECTED_PRODUCT_DOC_IDS:
        raise ValidationError(
            f'{field} names more than {MAX_SELECTED_PRODUCT_DOC_IDS} documents'
        )
    document_ids: list[str] = []
    for entry in raw:
        document_id = _validated_source_id(project_id, PRODUCT_DOC_SK_PREFIX, entry, field)
        if document_id and document_id not in document_ids:
            document_ids.append(document_id)
    return document_ids


@app.post("/projects/<project_id>/build-prototype")
@tracer.capture_method
def api_build_prototype(project_id: str):
    """
    Kick off a build-prototype job. The document-generator lambda reads the PRD
    and/or PR-FAQ this request names — or the newest of each type when it names
    none — and asks Bedrock to produce a self-contained HTML React prototype,
    saved as a ProjectDocument of type 'prototype'. The frontend polls job
    status, then displays the HTML in an iframe via srcdoc (sandboxed, no
    parent-page access).
    """
    body = app.current_event.json_body or {}
    # Read once: it is both a stored field and the switch deciding whether the id
    # list is looked at at all — see `selected_research_ids` below.
    use_research = bool(body.get('use_research'))
    doc_config = {
        'doc_type': 'build_prototype',
        'title': body.get('title') or 'Prototype',
        'response_language': body.get('response_language'),
        # Optional brand targeting (e.g. "UNNI" / a domain). Blank → neutral defaults.
        'brand': body.get('brand'),
        # Optional feedback-driven regeneration: revise an existing prototype
        # centered on this feedback while still honoring the PRD/PR-FAQ.
        'feedback': body.get('feedback'),
        # The prototype being revised is a client-supplied id like the two below,
        # and it is checked the same way — whenever it is supplied, whether or not
        # `feedback` came with it. Unchecked, an id naming no prototype produced a
        # document labelled a revision (it carries `revised_from_id`) that the
        # model built without ever seeing the prototype it supposedly revises,
        # after a billed multi-minute Bedrock call.
        'base_prototype_id': _validated_source_id(
            project_id, 'PROTOTYPE#', body.get('base_prototype_id'), 'base_prototype_id',
        ),
        # Optional aiming: build from THESE documents instead of the newest of
        # each type. Validated before the job exists, so a bad id costs a 4xx
        # rather than a billable build that fails minutes later.
        'source_prd_id': _validated_source_id(
            project_id, 'PRD#', body.get('source_prd_id'), 'source_prd_id',
        ),
        'source_prfaq_id': _validated_source_id(
            project_id, 'PRFAQ#', body.get('source_prfaq_id'), 'source_prfaq_id',
        ),
        # Optional extra grounding, chosen per build rather than remembered per
        # project (the same answer #320 took for the source ids). All three absent
        # means the prompt this endpoint has always produced: the generator adds a
        # section only for what is asked for, so False/[] changes nothing.
        'use_product_context': bool(body.get('use_product_context')),
        'use_research': use_research,
        # Ids sent with the switch OFF are ignored, not rejected — a deliberate
        # choice, and the opposite of `base_prototype_id`, which is checked whether
        # or not `feedback` came with it. The difference is what the field can
        # still reach: an unchecked `base_prototype_id` reaches `doc_config` and
        # produces a document labelled a revision, whereas `use_research` is the
        # only thing the generator reads before it opens this list, so a list sent
        # beside a false flag names nothing any build will look at. There is no
        # claim to check, and a 4xx over a field the build ignores would fail a
        # request for a reason the user cannot see. Ignoring it also drops the N
        # keyed reads that validating it unconditionally spent on a result nothing
        # used.
        #
        # DROPPED rather than passed through, which is the half that has to be
        # deliberate: every id in the stored config resolved under this project's
        # `RESEARCH#` prefix, so a replay of the job cannot reach an unvalidated
        # id if the switch is ever read differently.
        'selected_research_ids': _validated_research_ids(
            project_id, body.get('selected_research_ids'), 'selected_research_ids',
        ) if use_research else [],
        # Visual grounding: uploaded mockups/screenshots whose extracted design
        # description the generator injects. No `use_visuals` switch beside it, on
        # purpose — unlike the research pair above, a non-empty list is itself the
        # request, so there is no state where a flag and a list can disagree. The
        # consequence is that these ids are validated whenever they are sent
        # (there is no "off" for the check to skip), which is the `base_prototype_id`
        # rule rather than the `selected_research_ids` one.
        'selected_product_doc_ids': _validated_product_doc_ids(
            project_id, body.get('selected_product_doc_ids'), 'selected_product_doc_ids',
        ),
    }
    job_id, _ = create_job(project_id, 'build_prototype', 'doc_config', doc_config, status='pending')
    invoke_lambda_async(DOCUMENT_GENERATOR_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'doc_config': doc_config,
    })
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Prototype build started.'}


@app.post("/projects/<project_id>/product-report")
@tracer.capture_method
def api_generate_product_report(project_id: str):
    """
    Start an async product-report generation job. The actual Bedrock call (which
    can take 30+ seconds for Korean output) runs in the document-generator job
    lambda; this endpoint returns immediately with a job_id so API Gateway's
    29-second timeout can't trip the request.
    """
    body = app.current_event.json_body or {}
    doc_config = {
        'doc_type': 'product_report',
        'title': body.get('title') or 'Product description report',
        'response_language': body.get('response_language'),
    }
    job_id, _ = create_job(project_id, 'generate_product_report', 'doc_config', doc_config, status='pending')
    invoke_lambda_async(DOCUMENT_GENERATOR_FUNCTION, {
        'project_id': project_id,
        'job_id': job_id,
        'doc_config': doc_config,
    })
    return {'success': True, 'job_id': job_id, 'status': 'pending', 'message': 'Product report generation started.'}


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for projects API."""
    try:
        # Never log the raw event or the resolved result here (issue #245).
        # The event carries the caller's Authorization header (Cognito bearer
        # token) and request body; the result carries user-generated content
        # (project text, verbatims, persona data).  Powertools'
        # @logger.inject_lambda_context already attaches request-id, function
        # name and cold-start, so only the status code is added below.
        # Status code alone is not sensitive, so this stays at INFO to keep the
        # per-invocation completion signal that LOG_LEVEL=INFO would drop at
        # DEBUG — it is the absence of the body, not the log level, that
        # protects the data.
        result = app.resolve(event, context)
        logger.info("Returning response", extra={"status_code": result.get("statusCode")})
        return result
        
    except Exception as e:
        logger.exception(f"Lambda handler error: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({'error': 'Internal server error', 'message': 'An unexpected error occurred.'})
        }
