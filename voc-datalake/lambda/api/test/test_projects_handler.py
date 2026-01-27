"""
Tests for projects_handler.py - /projects/* endpoints.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestValidatePersonaCount:
    """Tests for validate_persona_count helper function."""

    def test_returns_default_when_value_is_none(self):
        """Returns default value when input is None."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(None, default=3) == 3

    def test_clamps_to_min_value(self):
        """Clamps values below minimum (hardcoded to 1)."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(0, default=3) == 1
        assert validate_persona_count(-1, default=3) == 1

    def test_clamps_to_max_value(self):
        """Clamps values above maximum (hardcoded to 10)."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(20, default=3) == 10

    def test_accepts_valid_count(self):
        """Accepts valid count within range."""
        from projects_handler import validate_persona_count
        
        assert validate_persona_count(5, default=3) == 5
        assert validate_persona_count('7', default=3) == 7


class TestGetConfigEndpoint:
    """Tests for GET /projects/config endpoint."""

    @patch.dict('os.environ', {'CHAT_STREAM_URL': 'wss://stream.example.com'})
    def test_returns_config_with_stream_url(self, api_gateway_event, lambda_context):
        """Returns configuration including streaming endpoint."""
        from projects_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/projects/config')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'chat_stream_url' in body
        assert body['chat_stream_url'] == 'wss://stream.example.com'


class TestListProjectsEndpoint:
    """Tests for GET /projects endpoint."""

    @patch('projects_handler.list_projects')
    def test_returns_list_of_projects(
        self, mock_list_projects, api_gateway_event, lambda_context
    ):
        """Returns list of all projects."""
        mock_list_projects.return_value = {
            'success': True,
            'projects': [
                {'project_id': 'proj-1', 'name': 'Project 1'},
                {'project_id': 'proj-2', 'name': 'Project 2'}
            ]
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/projects')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'projects' in body
        mock_list_projects.assert_called_once()


class TestCreateProjectEndpoint:
    """Tests for POST /projects endpoint."""

    @patch('projects_handler.create_project')
    def test_creates_project_successfully(
        self, mock_create_project, api_gateway_event, lambda_context
    ):
        """Creates a new project."""
        mock_create_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-new',
                'name': 'New Project',
                'description': 'A new project'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects',
            body={'name': 'New Project', 'description': 'A new project'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['project']['name'] == 'New Project'
        mock_create_project.assert_called_once()


class TestGetProjectEndpoint:
    """Tests for GET /projects/<project_id> endpoint."""

    @patch('projects_handler.get_project')
    def test_returns_project_details(
        self, mock_get_project, api_gateway_event, lambda_context
    ):
        """Returns project details for existing project."""
        mock_get_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-123',
                'name': 'Test Project',
                'personas': [],
                'documents': []
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        mock_get_project.assert_called_once_with('proj-123')


class TestUpdateProjectEndpoint:
    """Tests for PUT /projects/<project_id> endpoint."""

    @patch('projects_handler.update_project')
    def test_updates_project_successfully(
        self, mock_update_project, api_gateway_event, lambda_context
    ):
        """Updates project with new data."""
        mock_update_project.return_value = {
            'success': True,
            'project': {
                'project_id': 'proj-123',
                'name': 'Updated Name',
                'description': 'Updated description'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Updated Name', 'description': 'Updated description'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True


class TestDeleteProjectEndpoint:
    """Tests for DELETE /projects/<project_id> endpoint."""

    @patch('projects_handler.delete_project')
    def test_deletes_project_successfully(
        self, mock_delete_project, api_gateway_event, lambda_context
    ):
        """Deletes project successfully."""
        mock_delete_project.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123',
            path_params={'project_id': 'proj-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_delete_project.assert_called_once_with('proj-123')


class TestPersonaCRUDEndpoints:
    """Tests for persona CRUD endpoints."""

    @patch('projects_handler.create_persona')
    def test_create_persona(
        self, mock_create_persona, api_gateway_event, lambda_context
    ):
        """Creates a new persona."""
        mock_create_persona.return_value = {
            'success': True,
            'persona': {
                'persona_id': 'persona-123',
                'name': 'Tech Enthusiast',
                'description': 'Early adopter of technology'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/personas',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Tech Enthusiast', 'description': 'Early adopter of technology'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['persona']['name'] == 'Tech Enthusiast'

    @patch('projects_handler.update_persona')
    def test_update_persona(
        self, mock_update_persona, api_gateway_event, lambda_context
    ):
        """Updates an existing persona."""
        mock_update_persona.return_value = {
            'success': True,
            'persona': {
                'persona_id': 'persona-123',
                'name': 'Updated Name'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123/personas/persona-123',
            path_params={'project_id': 'proj-123', 'persona_id': 'persona-123'},
            body={'name': 'Updated Name'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['persona']['name'] == 'Updated Name'

    @patch('projects_handler.delete_persona')
    def test_delete_persona(
        self, mock_delete_persona, api_gateway_event, lambda_context
    ):
        """Deletes a persona."""
        mock_delete_persona.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/personas/persona-123',
            path_params={'project_id': 'proj-123', 'persona_id': 'persona-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True


class TestDocumentCRUDEndpoints:
    """Tests for document CRUD endpoints."""

    @patch('projects_handler.create_document')
    def test_create_document(
        self, mock_create_document, api_gateway_event, lambda_context
    ):
        """Creates a new document."""
        mock_create_document.return_value = {
            'success': True,
            'document': {
                'document_id': 'doc-123',
                'title': 'Product Requirements',
                'doc_type': 'prd'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/documents',
            path_params={'project_id': 'proj-123'},
            body={'title': 'Product Requirements', 'doc_type': 'prd'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['document']['title'] == 'Product Requirements'

    @patch('projects_handler.update_document')
    def test_update_document(
        self, mock_update_document, api_gateway_event, lambda_context
    ):
        """Updates an existing document."""
        mock_update_document.return_value = {
            'success': True,
            'document': {
                'document_id': 'doc-123',
                'title': 'Updated Title',
                'content': 'Updated content'
            }
        }
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='PUT',
            path='/projects/proj-123/documents/doc-123',
            path_params={'project_id': 'proj-123', 'document_id': 'doc-123'},
            body={'title': 'Updated Title', 'content': 'Updated content'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['document']['title'] == 'Updated Title'

    @patch('projects_handler.delete_document')
    def test_delete_document(
        self, mock_delete_document, api_gateway_event, lambda_context
    ):
        """Deletes a document."""
        mock_delete_document.return_value = {'success': True}
        
        from projects_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/documents/doc-123',
            path_params={'project_id': 'proj-123', 'document_id': 'doc-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True



