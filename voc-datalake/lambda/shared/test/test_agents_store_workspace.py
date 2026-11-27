"""shared/agents_store.py in a workspace (7.80.00, docs/multi-workspace.md, the project plan 3g3-a).

A workspace's agents, their history, their workflows and their runs' rows are that workspace's own: every key is
built through shared/ws_repo.py, and every call goes through the workspace layer, which refuses a key outside it
before DynamoDB. Without a workspace every request is the one sent before. The registry row of each agent and
workflow (``WS#{ws}#AGENT_REGISTRY``) is written in the same transaction as its first row."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Key

from shared import agent_seed, engineering_templates, workflow_schema
from shared import agents_store as store
from shared.exceptions import NotFoundError, ValidationError
from shared.project_access import Caller
from shared.test.agents_fixtures import CATEGORIES, agent_body, agents_env
from shared.ws_repo import OutOfScopeError, WorkspaceScope

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
A, B = WorkspaceScope(WS_A), WorkspaceScope(WS_B)
NOW = datetime(2026, 11, 26, 9, 0, tzinfo=UTC)


def _fields(**overrides: Any) -> dict[str, Any]:
    return store.normalize_agent(agent_body(**overrides), CATEGORIES)


def _rows(table: Any) -> list[dict[str, Any]]:
    return table.scan(ConsistentRead=True)['Items']


def _found(row: dict[str, Any] | None) -> dict[str, Any]:
    """A read the test expects to find something."""
    assert row is not None
    return row


def _pks(table: Any) -> set[str]:
    return {row['pk'] for row in _rows(table)}


def _definition(name: str = 'Trail flow') -> dict[str, Any]:
    definition = workflow_schema.default_template()
    definition['name'] = name
    return definition


class TestKeys:
    def test_each_key_of_a_workspace_is_built_by_the_layer(self):
        assert store.agent_key('ag_0123456789ab', workspace=A) == {'pk': f'WS#{WS_A}#AGENT#ag_0123456789ab',
                                                                    'sk': 'META'}
        assert store.run_key('ag_0123456789ab', 'ar_019a2b3c4d5e0123', workspace=A) == {
            'pk': f'WS#{WS_A}#AGENT#ag_0123456789ab', 'sk': 'RUN#ar_019a2b3c4d5e0123'}
        assert store.workflow_current_key('wf_0123456789ab', workspace=A) == {
            'pk': f'WS#{WS_A}#WORKFLOW#wf_0123456789ab', 'sk': 'CURRENT'}
        assert store.workflow_revision_key('wf_0123456789ab', 3, workspace=A) == {
            'pk': f'WS#{WS_A}#WORKFLOW#wf_0123456789ab', 'sk': 'REV#000003'}
        assert store.agent_log_key('ag_0123456789ab', NOW, workspace=A)['pk'] == f'WS#{WS_A}#AGENT#ag_0123456789ab'

    def test_without_a_workspace_the_keys_are_the_deployments(self):
        assert store.agent_key('ag_0123456789ab') == {'pk': 'AGENT#ag_0123456789ab', 'sk': 'META'}
        assert store.workflow_current_key('wf_0123456789ab') == {'pk': 'WORKFLOW#wf_0123456789ab', 'sk': 'CURRENT'}

    def test_a_malformed_id_builds_no_workspace_key(self):
        with pytest.raises(ValueError, match='not an agent'):
            store.agent_key('ag_x#WS#other', workspace=A)


class TestAgents:
    def test_an_agent_and_its_registry_row_are_written_in_the_workspace_only(self):
        with agents_env() as env:
            agent = store.create_agent(env.agents, _fields(), created_by='sub-ada', now=NOW, workspace=A)
            agent_id = agent['agent_id']
            rows = {(row['pk'], row['sk']): row for row in _rows(env.agents)}
            assert set(rows) == {(f'WS#{WS_A}#AGENT#{agent_id}', 'META'),
                                 (f'WS#{WS_A}#AGENT_REGISTRY', f'AGENT#{agent_id}')}
            assert rows[(f'WS#{WS_A}#AGENT#{agent_id}', 'META')]['gsi1pk'] == f'WS#{WS_A}#AGENTS'
            assert _found(store.get_agent(env.agents, agent_id, workspace=A))['name'] == 'Shipping crew'
            assert store.get_agent(env.agents, agent_id) is None
            assert store.get_agent(env.agents, agent_id, workspace=B) is None

    def test_each_scope_lists_its_own_agents(self):
        with agents_env() as env:
            ours = store.create_agent(env.agents, _fields(name='Ours'), created_by='s', now=NOW, workspace=A)
            theirs = store.create_agent(env.agents, _fields(name='Theirs'), created_by='s', now=NOW, workspace=B)
            deployment = store.create_agent(env.agents, _fields(name='Deployment'), created_by='s', now=NOW)
            assert [a['agent_id'] for a in store.list_agents(env.agents, workspace=A)] == [ours['agent_id']]
            assert [a['agent_id'] for a in store.list_agents(env.agents, workspace=B)] == [theirs['agent_id']]
            assert [a['agent_id'] for a in store.list_agents(env.agents)] == [deployment['agent_id']]

    def test_an_update_in_a_never_reaches_bs_agent(self):
        with agents_env() as env:
            theirs = store.create_agent(env.agents, _fields(), created_by='s', now=NOW, workspace=B)
            before = _rows(env.agents)
            with pytest.raises(NotFoundError):
                store.update_agent(env.agents, theirs['agent_id'], {'name': 'Taken'}, updated_by='x', now=NOW,
                                   workspace=A)
            assert _rows(env.agents) == before

    def test_an_update_and_an_archive_in_the_workspace(self):
        with agents_env() as env:
            ours = store.create_agent(env.agents, _fields(), created_by='s', now=NOW, workspace=A)
            updated = store.update_agent(env.agents, ours['agent_id'], {'name': 'Renamed'}, updated_by='u', now=NOW,
                                         workspace=A)
            assert (updated['name'], updated['gsi1sk'], updated['gsi1pk']) == ('Renamed', 'Renamed', f'WS#{WS_A}#AGENTS')
            store.update_agent(env.agents, ours['agent_id'], {'status': store.AGENT_STATUS_ARCHIVED}, updated_by='u',
                               now=NOW, allow_archived=True, workspace=A)
            assert _found(store.get_agent(env.agents, ours['agent_id'], workspace=A))['status'] == 'archived'

    def test_a_pause_and_its_history_row_stay_in_the_workspace(self):
        with agents_env() as env:
            ours = store.create_agent(env.agents, _fields(enabled=True), created_by='s', now=NOW, workspace=A)
            agent_id = ours['agent_id']
            paused = store.set_paused(env.agents, agent_id, True, by='sub-ada', username='ada', now=NOW, workspace=A)
            assert paused['paused'] is True
            logs = [row for row in _rows(env.agents) if row['sk'].startswith('LOG#')]
            assert [(row['pk'], row['event'], row['by']) for row in logs] == [
                (f'WS#{WS_A}#AGENT#{agent_id}', 'paused', 'sub-ada')]
            with pytest.raises(NotFoundError):
                store.set_paused(env.agents, agent_id, False, by='x', username='x', now=NOW, workspace=B)


class TestWorkflows:
    def test_a_workflow_its_revision_and_its_registry_row_are_the_workspaces(self):
        with agents_env() as env:
            created = store.create_workflow(env.agents, _definition(), created_by='s', username='ada', now=NOW,
                                            workspace=A)
            workflow_id = created['workflow_id']
            assert _pks(env.agents) == {f'WS#{WS_A}#WORKFLOW#{workflow_id}', f'WS#{WS_A}#AGENT_REGISTRY'}
            registry = [row for row in _rows(env.agents) if row['pk'] == f'WS#{WS_A}#AGENT_REGISTRY']
            assert [row['sk'] for row in registry] == [f'WORKFLOW#{workflow_id}']
            assert created['gsi1pk'] == f'WS#{WS_A}#WORKFLOWS'
            assert [row['workflow_id'] for row in store.list_workflows(env.agents, workspace=A)] == [
                workflow_schema.DEFAULT_WORKFLOW_ID, workflow_id]
            assert [row['workflow_id'] for row in store.list_workflows(env.agents, workspace=B)] == [
                workflow_schema.DEFAULT_WORKFLOW_ID]
            assert store.get_workflow(env.agents, workflow_id) is None
            assert store.get_workflow(env.agents, workflow_id, workspace=B) is None

    def test_a_save_a_revision_read_and_an_archive_in_the_workspace(self):
        with agents_env() as env:
            workflow_id = store.create_workflow(env.agents, _definition(), created_by='s', username='ada', now=NOW,
                                                workspace=A)['workflow_id']
            saved = store.save_revision(env.agents, workflow_id, _definition('Second'), expected_revision=1,
                                        saved_by='s', username='ada', now=NOW, workspace=A)
            assert saved['revision'] == 2
            assert [row['revision'] for row in store.list_revisions(env.agents, workflow_id, workspace=A)] == [2, 1]
            assert store.list_revisions(env.agents, workflow_id, workspace=B) == []
            assert _found(store.get_revision(env.agents, workflow_id, 1, workspace=A))['name'] == 'Trail flow'
            assert store.get_revision(env.agents, workflow_id, 1, workspace=B) is None
            with pytest.raises(NotFoundError):
                store.save_revision(env.agents, workflow_id, _definition('Taken'), expected_revision=2, saved_by='x',
                                    username='x', now=NOW, workspace=B)
            with pytest.raises(NotFoundError):
                store.archive_workflow(env.agents, workflow_id, archived_by='x', username='x', now=NOW, workspace=B)
            archived = store.archive_workflow(env.agents, workflow_id, archived_by='s', username='ada', now=NOW,
                                              workspace=A)
            assert archived['status'] == 'archived'

    def test_the_builtin_is_every_scopes_and_never_stored(self):
        with agents_env() as env:
            assert _found(store.get_workflow(env.agents, workflow_schema.DEFAULT_WORKFLOW_ID,
                                             workspace=A))['builtin'] is True
            assert _rows(env.agents) == []


class TestRuns:
    def _seed(self, env: Any, scope: WorkspaceScope | None) -> tuple[str, str]:
        agent_id, run_id = 'ag_0123456789ab', 'ar_019a2b3c4d5e0123'
        env.agents.put_item(Item={**store.run_key(agent_id, run_id, workspace=scope), 'run_id': run_id,
                                  'agent_id': agent_id, 'status': 'completed'})
        prefix = '' if scope is None else scope.prefix
        env.agents.put_item(Item={'pk': f'{prefix}RUN#{run_id}', 'sk': 'EVT#00000001', 'seq': 1, 'kind': 'message',
                                  'summary': f'{prefix or "deployment"} step'})
        return agent_id, run_id

    def test_a_workspaces_runs_and_events_are_read_in_it_only(self):
        with agents_env() as env:
            agent_id, run_id = self._seed(env, A)
            assert _found(store.get_run(env.agents, agent_id, run_id, workspace=A))['status'] == 'completed'
            assert store.get_run(env.agents, agent_id, run_id) is None
            assert store.get_run(env.agents, agent_id, run_id, workspace=B) is None
            runs, _cursor = store.list_runs(env.agents, agent_id, limit=10, workspace=A)
            assert [run['run_id'] for run in runs] == [run_id]
            assert store.list_runs(env.agents, agent_id, limit=10, workspace=B) == ([], None)
            assert [event['summary'] for event in store.list_events(env.agents, run_id, after=0, limit=10,
                                                                    workspace=A)] == [f'WS#{WS_A}# step']
            assert store.list_events(env.agents, run_id, after=0, limit=10, workspace=B) == []

    def test_a_cursor_of_another_scope_is_refused(self):
        with agents_env() as env:
            agent_id, _run_id = self._seed(env, None)
            deployment_cursor = store.encode_cursor({'pk': f'AGENT#{agent_id}', 'sk': 'RUN#ar_019a2b3c4d5e0123'})
            with pytest.raises(ValidationError, match='cursor'):
                store.list_runs(env.agents, agent_id, limit=1, cursor=deployment_cursor, workspace=A)


class TestTheDeploymentsRequests:
    """Without a workspace each call sends the request it always sent (the table's own calls)."""

    def _table(self) -> MagicMock:
        table = MagicMock(name='agents')
        table.name = 'test-agents'
        table.query.return_value = {'Items': []}
        table.get_item.return_value = {}
        return table

    def test_reads(self):
        table = self._table()
        store.get_agent(table, 'ag_0123456789ab')
        table.get_item.assert_called_once_with(Key={'pk': 'AGENT#ag_0123456789ab', 'sk': 'META'}, ConsistentRead=True)
        store.list_revisions(table, 'wf_0123456789ab')
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('WORKFLOW#wf_0123456789ab') & Key('sk').begins_with('REV#'),
            ScanIndexForward=False, Limit=50, ProjectionExpression='revision, saved_at, saved_by_username')

    def test_writes(self):
        table = self._table()
        store.create_agent(table, _fields(), created_by='sub-ada', now=NOW)
        assert table.put_item.call_args.kwargs['ConditionExpression'] == 'attribute_not_exists(pk)'
        assert table.put_item.call_args.kwargs['Item']['pk'].startswith('AGENT#')
        table.meta.client.transact_write_items.assert_not_called()
        store.create_workflow(table, _definition(), created_by='s', username='ada', now=NOW)
        [items] = [call.kwargs['TransactItems'] for call in table.meta.client.transact_write_items.call_args_list]
        assert [(next(iter(entry)), entry[next(iter(entry))]['TableName']) for entry in items] == [
            ('Put', 'test-agents'), ('Put', 'test-agents')]
        assert [entry['Put']['Item']['sk'] for entry in items] == ['CURRENT', 'REV#000001']

    # The exact requests the base release sent (7.72.03's shared/agents_store.py, copied from its code), for the
    # calls whose deployment path 3g3-a rebuilt: a run page, a run's events, an update, a pause and a resume, a saved
    # revision and a run's start.
    AGENT = 'ag_0123456789ab'
    STAMP = '2026-11-26T09:00:00+00:00'

    def test_a_run_page_and_a_runs_events(self):
        table = self._table()
        store.list_runs(table, self.AGENT, limit=5)
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq(f'AGENT#{self.AGENT}') & Key('sk').begins_with('RUN#'),
            ScanIndexForward=False, Limit=5)
        table.query.reset_mock()
        store.list_events(table, 'ar_019a2b3c4d5e0123', after=3, limit=50)
        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('RUN#ar_019a2b3c4d5e0123') & Key('sk').between(
                'EVT#00000004', 'EVT#99999999'),
            Limit=50)

    def test_an_update(self):
        table = self._table()
        table.update_item.return_value = {'Attributes': {}}
        store.update_agent(table, self.AGENT, {'name': 'Scout'}, updated_by='sub-ada', now=NOW)
        table.update_item.assert_called_once_with(
            Key={'pk': f'AGENT#{self.AGENT}', 'sk': 'META'},
            UpdateExpression='SET #f0 = :v0, #f1 = :v1, #f2 = :v2, #f3 = :v3',
            ConditionExpression='attribute_exists(pk) AND #status <> :archived',
            ExpressionAttributeNames={'#f0': 'name', '#f1': 'updated_by', '#f2': 'updated_at', '#f3': 'gsi1sk',
                                      '#status': 'status'},
            ExpressionAttributeValues={':v0': 'Scout', ':v1': 'sub-ada', ':v2': self.STAMP, ':v3': 'Scout',
                                       ':archived': store.AGENT_STATUS_ARCHIVED},
            ReturnValues='ALL_NEW')

    @pytest.mark.parametrize('paused', [True, False])
    def test_a_pause_and_a_resume(self, paused):
        table = self._table()
        table.get_item.return_value = {'Item': {'agent_id': self.AGENT}}
        store.set_paused(table, self.AGENT, paused, by='sub-ada', username='ada', now=NOW)
        [update, put] = table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        sent = update['Update']
        table_name, key = sent.pop('TableName'), sent.pop('Key')
        assert (table_name, key) == ('test-agents', {'pk': f'AGENT#{self.AGENT}', 'sk': 'META'})
        if paused:
            assert sent == {
                'UpdateExpression': 'SET paused = :true, paused_at = :at, paused_by = :username, updated_at = :at, '
                                    'updated_by = :by',
                'ConditionExpression': 'attribute_exists(pk) AND #status <> :archived AND enabled = :true AND '
                                       '(attribute_not_exists(paused) OR paused <> :true)',
                'ExpressionAttributeNames': {'#status': 'status'},
                'ExpressionAttributeValues': {':true': True, ':at': self.STAMP, ':by': 'sub-ada', ':username': 'ada',
                                              ':archived': 'archived'}}
        else:
            assert sent == {
                'UpdateExpression': 'SET paused = :false, updated_at = :at, updated_by = :by REMOVE paused_at, paused_by',
                'ConditionExpression': 'attribute_exists(pk) AND paused = :true',
                'ExpressionAttributeValues': {':true': True, ':at': self.STAMP, ':by': 'sub-ada', ':false': False}}
        log = put['Put']['Item']
        assert log['sk'].startswith('LOG#2026-11-26T09:00:00.000000+00:00#')
        assert put == {'Put': {'TableName': 'test-agents', 'ConditionExpression': 'attribute_not_exists(sk)',
                               'Item': {'pk': f'AGENT#{self.AGENT}', 'sk': log['sk'],
                                        'event': 'paused' if paused else 'resumed', 'by': 'sub-ada',
                                        'username': 'ada', 'at': self.STAMP, 'via': 'route'}}}

    def test_a_saved_revision(self):
        table = self._table()
        table.get_item.return_value = {'Item': {'workflow_id': 'wf_0123456789ab'}}
        definition = _definition('Trail flow')
        store.save_revision(table, 'wf_0123456789ab', definition, expected_revision=2, saved_by='sub-ada',
                            username='ada', now=NOW)
        [update, put] = table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        revision = store._revision_attrs(definition, 3, saved_by='sub-ada', username='ada', stamp=self.STAMP)
        clause, names, values = store.set_clause({
            **revision, 'description': definition.get('description', ''), 'updated_at': self.STAMP,
            'updated_by_username': 'ada', 'slug': workflow_schema.slugify('Trail flow'),
            'gsi1sk': 'trail flow#wf_0123456789ab'})
        assert update == {'Update': {
            'TableName': 'test-agents', 'Key': {'pk': 'WORKFLOW#wf_0123456789ab', 'sk': 'CURRENT'},
            'UpdateExpression': f'SET {clause}',
            'ConditionExpression': ('attribute_exists(pk) AND #rev = :expected '
                                    'AND (attribute_not_exists(#status) OR #status <> :archived)'),
            'ExpressionAttributeNames': {**names, '#rev': 'revision', '#status': 'status'},
            'ExpressionAttributeValues': {**values, ':expected': 2, ':archived': store.WORKFLOW_STATUS_ARCHIVED}}}
        assert put == {'Put': {'TableName': 'test-agents',
                               'Item': {'pk': 'WORKFLOW#wf_0123456789ab', 'sk': 'REV#000003',
                                        'workflow_id': 'wf_0123456789ab', **revision},
                               'ConditionExpression': 'attribute_not_exists(pk)'}}

    def test_a_runs_start(self):
        table = self._table()
        run_id = 'ar_019a2b3c4d5e0123'
        run = store.start_run(table, {'agent_id': self.AGENT, 'workflow_id': 'wf_0123456789ab'}, store.RunStart(
            trigger=store.TRIGGER_MANUAL, requested_by='sub-ada', workflow_revision=2, run_id=run_id), now=NOW)
        [update, put] = table.meta.client.transact_write_items.call_args.kwargs['TransactItems']
        clause, names, values = store.set_clause({
            'active_run_id': run_id, 'last_run_at': self.STAMP, 'last_run_id': run_id,
            'last_run_status': store.RUN_QUEUED, 'last_run_cursor': self.STAMP})
        assert update == {'Update': {
            'TableName': 'test-agents', 'Key': {'pk': f'AGENT#{self.AGENT}', 'sk': 'META'},
            'UpdateExpression': f'SET {clause}, runs_total = if_not_exists(runs_total, :zero) + :inc',
            'ConditionExpression': ('attribute_exists(pk) AND #status <> :archived '
                                    'AND attribute_not_exists(active_run_id)'),
            'ExpressionAttributeNames': {**names, '#status': 'status'},
            'ExpressionAttributeValues': {**values, ':archived': store.AGENT_STATUS_ARCHIVED, ':zero': 0, ':inc': 1}}}
        assert put == {'Put': {'TableName': 'test-agents', 'ConditionExpression': 'attribute_not_exists(pk)', 'Item': {
            'pk': f'AGENT#{self.AGENT}', 'sk': f'RUN#{run_id}', 'gsi1pk': 'RUNS_ACTIVE',
            'gsi1sk': f'{self.STAMP}#{run_id}', 'run_id': run_id, 'agent_id': self.AGENT, 'status': store.RUN_QUEUED,
            'trigger': store.TRIGGER_MANUAL, 'trigger_detail': {}, 'requested_by': 'sub-ada',
            'started_at': self.STAMP, 'workflow_id': 'wf_0123456789ab', 'workflow_revision': 2, 'model_calls': 0,
            'event_seq': 0}}}
        assert run == put['Put']['Item']


