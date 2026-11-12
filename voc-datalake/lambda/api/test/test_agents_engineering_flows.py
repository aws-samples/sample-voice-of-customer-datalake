"""Engineering flows (voc-workflow/2) in the workflow library: saved and validated like any workflow, but never run by
an agent (the agents' interpreter runs voc-workflow/1), and a workflow never changes kind."""
from __future__ import annotations

from typing import Any

from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create

from shared import workflow_schema
from shared.test.agents_fixtures import agent_body
from shared.test.test_workflow_engineering import bug_fix


def _save_engineering_flow(lambda_context: Any) -> str:
    status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': bug_fix()})
    assert status == 201, body
    return body['workflow']['workflow_id']


def test_an_engineering_flow_is_validated_and_kept_in_the_library(lambda_context: Any) -> None:
    with _api():
        status, body = _call(lambda_context, 'POST', '/workflows/validate', body={'definition': bug_fix()})
        assert (status, body['valid'], body['warnings']) == (200, True, [])   # the agents' methodology is not its own
        workflow_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'GET', f'/workflows/{workflow_id}')
        assert (status, body['workflow']['definition']['schema']) == (200, workflow_schema.SCHEMA_V2)
        # Not in the library (nor its agent picker) until the editor opens engineering flows.
        listed = [w['workflow_id'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']]
        assert workflow_id not in listed


def test_an_agent_cannot_run_an_engineering_flow(lambda_context: Any) -> None:
    with _api():
        workflow_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=workflow_id))
        assert status == 400
        assert 'an engineering flow is not run by an agent' in body['error']
        agent = _create(lambda_context)
        status, body = _call(lambda_context, 'PUT', f"/agents/{agent['agent_id']}",
                             body=agent_body(workflow_id=workflow_id))
        assert status == 400


def test_an_agents_workflow_whose_step_settings_name_the_other_schema_is_still_an_agents_workflow(
        lambda_context: Any) -> None:
    definition = workflow_schema.default_template()
    definition['nodes'][1]['data']['params'] = {'schema': workflow_schema.SCHEMA_V2}
    with _api():
        status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': definition})
        assert status == 201, body
        workflow_id = body['workflow']['workflow_id']
        listed = [w['workflow_id'] for w in _call(lambda_context, 'GET', '/workflows')[1]['items']]
        assert workflow_id in listed
        assert _call(lambda_context, 'POST', '/agents', body=agent_body(workflow_id=workflow_id))[0] == 201


def test_a_workflow_keeps_its_kind(lambda_context: Any) -> None:
    with _api():
        engineering_id = _save_engineering_flow(lambda_context)
        status, body = _call(lambda_context, 'PUT', f'/workflows/{engineering_id}',
                             body={'definition': workflow_schema.default_template(), 'expected_revision': 1})
        assert (status, 'a workflow keeps its kind' in body['error']) == (400, True)
        status, body = _call(lambda_context, 'POST', '/workflows',
                             body={'definition': workflow_schema.default_template()})
        assert status == 201, body
        agents_id = body['workflow']['workflow_id']
        status, body = _call(lambda_context, 'PUT', f'/workflows/{agents_id}',
                             body={'definition': bug_fix(), 'expected_revision': 1})
        assert status == 400
        status, body = _call(lambda_context, 'POST', '/workflows/validate',
                             body={'definition': bug_fix(), 'workflow_id': agents_id})
        assert (status, body['valid'], 'a workflow keeps its kind' in body['errors'][0]['message']) == (200, False, True)
        renamed = {**bug_fix(), 'name': 'Renamed flow'}
        assert _call(lambda_context, 'PUT', f'/workflows/{engineering_id}',
                     body={'definition': renamed, 'expected_revision': 1})[0] == 200
