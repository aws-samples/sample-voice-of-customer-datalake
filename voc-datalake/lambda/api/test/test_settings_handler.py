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



class TestModelSettings:
    """Tests for GET/PUT /settings/model (issue #96)."""

    SONNET = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
    HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

    @patch('settings_handler.aggregates_table')
    def test_get_returns_no_override_and_allowlist_when_unset(
        self, mock_table, api_gateway_event, lambda_context
    ):
        mock_table.get_item.return_value = {}
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/model')
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['model_id'] is None
        assert [m['id'] for m in body['available_models']] == [self.SONNET, self.HAIKU]

    @patch('settings_handler.aggregates_table')
    def test_get_returns_configured_override(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {'Item': {'model_id': self.HAIKU}}
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/model')
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['model_id'] == self.HAIKU

    @patch('settings_handler.aggregates_table')
    def test_get_ignores_non_allowlisted_stored_value(
        self, mock_table, api_gateway_event, lambda_context
    ):
        mock_table.get_item.return_value = {'Item': {'model_id': 'anthropic.retired-model'}}
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/model')
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['model_id'] is None

    @patch('settings_handler.aggregates_table')
    def test_put_saves_allowlisted_override(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/model', body={'model_id': self.HAIKU},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body == {'success': True, 'model_id': self.HAIKU}
        saved = mock_table.put_item.call_args.kwargs['Item']
        assert saved['pk'] == 'SETTINGS#model'
        assert saved['model_id'] == self.HAIKU

    @patch('settings_handler.aggregates_table')
    def test_put_null_clears_the_override(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/model', body={'model_id': None},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body == {'success': True, 'model_id': None}
        mock_table.delete_item.assert_called_once_with(
            Key={'pk': 'SETTINGS#model', 'sk': 'config'}
        )
        mock_table.put_item.assert_not_called()

    @pytest.mark.parametrize('payload', [
        {},                                          # missing key (must be explicit)
        {'model_id': ''},                            # empty string
        {'model_id': 'anthropic.claude-instant-v1'}, # not allowlisted
        {'model_id': 'arbitrary-injection'},         # free-form rejected
        {'model_id': 123},                           # wrong type
    ])
    @patch('settings_handler.aggregates_table')
    def test_put_rejects_models_outside_allowlist(
        self, mock_table, payload, api_gateway_event, lambda_context
    ):
        from settings_handler import lambda_handler

        event = api_gateway_event(method='PUT', path='/settings/model', body=payload)
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        mock_table.put_item.assert_not_called()
        mock_table.delete_item.assert_not_called()



class TestModelSettingsAuthorization:
    """PUT /settings/model is org-wide: admins only (review feedback on #154)."""

    @patch('settings_handler.aggregates_table')
    def test_put_rejects_non_admin_callers(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/model',
            body={'model_id': 'global.anthropic.claude-haiku-4-5-20251001-v1:0'},
        )
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        mock_table.put_item.assert_not_called()
        mock_table.delete_item.assert_not_called()

    @patch('settings_handler.aggregates_table')
    def test_put_rejects_callers_without_any_group(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/model', body={'model_id': None},
        )
        del event['requestContext']['authorizer']['claims']['cognito:groups']
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        mock_table.delete_item.assert_not_called()

    @patch('settings_handler.aggregates_table')
    def test_get_stays_available_to_non_admin_users(self, mock_table, api_gateway_event, lambda_context):
        """Reading the active model is harmless; only changing it is gated."""
        mock_table.get_item.return_value = {}
        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/model')
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
