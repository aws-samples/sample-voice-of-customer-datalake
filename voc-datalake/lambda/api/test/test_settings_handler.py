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
    def test_put_resolve_is_a_single_conditional_write(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'delivery|general|late orders', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body == {'success': True, 'key': 'delivery|general|late orders', 'resolved': True}
        # Steady state: exactly ONE write, cap enforced on the same call.
        assert mock_table.update_item.call_count == 1
        set_call = mock_table.update_item.call_args
        assert set_call.kwargs['UpdateExpression'] == 'SET #r.#k = :entry'
        assert set_call.kwargs['ConditionExpression'] == 'attribute_exists(#r.#k) OR size(#r) < :max'
        assert set_call.kwargs['ExpressionAttributeNames']['#k'] == 'delivery|general|late orders'
        assert 'resolved_at' in set_call.kwargs['ExpressionAttributeValues'][':entry']
        # No read-modify-write: the cap does not cost a get_item.
        mock_table.get_item.assert_not_called()

    @patch('settings_handler.aggregates_table')
    def test_first_ever_resolve_materializes_the_parent_map(self, mock_table, api_gateway_event, lambda_context):
        from botocore.exceptions import ClientError
        from settings_handler import lambda_handler

        missing_parent = ClientError(
            {'Error': {'Code': 'ValidationException', 'Message': 'document path invalid'}},
            'UpdateItem',
        )
        # First SET fails (no parent map) -> ensure-parent -> retry succeeds.
        mock_table.update_item.side_effect = [missing_parent, {}, {}]

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'delivery|general|late orders', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert mock_table.update_item.call_count == 3
        exprs = [c.kwargs['UpdateExpression'] for c in mock_table.update_item.call_args_list]
        assert exprs == ['SET #r.#k = :entry', 'SET #r = if_not_exists(#r, :empty)', 'SET #r.#k = :entry']

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
        {'key': 'x' * 256, 'resolved': True},        # over the char cap
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
    """The entry cap is atomic — enforced by ConditionExpression on the same
    write, not a read-then-check (review feedback on #153)."""

    @staticmethod
    def _cap_failure():
        from botocore.exceptions import ClientError
        return ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'cap'}},
            'UpdateItem',
        )

    @patch('settings_handler.aggregates_table')
    def test_rejects_new_entries_beyond_the_cap(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        # Both the first attempt and the post-ensure retry fail the condition:
        # the map genuinely holds MAX_RESOLVED_ENTRIES other keys.
        mock_table.update_item.side_effect = [self._cap_failure(), {}, self._cap_failure()]

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|one too many', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert 'limit reached' in body['error']

    @patch('settings_handler.aggregates_table')
    def test_condition_allows_overwriting_existing_keys_at_the_cap(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """attribute_exists(#r.#k) short-circuits the size check, so
        re-resolving an already-resolved problem never trips the cap."""
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 0', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        condition = mock_table.update_item.call_args.kwargs['ConditionExpression']
        assert condition.startswith('attribute_exists(#r.#k)')

    @patch('settings_handler.aggregates_table')
    def test_unresolve_is_never_capped_and_tolerates_missing_map(
        self, mock_table, api_gateway_event, lambda_context
    ):
        from botocore.exceptions import ClientError
        from settings_handler import lambda_handler

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ValidationException', 'Message': 'document path invalid'}},
            'UpdateItem',
        )

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 3', 'resolved': False},
        )
        response = lambda_handler(event, lambda_context)

        # Missing parent map == nothing to remove == success.
        assert response['statusCode'] == 200



class TestResolvedProblemsRoundThree:
    """Third review round: narrowed exception swallow + UTF-8 byte cap."""

    @patch('settings_handler.aggregates_table')
    def test_unresolve_does_not_swallow_real_validation_errors(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Only the missing-document-path variant is a no-op; other
        ValidationExceptions are genuine failures, not success."""
        from botocore.exceptions import ClientError
        from settings_handler import lambda_handler

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ValidationException',
                       'Message': 'ExpressionAttributeNames contains invalid value'}},
            'UpdateItem',
        )

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem', 'resolved': False},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 500

    @patch('settings_handler.aggregates_table')
    def test_rejects_keys_over_the_utf8_byte_cap(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """CJK text triples the byte cost: 200 chars under the char cap can
        still blow the byte budget that sizes the 400KB item math."""
        from settings_handler import lambda_handler

        cjk_key = '배송|일반|' + ('느린 배송 문제 ' * 12)  # under 255 chars, over 255 bytes
        assert len(cjk_key) <= 255
        assert len(cjk_key.encode('utf-8')) > 255

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': cjk_key, 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        mock_table.update_item.assert_not_called()
