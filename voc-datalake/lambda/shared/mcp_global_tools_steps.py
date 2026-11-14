"""The global MCP server's methodology, review, Radar and feedback-edit tools (tenet 4; docs/mcp.md → Tools).

Each tool calls ONE existing route as the token's minter, like every tool in
``shared/mcp_global_tools.py`` (never admin, capped at editor). Nothing here
decides a rule: the route does, so the methodology block, the way-of-working
check on PR/FAQ / PRD writing (``shared/ai_writing.py``: an MCP token is an
autonomous caller) and the project and category access answer exactly as they
do for the web app.

* ``projects_generate`` starts one methodology step (personas, research, PR/FAQ,
  PRD, prototype) and answers the job id with the route's ``methodology`` block;
  MCP has no push, so ``projects_get_job`` reads the job until it ends.
* ``documents_revise_from_comments`` starts "Revise from comments" on a PR/FAQ or
  PRD (an assist job, read with ``projects_get_job``), and
  ``documents_mark_comments_addressed`` marks or clears its threads
  (docs/document-review.md). Before 6.10.00 both were ``generate`` with
  ``step: revise``; ``legacy_revise`` maps such a call to them.
* ``documents_get_prototype_outline`` reads a prototype version's screens, headings and visible text
  (no code, no pins), so a client can name what to change.
* ``documents_draft_prototype_revision``, ``documents_get_prototype_draft``,
  ``documents_apply_prototype_draft`` and ``documents_discard_prototype_draft``: a
  prototype draft from an instruction, read, applied as the next version, or discarded
  (docs/prototype-builder.md, part 2). The draft's signed preview URL never leaves: a
  token holder reads the summary only.
* ``radar_read`` reads other brands' reviews (docs/radar.md).
* ``feedback_edit`` corrects one review's category, or its dimensions and tags.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.api import MAX_PERSONAS_PER_GENERATION
from shared.dimension_config import MAX_TAG_CHARS, MAX_TAGS
from shared.document_comments import MAX_ADDRESSED_THREADS
from shared.mcp_global_kit import (
    DOMAIN_FEEDBACK_EDIT,
    DOMAIN_PROJECTS,
    DOMAIN_RADAR,
    ID_SCHEMA,
    PROJECT_ID_SCHEMA,
    GlobalTool,
    InvalidToolArgument,
    RouteRequest,
    id_arg,
    int_arg,
    public,
    require_project,
    schema,
    stripped,
    text_arg,
)
from shared.methodology import STEPS
from shared.prototype_drafts import MAX_INSTRUCTION_CHARS
from shared.prototype_pins import MAX_BATCH_PINS

MAX_BRIEF_CHARS: Final = 4000
MAX_TITLE_CHARS: Final = 200
MAX_RADAR_DAYS: Final = 365
DEFAULT_RADAR_DAYS: Final = 90
MAX_RADAR_LIMIT: Final = 50
DEFAULT_RADAR_LIMIT: Final = 20
MAX_LABEL_CHARS: Final = 128
_JOB_FIELDS: Final = ('job_id', 'status', 'progress', 'current_step', 'job_type', 'created_at', 'updated_at',
                      'completed_at', 'error', 'result')
_START_FIELDS: Final = ('job_id', 'status', 'message', 'methodology')
_REVISE_FIELDS: Final = ('job_id', 'status', 'message')
TOOL_REVISE: Final = 'documents_revise_from_comments'
TOOL_MARK_ADDRESSED: Final = 'documents_mark_comments_addressed'
#: The step the old ``generate`` tool took for "Revise from comments" (accepted through 6.10.00).
LEGACY_REVISE_STEP: Final = 'revise'


def _step_request(step: str, project: str, title: str | None, brief: str | None,
                  args: Mapping[str, Any]) -> RouteRequest:
    """The route and body of one methodology step (each spelled out: the CDK spec checks every path is wired)."""
    if step == 'personas':
        count = int_arg(args, 'count', default=3, low=1, high=MAX_PERSONAS_PER_GENERATION)
        # Additive: a headless call never replaces the project's personas.
        body = {'persona_count': count, 'keep_existing_personas': True}
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project}/personas/generate', body=body)
    if step == 'research':
        body = {key: value for key, value in (('question', brief), ('title', title)) if value}
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project}/research', body=body)
    if step == 'prototype':
        return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project}/build-prototype',
                            body={'title': title} if title else {})
    body = {'doc_type': step, **({'title': title} if title else {}), **({'feature_idea': brief} if brief else {})}
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{project}/document', body=body)


def _generate(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    step = args.get('step')
    if step not in STEPS:
        raise InvalidToolArgument(f'step must be one of: {", ".join(STEPS)}')
    title = text_arg(args, 'title', max_length=MAX_TITLE_CHARS)
    brief = text_arg(args, 'brief', max_length=MAX_BRIEF_CHARS)
    return _step_request(str(step), require_project(project), title, brief, args)


def _passed_threads(args: Mapping[str, Any]) -> dict[str, Any]:
    """``thread_ids`` as given: the route checks them, and its 400 is the tool's error."""
    return {} if args.get('thread_ids') is None else {'thread_ids': args['thread_ids']}


