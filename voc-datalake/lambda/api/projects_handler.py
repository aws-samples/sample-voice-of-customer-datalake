"""
Projects API Lambda Handler
Separate Lambda to handle projects endpoints and avoid policy size limits.
"""

import json
import math
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from shared.logging import logger, tracer
from shared.aws import invoke_lambda_async
from shared.api import (
    create_api_resolver,
    get_caller_subject,
    validate_days,
    validate_int,
    validate_bool,
    api_handler,
    validate_date_basis,
    MAX_PERSONAS_PER_GENERATION,
    # Appended rather than sorted in, to avoid a conflict with #344 and #330 while
    # they are open; sort this block once both have landed.
    require_admin,
)
from shared.tables import get_jobs_table, get_aggregates_table, get_projects_table
from shared.jobs import create_job
from shared.exceptions import (
    ApiError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ServiceError,
    ValidationError,
)
from shared.persona_import import validate_import_config
from shared.tokens import hash_token

from aws_lambda_powertools.event_handler import Response, content_types
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


# A DynamoDB sort key is capped at 1024 bytes. Bounding an id that reaches one
# well under that makes an absurd value a 400 naming the field rather than a
# DynamoDB ValidationException surfacing as a 500.
#
# Named for the KEY SEGMENT rather than for the document, because it bounds every
# caller-supplied id that becomes half of a sort key: a document id, a project id
# (which `_default_row_id` composes a row id from), and a row id itself. It was
# `MAX_SOURCE_DOCUMENT_ID_LEN` while documents were the only such id; a row is now
# what a ballot is keyed to, and a name claiming documents was the last thing here
# still saying otherwise.
#
# Defined here, above the prioritization block that is its first use, rather than
# beside `_validated_source_id` further down: the previous placement worked only
# because every reference sat inside a function body, which breaks the moment a
# helper is hoisted to module scope.
MAX_KEY_SEGMENT_ID_LEN = 256


# ============================================
# Prioritization Routes
# ============================================
#
# A ROW is the thing that gets scored, and a row is a PROJECT'S SET OF DOCUMENTS.
# One ballot per reviewer per row, not one shared score map, and not one row per
# document — a project whose PRD and PR/FAQ describe one idea used to appear twice
# and be scored twice, and a room voting from their phones scored whichever half
# the QR happened to sit on.
#
# Storage lives in ONE partition, with the identity in the sort key:
#
#     pk = 'PRIORITIZATION'
#     sk = 'ROW#{row_id}'                       — the row: which documents it holds
#     sk = 'BALLOT#{row_id}#user:{cognito_sub}' — one reviewer's ballot ON that row
#
# Why this shape:
#   * A reviewer's save is a single `update_item` on its OWN key, so two
#     reviewers saving at the same moment cannot lose each other's edits. The
#     previous shape was a read-modify-write of one shared `scores` map, which
#     silently dropped the slower writer's numbers and recorded nobody's name.
#   * The page's read stays ONE paginated query on `pk = 'PRIORITIZATION'`,
#     which returns the ROWS, every ballot and the legacy `SCORES` item in the
#     same call — so the page learns what each row holds without a second round
#     trip per row. Partitioning per row would instead cost one read per row, on
#     a page that already fans out per project.
#   * The reviewer segment is namespaced by KIND ('user:' here, 'anon:' in
#     `ballots_handler`) so an anonymous ballot can never land on a signed-in
#     reviewer's key.
#
# Parsing assumption: row ids and Cognito subjects are both server-minted and
# contain no '#', which is what makes `BALLOT#{id}#{kind}:{subject}` safely
# splittable. BOTH halves are CHECKED against that assumption rather than trusted
# — row ids in `_validated_ballot_row_id` (and, at the point one is minted, in
# `_validated_row_project_id`), the reviewer subject in
# `_caller_reviewer_subject`. A '#' in either half mis-splits the key silently:
# the write succeeds, the ballot becomes unreadable, and a phantom row id appears
# in `aggregates`.
#
# Scale ceiling: ballots grow as rows x reviewers inside a single partition. That
# suits a team-sized backlog (tens of projects, tens of reviewers) and is read in
# one paginated query. A much larger deployment would need re-keying — e.g. a
# partition per period, or per row once the read is already fanned out — not a
# bigger page size. Making a row a project rather than a document is itself a
# reduction: the partition now grows with projects, not with every document of
# every project.
PRIORITIZATION_PK = 'PRIORITIZATION'

# The pre-ballot item: one map of document_id -> score, written by every
# reviewer. Read through (INVARIANT: nothing looks lost) and migrated away entry
# by entry on first write, so there is no migration script to run.
LEGACY_SCORES_SK = 'SCORES'

BALLOT_SK_PREFIX = 'BALLOT#'
REVIEWER_KIND_USER = 'user'

# The row record: which project a row belongs to and which of that project's
# documents it holds.
#
#     sk = 'ROW#{row_id}'
#
# In the SAME partition as the ballots on purpose. The page reads the partition
# whole already, so the rows arrive with the ballots in one query and nothing has
# to be fetched per row; and a row and the ballots keyed to it stay in one place,
# which is what a later phase's "delete a row with its ballots" needs.
ROW_SK_PREFIX = 'ROW#'

# The DEFAULT row of a project: the one every project with scorable documents gets
# without anybody performing a setup step.
#
# DERIVED from the project id rather than minted at random, which is what makes
# "ask for the default row twice and get the same row" true by construction rather
# than by a read-then-write that two simultaneous callers would both lose. The
# create is an idempotent conditional write on this exact key; a second caller's
# condition fails and it is handed the row that already exists.
#
# Phase 2 adds rows for other combinations. Those get minted ids under the same
# prefix; nothing here assumes a row id is derivable from its project, which is
# why the row record carries `project_id` as a field and the read never parses it
# back out of the id.
DEFAULT_ROW_ID_PREFIX = 'row_'
DEFAULT_ROW_ID_SUFFIX = '_default'

# How many random bytes a NON-default row's id carries, and how one is spelled.
#
# Minted server-side, never accepted from a caller, for the reason
# `_validated_ballot_row_id` records at length: the row id becomes the FIRST SEGMENT
# of every ballot sort key on that row, so a caller-chosen id puts the shape of that
# key under a caller's control. Hex under the same DEFAULT_ROW_ID_PREFIX namespace,
# so every row id in the partition reads alike and none of them can contain the '#'
# the key is split on.
#
# The DEFAULT suffix is deliberately NOT appended: a minted id must never be able to
# collide with the derived default id of any project, and `_default_row_id` is the
# only thing that composes that spelling.
ROW_ID_BYTES = 16

# The mark a row carries once a ballot has landed on it, and what the composition
# change asserts about.
#
# THIS ATTRIBUTE IS THE FREEZE. A composition change is one conditional
# `update_item` carrying `attribute_not_exists(first_ballot_at)`, so the DATABASE is
# what refuses a change to a row somebody has voted on — a read of a ballot count
# followed by a write would lose the race against the first ballot and leave a row
# whose documents nobody balloting on it ever saw. Written by the ballot save in the
# SAME transaction as the ballot itself (`_ballot_transact_items`), which is what
# makes "the first ballot froze it" true at the instant the ballot lands rather than
# on a later reconciliation.
#
# `if_not_exists`, so it records the FIRST ballot and every later one leaves it
# alone: it is the freeze instant, not a last-modified stamp.
ROW_FROZEN_AT_FIELD = 'first_ballot_at'

# How many ballot writes a row has taken. Not a reviewer count and not shown to
# anybody — it exists so a DELETE can be fenced on the row not having changed
# between the read that enumerated its ballots and the write that removes them (see
# `api_delete_prioritization_row`). Incremented with `ADD` in the ballot
# transaction, so two concurrent ballots each move it.
ROW_BALLOT_WRITES_FIELD = 'ballot_writes'

# Where the ROW's write sits in the ballot transaction `_ballot_transact_items`
# builds — the ballot's own write is first, the row's second.
#
# Named because the save READS THE CANCELLATION REASON AT THIS INDEX. A
# `TransactionCanceledException` does not mean a condition failed (see
# `_cancelled_by_condition`), and the only condition in that transaction is on the
# row, so "the row went away" is a claim about this position specifically rather
# than about the exception.
BALLOT_TRANSACT_ROW_INDEX = 1

# What a `TransactItems[].Update` accepts, per the DynamoDB API — a NARROWER set than
# `update_item` takes, which is why it is stated. `_ballot_transact_items` spreads the
# kwargs `_ballot_update_kwargs` built for `update_item` into one of these, so a
# resource-only key added there later (`ReturnValues`, `ReturnConsumedCapacity`) would
# have DynamoDB reject the whole transaction. Asserted against rather than filtered:
# dropping such a key silently would discard part of what that function decided to
# write while still answering 200.
#
# `TableName` is supplied by the caller of this list rather than by the kwargs.
TRANSACT_UPDATE_KEYS = frozenset({
    'TableName',
    'Key',
    'UpdateExpression',
    'ConditionExpression',
    'ExpressionAttributeNames',
    'ExpressionAttributeValues',
    'ReturnValuesOnConditionCheckFailure',
})

# How many documents one row may hold. A row is a project's scorable documents
# plus its latest prototype, and the composition is stored verbatim and read back
# on every page load. Generous next to any real project (a handful of PRDs and
# PR/FAQs) and small enough that a row stays one readable item.
MAX_ROW_DOCUMENT_IDS = 25

# The fields every ballot save stamps whatever the reviewer expressed: which ROW
# it is for, whose it is, and when it was written. Everything else on a ballot is
# a value the reviewer entered, which is what makes "did this save store anything
# a reviewer expressed?" answerable from the write itself — see
# `_writes_a_reviewer_value`, which subtracts these.
#
# `row_id`, not `document_id`: a ballot is about a row now, and stamping the old
# field name would leave the record claiming to be about a document it is not.
BALLOT_STAMP_FIELDS = ('row_id', 'reviewer', 'updated_at')

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
#
# REFUSED rather than truncated when a save exceeds it (see
# `_validated_ballot_entry`). Truncating discarded the tail of a durable decision
# record while answering 200 — and a justification runs long exactly when it is
# doing the most work, with the conclusion at the end. Unlike an out-of-range axis
# there is no "bounded either way" defence: the discarded characters are content,
# not a number pushed to the nearest legal value. It is the same argument that
# refuses a non-string `notes` rather than coercing it to '', on the same field.
#
# Mirrored in the frontend as `MAX_NOTE_LENGTH`, which bounds the textarea, so the
# shipped page cannot compose a body this route refuses. The pair is pinned by
# `test_prioritization_note_bound_lockstep.py` — a bound enforced on one side only
# turns a refusal the page can no longer explain into a save that appears to do
# nothing.
MAX_BALLOT_NOTE_LEN = 2000

# How many ROWS one save may carry. Each one costs one ballot write. A save that
# scores something also pays the legacy migration, but that is bounded per
# INVOCATION rather than per row: one read of the `SCORES` item decides whether
# there is anything to retire at all (`_LegacyScores`), and only a deployment that
# actually holds pre-ballot entries then pays a row read plus a conditional delete
# per held document. An unbounded body would still turn a single invocation into
# hundreds of sequential ballot writes, with a Lambda timeout part way through
# leaving the save half-persisted behind a bare 500. The page scores a team-sized
# backlog, so a body larger than this is a client defect, and a 400 naming the
# bound is a better answer than a partially-applied save.
MAX_BALLOTS_PER_SAVE = 100

# How many query pages the read will follow. The module comment above documents
# the scale ceiling (rows x reviewers in one partition); this is what makes
# crossing it an observable, diagnosable event rather than a slowly-worsening GET
# that eventually times out on the page's primary read. Generous enough that the
# documented team-sized deployment can never reach it.
MAX_PRIORITIZATION_PAGES = 20

# How many ballots one row may hold and still be deletable together with them.
#
# DynamoDB caps a transaction at 100 items, and the delete spends items on the row
# record and, for a default row, one `ConditionCheck` on a sibling — so this is that
# ceiling minus the two the transaction reserves for itself. Not a product bound: a
# row is one project's set of documents, and a reviewer count that reaches this is a
# deployment far past the team-sized shape the partition itself is scaled for.
#
# Crossing it REFUSES rather than deleting in batches, which is the whole argument
# for the transaction: several writes would leave the ballots that did not fit in the
# first one orphaned between them, and an orphaned ballot is precisely what this path
# exists to make impossible.
MAX_ROW_BALLOTS_PER_DELETE = 98

# How many rows one project may hold.
#
# THE ONLY BOUND ON A ROUTE THAT ADDS ONE ROW PER CALL. `POST .../rows/compose` is
# open to any signed-in reviewer and deliberately produces a new row every time it is
# asked, so without this the partition the page reads WHOLE grows without limit under
# ordinary authorized requests — and `_read_prioritization_partition` raises past
# MAX_PRIORITIZATION_PAGES rather than truncating, which would take the prioritization
# page down FOR EVERYBODY rather than only for whoever composed the rows. That
# asymmetry is the reason the bound is here rather than left to API Gateway's throttle.
#
# Generous next to the product: a row is one combination of a project's documents, the
# page renders one line per row, and a backlog nobody can read on one screen is past
# the point where another row helps. Small enough that even every project holding this
# many leaves the whole-partition read inside its page budget.
#
# Crossing it REFUSES with a 409 naming the bound — the shape MAX_ROW_BALLOTS_PER_DELETE
# uses — rather than evicting an existing row: a row carries ballots, and deleting one
# to make room for another is a destructive act, which is admin-gated for that reason.
#
# The DEFAULT row is exempt. `POST .../rows` must keep answering for a project whose
# rows were all composed, because it is idempotent on a derived key and the page has
# no other way to get the row a project is entitled to.
MAX_ROWS_PER_PROJECT = 50

# How many document pages a row COMPOSITION will follow.
#
# This bounds a project's total STORED BYTES, not its document count. DynamoDB's 1MB
# page limit applies to the data read BEFORE a `ProjectionExpression` is applied, so
# the projection below cuts what crosses the wire and does nothing to the page count
# — and documents keep their body inline, so a handful of long ones page further
# than their number suggests.
#
# Generous on purpose, because of what happens when it binds: the refusal is a 409,
# which the page reads as settled and does not retry, so the project gets no row at
# all. A tight bound would spend that outcome on projects the product legitimately
# produces. A generous one costs nothing in the normal case of a single page, and
# further pages are paid only by a project already outside the shape the wizard
# creates.
#
# Its own constant rather than sharing the one above, because the two bound
# different things: that one a partition growing as rows x reviewers, this one one
# project's stored bytes. They happen to hold the same number today; a change to
# either should be reasoned about on its own terms rather than kept in step.
MAX_PROJECT_DOCUMENT_PAGES = 20


def _json_object_body() -> dict:
    """The request body as a JSON object, or a ValidationError.

    `json_body` alone is two unhandled failures: unparseable JSON raises
    `JSONDecodeError`, and a body that parses to a LIST or a string passes an
    `or {}` guard truthy and then dies on `.get`. Neither has a registered handler,
    so both surface as a bare 500 — a malformed REQUEST reported as a server fault,
    counted as an error, with nothing the page can say about it. Probed before
    fixing: `[1,2]`, `"hi"` and `{not json` each answered 500.

    Deliberately the same helper, with the same name and contract, as
    `ballots_handler._json_object_body` — one idiom rather than two spellings of it.
    Not extracted into `shared/` while it has two copies; the third one should do
    that rather than a second refactor of the first two.

    SCOPE: applied to the prioritization routes only. The other bodies in this
    module have the same latent shape and predate this change, and sweeping ~20
    pre-existing routes is its own reviewable diff rather than a rider on a
    data-model change.
    """
    try:
        body = app.current_event.json_body
    except ValueError as e:
        # json.JSONDecodeError is a ValueError; a body that is not JSON at all is
        # the caller's mistake, not this service's.
        raise ValidationError('the request body must be JSON') from e
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ValidationError('the request body must be a JSON object')
    return body