class TestTheTemplatesCopy:
    """shared/agent_seed.py ``default_workflow_copy``: ``POST /agents``' own copy of the template, in the request's
    library; never an engineering flow (``voc-workflow/2``) into a workspace."""

    CALLER = Caller(subject='sub-ada', is_admin=True, username='ada')

    def test_an_agents_workflow_is_copied_into_the_workspace(self):
        with agents_env() as env:
            workflow_id = agent_seed.default_workflow_copy(env.agents, 'Scout', self.CALLER, workspace=A)
            copied = store.workflow_view(_found(store.get_workflow(env.agents, workflow_id, workspace=A)))
            assert (copied['name'], copied['kind']) == ('Scout workflow', 'agents')

    def test_an_engineering_flow_is_never_copied_into_a_workspace(self, monkeypatch):
        [engineering, *_] = engineering_templates.list_templates()
        assert engineering['definition']['schema'] == workflow_schema.SCHEMA_V2
        monkeypatch.setattr(workflow_schema, 'default_template', lambda: dict(engineering['definition']))
        with agents_env() as env:
            with pytest.raises(ValueError, match="the deployment's"):
                agent_seed.default_workflow_copy(env.agents, 'Scout', self.CALLER, workspace=A)
            assert _rows(env.agents) == []
            # (the deployment's library is the engineering flows' own: there it is copied, as before)
            workflow_id = agent_seed.default_workflow_copy(env.agents, 'Scout', self.CALLER)
            assert store.workflow_view(_found(store.get_workflow(env.agents, workflow_id)))['kind'] == 'engineering'


def test_the_workspace_layer_refuses_a_key_of_another_workspace():
    """A store call in A whose key names B is refused before DynamoDB (the layer's own check)."""
    with agents_env() as env:
        theirs = store.create_agent(env.agents, _fields(), created_by='s', now=NOW, workspace=B)
        with pytest.raises(OutOfScopeError):
            store._calls(env.agents, A).get_item(Key=store.agent_key(theirs['agent_id'], workspace=B))
