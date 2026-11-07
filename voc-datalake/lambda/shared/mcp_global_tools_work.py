"""The global MCP server's catalogue, Prioritization and feedback-board write tools (tenet 4; docs/mcp.md → Tools).

Each tool calls ONE existing route as the token's minter, like every tool in
``shared/mcp_global_tools.py`` (never admin, capped at editor); the route decides
every rule:

* ``get_feedback_catalogue``: ``GET /feedback/catalogue`` (what every stored field of
  a feedback item means); ``sources: true`` reads ``GET /sources/status`` instead
  (each source's schedule and circuit breaker; enable / disable / run are
  admin-only routes, so no tool reaches them).
* ``get_prioritization``: ``GET /projects/prioritization`` (rows the minter can view,
  the minter's own scores, the team aggregate, the scoring axes); with a project
  (or a pinned token) only that project's rows.
* ``score_prioritization``: ``PATCH /projects/prioritization`` for ONE row: the
  minter's own ballot (the route keys a delegated ballot on the minter, never on
  the token). It reaches rows of any project the minter can view, so a
  project-pinned token is refused (``workspace_wide``). The scoring axes
  (``PUT /projects/prioritization/config``) are admin-only: no tool.
* ``write_feature_request``: ``POST /feature-requests`` (a new request on a board the
  minter can see) or, with ``request_id``, ``POST /feature-requests/{id}/supports``
  (a +1). The board's audience, pause / archive state, fields and rate limit
  apply; the +1 is recorded as the credential's service address (one per token
  and request). Status changes are admin-only (``require_board_admin``): no tool.

No import tool: every CSV / JSON / paste / S3 import route is admin-only (the
manual-import and S3-import handlers' ``admins_only`` middleware), and an MCP
token is never admin.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, TypeGuard

from shared.mcp_global_kit import (
    BOOL_SCHEMA,
    DOMAIN_ENGAGEMENT,
    DOMAIN_INTEGRATIONS,
    DOMAIN_METRICS,
    DOMAIN_PROJECTS,
    ID_SCHEMA,
    PROJECT_ID_SCHEMA,
    GlobalTool,
    InvalidToolArgument,
    RouteRequest,
    bool_arg,
    id_arg,
    schema,
    stripped,
    text_arg,
)
from shared.request_body import optional_field

MAX_BOARD_REF_CHARS: Final = 64
MAX_REQUEST_TITLE_CHARS: Final = 160      # shared/feature_requests_store.MAX_TITLE
MAX_REQUEST_DESCRIPTION_CHARS: Final = 4000
MAX_BOARD_FIELDS: Final = 20
MAX_AXES: Final = 12
MIN_SCORE: Final = 1                      # the sliders run 1 … 5 (projects_handler UNSCORED_FLOOR)
MAX_SCORE: Final = 5
_PROJECT_KEYS: Final = ('rows', 'scores', 'aggregates')


def _catalogue(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    if bool_arg(args, 'sources'):
        return RouteRequest(DOMAIN_INTEGRATIONS, 'GET', '/sources/status')
    return RouteRequest(DOMAIN_METRICS, 'GET', '/feedback/catalogue')


def _prioritization(_args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    return RouteRequest(DOMAIN_PROJECTS, 'GET', '/projects/prioritization')


def _rows_of(payload: Mapping[str, Any], project: str) -> set[str]:
    rows = payload.get('rows')
    if not isinstance(rows, Mapping):
        return set()
    return {row_id for row_id, row in rows.items() if isinstance(row, Mapping) and row.get('project_id') == project}


def _project_rows(payload: object, args: Mapping[str, Any]) -> object:
    """The board read; with a project (the argument or the token's pin), only its rows, scores and aggregates."""
    if not isinstance(payload, Mapping):
        return payload
    project = args.get('project_id')
    if not isinstance(project, str) or not project:
        return stripped(payload, args)
    kept = _rows_of(payload, project)
    narrowed = {**payload}
    for key in _PROJECT_KEYS:
        value = payload.get(key)
        narrowed[key] = {k: v for k, v in value.items() if k in kept} if isinstance(value, Mapping) else {}
    return stripped(narrowed, args)


def _axis_scores(value: object) -> dict[str, int]:
    if not isinstance(value, Mapping) or not value or len(value) > MAX_AXES:
        raise InvalidToolArgument(f'scores must map 1 to {MAX_AXES} axis ids to an integer {MIN_SCORE}-{MAX_SCORE}')
    scores: dict[str, int] = {}
    for axis, score in value.items():
        if (not isinstance(axis, str) or not axis or len(axis) > MAX_BOARD_REF_CHARS or isinstance(score, bool)
                or not isinstance(score, int) or not MIN_SCORE <= score <= MAX_SCORE):
            raise InvalidToolArgument(f'scores must map axis ids (from get_prioritization) to {MIN_SCORE}-{MAX_SCORE}')
        scores[axis] = score
    return scores


def _score(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    row_id = id_arg(args, 'row_id')
    entry = _axis_scores(args.get('scores'))
    return RouteRequest(DOMAIN_PROJECTS, 'PATCH', '/projects/prioritization', body={'scores': {row_id: entry}})


def _board_fields(args: Mapping[str, Any]) -> dict[str, Any]:
    value = optional_field(args, 'fields', _is_board_fields, lambda: InvalidToolArgument(
        f'fields must be an object of at most {MAX_BOARD_FIELDS} board field values'))
    return {} if value is None else {'fields': dict(value)}


def _is_board_fields(value: object) -> TypeGuard[Mapping[str, Any]]:
    return isinstance(value, Mapping) and len(value) <= MAX_BOARD_FIELDS


def _feature_request(args: Mapping[str, Any], _project: str | None) -> RouteRequest:
    fields = _board_fields(args)
    if args.get('request_id') not in (None, ''):
        request_id = id_arg(args, 'request_id')
        if args.get('title') or args.get('description') or args.get('board'):
            raise InvalidToolArgument('a +1 (request_id) takes only fields; leave title, description and board out')
        return RouteRequest(DOMAIN_ENGAGEMENT, 'POST', f'/feature-requests/{request_id}/supports', body=fields)
    body: dict[str, Any] = {
        'title': text_arg(args, 'title', max_length=MAX_REQUEST_TITLE_CHARS, required=True),
        **fields,
    }
    description = text_arg(args, 'description', max_length=MAX_REQUEST_DESCRIPTION_CHARS)
    if description:
        body['description'] = description
    board = text_arg(args, 'board', max_length=MAX_BOARD_REF_CHARS)
    if board:
        body['board'] = board
    return RouteRequest(DOMAIN_ENGAGEMENT, 'POST', '/feature-requests', body=body)


WORK_TOOLS: Final[tuple[GlobalTool, ...]] = (
    GlobalTool(
        'get_feedback_catalogue', 'Get the feedback catalogue',
        'What each stored feedback field means (type, origin, personal data, values). `sources: true`: source status.',
        schema({'sources': BOOL_SCHEMA}), _catalogue, stripped),
    GlobalTool(
        'get_prioritization', 'Get prioritization',
        'Prioritization rows you can see, your and the team\'s scores, the axes; a project narrows the rows.',
        schema({'project_id': PROJECT_ID_SCHEMA}), _prioritization, _project_rows, project_scoped=True),
    GlobalTool(
        'score_prioritization', 'Score a prioritization row',
        'Your own scores on one row, {axis id: 1-5} (write token, not project-pinned).',
        schema({'row_id': ID_SCHEMA,
                'scores': {'type': 'object',
                           'additionalProperties': {'type': 'integer', 'minimum': MIN_SCORE, 'maximum': MAX_SCORE}}},
               ('row_id', 'scores')),
        _score, stripped, write=True, workspace_wide=True),
    GlobalTool(
        'write_feature_request', 'Post a board request',
        'Post a board request, or +1 one by `request_id` (write token); `fields`: the board\'s fields.',
        schema({'board': {'type': 'string', 'maxLength': MAX_BOARD_REF_CHARS},
                'title': {'type': 'string', 'maxLength': MAX_REQUEST_TITLE_CHARS},
                'description': {'type': 'string', 'maxLength': MAX_REQUEST_DESCRIPTION_CHARS},
                'request_id': ID_SCHEMA,
                'fields': {'type': 'object'}}),
        _feature_request, stripped, write=True, board_route=True),
)
