"""Request routes of the feedback boards (docs/feature-requests.md -> API), behind the BOARD authorizer.

Every route first resolves the request's board and checks the caller may use it
(``shared.feature_boards_access``): a board they may not use is invisible, so its requests
answer 404. On a board they use, any caller lists, reads, files requests and adds (one per
request: a second answers 409 ``already_supported``), edits or removes their OWN supports; the reporter edits the request's title, description and fields.
Admins (app-pool ``admins`` only) also change a status (one of the board's), delete a request,
edit or remove any support, and promote a request into a project. Field values are checked
against the board's enabled fields (``shared.feature_board_fields``); ``anyone`` boards are
rate-limited (``shared.feature_boards_limits``). No ``board`` = the seeded board, so a client
from before boards keeps working.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import engagement_config
from shared.engagement_common import created, is_id, now_iso
from shared.engagement_identity import BoardViewer, require_board_admin, require_project_access
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.feature_board_fields import description_required, field_values, fields_of, statuses_of, validate_status
from shared.feature_boards_access import BoardScope, scope_for, scope_from_event
from shared.feature_boards_limits import charge_request, charge_support
from shared.feature_boards_store import board_view
from shared.feature_requests_promote import promote
from shared.feature_requests_store import (
    REQUEST_NOT_FOUND,
    REQUEST_PREFIX,
    SUPPORT_NOT_FOUND,
    SUPPORT_PREFIX,
    create_request,
    delete_request,
    delete_support,
    get_support,
    new_support,
    poster_name,
    put_support,
    recompute_totals,
    request_text,
    request_view,
    requests_of_board,
    require_request,
    support_view,
    supports_of,
    update_request,
)
from shared.logging import logger, tracer
from shared.participants_settings import load_settings
from shared.project_access import LEVEL_EDIT
from shared.request_body import json_object_body

app = Router()
BOARD_ARCHIVED: Final = 'board_archived'
ALREADY_SUPPORTED: Final = 'already_supported'


def _request_id(raw: str) -> str:
    if not is_id(raw, REQUEST_PREFIX):
        raise NotFoundError(REQUEST_NOT_FOUND)
    return raw


def _support_id(raw: str) -> str:
    if not is_id(raw, SUPPORT_PREFIX):
        raise NotFoundError(SUPPORT_NOT_FOUND)
    return raw


def _scoped(scope: BoardScope, request_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(request, board)``; 404 for an unknown request or one on a board the caller may not use."""
    request = require_request(scope.table, _request_id(request_id))
    return request, scope.board_of(request)


def _open(board: Mapping[str, Any]) -> None:
    """Nothing new is posted on an archived board (only an admin still sees it)."""
    if board.get('archived') is True:
        raise ConflictError(BOARD_ARCHIVED)


def _not_yet_supporting(table: Any, request_id: str, email: str) -> None:
    """One +1 per person per request (the reporter's own included): a second one is refused, so
    the person edits theirs instead (it would count twice as a support, once as a supporter)."""
    if any(str(row.get('email') or '').lower() == email.lower() for row in supports_of(table, request_id)):
        raise ConflictError(ALREADY_SUPPORTED)


def _template(board: Mapping[str, Any]) -> str:
    return str(board.get('template', ''))


def _legacy_fields(supports: list[dict[str, Any]], board: Mapping[str, Any]) -> dict:
    """A request filed before boards keeps its customer, deal and impact on the reporter's support:
    show them as the request's fields."""
    reporter = next((row for row in supports if row.get('is_reporter') is True), {})
    enabled = [key for key, flags in fields_of(board)['request'].items() if flags['enabled']]
    return {key: reporter[key] for key in enabled if key in reporter}


def _detail(table: Any, request: dict[str, Any], board: Mapping[str, Any]) -> dict[str, Any]:
    supports = supports_of(table, str(request['request_id']))
    view = request_view(request, _template(board))
    if 'fields' not in request:
        view['fields'] = _legacy_fields(supports, board)
    return {'request': view, 'supports': [support_view(row) for row in supports]}


def _recomputed(scope: BoardScope, request_id: str, board: Mapping[str, Any]) -> dict[str, Any]:
    """The request's view after its totals are recomputed (the board template's keys)."""
    return request_view(recompute_totals(scope.table, request_id, _template(board)), _template(board))


def _may_change(viewer: BoardViewer, owner_email: object) -> bool:
    return viewer.is_admin or owner_email == viewer.email


def _own_or_admin(viewer: BoardViewer, owner_email: object) -> None:
    """An ownership check (an admin may change anything), not an admin gate."""
    if not _may_change(viewer, owner_email):
        raise AuthorizationError('You can only change your own entry')


def _reporter_support(board: Mapping[str, Any], body: Mapping[str, Any], values: Mapping[str, Any]) -> dict:
    """The reporter's own +1: before boards its values sat at the top of the body (read them so,
    with the support rules); with ``fields`` it carries the request values the board's +1s ask for."""
    if 'fields' not in body:
        return field_values(board, 'support', body)
    enabled = {key for key, flags in fields_of(board)['support'].items() if flags['enabled']}
    return {key: value for key, value in values.items() if key in enabled}


@app.get('/feature-requests')
@tracer.capture_method
def get_requests():
    """``?board=`` (slug or id; omitted = the seeded board): its requests, newest first."""
    scope = scope_from_event(app.current_event.raw_event)
    board = scope.board((app.current_event.query_string_parameters or {}).get('board'))
    template = _template(board)
    requests = [request_view(item, template) for item in requests_of_board(scope.table, str(board['board_id']))]
    return {'requests': requests, 'viewer': scope.viewer.view(),
            'board': board_view(board, admin=scope.viewer.is_admin, frontend_url=engagement_config.frontend_url())}


