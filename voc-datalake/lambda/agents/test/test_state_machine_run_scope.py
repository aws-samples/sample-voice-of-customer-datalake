"""voc-agent-run carries the run's workspace to every state's Lambda, and the run's Lambdas refuse one (7.29.00).

The definition's first states set ``$.run_scope`` from the input's optional ``workspace_id`` (``{}`` when it names none:
every run and plan today, whose input is unchanged), and every Lambda payload keeps its paths and adds
``run_scope``. The agent rows stay the deployment's, so the conductor and the node and persona-panel steps refuse a
state that names a workspace before anything is read (shared/project_keys.py ``AGENT_RUNS_STORE``), but for the two
failure recorders, which mark the run's or the plan's own row failed when it is of the run's scope.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import runtime, state_machine
from agents.conductor import handler as conductor
from shared.project_keys import NotPerWorkspaceError
from shared.ws_repo import RUN_SCOPE_FIELD, WORKSPACE_FIELD

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
RUN_SCOPE = {'run_scope.$': '$.run_scope'}


def _states() -> dict[str, Any]:
    return state_machine.build_definition()['States']


def _lambda_payloads(states: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every Task's Payload, the Map's inner states included (but the plan step's, which prepare builds)."""
    found: dict[str, dict[str, Any]] = {}
    for name, state in states.items():
        if state['Type'] == 'Map':
            found.update(_lambda_payloads(state['ItemProcessor']['States']))
            found[f'{name}.ItemSelector'] = state['ItemSelector']
        elif state['Type'] == 'Task' and 'Payload' in state['Parameters']:
            found[name] = state['Parameters']['Payload']
    return found


def test_the_run_starts_by_setting_its_scope():
    definition = state_machine.build_definition()
    states = definition['States']
    assert definition['StartAt'] == 'RunScope'
    assert states['RunScope'] == {
        'Type': 'Choice',
        'Choices': [{'Variable': '$.workspace_id', 'IsPresent': True, 'Next': 'RunScopeWorkspace'}],
        'Default': 'RunScopeDeployment',
    }
    assert states['RunScopeWorkspace'] == {'Type': 'Pass', 'Parameters': {'workspace_id.$': '$.workspace_id'},
                                           'ResultPath': '$.run_scope', 'Next': 'Start'}
    assert states['RunScopeDeployment'] == {'Type': 'Pass', 'Result': {}, 'ResultPath': '$.run_scope',
                                            'Next': 'Start'}


def test_every_lambda_payload_adds_the_run_scope_to_its_ids():
    payloads = _lambda_payloads(_states())
    agent_ids = {'agent_id.$': '$.agent_id', 'run_id.$': '$.run_id', **RUN_SCOPE}
    plan_ids = {'plan_id.$': '$.plan_id', **RUN_SCOPE}
    step_ids = {**plan_ids, 'step_id.$': '$.step_id'}
    assert payloads == {
        'Init': {'action': 'init', **agent_ids},
        'ExecuteNode': {'action': 'start', **agent_ids, 'node_id.$': '$.step.next.node_id',
                        'mate_seq.$': '$.step.next.mate_seq'},
        'PersonaPanel': {'action': 'start', **agent_ids, 'node_id.$': '$.step.next.node_id',
                         'mate_seq.$': '$.step.next.mate_seq'},
        'PollNode': {'action': 'poll', **agent_ids, 'node_id.$': '$.step.next.node_id',
                     'pending.$': '$.step.next.pending'},
        'Advance': {'action': 'advance', **agent_ids, 'node.$': '$.result.node'},
        'RecordFailure': {'action': 'fail', **agent_ids, 'error.$': '$.error'},
        'PlanDecide': {'action': 'plan_decide', **plan_ids},
        'PlanRecordFailure': {'action': 'plan_fail', **plan_ids, 'error.$': '$.error'},
        'PlanExecuteSteps.ItemSelector': {'plan_id.$': '$.plan_id', 'step_id.$': '$$.Map.Item.Value', **RUN_SCOPE},
        'PlanPrepare': {'action': 'plan_prepare', **step_ids},
        'PlanRecord': {'action': 'plan_record', **step_ids, 'result.$': '$.result.step'},
        'PlanStepError': {'action': 'plan_record', **step_ids, 'error.$': '$.error'},
    }


def test_the_plan_step_event_is_still_exactly_what_prepare_built():
    run_step = _states()['PlanExecuteSteps']['ItemProcessor']['States']['PlanRunStep']
    assert run_step['Parameters'] == {'FunctionName': '${PlanStepFunctionArn}',
                                      'Payload.$': '$.prepare.prepared.event'}


