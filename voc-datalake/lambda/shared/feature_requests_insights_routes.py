"""Insights over the feedback boards' requests (docs/feature-requests.md -> Insights), BOARD authorizer.

``GET /feature-requests/insights?board=&days=`` counts the requests of one board (``board``: slug or
id) or, without ``board``, of every board the caller may use (``shared.feature_boards_access``: an
invisible board is 404, as on every board route). ``days`` 0-3650 (0 = all time) filters on the
request's ``created_at``. Supporters are the request's ``totals.supporters`` (distinct supporter
emails, recomputed on META after every +1). Category and sentiment come from the request's own
enrichment (``shared.feature_requests_enrich``); a request without one counts as ``uncategorized`` /
``unknown``. These numbers are never mixed into the review metrics.

Reads are bounded: at most ``MAX_REQUESTS_LISTED`` requests, newest first; ``truncated`` says the
bound was reached.

``POST /feature-requests/insights/enrich`` (app admins): queue enrichment for up to
``MAX_BACKFILL`` requests with no enrichment, a stale one (title / description changed) or a failed
one; answers ``{queued, remaining}``. Call it again once the queued jobs finished for the rest.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.dynamo_values import as_count
from shared.engagement_identity import require_board_admin
from shared.exceptions import ValidationError
from shared.feature_boards_access import BoardScope, scope_for, scope_from_event
from shared.feature_requests_enrich import ENRICHMENT_FIELD, STATUS_OK, queue, wants_backfill
from shared.feature_requests_store import MAX_REQUESTS_LISTED, board_id_of, list_requests, requests_of_board
from shared.logging import logger, tracer

app = Router()

MAX_DAYS: Final = 3650
MAX_TOP: Final = 20
MAX_BACKFILL: Final = 200
UNCATEGORIZED: Final = 'uncategorized'
UNKNOWN_SENTIMENT: Final = 'unknown'
DAYS_INVALID: Final = f'days must be a whole number from 0 to {MAX_DAYS}'


def parse_days(raw: object) -> int:
    """``days`` from the query string: 0 (all time) when absent, else 0-``MAX_DAYS``."""
    if raw is None or raw == '':
        return 0
    if not isinstance(raw, str) or not raw.isdigit() or int(raw) > MAX_DAYS:
        raise ValidationError(DAYS_INVALID)
    return int(raw)


def _cutoff(days: int) -> str | None:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat() if days else None


def supporters_of(request: Mapping[str, Any]) -> int:
    """The request's ``totals.supporters`` (a DynamoDB number reads as a Decimal), 0 when absent."""
    totals = request.get('totals')
    return as_count(totals.get('supporters')) if isinstance(totals, Mapping) else 0


def _ok_enrichment(request: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The request's enrichment when its model call succeeded, else None."""
    enrichment = request.get(ENRICHMENT_FIELD)
    return enrichment if isinstance(enrichment, Mapping) and enrichment.get('status') == STATUS_OK else None


def _enriched(request: Mapping[str, Any], key: str) -> str | None:
    """One value of the request's successful enrichment, or None."""
    enrichment = _ok_enrichment(request)
    value = enrichment.get(key) if enrichment is not None else None
    return value if isinstance(value, str) and value else None


def _group(requests: Iterable[Mapping[str, Any]], key: Callable[[Mapping[str, Any]], str], name: str,
           *, supporters: bool) -> list[dict[str, Any]]:
    """``[{name: value, requests, supporters?}]``, the largest group first."""
    groups: dict[str, dict[str, Any]] = {}
    for request in requests:
        value = key(request)
        group = groups.setdefault(value, {name: value, 'requests': 0, **({'supporters': 0} if supporters else {})})
        group['requests'] += 1
        if supporters:
            group['supporters'] += supporters_of(request)
    order = 'supporters' if supporters else 'requests'
    return sorted(groups.values(), key=lambda group: (-group[order], -group['requests'], str(group[name])))


def _top_row(request: Mapping[str, Any]) -> dict[str, Any]:
    return {'request_id': request.get('request_id'), 'board_id': board_id_of(request),
            'title': request.get('title') if isinstance(request.get('title'), str) else '',
            'status': request.get('status'), 'supporters': supporters_of(request),
            'category': _enriched(request, 'category')}


def _top(requests: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    newest_first = sorted(requests, key=lambda request: str(request.get('created_at', '')), reverse=True)
    ranked = sorted(newest_first, key=supporters_of, reverse=True)  # stable: ties stay newest first
    return [_top_row(request) for request in ranked[:MAX_TOP]]


def summarize(requests: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The C4 counts of ``requests`` (totals, top, by category / status / sentiment)."""
    return {
        'totals': {'requests': len(requests), 'supporters': sum(supporters_of(request) for request in requests),
                   'enriched': sum(1 for request in requests if _ok_enrichment(request) is not None)},
        'top': _top(requests),
        'by_category': _group(requests, lambda r: _enriched(r, 'category') or UNCATEGORIZED, 'category',
                              supporters=True),
        'by_status': _group(requests, lambda r: str(r.get('status') or ''), 'status', supporters=True),
        'by_sentiment': _group(requests, lambda r: _enriched(r, 'sentiment') or UNKNOWN_SENTIMENT, 'sentiment',
                               supporters=False),
    }


def _scoped_requests(scope: BoardScope, ref: str | None) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """``(the named board or None, its requests / every visible board's)``, newest first, bounded."""
    if ref:
        board = scope.board(ref)
        return board, requests_of_board(scope.table, str(board['board_id']))
    visible = {str(board['board_id']) for board in scope.boards()}
    return None, [request for request in list_requests(scope.table) if board_id_of(request) in visible]


@app.get('/feature-requests/insights')
@tracer.capture_method
def get_insights():
    params = app.current_event.query_string_parameters or {}
    days = parse_days(params.get('days'))
    scope = scope_from_event(app.current_event.raw_event)
    board, requests = _scoped_requests(scope, params.get('board') or None)
    truncated = len(requests) >= MAX_REQUESTS_LISTED
    cutoff = _cutoff(days)
    if cutoff is not None:
        requests = [request for request in requests if str(request.get('created_at', '')) >= cutoff]
    label = {'id': str(board['board_id']), 'label': str(board.get('name') or '')} if board else None
    return {'success': True, 'board': label, 'window_days': days, 'truncated': truncated, **summarize(requests)}


@app.post('/feature-requests/insights/enrich')
@tracer.capture_method
def post_backfill():
    """Admin: queue enrichment for the requests that have none (or a stale / failed one)."""
    viewer = require_board_admin(app.current_event.raw_event)
    scope = scope_for(viewer)
    waiting = [str(request['request_id']) for request in list_requests(scope.table)
               if isinstance(request.get('request_id'), str) and wants_backfill(request)]
    queued = queue(waiting[:MAX_BACKFILL])
    logger.info('Feature request enrichment backfill queued', extra={'queued': queued, 'waiting': len(waiting)})
    return {'success': True, 'queued': queued, 'remaining': len(waiting) - queued}
