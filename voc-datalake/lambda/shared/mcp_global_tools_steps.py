"""The global MCP server's methodology, Radar and feedback-edit tools (tenet 4; docs/mcp.md → Tools).

Each tool calls ONE existing route as the token's minter, like every tool in
``shared/mcp_global_tools.py`` (never admin, capped at editor). Nothing here
decides a rule: the route does, so the methodology block, the way-of-working
check on PR/FAQ / PRD writing (``shared/ai_writing.py``: an MCP token is an
autonomous caller) and the project and category access answer exactly as they
do for the web app.

* ``generate`` starts one methodology step (personas, research, PR/FAQ, PRD,
  prototype) and answers the job id with the route's ``methodology`` block; MCP
  has no push, so ``get_job`` reads the job until it ends.
* ``read_radar`` reads other brands' reviews (docs/radar.md).
* ``edit_feedback`` corrects one review's category, or its dimensions and tags.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.api import MAX_PERSONAS_PER_GENERATION
from shared.dimension_config import MAX_TAG_CHARS, MAX_TAGS
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
    require_project,
    schema,
    stripped,
    text_arg,
)
from shared.methodology import STEPS

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


def _started(payload: object, args: Mapping[str, Any]) -> dict:
    """The start answer: the job and the route's methodology block (absent for personas)."""
    answer = payload if isinstance(payload, Mapping) else {}
    return {'step': args.get('step'), **{key: answer[key] for key in _START_FIELDS if key in answer}}


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

STEP_TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'generate', 'Start a methodology step',
        'Start personas, research, prfaq, prd or prototype in a project (write token); `brief` = the idea or '
        'question. Answers job_id and `methodology` (skipped steps); poll get_job.',
        schema({'project_id': PROJECT_ID_SCHEMA, 'step': {'type': 'string', 'enum': list(STEPS)},
                'title': {'type': 'string', 'maxLength': MAX_TITLE_CHARS},
                'brief': {'type': 'string', 'maxLength': MAX_BRIEF_CHARS},
                'count': {'type': 'integer', 'minimum': 1, 'maximum': MAX_PERSONAS_PER_GENERATION}}, ('step',)),
        _generate, _started, write=True, project_scoped=True),
    GlobalTool(
        'get_job', 'Get a job', "A project job's status and result (with its methodology block), by job_id.",
        schema({'project_id': PROJECT_ID_SCHEMA, 'job_id': ID_SCHEMA}, ('job_id',)),
        _get_job, _job, project_scoped=True),
    GlobalTool(
        'read_radar', 'Read Radar',
        "Other brands' reviews (not in our metrics): no `brand` = brands and totals, else its reviews.",
        schema({'brand': ID_SCHEMA, 'days': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RADAR_DAYS},
                'limit': {'type': 'integer', 'minimum': 1, 'maximum': MAX_RADAR_LIMIT}}),
        _read_radar, _radar),
    GlobalTool(
        'edit_feedback', 'Correct a feedback item',
        "Set one item's category (+ subcategory), or its dimensions / tags (write token).",
        schema({'feedback_id': ID_SCHEMA, 'category': _TEXT, 'subcategory': _TEXT,
                'dimensions': {'type': 'object', 'additionalProperties': {'type': ['string', 'null']}},
                'tags': {'type': 'array', 'maxItems': MAX_TAGS, 'items': {'type': 'string'}}}, ('feedback_id',)),
        _edit_feedback, stripped, write=True),
)