def _revise(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    """Start a pass (POST …/revise-from-comments).

    The route decides the pass's outcome: an MCP token is an autonomous caller, so it gets
    recommendations unless its minter (and the project's owner) work AI-driven, when the server
    applies the revision as a new version and marks the threads itself.
    """
    d = id_arg(args, 'document_id')
    p = require_project(project)
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{p}/documents/{d}/revise-from-comments',
                        body=_passed_threads(args))


def _mark_addressed(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    """Mark (``addressed`` true, the default) or clear (false) the threads by the version ``document_id``
    names (POST …/comments/addressed); ``addressed`` goes to the route as given, like ``thread_ids``."""
    d = id_arg(args, 'document_id')
    p = require_project(project)
    body = {**_passed_threads(args), 'addressed': args.get('addressed', True)}
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{p}/documents/{d}/comments/addressed', body=body)


def legacy_revise(args: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The tool and arguments an old ``generate`` call with ``step: revise`` now is.

    Without ``mark_addressed``: a pass (``documents_revise_from_comments``); with it, the threads marked
    (true) or cleared (false) (``documents_mark_comments_addressed`` with ``addressed``).
    """
    kept = {key: value for key, value in args.items() if key not in ('step', 'mark_addressed')}
    if args.get('mark_addressed') is None:
        return TOOL_REVISE, kept
    return TOOL_MARK_ADDRESSED, {**kept, 'addressed': args['mark_addressed']}


def _started(payload: object, args: Mapping[str, Any]) -> object:
    """The start answer: the step, the job and the route's methodology block (absent for personas)."""
    answer = payload if isinstance(payload, Mapping) else {}
    return {'step': args.get('step'), **{key: answer[key] for key in _START_FIELDS if key in answer}}


def _revise_started(payload: object, _args: Mapping[str, Any]) -> dict:
    """The pass's job: read its result with ``projects_get_job``."""
    answer = payload if isinstance(payload, Mapping) else {}
    return {key: answer[key] for key in _REVISE_FIELDS if key in answer}


def _start_draft(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    """Start a draft (POST …/drafts): the route drafts on the newest version of ``document_id``'s series.

    Exactly one of ``instruction`` (words) and ``pin_ids`` (tester pins to incorporate, ids only: the route
    reads the pins, refuses another series' and withholds flagged ones); the ids reach the route as given.
    """
    if (args.get('instruction') is None) == (args.get('pin_ids') is None):
        raise InvalidToolArgument('give either instruction or pin_ids')
    if args.get('pin_ids') is not None:
        body: dict[str, Any] = {'pin_ids': args['pin_ids']}
    else:
        body = {'instruction': text_arg(args, 'instruction', max_length=MAX_INSTRUCTION_CHARS, required=True)}
    p = require_project(project)
    d = id_arg(args, 'document_id')
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{p}/prototypes/{d}/drafts', body=body)


def _get_outline(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    p = require_project(project)
    d = id_arg(args, 'document_id')
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{p}/prototypes/{d}/outline')


def _get_draft(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    p = require_project(project)
    d = id_arg(args, 'document_id')
    draft = id_arg(args, 'draft_id')
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{p}/prototypes/{d}/drafts/{draft}')


def _apply_draft(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    p = require_project(project)
    d = id_arg(args, 'document_id')
    draft = id_arg(args, 'draft_id')
    return RouteRequest(DOMAIN_PROJECTS, 'POST', f'/projects/{p}/prototypes/{d}/drafts/{draft}/apply', body={})


def _discard_draft(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    """Discard (DELETE …/drafts/{draft_id}): the draft's job deleted, and only a draft job of that prototype's series."""
    p = require_project(project)
    d = id_arg(args, 'document_id')
    draft = id_arg(args, 'draft_id')
    return RouteRequest(DOMAIN_PROJECTS, 'DELETE', f'/projects/{p}/prototypes/{d}/drafts/{draft}')


def _applied(payload: object, _args: Mapping[str, Any]) -> dict:
    """The new version, without its storage keys or its signed prototype URL, and a feedback draft's
    ``incorporation`` (the pins marked, replied to, not written)."""
    answer = payload if isinstance(payload, Mapping) else {}
    shaped = {'success': answer.get('success'), 'document': public(answer.get('document'))}
    if isinstance(answer.get('incorporation'), Mapping):
        shaped['incorporation'] = stripped(answer['incorporation'], {})
    return shaped


def _get_job(args: Mapping[str, Any], project: str | None) -> RouteRequest:
    job_id = id_arg(args, 'job_id')
    return RouteRequest(DOMAIN_PROJECTS, 'GET', f'/projects/{require_project(project)}/jobs/{job_id}')


def _job(payload: object, _args: Mapping[str, Any]) -> dict:
    """The job without who started it (a Cognito subject)."""
    answer = payload if isinstance(payload, Mapping) else {}
    return {key: answer[key] for key in _JOB_FIELDS if key in answer}


def _read_radar(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    if args.get('brand') in (None, ''):
        return RouteRequest(DOMAIN_RADAR, 'GET', '/radar')
    query = {'days': int_arg(args, 'days', default=DEFAULT_RADAR_DAYS, low=1, high=MAX_RADAR_DAYS),
             'limit': int_arg(args, 'limit', default=DEFAULT_RADAR_LIMIT, low=1, high=MAX_RADAR_LIMIT)}
    return RouteRequest(DOMAIN_RADAR, 'GET', f"/radar/brands/{id_arg(args, 'brand')}/reviews", query=query)


def _radar(payload: object, args: Mapping[str, Any]) -> object:
    """The overview without the scan settings, or a brand's reviews page."""
    if args.get('brand') in (None, '') and isinstance(payload, Mapping):
        return stripped({key: value for key, value in payload.items() if key != 'settings'}, args)
    return stripped(payload, args)


def _dimension_changes(args: Mapping[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    dimensions = args.get('dimensions')
    if dimensions is not None:
        if not isinstance(dimensions, Mapping) or not all(
                v is None or (isinstance(v, str) and len(v) <= MAX_LABEL_CHARS) for v in dimensions.values()):
            raise InvalidToolArgument('dimensions must map a dimension key to a value string or null')
        body['dimensions'] = dict(dimensions)
    tags = args.get('tags')
    if tags is not None:
        if not isinstance(tags, list) or len(tags) > MAX_TAGS or not all(
                isinstance(t, str) and len(t) <= MAX_TAG_CHARS for t in tags):
            raise InvalidToolArgument(f'tags must be at most {MAX_TAGS} strings of at most {MAX_TAG_CHARS} characters')
        body['tags'] = list(tags)
    return body


def _edit_feedback(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    feedback_id = id_arg(args, 'feedback_id')
    category = text_arg(args, 'category', max_length=MAX_LABEL_CHARS)
    changes = _dimension_changes(args)
    if bool(category) == bool(changes):
        raise InvalidToolArgument('give either category (with an optional subcategory) or dimensions / tags')
    if category:
        subcategory = text_arg(args, 'subcategory', max_length=MAX_LABEL_CHARS)
        body = {'category': category, **({'subcategory': subcategory} if subcategory else {})}
        return RouteRequest(DOMAIN_FEEDBACK_EDIT, 'PUT', f'/feedback/{feedback_id}/category', body=body)
    return RouteRequest(DOMAIN_FEEDBACK_EDIT, 'PUT', f'/feedback/{feedback_id}/dimensions', body=changes)


_TEXT = {'type': 'string', 'maxLength': MAX_LABEL_CHARS}
_THREAD_IDS = {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': MAX_ADDRESSED_THREADS}

STEP_TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'projects_generate', 'Start a methodology step',
        'Start one methodology step in a research project (write token): `step` personas (adds `count` personas, '
        'never replaces), research (`brief` = the research question), prfaq or prd (`brief` = the feature idea; '
        'drafts a PR/FAQ or PRD from customer feedback), prototype (from the newest PRD or PR/FAQ). Answers a '
        'job_id and a `methodology` block (skipped upstream steps, warnings: tell the user); follow the job with '
        'projects_get_job. A PR/FAQ or PRD is refused unless the user and the project owner work AI-driven; a '
        'prototype without a PRD or PR/FAQ is refused. Confirm with the user first.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'step': {'type': 'string', 'enum': list(STEPS)},
                'title': {'type': 'string', 'maxLength': MAX_TITLE_CHARS},
                'brief': {'type': 'string', 'maxLength': MAX_BRIEF_CHARS},
                'count': {'type': 'integer', 'minimum': 1, 'maximum': MAX_PERSONAS_PER_GENERATION}}, ('step',)),
        _generate, _started, write=True, project_scoped=True),
    GlobalTool(
        'projects_get_job', 'Get a project job',
        "Read a project job's status, progress and result by `job_id`: a methodology step started by "
        'projects_generate or a pass started by documents_revise_from_comments. Poll until `status` is completed '
        '(the result names the document and carries its methodology block, or the revision outcome) or failed.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'job_id': ID_SCHEMA}, ('job_id',)),
        _get_job, _job, project_scoped=True),
    GlobalTool(
        'documents_revise_from_comments', 'Revise from comments',
        'Start "Revise from comments" on a PR/FAQ or PRD (write token): the AI reads the answered review comment '
        'threads (resolved or replied to, not yet addressed) and the evidence, and suggests changes. '
        '`document_id`; optional `thread_ids` (up to 50) instead of every waiting thread. Answers a job_id: read '
        'the result with projects_get_job: `recommendations` (nothing written), or `applied` (a new version '
        'written and its threads marked addressed) when the user and the project owner work AI-driven.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA, 'thread_ids': _THREAD_IDS},
               ('document_id',)),
        _revise, _revise_started, write=True, project_scoped=True),
    GlobalTool(
        'documents_mark_comments_addressed', 'Mark comments addressed',
        'Mark review comment threads of a PR/FAQ or PRD as addressed by the version `document_id` names, after '
        'saving a version that answers them, or clear that mark with `addressed: false` (write token). '
        '`thread_ids`: 1 to 50 comment ids. Answers the threads.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA, 'thread_ids': _THREAD_IDS,
                'addressed': {'type': 'boolean', 'default': True}}, ('document_id', 'thread_ids')),
        _mark_addressed, stripped, write=True, project_scoped=True),
    GlobalTool(
        'documents_get_prototype_outline', 'Get a prototype outline',
        "Read a prototype version's outline: its screens (routes), headings and visible text, extracted from its "
        'HTML (no code, no tester pins; capped, `truncated` says so). Use it to name what to change before '
        'documents_draft_prototype_revision.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA}, ('document_id',)),
        _get_outline, stripped, project_scoped=True),
    GlobalTool(
        'documents_draft_prototype_revision', 'Draft a prototype revision',
        'Ask for a change to a prototype (write token): `document_id` (any version of it) and either '
        '`instruction` (words) or `pin_ids` (up to 50 tester pins from documents_list_prototype_feedback to '
        'incorporate). The AI drafts it on the newest version; nothing is saved. Answers a job_id: its result is '
        'the `draft_id` (projects_get_job); read it with documents_get_prototype_draft.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA,
                'instruction': {'type': 'string', 'maxLength': MAX_INSTRUCTION_CHARS},
                'pin_ids': {'type': 'array', 'items': ID_SCHEMA, 'minItems': 1, 'maxItems': MAX_BATCH_PINS}},
               ('document_id',)),
        _start_draft, _revise_started, write=True, project_scoped=True),
    GlobalTool(
        'documents_get_prototype_draft', 'Get a prototype draft',
        "Read a prototype draft: its instruction, the AI's summary of what changed and the version it was "
        'drafted on (`base_version`); a draft from pins (`kind` feedback) adds `outcomes` per pin (done / not_done '
        'and a note), `withheld` and `ignored` pin ids. No preview: the user sees it on the prototype page.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA, 'draft_id': ID_SCHEMA},
               ('document_id', 'draft_id')),
        _get_draft, stripped, project_scoped=True),
    GlobalTool(
        'documents_apply_prototype_draft', 'Apply a prototype draft',
        'Save a prototype draft as the next version (write token); earlier versions are kept, and applying it '
        'again gives the same version. A draft from pins also marks its done pins addressed and replies to the '
        'others (`incorporation`). Refused when a version was saved since the draft: ask again. Confirm with the '
        'user first.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA, 'draft_id': ID_SCHEMA},
               ('document_id', 'draft_id')),
        _apply_draft, _applied, write=True, project_scoped=True),
    GlobalTool(
        'documents_discard_prototype_draft', 'Discard a prototype draft',
        'Discard a prototype draft by `document_id` and `draft_id` (write token): it is gone for everyone. '
        'Saved versions are untouched.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'document_id': ID_SCHEMA, 'draft_id': ID_SCHEMA},
               ('document_id', 'draft_id')),
        _discard_draft, stripped, write=True, project_scoped=True),
    GlobalTool(
        'radar_read', 'Read Radar',
        "Read Radar: competitors' and other brands' public reviews, kept apart from your own customer feedback "
        '(never count, chart or cite them as your customers). No `brand`: the tracked brands and their review '
        'totals; a `brand` key: its reviews (`days` default 90, `limit` up to 50).',
        schema({'brand': ID_SCHEMA, 'days': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RADAR_DAYS},
                'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RADAR_LIMIT}}),
        _read_radar, _radar),
    GlobalTool(
        'feedback_edit', 'Correct a feedback item',
        "Correct one feedback item's classification by `feedback_id` (write token): set its `category` (+ "
        'optional `subcategory`, names from feedback_list_categories), or its `dimensions` (key to value, null '
        'clears) and `tags`; not both in one call. Confirm with the user first.',
        schema({'feedback_id': ID_SCHEMA, 'category': _TEXT, 'subcategory': _TEXT,
                'dimensions': {'type': 'object', 'additionalProperties': {'type': ['string', 'null']}},
                'tags': {'type': 'array', 'maxItems': MAX_TAGS, 'items': {'type': 'string'}}}, ('feedback_id',)),
        _edit_feedback, stripped, write=True),
)
