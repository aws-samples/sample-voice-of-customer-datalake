"""End to end: the global MCP endpoint driven exactly as an external MCP client drives it.

todofeatures §6.3 requires an end-to-end test. Each case below opens a real MCP
session against ``mcp_global_handler.lambda_handler`` — ``initialize`` →
``notifications/initialized`` → ``tools/list`` → ``tools/call`` — over the REST
proxy event API Gateway delivers, with tokens minted through the REAL token API
(``mcp_tokens_handler``) and every tool delegated to the REAL domain handlers
(projects, agents) against moto tables. The user directory (Cognito) is an
in-memory fake at the boto3 surface, and Step Functions is a mock; nothing else
between the JSON-RPC frame and the DynamoDB row is stubbed.

The cases the spec names:
  (a) a read-only token reads, and is refused a write;
  (b) a write token creates (and updates) a document;
  (c) a revoked or an expired token is refused — at the handshake too;
  (d) a project-scoped token is refused outside its project;
  (e) a non-admin token is refused ``run_agent`` (and an admin's works, until demoted).

Live testing with Cowork / Copilot / Amazon Quick / Kiro needs a deployment
(docs/mcp.md); this is the strongest check possible without one.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from global_mcp_world import ALPHA, ALPHA_DOC, BETA, GAMMA, global_mcp_world, tool_payload

from shared import mcp_global_tokens as gt

READ_TOOLS = {'search_feedback', 'get_feedback', 'get_metrics', 'list_categories', 'list_dimensions',
              'search_memory',
              'get_company_context', 'list_projects', 'get_project', 'get_document', 'list_agents',
              'get_agent_run'}
WRITE_TOOLS = {'create_document', 'update_document'}


@pytest.fixture
def world(lambda_context):
    with global_mcp_world(lambda_context) as built:
        yield built


def _connected(world, minted):
    client = world.client(minted)
    reply = client.connect()
    assert reply.status == 200, reply.body
    assert reply.body['result']['serverInfo']['name'] == 'voc-datalake-global'
    assert reply.body['result']['protocolVersion'] == '2025-06-18'
    return client


class TestReadOnlyToken:
    def test_sees_only_read_tools_and_reads_what_its_minter_can(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        assert set(client.tool_names()) == READ_TOOLS

        is_error, listed = tool_payload(client.call('list_projects'))
        # Alice owns alpha and can see the public gamma; bob's private beta is invisible.
        assert not is_error
        assert sorted(p['project_id'] for p in listed['projects']) == [ALPHA, GAMMA]

        is_error, document = tool_payload(client.call('get_document', {'project_id': ALPHA, 'document_id': ALPHA_DOC}))
        assert not is_error
        assert document['document']['content'] == 'Customers want faster refunds.'
        assert 'pk' not in document['document']
        assert 'sk' not in document['document']

    def test_a_project_the_minter_cannot_see_is_not_found(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, message = tool_payload(client.call('get_project', {'project_id': BETA}))

        assert is_error
        assert 'HTTP 404' in message

    def test_a_write_is_refused_before_any_domain_call(self, world):
        minted = world.mint('alice', scope='read')
        client = _connected(world, minted)
        calls_before = len(world.lambdas.calls)

        is_error, message = tool_payload(client.call('create_document', {
            'project_id': ALPHA, 'title': 'Nope', 'content': 'x'}))

        assert is_error
        assert 'read-only' in message
        assert len(world.lambdas.calls) == calls_before
        latest = world.audit('alice', minted['token_id'])[0]
        assert {k: latest[k] for k in ('tool', 'project_id', 'outcome')} == {
            'tool': 'create_document', 'project_id': ALPHA, 'outcome': gt.OUTCOME_DENIED}

    def test_the_delegated_call_acts_as_the_minter_never_as_admin(self, world):
        client = _connected(world, world.mint('root', scope='read'))
        client.call('list_projects')

        _, event = world.lambdas.calls[-1]
        claims = event['requestContext']['authorizer']['claims']
        assert claims['sub'].startswith('mcp:tok_')
        assert claims['voc:acting_subject'] == world.subs['root']
        assert claims['cognito:groups'] == ''
        assert 'voc:mcp_agent_run' not in claims
        assert 'Authorization' not in event['headers']


class TestWriteToken:
    def test_creates_then_updates_a_document_in_a_project_the_minter_owns(self, world):
        minted = world.mint('alice', scope='write')
        client = _connected(world, minted)
        assert set(client.tool_names()) >= WRITE_TOOLS
        assert 'run_agent' not in client.tool_names()

        is_error, created = tool_payload(client.call('create_document', {
            'project_id': ALPHA, 'title': 'Refund plan', 'content': '# Plan\nRefund in 3 days.'}))
        assert not is_error, created
        document_id = created['document']['document_id']

        stored = world.projects.get_item(Key={'pk': f'PROJECT#{ALPHA}', 'sk': f'DOC#{document_id}'})['Item']
        assert stored['title'] == 'Refund plan'
        assert stored['document_type'] == 'custom'

        is_error, _ = tool_payload(client.call('update_document', {
            'project_id': ALPHA, 'document_id': document_id, 'content': 'Refund in 2 days.'}))
        assert not is_error
        stored = world.projects.get_item(Key={'pk': f'PROJECT#{ALPHA}', 'sk': f'DOC#{document_id}'})['Item']
        assert stored['content'] == 'Refund in 2 days.'

        events = world.audit('alice', minted['token_id'])
        assert [(e['tool'], e['outcome'], e['project_id']) for e in events[:2]] == [
            ('update_document', 'ok', ALPHA), ('create_document', 'ok', ALPHA)]
        # Never the arguments or the content.
        assert all(set(e) == {'tool', 'at', 'project_id', 'outcome'} for e in events)

    def test_cannot_write_where_the_minter_may_not(self, world):
        client = _connected(world, world.mint('alice', scope='write'))

        is_error, message = tool_payload(client.call('create_document', {
            'project_id': BETA, 'title': 'Sneaky', 'content': 'x'}))

        assert is_error
        assert 'HTTP 404' in message
        assert world.projects.query(
            KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': f'PROJECT#{BETA}'},
        )['Count'] == 1


class TestDeadTokens:
    def test_a_revoked_token_is_refused_immediately(self, world):
        minted = world.mint('alice', scope='write')
        client = _connected(world, minted)
        status, revoked = world.tokens_api('alice', 'DELETE', f"/connect/tokens/{minted['token_id']}")
        assert status == 200
        assert revoked['token']['status'] == gt.STATUS_REVOKED

        assert client.request('tools/list').status == 401
        assert client.call('list_projects').status == 401
        # A fresh session cannot even complete the handshake.
        assert world.client(minted).connect().status == 401

    def test_an_expired_token_is_refused(self, world):
        minted = world.mint('alice', scope='read', expires_in_days=1)
        world.projects.update_item(
            Key={'pk': gt.GLOBAL_TOKEN_PK, 'sk': gt.token_sk(minted['token_id'])},
            UpdateExpression='SET expires_at = :past',
            ExpressionAttributeValues={':past': (datetime.now(UTC) - timedelta(seconds=1)).isoformat()},
        )

        reply = world.client(minted).request('tools/list')

        assert reply.status == 401
        assert reply.body['error']['code'] == -32001
        assert reply.headers['WWW-Authenticate'].startswith('Bearer')

    def test_a_disabled_minter_takes_their_tokens_with_them(self, world):
        minted = world.mint('alice', scope='read')
        world.cognito.disable('alice')

        assert world.client(minted).request('tools/list').status == 401

    def test_a_tampered_secret_is_refused(self, world):
        minted = world.mint('alice', scope='read')
        forged = minted['token'][:-4] + ('0000' if not minted['token'].endswith('0000') else '1111')

        assert world.client(forged).request('tools/list').status == 401


class TestProjectScopedToken:
    def test_is_confined_to_its_project(self, world):
        minted = world.mint('alice', scope='write', project_id=ALPHA)
        client = _connected(world, minted)

        is_error, listed = tool_payload(client.call('list_projects'))
        assert not is_error
        assert [p['project_id'] for p in listed['projects']] == [ALPHA]

        # Gamma is public — alice herself could read it, but this token cannot.
        calls_before = len(world.lambdas.calls)
        is_error, message = tool_payload(client.call('get_project', {'project_id': GAMMA}))
        assert is_error
        assert f'scoped to project {ALPHA}' in message
        assert len(world.lambdas.calls) == calls_before
        assert world.audit('alice', minted['token_id'])[0]['outcome'] == gt.OUTCOME_DENIED

    def test_defaults_project_tools_to_its_project(self, world):
        client = _connected(world, world.mint('alice', scope='write', project_id=ALPHA))

        is_error, created = tool_payload(client.call('create_document', {'title': 'Pinned', 'content': 'Hi'}))

        assert not is_error
        assert world.projects.get_item(
            Key={'pk': f'PROJECT#{ALPHA}', 'sk': f"DOC#{created['document']['document_id']}"},
        ).get('Item')

    def test_cannot_be_minted_for_a_project_the_minter_cannot_see(self, world):
        status, body = world.tokens_api('alice', 'POST', '/connect/tokens',
                                        {'name': 'x', 'scope': 'read', 'project_id': BETA})
        assert status == 404, body


class TestRunAgent:
    def test_a_non_admin_token_is_refused(self, world):
        client = _connected(world, world.mint('alice', scope='write'))
        assert 'run_agent' not in client.tool_names()

        is_error, message = tool_payload(client.call('run_agent', {'agent_id': world.agent_id}))

        assert is_error
        assert 'administrator' in message
        world.agents_env.sfn.start_execution.assert_not_called()

    def test_an_admin_minted_write_token_starts_a_run(self, world):
        minted = world.mint('root', scope='write')
        client = _connected(world, minted)
        assert 'run_agent' in client.tool_names()

        is_error, started = tool_payload(client.call('run_agent', {'agent_id': world.agent_id}))

        assert not is_error, started
        assert started['run']['agent_id'] == world.agent_id
        world.agents_env.sfn.start_execution.assert_called_once()
        assert world.audit('root', minted['token_id'])[0]['outcome'] == gt.OUTCOME_OK

    def test_an_admin_read_token_is_refused(self, world):
        client = _connected(world, world.mint('root', scope='read'))

        is_error, message = tool_payload(client.call('run_agent', {'agent_id': world.agent_id}))

        assert is_error
        assert 'read-only' in message

    def test_a_demoted_admins_token_stops_running_agents(self, world):
        client = _connected(world, world.mint('root', scope='write'))
        world.cognito.demote('root')

        is_error, message = tool_payload(client.call('run_agent', {'agent_id': world.agent_id}))

        assert is_error
        assert 'still an administrator' in message
        world.agents_env.sfn.start_execution.assert_not_called()


class TestAgentRuns:
    """`get_agent_run` follows a run `run_agent` started, with a READ token of anyone who sees the agent."""

    def _started_run(self, world) -> str:
        client = _connected(world, world.mint('root', scope='write'))
        is_error, started = tool_payload(client.call('run_agent', {'agent_id': world.agent_id}))
        assert not is_error, started
        return started['run']['run_id']

    def test_a_read_token_reads_the_run_by_id(self, world):
        run_id = self._started_run(world)
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, body = tool_payload(client.call('get_agent_run', {'agent_id': world.agent_id, 'run_id': run_id}))

        assert not is_error, body
        assert (body['run']['run_id'], body['run']['agent_id']) == (run_id, world.agent_id)

    def test_without_a_run_id_it_lists_the_newest_runs(self, world):
        run_id = self._started_run(world)
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, body = tool_payload(client.call('get_agent_run', {'agent_id': world.agent_id}))

        assert not is_error, body
        assert [run['run_id'] for run in body['items']] == [run_id]

    def test_an_unknown_run_is_a_tool_error_the_model_can_act_on(self, world):
        client = _connected(world, world.mint('alice', scope='read'))

        is_error, message = tool_payload(client.call('get_agent_run', {'agent_id': world.agent_id,
                                                                       'run_id': 'run_missing'}))

        assert is_error
        assert 'HTTP 404' in message


class TestTokenOwnership:
    def test_lists_only_my_tokens_and_never_a_secret(self, world):
        mine = world.mint('alice', scope='read')
        world.mint('bob', scope='read')

        status, body = world.tokens_api('alice', 'GET', '/connect/tokens')

        assert status == 200
        assert [t['token_id'] for t in body['tokens']] == [mine['token_id']]
        assert body['endpoint_path'] == '/mcp/global'
        assert all('secret_hash' not in t and 'token' not in t for t in body['tokens'])

    def test_someone_elses_token_cannot_be_revoked_or_audited(self, world):
        bobs = world.mint('bob', scope='read')

        assert world.tokens_api('alice', 'DELETE', f"/connect/tokens/{bobs['token_id']}")[0] == 404
        assert world.tokens_api('alice', 'GET', f"/connect/tokens/{bobs['token_id']}")[0] == 404
