"""Shared flows, a flow's expansion and an automation's pause (7.52.00, api/agents_handler.py and
shared/agents_engineering_registry_routes.py).

- ``used_by``: ``GET /workflows/<id>`` and the library list name the automations that run each flow
  (``automations: [{agent_id, name, kind, connection, language}]``, as the caller may see them) and the saved flows
  that call it (``flows: [{workflow_id, name, revision}]``, the revision each pins); archived ones are left out.
- The shared-flow guard: saving a flow other automations run needs ``confirm_shared: true`` (409 ``shared_flow`` with
  ``used_by`` otherwise, nothing saved); the automation whose page the edit comes from (``agent_id``) is not "other".
- A save of an engineering flow simulates its calls' expansion (400 for one that cannot be expanded), and
  ``GET /workflows/<id>/expanded`` previews the flat flow a run would follow.
- ``POST /agents/<id>/pause`` and ``…/resume``: an automation that is on, held; each change with its history row;
  turning it off ends its pause.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import USER, create, create_workflow
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from boto3.dynamodb.conditions import Key

from shared import agents_store as store
from shared.test.agents_fixtures import AgentsEnv
from shared.test.test_workflow_engineering import arrow, bug_fix, flow, node


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[AgentsEnv]:
    with _api() as agents:
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', 'test-engineering')
        yield agents


def _save(lambda_context: Any, workflow: dict, **body: Any) -> tuple[int, dict]:
    definition = _call(lambda_context, 'GET', f'/workflows/{workflow["workflow_id"]}')[1]['workflow']['definition']
    return _call(lambda_context, 'PUT', f'/workflows/{workflow["workflow_id"]}',
                 body={'definition': {**definition, 'description': 'Edited.'}, 'expected_revision': 1, **body})


def _log(env: AgentsEnv, agent_id: str) -> list[dict[str, Any]]:
    found = env.agents.query(KeyConditionExpression=Key('pk').eq(f'AGENT#{agent_id}') & Key('sk').begins_with('LOG#'))
    return sorted(found['Items'], key=lambda row: row['sk'])


@pytest.mark.usefixtures('env')
def test_a_flow_names_the_automations_that_run_it(lambda_context: Any) -> None:
    workflow = create_workflow(lambda_context)
    second = create(lambda_context, name='Billing crew', workflow_id=workflow['workflow_id'])
    first = create(lambda_context, name='Alerts crew', workflow_id=workflow['workflow_id'])
    archived = create(lambda_context, name='Old crew', workflow_id=workflow['workflow_id'])
    assert _call(lambda_context, 'DELETE', f'/agents/{archived["agent_id"]}')[0] == 200
    used_by = {'automations': [_user(first, 'Alerts crew'), _user(second, 'Billing crew')], 'flows': []}
    assert _call(lambda_context, 'GET', f'/workflows/{workflow["workflow_id"]}')[1]['workflow']['used_by'] == used_by
    library = {item['workflow_id']: item['used_by'] for item in _call(lambda_context, 'GET', '/workflows')[1]['items']}
    assert library == {'wf_default': NOBODY, workflow['workflow_id']: used_by}
    # (a signed-in person reads them as they read the agents: here every category, so the same list)
    assert _call(lambda_context, 'GET', f'/workflows/{workflow["workflow_id"]}', claims=USER)[1]['workflow'][
        'used_by'] == used_by


NOBODY: dict[str, list[Any]] = {'automations': [], 'flows': []}


def _user(agent: dict, name: str) -> dict[str, Any]:
    return {'agent_id': agent['agent_id'], 'name': name, 'kind': 'agents', 'connection': None, 'language': None}


@pytest.mark.usefixtures('env')
def test_a_flow_names_the_flows_that_call_it_with_the_revision_each_pins(lambda_context: Any) -> None:
    status, called = _create(lambda_context, _two_agents())
    assert status == 201
    called_id = called['workflow']['workflow_id']
    caller = _create(lambda_context, _calls(f'{called_id}@1'))[1]['workflow']
    status, read = _call(lambda_context, 'GET', f'/workflows/{called_id}')
    assert (status, read['workflow']['used_by']) == (200, {'automations': [], 'flows': [
        {'workflow_id': caller['workflow_id'], 'name': 'Calls it', 'revision': 1}]})
    # (a caller pins a revision: a save of the called flow changes none of them, so it needs no confirmation)
    definition = read['workflow']['definition']
    status, saved = _call(lambda_context, 'PUT', f'/workflows/{called_id}',
                          body={'definition': {**definition, 'description': 'Edited.'}, 'expected_revision': 1})
    assert (status, saved['workflow']['used_by']['flows'][0]['revision']) == (200, 1)


@pytest.mark.usefixtures('env')
def test_saving_a_flow_other_automations_run_needs_a_confirmation(lambda_context: Any) -> None:
    workflow = create_workflow(lambda_context)
    agent = create(lambda_context, name='Alerts crew', workflow_id=workflow['workflow_id'])
    used_by = {'automations': [_user(agent, 'Alerts crew')], 'flows': []}
    status, refused = _save(lambda_context, workflow)
    assert (status, refused['code'], refused['used_by']) == (409, 'shared_flow', used_by)
    assert _call(lambda_context, 'GET', f'/workflows/{workflow["workflow_id"]}')[1]['workflow']['revision'] == 1
    # (from that automation's own page, it is no other automation's)
    status, saved = _save(lambda_context, workflow, agent_id=agent['agent_id'])
    assert (status, saved['workflow']['revision'], saved['workflow']['used_by']) == (200, 2, used_by)
    other = create(lambda_context, name='Billing crew', workflow_id=workflow['workflow_id'])
    definition = saved['workflow']['definition']
    body = {'definition': definition, 'expected_revision': 2, 'agent_id': agent['agent_id']}
    status, refused = _call(lambda_context, 'PUT', f'/workflows/{workflow["workflow_id"]}', body=body)
    assert (status, [user['agent_id'] for user in refused['used_by']['automations']]) == (
        409, [agent['agent_id'], other['agent_id']])
    status, saved = _call(lambda_context, 'PUT', f'/workflows/{workflow["workflow_id"]}',
                          body={**body, 'confirm_shared': True})
    assert (status, saved['workflow']['revision']) == (200, 3)
    for bad in ({'confirm_shared': 'yes'}, {'agent_id': 'not-an-agent'}):
        assert _save(lambda_context, workflow, **bad)[0] == 400
    # (a flow nobody runs saves as before; a rename changes no step, so it needs no confirmation)
    lone = create_workflow(lambda_context, name='Lone flow')
    assert _save(lambda_context, lone)[0] == 200
    assert _call(lambda_context, 'POST', f'/workflows/{workflow["workflow_id"]}/rename', body={'name': 'Renamed'})[0] \
        == 200


def _create(lambda_context: Any, definition: dict[str, Any]) -> tuple[int, dict]:
    return _call(lambda_context, 'POST', '/workflows', body={'definition': definition})


def _two_agents() -> dict[str, Any]:
    return flow([node('start', 'start'), node('hunt', 'agent', role='hunter', budget_share=0.5),
                 node('fix', 'agent', role='fixer', budget_share=0.5), node('done', 'end')],
                [arrow('start', 'hunt'), arrow('hunt', 'fix'), arrow('fix', 'done')], name='Find and fix')


def _calls(ref: str) -> dict[str, Any]:
    return flow([node('start', 'start'), node('find', 'call_flow', flow=ref, budget_share=0.4),
                 node('build', 'agent', role='builder'), node('end', 'end')],
                [arrow('start', 'find'), arrow('find', 'build'), arrow('build', 'end')], name='Calls it')


@pytest.mark.usefixtures('env')
def test_a_save_simulates_the_calls_and_the_preview_shows_the_flat_flow(lambda_context: Any) -> None:
    status, called = _create(lambda_context, _two_agents())
    assert status == 201
    ref = f'{called["workflow"]["workflow_id"]}@1'
    status, refused = _create(lambda_context, _calls(f'{called["workflow"]["workflow_id"]}@2'))
    assert (status, refused['errors'][0]['node_id']) == (400, 'find')
    assert 'not a saved revision' in refused['errors'][0]['message']
    status, body = _call(lambda_context, 'POST', '/workflows/validate', body={'definition': _calls('wf_0123456789ab@1')})
    assert (status, body['valid'], body['errors'][0]['node_id']) == (200, False, 'find')
    dotted = flow([node('start', 'start'), node('a.b', 'agent', role='hunter'), node('end', 'end')],
                  [arrow('start', 'a.b'), arrow('a.b', 'end')])
    assert _create(lambda_context, dotted)[0] == 400
    status, caller = _create(lambda_context, _calls(ref))
    assert status == 201
    status, preview = _call(lambda_context, 'GET', f'/workflows/{caller["workflow"]["workflow_id"]}/expanded')
    assert status == 200
    assert [step['id'] for step in preview['definition']['nodes']] == ['start', 'find.hunt', 'find.fix', 'build', 'end']
    assert (preview['revision'], preview['calls'], preview['steps']) == (1, 1, 5)
    assert preview['expansion'] == [{'step': 'find', 'flow': called['workflow']['workflow_id'], 'revision': 1}]
    assert [step['data']['params'].get('budget_share') for step in preview['definition']['nodes'][1:3]] == [0.2, 0.2]
    workflow_id = caller['workflow']['workflow_id']
    assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}/expanded', query={'revision': '9'})[0] == 404
    assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}/expanded', query={'revision': 'x'})[0] == 400
    assert _call(lambda_context, 'GET', f'/workflows/{workflow_id}/expanded', claims=USER)[0] == 403
    agents_flow = create_workflow(lambda_context)
    assert _call(lambda_context, 'GET', f'/workflows/{agents_flow["workflow_id"]}/expanded')[0] == 400
    assert _call(lambda_context, 'GET', '/workflows/wf_0123456789ab/expanded')[0] == 404


@pytest.mark.usefixtures('env')
def test_a_preview_of_a_call_that_cannot_be_expanded_says_why(lambda_context: Any, env: AgentsEnv) -> None:
    status, called = _create(lambda_context, bug_fix())
    assert status == 201
    # (a call to a flow that ends at a pull request, not its flow's last step: written past the save's simulation)
    stored = store.create_workflow(env.agents, _calls(f'{called["workflow"]["workflow_id"]}@1'),
                                   created_by='admin-sub', username='alice', now=store.utc_now())
    status, body = _call(lambda_context, 'GET', f'/workflows/{stored["workflow_id"]}/expanded')
    assert (status, body['node_id']) == (409, 'find')
    assert 'ends at a pull request' in body['error']


def test_an_automation_that_is_on_is_paused_and_resumed_with_its_history(lambda_context: Any, env: AgentsEnv) -> None:
    agent = create(lambda_context, enabled=True)
    path = f'/agents/{agent["agent_id"]}'
    status, paused = _call(lambda_context, 'POST', f'{path}/pause')
    assert (status, paused['agent']['paused'], paused['agent']['paused_by']) == (200, True, 'alice')
    assert paused['agent']['paused_at'] is not None
    assert paused['agent']['enabled'] is True
    # (pausing a paused automation answers it as it is, and writes nothing)
    assert _call(lambda_context, 'POST', f'{path}/pause')[1]['agent']['paused_at'] == paused['agent']['paused_at']
    assert _call(lambda_context, 'GET', path)[1]['agent']['paused'] is True
    status, resumed = _call(lambda_context, 'POST', f'{path}/resume')
    assert (status, resumed['agent']['paused'], resumed['agent']['paused_at']) == (200, False, None)
    assert _call(lambda_context, 'POST', f'{path}/resume')[0] == 200
    assert [(row['event'], row['username'], row['via']) for row in _log(env, agent['agent_id'])] == [
        ('paused', 'alice', 'route'), ('resumed', 'alice', 'route')]


def test_only_an_automation_that_is_on_is_paused_and_turning_it_off_ends_the_pause(lambda_context: Any,
                                                                                  env: AgentsEnv) -> None:
    off = create(lambda_context, enabled=False)
    assert _call(lambda_context, 'POST', f'/agents/{off["agent_id"]}/pause')[0] == 409
    agent = create(lambda_context, enabled=True)
    path = f'/agents/{agent["agent_id"]}'
    assert _call(lambda_context, 'POST', f'{path}/pause')[0] == 200
    status, disabled = _call(lambda_context, 'POST', f'{path}/disable')
    assert (status, disabled['agent']['enabled'], disabled['agent']['paused']) == (200, False, False)
    assert [(row['event'], row['via']) for row in _log(env, agent['agent_id'])] == [
        ('paused', 'route'), ('resumed', 'disabled')]
    assert _call(lambda_context, 'POST', f'{path}/enable')[1]['agent']['paused'] is False
    assert _call(lambda_context, 'POST', f'{path}/pause')[0] == 200
    status, updated = _call(lambda_context, 'PUT', path, body={'enabled': False})
    assert (status, updated['agent']['paused']) == (200, False)


@pytest.mark.usefixtures('env')
def test_pause_and_resume_are_an_administrators_and_need_an_agent(lambda_context: Any) -> None:
    agent = create(lambda_context, enabled=True)
    for action in ('pause', 'resume'):
        assert _call(lambda_context, 'POST', f'/agents/{agent["agent_id"]}/{action}', claims=USER)[0] == 403
        assert _call(lambda_context, 'POST', f'/agents/ag_0123456789ab/{action}')[0] == 404
        assert _call(lambda_context, 'POST', f'/agents/not-an-agent/{action}')[0] == 404
