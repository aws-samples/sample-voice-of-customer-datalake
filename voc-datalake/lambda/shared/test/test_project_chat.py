"""
Tests for shared.project_chat module - Project chat context building utilities.
"""
import pytest
from unittest.mock import MagicMock


class TestGetProjectData:
    """Tests for get_project_data function."""

    def test_returns_project_with_personas_and_documents(self):
        """Returns project data with personas and documents."""
        from shared.project_chat import get_project_data
        
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'META',
                    'project_id': 'proj-123',
                    'name': 'Test Project',
                    'filters': {'days': 30}
                },
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'PERSONA#persona-1',
                    'persona_id': 'persona-1',
                    'name': 'Tech User',
                    'tagline': 'Power user'
                },
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'DOC#doc-1',
                    'document_id': 'doc-1',
                    'title': 'Research Doc',
                    'document_type': 'research'
                }
            ]
        }
        
        result = get_project_data(mock_table, 'proj-123')
        
        assert result['project']['name'] == 'Test Project'
        assert len(result['personas']) == 1
        assert result['personas'][0]['name'] == 'Tech User'
        assert len(result['documents']) == 1
        assert result['documents'][0]['title'] == 'Research Doc'

    def test_returns_error_when_no_items(self):
        """Returns error when project not found."""
        from shared.project_chat import get_project_data
        
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        
        result = get_project_data(mock_table, 'nonexistent')
        
        assert 'error' in result
        assert result['error'] == 'Project not found'

    def test_returns_error_when_table_none(self):
        """Returns error when table not configured."""
        from shared.project_chat import get_project_data
        
        result = get_project_data(None, 'proj-123')
        
        assert 'error' in result
        assert 'not configured' in result['error']


class TestGetFeedbackForChat:
    """Tests for get_feedback_for_chat function."""

    def test_returns_filtered_feedback(self):
        """Returns feedback filtered by sources."""
        from shared.project_chat import get_feedback_for_chat
        
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {'source_platform': 'webscraper', 'original_text': 'Review 1'},
                {'source_platform': 'manual_import', 'original_text': 'Review 2'},
                {'source_platform': 'webscraper', 'original_text': 'Review 3'},
            ]
        }
        
        result = get_feedback_for_chat(mock_table, {'sources': ['webscraper']}, limit=10)
        
        assert len(result) == 2
        assert all(item['source_platform'] == 'webscraper' for item in result)

    def test_returns_empty_list_when_table_none(self):
        """Returns empty list when table not configured."""
        from shared.project_chat import get_feedback_for_chat
        
        result = get_feedback_for_chat(None, {}, limit=10)
        
        assert result == []


class TestFormatFeedbackForChat:
    """Tests for format_feedback_for_chat function."""

    def test_formats_items_correctly(self):
        """Formats feedback items with source, sentiment, category."""
        from shared.project_chat import format_feedback_for_chat
        
        items = [
            {
                'source_platform': 'webscraper',
                'sentiment_label': 'positive',
                'category': 'product',
                'original_text': 'Great product!'
            }
        ]
        
        result = format_feedback_for_chat(items)
        
        assert '[webscraper|positive|product]' in result
        assert 'Great product!' in result

    def test_returns_placeholder_for_empty(self):
        """Returns placeholder message for empty list."""
        from shared.project_chat import format_feedback_for_chat
        
        result = format_feedback_for_chat([])
        
        assert 'No feedback data available' in result


class TestBuildPersonasContext:
    """Tests for build_personas_context function."""

    def test_builds_persona_detail(self):
        """Builds detailed persona context."""
        from shared.project_chat import build_personas_context
        
        personas = [
            {
                'name': 'Tech User',
                'tagline': 'Power user',
                'quote': 'I need speed!',
                'goals': ['Fast performance', 'Easy setup'],
                'frustrations': ['Slow loading'],
                'needs': ['Better docs']
            }
        ]
        
        result = build_personas_context(personas)
        
        assert 'Tech User' in result
        assert 'Power user' in result
        assert 'I need speed!' in result
        assert 'Fast performance' in result

    def test_returns_empty_for_no_personas(self):
        """Returns empty string when no personas."""
        from shared.project_chat import build_personas_context
        
        result = build_personas_context([])
        
        assert result == ""


class TestBuildChatContext:
    """Tests for build_chat_context function."""

    def test_builds_context_with_project_data(self):
        """Builds system prompt with project context."""
        from shared.project_chat import build_chat_context
        
        mock_projects_table = MagicMock()
        mock_projects_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'META',
                    'project_id': 'proj-123',
                    'name': 'Test Project',
                    'filters': {}
                }
            ]
        }
        
        mock_feedback_table = MagicMock()
        mock_feedback_table.query.return_value = {'Items': []}
        
        system_prompt, user_message, metadata = build_chat_context(
            mock_projects_table,
            mock_feedback_table,
            'proj-123',
            'Hello world'
        )
        
        assert system_prompt is not None
        assert 'Test Project' in system_prompt
        assert user_message == 'Hello world'
        assert 'context' in metadata

    def test_returns_error_when_project_not_found(self):
        """Returns None system_prompt when project not found."""
        from shared.project_chat import build_chat_context
        
        mock_projects_table = MagicMock()
        mock_projects_table.query.return_value = {'Items': []}
        
        system_prompt, user_message, metadata = build_chat_context(
            mock_projects_table,
            None,
            'nonexistent',
            'Hello'
        )
        
        assert system_prompt is None
        assert 'error' in metadata

    def test_detects_persona_mentions(self):
        """Detects @mentions in message and includes persona."""
        from shared.project_chat import build_chat_context
        
        mock_projects_table = MagicMock()
        mock_projects_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'META',
                    'project_id': 'proj-123',
                    'name': 'Test Project',
                    'filters': {}
                },
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'PERSONA#persona-1',
                    'persona_id': 'persona-1',
                    'name': 'Marcus',
                    'tagline': 'Tech enthusiast',
                    'quote': 'I love tech',
                    'goals': ['Learn'],
                    'frustrations': ['Bugs'],
                    'needs': ['Docs']
                }
            ]
        }
        
        mock_feedback_table = MagicMock()
        mock_feedback_table.query.return_value = {'Items': []}
        
        system_prompt, user_message, metadata = build_chat_context(
            mock_projects_table,
            mock_feedback_table,
            'proj-123',
            'What does @Marcus think?'
        )
        
        assert 'Marcus' in metadata['mentioned_personas']
        assert 'PERSONA MODE ACTIVE' in system_prompt
