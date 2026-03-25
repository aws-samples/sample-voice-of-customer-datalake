"""
Additional coverage tests for chat_handler.py.
Targets uncovered lines: 104 (break on 30+ items), 132-135 (response_language), 253 (empty proxy delete).
"""

import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestChatFeedbackBreak:
    """Tests for chat endpoint breaking at 30+ feedback items (line 104)."""

    @patch('chat_handler.dynamodb')
    @patch('chat_handler.get_configured_categories')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_breaks_at_30_feedback_items(self, mock_agg, mock_fb, mock_converse, mock_cats, mock_dynamodb):
        """Stops fetching feedback when 30+ items collected."""
        from chat_handler import app

        mock_agg.get_item.return_value = {'Item': {'count': 10}}
        mock_cats.return_value = ['delivery']
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}

        # Return 31 items on first query to trigger the break
        mock_fb.query.return_value = {
            'Items': [{'original_text': f'Feedback {i}', 'source_platform': 'web'} for i in range(31)]
        }

        mock_converse.return_value = "AI response"

        event = {
            'httpMethod': 'POST',
            'path': '/chat',
            'resource': '/chat',
            'queryStringParameters': {'days': '7'},
            'pathParameters': {},
            'body': json.dumps({'message': 'What are the trends?'}),
            'headers': {'Content-Type': 'application/json'},
            'requestContext': {'requestId': 'test', 'stage': 'test'},
            'isBase64Encoded': False,
        }

        result = app.resolve(event, MagicMock())
        assert result['statusCode'] == 200

        # Should only query once since first query returned 31 items (>= 30)
        assert mock_fb.query.call_count == 1


class TestChatResponseLanguage:
    """Tests for response_language injection (lines 132-135)."""

    @patch('chat_handler.dynamodb')
    @patch('chat_handler.get_configured_categories')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_injects_language_instruction_for_non_english(self, mock_agg, mock_fb, mock_converse, mock_cats, mock_dynamodb):
        """Injects language instruction when response_language is set."""
        from chat_handler import app

        mock_agg.get_item.return_value = {}
        mock_cats.return_value = []
        mock_fb.query.return_value = {'Items': []}
        mock_converse.return_value = "Respuesta en español"
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}

        event = {
            'httpMethod': 'POST',
            'path': '/chat',
            'resource': '/chat',
            'queryStringParameters': {},
            'pathParameters': {},
            'body': json.dumps({'message': 'Hola', 'response_language': 'es'}),
            'headers': {'Content-Type': 'application/json'},
            'requestContext': {'requestId': 'test', 'stage': 'test'},
            'isBase64Encoded': False,
        }

        result = app.resolve(event, MagicMock())
        assert result['statusCode'] == 200

        # Verify converse was called with Spanish instruction in system prompt
        call_kwargs = mock_converse.call_args.kwargs
        assert 'Spanish' in call_kwargs['system_prompt']


class TestDeleteConversationEmptyProxy:
    """Tests for delete conversation with empty proxy (line 253)."""

    def test_raises_not_found_for_empty_proxy(self):
        """Raises AppNotFoundError when proxy is empty."""
        import chat_handler
        from shared.exceptions import NotFoundError

        mock_table = MagicMock()
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table

        try:
            with pytest.raises(NotFoundError, match="Conversation ID is required"):
                chat_handler.delete_conversation(proxy='')
        finally:
            chat_handler.conversations_table = original_table