REFUSED_ACTIONS = ['init', 'advance', 'plan_decide', 'plan_prepare', 'plan_record']
RECORDERS = [('_ACTIONS', 'fail'), ('_PLAN_ACTIONS', 'plan_fail')]
RECORDED = {'kind': 'finish', 'status': 'failed', 'recorded': True}


def _event(action: str, run_scope: object) -> dict[str, Any]:
    return {'action': action, 'agent_id': 'agt_1', 'run_id': 'run_1', 'plan_id': 'plan_1', 'step_id': 's1',
            'error': {'Error': 'NotPerWorkspaceError'}, RUN_SCOPE_FIELD: run_scope}


@pytest.mark.parametrize('run_scope', [{WORKSPACE_FIELD: WS}, {WORKSPACE_FIELD: 'nope'}])
@pytest.mark.parametrize('action', REFUSED_ACTIONS)
def test_the_conductor_refuses_a_workspace_or_malformed_scope_before_any_read(action, run_scope):
    """Every collaborator that could read or write is a mock: none is touched, whatever the action."""
    store, decide, execution, plans = MagicMock(), MagicMock(), MagicMock(), MagicMock()
    with patch.object(conductor, 'store', store), patch.object(conductor, 'plan_decide', decide), \
            patch.object(conductor, 'plan_execution', execution), patch.object(conductor, 'ps', plans), \
            pytest.raises((NotPerWorkspaceError, ValueError), match='workspace'):
        conductor.handle(_event(action, run_scope))
    assert (store.mock_calls, decide.mock_calls, execution.mock_calls, plans.mock_calls) == ([], [], [], [])


def test_the_refusal_names_the_agent_runs_store():
    with patch.object(conductor, 'store', MagicMock()), \
            pytest.raises(NotPerWorkspaceError, match=r'^Agent runs is not per workspace yet$'):
        conductor.handle(_event('init', {WORKSPACE_FIELD: WS}))


def _record(table: str, action: str, run_scope: object, row_workspace: str | None) -> tuple[dict, MagicMock]:
    recorder = MagicMock(return_value=RECORDED)
    row = {} if row_workspace is None else {WORKSPACE_FIELD: row_workspace}
    with patch.dict(getattr(conductor, table), {action: recorder}), \
            patch.object(conductor.store, 'get_agent', return_value=row), \
            patch.object(conductor.ps, 'get_meta', return_value=row), \
            patch.object(conductor.plan_state, 'table'):
        directive = conductor.handle(_event(action, run_scope))
    return directive, recorder


@pytest.mark.parametrize(('table', 'action'), RECORDERS)
def test_a_failure_in_the_rows_own_workspace_is_recorded(table, action):
    directive, recorder = _record(table, action, {WORKSPACE_FIELD: WS}, WS)
    assert directive == RECORDED
    recorder.assert_called_once()


@pytest.mark.parametrize('row_workspace', [None, OTHER_WS])
@pytest.mark.parametrize(('table', 'action'), RECORDERS)
def test_a_failure_of_another_scope_is_logged_only(table, action, row_workspace):
    """An agent's row names no workspace today, so an agent run's failure in a workspace is never written."""
    directive, recorder = _record(table, action, {WORKSPACE_FIELD: WS}, row_workspace)
    assert directive == {'kind': 'finish', 'status': 'failed'}
    recorder.assert_not_called()


@pytest.mark.parametrize(('table', 'action'), RECORDERS)
def test_a_deployment_runs_failure_is_recorded_as_before(table, action):
    directive, recorder = _record(table, action, {}, None)
    assert directive == RECORDED
    recorder.assert_called_once()


@pytest.mark.parametrize('run_scope', [{WORKSPACE_FIELD: 'nope'}, None, [WS]])
@pytest.mark.parametrize(('table', 'action'), RECORDERS)
def test_a_malformed_scope_records_nothing(table, action, run_scope):
    """No scope to compare, so no row is written on a guess: the execution ends at Failed, and an agent run left
    running is failed by the heartbeat's stale-run rule (a plan's input never names a workspace)."""
    directive, recorder = _record(table, action, run_scope, None)
    assert directive == {'kind': 'finish', 'status': 'failed'}
    recorder.assert_not_called()


@pytest.mark.parametrize('run_scope', [{WORKSPACE_FIELD: WS}, {WORKSPACE_FIELD: 'nope'}])
def test_a_node_step_refuses_a_workspace_or_malformed_scope_before_any_read(run_scope):
    store = MagicMock()
    with patch.object(runtime, 'store', store), \
            pytest.raises((NotPerWorkspaceError, ValueError), match='workspace'):
        runtime.build_context({'agent_id': 'agt_1', 'run_id': 'run_1', 'node_id': 'n1', RUN_SCOPE_FIELD: run_scope})
    assert store.mock_calls == []
