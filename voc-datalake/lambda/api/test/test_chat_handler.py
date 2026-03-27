"""
Tests for chat_handler.py - /chat/* endpoints with Bedrock AI integration.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
import importlib

# Bedrock model ID used in production
BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'


class TestChatEndpoint:
    """Tests for POST /chat endpoint."""

    @patch('chat_handler.dynamodb')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_ai_response_for_valid_message(
        self, mock_agg_table, mock_fb_table, mock_converse, mock_dynamodb,
        api_gateway_event, lambda_context
    ):
        """Returns AI-generated response based on feedback data."""
        # Arrange
        mock_converse.return_value = 'Based on the feedback data, customers are generally satisfied with the product quality.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 100}}
        mock_fb_table.query.return_value = {'Items': []}
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from chat_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What do customers think about our product?'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'response' in body
        assert 'satisfied' in body['response']
        mock_converse.assert_called_once()

    @patch('chat_handler.dynamodb')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_graceful_error_when_bedrock_fails(
        self, mock_agg_table, mock_fb_table, mock_converse, mock_dynamodb,
        api_gateway_event, lambda_context
    ):
        """Returns graceful error message when Bedrock service fails."""
        # Arrange
        mock_converse.side_effect = Exception('Service unavailable')
        mock_agg_table.get_item.return_value = {'Item': {'count': 50}}
        mock_fb_table.query.return_value = {'Items': []}
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What are the top issues?'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - graceful degradation, not 500 error
        assert response['statusCode'] == 200
        assert 'error' in body or 'Error' in body.get('response', '')

    @patch('chat_handler.dynamodb')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_includes_feedback_sources_in_response(
        self, mock_agg_table, mock_fb_table, mock_converse, mock_dynamodb,
        sample_feedback_items, api_gateway_event, lambda_context
    ):
        """Includes source feedback items in response."""
        # Arrange
        mock_converse.return_value = 'Analysis complete.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_fb_table.query.return_value = {'Items': sample_feedback_items}
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'Show me recent feedback'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'sources' in body


class TestChatConversationsEndpointWithTable:
    """Tests for /chat/conversations/* endpoints when table is configured.
    
    Note: The <proxy+> route syntax used in chat_handler.py is API Gateway specific
    and doesn't work with Lambda Powertools' route matching in unit tests.
    These tests call the handler functions directly to test the business logic.
    """

    def test_list_conversations_returns_conversations(self):
        """Returns list of conversations."""
        import chat_handler
        
        # Create mock table
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'conversation_id': 'conv-1',
                    'title': 'Test Conversation',
                    'messages': [{'role': 'user', 'content': 'Hello'}],
                    'created_at': '2026-01-07T10:00:00Z',
                    'updated_at': '2026-01-07T10:00:00Z'
                }
            ]
        }
        
        # Save original and patch
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            # Call the function directly
            result = chat_handler.get_conversations(proxy='_list')
            
            assert 'conversations' in result
            assert len(result['conversations']) == 1
            assert result['conversations'][0]['id'] == 'conv-1'
        finally:
            chat_handler.conversations_table = original_table

    def test_get_single_conversation(self):
        """Returns single conversation by ID."""
        import chat_handler
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'conversation_id': 'conv-123',
                'title': 'Test Conversation',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'filters': {'days': 7},
                'created_at': '2026-01-07T10:00:00Z',
                'updated_at': '2026-01-07T10:00:00Z'
            }
        }
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            result = chat_handler.get_conversations(proxy='conv-123')
            
            assert result['id'] == 'conv-123'
            assert result['title'] == 'Test Conversation'
            assert len(result['messages']) == 1
        finally:
            chat_handler.conversations_table = original_table

    def test_get_conversation_raises_not_found_when_missing(self):
        """Raises NotFoundError when conversation doesn't exist."""
        import chat_handler
        from shared.exceptions import NotFoundError
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            with pytest.raises(NotFoundError):
                chat_handler.get_conversations(proxy='nonexistent')
        finally:
            chat_handler.conversations_table = original_table


class TestChatConversationsEndpointNoTable:
    """Tests for /chat/conversations/* endpoints when table is NOT configured."""

    def test_list_conversations_returns_empty_when_no_table(self):
        """Returns empty list when conversations table not configured."""
        import chat_handler
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None
        
        try:
            result = chat_handler.get_conversations(proxy='_list')
            
            assert result['conversations'] == []
        finally:
            chat_handler.conversations_table = original_table


class TestSaveConversation:
    """Tests for POST /chat/conversations/* endpoint."""

    def test_returns_error_when_table_not_configured(self):
        """Returns error when conversations table not configured."""
        import chat_handler
        from shared.exceptions import ConfigurationError
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None
        
        try:
            # Mock the app.current_event for the function
            mock_event = MagicMock()
            mock_event.json_body = {'title': 'New Conversation', 'messages': []}
            
            with patch.object(chat_handler.app, 'current_event', mock_event):
                with pytest.raises(ConfigurationError):
                    chat_handler.save_conversation(proxy='new')
        finally:
            chat_handler.conversations_table = original_table

    def test_saves_conversation_successfully(self):
        """Saves conversation to DynamoDB."""
        import chat_handler
        
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            mock_event = MagicMock()
            mock_event.json_body = {
                'id': 'conv-123',
                'title': 'Test Conversation',
                'messages': [{'role': 'user', 'content': 'Hello'}],
                'filters': {'days': 7}
            }
            
            with patch.object(chat_handler.app, 'current_event', mock_event):
                result = chat_handler.save_conversation(proxy='new')
            
            assert result['success'] is True
            assert result['id'] == 'conv-123'
            mock_table.put_item.assert_called_once()
        finally:
            chat_handler.conversations_table = original_table

    def test_generates_id_when_not_provided(self):
        """Generates conversation ID when not provided."""
        import chat_handler
        
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            mock_event = MagicMock()
            mock_event.json_body = {'title': 'New Conversation', 'messages': []}
            
            with patch.object(chat_handler.app, 'current_event', mock_event):
                result = chat_handler.save_conversation(proxy='new')
            
            assert result['success'] is True
            assert 'id' in result
            assert result['id'].startswith('conv-')
        finally:
            chat_handler.conversations_table = original_table


class TestDeleteConversation:
    """Tests for DELETE /chat/conversations/* endpoint."""

    def test_raises_error_when_table_not_configured(self):
        """Raises ConfigurationError when conversations table not configured."""
        import chat_handler
        from shared.exceptions import ConfigurationError
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = None
        
        try:
            with pytest.raises(ConfigurationError) as exc_info:
                chat_handler.delete_conversation(proxy='conv-123')
            
            assert 'not configured' in str(exc_info.value)
        finally:
            chat_handler.conversations_table = original_table

    def test_deletes_conversation_successfully(self):
        """Deletes conversation from DynamoDB."""
        import chat_handler
        
        mock_table = MagicMock()
        mock_table.delete_item.return_value = {}
        
        original_table = chat_handler.conversations_table
        chat_handler.conversations_table = mock_table
        
        try:
            result = chat_handler.delete_conversation(proxy='conv-123')
            
            assert result['success'] is True
            mock_table.delete_item.assert_called_once()
        finally:
            chat_handler.conversations_table = original_table


class TestChatEndpointEdgeCases:
    """Additional edge case tests for POST /chat endpoint."""

    @patch('chat_handler.dynamodb')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_handles_empty_feedback_data(
        self, mock_agg_table, mock_fb_table, mock_converse, mock_dynamodb,
        api_gateway_event, lambda_context
    ):
        """Handles case when no feedback data exists."""
        mock_converse.return_value = 'No feedback data available for analysis.'
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {'Items': []}
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}
        
        from shared.api import clear_categories_cache
        clear_categories_cache()
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'What are the trends?'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'response' in body

    @patch('chat_handler.dynamodb')
    @patch('shared.converse.converse')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_uses_days_query_parameter(
        self, mock_agg_table, mock_fb_table, mock_converse, mock_dynamodb,
        api_gateway_event, lambda_context
    ):
        """Uses days parameter from query string."""
        mock_converse.return_value = 'Analysis complete.'
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_fb_table.query.return_value = {'Items': []}
        mock_dynamodb.batch_get_item.return_value = {'Responses': {}, 'UnprocessedKeys': {}}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            query_params={'days': '30'},
            body={'message': 'Analyze last 30 days'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['metadata']['days_analyzed'] == 30