def _caller_reviewer_subject() -> str:
    """The authenticated Cognito subject of the caller, or raise (403).

    Thin wrapper over `shared.api.get_caller_subject` so both routes read the
    identity the same way. That helper fails CLOSED, which is the point: a
    placeholder such as 'unknown' would merge every reviewer without a readable
    subject into one bucket — precisely the defect per-reviewer ballots exist to
    remove — and would do so silently, writing a ballot that claims to be someone.

    Also CHECKS the no-'#' assumption rather than trusting it. The three silent
    corruptions a '#' in the subject causes are enumerated in the module comment
    above, beside the key format they are about, and not repeated here. Unreachable
    through the Cognito authorizer today (a `sub` is a v4 UUID); checked anyway
    because the assumption is load-bearing, document ids are already held to it, and
    it stops being free the moment the 'anon:' kind the key is namespaced for
    arrives — an anonymous identifier is whatever its implementer chooses.

    The message names the rule and never echoes the subject, which identifies a
    person and must not be logged (`get_caller_subject`'s own contract).

    BOTH ROUTES REFUSE, THE READ DELIBERATELY INCLUDED. Sharing this funnel means
    GET answers 403 too, which is a decision and not a side effect. The read
    writes nothing, so it is not refused to prevent corruption; it is refused
    because there is no honest answer. `scores` is a specific caller's own ballots
    and this caller has none that any read can address, so serving `{}` alongside a
    populated `aggregates` would show them an unscored backlog — the exact "the
    read failed and nobody has scored" ambiguity `api_get_prioritization_scores`
    now raises to remove — and the page would then look ordinary and usable while
    every save from it answers 403. A reviewer would re-enter scores into a form
    that cannot keep them. Degrading the read would turn one clear failure at the
    top of the page into a working-looking page that silently cannot record
    anything, and the realistic trigger (a deployment whose identity source is not
    Cognito) is exactly when an operator needs the loud version.

    Only '#' is checked, and ':' deliberately is NOT. The two characters are not
    alike: '#' is PARSED — `_parse_ballot_sk` splits on it, so a '#' inside the
    subject moves where the document id is taken to end — while ':' is only ever
    COMPOSED here, by `_reviewer_segment`, and nothing splits on it. `user:a:b`
    compares whole against the caller's segment and round-trips intact. Should a
    future 'anon:' kind ever need to read the kind back, it must split on the FIRST
    colon (`partition(':')`, which the writer controls), never the last: that keeps
    the kind unambiguous whatever the subject contains, so no guard is owed. Adding
    one would not be free — identity providers do mint subjects containing colons,
    and refusing them would lock out a whole deployment to protect an invariant
    that holds without the refusal.
    """
    subject = get_caller_subject(app.current_event.raw_event)
    if '#' in subject:
        raise AuthorizationError(
            "Caller identity must not contain '#', the ballot sort-key delimiter"
        )
    return subject


def _reviewer_segment(subject: str) -> str:
    """The kind-namespaced reviewer half of a ballot sort key."""
    return f'{REVIEWER_KIND_USER}:{subject}'


def _ballot_sk(row_id: str, subject: str) -> str:
    return f'{BALLOT_SK_PREFIX}{row_id}#{_reviewer_segment(subject)}'


def _row_sk(row_id: str) -> str:
    return f'{ROW_SK_PREFIX}{row_id}'


def _default_row_id(project_id: str) -> str:
    """The id of a project's default row.

    Derived, never minted: see DEFAULT_ROW_ID_PREFIX. The project id is already
    known to contain no '#' by the time this is called
    (`_validated_row_project_id`), so the composed id is a legal first half of a
    ballot sort key.
    """
    return f'{DEFAULT_ROW_ID_PREFIX}{project_id}{DEFAULT_ROW_ID_SUFFIX}'


def _parse_ballot_sk(sk: str) -> tuple[str, str] | None:
    """Split a ballot sort key into (row_id, reviewer_segment).

    Returns None for anything that is not a ballot, so an unrelated item in the
    partition (a row record, the legacy SCORES map, or a future sibling) is
    skipped rather than misread as a ballot. The `rpartition` is safe because
    neither half contains '#' — an invariant the write path ENFORCES on both
    halves rather than assuming (see the module comment above).
    """
    if not sk.startswith(BALLOT_SK_PREFIX):
        return None
    remainder = sk[len(BALLOT_SK_PREFIX):]
    row_id, _, reviewer = remainder.rpartition('#')
    if not row_id or not reviewer:
        return None
    return row_id, reviewer


def _validated_ballot_row_id(raw: Any) -> str:
    """Check that a client-supplied score key can be a ballot sort key.

    '#' is refused rather than escaped: it is the sort-key delimiter, server-minted
    row ids never contain it, and an id carrying one would make the key ambiguous
    to `_parse_ballot_sk`. The length bound keeps an absurd id a 400 naming the
    field instead of a DynamoDB ValidationException surfacing as a 500 (a sort key
    is capped at 1024 bytes; MAX_KEY_SEGMENT_ID_LEN is the same bound the
    document-aiming fields in this module already use, and a row id is derived
    from a project id so it is bounded in the same order).

    Each branch names the RULE it failed rather than echoing the key: three
    distinct causes behind one message leaves a caller unable to tell a delimiter
    collision from an over-long id, while the value itself is unbounded caller
    input that a response body gains nothing by repeating (the same reasoning
    `validate_bool` in shared/api.py records).

    WHAT THIS CHECKS IS THE SHAPE, not the existence. Existence is checked by the
    ROUTE, against the table, once per save (`_fetched_ballot_rows`) — it cannot
    live here because this function sees one key at a time with no table in hand.
    The two checks answer differently on purpose: a malformed key is a 400 about
    the request, a well-formed key naming no row is a 404 about the world.

    An earlier version deliberately skipped the existence check, reasoning that an
    orphaned ballot is "a ballot nothing will read, which is the same outcome the
    read already has to tolerate". Production showed why that reasoning was wrong
    (#342): the same outcome for the READER is not the same outcome for the
    WRITER, who was told 200 `updated_count: 1` while their vote appeared nowhere
    — silent loss reported as success, the exact fault class this module's read
    side counts and warns about. That a row's documents belong to its project is
    still guaranteed one level up, where a row is composed
    (`_default_row_composition` picks from the project's own partition).
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('scores keys must be non-empty row id strings')
    row_id = raw.strip()
    if '#' in row_id:
        raise ValidationError("scores keys must not contain '#', the sort-key delimiter")
    if len(row_id) > MAX_KEY_SEGMENT_ID_LEN:
        raise ValidationError(
            f'scores keys must be at most {MAX_KEY_SEGMENT_ID_LEN} characters'
        )
    return row_id


def _validated_path_row_id(raw: Any) -> str:
    """Check that a row id taken from the URL PATH can be a sort key.

    The same three rules `_validated_ballot_row_id` applies, for the same reasons
    recorded there, with messages that name `row_id` rather than "scores keys": a
    caller who addressed `PATCH /projects/prioritization/rows/{row_id}` and was told
    their "scores keys" were wrong would be reading about a field their request does
    not have.

    A path segment reaches the same sort key as a body key does, so the no-'#' rule
    is not merely inherited — a '%23' that arrives decoded would compose
    `ROW#a#b`, and the row a later ballot's `BALLOT#a#b#user:x` key parses to is then
    not the row that was written.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('row_id is required')
    row_id = raw.strip()
    if '#' in row_id:
        raise ValidationError("row_id must not contain '#', the sort-key delimiter")
    if len(row_id) > MAX_KEY_SEGMENT_ID_LEN:
        raise ValidationError(
            f'row_id must be at most {MAX_KEY_SEGMENT_ID_LEN} characters'
        )
    return row_id


