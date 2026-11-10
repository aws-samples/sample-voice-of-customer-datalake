"""POST /projects/{id}/build-prototype — the `use_design_system` option.

Default ON: the generator read the design system on every build before the dialog offered
the choice, so a body without the field (agents, the assistant, MCP, an older SPA) keeps
that. Only an explicit `false` turns it off, and a non-boolean is a 400 before any job.
"""
import json

import pytest
from build_prototype_fixtures import build_prototype_against

PROJECT = 'proj_1'
PATH = f'/projects/{PROJECT}/build-prototype'
DOCUMENTS = {(f'PROJECT#{PROJECT}', 'PRD#prd_1'): {'document_id': 'prd_1'}}


def _build(body, api_gateway_event, lambda_context):
    response, config, _table, invoke, _create_job = build_prototype_against(
        DOCUMENTS, body, api_gateway_event, lambda_context, project_id=PROJECT, path=PATH,
    )
    return response, config, invoke


@pytest.mark.parametrize(('body', 'expected'), [
    ({}, True),
    ({'use_design_system': None}, True),
    ({'use_design_system': True}, True),
    ({'use_design_system': False}, False),
])
def test_the_choice_reaches_the_generator(body, expected, api_gateway_event, lambda_context):
    response, config, invoke = _build(body, api_gateway_event, lambda_context)
    assert response['statusCode'] == 200
    assert config is not None
    assert config['use_design_system'] is expected
    assert invoke.call_args.args[1]['doc_config']['use_design_system'] is expected


@pytest.mark.parametrize('value', ['false', 0, 1, [], {}])
def test_a_non_boolean_is_a_400_and_starts_no_job(value, api_gateway_event, lambda_context):
    response, config, invoke = _build({'use_design_system': value}, api_gateway_event, lambda_context)
    assert response['statusCode'] == 400
    assert 'use_design_system must be true or false' in json.loads(response['body'])['error']
    assert config is None
    invoke.assert_not_called()
