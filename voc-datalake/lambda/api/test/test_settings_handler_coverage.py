"""
Tests for settings_handler.py - coverage for review settings endpoints.
"""
import json
from unittest.mock import patch


class TestGetReviewSettings:
    """Tests for GET /settings/review endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_returns_stored_language(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns the primary_language value stored in DynamoDB."""
        mock_table.get_item.return_value = {
            'Item': {'pk': 'SETTINGS#review', 'sk': 'config', 'primary_language': 'de'}
        }

        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['primary_language'] == 'de'

    @patch('settings_handler.aggregates_table')
    def test_defaults_to_english_when_no_settings_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 'en' when no review settings record exists in DynamoDB."""
        mock_table.get_item.return_value = {}

        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['primary_language'] == 'en'

    @patch('settings_handler.aggregates_table')
    def test_returns_500_with_error_when_dynamodb_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when DynamoDB query fails."""
        mock_table.get_item.side_effect = Exception('DynamoDB error')

        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/review')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body


class TestSaveReviewSettings:
    """Tests for PUT /settings/review endpoint."""

    @patch('settings_handler.aggregates_table')
    def test_saves_supported_language_and_returns_it(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Saves review settings and echoes back the language in response."""
        mock_table.put_item.return_value = {}

        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/review',
            body={'primary_language': 'fr'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['settings']['primary_language'] == 'fr'

        # Verify DynamoDB received the correct item
        mock_table.put_item.assert_called_once()
        stored = mock_table.put_item.call_args.kwargs['Item']
        assert stored['primary_language'] == 'fr'
        assert stored['pk'] == 'SETTINGS#review'
        assert stored['sk'] == 'config'

    @patch('settings_handler.aggregates_table')
    def test_rejects_unsupported_language_with_400(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 400 with error for language codes not in the supported set."""
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/review',
            body={'primary_language': 'xx-invalid'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert 'error' in body
        # DynamoDB should not have been called
        mock_table.put_item.assert_not_called()

    @patch('settings_handler.aggregates_table')
    def test_returns_500_with_error_when_save_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when DynamoDB put fails."""
        mock_table.put_item.side_effect = Exception('DynamoDB error')

        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/review',
            body={'primary_language': 'en'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body


class TestSaveCategoriesError:
    """Tests for PUT /settings/categories error path."""

    @patch('settings_handler.aggregates_table')
    def test_returns_500_with_error_when_save_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 500 with error message when DynamoDB put fails for categories."""
        mock_table.put_item.side_effect = Exception('DynamoDB error')

        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/categories',
            body={'categories': [{'id': 'test', 'name': 'Test'}]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 500
        assert 'error' in body


class TestGetCategoriesError:
    """Tests for GET /settings/categories error path."""

    @patch('settings_handler.aggregates_table')
    def test_returns_empty_categories_with_error_message(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty categories array plus error string when DynamoDB fails."""
        mock_table.get_item.side_effect = Exception('DynamoDB error')

        from settings_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/settings/categories')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # This endpoint degrades gracefully: 200 with empty data + error
        assert response['statusCode'] == 200
        assert body['categories'] == []
        assert 'error' in body
        assert 'Failed' in body['error']
