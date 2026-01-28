"""
Tests for chat_stream_handler.py - Streaming chat handler for project AI chat.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


# Suppress metrics warnings in tests by mocking the metrics decorator
@pytest.fixture(autouse=True)
def mock_metrics():
    """Mock metrics to prevent 'No application metrics to publish' warnings."""
    with patch('shared.logging.metrics') as mock:
        # Make log_metrics return a pass-through decorator
        mock.log_metrics.return_value = lambda f: f
        yield mock


class TestParseContextFilters:
    """Tests for parse_context_filters helper function."""

    def test_parses_source_filter(self):
        """Parses source filter from context hint."""
        from chat_stream_handler import parse_context_filters
        
        result = parse_context_filters('Source: webscraper. Category: delivery.')
        
        assert result['source'] == 'webscraper'
        assert result['category'] == 'delivery'

    def test_returns_empty_dict_for_empty_input(self):
        """Returns empty dict for empty context hint."""
        from chat_stream_handler import parse_context_filters
        
        result = parse_context_filters('')
        
        assert result == {}

    def test_handles_missing_filters(self):
        """Handles context hint with only some filters."""
        from chat_stream_handler import parse_context_filters
        
        result = parse_context_filters('Source: webscraper.')
        
        assert result.get('source') == 'webscraper'
        assert 'category' not in result


class TestMatchesFeedbackItem:
    """Tests for matches_feedback_item helper function."""

    def test_matches_item_with_no_filters(self):
        """Matches item when no filters applied."""
        from chat_stream_handler import matches_feedback_item
        
        item = {
            'date': '2026-01-09',
            'source_platform': 'webscraper',
            'sentiment_label': 'positive',
            'category': 'delivery',
            'original_text': 'Great delivery!'
        }
        
        result = matches_feedback_item(item, '', {}, '2026-01-01')
        
        assert result is True

    def test_filters_by_source(self):
        """Filters item by source platform."""
        from chat_stream_handler import matches_feedback_item
        
        item = {
            'date': '2026-01-09',
            'source_platform': 'webscraper',
            'original_text': 'Test'
        }
        
        assert matches_feedback_item(item, '', {'source': 'webscraper'}, '2026-01-01') is True
        assert matches_feedback_item(item, '', {'source': 'manual_import'}, '2026-01-01') is False

    def test_filters_by_query(self):
        """Filters item by text query."""
        from chat_stream_handler import matches_feedback_item
        
        item = {
            'date': '2026-01-09',
            'original_text': 'Great delivery service!'
        }
        
        assert matches_feedback_item(item, 'delivery', {}, '2026-01-01') is True
        assert matches_feedback_item(item, 'pricing', {}, '2026-01-01') is False

    def test_excludes_items_before_cutoff(self):
        """Excludes items before cutoff date."""
        from chat_stream_handler import matches_feedback_item
        
        item = {
            'date': '2025-12-01',
            'original_text': 'Test'
        }
        
        result = matches_feedback_item(item, '', {}, '2026-01-01')
        
        assert result is False


class TestFormatToolResults:
    """Tests for format_tool_results helper function."""

    def test_formats_feedback_items(self):
        """Formats feedback items for tool result."""
        from chat_stream_handler import format_tool_results
        
        items = [
            {
                'source_platform': 'webscraper',
                'source_created_at': '2026-01-09T10:00:00Z',
                'sentiment_label': 'positive',
                'sentiment_score': 0.85,
                'category': 'delivery',
                'rating': 5,
                'original_text': 'Great service!'
            }
        ]
        
        result = format_tool_results(items)
        
        assert 'Found 1 relevant feedback' in result
        assert 'webscraper' in result
        assert 'positive' in result
        assert 'Great service!' in result

    def test_returns_no_results_message(self):
        """Returns appropriate message for empty results."""
        from chat_stream_handler import format_tool_results
        
        result = format_tool_results([])
        
        assert 'No feedback found' in result


class TestExtractTextResponse:
    """Tests for extract_text_response helper function."""

    def test_extracts_text_from_content_blocks(self):
        """Extracts text from Converse API content blocks."""
        from chat_stream_handler import extract_text_response
        
        blocks = [
            {'text': 'Hello '},
            {'text': 'world!'},
            {'toolUse': {'name': 'search_feedback'}}  # Should be ignored
        ]
        
        result = extract_text_response(blocks)
        
        assert result == 'Hello world!'

    def test_returns_empty_for_no_text_blocks(self):
        """Returns empty string when no text blocks."""
        from chat_stream_handler import extract_text_response
        
        blocks = [{'toolUse': {'name': 'search_feedback'}}]
        
        result = extract_text_response(blocks)
        
        assert result == ''


class TestCombinedHandler:
    """Tests for the combined_handler function."""

    @patch('chat_stream_handler.validate_auth')
    def test_returns_unauthorized_when_auth_fails(self, mock_auth):
        """Returns 401 when authentication fails."""
        mock_auth.return_value = (False, 'Invalid token')
        
        from chat_stream_handler import combined_handler
        
        event = {'headers': {'Authorization': 'Bearer invalid'}}
        context = MagicMock()
        
        response = combined_handler(event, context)
        
        assert response['statusCode'] == 401

    @patch('chat_stream_handler.voc_chat_handler')
    @patch('chat_stream_handler.validate_auth')
    def test_routes_to_voc_chat_for_chat_stream_path(self, mock_auth, mock_voc_handler):
        """Routes to VoC chat handler for /chat/stream path."""
        mock_auth.return_value = (True, "")
        mock_voc_handler.return_value = {'statusCode': 200, 'body': '{}'}
        
        from chat_stream_handler import combined_handler
        
        event = {
            'headers': {'Authorization': 'Bearer valid'},
            'rawPath': '/chat/stream',
            'body': json.dumps({'message': 'Hello'})
        }
        context = MagicMock()
        
        combined_handler(event, context)
        
        mock_voc_handler.assert_called_once()

    @patch('chat_stream_handler.project_chat_handler')
    @patch('chat_stream_handler.validate_auth')
    def test_routes_to_project_chat_for_projects_path(self, mock_auth, mock_project_handler):
        """Routes to project chat handler for /projects/*/chat/stream path."""
        mock_auth.return_value = (True, "")
        mock_project_handler.return_value = {'statusCode': 200, 'body': '{}'}
        
        from chat_stream_handler import combined_handler
        
        event = {
            'headers': {'Authorization': 'Bearer valid'},
            'rawPath': '/projects/proj-123/chat/stream',
            'body': json.dumps({'message': 'Hello'})
        }
        context = MagicMock()
        
        combined_handler(event, context)
        
        mock_project_handler.assert_called_once()


class TestProjectChatHandler:
    """Tests for project_chat_handler function."""

    @patch('chat_stream_handler.bedrock')
    @patch('chat_stream_handler.build_chat_context')
    def test_returns_error_when_project_not_found(self, mock_context, mock_bedrock):
        """Returns 404 when project not found."""
        mock_context.return_value = (None, None, {'error': 'Project not found'})
        
        from chat_stream_handler import project_chat_handler
        
        event = {
            'body': json.dumps({'message': 'Hello'}),
            'rawPath': '/projects/nonexistent/chat/stream'
        }
        context = MagicMock()
        
        response = project_chat_handler(event, context)
        
        assert response['statusCode'] == 404

    def test_returns_error_when_project_id_missing(self):
        """Returns 400 when project_id not in path."""
        from chat_stream_handler import project_chat_handler
        
        event = {
            'body': json.dumps({'message': 'Hello'}),
            'rawPath': '/invalid/path'
        }
        context = MagicMock()
        
        response = project_chat_handler(event, context)
        
        assert response['statusCode'] == 400


class TestVocChatHandler:
    """Tests for voc_chat_handler function."""

    def test_returns_error_when_message_missing(self):
        """Returns 400 when message is missing."""
        from chat_stream_handler import voc_chat_handler
        
        event = {
            'body': json.dumps({})
        }
        context = MagicMock()
        
        response = voc_chat_handler(event, context)
        
        assert response['statusCode'] == 400
        body = json.loads(response['body'])
        assert 'Message is required' in body['error']

    @patch('chat_stream_handler.bedrock')
    @patch('chat_stream_handler.get_aggregated_metrics')
    def test_returns_response_without_tool_use(self, mock_metrics, mock_bedrock):
        """Returns response when LLM doesn't use tools."""
        mock_metrics.return_value = {
            'total': 100,
            'sentiment': {'positive': 50, 'negative': 20, 'neutral': 25, 'mixed': 5},
            'categories': {'delivery': 30, 'support': 20},
            'urgent': 5
        }
        mock_bedrock.converse.return_value = {
            'stopReason': 'end_turn',
            'output': {
                'message': {
                    'content': [{'text': 'Hello! How can I help you?'}]
                }
            }
        }
        
        from chat_stream_handler import voc_chat_handler
        
        event = {
            'body': json.dumps({'message': 'Hello'})
        }
        context = MagicMock()
        
        response = voc_chat_handler(event, context)
        
        assert response['statusCode'] == 200
        body = json.loads(response['body'])
        assert body['response'] == 'Hello! How can I help you?'
        assert body['metadata']['tool_used'] is False
