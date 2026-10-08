"""The Connect page's token API (api/mcp_tokens_handler.py) and the policy
change the global MCP endpoint needed in another domain:
``POST /agents/{id}/run`` accepts a delegated ``mcp:`` call only with the
admin-cleared run claim (``project_access.delegated_agent_run_allowed``).

The token API's refusal wording, DynamoDB call shapes, ordering and cursor
validation are pinned in ``test_mcp_tokens_handler_mutation.py``, and the
memory-recall rule for a credential (personal memories for the minter, never for
an ``agent:`` principal) in ``test_memory_handler_mutation.py``; what stays here
is the secret-handling contract the mutation suite does not restate.
"""
from __future__ import annotations

import pytest
from global_mcp_world import ALPHA, global_mcp_world
from moto_helpers import rest_event

import agents_handler
from shared import mcp_global_tokens as gt
from shared import project_access


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


class TestMint:
    def test_the_raw_credential_is_returned_once_and_only_its_hash_is_stored(self, world):
        minted = world.mint('alice', scope='write', project_id=ALPHA, expires_in_days=7)
        row = world.projects.get_item(Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(minted['token_id'])})['Item']

        assert minted['token'].startswith(f"voc_{minted['token_id']}_")
        assert minted['token'] not in str(row)
        assert row['secret_hash']
        assert row['created_by'] == world.subs['alice']
        assert row['minted_by_admin'] is False
        assert row['project_id'] == ALPHA
        assert minted['status'] == gt.STATUS_ACTIVE
        assert minted['can_run_agents'] is False

    def test_an_admin_write_token_can_run_agents(self, world):
        assert world.mint('root', scope='write')['can_run_agents'] is True


class TestRevoke:
    def test_a_revoked_token_stays_listed_as_revoked(self, world):
        minted = world.mint('alice', scope='read')
        world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        _, listed = world.tokens_api('alice', 'GET', '/connect/tokens')
        assert [t['status'] for t in listed['tokens']] == [gt.STATUS_REVOKED]


class TestDelegatedAgentRunClaim:
    def test_requires_an_mcp_subject_the_claim_and_a_person(self):
        allowed = {'sub': 'mcp:tok_1', project_access.MCP_AGENT_RUN_CLAIM: 'true',
                   project_access.ACTING_SUBJECT_CLAIM: 'human-sub'}
        assert project_access.delegated_agent_run_allowed(allowed)
        assert not project_access.delegated_agent_run_allowed({**allowed, 'sub': 'human-sub'})
        assert not project_access.delegated_agent_run_allowed({**allowed, project_access.MCP_AGENT_RUN_CLAIM: 'True'})
        assert not project_access.delegated_agent_run_allowed(
            {**allowed, project_access.ACTING_SUBJECT_CLAIM: 'agent:a1'})
        assert not project_access.delegated_agent_run_allowed({'sub': 'agent:a1', **{
            k: v for k, v in allowed.items() if k != 'sub'}})

    def test_the_agents_route_refuses_a_delegated_call_without_the_claim(self, world):
        claims = {'sub': 'mcp:tok_1', project_access.ACTING_SUBJECT_CLAIM: world.subs['root']}
        event = rest_event('POST', f'/agents/{world.agent_id}/run', claims=claims)
        assert agents_handler.lambda_handler(event, world.context)['statusCode'] == 403

