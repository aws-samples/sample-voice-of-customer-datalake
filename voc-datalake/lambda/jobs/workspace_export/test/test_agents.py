"""voc-workspace-export (7.80.00, jobs/workspace_export/agents.py): a workspace's agents and workflows in its export.

The entity walks the workspace's registry (``WS#{ws}#AGENT_REGISTRY``), then each listed partition by its listed row
kinds only (an agent's ``META`` and pause history, a workflow's ``CURRENT`` and revisions), each row with only the
fields it lists; never another workspace's rows, a run's rows (none can be written in a workspace yet), an index key,
a lock, a counter or a saver's sub."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from jobs.workspace_export import agents, handler
from jobs.workspace_export.test.conftest import OTHER, WS, World, seed
from jobs.workspace_export.test.test_handler import _jsonl, _unzip
from jobs.workspace_export.test.test_memory import _run
from shared import agents_store as store
from shared import workflow_schema
from shared.ws_repo import WorkspaceScope, agent_registry_pk

NOW = datetime(2026, 11, 26, 9, 0, tzinfo=UTC)


def _seed_agents(world: World) -> dict[str, dict[str, str]]:
    """In each workspace, through the store: an agent (turned on and paused, so it has a history row) with its
    workflow saved twice; plus attributes no list names, a run row and a registry row of another shape."""
    made: dict[str, dict[str, str]] = {}
    for ws, name in ((WS, 'Ours'), (OTHER, 'Theirs')):
        scope = WorkspaceScope(ws)
        definition = {**workflow_schema.default_template(), 'name': f'{name} flow'}
        workflow = store.create_workflow(world.agents, definition, created_by='sub-saver', username='saver', now=NOW,
                                         workspace=scope)
        store.save_revision(world.agents, workflow['workflow_id'], {**definition, 'name': f'{name} flow 2'},
                            expected_revision=1, saved_by='sub-saver', username='saver', now=NOW, workspace=scope)
        fields = store.normalize_agent({'name': f'{name} scout', 'workflow_id': workflow['workflow_id'],
                                        'enabled': True}, [])
        agent = store.create_agent(world.agents, fields, created_by='sub-owner', now=NOW, workspace=scope)
        store.set_paused(world.agents, agent['agent_id'], True, by='sub-owner', username='owner', now=NOW,
                         workspace=scope)
        store.update_agent(world.agents, agent['agent_id'], {'later_field': 'x', 'month_calls': 7, 'month_key': '2026-11',
                                                            'active_run_id': 'ar_019a2b3c4d5e0123'},
                           updated_by='sub-owner', now=NOW, workspace=scope)
        world.agents.put_item(Item={**store.run_key(agent['agent_id'], 'ar_019a2b3c4d5e0123', workspace=scope),
                                    'run_id': 'ar_019a2b3c4d5e0123', 'status': 'running', 'summary': f'{name} run'})
        made[ws] = {'agent_id': agent['agent_id'], 'workflow_id': workflow['workflow_id']}
    world.agents.put_item(Item={'pk': agent_registry_pk(WorkspaceScope(WS)), 'sk': 'LATER#thing'})
    return made


def _rows(world: World, checks: int | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    _run(world, checks)
    files = _unzip(world)
    return _jsonl(files, 'agents_workflows'), json.loads(files['manifest.json'])


def test_the_workspaces_agents_and_workflows_are_exported_with_their_listed_fields_only(world):
    seed(world)
    made = _seed_agents(world)[WS]
    rows, manifest = _rows(world)
    by_sk = {}
    for row in rows:
        by_sk.setdefault(row['sk'].split('#')[0], []).append(row)
    assert sorted(by_sk) == ['CURRENT', 'LOG', 'META', 'REV']
    [agent] = by_sk['META']
    assert (agent['agent_id'], agent['name'], agent['paused'], agent['enabled']) == (made['agent_id'], 'Ours scout',
                                                                                     True, True)
    assert set(agent) <= set(agents.AGENT_FIELDS)
    for left_out in ('gsi1pk', 'gsi1sk', 'later_field', 'month_calls', 'month_key', 'active_run_id', 'runs_total',
                     'last_run_cursor'):
        assert left_out not in agent
    [log] = by_sk['LOG']
    assert (log['event'], log['by'], log['username']) == ('paused', 'sub-owner', 'owner')
    [current] = by_sk['CURRENT']
    assert (current['workflow_id'], current['name'], current['revision']) == (made['workflow_id'], 'Ours flow 2', 2)
    assert 'saved_by' not in current
    assert 'created_by' not in current
    assert sorted(row['revision'] for row in by_sk['REV']) == [1, 2]
    assert all('saved_by' not in row and row['saved_by_username'] == 'saver' for row in by_sk['REV'])
    # Every row is the workspace's own; no run row, nothing of the other workspace.
    assert all(row['pk'].startswith(f'WS#{WS}#') for row in rows)
    text = json.dumps(rows)
    assert 'Theirs' not in text
    assert 'Ours run' not in text
    assert manifest['entities']['agents_workflows']['count'] == len(rows) == 5
    assert 'agents_workflows' not in manifest['not_per_workspace']
    assert manifest['agents']['registry_rows_skipped'] == 1
    assert 'agent_runs' in manifest['not_exported']
    assert 'agent_fields' in manifest['excluded']


@pytest.mark.parametrize('checks', [3, 4, 5, 7])
def test_a_hand_over_anywhere_exports_the_same_rows_once(world, checks):
    """Hand-overs after any page or row (a time budget of ``checks`` looks): every row once, the count once."""
    seed(world)
    made = _seed_agents(world)[WS]
    rows, manifest = _rows(world, checks)
    agent_pk, workflow_pk = f'WS#{WS}#AGENT#{made["agent_id"]}', f'WS#{WS}#WORKFLOW#{made["workflow_id"]}'
    assert sorted((row['pk'], row['sk'].split('#')[0]) for row in rows) == sorted([
        (agent_pk, 'META'), (agent_pk, 'LOG'), (workflow_pk, 'CURRENT'), (workflow_pk, 'REV'), (workflow_pk, 'REV')])
    assert manifest['entities']['agents_workflows']['count'] == 5
    assert manifest['agents']['registry_rows_skipped'] == 1


@pytest.mark.parametrize('cursor', [
    {'todo': ['AGENT#ag_x'], 'part': 0}, {'todo': ['PLAN#pl_0123456789ab'], 'part': 0},
    {'todo': ['AGENT#ag_0123456789ab'], 'part': 2}, {'todo': 'AGENT#ag_0123456789ab', 'part': 0},
    {'todo': [], 'part': 'x'},
], ids=['a-malformed-id', 'another-kind', 'a-part-past-the-kinds', 'not-a-list', 'a-part-not-a-number'])
def test_a_malformed_carried_cursor_fails_the_job_as_malformed(cursor):
    carried = {'run': {'generation': 1, 'phase': 'agents_workflows', 'cursor': {'reg': None, 'reg_done': False,
                                                                                 'start': None, **cursor}}}
    with pytest.raises(ValueError, match='agents'):
        handler.RunState.from_event(carried, WorkspaceScope(WS))


def test_the_fields_are_allowlists():
    assert not {'gsi1pk', 'gsi1sk', 'active_run_id', 'month_calls', 'engineering'} & set(agents.AGENT_FIELDS)
    assert 'saved_by' not in agents.REVISION_FIELDS
    assert not {'saved_by', 'created_by', 'archived_by', 'gsi1pk'} & set(agents.CURRENT_FIELDS)
    assert agents.ENTITIES == ('agents_workflows',)


def test_a_registry_entry_is_listed_by_the_ids_own_shapes():
    """The entries the export lists are built from shared/agent_ids.py: every id the store mints is listed, and an id
    the layer would refuse is not (a longer one, an upper-case one, another kind's)."""
    for _ in range(20):
        assert agents._LISTED.fullmatch(f'AGENT#{store.new_agent_id()}')
        assert agents._LISTED.fullmatch(f'WORKFLOW#{store.new_workflow_id()}')
    for refused in ('AGENT#ag_0123456789abc', 'AGENT#ag_0123456789AB', 'AGENT#wf_0123456789ab',
                    'WORKFLOW#ag_0123456789ab', 'WORKFLOW#wf_default', 'RUN#ar_0123456789ab'):
        assert agents._LISTED.fullmatch(refused) is None, refused
