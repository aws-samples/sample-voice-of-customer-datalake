"""
Tests for chat_handler.py - /chat/* endpoints with Bedrock AI integration.
"""
import json
import pytest
from unittest.mock import patch, MagicMock

# Bedrock model ID used in production
BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'


class TestChatEndpoint:
    """Tests for POST /chat endpoint."""

    @patch('chat_handler.get_bedrock_client')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_ai_response_for_valid_message(
        self, mock_agg_table, mock_fb_table, mock_get_bedrock,
        mock_bedrock_response, api_gateway_event, lambda_context
    ):
        """Returns AI-generated response based on feedback data."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = mock_bedrock_response(
            'Based on the feedback data, customers are generally satisfied with the product quality.'
        )
        mock_get_bedrock.return_value = mock_bedrock
        mock_agg_table.get_item.return_value = {'Item': {'count': 100}}
        mock_fb_table.query.return_value = {'Items': []}
        
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
        mock_bedrock.invoke_model.assert_called_once()

    @patch('chat_handler.get_bedrock_client')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_uses_correct_bedrock_model_id(
        self, mock_agg_table, mock_fb_table, mock_get_bedrock,
        mock_bedrock_response, api_gateway_event, lambda_context
    ):
        """Verifies Claude Sonnet 4.5 model is used."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = mock_bedrock_response('Test response')
        mock_get_bedrock.return_value = mock_bedrock
        mock_agg_table.get_item.return_value = {}
        mock_fb_table.query.return_value = {'Items': []}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat',
            body={'message': 'test'}
        )
        
        # Act
        lambda_handler(event, lambda_context)
        
        # Assert
        call_kwargs = mock_bedrock.invoke_model.call_args.kwargs
        assert call_kwargs['modelId'] == BEDROCK_MODEL_ID

    @patch('chat_handler.get_bedrock_client')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_returns_graceful_error_when_bedrock_fails(
        self, mock_agg_table, mock_fb_table, mock_get_bedrock,
        api_gateway_event, lambda_context
    ):
        """Returns graceful error message when Bedrock service fails."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception('Service unavailable')
        mock_get_bedrock.return_value = mock_bedrock
        mock_agg_table.get_item.return_value = {'Item': {'count': 50}}
        mock_fb_table.query.return_value = {'Items': []}
        
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

    @patch('chat_handler.get_bedrock_client')
    @patch('chat_handler.feedback_table')
    @patch('chat_handler.aggregates_table')
    def test_includes_feedback_sources_in_response(
        self, mock_agg_table, mock_fb_table, mock_get_bedrock,
        mock_bedrock_response, sample_feedback_items, api_gateway_event, lambda_context
    ):
        """Includes source feedback items in response."""
        # Arrange
        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = mock_bedrock_response('Analysis complete.')
        mock_get_bedrock.return_value = mock_bedrock
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_fb_table.query.return_value = {'Items': sample_feedback_items}
        
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


class TestChatConversationsEndpoint:
    """Tests for /chat/conversations/* endpoints."""

    @patch('chat_handler.conversations_table')
    def test_returns_empty_list_when_no_conversations(
        self, mock_conv_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no conversations exist."""
        # Arrange
        mock_conv_table.query.return_value = {'Items': []}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/chat/conversations/_list'
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['conversations'] == []

    @patch('chat_handler.conversations_table')
    def test_returns_conversation_list(
        self, mock_conv_table, api_gateway_event, lambda_context
    ):
        """Returns list of conversations with metadata."""
        # Arrange
        mock_conv_table.query.return_value = {
            'Items': [
                {
                    'conversation_id': 'conv-123',
                    'title': 'Product Feedback Analysis',
                    'messages': [{'role': 'user', 'content': 'test'}],
                    'created_at': '2025-01-01T00:00:00Z',
                    'updated_at': '2025-01-01T01:00:00Z',
                }
            ]
        }
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/chat/conversations/_list'
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['conversations']) == 1
        assert body['conversations'][0]['id'] == 'conv-123'
        assert body['conversations'][0]['title'] == 'Product Feedback Analysis'

    @patch('chat_handler.conversations_table')
    def test_saves_new_conversation(
        self, mock_conv_table, api_gateway_event, lambda_context
    ):
        """Saves new conversation to DynamoDB."""
        # Arrange
        mock_conv_table.put_item.return_value = {}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/chat/conversations/new',
            body={
                'title': 'New Analysis',
                'messages': [
                    {'role': 'user', 'content': 'Hello'},
                    {'role': 'assistant', 'content': 'Hi there!'}
                ]
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'id' in body
        mock_conv_table.put_item.assert_called_once()

    @patch('chat_handler.conversations_table')
    def test_deletes_conversation(
        self, mock_conv_table, api_gateway_event, lambda_context
    ):
        """Deletes conversation from DynamoDB."""
        # Arrange
        mock_conv_table.delete_item.return_value = {}
        
        from chat_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/chat/conversations/conv-123'
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_conv_table.delete_item.assert_called_once()


class TestValidateDaysInChat:
    """Tests for validate_days helper in chat handler."""

    def test_defaults_to_7_days(self):
        """Uses 7 days as default period."""
        from chat_handler import validate_days
        
        assert validate_days(None) == 7

    def test_accepts_valid_days_parameter(self):
        """Accepts valid days within range."""
        from chat_handler import validate_days
        
        assert validate_days('30') == 30
        assert validate_days(14) == 14
