"""Feedback board routes (docs/feature-requests.md -> API), behind the BOARD authorizer.

Every caller lists and reads the boards they may use (``shared.feature_boards_access``; an
invisible board is a 404). Only an app-pool admin creates, configures, archives and deletes a
board. Included by ``api/engagement_handler.py`` BEFORE ``feature_requests_routes`` so that
``/feature-requests/boards/...`` is never read as a request id.
"""
from __future__ import annotations

from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import engagement_config
from shared.engagement_common import created
from shared.engagement_identity import require_board_admin
from shared.exceptions import ConflictError
from shared.feature_board_fields import status_keys
from shared.feature_boards_access import BoardScope, scope_for, scope_from_event
from shared.feature_boards_delete import parse_with_requests, remove_board_and_requests
from shared.feature_boards_store import (
    board_view,
    create_board,
    update_board,
    validate_create,
    validate_update,
)
from shared.feature_requests_store import requests_of_board
from shared.logging import logger, tracer
from shared.request_body import json_object_body

app = Router()
STATUS_IN_USE: Final = 'status_in_use'


def _view(scope: BoardScope, board: dict[str, Any]) -> dict[str, Any]:
    return board_view(board, admin=scope.viewer.is_admin, frontend_url=engagement_config.frontend_url())


def _refuse_removing_used_statuses(table: Any, board: dict[str, Any], statuses: list[dict[str, str]]) -> None:
    """409 ``status_in_use`` when a status the new list drops is still some request's status."""
    removed = set(status_keys(board)) - {status['key'] for status in statuses}
    if removed and any(row.get('status') in removed for row in requests_of_board(table, str(board['board_id']))):
        raise ConflictError(STATUS_IN_USE)


@app.get('/feature-requests/boards')
@tracer.capture_method
def get_boards():
    scope = scope_from_event(app.current_event.raw_event)
    return {'boards': [_view(scope, board) for board in scope.boards()], 'viewer': scope.viewer.view()}


@app.post('/feature-requests/boards')
@tracer.capture_method
def post_board():
    """Admin: a board from a template (``slug`` from the name when absent); 409 ``slug_taken``."""
    viewer = require_board_admin(app.current_event.raw_event)
    values = validate_create(json_object_body(app))
    scope = scope_for(viewer)
    scope.boards()  # the seeded board first, so a fresh deployment never loses the old requests' home
    board = create_board(scope.table, engagement_config.participants_table(), values, viewer.subject)
    logger.info('Board created', extra={'board_id': board['board_id'], 'template': board['template']})
    return created({'board': _view(scope, board)})


@app.get('/feature-requests/boards/<board_ref>')
@tracer.capture_method
def get_board_route(board_ref: str):
    scope = scope_from_event(app.current_event.raw_event)
    return {'board': _view(scope, scope.board(board_ref))}


@app.put('/feature-requests/boards/<board_ref>')
@tracer.capture_method
def put_board(board_ref: str):
    """Admin: any of name, slug, description, fields, statuses, audience, archived."""
    viewer = require_board_admin(app.current_event.raw_event)
    scope = scope_for(viewer)
    board = scope.board(board_ref)
    changes = validate_update(json_object_body(app))
    if 'statuses' in changes:
        _refuse_removing_used_statuses(scope.table, board, changes['statuses'])
    updated = update_board(scope.table, engagement_config.participants_table(), board, changes)
    logger.info('Board updated', extra={'board_id': board['board_id'], 'changed': sorted(changes)})
    return {'board': _view(scope, updated)}


@app.delete('/feature-requests/boards/<board_ref>')
@tracer.capture_method
def remove_board(board_ref: str):
    """Admin: an empty board (409 ``board_not_empty``), or with ``?with_requests=true`` the board
    and its requests, resumably (``shared.feature_boards_delete``)."""
    viewer = require_board_admin(app.current_event.raw_event)
    with_requests = parse_with_requests(app.current_event.query_string_parameters)
    scope = scope_for(viewer)
    board = scope.board(board_ref)
    removal = remove_board_and_requests(scope.table, engagement_config.participants_table(), board,
                                        with_requests=with_requests)
    logger.info('Board deleted' if removal.done else 'Board emptying', extra={
        'board_id': board['board_id'], 'requests_deleted': removal.deleted, 'remaining': removal.remaining,
        'by': viewer.subject})
    return removal.view()
