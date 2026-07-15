"""
Tests for settings_handler.py - /settings/* endpoints.
Manages brand configuration and categories.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta, timezone


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
        # the map genuinely holds MAX_RESOLVED_ENTRIES other keys — and none
        # of them are expired, so pruning (issue #159) frees nothing.
        mock_table.update_item.side_effect = [self._cap_failure(), {}, self._cap_failure()]
        mock_table.get_item.return_value = {'Item': {'resolved': {}}}

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
        """Missing parent map surfaces as a FAILED CONDITION (stable error
        code), not as message-text sniffing on ValidationException."""
        from botocore.exceptions import ClientError
        from settings_handler import lambda_handler

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no map'}},
            'UpdateItem',
        )

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem 3', 'resolved': False},
        )
        response = lambda_handler(event, lambda_context)

        # Missing parent map == nothing to remove == success.
        assert response['statusCode'] == 200
        assert mock_table.update_item.call_args.kwargs['ConditionExpression'] == 'attribute_exists(#r)'



class TestResolvedProblemsExpiry:
    """Entry expiry and cap-pressure pruning (issue #159).

    Resolution keys are client-derived from similarity groups, so a key can
    be orphaned forever when its group re-forms differently. Entries expire
    after RESOLVED_PROBLEMS_TTL_DAYS: GET filters them from responses, and a
    resolve that hits the entry cap prunes them from storage before the cap
    error is surfaced.
    """

    @staticmethod
    def _entry(days_old: int) -> dict:
        return {'resolved_at': (datetime.now(timezone.utc) - timedelta(days=days_old)).isoformat()}

    @staticmethod
    def _cap_failure():
        from botocore.exceptions import ClientError
        return ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'cap'}},
            'UpdateItem',
        )

    @patch('settings_handler.aggregates_table')
    def test_get_filters_expired_entries(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        mock_table.get_item.return_value = {
            'Item': {'resolved': {
                'cat|sub|fresh': self._entry(days_old=1),
                'cat|sub|ancient': self._entry(days_old=181),
            }}
        }

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert 'cat|sub|fresh' in body['resolved']
        assert 'cat|sub|ancient' not in body['resolved']

    @patch('settings_handler.RESOLVED_PROBLEMS_TTL_DAYS', 0)
    @patch('settings_handler.aggregates_table')
    def test_ttl_zero_disables_expiry(self, mock_table, api_gateway_event, lambda_context):
        from settings_handler import lambda_handler

        mock_table.get_item.return_value = {
            'Item': {'resolved': {'cat|sub|ancient': self._entry(days_old=5000)}}
        }

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert 'cat|sub|ancient' in body['resolved']

    @patch('settings_handler.aggregates_table')
    def test_malformed_entries_count_as_expired(self, mock_table, api_gateway_event, lambda_context):
        """Entries without a comparable resolved_at can never be displayed or
        aged out normally — they must not hold cap slots forever."""
        from settings_handler import lambda_handler

        mock_table.get_item.return_value = {
            'Item': {'resolved': {
                'cat|sub|no-date': {},
                'cat|sub|wrong-type': {'resolved_at': 12345},
                'cat|sub|fresh': self._entry(days_old=1),
            }}
        }

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert list(body['resolved']) == ['cat|sub|fresh']

    @patch('settings_handler.aggregates_table')
    def test_cap_pressure_prunes_expired_then_succeeds(self, mock_table, api_gateway_event, lambda_context):
        """At the cap, expired entries are reclaimed and the resolve retried —
        the user only sees the cap error when every entry is live."""
        from settings_handler import lambda_handler

        mock_table.update_item.side_effect = [
            self._cap_failure(),  # initial conditional SET
            {},                   # ensure parent map
            self._cap_failure(),  # post-ensure retry: genuinely at cap
            {},                   # pruning REMOVE
            {},                   # final SET succeeds in the freed slot
        ]
        mock_table.get_item.return_value = {
            'Item': {'resolved': {
                'cat|sub|orphaned': self._entry(days_old=200),
                'cat|sub|live': self._entry(days_old=3),
            }}
        }

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|new problem', 'resolved': True},
        )
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        remove_call = mock_table.update_item.call_args_list[3]
        assert remove_call.kwargs['UpdateExpression'].startswith('REMOVE ')
        # Only the expired key is pruned; the live one keeps its slot.
        assert 'cat|sub|orphaned' in remove_call.kwargs['ExpressionAttributeNames'].values()
        assert 'cat|sub|live' not in remove_call.kwargs['ExpressionAttributeNames'].values()

    @patch('settings_handler.aggregates_table')
    def test_get_tolerates_malformed_resolved_attribute(self, mock_table, api_gateway_event, lambda_context):
        """Non-dict storage under 'resolved' degrades to an empty map, not a 500
        (symmetry with the prune path's guard)."""
        from settings_handler import lambda_handler

        mock_table.get_item.return_value = {'Item': {'resolved': 'corrupted'}}

        event = api_gateway_event(method='GET', path='/settings/resolved-problems')
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['resolved'] == {}

    def test_ttl_env_parse_falls_back_on_garbage(self):
        """A console typo in RESOLVED_PROBLEMS_TTL_DAYS must not crash the
        whole settings Lambda at import — boundary validation."""
        from settings_handler import _parse_ttl_days

        assert _parse_ttl_days('180d') == 180
        assert _parse_ttl_days('') == 180
        assert _parse_ttl_days(None) == 180
        assert _parse_ttl_days('30') == 30
        assert _parse_ttl_days('0') == 0

    @patch('settings_handler.aggregates_table')
    def test_prune_chunks_large_removals(self, mock_table):
        """REMOVE expressions are chunked so they stay far below DynamoDB's
        4KB expression limit even with hundreds of stale keys."""
        from settings_handler import _prune_expired_entries

        stale = {f'cat|sub|old {i}': self._entry(days_old=300) for i in range(45)}
        mock_table.get_item.return_value = {'Item': {'resolved': stale}}
        mock_table.update_item.return_value = {}

        pruned = _prune_expired_entries()

        assert pruned == 45
        assert mock_table.update_item.call_count == 3  # 20 + 20 + 5
        for call in mock_table.update_item.call_args_list:
            aliases = [k for k in call.kwargs['ExpressionAttributeNames'] if k != '#r']
            assert len(aliases) <= 20


class TestResolvedProblemsKeyEncoding:
    """Key byte-cap validation and unresolve error semantics."""

    @patch('settings_handler.aggregates_table')
    def test_unresolve_does_not_swallow_real_validation_errors(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """ValidationExceptions are genuine failures, not success — only the
        failed parent-map condition (stable code) is the no-op."""
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


class TestResolvedProblemsSurrogates:
    """Unpaired surrogates must 400, not 500 (review feedback on #153).

    JSON carries lone surrogates ("\\ud800") happily; encoding them to UTF-8
    raises, which without the guard would surface as a 500 from the handler
    or the DynamoDB client.
    """

    @patch('settings_handler.aggregates_table')
    def test_lone_surrogate_key_is_a_clean_400(self, mock_table, api_gateway_event, lambda_context):
        import json as json_module
        from settings_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/settings/resolved-problems',
            body={'key': 'cat|sub|problem', 'resolved': True},
        )
        # Inject the lone surrogate at the raw-JSON layer, exactly as a
        # hostile/buggy client would send it.
        event['body'] = json_module.dumps(
            {'key': 'cat|sub|broken \ud83d', 'resolved': True}, ensure_ascii=True
        )
        response = lambda_handler(event, lambda_context)
        body = json_module.loads(response['body'])

        assert response['statusCode'] == 400
        assert 'surrogate' in body['error']
        mock_table.update_item.assert_not_called()
