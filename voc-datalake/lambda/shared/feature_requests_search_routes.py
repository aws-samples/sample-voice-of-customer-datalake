"""``GET /feature-requests/search`` (docs/feature-requests.md -> Search), behind the BOARD authorizer.

``?q=&board=&category=&status=&days=&limit=``: the requests of the boards the caller may use
(``shared.feature_boards_access``) that match, most-supported first, as slim evidence views
(``shared.feature_request_evidence``: never an email or a name). ``board``, ``category`` and
``status`` take one value or a comma list; a named board the caller may not use is a 404 like on
every board route. ``days`` is 0 to 3650 (0 = all time), ``limit`` 1 to 100 (default 25); anything else
is a 400. Included in ``engagement_handler.py`` BEFORE ``feature_requests_routes``, so ``search``
is never read as a request id.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.exceptions import ValidationError
from shared.feature_boards_access import BoardScope, scope_from_event
from shared.feature_request_evidence import load_feature_request_evidence
from shared.logging import tracer

app = Router()

DEFAULT_LIMIT: Final = 25
MAX_LIMIT: Final = 100
MAX_DAYS: Final = 3650
MAX_QUERY_CHARS: Final = 200
MAX_LIST_VALUES: Final = 20
MAX_VALUE_CHARS: Final = 128


def _int_param(params: Mapping[str, str], name: str, *, default: int, low: int, high: int) -> int:
    raw = params.get(name)
    if raw is None or raw == '':
        return default
    if not raw.isdigit() or not low <= int(raw) <= high:
        raise ValidationError(f'{name} must be a whole number from {low} to {high}')
    return int(raw)


def _list_param(params: Mapping[str, str], name: str) -> list[str] | None:
    """A comma list (None when absent or empty); 400 past 20 values or 128 characters a value."""
    values = [value.strip() for value in (params.get(name) or '').split(',') if value.strip()]
    if not values:
        return None
    if len(values) > MAX_LIST_VALUES or any(len(value) > MAX_VALUE_CHARS for value in values):
        raise ValidationError(f'{name} takes at most {MAX_LIST_VALUES} values of {MAX_VALUE_CHARS} characters')
    return values


def _query(params: Mapping[str, str]) -> str | None:
    query = (params.get('q') or '').strip()
    if len(query) > MAX_QUERY_CHARS:
        raise ValidationError(f'q must be at most {MAX_QUERY_CHARS} characters')
    return query or None


def _board_ids(scope: BoardScope, refs: list[str] | None) -> list[str] | None:
    """The named boards' ids (by id or slug; 404 when one is invisible), None = every visible board."""
    return None if refs is None else [str(scope.board(ref)['board_id']) for ref in refs]


@app.get('/feature-requests/search')
@tracer.capture_method
def search_requests() -> dict[str, Any]:
    params = app.current_event.query_string_parameters or {}
    limit = _int_param(params, 'limit', default=DEFAULT_LIMIT, low=1, high=MAX_LIMIT)
    days = _int_param(params, 'days', default=0, low=0, high=MAX_DAYS)  # 0 = all time
    query = _query(params)
    categories, statuses = _list_param(params, 'category'), _list_param(params, 'status')
    scope = scope_from_event(app.current_event.raw_event)
    board_ids = _board_ids(scope, _list_param(params, 'board'))
    visible = [str(board['board_id']) for board in scope.boards()]
    evidence = load_feature_request_evidence(
        board_ids=board_ids, days=days, categories=categories, statuses=statuses, query=query,
        limit=limit, visible_board_ids=visible,
    )
    return {'success': True, 'items': evidence.items, 'total': evidence.total, 'truncated': evidence.truncated}
