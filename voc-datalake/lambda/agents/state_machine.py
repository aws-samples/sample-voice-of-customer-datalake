"""The ``voc-agent-run`` Step Functions definition (Amazon States Language), as pure data.

``build_definition()`` is the source of truth; ``state_machine.asl.json`` beside
this file is its rendering, kept in lockstep by a test, so the CDK stack can load
it with ``sfn.DefinitionBody.fromFile(...)`` and ``definitionSubstitutions``:

- ``${ConductorFunctionArn}``   — ``agents.conductor.handler.lambda_handler``
- ``${NodesFunctionArn}``       — ``agents.nodes.handler.lambda_handler``
- ``${PersonaPanelFunctionArn}`` — ``agents.persona_panel.handler.lambda_handler``

Execution input: ``{"agent_id": "...", "run_id": "..."}`` (the agents API and the
heartbeat start one execution per run, named after the run id). State stays
small: ids plus the conductor's latest directive and the last node result.

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


def _task(function: str, payload: dict[str, Any], result_key: str, result_path: str, next_state: str,
          *, catch: bool = True) -> dict[str, Any]:
    state: dict[str, Any] = {
        'Type': 'Task',
        'Resource': 'arn:aws:states:::lambda:invoke',
        'Parameters': {'FunctionName': f'${{{function}}}', 'Payload': {**_IDS, **payload}},
        'ResultSelector': {f'{result_key}.$': '$.Payload'},
        'ResultPath': result_path,
        'Retry': _LAMBDA_RETRY,
        'Next': next_state,
    }
    if catch:
        state['Catch'] = _CATCH
    return state


def build_definition() -> dict[str, Any]:
    return {
        'Comment': 'The conductor walks an autonomous agent workflow (agents/conductor).',
        'TimeoutSeconds': TIMEOUT_SECONDS,
        'StartAt': 'Init',
        'States': {
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
            }, 'next', '$.step', 'Failed', catch=False),
            'Failed': {'Type': 'Fail', 'Error': 'AgentRunFailed', 'Cause': 'See the run event journal.'},
            'Done': {'Type': 'Succeed'},
        },
    }


def render() -> str:
    return json.dumps(build_definition(), indent=2, sort_keys=True) + '\n'


if __name__ == '__main__':  # pragma: no cover - developer utility
    ASL_PATH.write_text(render(), encoding='utf-8')
