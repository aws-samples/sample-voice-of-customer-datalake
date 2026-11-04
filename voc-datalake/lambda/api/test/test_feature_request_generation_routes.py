"""Board requests as evidence on the Projects API: the generation routes validate and carry
``include_feature_requests`` / ``data_sources.feature_requests`` and ``feature_request_board_ids``
into the job input, and ``feedback-preview`` answers ``feature_requests_matched`` when asked."""
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared.category_access import CategoryScope
from shared.feature_request_evidence import FeatureRequestEvidence

SCOPE = CategoryScope(all=True, categories=frozenset())
BOARDS = ['brd_0000000a', 'brd_sales']


def _call(api_gateway_event, lambda_context, path: str, body: dict[str, Any]) -> tuple[int, Any, dict]:
    from projects_handler import lambda_handler
    event = api_gateway_event(method='POST', path=path, path_params={'project_id': 'p1'}, body=body)
    sfn = MagicMock()
    with patch('projects_handler.category_gate.scope_for_event', return_value=SCOPE), \
            patch('projects_handler._require_project_exists'), \
            patch('projects_handler.ensure_persona_feedback'), \
            patch('projects_handler.ensure_research_feedback'), \
            patch('projects_handler.create_job', return_value=('job-1', {})) as create_job, \
            patch('projects_handler.invoke_lambda_async') as invoke_async, \
            patch('projects_handler.boto3.client', return_value=sfn), \
            patch.dict('os.environ', {'RESEARCH_STATE_MACHINE_ARN': 'arn:sm:research',
                                      'DOCUMENT_STATE_MACHINE_ARN': ''}):
        response = lambda_handler(event, lambda_context)
    calls = {'create_job': create_job, 'invoke_async': invoke_async, 'sfn': sfn}
    return response['statusCode'], json.loads(response['body']), calls


def _config(calls: dict) -> dict:
    return calls['create_job'].call_args.args[3]


def test_persona_generation_carries_the_flag_and_boards(api_gateway_event, lambda_context):
    status, _body, calls = _call(api_gateway_event, lambda_context, '/projects/p1/personas/generate', {
        'persona_count': 2, 'include_feature_requests': True, 'feature_request_board_ids': [*BOARDS, BOARDS[0]],
    })
    assert status == 200
    filters = calls['invoke_async'].call_args.args[1]['filters']
    assert (filters['include_feature_requests'], filters['feature_request_board_ids']) == (True, BOARDS)


def test_persona_generation_defaults_to_no_feature_requests(api_gateway_event, lambda_context):
    status, _body, calls = _call(api_gateway_event, lambda_context, '/projects/p1/personas/generate', {})
    assert status == 200
    filters = calls['invoke_async'].call_args.args[1]['filters']
    assert (filters['include_feature_requests'], filters['feature_request_board_ids']) == (False, None)


def test_research_carries_the_flag_into_the_execution_input(api_gateway_event, lambda_context):
    status, _body, calls = _call(api_gateway_event, lambda_context, '/projects/p1/research', {
        'include_feature_requests': True, 'feature_request_board_ids': ['brd_sales'],
    })
    assert status == 200
    execution = json.loads(calls['sfn'].start_execution.call_args.kwargs['input'])
    config = execution['research_config']
    assert (config['include_feature_requests'], config['feature_request_board_ids']) == (True, ['brd_sales'])


def test_a_document_normalises_its_data_sources_flag(api_gateway_event, lambda_context):
    status, _body, calls = _call(api_gateway_event, lambda_context, '/projects/p1/document', {
        'doc_type': 'prd', 'data_sources': {'feedback': True, 'feature_requests': True},
        'feature_request_board_ids': ['brd_0000000a'],
    })
    assert status == 200
    config = _config(calls)
    assert config['data_sources'] == {'feedback': True, 'feature_requests': True}
    assert config['feature_request_board_ids'] == ['brd_0000000a']
    status, _body, calls = _call(api_gateway_event, lambda_context, '/projects/p1/document', {'doc_type': 'prd'})
    assert _config(calls)['data_sources'] == {'feature_requests': False}


@pytest.mark.parametrize(('path', 'body'), [
    ('/projects/p1/personas/generate', {'include_feature_requests': 'true'}),
    ('/projects/p1/personas/generate', {'feature_request_board_ids': 'brd_sales'}),
    ('/projects/p1/personas/generate', {'feature_request_board_ids': ['brd_../x']}),
    ('/projects/p1/research', {'feature_request_board_ids': [f'brd_{n:08x}' for n in range(21)]}),
    ('/projects/p1/document', {'data_sources': {'feature_requests': 1}}),
    ('/projects/p1/document', {'data_sources': ['feedback']}),
    ('/projects/p1/document', {'feature_request_board_ids': [7]}),
])
def test_bad_feature_request_fields_are_400_before_any_job(api_gateway_event, lambda_context, path, body):
    status, _body, calls = _call(api_gateway_event, lambda_context, path, body)
    assert status == 400
    calls['create_job'].assert_not_called()


def _preview(api_gateway_event, lambda_context, body: dict[str, Any], evidence: FeatureRequestEvidence):
    from projects_handler import lambda_handler
    event = api_gateway_event(method='POST', path='/projects/p1/feedback-preview',
                              path_params={'project_id': 'p1'}, body=body)
    answer = {'matched': 4, 'matched_is_lower_bound': False, 'estimated': True}
    with patch('projects_handler.category_gate.scope_for_event', return_value=SCOPE), \
            patch('projects.persona_context_budget', return_value=(100_000, 145)), \
            patch('projects.persona_feedback_preview.preview_feedback', return_value=answer), \
            patch('shared.feature_request_context.load_feature_request_evidence', return_value=evidence) as load:
        response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body']), load


def test_the_preview_counts_feature_requests_only_when_asked(api_gateway_event, lambda_context):
    evidence = FeatureRequestEvidence([], 9, True)
    status, body, load = _preview(api_gateway_event, lambda_context, {
        'mode': 'estimate', 'days': 14, 'include_feature_requests': True, 'feature_request_board_ids': ['brd_sales'],
    }, evidence)
    assert (status, body['matched'], body['feature_requests_matched']) == (200, 4, 9)
    assert load.call_args.kwargs == {'board_ids': ['brd_sales'], 'days': 14, 'limit': 0}
    status, body, load = _preview(api_gateway_event, lambda_context, {'mode': 'estimate'}, evidence)
    assert (status, 'feature_requests_matched' in body) == (200, False)
    load.assert_not_called()
