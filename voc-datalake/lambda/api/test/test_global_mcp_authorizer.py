"""The ``/mcp/global`` token authorizer is the endpoint's own credential check (5.35 prod e2e).

A dead token's 401 used to come from the handler, and API Gateway remaps a Lambda proxy
response's ``WWW-Authenticate`` to ``x-amzn-Remapped-WWW-Authenticate``: MCP clients never saw
the Bearer challenge. Now the authorizer (the same function, ``_authorize``) answers Deny for
every credential the handler would refuse, and the ACCESS_DENIED gateway response
(lib/stacks/api-mcp.ts) turns that Deny into a 401 with the challenge and the handler's
JSON-RPC body. These cases drive the authorizer with real minted tokens (moto + the fake
directory of ``global_mcp_world``).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from global_mcp_world import global_mcp_world

import mcp_global_handler

METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/v1/POST/mcp/global'
API_MCP_TS = Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'api-mcp.ts'


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


def _authorize(world, token: str) -> dict:
    event = {'type': 'TOKEN', 'authorizationToken': f'Bearer {token}', 'methodArn': METHOD_ARN}
    return mcp_global_handler.lambda_handler(event, world.context)


def _effect(answer: dict) -> str:
    statements = answer['policyDocument']['Statement']
    assert [s['Resource'] for s in statements] == [METHOD_ARN]
    return statements[0]['Effect']


def test_a_live_token_is_allowed_for_exactly_this_method_and_named(world):
    minted = world.mint('alice', scope='read')

    answer = _authorize(world, minted['token'])

    assert _effect(answer) == 'Allow'
    assert answer['context'] == {'token_id': minted['token_id']}


def test_a_revoked_token_is_denied_by_the_gateway(world):
    minted = world.mint('alice', scope='write')
    status, _ = world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
    assert status == 200

    assert _effect(_authorize(world, minted['token'])) == 'Deny'


def test_an_expired_token_is_denied_by_the_gateway(world):
    minted = world.mint('alice', scope='read', expires_in_days=1)
    world.expire(minted)

    assert _effect(_authorize(world, minted['token'])) == 'Deny'


def test_a_disabled_minter_or_a_tampered_secret_is_denied(world):
    minted = world.mint('alice', scope='read')
    forged = minted['token'][:-4] + ('0000' if not minted['token'].endswith('0000') else '1111')
    assert _effect(_authorize(world, forged)) == 'Deny'

    world.cognito.disable('alice')
    assert _effect(_authorize(world, minted['token'])) == 'Deny'


def test_an_unknown_token_of_the_right_shape_is_denied(world):
    assert _effect(_authorize(world, f"voc_tok_0123456789abcdef_{'0' * 64}")) == 'Deny'
    assert 'context' not in _authorize(world, 'voc_short')


def test_a_store_fault_is_not_a_deny(world):
    minted = world.mint('alice', scope='read')
    with patch.object(mcp_global_handler, 'get_projects_table', return_value=None), \
            pytest.raises(mcp_global_handler.AuthBackendUnavailable):
        _authorize(world, minted['token'])


def test_the_gateway_401_body_is_the_handlers_own_401_body():
    source = API_MCP_TS.read_text(encoding='utf-8')
    match = re.search(r"MCP_UNAUTHORIZED_BODY =\s*'([^']+)'", source)
    assert match, 'MCP_UNAUTHORIZED_BODY not found in lib/stacks/api-mcp.ts'
    gateway_body = json.loads(match.group(1))

    handler_body = json.loads(mcp_global_handler._response(401, mcp_global_handler._error(
        None, mcp_global_handler.MCP_UNAUTHORIZED, mcp_global_handler.MCP_UNAUTHORIZED_MESSAGE))['body'])
    assert gateway_body == handler_body
    challenge = re.search(r"MCP_BEARER_CHALLENGE = '([^']+)'", source)
    assert challenge, 'MCP_BEARER_CHALLENGE not found in lib/stacks/api-mcp.ts'
    assert challenge.group(1).startswith('Bearer realm="voc-mcp-global"')