@app.post('/feature-requests')
@tracer.capture_method
def post_request():
    scope = scope_from_event(app.current_event.raw_event)
    viewer = scope.viewer
    body = json_object_body(app)
    board = scope.board(body.get('board'))
    _open(board)
    text = request_text(body, partial=False, description_required=description_required(board))
    values = field_values(board, 'request', body)
    name = poster_name(body) or viewer.name
    support = {**_reporter_support(board, body, values), 'name': name}
    charge_request(scope.table, board, viewer)
    status = statuses_of(board)[0]['key']
    meta, sup = create_request(scope.table, board, {**text, 'status': status, 'fields': values}, support,
                               (viewer.email, name))
    logger.info('Feature request created', extra={'request_id': meta['request_id'], 'board_id': board['board_id'],
                                                   'pool': viewer.pool})
    return created({'request': request_view(meta, _template(board)), 'supports': [support_view(sup)]})


@app.get('/feature-requests/<request_id>')
@tracer.capture_method
def get_request(request_id: str):
    scope = scope_from_event(app.current_event.raw_event)
    request, board = _scoped(scope, request_id)
    return _detail(scope.table, request, board)


@app.put('/feature-requests/<request_id>')
@tracer.capture_method
def put_request(request_id: str):
    """The reporter or an admin: title, description and (all of) the board's request fields."""
    scope = scope_from_event(app.current_event.raw_event)
    request, board = _scoped(scope, request_id)
    _own_or_admin(scope.viewer, request.get('reporter_email'))
    body = json_object_body(app)
    changes = request_text(body, partial=True, description_required=description_required(board))
    if 'fields' in body:
        changes['fields'] = field_values(board, 'request', body)
    if not changes:
        raise ValidationError('Nothing to update: send title, description or fields')
    updated = update_request(scope.table, request_id, changes)
    if 'fields' in changes:
        return {'request': _recomputed(scope, request_id, board)}
    return {'request': request_view(updated, _template(board))}


@app.put('/feature-requests/<request_id>/status')
@tracer.capture_method
def put_status(request_id: str):
    """Admin: move the request to one of its board's statuses."""
    viewer = require_board_admin(app.current_event.raw_event)
    scope = scope_for(viewer)
    _, board = _scoped(scope, request_id)
    status = validate_status(board, json_object_body(app).get('status'))
    return {'request': request_view(update_request(scope.table, request_id, {'status': status}), _template(board))}


@app.delete('/feature-requests/<request_id>')
@tracer.capture_method
def remove_request(request_id: str):
    """Admin: the request and every support."""
    viewer = require_board_admin(app.current_event.raw_event)
    scope = scope_for(viewer)
    request, _ = _scoped(scope, request_id)
    delete_request(scope.table, request)
    logger.info('Feature request deleted', extra={'request_id': request_id})
    return {'success': True}


@app.post('/feature-requests/<request_id>/supports')
@tracer.capture_method
def post_support(request_id: str):
    """Any user of the board who does not support the request yet: a +1 with the board's support fields."""
    scope = scope_from_event(app.current_event.raw_event)
    _, board = _scoped(scope, request_id)
    _open(board)
    _not_yet_supporting(scope.table, request_id, scope.viewer.email)
    body = json_object_body(app)
    fields = {**field_values(board, 'support', body), 'name': poster_name(body) or scope.viewer.name}
    charge_support(scope.table, board, scope.viewer)
    support = new_support(request_id, fields, scope.viewer.email, is_reporter=False)
    put_support(scope.table, support)
    return created({'support': support_view(support), 'request': _recomputed(scope, request_id, board)})


@app.put('/feature-requests/<request_id>/supports/<support_id>')
@tracer.capture_method
def put_support_route(request_id: str, support_id: str):
    """The support's owner or an admin; every field is replaced (the email and reporter flag stay)."""
    scope = scope_from_event(app.current_event.raw_event)
    _, board = _scoped(scope, request_id)
    current = get_support(scope.table, request_id, _support_id(support_id))
    _own_or_admin(scope.viewer, current.get('email'))
    body = json_object_body(app)
    fields = {**field_values(board, 'support', body), 'name': poster_name(body) or str(current.get('name') or '')}
    keep = {key: current[key] for key in ('pk', 'sk', 'support_id', 'request_id', 'email', 'is_reporter',
                                          'created_at') if key in current}
    put_support(scope.table, {**keep, **fields, 'updated_at': now_iso()}, replacing=True)
    return {'request': _recomputed(scope, request_id, board)}


@app.delete('/feature-requests/<request_id>/supports/<support_id>')
@tracer.capture_method
def delete_support_route(request_id: str, support_id: str):
    scope = scope_from_event(app.current_event.raw_event)
    _, board = _scoped(scope, request_id)
    current = get_support(scope.table, request_id, _support_id(support_id))
    _own_or_admin(scope.viewer, current.get('email'))
    delete_support(scope.table, request_id, support_id)
    return {'request': _recomputed(scope, request_id, board)}


@app.post('/feature-requests/<request_id>/promote')
@tracer.capture_method
def promote_request(request_id: str):
    """Admin with edit on the project: the supporters become participants of the project."""
    viewer = require_board_admin(app.current_event.raw_event)
    body = json_object_body(app)
    project_id = require_project_access(app.current_event.raw_event, body.get('project_id'), LEVEL_EDIT)
    scope = scope_for(viewer)
    request, board = _scoped(scope, request_id)
    participants = engagement_config.participants_table()
    settings = load_settings(participants, engagement_config.brand_name())
    answer = promote(scope.table, participants, request, board, project_id, settings, viewer.subject)
    return {**answer, 'request': request_view(answer['request'], _template(board))}
