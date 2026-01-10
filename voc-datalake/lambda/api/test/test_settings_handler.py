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
        
        # Assert
        assert response['statusCode'] == 200
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
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False


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
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'required' in body['message'].lower()

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
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
