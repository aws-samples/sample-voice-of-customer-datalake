"""
Tests for chat_stream_handler.py - Streaming chat handler for project AI chat.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestBase64UrlDecode:
    """Tests for base64url_decode helper function."""

    def test_decodes_base64url_string(self):
        """Decodes base64url-encoded string."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from chat_stream_handler import base64url_decode
        
        # "test" in base64url
        encoded = "dGVzdA"
        result = base64url_decode(encoded)
        
        assert result == b'test'

    def test_handles_padding(self):
        """Handles strings that need padding."""
        from chat_stream_handler import base64url_decode
        
        # String without proper padding
        encoded = "dGVzdA"  # Missing padding
        result = base64url_decode(encoded)
        
        assert result == b'test'


class TestDecodeJwtParts:
    """Tests for decode_jwt_parts helper function."""

    def test_decodes_valid_jwt(self):
        """Decodes valid JWT into parts."""
        from chat_stream_handler import decode_jwt_parts
        import base64
        
        # Create a simple JWT structure
        header = base64.urlsafe_b64encode(json.dumps({'alg': 'RS256', 'kid': 'key-1'}).encode()).decode().rstrip('=')
        payload = base64.urlsafe_b64encode(json.dumps({'sub': 'user-123', 'exp': 9999999999}).encode()).decode().rstrip('=')
        signature = base64.urlsafe_b64encode(b'signature').decode().rstrip('=')
        
        token = f"{header}.{payload}.{signature}"
        
        h, p, s = decode_jwt_parts(token)
        
        assert h['alg'] == 'RS256'
        assert p['sub'] == 'user-123'
        assert s is not None

    def test_returns_none_for_invalid_token(self):
        """Returns None for invalid token format."""
        from chat_stream_handler import decode_jwt_parts
        
        h, p, s = decode_jwt_parts('invalid-token')
        
        assert h is None
        assert p is None
        assert s is None

    def test_returns_none_for_malformed_jwt(self):
        """Returns None for malformed JWT."""
        from chat_stream_handler import decode_jwt_parts
        
        h, p, s = decode_jwt_parts('part1.part2')  # Missing third part
        
        assert h is None


class TestValidateCognitoToken:
    """Tests for validate_cognito_token function."""

    @patch('chat_stream_handler.USER_POOL_ID', '')
    def test_skips_validation_when_user_pool_not_configured(self):
        """Skips validation when USER_POOL_ID not configured."""
        from chat_stream_handler import validate_cognito_token
        
        is_valid, error, claims = validate_cognito_token('any-token')
        
        assert is_valid is True
        assert error == ""

    @patch('chat_stream_handler.USER_POOL_ID', 'us-east-1_testpool')
    @patch('chat_stream_handler.get_cognito_jwks')
    def test_rejects_invalid_token_format(self, mock_jwks):
        """Rejects token with invalid format."""
        mock_jwks.return_value = {'keys': []}
        
        from chat_stream_handler import validate_cognito_token
        
        is_valid, error, claims = validate_cognito_token('invalid-token')
        
        assert is_valid is False
        assert 'Invalid token format' in error


class TestValidateAuth:
    """Tests for validate_auth function."""

    def test_returns_error_when_auth_header_missing(self):
        """Returns error when Authorization header is missing."""
        from chat_stream_handler import validate_auth
        
        event = {'headers': {}}
        
        is_valid, error = validate_auth(event)
        
        assert is_valid is False
        assert 'Missing Authorization' in error

    @patch('chat_stream_handler.validate_cognito_token')
    def test_extracts_bearer_token(self, mock_validate):
        """Extracts token from Bearer prefix."""
        mock_validate.return_value = (True, "", {'sub': 'user-123'})
        
        from chat_stream_handler import validate_auth
        
        event = {'headers': {'Authorization': 'Bearer test-token'}}
        
        is_valid, error = validate_auth(event)
        
        assert is_valid is True
        mock_validate.assert_called_once_with('test-token')

    @patch('chat_stream_handler.validate_cognito_token')
    def test_handles_case_insensitive_header(self, mock_validate):
        """Handles case-insensitive Authorization header."""
        mock_validate.return_value = (True, "", {'sub': 'user-123'})
        
        from chat_stream_handler import validate_auth
        
        event = {'headers': {'authorization': 'Bearer test-token'}}
        
        is_valid, error = validate_auth(event)
        
        assert is_valid is True


class TestUnauthorizedResponse:
    """Tests for unauthorized_response helper function."""

    def test_returns_401_status(self):
        """Returns 401 status code."""
        from chat_stream_handler import unauthorized_response
        
        response = unauthorized_response()
        
        assert response['statusCode'] == 401

    def test_includes_www_authenticate_header(self):
        """Includes WWW-Authenticate header."""
        from chat_stream_handler import unauthorized_response
        
        response = unauthorized_response()
        
        assert 'WWW-Authenticate' in response['headers']

    def test_includes_custom_message(self):
        """Includes custom error message."""
        from chat_stream_handler import unauthorized_response
        
        response = unauthorized_response('Custom error')
        body = json.loads(response['body'])
        
        assert body['error'] == 'Custom error'


