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
        """Filters feedback by source platform."""
        # Arrange
        twitter_items = [i for i in sample_feedback_items if i['source_platform'] == 'twitter']
        mock_fb_table.query.return_value = {'Items': twitter_items}
        
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
        assert body['count'] == 1
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
