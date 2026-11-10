"""Decision routes on the projects Lambda: create, edit, Pursue → PR/FAQ, generic-edit refusal."""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

from projects_handler import lambda_handler
from shared.exceptions import ValidationError

DECISION = {'pk': 'PROJECT#proj-123', 'sk': 'DOC#doc_1', 'document_id': 'doc_1', 'document_type': 'decision',
            'title': 'Offline mode', 'decision': {'verdict': 'pursue', 'rationale': 'Why',
                                                  'evidence': {'document_ids': [], 'feedback_ids': []}}}


def _call(api_gateway_event, lambda_context, method, path, body=None):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method=method,
                      path=f'/projects/proj-123{path}', path_params={'project_id': 'proj-123'}, body=body or {})


@pytest.mark.usefixtures('existing_project')
class TestDecisionRoutes:
    def test_create_passes_the_caller_and_body(self, api_gateway_event, lambda_context):
        with patch('shared.decision_records.create_decision', return_value={'success': True}) as create:
            response, _ = _call(api_gateway_event, lambda_context, 'POST', '/decisions', {'title': 'T'})
        assert response['statusCode'] == 200
        assert create.call_args.args[2] == {'title': 'T'}

    def test_update_targets_the_document(self, api_gateway_event, lambda_context):
        with patch('shared.decision_records.update_decision', return_value={'success': True}) as update:
            response, _ = _call(api_gateway_event, lambda_context, 'PUT', '/decisions/doc_1', {'rationale': 'x'})
        assert response['statusCode'] == 200
        assert update.call_args.args[2] == 'doc_1'

    def test_pursue_starts_a_prfaq_job_with_the_decision_as_reference(self, api_gateway_event, lambda_context):
        with patch('shared.decision_records.stored_decision', return_value=DECISION), \
                patch('shared.decision_records.record_seeded_prfaq') as record, \
                patch('projects_handler.create_job', return_value=('job-1', {})) as create_job, \
                patch('projects_handler.invoke_lambda_async'):
            response, body = _call(api_gateway_event, lambda_context, 'POST', '/decisions/doc_1/pursue')
        assert (response['statusCode'], body['job_id']) == (202, 'job-1')
        config = create_job.call_args.args[3]
        assert config['selected_document_ids'][0] == 'doc_1'
        assert record.call_args.args[2] == 'job-1'

    def test_pursue_of_a_parked_decision_is_a_400_and_starts_nothing(self, api_gateway_event, lambda_context):
        parked = {**DECISION, 'decision': {**DECISION['decision'], 'verdict': 'park'}}
        with patch('shared.decision_records.stored_decision', return_value=parked), \
                patch('projects_handler.create_job') as create_job:
            response, _ = _call(api_gateway_event, lambda_context, 'POST', '/decisions/doc_1/pursue')
        assert response['statusCode'] == 400
        create_job.assert_not_called()


def test_the_generic_document_edit_refuses_a_decision():
    import projects

    with patch('projects._source_document_item', return_value=DECISION), \
            patch('projects.projects_table'), pytest.raises(ValidationError, match='decisions'):
        projects.update_document('proj-123', 'doc_1', {'content': 'x'})


def test_restoring_a_decision_version_is_refused():
    import projects

    with patch('projects._source_document_item', return_value=DECISION), \
            patch('projects.projects_table'), pytest.raises(ValidationError, match='decisions'):
        projects.restore_document('proj-123', 'doc_1', 'r1', {})