def _is_clampable_number(value: Any) -> bool:
    """Whether an axis value is a number this route may clamp into 0-5.

    CLAMP A NUMBER, REFUSE A NON-NUMBER. The clamp is justified because the value
    is bounded either way — `99`, `-4`, `'3'` and `2.7` all plainly mean a number
    the slider range can hold. `'high'` does not: there is no value to bound, so
    the 0 that `validate_int`'s fallback produces is INVENTED, and once stored it
    is indistinguishable from a deliberate lowest score. That is the same "an
    all-zero ballot inflates `reviewer_count` and drags every mean down" defect
    `_validated_ballot_entry` refuses a non-dict entry to prevent, one level
    further in — and worse, because four unparseable axes also satisfy
    `_is_fully_scored` and so corrupt `score_spread` too.

    Three traps, each of which lets a non-number through a numeric check written
    the obvious way:

    * `bool` is a subclass of `int`, so `isinstance(True, int)` is true and
      `int(True)` is `1`. A flag is not a slider position: `true` would store a 1
      nobody chose, and `false` an invented 0 that reaches the aggregate as a
      deliberate lowest vote. Refused explicitly, ahead of any coercion — the
      mirror of the argument `validate_bool` in shared/api.py makes.
    * `int(float('inf'))` raises `OverflowError`, which is in NEITHER of the
      exception types `validate_int` catches. Left to `validate_int` it therefore
      does not fall back at all: it propagates out of the write loop and
      half-persists a multi-row save behind a bare 500, defeating the whole
      point of validating before the first write. `Infinity` is reachable over
      the wire because Powertools parses the body with non-strict `json.loads`.
    * `int(float('nan'))` raises `ValueError`, which IS swallowed, so a `NaN`
      would silently store the invented 0.

    So the coercion attempt catches `OverflowError` beside `ValueError` and
    `TypeError`, and a non-finite float is refused outright.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    try:
        int(value)
    except (ValueError, TypeError, OverflowError):
        return False
    return True


def _validated_ballot_entry(entry: Any) -> dict:
    """Check that a client-supplied score value can be a ballot.

    REFUSED rather than coerced, at every level the entry has. `_axis_value` and
    `validate_int` between them would turn `'nonsense'`, `null` or `[1, 2]` into a
    perfectly well-formed all-zero ballot, indistinguishable from a deliberate
    all-zero vote — which then inflates `reviewer_count` and drags every axis mean
    down in the aggregate this change introduces. Clamping a number is safe
    because the value is bounded either way; a value of the wrong TYPE means the
    caller expressed something other than what would be inferred, so the honest
    answer is a 400 (the distinction `validate_bool` in shared/api.py documents).

    The same argument applies to the FIELDS of an accepted entry, and refusing
    them here rather than at the write is what makes the up-front pass's promise
    ("nothing malformed can leave a multi-row save half-persisted") true:

    * An axis must be null (absent, left alone) or a number `_is_clampable_number`
      will accept. An unparseable axis stored as a real 0 both invents a vote and
      DESTROYS the sender's own stored score, while answering 200.
    * `notes` must be null (absent, left alone) or a string. Coercing a non-string
      to `''` overwrote a note the reviewer had already saved — silent loss of a
      durable decision record on a success response.
    * `notes` must also be within MAX_BALLOT_NOTE_LEN. Truncating to the bound was
      the SAME silent loss on the SAME field: the reviewer was told their note
      saved and the tail was discarded, on a 200. The clamp/refuse line is drawn
      where it is because an out-of-range axis is bounded either way — 99 plainly
      means "as high as it goes" — while the characters past a note's bound are
      content, not a number pushed to the nearest legal value, and a justification
      runs long exactly when it is doing the most work. Refusing HERE rather than
      at the write is also what lets the note inherit the up-front pass's promise:
      an over-long note cannot leave a multi-row save half-persisted.

    None of the messages echoes the value: it is unbounded caller input a response
    body gains nothing by repeating (the reasoning `_validated_ballot_row_id`
    and `validate_bool` both record). The note's message names the bound instead,
    which is the part a caller can act on.
    """
    if not isinstance(entry, dict):
        raise ValidationError(
            f'scores values must be objects, got {type(entry).__name__}'
        )
    for axis in SCORE_AXES:
        value = entry.get(axis)
        if value is None:
            continue
        if not _is_clampable_number(value):
            raise ValidationError(
                f'{axis} must be a number between {MIN_AXIS_VALUE} and '
                f'{MAX_AXIS_VALUE}, or null to leave it unchanged'
            )
    notes = entry.get('notes')
    if notes is not None:
        if not isinstance(notes, str):
            raise ValidationError('notes must be a string, or null to leave it unchanged')
        if len(notes) > MAX_BALLOT_NOTE_LEN:
            raise ValidationError(
                f'notes must be at most {MAX_BALLOT_NOTE_LEN} characters'
            )
    return entry


def _readable_axis(entry: Any, axis: str) -> float | None:
    """The number an entry expressed for one axis, or None if it expressed none.

    THE one place that decides whether a stored value is a score, so that
    "what is this axis worth?" and "did anybody score this axis?" cannot answer
    from different rules. `_axis_value` and `_carries_axis` are both built on it,
    which is what keeps the read (`scores`) and the aggregate agreeing about the
    same stored value rather than agreeing by coincidence.

    None means NOTHING WAS EXPRESSED, which covers four cases: a non-dict entry, an
    absent or null axis, a value no number can be read out of (`'high'`, `''`,
    `[1, 2]`, `NaN`, `Infinity`), and a bool — `float(True)` is `1.0`, but a flag is not a
    slider position, the same reading `_is_clampable_number` enforces on the way
    in. Everything the write path stores is an int, and DynamoDB hands numbers back
    as Decimal, both of which read cleanly.

    Unreadable is silence rather than zero on purpose. The write path refuses these
    values now, but the legacy map predates that check and was written by a handler
    with no type discipline; reading one as a 0 would put an invented lowest score
    in a field named for what a reviewer entered, and make it indistinguishable
    from the deliberate 0 that `_carries_axis` exists to keep distinguishable.

    So this and `_is_clampable_number` answer the same question with different
    verdicts for the same input — `''` is refused on the way IN (400) and read as
    silence on the way OUT — and that asymmetry is the design, not a gap. Refusing is
    available on a write because there is a caller to tell; on a read the value is
    already stored, nobody is present to correct it, and the only choices are to
    invent a number or to say nothing. Making the read refuse instead would take a
    page down over one bad legacy entry.
    """
    if not isinstance(entry, dict):
        return None
    raw = entry.get(axis)
    if raw is None or isinstance(raw, bool):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _axis_value(entry: Any, axis: str) -> float:
    """Read one axis out of a stored ballot or a legacy score map entry.

    Values come back from DynamoDB as Decimal and may be absent, so this
    normalises to float and reads anything the entry did not express as 0.0.

    0.0 here means ABSENT, and since #343 the frontend adopts that reading for
    ALL FOUR axes: `DEFAULT_SCORE` is 0 across the board, the slider renders a
    0 as "not scored" rather than borrowing a 3, and the team chips print a
    dash for a 0.0 mean. (Historically `time_to_market`'s frontend default was
    3 while its siblings were 0, so a stored ballot missing that one axis read
    back as a deliberate lowest-possible score — the divergence this paragraph
    used to document is the one #343 removed.)

    An axis is absent whenever the caller has never sent it (see `_readable_axis`
    for the exhaustive list), which happens three ways: a legacy entry predating
    the axis; any ballot whose first-ever save was partial, because the save only
    writes the axes it was given; and a legacy value no number can be read out of,
    which predates the validation that now refuses one. A reviewer who saves only
    `notes`, or only `impact`, therefore reads back `time_to_market: 0.0`, which
    the page now renders as unscored. Pinned by
    `test_a_notes_only_first_save_reads_back_a_zero_time_to_market`.

    Not corrected on the read: seeding an absent axis from the frontend's default
    would put a number nobody entered into a field named for what a reviewer
    scored, and the aggregate would then have no way to tell it from a vote. The
    aggregate instead asks `_carries_axis` and skips what was never scored, which
    is the same distinction made where it can be made honestly. For the same
    reason a legacy entry that expressed no score at all is not read through into
    `scores` (see `api_get_prioritization_scores`) rather than shown as four zeros.
    """
    value = _readable_axis(entry, axis)
    return value if value is not None else 0.0


def _carries_axis(entry: Any, axis: str) -> bool:
    """Whether an entry expressed a score for one axis at all.

    Distinct from `_axis_value(entry, axis) == 0`, which cannot tell a deliberate
    zero from silence — the distinction the aggregate depends on. Null counts as
    absent, matching the save path (which skips a null axis rather than clamping
    it) and the legacy map (whose entries predate axes that did not exist yet); so
    does a value that is not a readable number, because 0 is then invented rather
    than expressed (see `_readable_axis`).
    """
    return _readable_axis(entry, axis) is not None


def _is_a_vote(entry: Any) -> bool:
    """Whether an entry says anything about ANY axis.

    A ballot carrying only `notes` (or nothing at all) is a legal PATCH — the verb
    means "change what I sent" and a reviewer may well comment without scoring —
    but it is not a vote, and counting it as one is how an aggregate lies: every
    axis it does not carry reads as 0.0 through `_axis_value`, so one notes-only
    reviewer beside one who scored 5 across the board reported a team mean of 2.5
    and a 5.0 spread, the maximum possible disagreement, manufactured out of
    somebody who expressed no numbers.
    """
    return any(_carries_axis(entry, axis) for axis in SCORE_AXES)


def _is_fully_scored(entry: Any) -> bool:
    """Whether an entry expressed a value for EVERY axis.

    The precondition for comparing one ballot's composite against another's.
    `_composite` weighs an absent axis as 0, so a ballot that scored fewer axes
    always sits lower — comparing it against a fully-scored one measures how
    COMPLETELY each reviewer scored rather than how much they disagreed. Two
    reviewers who agreed exactly on the only axis they both scored reported a
    spread of 2.4 out of 5.0 before this existed.
    """
    return all(_carries_axis(entry, axis) for axis in SCORE_AXES)


def _expresses_something(entry: Any) -> bool:
    """Whether an entry expressed anything a reader should show back.

    The read-through's question, and deliberately WIDER than `_is_a_vote`: a
    pre-ballot entry carrying only a note expressed no score, so it is not a vote
    and must not enter the aggregate, but the note is still something a reviewer
    wrote and dropping it would lose it from the page. So this is "any axis, or a
    note", where `_is_a_vote` is "any axis".

    Both are defined in terms of `_carries_axis`, which is what stops the two
    questions drifting: the same value that is silence to the aggregate is silence
    here, and an unreadable entry — non-dict, or a dict whose axes read as nothing
    — expresses nothing under either.

    The consequence of being wider, stated because it looks like the two halves
    disagreeing: `{'notes': 'x', 'impact': 'high'}` is read through for the note, so
    the caller sees `impact: 0.0` while `aggregates` omits the row. That 0.0 is
    `_axis_value` reporting an axis nobody expressed, which is the same thing the
    page already shows for a reviewer whose first save carried only a note — and
    seeding the frontend's default instead was rejected there for the reason that
    applies here too: it would write a number nobody entered into a field named for
    what a reviewer scored, and the aggregate would lose the distinction it depends
    on. Pinned by `test_a_legacy_entry_carrying_only_a_note_still_reads_through` and
    its unreadable-axis sibling.
    """
    if _is_a_vote(entry):
        return True
    notes = entry.get('notes') if isinstance(entry, dict) else None
    return isinstance(notes, str) and bool(notes.strip())


def _composite(entry: Any) -> float:
    """The weighted priority score of one ballot.

    Absent axes weigh as 0, exactly as they do on the page: `calculatePriorityScore`
    reads whatever `getScore` handed it, and the axes this can see are the axes the
    reviewer sent. So a ballot scoring only `impact` sits lower in the composite
    than a fully-scored one carrying the same number.

    That floor is why `score_spread` compares only fully-scored ballots rather
    than every voting one (see `_aggregate_scores`) — and restricting WHICH
    ballots are compared is what keeps this function and the page agreeing.
    Since #343 the page's TEAM composite renormalises its weights over the axes
    the team expressed (so a one-axis ballot is not ranked on three zeros
    nobody entered); on a fully-scored input the expressed weights sum to 1.0
    and renormalisation is the identity, and fully-scored inputs are the only
    ones this composite is ever compared across. So the spread stays in the
    unit the page's column sorts by without this function renormalising —
    which it deliberately does not, because for PARTIAL inputs the two
    computations answer different questions (completeness versus disagreement)
    and the spread must never mix them. The shared scale is what
    `test_prioritization_weights_lockstep.py` exists to protect.
    """
    return sum(_axis_value(entry, axis) * weight for axis, weight in COMPOSITE_WEIGHTS.items())


def _score_payload(row_id: str, entry: Any) -> dict:
    """One entry of the `scores` map the page consumes, keyed by ROW.

    `row_id` rather than `document_id`, because that is what the ballot is about.
    The field names the identity the map is keyed by, so a consumer that reads the
    row out of the entry rather than out of the key cannot end up addressing a
    document that the row merely contains.
    """
    notes = entry.get('notes') if isinstance(entry, dict) else None
    return {
        'row_id': row_id,
        'impact': _axis_value(entry, 'impact'),
        'time_to_market': _axis_value(entry, 'time_to_market'),
        'confidence': _axis_value(entry, 'confidence'),
        'strategic_fit': _axis_value(entry, 'strategic_fit'),
        'notes': notes if isinstance(notes, str) else '',
    }


def _read_prioritization_partition() -> list[dict]:
    """Every item under `pk = 'PRIORITIZATION'`, in ONE logical paginated query.

    Paginated because DynamoDB caps a query page at 1MB: without following
    LastEvaluatedKey a large-enough backlog would silently return only the
    reviewers whose ballots happened to sort first. One logical query, but N
    round trips — which is why the page count is bounded.

    Bounded at MAX_PRIORITIZATION_PAGES and then RAISED, rather than followed
    forever: the module comment above documents a scale ceiling that nothing was
    enforcing, so crossing it showed up as a slow GET and eventually a Lambda
    timeout on the page's primary read. A refusal that names the ceiling is
    diagnosable; a timeout is not. Truncating instead would be worse still — a
    silently-short window is exactly how this codebase has been bitten before.
    """
    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')
    items: list[dict] = []
    query_kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(PRIORITIZATION_PK),
    }
    for _ in range(MAX_PRIORITIZATION_PAGES):
        response = table.query(**query_kwargs)
        items.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return items
        query_kwargs['ExclusiveStartKey'] = last_key
    logger.error(
        'Prioritization ballots exceed %d query pages. Ballots grow as rows '
        'x reviewers in one partition; past this size the partition needs '
        're-keying, not a bigger page budget.',
        MAX_PRIORITIZATION_PAGES,
    )
    raise ServiceError('Too many prioritization ballots to read in one request')


def _superseded_rows(ballots_by_row: dict[str, list[dict]]) -> set[str]:
    """Rows whose pre-ballot value a real ballot has replaced.

    THE one definition of "superseded", asked by both halves of the GET response —
    the read-through in `api_get_prioritization_scores` and the aggregate in
    `_aggregate_scores` — so that `scores` can never show a legacy value the same
    response's `aggregates` says nobody scored. Two inline tests that happened to
    line up would be the shape the round-6 read-through finding was about.

    Superseded means SOMEBODY VOTED, not merely that a ballot exists: the legacy
    value is a score, so only a score replaces it. A reviewer who saved a note
    without touching a slider has a ballot and has replaced nothing.

    It is also what makes the guarantee independent of `_drop_legacy_score`, which
    is best-effort by design: whether or not that removal landed, the read behaves
    the same way, so a failed migration is invisible instead of resurfacing a
    superseded value as a second reviewer (`_aggregate_scores`) or as the caller's
    own starting numbers (the read-through).
    """
    return {
        row_id for row_id, ballots in ballots_by_row.items()
        if any(_is_a_vote(ballot) for ballot in ballots)
    }


def _legacy_scores_by_row(
    legacy_scores: dict, rows_by_id: dict[str, dict]
) -> dict[str, Any]:
    """The pre-ballot score map, re-keyed from documents onto rows.

    The legacy item predates rows entirely: its keys are document ids. It is the
    one thing in the deployed partition that has to be carried across, and the
    carry is a READ-SIDE translation — the stored map is never rewritten in place,
    so a deployment that rolls back reads exactly what it wrote.

    A legacy value lands on the DEFAULT row of the project that owns its document,
    which is the row a reviewer opening the page will actually see. Only the
    default row: a phase-2 row for another combination may also contain that
    document, and attaching an unattributed pre-ballot value to every row holding
    the document would multiply one old score into several unattributed ballots.

    An entry whose document belongs to no row this response knows about is left
    out rather than invented onto some row. It is not lost — nothing deletes it,
    and it surfaces the moment the owning project's default row exists — and the
    alternative is a score appearing under a row that does not contain the
    document it was cast on.

    ONE entry per row, not a list, and that is the whole of this function's
    judgement about the old data.

    Two documents of one project can each carry a pre-ballot value, and it is
    tempting to read those as two opinions. They are not: the pre-ballot item was a
    SINGLE SHARED MAP that every reviewer wrote into, with no attribution anywhere
    in it — that lack of attribution is precisely why #333 replaced it. So two
    entries on a project's PRD and its PR/FAQ are most plausibly one person scoring
    one idea twice, which is the very duplication the row unit exists to collapse.

    Counting them separately made the aggregate say things nobody said. Measured on
    a project whose PRD read all-5s and whose PR/FAQ read all-1s, both on its
    default row: `reviewer_count: 2` and `score_spread: 4.0` — two reviewers at
    maximum disagreement about a row on which nobody ever disagreed, rendered in
    the two fields whose documented meanings are "reviewers who scored something"
    and "zero means agreement". Before rows, those were two separate rows, each
    reporting one reviewer and no spread.

    WHICH entry, in the document order fixed by sorting: the first that is a VOTE,
    falling back to the first that merely expresses something. Preferring a vote
    matters in both directions — a notes-only entry winning would take a real score
    out of the aggregate, and it also gives the read-through a better starting
    number than a note. The deployed partition holds exactly one legacy entry, so
    the multi-entry case is about being explainable rather than about a case in the
    field; the single-entry behaviour is unchanged either way.
    """
    row_of_document: dict[str, str] = {}
    for row_id, row in rows_by_id.items():
        if not _is_default_row(row):
            continue
        for document_id in _row_document_ids(row):
            row_of_document.setdefault(document_id, row_id)
    candidates: dict[str, list[Any]] = {}
    for document_id in sorted(legacy_scores or {}):
        row_id = row_of_document.get(document_id)
        if row_id is None:
            continue
        candidates.setdefault(row_id, []).append(legacy_scores[document_id])
    by_row: dict[str, Any] = {}
    for row_id, entries in candidates.items():
        chosen = next(
            (entry for entry in entries if _is_a_vote(entry)),
            next((entry for entry in entries if _expresses_something(entry)), None),
        )
        if chosen is not None:
            by_row[row_id] = chosen
    return by_row


def _aggregate_scores(
    ballots_by_row: dict[str, list[dict]], legacy_by_row: dict[str, Any]
) -> dict:
    """Per row: the mean of each axis, how many reviewers scored it, and the
    spread of the composite score.

    A surviving legacy entry counts as exactly ONE unattributed ballot on the row
    it lands on (`_legacy_scores_by_row`), and only while NOTHING HAS SUPERSEDED
    IT: it is skipped as soon as any ballot for that row is a vote. THE READ is
    what prevents the double count, not the write.
    Resting it on the write was wrong, because `_drop_legacy_score` is deliberately
    best-effort — a throttle or a permissions gap leaves the legacy entry in place
    while the ballot is durably written and the reviewer is told 200 — so failing
    only the REMOVE made a single reviewer report `reviewer_count: 2` with a
    non-zero `score_spread`: her own superseded pre-ballot value read as a second
    reviewer disagreeing with her, in the two fields whose documented contracts are
    "reviewers who scored something" and "zero means agreement". And it was STICKY,
    since nothing retries the removal on a later read.

    Skipping is also strictly more accurate than counting, independently of any
    failure: ballots carry a `reviewer` and the legacy entry carries nobody, so the
    aggregate cannot tell "alice plus an unattributed value that is probably also
    alice" from "alice plus a second reviewer" — and once anyone has voted, the
    unattributed value is superseded by definition. `_is_a_vote` is the same
    predicate `_drop_legacy_score` is now gated on, so the write's trigger and the
    read's suppression cannot answer differently.

    Only entries that scored at least one axis count. A ballot carrying just
    `notes` is a legal save but not a vote, and counting it as one let a reviewer
    who moved no slider drag every mean toward zero and inflate `score_spread` to
    the maximum — reachable from the shipped page, whose notes textarea saves
    through the same path as the sliders. Each axis is likewise averaged over the
    reviewers who actually scored THAT axis, so a partially-scored ballot cannot
    depress the axes it says nothing about. An axis nobody scored reports 0.0,
    which is the same "no number here" the page already renders for an unscored
    row; `reviewer_count` is the count of reviewers who scored something, not
    of reviewers who scored every axis.

    `score_spread` compares only FULLY-scored ballots, and is 0.0 below two of
    them. It is the range of `_composite`, which floors an absent axis at 0, so a
    partially-scored ballot always composites lower than a complete one carrying
    the same numbers — including it measured how completely each reviewer scored
    rather than how far apart they were. Two reviewers who agreed exactly on the
    one axis they both scored reported a spread of 2.4 out of a 5.0 range, and
    adding real disagreement barely moved it. Excluded rather than renormalised,
    which would take the composite off the scale the page sorts by (see
    `_composite`). So `reviewer_count` can exceed the number of ballots the spread
    compares: the means describe everyone who scored, the spread describes only
    those who can be compared like for like, and zero spread still means the
    comparable reviewers agreed.

    Response size: one entry per ROW that anybody has scored — reviewers are
    collapsed into a mean here rather than listed, so the response grows with rows
    alone, not rows x reviewers the way storage does. A row deleted since it was
    scored keeps an entry (its ballots live beside it and nothing removes them in
    this phase), so a consumer should intersect these keys with the rows it can
    resolve rather than treat the map as a row index.
    """
    aggregates: dict[str, dict] = {}
    legacy = legacy_by_row or {}
    superseded = _superseded_rows(ballots_by_row)
    for row_id in set(ballots_by_row) | set(legacy):
        entries: list[Any] = list(ballots_by_row.get(row_id, []))
        # A legacy value counts only until a real ballot on this row supersedes it,
        # and counts as exactly ONE unattributed opinion — see
        # `_legacy_scores_by_row`, which now chooses among a row's pre-ballot values
        # rather than handing all of them over as separate reviewers.
        if row_id not in superseded and row_id in legacy:
            entries.append(legacy[row_id])
        votes = [entry for entry in entries if _is_a_vote(entry)]
        if not votes:
            continue
        means = {}
        for axis in SCORE_AXES:
            scored = [_axis_value(entry, axis) for entry in votes
                      if _carries_axis(entry, axis)]
            means[axis] = round(sum(scored) / len(scored), 2) if scored else 0.0
        # Only ballots that scored EVERY axis are comparable: `_composite` floors
        # an absent axis at 0, so including a partial ballot would measure how
        # completely each reviewer scored instead of how much they disagreed.
        comparable = [_composite(entry) for entry in votes if _is_fully_scored(entry)]
        aggregates[row_id] = {
            **means,
            'reviewer_count': len(votes),
            # Zero below two comparable ballots, which is the honest reading:
            # one ballot cannot disagree with itself, and there is no second
            # fully-scored opinion to disagree with it.
            'score_spread': (
                round(max(comparable) - min(comparable), 2) if len(comparable) > 1
                else 0.0
            ),
        }
    return aggregates


def _drop_legacy_score(table, document_id: str) -> None:
    """Remove one document's entry from the legacy shared map, if it is still there.

    Migrate-on-write, so no migration script and no window in which a legacy
    value and a real ballot are both counted. Conditional so that the common case
    (already migrated, or never present) is a no-op rather than a resurrection of
    an empty `scores` map.

    Attempted without the caller saying so, rather than on a client-supplied
    "please migrate" flag. It is not attempted BLINDLY, though: the caller
    (`_drop_legacy_scores_for_row`) asks `_LegacyScores` which document ids the map
    actually holds — one read of the `SCORES` item per invocation, shared by every
    row of the save — so in a deployment with no legacy entries, which is every
    deployment that never ran the pre-ballot version, no write is issued at all.
    Removing the entry is still done by CONDITION rather than by that read, because
    a concurrent save may have retired the same entry in between; the read decides
    what is worth attempting, the condition decides what happens.

    NOW CALLED PER DOCUMENT OF THE SAVED ROW, because the legacy map is keyed by
    document while a ballot is keyed by row. A row's ballot supersedes the
    pre-ballot value of every document that row holds — that is the same
    translation the read performs (`_legacy_scores_by_row`), so the write's removal
    and the read's suppression stay about the same values. Removing only some of
    them would leave a value the read has already stopped counting sitting in the
    map for a later, differently-composed row to pick up.

    ONLY CALLED FOR A SAVE THAT ACTUALLY SCORED SOMETHING (`_is_a_vote`). The
    justification below is "the reviewer who saved has just expressed the newer
    opinion", and that clause is what makes deleting a value nobody's name is on
    acceptable — so it has to be TRUE before this runs. Called for every validated
    key instead, it fired for entries that expressed nothing: `{}` (a legal no-op
    by design), `{'impact': null}` (silence, by round 3's reading), and an entry
    whose only key is a typo'd axis each permanently deleted the pre-ballot score
    for that document, for every reviewer, on a 200. That is this change's own
    defect class — one reviewer's write destroying a score another can see — and
    worse than the shared-map race it replaced, because the winning write expressed
    no opinion at all. A note is not enough either: `_expresses_something` is the
    read-through's wider question, and a reviewer who typed a comment without
    touching a slider has expressed no newer SCORE.

    Note what removal costs: once any reviewer VOTES on a row, the pre-ballot
    value of every document that row holds is gone, so a reviewer who has not
    saved stops seeing it read through and it stops counting in the aggregate.
    That is the deliberate trade — a value nobody's name is on is worth less than
    the guarantee that it can never be double-counted against the ballot that
    replaced it, and the reviewer who voted has just expressed the newer opinion.

    The aggregate asks the SAME predicate on the read side (`_aggregate_scores`
    counts the legacy value only while no ballot for that row is a vote), so
    the write's trigger and the read's suppression cannot disagree — and the read
    is what makes the no-double-count guarantee hold even when this best-effort
    write does not land.

    BEST EFFORT: no failure here is allowed to surface. The caller's ballot is
    already durably written by the time this runs, so raising would tell a
    reviewer their vote failed when it landed. Only the conditional failure (the
    already-migrated no-op) is expected; anything else is logged so a stuck
    migration is visible without being fatal.

    RETIREMENT: this path is PERMANENT unless someone deliberately makes "drained"
    observable first. The conditional fails identically whether the entry was just
    migrated or never existed, and removing the last member leaves an empty `scores`
    map rather than deleting the item, so "delete this once every deployment has
    drained" is a condition that can never be shown to have fired. What the
    per-invocation read above buys is that keeping it costs a deployment with nothing
    to migrate ONE `get_item` per save and no writes, rather than a write per
    document of every scored row forever. A future change that wants the path gone
    still has to add the marker it would key on (delete the item when the map
    empties, or stamp a `migrated_at` on it) as its first step.
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
            logger.warning(f"Legacy prioritization score removal failed: {e}")
    except Exception as e:
        logger.warning(f"Legacy prioritization score removal failed: {e}")


class _LegacyScores:
    """Which documents the pre-ballot `SCORES` map still holds, read ONCE per save.

    THE POINT IS THE EMPTY CASE. Migrate-on-write has to be attempted without the
    client asking for it, and it is keyed by DOCUMENT while a ballot is keyed by ROW
    — so "retire what this ballot supersedes" is, per scored row, a read of the row
    and a conditional delete per document it holds. Done unconditionally that is up
    to MAX_BALLOTS_PER_SAVE × MAX_ROW_DOCUMENT_IDS sequential writes in one
    invocation, forever, in a deployment that has never held a single legacy entry —
    which is every deployment that never ran the pre-ballot version. One keyed read
    of the map tells us there is nothing to do, and `empty` then skips the row read
    as well as the writes.

    ONE INSTANCE PER SAVE, not per row and not module-level. Per row would re-read
    the map for each of up to 100 rows. Module-level (or `lru_cache`) would outlive
    the request on a warm Lambda and cache "there is something here" against a map
    another invocation has since drained — and, worse, cache emptiness against a
    table handle from a previous configuration. A save is the natural scope: the
    entries this save can supersede are the ones present when it started.

    BEST EFFORT, like everything on this path: the ballot is already durably
    written, so a failed read reports NOTHING to remove rather than raising. The
    read's own suppression (`_superseded_rows`) is what makes the no-double-count
    guarantee hold whether or not any of this lands.
    """

    def __init__(self, table) -> None:
        self._table = table
        self._document_ids: set[str] | None = None

    def _held(self) -> set[str]:
        if self._document_ids is None:
            self._document_ids = _legacy_score_document_ids(self._table)
        return self._document_ids

    @property
    def empty(self) -> bool:
        """True when the map holds nothing this save could supersede.

        The one question worth asking before touching a row: false here and the
        whole migrate-on-write path — the row read included — is skipped.
        """
        return not self._held()

    def drop_for_row(self, row: Any) -> None:
        """Retire the pre-ballot value of every document the saved row holds.

        The translation the write side owes the read side: the legacy map is keyed
        by DOCUMENT and a ballot is keyed by ROW, so "this row's ballot supersedes
        that value" means the documents the row holds — the same mapping
        `_legacy_scores_by_row` performs on the read.

        Takes the ROW RECORD, not a row id: the save has already read every named
        row once to check it exists (`_fetched_ballot_rows`), and reading the same
        key a second time here answered a question the request already answered.
        The record is trusted defensively (`_row_document_ids` reads a malformed
        one as holding nothing), the same stance the page read takes.

        Attempts a delete only for a document the map was seen to hold, so a row of
        25 freshly-generated documents in a deployment holding one legacy entry
        issues at most one write rather than 25.

        The forgetting is local, and it forgets a FAILED attempt as readily as a
        successful one: an id leaves the remembered set once tried, whatever the
        delete then did. That keeps the bound this method promises — one attempt per
        id per save, so two scored rows sharing a document do not both try, and
        neither does a retry loop inside one invocation — and it costs nothing that
        matters, because the delete is best-effort either way. What guarantees the
        entry is not double-counted is the READ side's suppression
        (`_superseded_rows`), which holds whether or not any delete ever lands; the
        next save reads the map again and tries what is still there.
        """
        if self.empty:
            return
        held = self._held()
        for document_id in _row_document_ids(row):
            if document_id not in held:
                continue
            held.discard(document_id)
            _drop_legacy_score(self._table, document_id)


def _legacy_score_document_ids(table) -> set[str]:
    """The document ids the legacy `SCORES` map holds, or an empty set.

    Empty for the case that matters — no such item, which is every deployment that
    never ran the pre-ballot version — and also for a map that has been fully
    drained, an unreadable one, and a failed read. Every one of those means "nothing
    here to supersede", and this is a best-effort path on which a landed ballot must
    never be failed.
    """
    try:
        item = table.get_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': LEGACY_SCORES_SK}
        ).get('Item')
    except Exception as e:  # noqa: BLE001 - a landed ballot must never be failed
        logger.warning(f"Legacy prioritization score read failed: {e}")
        return set()
    if not isinstance(item, dict):
        return set()
    scores = item.get('scores')
    if not isinstance(scores, dict):
        return set()
    return {key for key in scores if isinstance(key, str) and key}


# ============================================
# Rows — a project's set of documents, scored once
# ============================================


def _row_document_ids(row: Any) -> list[str]:
    """The document ids a stored row holds, defensively.

    A row is written by this module and read straight back, but it is read on
    every page load and the read must never take the page down over a malformed
    item: a row whose `document_ids` is not a list of strings reads as holding
    nothing rather than raising. That is the same "an unreadable stored value is
    silence" reading `_readable_axis` takes one field over — on a read there is
    nobody to tell, so the choice is between saying nothing and inventing
    something.
    """
    if not isinstance(row, dict):
        return []
    stored = row.get('document_ids')
    if not isinstance(stored, list):
        return []
    return [value for value in stored if isinstance(value, str) and value]


def _fetched_ballot_rows(table, row_ids: list[str]) -> dict[str, dict]:
    """The row records for a save's named rows, keyed by row id — existing ones.

    One keyed read per row, before the first write; a named row absent from the
    result is one the save must refuse. The ids are validated shapes by the
    time they arrive here, so the key is always legal. The FETCHED items are
    returned rather than a mere existence verdict, because the legacy migration
    needs each scored row's `document_ids` and reading the same key twice in
    one save is a round trip that answers a question already answered.

    Sequential keyed reads rather than `batch_get_item`, deliberately: the page
    sends the rows a reader touched (single digits), the batch API lives on the
    client with unmarshalled-attribute plumbing this module otherwise never
    needs, and the loop stays inspectable by the same fakes the rest of the
    suite uses. The bound is MAX_BALLOTS_PER_SAVE either way.

    A FAILED read raises rather than answering "present" or "missing": either
    invented answer is worse than the truth. Calling it missing refuses a save
    the caller could legitimately make over a transient throttle; calling it
    present waves through exactly the orphan this check exists to refuse. The
    same reasoning the page read gives for raising on a failed partition read —
    "the read failed" and "nobody has scored anything" must stay
    distinguishable — applied to the write side.
    """
    fetched: dict[str, dict] = {}
    for row_id in row_ids:
        try:
            # Strongly consistent, because this read GATES a write and the case
            # it exists to distinguish is "created moments ago": the row create
            # answers the page, the page saves, and an eventually-consistent
            # read can miss the row it just handed out — refusing a legitimate
            # save with 404. Negligible cost for a keyed read on a save path.
            item = table.get_item(
                Key={'pk': PRIORITIZATION_PK, 'sk': _row_sk(row_id)},
                ConsistentRead=True,
            ).get('Item')
        except Exception as e:
            logger.exception(f'Failed to read a prioritization row before a save: {e}')
            raise ServiceError('Failed to save prioritization scores') from e
        if isinstance(item, dict):
            fetched[row_id] = item
    return fetched


def _fetched_row(table, row_id: str) -> dict | None:
    """One row record, or None — the DELETE's read.

    Separate from `_fetched_ballot_rows` for one reason: that helper's failed-read
    message says a SAVE failed, and a delete that reported "Failed to save
    prioritization scores" would send an operator reading the wrong route's logs. The
    consistency argument is the same and stated there.
    """
    try:
        item = table.get_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': _row_sk(row_id)},
            ConsistentRead=True,
        ).get('Item')
    except Exception as e:
        logger.exception(f'Failed to read a prioritization row before a delete: {e}')
        raise ServiceError('Failed to delete the prioritization row') from e
    return item if isinstance(item, dict) else None


