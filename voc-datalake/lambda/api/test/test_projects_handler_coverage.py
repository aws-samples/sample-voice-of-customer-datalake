"""
Additional tests for projects_handler.py to reach 100% coverage.
Covers: autoseed, import persona, generate personas, research,
generate document, merge documents, job CRUD, prioritization CRUD,
persona notes, regenerate avatar, lambda handler error path.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestAutoseedEndpoint:

    @patch('projects_handler.autoseed_project')
    def test_autoseed_no_filters(self, mock_autoseed, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_autoseed.return_value = {'project': {'name': 'P'}, 'files': []}
        event = api_gateway_event(
            method='GET', path='/projects/p1/autoseed',
            path_params={'project_id': 'p1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert 'files' in body
        mock_autoseed.assert_called_once_with('p1', persona_ids=None, document_ids=None)

    @patch('projects_handler.autoseed_project')
    def test_autoseed_with_filters(self, mock_autoseed, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_autoseed.return_value = {'project': {'name': 'P'}, 'files': []}
        event = api_gateway_event(
            method='GET', path='/projects/p1/autoseed',
            path_params={'project_id': 'p1'},
            query_params={'persona_ids': 'a,b', 'document_ids': 'c'}
        )
        response = lambda_handler(event, lambda_context)
        mock_autoseed.assert_called_once_with('p1', persona_ids=['a', 'b'], document_ids=['c'])


class TestImportPersonaEndpoint:

    @patch('projects_handler.invoke_lambda_async')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_import_persona(self, mock_job, mock_invoke, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/projects/p1/personas/import',
            path_params={'project_id': 'p1'},
            body={'input_type': 'text', 'content': 'Some persona text'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['job_id'] == 'job1'
        mock_invoke.assert_called_once()


class TestGeneratePersonasEndpoint:

    @patch('projects_handler.invoke_lambda_async')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_generate_personas(self, mock_job, mock_invoke, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/projects/p1/personas/generate',
            path_params={'project_id': 'p1'},
            body={'sources': ['web'], 'persona_count': 3, 'days': 14}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['status'] == 'running'


class TestPersonaNoteEndpoints:

    @patch('projects_handler.add_persona_note')
    def test_add_note(self, mock_add, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_add.return_value = {'success': True, 'note': {'note_id': 'n1'}}
        event = api_gateway_event(
            method='POST', path='/projects/p1/personas/per1/notes',
            path_params={'project_id': 'p1', 'persona_id': 'per1'},
            body={'text': 'A note'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True

    @patch('projects_handler.update_persona_note')
    def test_update_note(self, mock_update, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_update.return_value = {'success': True}
        event = api_gateway_event(
            method='PUT', path='/projects/p1/personas/per1/notes/n1',
            path_params={'project_id': 'p1', 'persona_id': 'per1', 'note_id': 'n1'},
            body={'text': 'Updated'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True

    @patch('projects_handler.delete_persona_note')
    def test_delete_note(self, mock_delete, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_delete.return_value = {'success': True}
        event = api_gateway_event(
            method='DELETE', path='/projects/p1/personas/per1/notes/n1',
            path_params={'project_id': 'p1', 'persona_id': 'per1', 'note_id': 'n1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True


class TestRegenerateAvatarEndpoint:

    @patch('projects_handler.regenerate_persona_avatar')
    def test_regenerate_avatar(self, mock_regen, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_regen.return_value = {'success': True, 'avatar_url': 'url'}
        event = api_gateway_event(
            method='POST', path='/projects/p1/personas/per1/regenerate-avatar',
            path_params={'project_id': 'p1', 'persona_id': 'per1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True


class TestResearchEndpoint:

    @patch('projects_handler.boto3')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_research_with_step_functions(self, mock_job, mock_boto3, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        import os
        with patch.dict(os.environ, {'RESEARCH_STATE_MACHINE_ARN': 'arn:aws:states:us-east-1:123:stateMachine:test'}):
            event = api_gateway_event(
                method='POST', path='/projects/p1/research',
                path_params={'project_id': 'p1'},
                body={'question': 'What are pain points?', 'days': 7}
            )
            response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['status'] == 'pending'

    @patch('projects_handler.run_research')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_research_without_step_functions(self, mock_job, mock_run, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        import os
        mock_run.return_value = {'success': True, 'document': {}}
        with patch.dict(os.environ, {'RESEARCH_STATE_MACHINE_ARN': ''}):
            event = api_gateway_event(
                method='POST', path='/projects/p1/research',
                path_params={'project_id': 'p1'},
                body={'question': 'Q?'}
            )
            response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True


class TestGenerateDocumentEndpoint:

    @patch('projects_handler.invoke_lambda_async')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_generate_prd(self, mock_job, mock_invoke, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/projects/p1/document',
            path_params={'project_id': 'p1'},
            body={'doc_type': 'prd', 'feature_idea': 'New feature'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['status'] == 'pending'


class TestMergeDocumentsEndpoint:

    @patch('projects_handler.invoke_lambda_async')
    @patch('projects_handler.create_job', return_value=('job1', {}))
    def test_merge_documents(self, mock_job, mock_invoke, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/projects/p1/documents/merge',
            path_params={'project_id': 'p1'},
            body={'document_ids': ['d1', 'd2']}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['status'] == 'pending'


class TestJobEndpoints:

    @patch('projects_handler.get_jobs_table')
    def test_get_job_status(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'job_id': 'j1', 'status': 'completed', 'progress': 100,
                'current_step': 'done', 'job_type': 'research',
                'created_at': '2026-01-01', 'updated_at': '2026-01-01',
                'completed_at': '2026-01-01', 'error': None, 'result': {}
            }
        }
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='GET', path='/projects/p1/jobs/j1',
            path_params={'project_id': 'p1', 'job_id': 'j1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['status'] == 'completed'

    @patch('projects_handler.get_jobs_table')
    def test_get_job_not_found(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='GET', path='/projects/p1/jobs/j1',
            path_params={'project_id': 'p1', 'job_id': 'j1'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 404

    @patch('projects_handler.get_jobs_table')
    def test_list_jobs(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {'job_id': 'j1', 'job_type': 'research', 'status': 'completed',
                 'progress': 100, 'current_step': 'done', 'created_at': '2026-01-01',
                 'updated_at': '2026-01-01', 'completed_at': '2026-01-01',
                 'error': None, 'result': {}}
            ]
        }
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='GET', path='/projects/p1/jobs',
            path_params={'project_id': 'p1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert len(body['jobs']) == 1

    @patch('projects_handler.get_jobs_table')
    def test_delete_job(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='DELETE', path='/projects/p1/jobs/j1',
            path_params={'project_id': 'p1', 'job_id': 'j1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True


class TestPrioritizationEndpoints:

    @patch('projects_handler.get_aggregates_table')
    def test_get_prioritization_scores(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'scores': {'issue1': 5}}}
        mock_get_table.return_value = mock_table
        event = api_gateway_event(method='GET', path='/projects/prioritization')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['scores'] == {'issue1': 5}

    @patch('projects_handler.get_aggregates_table')
    def test_get_prioritization_scores_error(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_get_table.return_value = MagicMock(get_item=MagicMock(side_effect=Exception('fail')))
        event = api_gateway_event(method='GET', path='/projects/prioritization')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['scores'] == {}

    @patch('projects_handler.get_aggregates_table')
    def test_save_prioritization_scores(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='PUT', path='/projects/prioritization',
            body={'scores': {'issue1': 8}}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True

    @patch('projects_handler.get_aggregates_table')
    def test_save_prioritization_scores_error(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_get_table.return_value = MagicMock(put_item=MagicMock(side_effect=Exception('fail')))
        event = api_gateway_event(
            method='PUT', path='/projects/prioritization',
            body={'scores': {}}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('projects_handler.get_aggregates_table')
    def test_patch_prioritization_scores(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {'scores': {'a': 1}}}
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='PATCH', path='/projects/prioritization',
            body={'scores': {'b': 2}}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['updated_count'] == 1

    @patch('projects_handler.get_aggregates_table')
    def test_patch_prioritization_no_changes(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_get_table.return_value = MagicMock()
        event = api_gateway_event(
            method='PATCH', path='/projects/prioritization',
            body={'scores': {}}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert 'No changes' in body.get('message', '')

    @patch('projects_handler.get_aggregates_table')
    def test_patch_prioritization_error(self, mock_get_table, api_gateway_event, lambda_context):
        from projects_handler import lambda_handler
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception('fail')
        mock_get_table.return_value = mock_table
        event = api_gateway_event(
            method='PATCH', path='/projects/prioritization',
            body={'scores': {'a': 1}}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
