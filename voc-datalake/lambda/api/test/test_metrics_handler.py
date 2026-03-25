"""
Tests for metrics_handler.py - /feedback/* and /metrics/* endpoints.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestListFeedbackEndpoint:
    """Tests for GET /feedback endpoint."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_empty_list_when_no_feedback_exists(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no feedback in date range."""
        mock_fb_table.query.return_value = {'Items': []}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['count'] == 0
        assert body['items'] == []

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_by_source_when_source_param_provided(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context, sample_feedback_items
    ):
        """Filters feedback by source platform."""
        mock_fb_table.query.side_effect = [
            {'Items': sample_feedback_items},
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
            {'Items': []},
        ]
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'source': 'webscraper', 'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert all(item['source_platform'] == 'webscraper' for item in body['items'])

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_items_within_limit(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Respects limit parameter."""
        items = [{'feedback_id': str(i), 'date': '2025-01-01'} for i in range(100)]
        mock_fb_table.query.return_value = {'Items': items}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/feedback', 
            query_params={'limit': '10', 'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert len(body['items']) <= 10


class TestGetSummaryEndpoint:
    """Tests for GET /metrics/summary endpoint."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_summary_metrics_for_period(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns aggregated metrics for specified period."""
        mock_agg_table.get_item.return_value = {
            'Item': {'count': 50, 'sum': 25.0}
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/metrics/summary', 
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'total_feedback' in body
        assert 'period_days' in body
        assert body['period_days'] == 7

    @patch('metrics_handler.aggregates_table')
    def test_returns_zero_totals_when_no_data(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns zero values when no aggregates exist."""
        mock_agg_table.get_item.return_value = {}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/metrics/summary', 
            query_params={'days': '30'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
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
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/metrics/sentiment', 
            query_params={'days': '7'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'breakdown' in body
        assert 'positive' in body['breakdown']
        assert 'negative' in body['breakdown']


class TestGetUrgentFeedback:
    """Tests for GET /feedback/urgent endpoint."""

    @patch('metrics_handler.feedback_table')
    def test_returns_urgent_feedback_items(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns high-urgency feedback items."""
        mock_fb_table.query.return_value = {
            'Items': [
                {'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1', 'urgency': 'high'},
                {'pk': 'SOURCE#manual_import', 'sk': 'FEEDBACK#2', 'urgency': 'high'}
            ]
        }
        mock_fb_table.get_item.return_value = {
            'Item': {'feedback_id': '1', 'urgency': 'high', 'original_text': 'Urgent issue!', 'date': '2026-01-07'}
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
                {'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#1'},
                {'pk': 'SOURCE#manual_import', 'sk': 'FEEDBACK#2'}
            ]
        }
        def get_item_side_effect(Key):
            if Key['pk'] == 'SOURCE#webscraper':
                return {'Item': {'feedback_id': '1', 'source_platform': 'webscraper', 'date': '2026-01-07'}}
            return {'Item': {'feedback_id': '2', 'source_platform': 'manual_import', 'date': '2026-01-07'}}
        
        mock_fb_table.get_item.side_effect = get_item_side_effect
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/feedback/urgent',
            query_params={'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        for item in body['items']:
            assert item['source_platform'] == 'webscraper'


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
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        mock_fb_table.query.side_effect = [
            {'Items': [{'feedback_id': 'test-123', 'category': 'product'}]},
            {'Items': [
                {'feedback_id': 'similar-1', 'category': 'product'},
                {'feedback_id': 'similar-2', 'category': 'product'},
                {'feedback_id': 'test-123', 'category': 'product'},
            ]}
        ]
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        assert all(item['feedback_id'] != 'test-123' for item in body['items'])

    @patch('metrics_handler.feedback_table')
    def test_returns_404_when_source_feedback_not_found(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Returns 404 when source feedback doesn't exist."""
        mock_fb_table.query.return_value = {'Items': []}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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


class TestGetSourceMetrics:
    """Tests for GET /metrics/sources endpoint."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_source_breakdown(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns source platform distribution."""
        mock_agg_table.query.return_value = {
            'Items': [
                {'pk': 'METRIC#daily_source#webscraper', 'sk': '2026-01-07', 'count': 50},
                {'pk': 'METRIC#daily_source#manual_import', 'sk': '2026-01-07', 'count': 30},
            ]
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
                {'pk': 'METRIC#persona#TechEnthusiast', 'sk': '2026-01-07', 'count': 25},
                {'pk': 'METRIC#persona#BudgetShopper', 'sk': '2026-01-07', 'count': 15},
            ]
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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


class TestListFeedbackCategoryFiltering:
    """Tests for category filtering in GET /feedback — regression tests for
    the bug where selecting categories on the Categories page returned 0 results."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_single_category_queries_gsi2_and_filters_by_date(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Single category param queries GSI2 and excludes items outside the date range."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        old_date = '2020-01-01'

        mock_fb_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'category': 'ease_of_use', 'date': today},
                {'feedback_id': '2', 'category': 'ease_of_use', 'date': old_date},
            ]
        }

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'category': 'ease_of_use', 'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # Old item should be filtered out by date
        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == '1'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_multiple_comma_separated_categories_returns_items_from_all(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Comma-separated categories query GSI2 for each and merge results."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')

        mock_fb_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'category': 'ease_of_use', 'date': today},
            ]},
            {'Items': [
                {'feedback_id': '2', 'category': 'integration_compatibility', 'date': today},
            ]},
        ]

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'category': 'ease_of_use,integration_compatibility', 'days': '30'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 2
        returned_ids = {item['feedback_id'] for item in body['items']}
        assert returned_ids == {'1', '2'}

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_category_with_source_filters_both(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """When both category and source are provided, items are filtered by both."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')

        # When source is provided, the code queries by date GSI (not category GSI)
        # Return items on first day query, empty for the rest
        mock_fb_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper', 'category': 'delivery', 'date': today},
                {'feedback_id': '2', 'source_platform': 'manual_import', 'category': 'delivery', 'date': today},
                {'feedback_id': '3', 'source_platform': 'webscraper', 'category': 'pricing', 'date': today},
            ]},
        ] + [{'Items': []}] * 6  # remaining 6 days return empty

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'category': 'delivery', 'source': 'webscraper', 'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == '1'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_no_category_param_queries_by_date(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Without category param, queries by date GSI as before."""
        # Return items on first day query, empty for the rest
        mock_fb_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'category': 'delivery', 'date': '2026-03-25'},
            ]},
        ] + [{'Items': []}] * 6  # remaining 6 days return empty

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 1