def _is_default_row(row: Any) -> bool:
    """Is this the project's default row?

    Read off a stored FLAG rather than by re-deriving the id from the project id.
    The derivation is how the id is minted, and the flag is what the read asks, so
    a phase-2 row minted under a different scheme cannot accidentally answer yes
    because of how its id happens to be spelled.
    """
    return isinstance(row, dict) and row.get('is_default') is True


def _is_frozen_row(row: Any) -> bool:
    """Has a ballot landed on this row, so its composition is settled?

    Read off the presence of ROW_FROZEN_AT_FIELD, which is the SAME attribute the
    composition change's condition names. One fact, asked one way: a predicate that
    counted ballots instead could answer "not frozen" for a row the database will
    nonetheless refuse to recompose, which is a page saying the opposite of what the
    save does.
    """
    if not isinstance(row, dict):
        return False
    frozen_at = row.get(ROW_FROZEN_AT_FIELD)
    return isinstance(frozen_at, str) and bool(frozen_at)


def _row_payload(row: dict) -> dict:
    """One entry of the `rows` map the page consumes.

    Explicitly projected rather than returned whole, the same reasoning
    `item_to_widget_config` records in the feedback-form handler: `pk`/`sk` are
    storage detail, and a field added to the record later must not reach the page
    without somebody deciding it should.

    `is_frozen` is ADDITIVE and every existing field keeps its name and meaning, so
    the shipped page keeps working unchanged. It is a boolean rather than the stored
    instant because what a consumer can act on is whether the composition may still
    change; the instant itself is storage detail nothing on the page renders, and
    publishing it would invite a client to compute the freeze itself and disagree
    with the condition that actually enforces it. `ballot_writes` is not published
    for the same reason and a stronger one — it counts writes, not reviewers, and a
    number that looks like a reviewer count but is not is worse than no number.
    """
    return {
        'row_id': row.get('row_id', ''),
        'project_id': row.get('project_id', ''),
        'document_ids': _row_document_ids(row),
        'prototype_id': (
            row['prototype_id'] if isinstance(row.get('prototype_id'), str) else ''
        ),
        'is_default': _is_default_row(row),
        'created_at': row.get('created_at', ''),
        'is_frozen': _is_frozen_row(row),
    }


