"""The ``voc-agent-run`` Step Functions definition (Amazon States Language), as pure data.

``build_definition()`` is the source of truth; ``state_machine.asl.json`` beside
this file is its rendering, kept in lockstep by a test, so the CDK stack can load
it with ``sfn.DefinitionBody.fromFile(...)`` and ``definitionSubstitutions``:

- ``${ConductorFunctionArn}``   — ``agents.conductor.handler.lambda_handler``
- ``${NodesFunctionArn}``       — ``agents.nodes.handler.lambda_handler``
- ``${PersonaPanelFunctionArn}`` — ``agents.persona_panel.handler.lambda_handler``
- ``${PlanStepFunctionArn}``    — ``voc-plan-step`` (lambda/stream/src/plan-step/handler.ts)

Execution input: ``{"agent_id": "...", "run_id": "..."}`` (the agents API and the
heartbeat start one execution per run, named after the run id), or
``{"run_kind": "plan", "plan_id": "..."}`` for an approved assistant plan (named after the
plan id; docs/assistant-plan-mode.md). The ``Start`` choice sends a plan to its own branch:
``PlanDecide`` → execute (a Map of ≤ 3 steps: prepare → voc-plan-step → record) | wait | finish.
State stays small: ids plus the conductor's latest directive and the last node result.

Regenerate the JSON after editing: ``python -m agents.state_machine`` from lambda/.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ASL_PATH = Path(__file__).with_name('state_machine.asl.json')
TIMEOUT_SECONDS = 24 * 60 * 60  # brief: a run is capped at 24 h

_LAMBDA_RETRY = [{
    'ErrorEquals': [
        'Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException',
        'Lambda.TooManyRequestsException',
    ],
    'IntervalSeconds': 2, 'MaxAttempts': 4, 'BackoffRate': 2, 'JitterStrategy': 'FULL',
}]
_CATCH = [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.error', 'Next': 'RecordFailure'}]
_IDS = {'agent_id.$': '$.agent_id', 'run_id.$': '$.run_id'}
_PLAN_IDS = {'plan_id.$': '$.plan_id'}
_PLAN_CATCH = [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.error', 'Next': 'PlanRecordFailure'}]
# Inside a plan step: only a throttle is retried — that invocation never ran. Any other Lambda
# service error might have run the write, so it is recorded as the step's failure instead.
_PLAN_STEP_RETRY = [{
    'ErrorEquals': ['Lambda.TooManyRequestsException'],
    'IntervalSeconds': 2, 'MaxAttempts': 4, 'BackoffRate': 2, 'JitterStrategy': 'FULL',
}]
_STEP_ERROR = [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.error', 'Next': 'PlanStepError'}]
PLAN_MAP_CONCURRENCY = 3  # independent ready plan steps run at most three at once


def _task(function: str, payload: dict[str, Any], result_key: str, result_path: str, next_state: str | None,
          *, catch: list[dict[str, Any]] | None = _CATCH, ids: dict[str, str] = _IDS,
          retry: list[dict[str, Any]] = _LAMBDA_RETRY) -> dict[str, Any]:
    state: dict[str, Any] = {
        'Type': 'Task',
        'Resource': 'arn:aws:states:::lambda:invoke',
        'Parameters': {'FunctionName': f'${{{function}}}', 'Payload': {**ids, **payload}},
        'ResultSelector': {f'{result_key}.$': '$.Payload'},
        'ResultPath': result_path,
        'Retry': retry,
    }
    if next_state is None:
        state['End'] = True
    else:
        state['Next'] = next_state
    if catch:
        state['Catch'] = catch
    return state


def _plan_step_states() -> dict[str, Any]:
    """One ready plan step: prepare (conductor) → voc-plan-step → record (conductor)."""
    item_ids = {'plan_id.$': '$.plan_id', 'step_id.$': '$.step_id'}
    run_step = _task('PlanStepFunctionArn', {}, 'step', '$.result', 'PlanRecord', ids={},
                     catch=_STEP_ERROR, retry=_PLAN_STEP_RETRY)
    # The plan-step event is exactly what prepare built (claims included), nothing from the state.
    run_step['Parameters'] = {'FunctionName': '${PlanStepFunctionArn}', 'Payload.$': '$.prepare.prepared.event'}
    return {
        'PlanPrepare': _task('ConductorFunctionArn', {'action': 'plan_prepare'}, 'prepared', '$.prepare',
                             'PlanPrepared', ids=item_ids, catch=_STEP_ERROR),
        'PlanPrepared': {
            'Type': 'Choice',
            'Choices': [{'Variable': '$.prepare.prepared.run', 'BooleanEquals': True, 'Next': 'PlanRunStep'}],
            'Default': 'PlanStepSkipped',
        },
        'PlanRunStep': run_step,
        'PlanRecord': _task('ConductorFunctionArn', {'action': 'plan_record', 'result.$': '$.result.step'},
                            'recorded', '$.recorded', None, ids=item_ids, catch=_STEP_ERROR),
        'PlanStepError': _task('ConductorFunctionArn', {'action': 'plan_record', 'error.$': '$.error'},
                               'recorded', '$.recorded', None, ids=item_ids, catch=None),
        'PlanStepSkipped': {'Type': 'Succeed'},
    }


def _plan_states() -> dict[str, Any]:
    """The plan branch (execution input ``{run_kind: 'plan', plan_id}``)."""
    return {
        'PlanDecide': _task('ConductorFunctionArn', {'action': 'plan_decide'}, 'next', '$.plan', 'PlanRoute',
                            ids=_PLAN_IDS, catch=_PLAN_CATCH),
        'PlanRoute': {
            'Type': 'Choice',
            'Choices': [
                {'Variable': '$.plan.next.kind', 'StringEquals': 'execute', 'Next': 'PlanExecuteSteps'},
                {'Variable': '$.plan.next.kind', 'StringEquals': 'wait', 'Next': 'PlanWait'},
            ],
            'Default': 'Done',
        },
        'PlanExecuteSteps': {
            'Type': 'Map',
            'ItemsPath': '$.plan.next.steps',
            'ItemSelector': {'plan_id.$': '$.plan_id', 'step_id.$': '$$.Map.Item.Value'},
            'MaxConcurrency': PLAN_MAP_CONCURRENCY,
            'ItemProcessor': {
                'ProcessorConfig': {'Mode': 'INLINE'},
                'StartAt': 'PlanPrepare',
                'States': _plan_step_states(),
            },
            'ResultPath': None,
            'Next': 'PlanDecide',
            'Catch': _PLAN_CATCH,
        },
        'PlanWait': {'Type': 'Wait', 'SecondsPath': '$.plan.next.wait_seconds', 'Next': 'PlanDecide'},
        'PlanRecordFailure': _task('ConductorFunctionArn', {'action': 'plan_fail', 'error.$': '$.error'},
                                   'next', '$.plan', 'Failed', ids=_PLAN_IDS, catch=None),
    }


def build_definition() -> dict[str, Any]:
    return {
        'Comment': 'The conductor walks an autonomous agent workflow or an approved assistant plan (agents/conductor).',
        'TimeoutSeconds': TIMEOUT_SECONDS,
        'StartAt': 'Start',
        'States': {
            'Start': {
                'Type': 'Choice',
                'Choices': [{'And': [
                    {'Variable': '$.run_kind', 'IsPresent': True},
                    {'Variable': '$.run_kind', 'StringEquals': 'plan'},
                ], 'Next': 'PlanDecide'}],
                'Default': 'Init',
            },
            **_plan_states(),
            'Init': _task('ConductorFunctionArn', {'action': 'init'}, 'next', '$.step', 'Route'),
            'Route': {
                'Type': 'Choice',
                'Choices': [
                    {'And': [
                        {'Variable': '$.step.next.kind', 'StringEquals': 'execute'},
                        {'Variable': '$.step.next.node_type', 'StringEquals': 'persona_review'},
                    ], 'Next': 'PersonaPanel'},
                    {'Variable': '$.step.next.kind', 'StringEquals': 'execute', 'Next': 'ExecuteNode'},
                    {'Variable': '$.step.next.kind', 'StringEquals': 'wait', 'Next': 'WaitForJob'},
                ],
                'Default': 'Done',
            },
            'ExecuteNode': _task('NodesFunctionArn', {
                'action': 'start', 'node_id.$': '$.step.next.node_id', 'mate_seq.$': '$.step.next.mate_seq',
            }, 'node', '$.result', 'Advance'),
            'PersonaPanel': _task('PersonaPanelFunctionArn', {
                'action': 'start', 'node_id.$': '$.step.next.node_id', 'mate_seq.$': '$.step.next.mate_seq',
            }, 'node', '$.result', 'Advance'),
            'WaitForJob': {'Type': 'Wait', 'SecondsPath': '$.step.next.wait_seconds', 'Next': 'PollNode'},
            'PollNode': _task('NodesFunctionArn', {
                'action': 'poll', 'node_id.$': '$.step.next.node_id', 'pending.$': '$.step.next.pending',
            }, 'node', '$.result', 'Advance'),
            'Advance': _task('ConductorFunctionArn', {
                'action': 'advance', 'node.$': '$.result.node',
            }, 'next', '$.step', 'Route'),
            'RecordFailure': _task('ConductorFunctionArn', {
                'action': 'fail', 'error.$': '$.error',
            }, 'next', '$.step', 'Failed', catch=None),
            'Failed': {'Type': 'Fail', 'Error': 'AgentRunFailed', 'Cause': 'See the run event journal.'},
            'Done': {'Type': 'Succeed'},
        },
    }


def render() -> str:
    return json.dumps(build_definition(), indent=2, sort_keys=True) + '\n'


if __name__ == '__main__':  # pragma: no cover - developer utility
    ASL_PATH.write_text(render(), encoding='utf-8')
