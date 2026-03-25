"""
Additional tests for metrics_handler.py to reach 100% coverage.
Covers: list_feedback with category filter, get_entities (with/without source),
search_feedback, sentiment/category with source filter,
list_resolved_problems, resolve_problem, unresolve_problem.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestListFeedbackCategoryFilter:

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_category_filter_without_source(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        """Uses GSI2 when category is provided without source."""
        from metrics_handler import lambda_handler
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'category': 'delivery', 'source_platform': 'web', 'date': today},
                {'feedback_id': '2', 'category': 'delivery', 'source_platform': 'app', 'date': today},
            ]}
        ] + [{'Items': []}] * 10
        event = api_gateway_event(
            method='GET', path='/feedback',
            query_params={'category': 'delivery', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] == 2

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_category_and_source_filter(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        """Filters by both category and source."""
        from metrics_handler import lambda_handler
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'category': 'delivery', 'source_platform': 'web'},
                {'feedback_id': '2', 'category': 'product', 'source_platform': 'web'},
                {'feedback_id': '3', 'category': 'delivery', 'source_platform': 'app'},
            ]},
        ] + [{'Items': []}] * 10
        event = api_gateway_event(
            method='GET', path='/feedback',
            query_params={'category': 'delivery', 'source': 'web', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] == 1

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_sentiment_filter(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        """Filters by sentiment."""
        from metrics_handler import lambda_handler
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'sentiment_label': 'positive', 'source_platform': 'web'},
                {'feedback_id': '2', 'sentiment_label': 'negative', 'source_platform': 'web'},
            ]},
        ] + [{'Items': []}] * 10
        event = api_gateway_event(
            method='GET', path='/feedback',
            query_params={'sentiment': 'positive', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 1


class TestGetEntities:

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_entities_with_source_filter(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        """Returns entities filtered by source."""
        from metrics_handler import lambda_handler
        mock_fb.query.side_effect = [
            {'Items': [
                {'source_platform': 'web', 'category': 'product', 'problem_summary': 'Slow loading times on mobile'},
                {'source_platform': 'web', 'category': 'product', 'problem_summary': 'Slow loading times on mobile'},
                {'source_platform': 'app', 'category': 'delivery', 'problem_summary': 'Late delivery'},
            ]},
        ] + [{'Items': []}] * 10
        event = api_gateway_event(
            method='GET', path='/feedback/entities',
            query_params={'source': 'web', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['entities']['categories']['product'] == 2
        assert 'web' in body['entities']['sources']

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_entities_without_source(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        """Returns entities from aggregates when no source filter."""
        from metrics_handler import lambda_handler

        def get_item_side_effect(Key):
            pk = Key.get('pk', '')
            if pk == 'SETTINGS#categories':
                return {'Item': {'categories': [{'name': 'product'}, {'name': 'delivery'}]}}
            elif 'daily_category#product' in pk:
                return {'Item': {'count': 10}}
            elif 'daily_category#delivery' in pk:
                return {'Item': {'count': 5}}
            elif 'daily_total' in pk:
                return {'Item': {'count': 15}}
            return {}

        mock_agg.get_item.side_effect = get_item_side_effect
        mock_agg.query.side_effect = [
            {'Items': [{'pk': 'METRIC#daily_source#web', 'sk': datetime.now(timezone.utc).strftime('%Y-%m-%d'), 'count': 10}]},
            {'Items': [{'pk': 'METRIC#persona#Alice', 'sk': datetime.now(timezone.utc).strftime('%Y-%m-%d'), 'count': 5}]},
        ]
        mock_fb.query.side_effect = [
            {'Items': [
                {'problem_summary': 'Slow loading times on mobile devices'},
                {'problem_summary': 'tiny'},
            ]},
        ] + [{'Items': []}] * 10

        event = api_gateway_event(
            method='GET', path='/feedback/entities',
            query_params={'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert 'entities' in body
        assert body['feedback_count'] > 0


class TestSearchFeedback:

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_search_returns_matching_items(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'The product is great', 'date': today,
                 'source_platform': 'web', 'sentiment_label': 'positive', 'category': 'product'},
                {'feedback_id': '2', 'original_text': 'Delivery was slow', 'date': today,
                 'source_platform': 'web', 'sentiment_label': 'negative', 'category': 'delivery'},
            ]},
        ] + [{'Items': []}] * 30
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'product', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 1
        assert body['query'] == 'product'
        assert 'entities' in body

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_search_empty_query(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': ''}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 0

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_search_short_query(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'a'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 0

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_search_with_filters(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'Product issue', 'date': today,
                 'source_platform': 'web', 'sentiment_label': 'negative', 'category': 'product'},
                {'feedback_id': '2', 'original_text': 'Product great', 'date': today,
                 'source_platform': 'app', 'sentiment_label': 'positive', 'category': 'product'},
            ]},
        ] + [{'Items': []}] * 30
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'product', 'source': 'web', 'sentiment': 'negative', 'category': 'product'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 1

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_search_matches_title_and_problem(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'nothing', 'title': 'Bug report', 'problem_summary': '', 'date': today,
                 'source_platform': 'web', 'sentiment_label': 'negative', 'category': 'bug'},
                {'feedback_id': '2', 'original_text': 'nothing', 'title': '', 'problem_summary': 'Bug in checkout', 'date': today,
                 'source_platform': 'web', 'sentiment_label': 'negative', 'category': 'bug'},
            ]},
        ] + [{'Items': []}] * 30
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'bug', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 2


class TestSentimentWithSourceFilter:

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_sentiment_filtered_by_source(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_fb.query.side_effect = [
            {'Items': [
                {'source_platform': 'web', 'sentiment_label': 'positive'},
                {'source_platform': 'web', 'sentiment_label': 'negative'},
                {'source_platform': 'app', 'sentiment_label': 'positive'},
            ]},
        ] + [{'Items': []}] * 30
        event = api_gateway_event(
            method='GET', path='/metrics/sentiment',
            query_params={'source': 'web', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['breakdown']['positive'] == 1
        assert body['breakdown']['negative'] == 1


class TestCategoryWithSourceFilter:

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_category_filtered_by_source(self, mock_agg, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_agg.get_item.return_value = {'Item': {'categories': [{'name': 'product'}]}}
        mock_fb.query.side_effect = [
            {'Items': [
                {'source_platform': 'web', 'category': 'product'},
                {'source_platform': 'web', 'category': 'delivery'},
                {'source_platform': 'app', 'category': 'product'},
            ]},
        ] + [{'Items': []}] * 30
        event = api_gateway_event(
            method='GET', path='/metrics/categories',
            query_params={'source': 'web', 'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['categories']['product'] == 1
        assert body['categories']['delivery'] == 1


class TestResolvedProblems:

    @patch('metrics_handler.aggregates_table')
    def test_list_resolved_problems(self, mock_agg, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_agg.query.return_value = {
            'Items': [
                {'sk': 'PROBLEM#p1', 'category': 'bug', 'subcategory': 'ui',
                 'problem_text': 'Button broken', 'resolved_at': '2026-01-01', 'resolved_by': 'user@test.com'}
            ]
        }
        event = api_gateway_event(method='GET', path='/feedback/problems/resolved')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert len(body['resolved']) == 1
        assert body['resolved'][0]['problem_id'] == 'p1'

    @patch('metrics_handler.aggregates_table', None)
    def test_list_resolved_problems_no_table(self, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/feedback/problems/resolved')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['resolved'] == []

    @patch('metrics_handler.aggregates_table')
    def test_resolve_problem(self, mock_agg, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='PUT', path='/feedback/problems/p1/resolve',
            path_params={'problem_id': 'p1'},
            body={'category': 'bug', 'subcategory': 'ui', 'problem_text': 'Button broken'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['problem_id'] == 'p1'
        mock_agg.put_item.assert_called_once()

    @patch('metrics_handler.aggregates_table', None)
    def test_resolve_problem_no_table(self, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='PUT', path='/feedback/problems/p1/resolve',
            path_params={'problem_id': 'p1'},
            body={}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is False

    @patch('metrics_handler.aggregates_table')
    def test_unresolve_problem(self, mock_agg, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE', path='/feedback/problems/p1/resolve',
            path_params={'problem_id': 'p1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        mock_agg.delete_item.assert_called_once()

    @patch('metrics_handler.aggregates_table', None)
    def test_unresolve_problem_no_table(self, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE', path='/feedback/problems/p1/resolve',
            path_params={'problem_id': 'p1'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is False


class TestUrgentFeedbackFilters:

    @patch('metrics_handler.feedback_table')
    def test_urgent_with_sentiment_and_category_filter(self, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.return_value = {
            'Items': [
                {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'},
                {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#2'},
            ]
        }
        mock_fb.get_item.side_effect = [
            {'Item': {'feedback_id': '1', 'date': today, 'source_platform': 'web',
                      'sentiment_label': 'negative', 'category': 'bug'}},
            {'Item': {'feedback_id': '2', 'date': today, 'source_platform': 'web',
                      'sentiment_label': 'positive', 'category': 'product'}},
        ]
        event = api_gateway_event(
            method='GET', path='/feedback/urgent',
            query_params={'sentiment': 'negative', 'category': 'bug'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 1

    @patch('metrics_handler.feedback_table')
    def test_urgent_skips_missing_pk_sk(self, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_fb.query.return_value = {
            'Items': [
                {'pk': None, 'sk': None},
                {},
            ]
        }
        event = api_gateway_event(method='GET', path='/feedback/urgent')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 0

    @patch('metrics_handler.feedback_table')
    def test_urgent_skips_missing_item(self, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_fb.query.return_value = {
            'Items': [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'}]
        }
        mock_fb.get_item.return_value = {}
        event = api_gateway_event(method='GET', path='/feedback/urgent')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 0

    @patch('metrics_handler.feedback_table')
    def test_urgent_skips_old_items(self, mock_fb, api_gateway_event, lambda_context):
        from metrics_handler import lambda_handler
        mock_fb.query.return_value = {
            'Items': [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'}]
        }
        mock_fb.get_item.return_value = {
            'Item': {'feedback_id': '1', 'date': '2020-01-01', 'source_platform': 'web'}
        }
        event = api_gateway_event(
            method='GET', path='/feedback/urgent',
            query_params={'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['count'] == 0