def _validated_row_project_id(raw: Any) -> str:
    """Check that a client-supplied project id can name a row.

    The project id reaches a SORT KEY through `_default_row_id`, so the same
    no-'#' rule every other half of a ballot key is held to applies here — and it
    is checked at the one place a row id is minted, which is what lets
    `_validated_ballot_row_id` refuse a '#' without having to explain where one
    could have come from.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValidationError('project_id is required')
    project_id = raw.strip()
    if '#' in project_id:
        raise ValidationError("project_id must not contain '#', the sort-key delimiter")
    if len(project_id) > MAX_KEY_SEGMENT_ID_LEN:
        raise ValidationError(
            f'project_id must be at most {MAX_KEY_SEGMENT_ID_LEN} characters'
        )
    return project_id


def _project_documents(project_id: str) -> list[dict]:
    """The project's documents, from the projects table.

    One logical query on the project's own partition — the same read `get_project`
    performs, minus the signing and the personas. Not `get_project` itself: that
    signs every prototype URL through CloudFront, which is work a row composition
    has no use for.

    PROJECTED to the three fields a composition reads. Documents store their body
    inline (`content`), so without this every full PRD, PR/FAQ, research doc and
    product report crossed the wire to pick two ids — and the page asks for one
    composition per project on mount.

    PAGINATED, and bounded then RAISED rather than truncated, which is the part that
    matters most here. DynamoDB caps a query page at 1MB; with bodies inline a
    project with a few revisions plus a product report reaches that without being
    unusual. A short read does not merely hide a document:

      * `sk` sorts ascending and `DOC#` precedes `META`, so a project carrying
        enough generic documents pushes its own `META` item onto a later page and
        the existence check answers 404 FOR A PROJECT THAT EXISTS. Only `DOC#`
        does this: `PRD#`, `PRFAQ#`, `PROTOTYPE#`, `RESEARCH#` and the rest all
        sort AFTER `META` (`ME` < `PR`), so revising a PRD alone cannot reach this
        shape — it reaches the next one;
      * truncation later composes a row from a superseded PRD, or refuses with "no
        PRD or PR/FAQ to score" for a project that has one.

    And a composition BECOMES FROZEN at the first ballot. The create is idempotent on
    the row id, so it never rewrites a row it finds; a recompose route exists, but the
    database refuses it once anybody has balloted (ROW_FROZEN_AT_FIELD), and a row
    composed from a short read is not marked as suspect in any way that would prompt
    somebody to correct it before that happens. So the repair window is real but
    closes on its own, unannounced — and after it closes every ballot on the row
    describes documents nobody chose. That asymmetry is why this refuses instead of
    returning what it has — the same reading `_read_prioritization_partition` takes one
    screen up, where "a silently-short window is exactly how this codebase has been
    bitten before".
    """
    table = get_projects_table()
    if not table:
        raise ConfigurationError('Projects table not configured')
    query_kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}'),
        # `sk` identifies the type, `document_id` and `created_at` are what the
        # composition selects on. None is a DynamoDB reserved word.
        'ProjectionExpression': 'sk, document_id, created_at',
    }
    items: list[dict] = []
    for _ in range(MAX_PROJECT_DOCUMENT_PAGES):
        response = table.query(**query_kwargs)
        items.extend(
            item for item in response.get('Items', []) if isinstance(item, dict)
        )
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return items
        query_kwargs['ExclusiveStartKey'] = last_key
    logger.error(
        'Project %s has more document pages than the %d this composition reads. '
        'A row composed from a short read is frozen and cannot be recomposed, so '
        'this refuses rather than composing from part of the project.',
        project_id,
        MAX_PROJECT_DOCUMENT_PAGES,
    )
    # 409, not 500, and the difference is behavioural rather than cosmetic. This is a
    # settled fact about the project's stored state — it will answer the same on every
    # attempt until documents are removed — so a status that invites a retry invites
    # one that can never succeed. The page releases a non-4xx for another try and
    # treats a 4xx as settled (`isPermanentRefusal`), and it re-asks on every project
    # refetch, so a 500 here would be a permanent loop against an unchanging answer:
    # exactly the per-refetch loop that predicate exists to prevent, on the one status
    # class it cannot classify as settled.
    raise ConflictError(
        'This project holds more documents than a prioritization row can be composed '
        'from in one read'
    )


# Which sort-key prefixes hold a SCORABLE document, and which holds a prototype.
#
# The scorable set is the backend's half of the frontend's `SCORABLE_TYPE_META`,
# which is "the single source of truth for which document types are scorable" on
# the page. The two are pinned against each other by
# `test_prioritization_scorable_types_lockstep.py`: a type scorable on one side
# only means either a row composed without a document the page shows sliders for,
# or a page refusing to show a document the row was scored on.
SCORABLE_SK_PREFIXES = ('PRD#', 'PRFAQ#')
PROTOTYPE_SK_PREFIX = 'PROTOTYPE#'


def _default_row_composition(documents: list[dict]) -> tuple[list[str], str]:
    """The concrete ids a project's default row is first composed of.

    THE LATEST OF EACH SCORABLE TYPE — one PRD and one PR/FAQ at most — plus the
    project's latest prototype as a separate field. The prototype is context a
    reviewer looks at rather than a document the row is scored on, which is why it
    is not in `document_ids`.

    "Latest of each type" describes THIS FUNCTION and nothing else. What it
    returns is a list of ids, and the row stores those ids; a row never holds a
    selector, so generating a new PRD later changes no existing row. That is what
    keeps a ballot describing the documents it was cast about.

    LATEST PER TYPE, NOT EVERY REVISION. Every scorable document of the project
    would put each iteration of a PRD on the row: a project that revised its PRD
    four times would get a row whose collapsed header shows seven type badges and
    whose copy says "7 documents, one ballot" about one idea described twice. A
    superseded draft is not a separate thing to score — it is the same thing,
    earlier — and the defect this change exists to fix is precisely one idea being
    presented as several. Choosing a different set (an older revision, both of two
    PRDs) is phase 2's `document_ids`-on-the-request, and the storage already holds
    an arbitrary list so nothing here has to move for it.

    Still bounded at MAX_ROW_DOCUMENT_IDS. Unreachable while the rule is
    latest-per-type and there are two types, and kept anyway: a row is one item read
    on every page load, the bound is the storage contract the frontend's schema
    mirrors, and it must hold whatever a later composition rule decides.
    """
    # Newest per type, by sort-key prefix — which is how the type is spelled in
    # storage (`SCORABLE_SK_PREFIXES`), so this cannot disagree with what counts as
    # scorable. `created_at` compares lexicographically because it is an ISO-8601
    # instant; a document with none sorts oldest, which is the right way for an
    # unreadable timestamp to lose to a readable one.
    newest_by_type: dict[str, dict] = {}
    for item in documents:
        sk = str(item.get('sk', ''))
        prefix = next((p for p in SCORABLE_SK_PREFIXES if sk.startswith(p)), None)
        if prefix is None:
            continue
        document_id = item.get('document_id')
        if not isinstance(document_id, str) or not document_id:
            continue
        incumbent = newest_by_type.get(prefix)
        if incumbent is None or str(item.get('created_at', '')) > str(incumbent.get('created_at', '')):
            newest_by_type[prefix] = item

    # Ordered by SCORABLE_SK_PREFIXES rather than by recency, so the badges on a
    # collapsed row read in a stable order across projects instead of flipping with
    # which document happened to be generated last.
    document_ids: list[str] = []
    for prefix in SCORABLE_SK_PREFIXES:
        item = newest_by_type.get(prefix)
        if item is None:
            continue
        document_id = item['document_id']
        if document_id not in document_ids:
            document_ids.append(document_id)
    document_ids = document_ids[:MAX_ROW_DOCUMENT_IDS]
    return document_ids, _latest_prototype_id(documents)


def _latest_prototype_id(documents: list[dict]) -> str:
    """The project's newest prototype id, or ''.

    Its own function because BOTH row-creating routes carry it and only one of them
    composes `document_ids`: the compose route takes the caller's document set and
    this prototype, so calling `_default_row_composition` for the prototype alone
    would have it deriving "latest of each type" for a set it then discards — a
    derivation sitting inside the one route whose whole contract is not to derive.
    """
    prototypes = [
        item for item in documents
        if str(item.get('sk', '')).startswith(PROTOTYPE_SK_PREFIX)
    ]
    prototypes.sort(key=lambda item: str(item.get('created_at', '')), reverse=True)
    for item in prototypes:
        candidate = item.get('document_id')
        if isinstance(candidate, str) and candidate:
            return candidate
    return ''


def _minted_row_id() -> str:
    """A new NON-default row's id.

    Always minted here, never taken from the request, for the reason
    `_validated_ballot_row_id` records: the id becomes the first segment of every
    ballot sort key on the row, so a caller-chosen id would put that key's shape
    under a caller's control. Hex, so it cannot carry the '#' the key is split on,
    and prefixed like the derived default ids so every row id in the partition reads
    alike.
    """
    return f'{DEFAULT_ROW_ID_PREFIX}{secrets.token_hex(ROW_ID_BYTES)}'


def _scorable_document_ids(documents: list[dict]) -> dict[str, str]:
    """Every SCORABLE document of the project, as document_id -> sort-key prefix.

    The candidate set a caller may compose a row from. Built from the project's own
    partition and keyed by the sort-key prefix, so "this project owns it" and "this
    type is scorable" are one lookup rather than two checks that could disagree —
    `pk` is the project and `sk` carries the type, which is the same reasoning
    `_validated_source_id` records for the generation routes' trust boundary.

    A prototype is deliberately absent: it is context a reviewer looks at rather
    than a document a row is scored on (see `_default_row_composition`), so offering
    one as a row member would put an unscorable id in `document_ids`.
    """
    owned: dict[str, str] = {}
    for item in documents:
        sk = str(item.get('sk', ''))
        prefix = next((p for p in SCORABLE_SK_PREFIXES if sk.startswith(p)), None)
        if prefix is None:
            continue
        document_id = item.get('document_id')
        if isinstance(document_id, str) and document_id:
            owned.setdefault(document_id, prefix)
    return owned


def _validated_row_document_ids(raw: Any, documents: list[dict]) -> list[str]:
    """The concrete document ids a caller asked a row to hold, or a refusal.

    STORED VERBATIM by the caller's choosing — this is what makes a row mean the
    same set forever. Nothing here re-derives "latest of each type": that rule
    composes a DEFAULT row once (`_default_row_composition`) and has no business
    reinterpreting a set somebody picked.

    Every refusal happens BEFORE anything is written, and each names the rule it
    failed rather than echoing the id, which is unbounded caller input a response
    body gains nothing by repeating (the reasoning `_validated_ballot_row_id` and
    `validate_bool` both record). Five rules, and the reason each one is a refusal
    rather than a repair:

    * NOT A LIST OF STRINGS — there is no set to store, and coercing one would
      invent a composition nobody chose.
    * EMPTY — a row with nothing to score is not a row. The same refusal the default
      row's create already makes for a project with no scorable document, in the
      same words the page already has an answer for.
    * AN ID THIS PROJECT DOES NOT OWN — the trust boundary. A row is a PROJECT'S set
      of documents, and a ballot's aggregate is read per project, so an id from
      elsewhere would put another project's document inside this project's team
      score. Checked against the project's own partition rather than against a
      caller-supplied project field.
    * AN ID THAT IS NOT SCORABLE — a prototype or a research report has no sliders
      on the page, so a row holding one would show a member nobody can score and
      the row's own copy would miscount what it holds.
    * A DUPLICATE — the same document twice says nothing new about the row, and it
      spends the bound twice; refused rather than de-duplicated for the reason the
      duplicate-key refusal in the save path records, that the request states
      something contradictory and there is nothing to prefer.

    Ownership and type share one message on purpose, and it is the one exception to
    "name the rule that failed": distinguishing them would tell a caller whether a
    document id exists in a project they may not have named, which is the same
    reason `_validated_source_id` answers one 404 for both.
    """
    if not isinstance(raw, list):
        raise ValidationError('document_ids must be a list of document id strings')
    if not raw:
        raise ValidationError(
            'document_ids must name at least one document, so the row has '
            'something to score'
        )
    if len(raw) > MAX_ROW_DOCUMENT_IDS:
        raise ValidationError(
            f'document_ids must name at most {MAX_ROW_DOCUMENT_IDS} documents'
        )
    owned = _scorable_document_ids(documents)
    document_ids: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or not entry.strip():
            raise ValidationError('document_ids must be non-empty document id strings')
        document_id = entry.strip()
        if document_id not in owned:
            raise NotFoundError(
                'document_ids name a document this project does not hold, or one '
                'that is not a PRD or a PR/FAQ'
            )
        if document_id in document_ids:
            raise ValidationError('document_ids must name distinct documents')
        document_ids.append(document_id)
    return document_ids


@app.post("/projects/prioritization/rows/compose")
@tracer.capture_method
def api_compose_prioritization_row():
    """Create a row for another combination of one project's documents.

    A ROW IS WHAT THE CALLER NAMED. The request carries the project and the concrete
    document ids, and those ids are stored verbatim — nothing here re-derives them,
    so the row means the same set forever and generating a newer PR/FAQ later leaves
    it composed exactly as it was. That is the same guarantee the default row has
    (`_default_row_composition`), stated for a set somebody picked.

    Open to any signed-in reviewer, per the decision recorded on #339: the identity
    of whoever composed a row is not the protection — the freeze is, and deletion is
    the one action that is admin-gated.

    Never a DEFAULT row. `is_default` is stamped false and the id is minted
    (`_minted_row_id`) rather than derived, so `POST .../rows` keeps its idempotence
    on a key nothing here can occupy: two calls to this route deliberately produce
    two rows, because "score another combination" is a request to add one.

    A minted id makes the conditional put a formality rather than an idempotence —
    it is kept anyway, because a put with no condition is an upsert, and the one
    thing worse than a failed create is a create that silently replaced a row whose
    ballots already exist.

    BOUNDED AT MAX_ROWS_PER_PROJECT, because this is the one route that adds a row
    per call and it is open to any signed-in reviewer. The partition the page reads
    WHOLE would otherwise grow without limit under ordinary authorized requests, and
    the read raises past its page budget rather than truncating — so enough composed
    rows takes the prioritization page down for everybody, not only for whoever
    composed them.

    The count is read and then the put is made, which is a read-then-write: two
    reviewers composing simultaneously against a project one row under the bound can
    both pass it and leave the project one row over. Accepted deliberately. Making it
    exact needs a counter item every compose contends on, and the bound is a
    protection against unbounded growth rather than an exact quota — one row over it
    is not a state the reads care about, while a hundred is. The bound still holds as
    a bound: the next call reads the crossed count and refuses.
    """
    body = _json_object_body()
    project_id = _validated_row_project_id(body.get('project_id'))

    documents = _project_documents(project_id)
    if not any(item.get('sk') == 'META' for item in documents):
        raise NotFoundError(f'Project {project_id} not found')
    document_ids = _validated_row_document_ids(body.get('document_ids'), documents)
    prototype_id = _latest_prototype_id(documents)

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')

    # Read no further than the bound: what this asks is "are there already this
    # many", and the keys past that answer nothing.
    existing = _project_row_sort_keys(table, project_id, limit=MAX_ROWS_PER_PROJECT)
    if len(existing) >= MAX_ROWS_PER_PROJECT:
        raise ConflictError(
            f'This project already holds the {MAX_ROWS_PER_PROJECT} prioritization '
            'rows one project may have; delete a row before composing another'
        )

    row_id = _minted_row_id()
    now = datetime.now(timezone.utc).isoformat()
    item = {
        'pk': PRIORITIZATION_PK,
        'sk': _row_sk(row_id),
        'row_id': row_id,
        'project_id': project_id,
        'document_ids': document_ids,
        # The project's latest prototype, as context, exactly as the default row
        # carries it. Not composable per row: a prototype is not scored, so a
        # separate selector for it would be a second dimension of choice over
        # something no ballot is about.
        'prototype_id': prototype_id,
        'is_default': False,
        'created_at': now,
        'updated_at': now,
        # No `ttl`: the aggregates table expires anything carrying one, and a row is
        # as durable as the ballots keyed to it.
    }
    try:
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
    except Exception as e:
        logger.exception(f'Failed to compose a prioritization row for {project_id}: {e}')
        raise ServiceError('Failed to create the prioritization row') from e

    return {'success': True, 'created': True, 'row': _row_payload(item)}


@app.patch("/projects/prioritization/rows/<row_id>")
@tracer.capture_method
def api_recompose_prioritization_row(row_id: str):
    """Change which documents an UN-BALLOTED row holds.

    THE DATABASE REFUSES A FROZEN ROW, not this function. The write is one
    conditional `update_item` whose condition asserts the row exists and carries no
    ROW_FROZEN_AT_FIELD, and the ballot save writes that attribute in the same
    transaction as the ballot itself — so a composition change racing the first
    ballot LOSES TO IT rather than being sorted out afterwards. Reading a ballot
    count first and then writing would land the change in the gap between the two
    calls, leaving a row whose documents nobody who balloted on it ever saw; that is
    the race #339 records as the reason the condition has to be the rule and
    disabled controls only a courtesy.

    A refusal answers 409 and writes nothing. 409 rather than 403, because the row's
    state is what refuses — the caller was permitted, and what they asked for
    conflicts with a fact about the world that a reload will show them.

    A DEFAULT ROW MAY BE RECOMPOSED, and the condition deliberately says nothing about
    `is_default`. "Latest of each type" is how a default row is FIRST COMPOSED, not a
    property it keeps: `_default_row_composition` is a starting point for a project
    nobody has set up, and narrowing it before anyone votes is the ordinary case this
    route exists for — a project holding four PRDs gets all four in one row, and the
    reviewer who wants to score two of them is editing the row they were handed, not
    replacing it. Refusing here would force compose-then-delete for that, which needs
    an admin (the delete is admin-gated) and leaves the project's derived key holding
    the row nobody wanted.

    The consequence is that after a recompose, `POST .../rows` answers `created: false`
    with a composition that is no longer what `_default_row_composition` would derive.
    That is the honest reading rather than a gap: the create's contract is "this
    project's row, whatever it now holds", and a create that re-derived would silently
    discard a choice somebody made. `is_default` continues to mean what it has always
    meant — the row a project got without a setup step, which is what makes it the one
    that cannot be deleted while it is the project's only row.

    `project_id` is asserted in the same condition rather than trusted from the
    row's stored value, so a recompose can only ever hold documents of the project
    the caller validated the ids against. Without it, naming another project's row
    id would install this project's documents on it.

    Open to any signed-in reviewer, for the same reason the create is.
    """
    validated_row_id = _validated_path_row_id(row_id)
    body = _json_object_body()
    project_id = _validated_row_project_id(body.get('project_id'))

    documents = _project_documents(project_id)
    if not any(item.get('sk') == 'META' for item in documents):
        raise NotFoundError(f'Project {project_id} not found')
    document_ids = _validated_row_document_ids(body.get('document_ids'), documents)

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')

    now = datetime.now(timezone.utc).isoformat()
    try:
        response = table.update_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': _row_sk(validated_row_id)},
            UpdateExpression=(
                'SET #document_ids = :document_ids, #updated_at = :updated_at'
            ),
            # THE FREEZE. All three conjuncts matter: `attribute_exists` because
            # `update_item` is an upsert and would otherwise create a bare row
            # record for an id that never existed; the frozen mark because that is
            # what the first ballot writes; the project because the ids were
            # validated against THAT project's documents and no other.
            ConditionExpression=(
                f'attribute_exists(sk) AND attribute_not_exists({ROW_FROZEN_AT_FIELD}) '
                'AND #project_id = :project_id'
            ),
            ExpressionAttributeNames={
                '#document_ids': 'document_ids',
                '#updated_at': 'updated_at',
                '#project_id': 'project_id',
            },
            ExpressionAttributeValues={
                ':document_ids': document_ids,
                ':updated_at': now,
                ':project_id': project_id,
            },
            ReturnValues='ALL_NEW',
        )
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            logger.exception(f'Failed to recompose prioritization row: {e}')
            raise ServiceError('Failed to change the row composition') from e
        # ONE answer for all three ways the condition fails, and it is a 409 rather
        # than three statuses. Telling them apart would need a read the condition
        # exists to avoid, and the read could disagree with the write it is
        # explaining; what a caller can act on is the same in every case — reload
        # and see the current rows.
        raise ConflictError(
            'This row cannot be recomposed: it does not exist, it belongs to '
            'another project, or a ballot has already frozen its composition'
        ) from e
    except Exception as e:
        logger.exception(f'Failed to recompose prioritization row: {e}')
        raise ServiceError('Failed to change the row composition') from e

    stored = response.get('Attributes')
    if not isinstance(stored, dict):
        # `ALL_NEW` on a landed update always carries the item; answering the
        # composed request instead would claim a stored state nothing read.
        raise ServiceError('Failed to read the recomposed row back')
    return {'success': True, 'row': _row_payload(stored)}


def _project_row_sort_keys(table, project_id: str, *, limit: int | None = None) -> list[str]:
    """The sort key of every ROW of one project, in ascending key order.

    A bounded, strongly-consistent query over the row keys only
    (`begins_with(sk, 'ROW#')`), so the ballots — which outnumber the rows — are not
    read to answer a question about rows. Strongly consistent because it GATES both
    of its callers' writes, and the case that matters is "composed moments ago".

    PROJECTED to `sk` and `project_id`, which is everything either caller reads.
    Without it every row of every project crossed the wire with its `document_ids`
    inline to answer a question about one project's row COUNT — the same cost
    `_row_ballot_sort_keys` projects away one screen down.

    Filtered on the stored `project_id` field rather than by parsing the row id: a
    minted id says nothing about its project, which is exactly why the record carries
    the field (see DEFAULT_ROW_ID_PREFIX). That filter is applied HERE rather than as
    a DynamoDB `FilterExpression` because a filter is applied after the page is read
    and so changes nothing about what is paid for, while making the page's item count
    unpredictable — the pagination this loop performs is easier to reason about when
    every page it sees is a full one.

    `limit` STOPS EARLY once that many of the project's rows have been seen, which is
    what keeps the delete's sibling lookup from reading a whole keyspace to find one
    row. Ascending key order is preserved, so "the lowest-keyed sibling" is still
    deterministic: the first qualifying key of the first page is the lowest one there
    is.
    """
    query_kwargs: dict[str, Any] = {
        'KeyConditionExpression': (
            Key('pk').eq(PRIORITIZATION_PK) & Key('sk').begins_with(ROW_SK_PREFIX)
        ),
        # `project_id` is not a DynamoDB reserved word; `sk` is the key itself.
        'ProjectionExpression': 'sk, project_id',
        'ConsistentRead': True,
    }
    sort_keys: list[str] = []
    for _ in range(MAX_PRIORITIZATION_PAGES):
        response = table.query(**query_kwargs)
        for item in response.get('Items', []):
            if not isinstance(item, dict) or item.get('project_id') != project_id:
                continue
            sort_key = str(item.get('sk', ''))
            if sort_key:
                sort_keys.append(sort_key)
            if limit is not None and len(sort_keys) >= limit:
                return sort_keys
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return sort_keys
        query_kwargs['ExclusiveStartKey'] = last_key
    logger.error(
        'Prioritization rows exceed %d query pages while counting one '
        "project's rows.",
        MAX_PRIORITIZATION_PAGES,
    )
    raise ServiceError('Too many prioritization rows to read in one request')


def _sibling_row_sk(table, row: dict, row_id: str) -> str | None:
    """The sort key of one OTHER row of this row's project, if there is one.

    Returned rather than a bare "has siblings" verdict, because the delete FENCES on
    it: the sibling's key goes into the transaction as a `ConditionCheck`, so a
    concurrent delete of the last sibling cancels this one instead of leaving the
    project with no row at all. A read that merely counted would let two admins each
    see two rows and each delete one.

    Deterministic (the lowest sort key) so the same delete fences on the same
    sibling on a retry. TWO keys are asked for, not one, because the row being
    deleted is itself one of the project's rows and is dropped below — asking for
    one could return only that row and report a project with a sibling as having
    none.
    """
    project_id = row.get('project_id')
    if not isinstance(project_id, str) or not project_id:
        # A row whose project cannot be read has no siblings that can be found.
        # Treated as "no sibling", which only ever makes the delete of a DEFAULT row
        # stricter — it refuses. A non-default row is unaffected.
        return None
    siblings = sorted(
        sort_key
        for sort_key in _project_row_sort_keys(table, project_id, limit=2)
        if sort_key != _row_sk(row_id)
    )
    return siblings[0] if siblings else None


def _row_ballot_sort_keys(table, row_id: str) -> list[str]:
    """The sort key of every ballot keyed to one row.

    `begins_with(sk, 'BALLOT#{row_id}#')` — the trailing '#' is what keeps the prefix
    from also matching a row id this one is a prefix of, which minted ids make
    possible in principle and a hand-created one makes possible in practice.
    Strongly consistent, because a ballot missed here is a ballot the delete leaves
    behind.

    PROJECTED to the key. Nothing about a ballot's contents decides whether it is
    deleted — it is deleted because the row it describes is going — and the ballots
    of a heavily-reviewed row carry notes this would otherwise pull across the wire.

    Bounded at MAX_ROW_BALLOTS_PER_DELETE and then REFUSED rather than truncated: a
    short read here would delete the row and leave the ballots that did not fit,
    which is exactly the orphan the whole path exists to prevent.

    THE PAGE-EXHAUSTION BRANCH IS UNREACHABLE TODAY, and kept as a guard rather than
    dropped. A page of key-only projected items holds far more than the 98/20 ≈ 5
    ballots that would be needed to spend the page budget before the ballot bound, so
    the ballot bound always binds first. It is retained because the two limits are
    independent — MAX_ROW_BALLOTS_PER_DELETE follows DynamoDB's transaction cap and
    MAX_PRIORITIZATION_PAGES the read this module performs everywhere — so raising
    either without the other makes it live, and a loop with no terminating case is
    not something to leave behind on the strength of an arithmetic coincidence.
    Stated here rather than left to a reader, because a distinct, carefully-worded
    message reads as a live path.

    The two messages differ because the remedies would: one is a row too heavily
    balloted for one transaction, the other a partition that has outgrown the read. A
    single message covering both would name the wrong cause for whichever case it was
    not written about.
    """
    query_kwargs: dict[str, Any] = {
        'KeyConditionExpression': (
            Key('pk').eq(PRIORITIZATION_PK)
            & Key('sk').begins_with(f'{BALLOT_SK_PREFIX}{row_id}#')
        ),
        'ProjectionExpression': 'sk',
        'ConsistentRead': True,
    }
    sort_keys: list[str] = []
    for _ in range(MAX_PRIORITIZATION_PAGES):
        response = table.query(**query_kwargs)
        sort_keys.extend(
            str(item['sk']) for item in response.get('Items', [])
            if isinstance(item, dict) and item.get('sk')
        )
        if len(sort_keys) > MAX_ROW_BALLOTS_PER_DELETE:
            logger.error(
                'A prioritization row holds more than the %d ballots one atomic '
                'delete can remove. Deleting it in several writes would leave '
                'orphaned ballots between them, which is the fault this path exists '
                'to prevent.',
                MAX_ROW_BALLOTS_PER_DELETE,
            )
            raise ConflictError(
                f'This row holds more than the {MAX_ROW_BALLOTS_PER_DELETE} ballots '
                'that can be removed together with it in one atomic write'
            )
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return sort_keys
        query_kwargs['ExclusiveStartKey'] = last_key
    logger.error(
        "A prioritization row's ballots exceed %d query pages, so the delete cannot "
        'enumerate them all. Deleting the row on a short read would orphan the '
        'ballots it did not see.',
        MAX_PRIORITIZATION_PAGES,
    )
    raise ServiceError('Too many ballots on this row to read in one request')


def _cancelled_by_condition(e: ClientError, index: int | None = None) -> bool:
    """Did a CONDITION cancel this transaction, or did contention?

    A `TransactionCanceledException` IS NOT ONLY A FAILED CONDITION. DynamoDB
    cancels a transaction with the same exception for `TransactionConflict`
    (another in-flight transaction touching one of the same items),
    `ThrottlingError`, `ProvisionedThroughputExceeded`,
    `ItemCollectionSizeLimitExceeded` and `ValidationError` — and botocore does not
    auto-retry it, so every one of those arrives at the caller's `except`. Reading
    the exception as "the condition failed" therefore reports a TRANSIENT failure
    as a settled fact about the world, which is the worst direction to be wrong in:
    the page treats a 4xx as a refusal retrying cannot fix, so the reviewer is told
    to reload a row that is still there and their ballot is simply gone, where a
    500 would have been released for a retry and saved.

    `TransactionConflict` is not theoretical on these writes. Every ballot on a row
    `ADD`s to the SAME row record, so two reviewers scoring one row at the same
    moment — the ordinary case — contend on one item, and an admin's delete of that
    row is a third contender.

    `index`, when given, is the position in the `TransactItems` list whose condition
    the caller is asking about, so a condition failure somewhere else in the same
    transaction cannot be mistaken for this one. `None` asks "did any condition
    fail", which is what a caller answers the same way whichever of its conditions
    it was.

    A MISSING or SHORT `CancellationReasons` answers False, so an unreadable
    cancellation is handled as the transient failure it might be rather than as the
    condition it might not be.
    """
    reasons = e.response.get('CancellationReasons')
    if not isinstance(reasons, list):
        return False
    if index is not None:
        if index >= len(reasons):
            return False
        reasons = [reasons[index]]
    return any(
        isinstance(reason, dict) and reason.get('Code') == 'ConditionalCheckFailed'
        for reason in reasons
    )


def _transact_delete_row(
    table, row: dict, row_id: str, ballot_sks: list[str], sibling_sk: str | None
) -> None:
    """Remove the row record and every listed ballot in ONE transaction.

    The row's delete carries the fence: it must still exist, and its
    ROW_BALLOT_WRITES_FIELD must read exactly what it read when the row was fetched
    — which the ballot transaction increments, so a ballot landing at any point
    after that fetch cancels this write rather than being orphaned by it. The
    snapshot is taken BEFORE the ballots are enumerated, so a ballot arriving during
    the enumeration also cancels the delete even though the enumeration saw it: the
    fence is deliberately conservative, because a spurious 409 costs a retry and a
    missed one costs an orphaned ballot. A row that had never taken a ballot fences
    on the attribute being ABSENT, which is the same assertion for the same reason.

    The fence value is passed through UNCONVERTED. It was read at the resource layer
    (a `Decimal`) and goes back as `:seen_writes` through `table.meta.client` — the
    RESOURCE'S client, which carries the resource's type serializer, so the `Decimal`
    becomes `{'N': '1'}` and the comparison holds. This is the one place in the module
    where a value read at the resource layer is fed back through a client-layer call,
    which is why it is written down: issuing this transaction on a bare
    `boto3.client('dynamodb')` instead would reject every native value in it outright.
    `test_projects_prioritization_row_lifecycle_moto.py` executes this against a real
    implementation for exactly that reason — the suite's fake accepts whatever `dict`
    it is handed, so it cannot tell a legal request from an illegal one.

    `sibling_sk`, when present, is a `ConditionCheck` asserting that another row of
    the project still exists. It is what makes "the default row is not deleted while
    it is the project's only row" survive two admins acting at once.

    A transaction cancelled BY A CONDITION is a 409 naming the state that moved, and
    nothing is written — a transaction either applies whole or not at all, which is
    the property this path is built on. A cancellation for any other reason
    (contention, throttling) is a 500, because "reload the page and try again" is
    advice about a state that did not actually change; see
    `_cancelled_by_condition`.
    """
    items: list[dict] = []
    if sibling_sk:
        items.append({
            'ConditionCheck': {
                'TableName': table.name,
                'Key': {'pk': PRIORITIZATION_PK, 'sk': sibling_sk},
                'ConditionExpression': 'attribute_exists(sk)',
            },
        })
    seen_writes = row.get(ROW_BALLOT_WRITES_FIELD)
    row_delete: dict[str, Any] = {
        'TableName': table.name,
        'Key': {'pk': PRIORITIZATION_PK, 'sk': _row_sk(row_id)},
        'ExpressionAttributeNames': {'#ballot_writes': ROW_BALLOT_WRITES_FIELD},
    }
    if seen_writes is None:
        row_delete['ConditionExpression'] = (
            'attribute_exists(sk) AND attribute_not_exists(#ballot_writes)'
        )
    else:
        row_delete['ConditionExpression'] = (
            'attribute_exists(sk) AND #ballot_writes = :seen_writes'
        )
        row_delete['ExpressionAttributeValues'] = {':seen_writes': seen_writes}
    items.append({'Delete': row_delete})
    items.extend(
        {'Delete': {
            'TableName': table.name,
            'Key': {'pk': PRIORITIZATION_PK, 'sk': sort_key},
        }}
        for sort_key in ballot_sks
    )

    try:
        table.meta.client.transact_write_items(TransactItems=items)
    except ClientError as e:
        if (
            e.response.get('Error', {}).get('Code') != 'TransactionCanceledException'
            # Any condition in this transaction: the row's fence and the sibling's
            # existence are both states the caller reloads to see, so which one it
            # was does not change the answer. What DOES change it is a cancellation
            # that no condition caused — that is contention, and it is a 500 the page
            # will retry rather than a 409 it will not.
            or not _cancelled_by_condition(e)
        ):
            logger.exception(f'Failed to delete a prioritization row: {e}')
            raise ServiceError('Failed to delete the prioritization row') from e
        logger.warning(
            'A prioritization row delete was cancelled; the row changed between '
            'reading its ballots and removing them, or its last sibling row was '
            'deleted concurrently. Nothing was written.'
        )
        raise ConflictError(
            'This row changed while it was being deleted; reload the page and '
            'try again'
        ) from e
    except Exception as e:
        logger.exception(f'Failed to delete a prioritization row: {e}')
        raise ServiceError('Failed to delete the prioritization row') from e


@app.delete("/projects/prioritization/rows/<row_id>")
@tracer.capture_method
def api_delete_prioritization_row(row_id: str):
    """Delete one row TOGETHER WITH ITS BALLOTS. Admin only.

    ONE ATOMIC WRITE, so no ballot outlives the row it describes. A row and its
    ballots share a partition precisely so this is possible: the ballots are read
    with `begins_with(sk, 'BALLOT#{row_id}#')`, and the row record plus every ballot
    found go into a single `transact_write_items`. Deleting the row first and its
    ballots afterwards would leave, on any failure between the two, exactly the
    orphaned ballots the page read counts and warns about — the warning whose rising
    count is the signal that this path is NOT working (#342).

    FENCED on the row not having changed since the ballots were enumerated.
    ROW_BALLOT_WRITES_FIELD is what the ballot transaction increments, so a ballot
    landing between the read and the delete moves it and the transaction is
    cancelled rather than committing a delete that would leave that ballot behind.
    The caller is answered 409 and retries against the current state. A transaction
    cannot both enumerate and delete, so the fence is what closes the gap the
    enumeration opens.

    `ballots_deleted` IS THE EVIDENCE the deletion was complete. It is the only
    thing the caller has: the row is gone, so nothing can be re-read to check, and a
    bare `{'success': True}` would be identical whether the ballots went with the
    row or were left orphaned in the partition.

    ADMIN ONLY, through the shared `require_admin` — the one destructive action on a
    row, per the decision recorded on #339, and the reason a frozen row is never
    edited but may be deleted. A non-admin caller is refused BEFORE anything is
    read, so a 403 costs no round trip and, more importantly, cannot be a 403 that
    deleted something first.

    THE DEFAULT ROW IS NOT DELETABLE WHILE IT IS THE PROJECT'S ONLY ROW. The page
    invites a PRD or a PR/FAQ for a project with no scorable document, so a project
    whose only row was deleted would show that invitation beside documents it still
    holds — and the create route is idempotent on a derived key, which makes the
    resulting state one nothing in the product can repair by asking again.
    """
    require_admin(app.current_event.raw_event)
    validated_row_id = _validated_path_row_id(row_id)

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')

    row = _fetched_row(table, validated_row_id)
    if row is None:
        raise NotFoundError('That prioritization row does not exist')

    # Only a DEFAULT row needs a sibling, and only a default row pays the query that
    # looks for one: a row somebody composed is never the reason a project has a row
    # at all, so deleting it can never leave the page inviting a PRD for a project
    # that has one.
    is_default = _is_default_row(row)
    sibling_sk = _sibling_row_sk(table, row, validated_row_id) if is_default else None
    if is_default and sibling_sk is None:
        raise ConflictError(
            "A project's default row cannot be deleted while it is the project's "
            'only row'
        )

    ballot_sks = _row_ballot_sort_keys(table, validated_row_id)
    _transact_delete_row(table, row, validated_row_id, ballot_sks, sibling_sk)
    # THE ONLY TRACE A COMPLETED DELETE LEAVES. `ballots_deleted` is evidence only in
    # the caller's own response body, and every ballot removed here is a durable
    # decision record — so an operator asked "where did the team's score go?" has
    # nothing to read without this, and the page read's discard-warning count cannot
    # tell a legitimate delete from the orphaning it is watching for. The cancelled
    # case already logs; leaving the successful one silent made the delete that
    # actually removed data the one with no record of it.
    #
    # No caller identity and no ballot content, per the module's standing rule: the
    # row id and the counts are what an investigation needs, and a reviewer's subject
    # is not.
    logger.info(
        'Deleted prioritization row %s (default: %s) with %d ballot(s)',
        validated_row_id, is_default, len(ballot_sks),
    )
    return {
        'success': True,
        'row_id': validated_row_id,
        'ballots_deleted': len(ballot_sks),
    }


@app.post("/projects/prioritization/rows")
@tracer.capture_method
def api_create_prioritization_row():
    """Ensure the default row of one project exists, and return it.

    IDEMPOTENT, which is the whole contract: asking twice yields the SAME row
    rather than a second one. The row id is derived from the project id
    (`_default_row_id`) and the write is conditional on the key not already
    existing, so two callers racing on a project that has never been prioritised
    end with one row — the loser's condition fails and it reads back the row the
    winner wrote. A minted id plus a read-then-write would lose that race silently
    and give one project two default rows, each with its own ballots.

    Composed from the project's own documents, and REFUSED for a project with no
    scorable document: a row with nothing to score is not a row, and the page
    already has words inviting a PRD or a PR/FAQ for that project. So "a project
    with no scorable documents has no row" is enforced here rather than left to
    whoever calls.

    Authenticated exactly like every other prioritization route — it is under the
    same `/projects` proxy — and deliberately open to any signed-in reviewer, per
    the decision recorded on the issue: the freeze phase 2 adds is the protection,
    not the identity of whoever created the row.
    """
    body = _json_object_body()
    project_id = _validated_row_project_id(body.get('project_id'))

    documents = _project_documents(project_id)
    if not any(item.get('sk') == 'META' for item in documents):
        raise NotFoundError(f'Project {project_id} not found')
    document_ids, prototype_id = _default_row_composition(documents)
    if not document_ids:
        raise ValidationError(
            'This project has no PRD or PR/FAQ to score, so it has no prioritization row'
        )

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')

    row_id = _default_row_id(project_id)
    now = datetime.now(timezone.utc).isoformat()
    item = {
        'pk': PRIORITIZATION_PK,
        'sk': _row_sk(row_id),
        'row_id': row_id,
        'project_id': project_id,
        # CONCRETE ids, never the selector that chose them. See
        # `_default_row_composition`.
        'document_ids': document_ids,
        'prototype_id': prototype_id,
        'is_default': True,
        'created_at': now,
        'updated_at': now,
        # No `ttl`: the aggregates table expires anything carrying one, and a row
        # is as durable as the ballots keyed to it.
    }
    try:
        table.put_item(
            Item=item,
            # THE idempotence. Not a read-then-write: two simultaneous callers both
            # read "no row" and both write, and one project ends up with two rows
            # holding two disjoint sets of ballots.
            ConditionExpression='attribute_not_exists(sk)',
        )
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            logger.exception(f'Failed to create prioritization row for {project_id}: {e}')
            raise ServiceError('Failed to create the prioritization row') from e
        # Already there — which is a success for a route whose contract is "this
        # row exists". Read it back rather than answering the item just composed:
        # the stored row is the one the ballots are keyed to, and its composition
        # is whatever it was created with, not what "latest of each type" would
        # pick today.
        existing = table.get_item(
            Key={'pk': PRIORITIZATION_PK, 'sk': _row_sk(row_id)}
        ).get('Item')
        if not isinstance(existing, dict):
            # The condition said the item exists and the read says it does not,
            # which only a deletion between the two calls explains. Reported rather
            # than papered over with the composed item, which would claim a
            # composition nothing stored.
            raise ServiceError('Failed to read the prioritization row back') from e
        return {'success': True, 'created': False, 'row': _row_payload(existing)}
    except Exception as e:
        logger.exception(f'Failed to create prioritization row for {project_id}: {e}')
        raise ServiceError('Failed to create the prioritization row') from e

    return {'success': True, 'created': True, 'row': _row_payload(item)}


@app.get("/projects/prioritization")
@tracer.capture_method
def api_get_prioritization_scores():
    """Return the rows, the caller's own ballots on them, and the team aggregate.

    Three maps, ALL KEYED BY ROW ID, out of ONE query on the partition:

      * `rows` — what each row is: its project and the concrete document ids it
        holds. Returned with the scores rather than behind a route of its own, so
        the page learns what every row contains without a second round trip per
        row.
      * `scores` — the CALLER'S own ballot per row (or a legacy pre-ballot value on
        a row whose documents carry one and where the caller has none yet).
      * `aggregates` — what every reviewer together said, per row.

    A stored ballot naming a row that no longer resolves is IGNORED rather than
    allowed to break the page: it contributes to nothing and appears in nothing.
    That is the read behaving like the rest of this module does about unreadable
    stored values — there is nobody to tell, so the choice is between silence and
    inventing a row — and it is what makes a deleted row (phase 2) a non-event for
    a reader here.

    A failed read RAISES. Returning an empty map made "the read failed" and
    "nobody has scored anything" indistinguishable, so a transient DynamoDB error
    looked like an unscored backlog — and a save from that state would then
    persist zeros over real ballots.
    """
    subject = _caller_reviewer_subject()
    try:
        items = _read_prioritization_partition()
    except ApiError:
        raise
    except Exception as e:
        logger.exception(f"Failed to read prioritization ballots: {e}")
        raise ServiceError('Failed to read prioritization scores') from e

    caller_segment = _reviewer_segment(subject)
    legacy_scores: dict = {}
    rows_by_id: dict[str, dict] = {}
    all_ballots: list[tuple[str, str, dict]] = []

    for item in items:
        sk = item.get('sk') or ''
        if sk == LEGACY_SCORES_SK:
            stored = item.get('scores')
            legacy_scores = stored if isinstance(stored, dict) else {}
            continue
        if sk.startswith(ROW_SK_PREFIX):
            row_id = sk[len(ROW_SK_PREFIX):]
            if row_id:
                rows_by_id[row_id] = item
            continue
        parsed = _parse_ballot_sk(sk)
        if not parsed:
            continue
        row_id, reviewer = parsed
        all_ballots.append((row_id, reviewer, item))

    # A ballot whose row does not resolve is dropped here, once, so that neither
    # the caller's own map nor the aggregate can name a row the response does not
    # describe. Filtering in only one of the two places is how `scores` came to
    # disagree with `aggregates` about the legacy value, one field over.
    #
    # COUNTED AND LOGGED, not dropped in silence. A discarded ballot is somebody's
    # opinion disappearing, and until this read the discard left no trace at all:
    # no log, no count, a 200, and a row reading as never scored. That is the same
    # class of fault this function refuses one screen up, where crossing the page
    # bound RAISES rather than truncating because "a silently-short window is
    # exactly how this codebase has been bitten before" — so it should not be
    # silent here either.
    #
    # A warning rather than a raise, because a stale ballot must never take the
    # page down, and aggregated rather than per-item so one poisoned partition
    # cannot flood the log. Two shapes reach it: the one-time cost of this change
    # (ballots keyed by a DOCUMENT id, written by the deployment before rows
    # existed — abandoned deliberately, no migration), and any future ballot whose
    # row has gone. Phase 2 introduces row deletion, which is when the second
    # becomes ordinary and needs the delete-row-with-its-ballots path rather than
    # this line; the count is what will show whether that is working.
    ballots_by_row: dict[str, list[dict]] = {}
    caller_ballots: dict[str, dict] = {}
    unresolved_rows: set[str] = set()
    unresolved_ballots = 0
    for row_id, reviewer, item in all_ballots:
        if row_id not in rows_by_id:
            unresolved_rows.add(row_id)
            unresolved_ballots += 1
            continue
        ballots_by_row.setdefault(row_id, []).append(item)
        if reviewer == caller_segment:
            caller_ballots[row_id] = item

    if unresolved_ballots:
        # EVERY read, not once per environment, and the message has to say so: nothing
        # deletes an orphaned ballot, so a partition holding one logs this on every
        # page load until somebody removes it. A line that implied "once" would leave
        # an on-call reader hunting for a recurrence that is the normal state.
        #
        # The row ids are not logged: one of them is a document id from the old key
        # shape, and this module's rule is not to echo stored identifiers. The counts
        # are what make the loss detectable, and naming the remedy is what keeps a
        # permanent warning from being permanent noise.
        logger.warning(
            'Discarded %d prioritization ballot(s) across %d row id(s) that no row '
            'record describes; repeats on every read until those items are removed. '
            'A stable count is the expected one-off from ballots written before rows '
            'existed. A RISING count means ballots are being written against rows '
            'that do not exist, which is a defect rather than history.',
            unresolved_ballots,
            len(unresolved_rows),
        )

    scores = {
        row_id: _score_payload(row_id, ballot)
        for row_id, ballot in caller_ballots.items()
    }
    # Read-through: a row the caller has not scored, but one of whose documents
    # carries a pre-ballot value, still shows that value rather than looking
    # unscored. `_legacy_scores_by_row` is what decides which row a document-keyed
    # legacy value lands on — the default row of the project owning the document.
    #
    # Only entries that EXPRESSED SOMETHING are read through. A value the write
    # path would refuse is not read through as if a reviewer had entered it: every
    # axis of an unreadable entry reads 0.0 out of `_axis_value`, so passing one to
    # `_score_payload` showed the caller an invented lowest score on all four axes
    # for a row `_aggregate_scores` correctly omits — the two halves
    # disagreeing about the same value.
    #
    # `_expresses_something` rather than `isinstance(entry, dict)`, because a type
    # filter closes only the non-dict shape: `{'impact': 'high'}` IS a dict and
    # would still read through as a full zero row. Built from the same
    # `_carries_axis` predicate the aggregate asks, so the two cannot drift and any
    # later unreadable shape is closed at both ends at once.
    #
    # The legacy map predates this route's validation and was written by a handler
    # with no type discipline, so neither shape is ruled out by construction, and
    # nothing migrates one away until the first save against that row.
    #
    # A SUPERSEDED value is not read through either, even to a caller who has no
    # ballot of their own: once somebody has voted, the unattributed value has been
    # replaced, and `_aggregate_scores` already stops counting it. Showing it here
    # would put a number in `scores` that the same response's `aggregates` says
    # nobody scored — and it would do so only when the best-effort
    # `_drop_legacy_score` happened to fail, so the page's starting numbers would
    # depend on whether a write nobody was told about landed.
    legacy_by_row = _legacy_scores_by_row(legacy_scores, rows_by_id)
    superseded = _superseded_rows(ballots_by_row)
    for row_id, entry in legacy_by_row.items():
        if row_id in scores or row_id in superseded:
            continue
        # ONE pre-ballot value per row, already chosen by `_legacy_scores_by_row`
        # (a vote in preference to a note, in a fixed document order). Choosing
        # there rather than here is what keeps `scores` and `aggregates` describing
        # the SAME opinion: they used to disagree by construction — this loop took
        # the first entry that expressed anything while the aggregate counted every
        # entry as its own reviewer.
        scores[row_id] = _score_payload(row_id, entry)

    return {
        'rows': {row_id: _row_payload(row) for row_id, row in rows_by_id.items()},
        'scores': scores,
        'aggregates': _aggregate_scores(ballots_by_row, legacy_by_row),
    }


def _ballot_update_kwargs(row_id: str, subject: str, entry: dict, now: str) -> dict:
    """The single `update_item` that persists one row's ballot for one reviewer.

    Only the axes the caller ACTUALLY SENT are assigned. Writing all four
    unconditionally with `validate_int(default=0)` meant a body carrying just
    `{'impact': 5}` silently rewrote the reviewer's other three axes to zero —
    the same "a write destroys scores someone entered" defect this change exists
    to remove, merely relocated from between reviewers to inside one reviewer's
    own ballot. The verb is PATCH, so an omitted axis means "leave it alone".
    `notes` follows the same rule for the same reason.

    "Sent" means CARRIES A VALUE, not merely present as a key: an explicit
    `null` is treated as absent. Membership alone (`axis not in entry`) counted a
    null as sent and clamped it to 0 through `validate_int`, so `{'impact': null}`
    destroyed a reviewer's stored 4 — the same partial-write loss this method
    exists to prevent, surviving for one encoding of "no value". Since the intent
    here is "leave an unspecified axis alone", a serialiser that writes untouched
    fields as `null` is expressing exactly that intent and must be read that way
    (`validate_bool` in shared/api.py records the same null-is-absent reading).
    `notes` follows suit, so a null note preserves the stored text instead of
    blanking it.

    Present axes still go through `validate_int`, so an out-of-range slider is
    clamped to 0-5 rather than failing a whole multi-row save over one axis.
    Nothing here has to fall back, though: `_validated_ballot_entry` has already
    refused any axis that is not a clampable number, and any `notes` that is not a
    string or that exceeds MAX_BALLOT_NOTE_LEN — so `validate_int`'s `default` is
    unreachable and the note is written VERBATIM. It is not truncated here: a
    silently shortened note is a durable decision record losing its tail on a 200,
    which is the same loss refusing a non-string prevents. That ordering is
    deliberate — a value refused up front cannot half-persist a multi-row
    save, and neither an invented 0 nor a shortened note can overwrite what a
    reviewer stored.

    The three BALLOT_STAMP_FIELDS are always assigned; everything else is
    conditional. `_writes_a_reviewer_value` reads that distinction back off the
    kwargs this returns, which is what keeps `updated_count` counting ballots that
    stored something rather than keys received.
    """
    assignments = [f'#{field} = :{field}' for field in BALLOT_STAMP_FIELDS]
    names = {f'#{field}': field for field in BALLOT_STAMP_FIELDS}
    values: dict[str, Any] = {
        ':row_id': row_id,
        ':reviewer': _reviewer_segment(subject),
        ':updated_at': now,
    }

    for axis in SCORE_AXES:
        if not _carries_axis(entry, axis):
            continue
        assignments.append(f'#{axis} = :{axis}')
        names[f'#{axis}'] = axis
        values[f':{axis}'] = validate_int(
            entry.get(axis),
            default=MIN_AXIS_VALUE,
            min_val=MIN_AXIS_VALUE,
            max_val=MAX_AXIS_VALUE,
        )

    notes = entry.get('notes')
    if notes is not None:
        # A non-string, and anything past MAX_BALLOT_NOTE_LEN, was refused up
        # front — so this is a string within the bound and is written as sent.
        # Never coerced and never shortened: writing `''` for a value that
        # expressed no note, or dropping the tail of one that ran long, both
        # destroyed text the reviewer had saved and reported success for the loss.
        assignments.append('#notes = :notes')
        names['#notes'] = 'notes'
        values[':notes'] = notes

    return {
        'Key': {'pk': PRIORITIZATION_PK, 'sk': _ballot_sk(row_id, subject)},
        'UpdateExpression': 'SET ' + ', '.join(assignments),
        'ExpressionAttributeNames': names,
        'ExpressionAttributeValues': values,
    }


def _writes_a_reviewer_value(update_kwargs: dict) -> bool:
    """Whether one ballot save stores anything the reviewer actually entered.

    Read off the WRITE rather than re-derived from the entry, deliberately.
    `updated_count` is a claim about what was written, so asking the update itself
    what it assigns cannot drift from what `_ballot_update_kwargs` decided to
    assign — where a second predicate over the entry would have to keep two
    readings of "carries a value" in step by hand, which is the drift
    `_readable_axis` was introduced to end elsewhere in this module.

    Everything past BALLOT_STAMP_FIELDS is a reviewer's own value: the four axes
    and the note. So an entry that changed nothing — `{}`, an all-null entry, or
    one whose only keys are unrecognised — stamps the ballot and answers 200, but
    does not count as a ballot written. Note this reads CHANGED, not SCORED: a
    reviewer deliberately clearing their note (`{'notes': ''}`) wrote a real
    change, and is counted, while `_is_a_vote` would call it silence. The two
    questions are different and each is asked where it belongs — this one of the
    counter, `_is_a_vote` of the legacy migration and the aggregate.
    """
    assigned = set(update_kwargs['ExpressionAttributeNames'].values())
    return bool(assigned - set(BALLOT_STAMP_FIELDS))


def _ballot_transact_items(table, update_kwargs: dict, row_id: str, now: str) -> list[dict]:
    """One reviewer's ballot and its row's freeze mark, as ONE transaction.

    TWO WRITES THAT MUST NOT BE SEPARABLE, for two reasons that arrive from opposite
    directions:

    * THE ROW MUST STILL EXIST (#342, and the criterion that issue keeps open). The
      route already reads every named row before the first write, but a keyed read
      followed by a write is complete only while nothing can delete a row. Deletion
      now exists, so the read and the write race: the row's `attribute_exists(sk)`
      moves onto the WRITE, in the same transaction as the ballot, and a delete
      landing between the two cancels the ballot instead of orphaning it.
    * THE BALLOT MUST FREEZE THE COMPOSITION. ROW_FROZEN_AT_FIELD is what a
      composition change asserts the absence of, so it has to be written at the
      instant the ballot lands — not afterwards, where a recompose could slip in
      between and leave a row whose documents nobody balloting on it ever saw.

    FREEZING FOLLOWS `_writes_a_reviewer_value`, NOT `_is_a_vote`. A ballot carrying
    only a note freezes exactly as a scored one does: the note is a durable decision
    record about the set of documents the row held when it was written, and
    recomposing the row afterwards would leave that record describing documents its
    author never saw. The module already distinguishes the two questions — "expressed
    a score" gates the legacy migration and the aggregate, "changed something" counts
    a ballot written — and this is the second reading. #339 records it as a
    deliberately stricter predicate than the vote-supersession helper, and says not
    to reuse that helper here.

    A stamp-only save — `{}`, an all-null entry — writes no reviewer value and so
    freezes nothing. It still takes this path, though, and that is not an oversight:
    the row's `attribute_exists(sk)` still has to hold, because such a save does
    write a ballot record and an orphan is an orphan whether or not a reviewer
    expressed anything in it.

    `ADD` on ROW_BALLOT_WRITES_FIELD rather than `if_not_exists(...) + 1`, so two
    concurrent ballots each move it and neither reads it first. It is what the delete
    fences on.
    """
    row_update: dict[str, Any] = {
        'TableName': table.name,
        'Key': {'pk': PRIORITIZATION_PK, 'sk': _row_sk(row_id)},
        # `attribute_exists(sk)` is on the ROW's write rather than the ballot's,
        # because `update_item` is an upsert: without it this would CREATE a bare row
        # record for a row somebody deleted, resurrecting a deleted proposal as a
        # side effect of scoring it — the outcome #342 rules out by name.
        'ConditionExpression': 'attribute_exists(sk)',
        'ExpressionAttributeNames': {'#ballot_writes': ROW_BALLOT_WRITES_FIELD},
        'ExpressionAttributeValues': {':one': 1},
    }
    assignments: list[str] = []
    if _writes_a_reviewer_value(update_kwargs):
        assignments.append('#frozen_at = if_not_exists(#frozen_at, :now)')
        row_update['ExpressionAttributeNames']['#frozen_at'] = ROW_FROZEN_AT_FIELD
        row_update['ExpressionAttributeValues'][':now'] = now
    row_update['UpdateExpression'] = (
        (('SET ' + ', '.join(assignments) + ' ') if assignments else '')
        + 'ADD #ballot_writes :one'
    )
    # SPREAD rather than rebuilt field by field, and checked rather than trusted. A
    # `TransactItems[].Update` accepts a narrower set of keys than `update_item` does,
    # so a resource-only one (`ReturnValues`, `ReturnConsumedCapacity`) reaching here
    # is rejected by DynamoDB for the whole transaction — a ballot save failing on
    # something the ballot itself is not about. Rebuilding the item here instead would
    # SILENTLY DROP such a key, which is worse: it would discard part of what
    # `_ballot_update_kwargs` decided to write while answering 200. So the mismatch is
    # asserted, which turns a future addition there into a failure that names the
    # cause. (`test_projects_prioritization_row_lifecycle_moto.py` executes the shape
    # against a real implementation; the suite's fake accepts any `dict`.)
    unsupported = set(update_kwargs) - TRANSACT_UPDATE_KEYS
    assert not unsupported, (
        f'_ballot_update_kwargs returned {sorted(unsupported)}, which a transaction '
        'Update does not accept'
    )
    items = [
        {'Update': {'TableName': table.name, **update_kwargs}},
        {'Update': row_update},
    ]
    # The row's write is the ONE this transaction carries a condition on, and the
    # save reads the cancellation reason at its index to tell a vanished row from
    # contention. Asserted rather than commented, so the two cannot drift.
    assert 'ConditionExpression' in items[BALLOT_TRANSACT_ROW_INDEX]['Update']
    return items


@app.put("/projects/prioritization")
@tracer.capture_method
def api_put_prioritization_scores():
    """Refuse the retired whole-map overwrite.

    The route it replaces took the caller's map and made it EVERY reviewer's
    scores. Under per-reviewer ballots there is no honest thing for that to mean,
    so it is gone — but this stub has to stay, because deleting the route outright
    does not make the path unreachable. Powertools sorts routes into static and
    dynamic buckets at registration time and `_resolve` walks static before
    dynamic regardless of registration order, so with no literal route here
    `PUT /projects/prioritization` falls through to `PUT /projects/<project_id>`
    and reaches `update_project('prioritization', body)` — whose `update_item` is
    an upsert. That answers 200 while discarding the scores and leaving a phantom
    `PROJECT#prioritization` item behind, which is strictly worse than a refusal:
    it reports success for data it silently dropped.

    Answers 405 rather than 400, with the `Allow` header a 405 is required to carry.
    The distinction is not pedantry here: 400 says "your request was malformed",
    which sends a client looking at its body, while the body was fine and the VERB is
    what no longer exists. 405 plus `Allow` says exactly that, and names the verbs
    that do work — which is the whole of what a caller stranded on the retired route
    needs. Returned as a `Response` rather than raised, because the shared
    error classes map to fixed statuses and inventing a shared `MethodNotAllowedError`
    for one stub would put a class in `shared/api.py` with a single caller. The body
    keeps the `{'success': False, 'error': ...}` shape every other error answers with.
    """
    return Response(
        status_code=405,
        content_type=content_types.APPLICATION_JSON,
        # OPTIONS is listed because it really is served on this path — twice over:
        # API Gateway answers preflight from `defaultCorsPreflightOptions`, and the
        # resolver answers it too when CORS is configured. A header that claims to
        # enumerate what works has to include it.
        headers={'Allow': 'GET, PATCH, OPTIONS'},
        body=json.dumps({
            'success': False,
            'error': 'PUT /projects/prioritization is no longer supported; '
                     "PATCH the caller's own scores instead",
        }),
    )


@app.patch("/projects/prioritization")
@tracer.capture_method
def api_patch_prioritization_scores():
    """Persist the caller's own ballot for each ROW in the request.

    Body shape is `{'scores': {row_id: {...}}}`; every entry is written as the
    CALLER'S ballot on that row.

    Each row is one `update_item` on the caller's own key — never a
    read-modify-write of a shared map — so concurrent reviewers cannot overwrite
    each other. Only the fields an entry carries are written, so a partial entry
    leaves the reviewer's other axes untouched. No `ttl` attribute is ever
    written: the aggregates table expires anything carrying one, and a ballot is a
    durable decision record.

    PARTIAL FAILURE, and why RETRYING IS SAFE. This is NOT all-or-nothing. Nothing
    malformed can half-apply — every key and every value is refused before the
    first write — but the rows are written sequentially, so a throttle or a
    timeout on row 3 of 10 leaves the first two durably persisted and answers
    a bare 500 that does not say so. Retrying the identical body is nonetheless
    safe: every write is an idempotent `update_item` on a deterministic key derived
    from the row id and the caller's own subject, so replaying converges on
    the same ballots rather than duplicating or compounding anything. A client that
    sees a 500 should re-send the whole body, not try to work out what landed.

    `updated_count` is returned only on success, where it is the number of BALLOTS
    WRITTEN — saves that stored a value the reviewer entered — which is at most the
    number of rows in the body and is fewer when an entry changed nothing.
    Counting keys received instead reported `updated_count: 3` for a body of three
    empty objects that stored no score, contradicting the very unit the
    duplicate-key refusal above is justified on ("ballots written, not keys
    received"). The count is read off the write itself (`_writes_a_reviewer_value`)
    rather than re-derived from the request, so it cannot drift from what was
    assigned.

    MAX_BALLOTS_PER_SAVE stays in the OTHER unit deliberately: it bounds keys
    received, because the cost it exists to bound is round trips, and an entry that
    expresses nothing still costs its `update_item`. So 100 empty entries do consume
    the whole budget — that is the budget doing its job, not the counter's unit
    leaking. One number describes work done for the caller, the other describes work
    done by the Lambda.

    On failure the count of rows written goes to the log and NOT to the
    response — deliberately, because a partial
    count invites exactly the reasoning the idempotence makes unnecessary (working
    out which rows to re-send) while being unreliable for it: the failing
    write may or may not have landed server-side, and the legacy migration for an
    already-counted row may still be outstanding. One number the client can
    act on ("retry the body") is better than a number it would have to interpret.
    """
    subject = _caller_reviewer_subject()
    body = _json_object_body()
    changed_scores = body.get('scores') or {}
    if not isinstance(changed_scores, dict):
        raise ValidationError('scores must be an object keyed by row id')
    if not changed_scores:
        return {'success': True, 'message': 'No changes to save'}
    if len(changed_scores) > MAX_BALLOTS_PER_SAVE:
        raise ValidationError(
            f'scores may carry at most {MAX_BALLOTS_PER_SAVE} rows per save'
        )

    # Validate every key AND value BEFORE the first write, so nothing malformed
    # can leave a multi-row save half-persisted.
    validated = [
        (_validated_ballot_row_id(row_id), _validated_ballot_entry(entry))
        for row_id, entry in changed_scores.items()
    ]
    # Two keys differing only in surrounding whitespace address the SAME ballot
    # once stripped, so writing both silently let one entry overwrite the other —
    # with the winner decided by object order rather than by anything the caller
    # said — and still reported `updated_count` as if two rows had been saved.
    # Refused rather than de-duplicated, for the same reason `_validated_ballot_entry`
    # refuses a non-dict: the request states two different scores for one row
    # and there is no way to know which was meant. Refusing also keeps
    # `updated_count` and MAX_BALLOTS_PER_SAVE counted in the unit they claim —
    # ballots written, not keys received.
    seen: set[str] = set()
    for row_id, _ in validated:
        if row_id in seen:
            raise ValidationError(
                'scores keys must be distinct row ids; two keys differing '
                'only in surrounding whitespace address the same ballot'
            )
        seen.add(row_id)

    table = get_aggregates_table()
    if not table:
        raise ConfigurationError('Aggregates table not configured')

    # EVERY named row must exist BEFORE the first write, joining the up-front
    # pass above: a body naming one vanished row among five persists NOTHING,
    # which keeps the promise that only a mid-save infrastructure failure can
    # half-persist. Checked here rather than left to the read's discard (#342):
    # the discard protects the READER, but the WRITER was answered 200
    # `updated_count: 1` for a vote that then appeared nowhere — silent loss
    # reported as success. A keyed read per row is the price, and it is paid
    # only by a save (the page issues one per click, not per render); the
    # fetched records are then what the legacy migration reads, so the same key
    # is never read twice in one save.
    #
    # NO LONGER THE WHOLE STORY, and the difference is the point. This read used to
    # be the only existence check, which was honest only while nothing could delete a
    # row; deletion now exists, so the SAME assertion also rides on the write, inside
    # the transaction `_ballot_transact_items` builds. A delete landing between this
    # read and that write cancels the ballot rather than orphaning it.
    #
    # The read is kept for two things the condition cannot do: it refuses a body
    # naming one vanished row among five BEFORE the first write, so such a body
    # persists nothing rather than persisting the rows before the phantom; and it
    # returns the row records the legacy migration reads, so the same key is never
    # read twice in one save.
    rows_by_id = _fetched_ballot_rows(table, [row_id for row_id, _ in validated])
    if any(row_id not in rows_by_id for row_id, _ in validated):
        raise NotFoundError(
            'scores name a row that does not exist; reload the page to get '
            'the current rows'
        )

    now = datetime.now(timezone.utc).isoformat()

    # Counted so a failure part way through a multi-row save is diagnosable.
    # Validation cannot half-persist a save, but a throttle or a timeout on
    # row 3 of 10 can, and a bare 500 says nothing about how far it got.
    # TWO counters, because the two questions are asked in different units and
    # only one of them is the caller's. `rows_written` is round trips issued,
    # which is what a partial-failure log has to report — how far the loop got.
    # `ballots` is saves that stored something the reviewer entered, which is what
    # `updated_count` claims to be.
    rows_written = 0
    ballots = 0
    # Read ONCE for the whole save, and lazily: a save that scores nothing never
    # touches it. See `_LegacyScores` for why the scope is the save.
    legacy = _LegacyScores(table)
    try:
        for row_id, entry in validated:
            update_kwargs = _ballot_update_kwargs(row_id, subject, entry, now)
            # ONE TRANSACTION per row, not one `update_item`: the ballot, the row's
            # continued existence and the freeze mark land together or not at all.
            # See `_ballot_transact_items` for why each of the three has to be in the
            # same write as the others.
            try:
                table.meta.client.transact_write_items(
                    TransactItems=_ballot_transact_items(table, update_kwargs, row_id, now)
                )
            except ClientError as e:
                if (
                    e.response.get('Error', {}).get('Code')
                    != 'TransactionCanceledException'
                    # ONLY a failed condition on the ROW's half means the row went
                    # away. A cancellation for any other reason — above all
                    # `TransactionConflict`, which two reviewers scoring one row at
                    # the same moment reach because both `ADD` to the same record —
                    # is re-raised into the 500 below, so the page releases it for a
                    # retry. Answering 404 there told a reviewer whose save merely
                    # lost a race to reload a row that is still there, and dropped
                    # their ballot on advice that could never work.
                    or not _cancelled_by_condition(e, BALLOT_TRANSACT_ROW_INDEX)
                ):
                    raise
                # The row's own condition failed, and the only thing it asserts is
                # that the row exists — so the row went away between the pass above
                # and this write, the delete-racing-a-ballot case (#342). 404, the
                # same answer the up-front pass gives, because it is the same fact
                # about the world; and nothing of this row's ballot was written,
                # because a transaction applies whole or not at all.
                raise NotFoundError(
                    'scores name a row that does not exist; reload the page to get '
                    'the current rows'
                ) from e
            rows_written += 1
            if _writes_a_reviewer_value(update_kwargs):
                ballots += 1
            # Same save: the pre-ballot value of every document this row holds goes
            # away — but ONLY when this ballot actually scored something, because
            # that value is a score and nothing else supersedes it. An entry that
            # expressed no axis would otherwise delete a value it did not replace.
            # The row record was already fetched by the existence pass above.
            if _is_a_vote(entry):
                legacy.drop_for_row(rows_by_id[row_id])
        return {'success': True, 'updated_count': ballots}
    except ApiError:
        raise
    except Exception as e:
        logger.exception(
            f"Failed to save prioritization ballot after {rows_written} of "
            f"{len(validated)} rows: {e}"
        )
        raise ServiceError('Failed to save prioritization scores') from e


# ============================================
# API Token Routes (MCP Access)
# ============================================

TOKEN_PREFIX = 'voc_'
TOKEN_BYTE_LENGTH = 32
# Ceiling for an OPTIONAL expires_in_days at mint time. A year, matching the
# repo's outermost `days` bound (validate_days max_val=365). Omitting the field
# still mints a non-expiring token — expiry is opt-in until the plan's Phase 1
# credential model revisits the default.
MAX_TOKEN_LIFETIME_DAYS = 365


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
            # None for rows minted before expiry existed — displayed as
            # "never expires", which is also how mcp_handler enforces it.
            'expires_at': item.get('expires_at'),
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

    # Optional expiry. Absent (or JSON null) = a non-expiring token, exactly
    # what every existing caller gets today. When PRESENT it is validated
    # strictly rather than clamped: this is a credential lifetime a human
    # chose, so `validate_int`'s fall-back-to-default contract is wrong here —
    # an unreadable value would silently mint a credential with a lifetime
    # nobody picked. Bools are excluded before int() because isinstance(True,
    # int) is True, and fractional values are refused rather than truncated.
    expires_in_days = body.get('expires_in_days')
    expires_at = None
    if expires_in_days is not None:
        if (
            isinstance(expires_in_days, bool)
            or not isinstance(expires_in_days, int)
            or not (1 <= expires_in_days <= MAX_TOKEN_LIFETIME_DAYS)
        ):
            raise ValidationError(
                f'expires_in_days must be an integer between 1 and {MAX_TOKEN_LIFETIME_DAYS}'
            )
        expires_at = (
            datetime.now(timezone.utc) + timedelta(days=expires_in_days)
        ).isoformat()

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

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'TOKEN#{token_id}',
        'token_id': token_id,
        'name': name,
        'scope': scope,
        'token_hash': hash_token(raw_token),
        'created_at': now,
        'project_id': project_id,
    }
    if expires_at is not None:
        # The attribute is simply absent on a non-expiring token — the same
        # shape as every pre-expiry row, so mcp_handler needs no special case.
        item['expires_at'] = expires_at
    table.put_item(Item=item)

    logger.info(f"Created API token {token_id} for project {project_id}")

    return {
        'success': True,
        'token': raw_token,
        'token_id': token_id,
        'name': name,
        'expires_at': expires_at,
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
    if len(document_id) > MAX_KEY_SEGMENT_ID_LEN:
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
