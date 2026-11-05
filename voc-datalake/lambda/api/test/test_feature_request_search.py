"""Board requests as evidence: the loader (shared/feature_request_evidence.py) and
``GET /feature-requests/search`` (shared/feature_requests_search_routes.py), on moto tables."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from engagement_fixtures import ADMIN, APP_POOL, BOARD, BOARD_POOL, ISSUER, USER, engagement_world, event

import mcp_global_handler as mcp
from shared import feature_boards_routes, feature_requests_routes
from shared import feature_requests_search_routes as search_routes
from shared.api import create_api_resolver
from shared.exceptions import ConfigurationError
from shared.feature_request_evidence import MAX_DESCRIPTION_CHARS, load_feature_request_evidence
from shared.mcp_delegate import DomainCall, DomainResult, build_proxy_event
from shared.mcp_global_tools import TOOLS_BY_NAME
from shared.participants_settings import SETTINGS_KEY

OUTSIDER = {'sub': 'out-sub', 'email': 'eve@outsider.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}
OPEN_BOARD = 'brd_0000000a'
ANYONE_BOARD = 'brd_0000000b'
ARCHIVED_BOARD = 'brd_0000000c'
SEARCH = '/feature-requests/search'

# The integrator's order in engagement_handler.py: search before the request routes.
resolver = create_api_resolver()
resolver.include_router(search_routes.app)
resolver.include_router(feature_boards_routes.app)
resolver.include_router(feature_requests_routes.app)


def _ago(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat()


def _board(table: Any, board_id: str, *, audience: str = 'company', archived: bool = False) -> None:
    table.put_item(Item={'pk': f'BOARD#{board_id}', 'sk': 'META', 'board_id': board_id, 'name': board_id,
                         'slug': board_id.replace('_', '-'), 'template': 'beta', 'audience': {'mode': audience},
                         'archived': archived, 'gsi1pk': 'BOARDS', 'gsi1sk': board_id})


def _request(table: Any, n: int, board_id: str | None, *, days_ago: int = 1, supporters: int = 1,
             enrichment: dict | None = None, **fields: Any) -> str:
    request_id = f'fr_{n:016x}'
    created = _ago(days_ago)
    item = {'pk': f'FR#{request_id}', 'sk': 'META', 'request_id': request_id, 'title': f'Request {n}',
            'description': 'Seat maps do not load on the Example Air app', 'status': 'new',
            'reporter_email': 'sam@acme.example', 'reporter_name': 'Sam Seller',
            'fields': {'customer': 'Example Air'}, 'totals': {'supporters': supporters},
            'created_at': created, 'gsi1pk': 'FRS', 'gsi1sk': f'{created}#{request_id}', **fields}
    if board_id is not None:
        item['board_id'] = board_id
    if enrichment is not None:
        item['enrichment'] = enrichment
    table.put_item(Item=item)
    return request_id


@pytest.fixture
def world():
    with engagement_world() as w:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        _board(w.requests, OPEN_BOARD)
        _board(w.requests, ANYONE_BOARD, audience='anyone')
        _board(w.requests, ARCHIVED_BOARD, archived=True)
        yield w


def _search(ctx: Any, claims: dict = USER, **query: str) -> tuple[int, Any]:
    response = resolver.resolve(event('GET', SEARCH, claims=claims, query=query or None), ctx)
    return response['statusCode'], json.loads(response['body'])


def _ids(evidence_items: list[dict]) -> list[str]:
    return [item['request_id'] for item in evidence_items]


# ── Loader ────────────────────────────────────────────────────────────────────

def test_slim_items_never_carry_an_email_a_name_or_a_field_value(world):
    _request(world.requests, 1, OPEN_BOARD, description='x' * 3000,
             enrichment={'status': 'ok', 'category': 'Booking', 'sentiment': 'negative',
                         'problem_summary': 'Customers cannot pick seats', 'text_sha16': 'a' * 16})
    (item,) = load_feature_request_evidence().items
    assert set(item) == {'request_id', 'board_id', 'title', 'description', 'status', 'supporters', 'category',
                         'sentiment', 'problem_summary', 'created_at'}
    assert len(item['description']) == MAX_DESCRIPTION_CHARS
    assert (item['category'], item['sentiment'], item['supporters']) == ('Booking', 'negative', 1)
    assert 'sam@acme.example' not in json.dumps(item)
    assert 'Sam Seller' not in json.dumps(item)


def test_unenriched_requests_read_without_category_sentiment_or_summary(world):
    _request(world.requests, 1, OPEN_BOARD)
    (item,) = load_feature_request_evidence().items
    assert (item['category'], item['sentiment'], item['problem_summary']) == (None, None, None)


def test_archived_boards_are_excluded_and_board_ids_narrow(world):
    on_open = _request(world.requests, 1, OPEN_BOARD)
    on_anyone = _request(world.requests, 2, ANYONE_BOARD)
    _request(world.requests, 3, ARCHIVED_BOARD)
    assert sorted(_ids(load_feature_request_evidence().items)) == sorted([on_open, on_anyone])
    assert _ids(load_feature_request_evidence(board_ids=[OPEN_BOARD, ARCHIVED_BOARD]).items) == [on_open]
    assert _ids(load_feature_request_evidence(visible_board_ids=[ANYONE_BOARD]).items) == [on_anyone]
    assert load_feature_request_evidence(board_ids=[ARCHIVED_BOARD]).total == 0


def test_requests_without_a_board_are_the_seeded_boards(world):
    world.requests.put_item(Item={'pk': 'BOARD#brd_sales', 'sk': 'META', 'board_id': 'brd_sales', 'name': 'Sales',
                                  'gsi1pk': 'BOARDS', 'gsi1sk': 'sales'})
    legacy = _request(world.requests, 1, None)
    (item,) = load_feature_request_evidence(board_ids=['brd_sales']).items
    assert (item['request_id'], item['board_id']) == (legacy, 'brd_sales')


def test_days_filters_on_created_at_and_ranking_is_by_supporters(world):
    old = _request(world.requests, 1, OPEN_BOARD, days_ago=40, supporters=9)
    few = _request(world.requests, 2, OPEN_BOARD, days_ago=2, supporters=1)
    many = _request(world.requests, 3, OPEN_BOARD, days_ago=3, supporters=5)
    assert _ids(load_feature_request_evidence(days=30).items) == [many, few]
    assert _ids(load_feature_request_evidence(days=0).items) == [old, many, few]


def test_category_status_and_query_filters(world):
    booking = _request(world.requests, 1, OPEN_BOARD, status='planned',
                       enrichment={'status': 'ok', 'category': 'Booking', 'problem_summary': 'Refund delays'})
    plain = _request(world.requests, 2, OPEN_BOARD, title='Dark mode')
    assert _ids(load_feature_request_evidence(categories=['booking']).items) == [booking]
    assert _ids(load_feature_request_evidence(categories=['uncategorized']).items) == [plain]
    assert _ids(load_feature_request_evidence(statuses=['planned']).items) == [booking]
    assert _ids(load_feature_request_evidence(query='REFUND seat').items) == [booking]
    assert _ids(load_feature_request_evidence(query='dark MODE').items) == [plain]
    assert load_feature_request_evidence(categories=[], statuses=[]).total == 2


def test_limit_caps_items_and_reports_truncated(world):
    for n in range(1, 5):
        _request(world.requests, n, OPEN_BOARD, supporters=n)
    evidence = load_feature_request_evidence(limit=2)
    assert (len(evidence.items), evidence.total, evidence.truncated) == (2, 4, True)
    assert load_feature_request_evidence(limit=10).truncated is False


@pytest.mark.usefixtures('world')
def test_the_loader_needs_its_table(monkeypatch):
    monkeypatch.delenv('FEATURE_REQUESTS_TABLE')
    with pytest.raises(ConfigurationError):
        load_feature_request_evidence()


# ── Route ─────────────────────────────────────────────────────────────────────

def test_search_answers_the_slim_items_of_the_callers_boards(world, lambda_context):
    on_open = _request(world.requests, 1, OPEN_BOARD, supporters=3)
    on_anyone = _request(world.requests, 2, ANYONE_BOARD)
    _request(world.requests, 3, ARCHIVED_BOARD)
    status, body = _search(lambda_context, USER)
    assert status == 200
    assert (body['success'], body['total'], body['truncated']) == (True, 2, False)
    assert _ids(body['items']) == [on_open, on_anyone]
    # An outsider on the board pool sees only the board open to anyone.
    status, body = _search(lambda_context, OUTSIDER)
    assert (status, _ids(body['items'])) == (200, [on_anyone])
    # Admins see archived boards, but archived requests are never evidence.
    assert _search(lambda_context, ADMIN)[1]['total'] == 2


def test_search_filters_by_board_category_status_query_and_days(world, lambda_context):
    hit = _request(world.requests, 1, OPEN_BOARD, status='planned', days_ago=2,
                   enrichment={'status': 'ok', 'category': 'Booking'})
    _request(world.requests, 2, ANYONE_BOARD, status='planned', enrichment={'status': 'ok', 'category': 'Booking'})
    _request(world.requests, 3, OPEN_BOARD, days_ago=60)
    status, body = _search(lambda_context, BOARD, board=f'{OPEN_BOARD}', category='Booking,Other',
                           status='planned', q='seat', days='30', limit='5')
    assert (status, _ids(body['items'])) == (200, [hit])


@pytest.mark.usefixtures('world')
def test_search_404s_a_board_the_caller_may_not_use(lambda_context):
    assert _search(lambda_context, OUTSIDER, board=OPEN_BOARD)[0] == 404
    assert _search(lambda_context, USER, board=ARCHIVED_BOARD)[0] == 404


@pytest.mark.parametrize('query', [
    {'limit': '0'}, {'limit': '101'}, {'limit': 'ten'}, {'days': '-1'}, {'days': '3651'}, {'days': '1.5'},
    {'q': 'x' * 201}, {'status': ','.join(f's{n}' for n in range(21))}, {'category': 'c' * 129},
])
@pytest.mark.usefixtures('world')
def test_search_refuses_bad_parameters(lambda_context, query):
    assert _search(lambda_context, USER, **query)[0] == 400


@pytest.mark.usefixtures('world')
def test_search_is_not_read_as_a_request_id(lambda_context):
    status, body = _search(lambda_context, USER)
    assert status == 200
    assert body['items'] == []


# ── Over /mcp/global (docs/mcp.md → Tools) ───────────────────────────────────
# End to end: the MCP handler builds the delegated call and claims (board_route_claims), build_proxy_event
# turns them into the engagement function's event, and the real search route answers it.

MCP_SEARCH = TOOLS_BY_NAME['search_feature_requests']
MCP_ROW = {'token_id': 'gmt_tok1', 'scope': 'read', 'created_by': 'admin-sub', 'created_by_username': 'ada'}


def _mcp_search(ctx: Any, arguments: dict) -> tuple[str, str, list[dict]]:
    """The tool's outcome, its answer as text, and the claims of every delegated call."""
    seen: list[dict] = []

    def call_domain(call: DomainCall, *, claims: dict) -> DomainResult:
        seen.append(dict(claims))
        response = resolver.resolve(build_proxy_event(call, claims), ctx)
        return DomainResult(response['statusCode'], json.loads(response['body']))

    with patch.object(mcp, 'call_domain', call_domain), patch.dict('os.environ', {'USER_POOL_ID': APP_POOL}):
        content, outcome = mcp._run_tool(mcp.ToolCall(MCP_SEARCH, arguments, None), MCP_ROW)
    return outcome, json.dumps(content), seen


def test_an_mcp_search_sees_every_non_archived_board_never_an_archived_one(world, lambda_context):
    """The row names an admin minter: the delegated claims still carry no group, so no admin reach."""
    on_open = _request(world.requests, 1, OPEN_BOARD)
    on_anyone = _request(world.requests, 2, ANYONE_BOARD)
    archived = _request(world.requests, 3, ARCHIVED_BOARD)
    outcome, text, claims = _mcp_search(lambda_context, {})
    assert outcome == 'ok'
    assert (on_open in text, on_anyone in text, archived in text) == (True, True, False)
    assert (claims[0]['iss'], claims[0]['cognito:groups']) == (ISSUER + APP_POOL, '')
    # Naming the archived board is a tool error (the route's 404: invisible to the caller), never its requests.
    outcome, text, _ = _mcp_search(lambda_context, {'board': ARCHIVED_BOARD})
    assert outcome != 'ok'
    assert archived not in text
