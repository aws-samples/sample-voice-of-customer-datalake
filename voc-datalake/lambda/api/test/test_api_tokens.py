"""
Tests for API token management endpoints in projects_handler.py.
Covers GET/POST/DELETE /projects/{id}/api-tokens.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestListApiTokens:
    """Tests for GET /projects/<project_id>/api-tokens."""

    @patch('projects_handler.get_projects_table')
    def test_returns_empty_list_when_no_tokens(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['tokens'] == []

    @patch('projects_handler.get_projects_table')
    def test_returns_tokens_without_hash(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-123',
                    'sk': 'TOKEN#tok_abc123',
                    'token_id': 'tok_abc123',
                    'name': 'My Token',
                    'scope': 'read',
                    'token_hash': 'should_not_be_returned',
                    'created_at': '2025-01-01T00:00:00+00:00',
                    'project_id': 'proj-123',
                }
            ]
        }
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert len(body['tokens']) == 1
        token = body['tokens'][0]
        assert token['token_id'] == 'tok_abc123'
        assert token['name'] == 'My Token'
        assert token['scope'] == 'read'
        assert token['project_id'] == 'proj-123'
        assert 'token_hash' not in token

    @patch('projects_handler.get_projects_table')
    def test_raises_error_when_table_not_configured(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_get_table.return_value = None

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500


class TestCreateApiToken:
    """Tests for POST /projects/<project_id>/api-tokens."""

    @patch('projects_handler.get_projects_table')
    def test_creates_token_successfully(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'pk': 'PROJECT#proj-123', 'sk': 'META', 'name': 'Test Project'}
        }
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'},
            body={'name': 'CI Token', 'scope': 'read'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['token'].startswith('voc_')
        assert body['token_id'].startswith('tok_')
        assert body['name'] == 'CI Token'
        mock_table.put_item.assert_called_once()

    @patch('projects_handler.get_projects_table')
    def test_rejects_empty_name(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_get_table.return_value = MagicMock()

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'},
            body={'name': '', 'scope': 'read'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('projects_handler.get_projects_table')
    def test_rejects_invalid_scope(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_get_table.return_value = MagicMock()

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Token', 'scope': 'admin'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400

    @patch('projects_handler.get_projects_table')
    def test_rejects_when_project_not_found(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-999/api-tokens',
            path_params={'project_id': 'proj-999'},
            body={'name': 'Token', 'scope': 'read'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404

    @patch('projects_handler.get_projects_table')
    def test_stores_hashed_token(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'pk': 'PROJECT#proj-123', 'sk': 'META'}
        }
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Token', 'scope': 'read-write'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Verify the stored item has a hash, not the raw token
        put_call = mock_table.put_item.call_args
        stored_item = put_call[1]['Item'] if 'Item' in put_call[1] else put_call[0][0]
        assert 'token_hash' in stored_item
        assert stored_item['token_hash'] != body['token']
        assert stored_item['scope'] == 'read-write'

    @patch('projects_handler.get_projects_table')
    def test_defaults_scope_to_read(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'pk': 'PROJECT#proj-123', 'sk': 'META'}
        }
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/projects/proj-123/api-tokens',
            path_params={'project_id': 'proj-123'},
            body={'name': 'Token'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        put_call = mock_table.put_item.call_args
        stored_item = put_call[1]['Item'] if 'Item' in put_call[1] else put_call[0][0]
        assert stored_item['scope'] == 'read'


class TestDeleteApiToken:
    """Tests for DELETE /projects/<project_id>/api-tokens/<token_id>."""

    @patch('projects_handler.get_projects_table')
    def test_deletes_token_successfully(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'PROJECT#proj-123',
                'sk': 'TOKEN#tok_abc123',
                'token_id': 'tok_abc123',
            }
        }
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/api-tokens/tok_abc123',
            path_params={'project_id': 'proj-123', 'token_id': 'tok_abc123'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_table.delete_item.assert_called_once()

    @patch('projects_handler.get_projects_table')
    def test_returns_404_when_token_not_found(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_get_table.return_value = mock_table

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/api-tokens/tok_missing',
            path_params={'project_id': 'proj-123', 'token_id': 'tok_missing'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 404

    @patch('projects_handler.get_projects_table')
    def test_raises_error_when_table_not_configured(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        mock_get_table.return_value = None

        from projects_handler import lambda_handler

        event = api_gateway_event(
            method='DELETE',
            path='/projects/proj-123/api-tokens/tok_abc',
            path_params={'project_id': 'proj-123', 'token_id': 'tok_abc'}
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500


class TestHashToken:
    """Tests for _hash_token helper."""

    def test_produces_consistent_hash(self):
        from projects_handler import _hash_token
        assert _hash_token('voc_abc123') == _hash_token('voc_abc123')

    def test_different_tokens_produce_different_hashes(self):
        from projects_handler import _hash_token
        assert _hash_token('voc_abc') != _hash_token('voc_xyz')
