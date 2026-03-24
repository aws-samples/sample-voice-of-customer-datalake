"""
Tests for projects.py - Projects API core functions.
"""
import json
import os
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone
from decimal import Decimal


class TestFixPersonaName:
    """Tests for fix_persona_name helper function."""

    def test_adds_space_between_camel_case(self):
        """Adds space between lowercase and uppercase letters."""
        from projects import fix_persona_name
        
        assert fix_persona_name('VeronicaChen') == 'Veronica Chen'
        assert fix_persona_name('JohnSmith') == 'John Smith'
        assert fix_persona_name('MaryJaneWatson') == 'Mary Jane Watson'

    def test_preserves_already_spaced_names(self):
        """Preserves names that already have proper spacing."""
        from projects import fix_persona_name
        
        assert fix_persona_name('John Smith') == 'John Smith'
        assert fix_persona_name('Mary Jane') == 'Mary Jane'

    def test_handles_single_word_names(self):
        """Handles single word names without changes."""
        from projects import fix_persona_name
        
        assert fix_persona_name('Marcus') == 'Marcus'
        assert fix_persona_name('ALLCAPS') == 'ALLCAPS'

    def test_handles_empty_string(self):
        """Handles empty string input."""
        from projects import fix_persona_name
        
        assert fix_persona_name('') == ''


class TestListProjects:
    """Tests for list_projects function."""

    @patch('projects.projects_table')
    def test_returns_list_of_projects(self, mock_table):
        """Returns list of all projects."""
        mock_table.query.return_value = {
            'Items': [
                {'project_id': 'proj-1', 'name': 'Project 1', 'created_at': '2026-01-01'},
                {'project_id': 'proj-2', 'name': 'Project 2', 'created_at': '2026-01-02'}
            ]
        }
        # Mock the second query for item counts
        mock_table.query.side_effect = [
            {'Items': [{'project_id': 'proj-1', 'name': 'Project 1'}]},
            {'Items': [{'sk': 'META'}, {'sk': 'PERSONA#1'}]},
        ]
        
        from projects import list_projects
        
        result = list_projects()
        
        assert 'projects' in result

    @patch('projects.projects_table', None)
    def test_returns_empty_when_table_not_configured(self):
        """Returns empty list when table not configured."""
        from projects import list_projects
        
        result = list_projects()
        
        assert result['projects'] == []


class TestCreateProject:
    """Tests for create_project function."""

    @patch('projects.projects_table')
    def test_creates_project(self, mock_table):
        """Creates a new project."""
        from projects import create_project
        
        result = create_project({'name': 'New Project', 'description': 'Test'})
        
        assert result['success'] is True
        assert 'project' in result
        mock_table.put_item.assert_called_once()

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import create_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            create_project({'name': 'Test'})


class TestGetProject:
    """Tests for get_project function."""

    @patch('projects.projects_table')
    def test_returns_project_with_personas_and_documents(self, mock_table):
        """Returns project with all related data."""
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#proj-1', 'sk': 'META', 'project_id': 'proj-1', 'name': 'Test'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'User'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'PRD'}
            ]
        }
        
        from projects import get_project
        
        result = get_project('proj-1')
        
        assert result['project']['name'] == 'Test'
        assert len(result['personas']) == 1
        assert len(result['documents']) == 1

    @patch('projects.projects_table')
    def test_returns_error_when_project_not_found(self, mock_table):
        """Returns error when project doesn't exist."""
        mock_table.query.return_value = {'Items': []}
        
        from projects import get_project
        from shared.exceptions import NotFoundError
        
        with pytest.raises(NotFoundError):
            get_project('nonexistent')


class TestUpdateProject:
    """Tests for update_project function."""

    @patch('projects.projects_table')
    def test_updates_project_fields(self, mock_table):
        """Updates project with new values."""
        from projects import update_project
        
        result = update_project('proj-1', {'name': 'Updated', 'description': 'New desc'})
        
        assert result['success'] is True
        mock_table.update_item.assert_called_once()

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import update_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            update_project('proj-1', {'name': 'Test'})


