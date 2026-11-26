"""The agents API inside a workspace (7.80.00, docs/multi-workspace.md, the project plan 3g3-a).

With ``X-Workspace-Id`` the agents and workflows routes act on that workspace's own rows: any member reads, its
admins acting for themselves write. No agent is seeded there, an engineering agent or flow is refused, and no run
starts there (enable, Run now, cancel and decision answer 409 before any run or lock is written) until the agents'
runtime moves into the workspace. The two-workspace isolation of every route is proven by the cross-workspace suite
(cross_workspace_worlds.py); these are the rules inside one workspace."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, api, call

import agents_handler
from shared import agents_store as store
from shared import engineering_templates, request_workspace, workflow_schema
from shared.test.agents_fixtures import CATEGORIES, AgentsEnv, agent_body
from shared.workspace import MembershipCache
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
A = WorkspaceScope(WS_A)
#: A's admin, in no deployment group.
WENDY = {'sub': 'sub-wendy', 'cognito:username': 'wendy', 'cognito:groups': 'users'}
#: A's viewer.
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
#: An MCP token Wendy minted (a delegated caller acting for her).
WENDYS_TOKEN = {'sub': 'mcp:tok_1', 'voc:acting_subject': 'sub-wendy', 'cognito:groups': 'users'}
IN_A = {'X-Workspace-Id': WS_A}


@pytest.fixture
def env() -> Iterator[AgentsEnv]:
    with api() as made, patch.object(request_workspace, '_MEMBERSHIPS', MembershipCache()):
        made.add_member(WS_A, 'sub-wendy', role='admin')
        made.add_member(WS_A, 'sub-vic', role='viewer')
        made.add_member(WS_B, 'sub-bea', role='admin')
        # A's own categories (an agent's scope is checked against its workspace's, never the deployment's).
        made.aggregates.put_item(Item={**settings_key(WS_A, 'categories'), 'categories': CATEGORIES})
        yield made


def _in_a(lambda_context: Any, method: str, path: str, *, claims: dict = WENDY, **kwargs: Any) -> tuple[int, dict]:
    return call(lambda_context, method, path, claims=claims, headers=IN_A, **kwargs)


def _rows(env: AgentsEnv) -> list[dict[str, Any]]:
    return sorted(env.agents.scan(ConsistentRead=True)['Items'], key=lambda row: (row['pk'], row['sk']))


def _create(lambda_context: Any, **overrides: Any) -> dict:
    status, body = _in_a(lambda_context, 'POST', '/agents', body=agent_body(**overrides))
    assert status == 201, body
    return body['agent']


class TestAgentsOfAWorkspace:
    def test_its_admin_creates_lists_and_reads_its_own_agents(self, env, lambda_context):
        agent = _create(lambda_context)
        # The agent and its own copy of the template, each with its registry row, all in A's partitions.
        assert {row['pk'].split('#')[2] for row in _rows(env)} == {'AGENT', 'WORKFLOW', 'AGENT_REGISTRY'}
        assert all(row['pk'].startswith(f'WS#{WS_A}#') for row in _rows(env))
        status, listed = _in_a(lambda_context, 'GET', '/agents')
        assert (status, [item['agent_id'] for item in listed['items']]) == (200, [agent['agent_id']])
        assert _in_a(lambda_context, 'GET', f"/agents/{agent['agent_id']}", claims=VIC)[0] == 200
        # Without the header: the deployment's agents (the default one seeded for its admin), never A's.
        status, deployment = call(lambda_context, 'GET', '/agents')
        assert status == 200
        assert agent['agent_id'] not in [item['agent_id'] for item in deployment['items']]
        assert call(lambda_context, 'GET', f"/agents/{agent['agent_id']}")[0] == 404

    def test_a_deployment_admin_who_is_its_viewer_sees_every_agent(self, env, lambda_context):
        """As on the workspace's other routes, a deployment admin acting for themselves is not narrowed by the
        workspace's categories: as its viewer they see an agent scoped to a category (and cannot write)."""
        env.add_member(WS_A, 'admin-sub', role='viewer')
        agent = _create(lambda_context, scope={'all': False, 'categories': ['billing']})
        status, listed = _in_a(lambda_context, 'GET', '/agents', claims=ADMIN)
        assert (status, [item['agent_id'] for item in listed['items']]) == (200, [agent['agent_id']])
        assert _in_a(lambda_context, 'GET', f"/agents/{agent['agent_id']}", claims=ADMIN)[0] == 200
        assert _in_a(lambda_context, 'PUT', f"/agents/{agent['agent_id']}", claims=ADMIN, body={'name': 'x'})[0] == 403

    def test_no_agent_is_seeded_in_a_workspace(self, env, lambda_context):
        assert _in_a(lambda_context, 'GET', '/agents')[1] == {'items': [], 'count': 0}
        assert _rows(env) == []

    @pytest.mark.parametrize('claims', [VIC, ADMIN, WENDYS_TOKEN], ids=['a-viewer', 'a-deployment-admin', 'a-token'])
    def test_only_its_admin_acting_for_themselves_writes(self, env, lambda_context, claims):
        """A viewer, an editor who is a deployment admin (the ``admins`` group grants nothing in a workspace) and a
        token acting for A's admin are each refused, nothing written."""
        if claims is ADMIN:
            env.add_member(WS_A, 'admin-sub', role='editor')
        status, _body = _in_a(lambda_context, 'POST', '/agents', claims=claims, body=agent_body())
        assert status == 403
        assert _rows(env) == []

    def test_an_engineering_agent_is_refused_in_a_workspace(self, env, lambda_context):
        body = agent_body(engineering={'connection': None, 'language': None, 'feedback_type': 'bug'})
        status, answer = _in_a(lambda_context, 'POST', '/agents', body=body)
        assert status == 400
        assert 'deployment' in answer['error']
        assert _rows(env) == []

    def test_a_workflow_of_another_workspace_is_no_workflow_here(self, env, lambda_context):
        theirs = store.create_workflow(env.agents, workflow_schema.default_template(), created_by='sub-bea',
                                       username='bea', now=store.utc_now(), workspace=WorkspaceScope(WS_B))
        before = _rows(env)
        status, answer = _in_a(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=theirs['workflow_id']))
        assert (status, answer['error']) == (400, 'workflow_id does not name a workflow')
        assert _rows(env) == before

    def test_its_agent_runs_as_one_of_its_current_members_only(self, env, lambda_context):
        """``owner_sub`` (who an agent's runs act as) named in a workspace is one of its current members: another
        workspace's admin, someone who was removed or anyone else is 400 and nothing is written or changed; a member
        (its viewer too) is kept. Unnamed, the agent runs as the admin who created it, as in the deployment."""
        env.add_member(WS_A, 'sub-gone', role='editor')
        env.workspaces.delete_item(Key={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-gone'})
        for stranger in ('sub-bea', 'sub-gone', 'admin-sub'):
            status, answer = _in_a(lambda_context, 'POST', '/agents', body=agent_body(owner_sub=stranger))
            assert (status, answer['error']) == (400, agents_handler.OWNER_NOT_A_MEMBER), stranger
        assert _rows(env) == []
        assert _create(lambda_context)['owner_sub'] == 'sub-wendy'
        agent = _create(lambda_context, name='Viewer run', owner_sub='sub-vic')
        assert agent['owner_sub'] == 'sub-vic'
        path = f"/agents/{agent['agent_id']}"
        before = _rows(env)
        status, answer = _in_a(lambda_context, 'PUT', path, body={'owner_sub': 'sub-bea'})
        assert (status, answer['error'], _rows(env)) == (400, agents_handler.OWNER_NOT_A_MEMBER, before)
        # An edit that names no owner keeps the stored one, even once that member has left.
        env.workspaces.delete_item(Key={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-vic'})
        status, answer = _in_a(lambda_context, 'PUT', path, body={'description': 'Still here'})
        assert (status, answer['agent']['owner_sub']) == (200, 'sub-vic')


class TestATokenMintedInTheWorkspace:
    """7.80.00: an MCP token minted inside A sends A's X-Workspace-Id to the agents API too (shared/mcp_delegate.py):
    its agents_list is A's agents, and its Run now is refused (a delegated caller writes nothing in a workspace), so
    the MCP server does not offer it agents_run (api/mcp_global_handler.py ``NOT_OFFERED_TO_A_WORKSPACE_TOKEN``)."""

    @pytest.mark.usefixtures('env')
    def test_its_agents_list_is_the_workspaces_agents(self, lambda_context):
        agent = _create(lambda_context)
        status, listed = _in_a(lambda_context, 'GET', '/agents', claims=WENDYS_TOKEN)
        assert (status, [item['agent_id'] for item in listed['items']]) == (200, [agent['agent_id']])

    def test_its_run_now_is_refused_and_starts_nothing(self, env, lambda_context):
        agent = _create(lambda_context)
        before = _rows(env)
        status, _body = _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/run", claims=WENDYS_TOKEN)
        assert (status, _rows(env)) == (403, before)
        env.sfn.start_execution.assert_not_called()


class TestNoRunStartsInAWorkspace:
    def test_an_agent_is_never_turned_on_there(self, env, lambda_context):
        assert _in_a(lambda_context, 'POST', '/agents', body=agent_body(enabled=True))[0] == 409
        assert _rows(env) == []
        agent = _create(lambda_context)
        before = _rows(env)
        for method, path, body in (('POST', f"/agents/{agent['agent_id']}/enable", None),
                                   ('PUT', f"/agents/{agent['agent_id']}", {'enabled': True})):
            status, answer = _in_a(lambda_context, method, path, body=body)
            assert (status, answer['code']) == (409, 'runs_not_in_workspace'), (method, path)
        assert _rows(env) == before
        # Turning it off is a plain update.
        assert _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/disable")[0] == 200

    def test_run_now_starts_nothing(self, env, lambda_context):
        agent = _create(lambda_context)
        before = _rows(env)
        status, answer = _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/run")
        assert (status, answer['code']) == (409, 'runs_not_in_workspace')
        assert _rows(env) == before
        env.sfn.start_execution.assert_not_called()

    @pytest.mark.parametrize(('tail', 'body'), [('cancel', None), ('decision', {'decision': 'stop'})])
    def test_a_runs_cancel_and_decision_change_nothing(self, env, lambda_context, tail, body):
        agent = _create(lambda_context)
        run_id = 'ar_019a2b3c4d5e0123'
        env.agents.put_item(Item={**store.run_key(agent['agent_id'], run_id, workspace=A), 'run_id': run_id,
                                  'agent_id': agent['agent_id'], 'status': 'needs_human'})
        before = _rows(env)
        status, answer = _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/runs/{run_id}/{tail}", body=body)
        assert (status, answer['code']) == (409, 'runs_not_in_workspace')
        assert _rows(env) == before
        env.sfn.stop_execution.assert_not_called()
        # Its runs and their journal are read in the workspace.
        assert _in_a(lambda_context, 'GET', f"/agents/{agent['agent_id']}/runs")[1]['items'][0]['run_id'] == run_id

    @pytest.mark.usefixtures('env')
    def test_a_pause_needs_an_agent_that_is_on(self, lambda_context):
        agent = _create(lambda_context)
        assert _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/pause")[0] == 409
        status, answer = _in_a(lambda_context, 'POST', f"/agents/{agent['agent_id']}/resume")
        assert (status, answer['agent']['paused']) == (200, False)


class TestWorkflowsOfAWorkspace:
    @pytest.mark.usefixtures('env')
    def test_its_library_holds_its_own_flows_and_who_uses_them(self, lambda_context):
        agent = _create(lambda_context)
        status, library = _in_a(lambda_context, 'GET', '/workflows', claims=VIC)
        assert status == 200
        stored = [item for item in library['items'] if not item['builtin']]
        assert [item['workflow_id'] for item in stored] == [agent['workflow_id']]
        assert [user['agent_id'] for user in stored[0]['used_by']['automations']] == [agent['agent_id']]
        assert [item['workflow_id'] for item in call(lambda_context, 'GET', '/workflows')[1]['items']] == [
            workflow_schema.DEFAULT_WORKFLOW_ID]

    def test_an_engineering_flow_is_refused_in_a_workspace(self, env, lambda_context):
        definition = engineering_templates.list_templates()[0]['definition']
        status, answer = _in_a(lambda_context, 'POST', '/workflows', body={'definition': definition})
        assert status == 409
        assert 'deployment' in answer['error']
        assert _rows(env) == []