class TestValidateDays:
    """Tests for validate_days helper function."""

    def test_returns_default_when_value_is_none(self):
        """Returns default value when input is None."""
        from chat_stream_handler import validate_days
        
        assert validate_days(None, default=7) == 7

    def test_clamps_to_min_value(self):
        """Clamps values below minimum."""
        from chat_stream_handler import validate_days
        
        assert validate_days(-5, default=7, min_val=1) == 1

    def test_clamps_to_max_value(self):
        """Clamps values above maximum."""
        from chat_stream_handler import validate_days
        
        assert validate_days(500, default=7, max_val=365) == 365


class TestGetProject:
    """Tests for get_project helper function."""

    @patch('chat_stream_handler.projects_table')
    def test_returns_project_data(self, mock_table):
        """Returns project with personas and documents."""
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'META',
                    'project_id': 'proj-123',
                    'name': 'Test Project'
                },
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'PERSONA#persona-1',
                    'persona_id': 'persona-1',
                    'name': 'Tech User'
                }
            ]
        }
        
        from chat_stream_handler import get_project
        
        result = get_project('proj-123')
        
        assert result['project']['name'] == 'Test Project'
        assert len(result['personas']) == 1

    @patch('chat_stream_handler.projects_table')
    def test_returns_error_when_project_not_found(self, mock_table):
        """Returns error when project doesn't exist."""
        mock_table.query.return_value = {'Items': []}
        
        from chat_stream_handler import get_project
        
        result = get_project('nonexistent')
        
        assert 'error' in result

    @patch('chat_stream_handler.projects_table', None)
    def test_returns_error_when_table_not_configured(self):
        """Returns error when projects table not configured."""
        from chat_stream_handler import get_project
        
        result = get_project('proj-123')
        
        assert 'error' in result


class TestFormatFeedbackForLlm:
    """Tests for format_feedback_for_llm helper function."""

    def test_formats_feedback_items(self):
        """Formats feedback items for LLM context."""
        from chat_stream_handler import format_feedback_for_llm
        
        items = [
            {
                'source_platform': 'twitter',
                'sentiment_label': 'positive',
                'category': 'product',
                'original_text': 'Great product!'
            }
        ]
        
        result = format_feedback_for_llm(items)
        
        assert 'twitter' in result
        assert 'positive' in result
        assert 'Great product!' in result

    def test_returns_placeholder_for_empty_list(self):
        """Returns placeholder for empty feedback list."""
        from chat_stream_handler import format_feedback_for_llm
        
        result = format_feedback_for_llm([])
        
        assert 'No feedback data' in result


class TestHandler:
    """Tests for the main handler function."""

    @patch('chat_stream_handler.validate_auth')
    def test_returns_unauthorized_when_auth_fails(self, mock_auth):
        """Returns 401 when authentication fails."""
        mock_auth.return_value = (False, 'Invalid token')
        
        from chat_stream_handler import handler
        
        event = {'headers': {'Authorization': 'Bearer invalid'}}
        context = MagicMock()
        
        response = handler(event, context)
        
        assert response['statusCode'] == 401

    @patch('chat_stream_handler.bedrock')
    @patch('chat_stream_handler.build_chat_context')
    @patch('chat_stream_handler.validate_auth')
    def test_returns_error_when_project_not_found(self, mock_auth, mock_context, mock_bedrock):
        """Returns 404 when project not found."""
        mock_auth.return_value = (True, "")
        mock_context.return_value = (None, None, {'error': 'Project not found'})
        
        from chat_stream_handler import handler
        
        event = {
            'headers': {'Authorization': 'Bearer valid'},
            'body': json.dumps({'message': 'Hello'}),
            'rawPath': '/projects/nonexistent/chat/stream'
        }
        context = MagicMock()
        
        response = handler(event, context)
        
        assert response['statusCode'] == 404

    @patch('chat_stream_handler.validate_auth')
    def test_returns_error_when_project_id_missing(self, mock_auth):
        """Returns 400 when project_id not in path."""
        mock_auth.return_value = (True, "")
        
        from chat_stream_handler import handler
        
        event = {
            'headers': {'Authorization': 'Bearer valid'},
            'body': json.dumps({'message': 'Hello'}),
            'rawPath': '/invalid/path'
        }
        context = MagicMock()
        
        response = handler(event, context)
        
        assert response['statusCode'] == 400


class TestGetConfiguredCategories:
    """Tests for get_configured_categories function."""

    def test_returns_cached_categories(self):
        """Returns cached categories when cache is valid."""
        import chat_stream_handler
        
        # Set up cache with valid timestamp
        chat_stream_handler._categories_cache = ['cat1', 'cat2']
        chat_stream_handler._categories_cache_time = datetime.now(timezone.utc).timestamp()
        
        result = chat_stream_handler.get_configured_categories()
        
        assert result == ['cat1', 'cat2']
        
        # Clean up
        chat_stream_handler._categories_cache = None
        chat_stream_handler._categories_cache_time = None

    @patch('chat_stream_handler.dynamodb')
    def test_returns_default_categories_on_error(self, mock_dynamodb):
        """Returns default categories when fetch fails."""
        import chat_stream_handler
        chat_stream_handler._categories_cache = None
        chat_stream_handler._categories_cache_time = None
        
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        mock_dynamodb.Table.return_value = mock_table
        
        result = chat_stream_handler.get_configured_categories()
        
        assert result == chat_stream_handler.DEFAULT_CATEGORIES
        
        # Clean up
        chat_stream_handler._categories_cache = None
        chat_stream_handler._categories_cache_time = None