class TestDeleteProject:
    """Tests for delete_project function."""

    @patch('projects.projects_table')
    def test_deletes_project_and_related_items(self, mock_table):
        """Deletes project and all related items."""
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#proj-1', 'sk': 'META'},
                {'pk': 'PROJECT#proj-1', 'sk': 'PERSONA#p1'}
            ]
        }
        mock_table.batch_writer.return_value.__enter__ = MagicMock()
        mock_table.batch_writer.return_value.__exit__ = MagicMock()
        
        from projects import delete_project
        
        result = delete_project('proj-1')
        
        assert result['success'] is True

    @patch('projects.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when table not configured."""
        from projects import delete_project
        from shared.exceptions import ConfigurationError
        
        with pytest.raises(ConfigurationError):
            delete_project('proj-1')


class TestGetAvatarCdnUrl:
    """Tests for get_avatar_cdn_url function."""

    def test_converts_s3_uri_to_cdn_url(self):
        """Converts S3 URI to CloudFront CDN URL."""
        from shared.avatar import get_avatar_cdn_url
        
        s3_uri = 's3://bucket/avatars/persona_123.png'
        result = get_avatar_cdn_url(s3_uri, cdn_url='https://cdn.example.com')
        
        assert result == 'https://cdn.example.com/persona_123.png'

    def test_returns_none_when_cdn_not_configured(self):
        """Returns None when CDN URL not configured."""
        from shared.avatar import get_avatar_cdn_url
        
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('AVATARS_CDN_URL', None)
            result = get_avatar_cdn_url('s3://bucket/avatars/test.png', cdn_url='')
        
        assert result is None

    def test_returns_none_for_invalid_uri(self):
        """Returns None for invalid S3 URI."""
        from shared.avatar import get_avatar_cdn_url
        
        result = get_avatar_cdn_url('not-an-s3-uri')
        
        assert result is None

    def test_returns_none_for_empty_uri(self):
        """Returns None for empty URI."""
        from shared.avatar import get_avatar_cdn_url
        
        result = get_avatar_cdn_url('')
        
        assert result is None


class TestGenerateAvatarPromptWithLlm:
    """Tests for generate_avatar_prompt_with_llm function."""

    @patch('shared.avatar.get_avatar_prompt_config')
    def test_generates_prompt_from_persona_data(self, mock_config):
        """Generates image prompt from persona data."""
        mock_config.return_value = {
            'system_prompt': 'Generate image prompt',
            'user_prompt_template': 'Create avatar for {name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Professional headshot of a {occupation}'
        }
        
        from shared.avatar import generate_avatar_prompt_with_llm
        
        # Create a mock bedrock client
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=lambda: json.dumps({
                'content': [{'type': 'text', 'text': 'Professional headshot of a software engineer'}]
            }).encode())
        }
        
        persona_data = {
            'name': 'John Smith',
            'tagline': 'Tech enthusiast',
            'identity': {
                'bio': 'Software developer',
                'age_range': '30-40',
                'occupation': 'Engineer',
                'location': 'San Francisco'
            }
        }
        
        result = generate_avatar_prompt_with_llm(persona_data, mock_bedrock)
        
        assert 'Professional headshot' in result

    @patch('shared.avatar.get_avatar_prompt_config')
    def test_returns_fallback_on_error(self, mock_config):
        """Returns fallback prompt on LLM error."""
        mock_config.return_value = {
            'system_prompt': 'Generate image prompt',
            'user_prompt_template': 'Create avatar for {name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Professional headshot of a {occupation}'
        }
        
        from shared.avatar import generate_avatar_prompt_with_llm
        
        # Create a mock bedrock client that raises an error
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception('LLM error')
        
        persona_data = {'name': 'Test', 'identity': {'occupation': 'Developer'}}
        
        result = generate_avatar_prompt_with_llm(persona_data, mock_bedrock)
        
        assert 'Professional headshot' in result
