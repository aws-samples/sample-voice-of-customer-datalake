"""A feature request or +1 made over /mcp/global is the PERSON's (docs/mcp.md → Tools): the board routes record
the minter's verified email and name, so the request is theirs and one person supports a request once however
many tokens they hold. End to end: the MCP handler builds the delegated call and claims, build_proxy_event turns
them into the engagement function's event, and the real feature-request routes answer it, on moto tables."""
from __future__ import annotations

import json
from typing import Any

import pytest
from engagement_fixtures import APP_POOL, engagement_world

import mcp_global_handler as mcp
from shared import feature_boards_routes, feature_requests_routes
from shared.api import create_api_resolver
from shared.mcp_delegate import DomainCall, DomainResult, build_proxy_event
from shared.mcp_global_tools import TOOLS_BY_NAME, MinterIdentity
from shared.participants_settings import SETTINGS_KEY

WRITE = TOOLS_BY_NAME['write_feature_request']
ALICE = MinterIdentity(email='alice@acme.example', name='Alice Example')
TOKEN_A = {'token_id': 'gmt_tokA', 'scope': 'write', 'created_by': 'alice-sub', 'created_by_username': 'alice'}
TOKEN_B = {**TOKEN_A, 'token_id': 'gmt_tokB'}
# The seeded board is the sales template: a request and a +1 both name the customer and the impact.
SALES_FIELDS = {'customer': 'Example Air', 'impact': 'none'}
NEW_REQUEST = {'title': 'Seat maps on the Example Air app', 'description': 'The seat map never loads on mobile.',
               'fields': SALES_FIELDS}

resolver = create_api_resolver()
resolver.include_router(feature_boards_routes.app)
resolver.include_router(feature_requests_routes.app)


@pytest.fixture
def world():
    with engagement_world() as w:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w


def _write(ctx: Any, row: dict, arguments: dict, minter: MinterIdentity | None = ALICE) -> tuple[str, str]:
    """The tool's outcome and its answer text (JSON on success, the route's refusal otherwise)."""
    def call_domain(call: DomainCall, *, claims: dict, workspace: str | None = None) -> DomainResult:
        response = resolver.resolve(build_proxy_event(call, claims, workspace), ctx)
        return DomainResult(response['statusCode'], json.loads(response['body']))

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(mcp, 'call_domain', call_domain)
        mp.setattr(mcp, '_minter_identity', lambda _row: minter)
        mp.setenv('USER_POOL_ID', APP_POOL)
        content, outcome = mcp._run_tool(mcp.ToolCall(WRITE, arguments, None), row)
    return outcome, content['content'][0]['text']


def _stored_request(world: Any) -> dict:
    items = world.requests.scan()['Items']
    (request,) = [item for item in items if str(item['pk']).startswith('FR#') and item['sk'] == 'META']
    return request


def test_a_request_posted_over_mcp_is_recorded_under_the_person(world, lambda_context):
    outcome, _ = _write(lambda_context, TOKEN_A, NEW_REQUEST)
    assert outcome == 'ok'
    request = _stored_request(world)
    assert (request['reporter_email'], request['reporter_name']) == ('alice@acme.example', 'Alice Example')
    assert 'mcp.invalid' not in json.dumps(request, default=str)


def test_the_same_person_cannot_support_twice_with_a_second_token(world, lambda_context):
    _write(lambda_context, TOKEN_A, NEW_REQUEST)
    request_id = _stored_request(world)['request_id']
    # The reporter's own +1 is already there: a second token of the same person is the same supporter.
    outcome, answer = _write(lambda_context, TOKEN_B, {'request_id': request_id, 'fields': SALES_FIELDS})
    assert outcome != 'ok'
    assert 'already' in answer.lower()


def test_without_a_verified_minter_the_board_route_refuses(world, lambda_context):
    outcome, _ = _write(lambda_context, TOKEN_A, NEW_REQUEST, minter=None)
    assert outcome != 'ok'
    assert [item for item in world.requests.scan()['Items'] if str(item['pk']).startswith('FR#')] == []
