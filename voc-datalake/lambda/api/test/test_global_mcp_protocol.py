"""The global MCP endpoint's argument and failure handling over real stores (api/mcp_global_handler.py).

The happy and refused paths through real domain handlers are in
test_global_mcp_e2e.py, and the transport envelope (verbs, Origin, parse errors,
version negotiation, every credential refusal) byte for byte, against mocks, in
test_mcp_global_handler_mutation.py; this file drives the failure handling
through the real token store and audit log: what an unknown tool, a bad
argument or a broken domain call is answered with and audited as, that the tool
catalogue never lets caller text become a route path, and that a retired
per-project credential is refused.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from global_mcp_world import ALPHA, global_mcp_world, tool_payload

import mcp_global_handler as handler
from shared import mcp_global_tokens as gt
from shared.mcp_delegate import DelegationUnavailable


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


class TestToolCalls:
    def test_an_unknown_tool_is_invalid_params_and_audited_without_the_name(self, world):
        minted = world.mint('alice', scope='read')
        reply = world.client(minted).call('drop_tables')
        assert reply.body['error']['code'] == -32602
        assert world.audit('alice', minted['token_id'])[0]['tool'] == 'unknown'

    @pytest.mark.parametrize('bad_id', ['../agents', 'a/b', 'x' * 200, 7, ''])
    def test_a_path_unsafe_id_is_a_tool_error_with_no_domain_call(self, world, bad_id):
        client = world.client(world.mint('alice', scope='read'))
        before = len(world.lambdas.calls)
        is_error, _ = tool_payload(client.call('get_document', {'project_id': ALPHA, 'document_id': bad_id}))
        assert is_error
        assert len(world.lambdas.calls) == before

    def test_a_domain_fault_is_an_internal_error_and_audited_as_failed(self, world):
        minted = world.mint('alice', scope='read')
        with patch.object(handler, 'call_domain', side_effect=DelegationUnavailable('boom')):
            reply = world.client(minted).call('list_projects')
        assert reply.body['error']['code'] == -32603
        assert world.audit('alice', minted['token_id'])[0]['outcome'] == gt.OUTCOME_FAILED

    def test_a_missing_project_id_is_a_tool_error(self, world):
        client = world.client(world.mint('alice', scope='read'))
        is_error, message = tool_payload(client.call('get_project'))
        assert is_error
        assert 'project_id is required' in message

    def test_last_used_is_stamped(self, world):
        minted = world.mint('alice', scope='read')
        world.client(minted).request('tools/list')
        row = world.projects.get_item(Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(minted['token_id'])})['Item']
        assert row['last_used_at']


class TestPerTokenRateLimit:
    """The admission count is two real DynamoDB conditional writes (moto evaluates them)."""

    MINUTE = datetime.now(UTC).replace(second=0, microsecond=0)

    def _requests(self, client, at: datetime, count: int) -> list[int]:
        with patch.object(handler, '_now', return_value=at):
            return [client.request('tools/list').status for _ in range(count)]

    def test_the_request_past_the_budget_is_429_and_the_next_minute_is_open(self, world):
        client = world.client(world.mint('alice', scope='read'))
        limit = handler.RATE_LIMIT_PER_MINUTE

        assert self._requests(client, self.MINUTE + timedelta(seconds=5), limit) == [200] * limit
        assert self._requests(client, self.MINUTE + timedelta(seconds=50), 1) == [429]
        assert self._requests(client, self.MINUTE + timedelta(seconds=61), 1) == [200]

    def test_the_budget_is_per_token(self, world):
        busy = world.client(world.mint('alice', scope='read'))
        other = world.client(world.mint('alice', scope='read'))
        at = self.MINUTE + timedelta(seconds=5)

        self._requests(busy, at, handler.RATE_LIMIT_PER_MINUTE)

        assert self._requests(busy, at, 1) == [429]
        assert self._requests(other, at, 1) == [200]


class TestTokenModel:
    NOW = datetime(2026, 10, 1, tzinfo=UTC)

    def test_an_audit_row_carries_only_the_four_facts(self):
        item = gt.audit_item('tok_1', tool='x' * 100, project_id='../p', outcome='weird', now=self.NOW)
        assert len(item['tool']) == 64
        assert 'project_id' not in item
        assert item['outcome'] == gt.OUTCOME_FAILED
        assert set(gt.audit_view(item)) == {'tool', 'at', 'project_id', 'outcome'}


class TestRetiredPerProjectTokens:
    """3.00.00 retired the per-project MCP server. Its ``MCPTOKEN`` rows are still in the
    table and its credentials have the very same ``voc_tok_…`` shape, so the global server
    must refuse them by WHERE it looks (``MCPGTOKEN`` only), not by their format."""

    def test_a_stale_per_project_token_is_401(self, world):
        from shared.mcp_tokens import mint_token

        stale = mint_token()
        # The row the retired POST /projects/{id}/api-tokens wrote: valid hash, never expires.
        world.projects.put_item(Item={
            'pk': 'MCPTOKEN', 'sk': f'TOKEN#{stale.token_id}', 'token_id': stale.token_id,
            'name': 'legacy', 'secret_hash': stale.secret_hash, 'scopes': ['feedback:read'],
            'projects': [ALPHA], 'read_reach': 'workspace', 'created_by': world.subs['alice'],
            'created_at': '2026-01-01T00:00:00+00:00',
        })
        client = world.client(stale.raw)
        reply = client.request('tools/list')
        assert reply.status == 401
        assert reply.body is not None
        assert reply.body['error']['message'] == 'Unauthorized: invalid, expired or revoked token'
        assert world.projects.get_item(Key={'pk': 'MCPTOKEN', 'sk': f'TOKEN#{stale.token_id}'})['Item'].get(
            'last_used_at') is None

    def test_a_global_token_of_the_same_minter_still_works(self, world):
        assert world.client(world.mint('alice', scope='read')).request('tools/list').status == 200
