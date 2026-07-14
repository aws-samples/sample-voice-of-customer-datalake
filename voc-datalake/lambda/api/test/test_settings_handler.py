"""
Tests for settings_handler.py - /settings/* endpoints.
Manages brand configuration and categories.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestGetBrandSettings:
    """Tests for GET /settings/brand endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_returns_brand_settings_when_exists(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns brand configuration from DynamoDB."""
        # Arrange
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#brand',
                'sk': 'config',
                'brand_name': 'TestBrand',
                'brand_handles': ['@testbrand', '@test'],
                'hashtags': ['#testbrand', '#test'],
                'urls_to_track': ['https://example.com']
            }
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from settings_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/settings/brand')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['brand_name'] == 'TestBrand'
        assert body['brand_handles'] == ['@testbrand', '@test']
        assert body['hashtags'] == ['#testbrand', '#test']
        assert body['urls_to_track'] == ['https://example.com']

    @patch('settings_handler.aggregates_table')
    def test_returns_empty_defaults_when_no_settings_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty defaults when no brand settings configured."""
        # Arrange
        mock_table.get_item.return_value = {}
        
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/brand')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['brand_name'] == ''
        assert body['brand_handles'] == []
        assert body['hashtags'] == []
        assert body['urls_to_track'] == []

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_dynamodb_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error message when DynamoDB query fails."""
        # Arrange
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/brand')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body


class TestSaveBrandSettings:
    """Tests for PUT /settings/brand endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_saves_brand_settings_successfully(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Saves brand configuration to DynamoDB."""
        # Arrange
        mock_table.put_item.return_value = {}
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/settings/brand',
            body={
                'brand_name': 'NewBrand',
                'brand_handles': ['@newbrand'],
                'hashtags': ['#newbrand'],
                'urls_to_track': ['https://newbrand.com']
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['settings']['brand_name'] == 'NewBrand'
        mock_table.put_item.assert_called_once()

    @patch('settings_handler.aggregates_table')
    def test_handles_partial_brand_settings(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Saves partial brand settings with defaults for missing fields."""
        # Arrange
        mock_table.put_item.return_value = {}
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/settings/brand',
            body={'brand_name': 'PartialBrand'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['settings']['brand_name'] == 'PartialBrand'
        assert body['settings']['brand_handles'] == []

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_save_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when DynamoDB put fails."""
        # Arrange
        mock_table.put_item.side_effect = Exception('DynamoDB error')
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/settings/brand',
            body={'brand_name': 'FailBrand'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body


class TestGetCategoriesConfig:
    """Tests for GET /settings/categories endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_returns_categories_when_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns categories configuration from DynamoDB."""
        # Arrange
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#categories',
                'sk': 'config',
                'categories': [
                    {'id': 'product', 'name': 'Product', 'subcategories': []},
                    {'id': 'service', 'name': 'Service', 'subcategories': []}
                ],
                'updated_at': '2025-01-01T00:00:00Z'
            }
        }
        
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/categories')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['categories']) == 2
        assert body['categories'][0]['id'] == 'product'

    @patch('settings_handler.aggregates_table')
    def test_returns_empty_categories_when_none_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no categories configured."""
        # Arrange
        mock_table.get_item.return_value = {}
        
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/categories')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['categories'] == []


class TestSaveCategoriesConfig:
    """Tests for PUT /settings/categories endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_saves_categories_successfully(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Saves categories configuration to DynamoDB."""
        # Arrange
        mock_table.put_item.return_value = {}
        categories = [
            {'id': 'product', 'name': 'Product', 'subcategories': []},
            {'id': 'service', 'name': 'Service', 'subcategories': []}
        ]
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/settings/categories',
            body={'categories': categories}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert 'Saved 2 categories' in body['message']


class TestGenerateCategories:
    """Tests for POST /settings/categories/generate endpoint."""

    @patch('shared.converse.converse')
    @patch('settings_handler.aggregates_table')
    def test_generates_categories_from_description(
        self, mock_table, mock_converse,
        api_gateway_event, lambda_context
    ):
        """Generates categories using Bedrock LLM."""
        # Arrange - mock the converse function to return JSON with categories
        mock_converse.return_value = '{"categories": [{"id": "product_quality", "name": "product_quality", "description": "Product Quality", "subcategories": []}]}'
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/settings/categories/generate',
            body={'company_description': 'We sell software products for developers.'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert len(body['categories']) > 0
        mock_converse.assert_called_once()

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_description_missing(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when company description not provided."""
        # Arrange
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/settings/categories/generate',
            body={'company_description': ''}  # Empty description
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()

    @patch('shared.converse.converse')
    @patch('settings_handler.aggregates_table')
    def test_handles_bedrock_failure_gracefully(
        self, mock_table, mock_converse, api_gateway_event, lambda_context
    ):
        """Returns error when Bedrock service fails."""
        # Arrange - mock converse to raise an exception
        mock_converse.side_effect = Exception('Bedrock unavailable')
        
        from settings_handler import lambda_handler
        event = api_gateway_event(
            method='POST',
            path='/settings/categories/generate',
            body={'company_description': 'Test company'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body



class TestResolvedProblems:
    """Tests for GET/PUT /settings/resolved-problems (issue #66)."""

    @patch('settings_handler.aggregates_table')
    def test_get_returns_resolved_map(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'SETTINGS#resolved_problems',
                'sk': 'config',
                'resolved': {'delivery|general|late orders': {'resolved_at': '2026-07-01T00:00:00+00:00'}},
            }
        }
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert 'delivery|general|late orders' in body['resolved']

    @patch('settings_handler.aggregates_table')
    def test_get_returns_empty_map_when_unset(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {}
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['resolved'] == {}

    @patch('settings_handler.aggregates_table')
    def test_put_resolve_sets_nested_key_atomically(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'delivery|general|late orders', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body == {'success': True, 'key': 'delivery|general|late orders', 'resolved': True}
        # Two updates: ensure the parent map exists, then set the nested key.
        assert mock_table.update_item.call_count == 2
        ensure, set_call = mock_table.update_item.call_args_list
        assert 'if_not_exists' in ensure.kwargs['UpdateExpression']
        assert set_call.kwargs['UpdateExpression'] == 'SET #r.#k = :entry'
        assert set_call.kwargs['ExpressionAttributeNames']['#k'] == 'delivery|general|late orders'
        assert 'resolved_at' in set_call.kwargs['ExpressionAttributeValues'][':entry']

    @patch('settings_handler.aggregates_table')
    def test_put_unresolve_removes_nested_key(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'delivery|general|late orders', 'resolved': False},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        remove_call = mock_table.update_item.call_args_list[-1]
        assert remove_call.kwargs['UpdateExpression'] == 'REMOVE #r.#k'

    @pytest.mark.parametrize('payload', [
        {'resolved': True},                          # missing key
        {'key': '', 'resolved': True},               # empty key
        {'key': '  ', 'resolved': True},             # whitespace key
        {'key': 'x' * 501, 'resolved': True},        # oversized key
        {'key': 'ok', 'resolved': 'yes'},            # non-boolean resolved
        {'key': 'ok'},                               # missing resolved
    ])
    @patch('settings_handler.aggregates_table')
    def test_put_rejects_invalid_payloads(self, mock_table, payload, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems', body=payload,
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        mock_table.update_item.assert_not_called()



class TestResolvedProblemsCap:
    """The single config item is bounded (review feedback on #153)."""

    @patch('settings_handler.aggregates_table')
    def test_rejects_new_entries_beyond_the_cap(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import MAX_RESOLVED_ENTRIES, lambda_handler

        full_map = {f'cat|sub|problem {i}': {'resolved_at': 'x'} for i in range(MAX_RESOLVED_ENTRIES)}
        mock_table.get_item.return_value = {'Item': {'resolved': full_map}}

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|one too many', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        # Only the ensure-parent update ran; the SET never happened.
        update_expressions = [
            c.kwargs['UpdateExpression'] for c in mock_table.update_item.call_args_list
        ]
        assert 'SET #r.#k = :entry' not in update_expressions

    @patch('settings_handler.aggregates_table')
    def test_overwriting_an_existing_key_is_allowed_at_the_cap(
        self, mock_table, api_gateway_event, lambda_context
    ):
        from settings_handler import MAX_RESOLVED_ENTRIES, lambda_handler

        full_map = {f'cat|sub|problem {i}': {'resolved_at': 'x'} for i in range(MAX_RESOLVED_ENTRIES)}
        mock_table.get_item.return_value = {'Item': {'resolved': full_map}}

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 0', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200

    @patch('settings_handler.aggregates_table')
    def test_unresolve_is_never_capped(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import MAX_RESOLVED_ENTRIES, lambda_handler

        full_map = {f'cat|sub|problem {i}': {'resolved_at': 'x'} for i in range(MAX_RESOLVED_ENTRIES)}
        mock_table.get_item.return_value = {'Item': {'resolved': full_map}}

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 3', 'resolved': False},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
