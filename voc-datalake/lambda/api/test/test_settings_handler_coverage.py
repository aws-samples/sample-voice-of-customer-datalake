"""
Additional coverage tests for settings_handler.py.
Covers: review settings, no-table paths, save errors, generate edge cases.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestGetBrandSettingsNoTable:
    """Cover aggregates_table=None path."""

    @patch('settings_handler.aggregates_table', None)
    def test_raises_config_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/brand')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
        body = json.loads(response['body'])
        assert 'error' in body


class TestSaveBrandSettingsNoTable:
    """Cover aggregates_table=None path for save."""

    @patch('settings_handler.aggregates_table', None)
    def test_raises_config_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/brand', body={'brand_name': 'X'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetReviewSettings:
    """Cover GET /settings/review endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_returns_review_settings_when_exists(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {
            'Item': {'pk': 'SETTINGS#review', 'sk': 'config', 'primary_language': 'es'}
        }
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['primary_language'] == 'es'

    @patch('settings_handler.aggregates_table')
    def test_returns_default_when_no_review_settings(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {}
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['primary_language'] == 'en'

    @patch('settings_handler.aggregates_table', None)
    def test_raises_config_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_dynamodb_fails(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestSaveReviewSettings:
    """Cover PUT /settings/review endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_saves_review_settings_successfully(self, mock_table, api_gateway_event, lambda_context):
        mock_table.put_item.return_value = {}
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/review', body={'primary_language': 'fr'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['settings']['primary_language'] == 'fr'

    @patch('settings_handler.aggregates_table')
    def test_rejects_unsupported_language(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/review', body={'primary_language': 'xx-invalid'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400
        body = json.loads(response['body'])
        assert 'error' in body

    @patch('settings_handler.aggregates_table', None)
    def test_raises_config_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/review', body={'primary_language': 'en'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_save_fails(self, mock_table, api_gateway_event, lambda_context):
        mock_table.put_item.side_effect = Exception('DynamoDB error')
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/review', body={'primary_language': 'en'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetCategoriesConfigNoTable:
    """Cover aggregates_table=None path for categories."""

    @patch('settings_handler.aggregates_table', None)
    def test_returns_empty_with_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/categories')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['categories'] == []
        assert 'error' in body

    @patch('settings_handler.aggregates_table')
    def test_returns_error_string_when_dynamodb_fails(self, mock_table, api_gateway_event, lambda_context):
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        from settings_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/settings/categories')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['categories'] == []
        assert 'error' in body


class TestSaveCategoriesConfigNoTable:
    """Cover aggregates_table=None path for save categories."""

    @patch('settings_handler.aggregates_table', None)
    def test_raises_config_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/categories', body={'categories': []})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_save_fails(self, mock_table, api_gateway_event, lambda_context):
        mock_table.put_item.side_effect = Exception('DynamoDB error')
        from settings_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/settings/categories', body={'categories': [{'id': 'x'}]})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGenerateCategoriesEdgeCases:
    """Cover edge cases in generate_categories."""

    @patch('shared.converse.converse')
    @patch('settings_handler.aggregates_table')
    def test_returns_error_when_json_not_parseable(self, mock_table, mock_converse, api_gateway_event, lambda_context):
        mock_converse.return_value = 'No JSON here, just plain text'
        from settings_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/settings/categories/generate', body={'company_description': 'Test'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
