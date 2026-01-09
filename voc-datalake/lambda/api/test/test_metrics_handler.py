"""
Tests for metrics_handler.py - /feedback/* and /metrics/* endpoints.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestValidateDays:
    """Tests for validate_days helper function."""

    def test_returns_default_when_value_is_none(self):
        """Returns default value when input is None."""
        # Import after env vars are set in conftest
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import validate_days
        
        assert validate_days(None, default=7) == 7

    def test_returns_default_when_value_is_invalid_string(self):
        """Returns default for non-numeric strings."""
        from metrics_handler import validate_days
        
        assert validate_days('invalid', default=7) == 7
        assert validate_days('abc', default=30) == 30

    def test_clamps_to_min_value(self):
        """Clamps values below minimum to min_val."""
        from metrics_handler import validate_days
        
        assert validate_days(-5, default=7, min_val=1) == 1
        assert validate_days(0, default=7, min_val=1) == 1

    def test_clamps_to_max_value(self):
        """Clamps values above maximum to max_val."""
        from metrics_handler import validate_days
        
        assert validate_days(1000, default=7, max_val=365) == 365
        assert validate_days(500, default=7, max_val=365) == 365

    def test_accepts_valid_integer(self):
        """Accepts valid integer within range."""
        from metrics_handler import validate_days
        
        assert validate_days(30, default=7) == 30
        assert validate_days(1, default=7) == 1
        assert validate_days(365, default=7) == 365

    def test_accepts_valid_string_integer(self):
        """Parses valid string integers."""
        from metrics_handler import validate_days
        
        assert validate_days('30', default=7) == 30
        assert validate_days('7', default=30) == 7


class TestValidateLimit:
    """Tests for validate_limit helper function."""

    def test_returns_default_when_value_is_none(self):
        """Returns default value when input is None."""
        from metrics_handler import validate_limit
        
        assert validate_limit(None, default=50) == 50

    def test_clamps_to_max_100(self):
        """Enforces maximum limit of 100."""
        from metrics_handler import validate_limit
        
        assert validate_limit(500, default=50, max_val=100) == 100
        assert validate_limit(150, default=50, max_val=100) == 100

    def test_accepts_valid_limit(self):
        """Accepts valid limit within range."""
        from metrics_handler import validate_limit
        
        assert validate_limit(25, default=50) == 25
        assert validate_limit(100, default=50, max_val=100) == 100


class TestListFeedbackEndpoint:
    """Tests for GET /feedback endpoint."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_empty_list_when_no_feedback_exists(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no feedback in date range."""
        # Arrange
        mock_fb_table.query.return_value = {'Items': []}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'days': '7'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['count'] == 0
        assert body['items'] == []

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_by_source_when_source_param_provided(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context, sample_feedback_items
    ):
        """Filters feedback by source platform using source_platform field."""
        # Arrange - return items only on first query call, empty on subsequent calls
        # This simulates querying by date where items are only in one day
        mock_fb_table.query.side_effect = [
            {'Items': sample_feedback_items},  # First day
            {'Items': []},  # Subsequent days
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
        ]
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'source': 'twitter', 'days': '7'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        # Should filter to only twitter items (1 in sample_feedback_items)
        assert body['count'] == 1
        assert all(item['source_platform'] == 'twitter' for item in body['items'])
        mock_fb_table.query.assert_called()

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_items_within_limit(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Respects limit parameter."""
        # Arrange
        items = [{'feedback_id': str(i), 'date': '2025-01-01'} for i in range(100)]
        mock_fb_table.query.return_value = {'Items': items}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'limit': '10', 'source': 'twitter'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['items']) <= 10


class TestGetSummaryEndpoint:
    """Tests for GET /metrics/summary endpoint."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_summary_metrics_for_period(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns aggregated metrics for specified period."""
        # Arrange
        mock_agg_table.get_item.return_value = {
            'Item': {'count': 50, 'sum': 25.0}
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/metrics/summary', 
            query_params={'days': '7'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'total_feedback' in body
        assert 'period_days' in body
        assert body['period_days'] == 7

    @patch('metrics_handler.aggregates_table')
    def test_returns_zero_totals_when_no_data(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns zero values when no aggregates exist."""
        # Arrange
        mock_agg_table.get_item.return_value = {}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/metrics/summary', 
            query_params={'days': '30'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['total_feedback'] == 0


class TestGetSentimentEndpoint:
    """Tests for GET /metrics/sentiment endpoint."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_returns_sentiment_breakdown(
        self, mock_fb_table, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns sentiment distribution."""
        # Arrange
        def get_item_side_effect(Key):
            pk = Key.get('pk', '')
            if 'positive' in pk:
                return {'Item': {'count': 60}}
            elif 'negative' in pk:
                return {'Item': {'count': 20}}
            elif 'neutral' in pk:
                return {'Item': {'count': 15}}
            elif 'mixed' in pk:
                return {'Item': {'count': 5}}
            return {}
        
        mock_agg_table.get_item.side_effect = get_item_side_effect
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', 
            path='/metrics/sentiment', 
            query_params={'days': '7'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'breakdown' in body
        assert 'positive' in body['breakdown']
        assert 'negative' in body['breakdown']


class TestValidateLimitEdgeCases:
    """Additional tests for validate_limit helper function."""

    def test_returns_default_when_value_is_invalid_string(self):
        """Returns default for non-numeric strings."""
        from metrics_handler import validate_limit
        
        assert validate_limit('invalid', default=50) == 50
        assert validate_limit('abc', default=25) == 25

    def test_clamps_to_min_value(self):
        """Clamps values below minimum."""
        from metrics_handler import validate_limit
        
        assert validate_limit(-5, default=50, min_val=1) == 1
        assert validate_limit(0, default=50, min_val=1) == 1


class TestGetDateRange:
    """Tests for get_date_range helper function."""

    def test_returns_correct_date_range(self):
        """Returns start and end dates for given days."""
        from metrics_handler import get_date_range
        
        start, end = get_date_range(7)
        
        # Verify format
        assert len(start) == 10  # YYYY-MM-DD
        assert len(end) == 10
        assert '-' in start
        assert '-' in end


class TestGetConfiguredCategories:
    """Tests for get_configured_categories helper function."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler._categories_cache', None)
    @patch('metrics_handler._categories_cache_time', None)
    def test_returns_categories_from_settings(self, mock_table):
        """Returns categories from DynamoDB settings."""
        mock_table.get_item.return_value = {
            'Item': {
                'categories': [
                    {'name': 'product'},
                    {'name': 'support'},
                    {'name': 'delivery'}
                ]
            }
        }
        
        from metrics_handler import get_configured_categories
        import metrics_handler
        metrics_handler._categories_cache = None
        metrics_handler._categories_cache_time = None
        
        result = get_configured_categories()
        
        assert 'product' in result
        assert 'support' in result
        assert 'delivery' in result

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler._categories_cache', None)
    @patch('metrics_handler._categories_cache_time', None)
    def test_returns_defaults_when_settings_empty(self, mock_table):
        """Returns default categories when settings are empty."""
        mock_table.get_item.return_value = {}
        
        from metrics_handler import get_configured_categories, DEFAULT_CATEGORIES
        import metrics_handler
        metrics_handler._categories_cache = None
        metrics_handler._categories_cache_time = None
        
        result = get_configured_categories()
        
        assert result == DEFAULT_CATEGORIES

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler._categories_cache', None)
    @patch('metrics_handler._categories_cache_time', None)
    def test_returns_defaults_on_exception(self, mock_table):
        """Returns default categories when DynamoDB fails."""
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        from metrics_handler import get_configured_categories, DEFAULT_CATEGORIES
        import metrics_handler
        metrics_handler._categories_cache = None
        metrics_handler._categories_cache_time = None
        
        result = get_configured_categories()
        
        assert result == DEFAULT_CATEGORIES


class TestDecimalEncoder:
    """Tests for DecimalEncoder JSON encoder."""

    def test_encodes_decimal_as_float(self):
        """Converts Decimal to float in JSON."""
        from decimal import Decimal
        from metrics_handler import DecimalEncoder
        
        data = {'value': Decimal('3.14')}
        result = json.dumps(data, cls=DecimalEncoder)
        
        assert '3.14' in result

    def test_raises_for_non_decimal_types(self):
        """Raises TypeError for unsupported types."""
        from metrics_handler import DecimalEncoder
        
        class CustomType:
            pass
        
        encoder = DecimalEncoder()
        with pytest.raises(TypeError):
            encoder.default(CustomType())


class TestListFeedbackWithFilters:
    """Additional tests for GET /feedback endpoint with various filters."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_by_category_when_category_param_provided(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Filters feedback by category using GSI."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'category': 'product_quality'},
                {'feedback_id': '2', 'category': 'product_quality'}
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'category': 'product_quality', 'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['count'] == 2

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_by_sentiment(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Filters feedback by sentiment label."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'sentiment_label': 'positive', 'date': '2026-01-07'},
                {'feedback_id': '2', 'sentiment_label': 'negative', 'date': '2026-01-07'},
                {'feedback_id': '3', 'sentiment_label': 'positive', 'date': '2026-01-07'}
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'sentiment': 'positive', 'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        # Should filter to only positive items
        assert all(item.get('sentiment_label') == 'positive' for item in body['items'])

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_by_source_and_category(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Filters feedback by both source and category."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'category': 'delivery', 'date': '2026-01-07'},
                {'feedback_id': '2', 'category': 'product', 'date': '2026-01-07'},
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'source': 'twitter', 'category': 'delivery', 'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200


class TestGetUrgentFeedback:
    """Tests for GET /feedback/urgent endpoint."""

    @patch('metrics_handler.feedback_table')
    def test_returns_urgent_feedback_items(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns high-urgency feedback items."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'pk': 'SOURCE#twitter', 'sk': 'FEEDBACK#1', 'urgency': 'high'},
                {'pk': 'SOURCE#trustpilot', 'sk': 'FEEDBACK#2', 'urgency': 'high'}
            ]
        }
        mock_fb_table.get_item.return_value = {
            'Item': {'feedback_id': '1', 'urgency': 'high', 'original_text': 'Urgent issue!', 'date': '2026-01-07'}
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback/urgent')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'items' in body
        assert 'count' in body

    @patch('metrics_handler.feedback_table')
    def test_respects_limit_parameter(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Respects limit parameter for urgent feedback."""
        mock_fb_table.query.return_value = {'Items': []}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/urgent',
            query_params={'limit': '5'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200

    @patch('metrics_handler.feedback_table')
    def test_filters_by_source(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Filters urgent feedback by source platform."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'pk': 'SOURCE#twitter', 'sk': 'FEEDBACK#1'},
                {'pk': 'SOURCE#trustpilot', 'sk': 'FEEDBACK#2'}
            ]
        }
        # Return different items based on pk to simulate filtering
        def get_item_side_effect(Key):
            if Key['pk'] == 'SOURCE#twitter':
                return {'Item': {'feedback_id': '1', 'source_platform': 'twitter', 'date': '2026-01-07'}}
            return {'Item': {'feedback_id': '2', 'source_platform': 'trustpilot', 'date': '2026-01-07'}}
        
        mock_fb_table.get_item.side_effect = get_item_side_effect
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/urgent',
            query_params={'source': 'twitter'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        # Should only return twitter items
        for item in body['items']:
            assert item['source_platform'] == 'twitter'

    @patch('metrics_handler.feedback_table')
    def test_filters_by_sentiment_and_category(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Filters urgent feedback by sentiment and category."""
        mock_fb_table.query.return_value = {
            'Items': [{'pk': 'SOURCE#test', 'sk': 'FEEDBACK#1'}]
        }
        mock_fb_table.get_item.return_value = {
            'Item': {
                'feedback_id': '1',
                'source_platform': 'test',
                'sentiment_label': 'negative',
                'category': 'delivery',
                'date': '2026-01-07'
            }
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/urgent',
            query_params={'sentiment': 'negative', 'category': 'delivery'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['count'] == 1


class TestGetEntities:
    """Tests for GET /feedback/entities endpoint."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_entities_for_source_filter(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns entities when source filter is provided."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'date': '2026-01-07', 'category': 'product', 'problem_summary': 'Product quality issue'},
                {'date': '2026-01-07', 'category': 'delivery', 'problem_summary': 'Late delivery'},
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/entities',
            query_params={'source': 'twitter', 'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'entities' in body
        assert 'categories' in body['entities']
        assert 'issues' in body['entities']

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler._categories_cache', None)
    @patch('metrics_handler._categories_cache_time', None)
    def test_returns_entities_without_source_filter(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns entities from aggregates when no source filter."""
        mock_agg_table.get_item.return_value = {'Item': {'count': 10}}
        mock_agg_table.query.return_value = {'Items': []}
        mock_fb_table.query.return_value = {'Items': []}
        
        import metrics_handler
        metrics_handler._categories_cache = None
        metrics_handler._categories_cache_time = None
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/entities',
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'entities' in body


class TestGetFeedbackById:
    """Tests for GET /feedback/<feedback_id> endpoint."""

    @patch('metrics_handler.feedback_table')
    def test_returns_feedback_item_by_id(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns single feedback item by ID."""
        mock_fb_table.query.return_value = {
            'Items': [{'feedback_id': 'test-123', 'original_text': 'Great product!'}]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/test-123',
            path_params={'feedback_id': 'test-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['feedback_id'] == 'test-123'

    @patch('metrics_handler.feedback_table')
    def test_returns_404_when_feedback_not_found(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns 404 when feedback ID doesn't exist."""
        mock_fb_table.query.return_value = {'Items': []}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/nonexistent',
            path_params={'feedback_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 404


class TestGetSimilarFeedback:
    """Tests for GET /feedback/<feedback_id>/similar endpoint."""

    @patch('metrics_handler.feedback_table')
    def test_returns_similar_feedback_items(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns feedback items similar to the given one."""
        # First query returns the source item
        mock_fb_table.query.side_effect = [
            {'Items': [{'feedback_id': 'test-123', 'category': 'product'}]},
            {'Items': [
                {'feedback_id': 'similar-1', 'category': 'product'},
                {'feedback_id': 'similar-2', 'category': 'product'},
                {'feedback_id': 'test-123', 'category': 'product'},  # Should be excluded
            ]}
        ]
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/test-123/similar',
            path_params={'feedback_id': 'test-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['source_feedback_id'] == 'test-123'
        assert 'items' in body
        # Should not include the source item
        assert all(item['feedback_id'] != 'test-123' for item in body['items'])

    @patch('metrics_handler.feedback_table')
    def test_returns_404_when_source_feedback_not_found(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns 404 when source feedback doesn't exist."""
        mock_fb_table.query.return_value = {'Items': []}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback/nonexistent/similar',
            path_params={'feedback_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 404


class TestGetCategoryMetrics:
    """Tests for GET /metrics/categories endpoint."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_returns_category_breakdown(
        self, mock_fb_table, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns category distribution."""
        def get_item_side_effect(Key):
            pk = Key.get('pk', '')
            if pk == 'SETTINGS#categories':
                return {'Item': {'categories': [{'name': 'product'}, {'name': 'delivery'}]}}
            elif 'product' in pk:
                return {'Item': {'count': 50}}
            elif 'delivery' in pk:
                return {'Item': {'count': 30}}
            return {}
        
        mock_agg_table.get_item.side_effect = get_item_side_effect
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/metrics/categories',
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'categories' in body

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_returns_category_breakdown_for_source(
        self, mock_fb_table, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns category distribution for specific source."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'date': '2026-01-07', 'category': 'product'},
                {'date': '2026-01-07', 'category': 'product'},
                {'date': '2026-01-07', 'category': 'delivery'},
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/metrics/categories',
            query_params={'days': '7', 'source': 'twitter'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'categories' in body


class TestGetSourceMetrics:
    """Tests for GET /metrics/sources endpoint."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_source_breakdown(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns source platform distribution."""
        mock_agg_table.query.return_value = {
            'Items': [
                {'pk': 'METRIC#daily_source#twitter', 'sk': '2026-01-07', 'count': 50},
                {'pk': 'METRIC#daily_source#trustpilot', 'sk': '2026-01-07', 'count': 30},
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/metrics/sources',
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'sources' in body


class TestGetPersonaMetrics:
    """Tests for GET /metrics/personas endpoint."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_persona_breakdown(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns persona distribution."""
        mock_agg_table.query.return_value = {
            'Items': [
                {'pk': 'METRIC#persona#Tech Enthusiast', 'sk': '2026-01-07', 'count': 25},
                {'pk': 'METRIC#persona#Budget Shopper', 'sk': '2026-01-07', 'count': 15},
            ]
        }
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/metrics/personas',
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'personas' in body


class TestGetSentimentWithSource:
    """Additional tests for GET /metrics/sentiment endpoint."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_returns_sentiment_for_specific_source(
        self, mock_fb_table, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns sentiment breakdown for specific source using source_platform field."""
        # Return items with source_platform field - filtering happens in memory
        # Use side_effect to return items only on first call
        test_items = [
            {'date': '2026-01-07', 'sentiment_label': 'positive', 'source_platform': 'twitter'},
            {'date': '2026-01-07', 'sentiment_label': 'positive', 'source_platform': 'twitter'},
            {'date': '2026-01-07', 'sentiment_label': 'negative', 'source_platform': 'twitter'},
            {'date': '2026-01-07', 'sentiment_label': 'positive', 'source_platform': 'trustpilot'},
        ]
        mock_fb_table.query.side_effect = [
            {'Items': test_items},  # First day
            {'Items': []},  # Subsequent days
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
        ]
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/metrics/sentiment',
            query_params={'days': '7', 'source': 'twitter'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        # Should only count twitter items (2 positive, 1 negative)
        assert body['breakdown']['positive'] == 2
        assert body['breakdown']['negative'] == 1
