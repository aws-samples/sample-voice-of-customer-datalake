"""
Regression tests for the /feedback endpoint limit handling.

Bug: The Problem Analysis page requests limit=500 but the backend capped it at 100,
causing the page to show 0 categories/problems when there were more than 100 items
spread across many categories.
"""
import json
import pytest
from unittest.mock import patch
from datetime import datetime, timezone, timedelta


class TestFeedbackLimitRegression:
    """Regression: /feedback must support limit up to 500 for problem analysis."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_limit_500_returns_up_to_500_items(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """The /feedback endpoint must honour limit=500 for the Problem Analysis page."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        items = [
            {
                'feedback_id': f'fb-{i}',
                'source_platform': 'webscraper',
                'category': f'cat-{i % 10}',
                'problem_summary': f'Problem {i}',
                'date': today,
            }
            for i in range(300)
        ]

        # Return all 300 items on the first day query
        mock_fb_table.query.side_effect = [
            {'Items': items},
        ] + [{'Items': []} for _ in range(29)]

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '30', 'limit': '500'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 300
        assert len(body['items']) == 300

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_limit_above_500_is_capped_at_500(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Limits above 500 are capped to prevent abuse."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        items = [
            {'feedback_id': f'fb-{i}', 'date': today}
            for i in range(600)
        ]

        mock_fb_table.query.side_effect = [
            {'Items': items},
        ] + [{'Items': []} for _ in range(6)]

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '7', 'limit': '9999'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert len(body['items']) <= 500

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_default_limit_remains_50(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """When no limit is specified, the default of 50 still applies."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        items = [
            {'feedback_id': f'fb-{i}', 'date': today}
            for i in range(100)
        ]

        mock_fb_table.query.side_effect = [
            {'Items': items},
        ] + [{'Items': []} for _ in range(6)]

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '7'},
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert len(body['items']) <= 50
