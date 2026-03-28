"""
Tests for metrics_handler.py - coverage for uncovered endpoints:
search, entities, category/sentiment/source metrics with filters,
and problem resolution endpoints.
"""
import json
from unittest.mock import patch, call
from datetime import datetime, timezone


class TestSearchFeedback:
    """Tests for GET /feedback/search endpoint."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_matching_items_by_text(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns only feedback items whose original_text contains the query."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'Great delivery speed', 'date': today,
                 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'delivery'},
                {'feedback_id': '2', 'original_text': 'Bad product quality', 'date': today,
                 'source_platform': 'webscraper', 'sentiment_label': 'negative', 'category': 'product'},
            ]},
        ] + [{'Items': []}] * 29

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'delivery', 'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == '1'
        assert body['query'] == 'delivery'
        # Entities should summarize the matched results
        assert body['entities']['categories'] == {'delivery': 1}
        assert body['entities']['sources'] == {'webscraper': 1}
        assert body['entities']['sentiments'] == {'positive': 1}

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_empty_for_short_query(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns empty results when query is less than 2 characters."""
        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'a'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['count'] == 0
        assert body['items'] == []
        assert body['query'] == 'a'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_filters_search_by_source_and_sentiment(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Excludes items that don't match source and sentiment filters."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'slow delivery', 'date': today,
                 'source_platform': 'webscraper', 'sentiment_label': 'negative', 'category': 'delivery'},
                {'feedback_id': '2', 'original_text': 'slow delivery too', 'date': today,
                 'source_platform': 'manual_import', 'sentiment_label': 'negative', 'category': 'delivery'},
                {'feedback_id': '3', 'original_text': 'slow but ok delivery', 'date': today,
                 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'delivery'},
            ]},
        ] + [{'Items': []}] * 29

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'slow', 'source': 'webscraper', 'sentiment': 'negative'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Only item 1 matches: webscraper + negative + contains "slow"
        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == '1'
        assert body['items'][0]['source_platform'] == 'webscraper'
        assert body['items'][0]['sentiment_label'] == 'negative'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_matches_in_title_and_problem_summary(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Finds items where query appears in title or problem_summary, not just original_text."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'original_text': 'unrelated text', 'title': 'shipping delay',
                 'problem_summary': '', 'date': today, 'source_platform': 'web',
                 'sentiment_label': 'negative', 'category': 'delivery'},
                {'feedback_id': '2', 'original_text': 'unrelated text', 'title': '',
                 'problem_summary': 'shipping was late', 'date': today, 'source_platform': 'web',
                 'sentiment_label': 'negative', 'category': 'delivery'},
                {'feedback_id': '3', 'original_text': 'no match anywhere', 'title': 'good product',
                 'problem_summary': 'none', 'date': today, 'source_platform': 'web',
                 'sentiment_label': 'positive', 'category': 'product'},
            ]},
        ] + [{'Items': []}] * 29

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'shipping'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['count'] == 2
        matched_ids = {item['feedback_id'] for item in body['items']}
        assert matched_ids == {'1', '2'}


class TestGetEntities:
    """Tests for GET /feedback/entities endpoint."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_entities_filtered_by_source(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns category counts and issue counts only for the specified source."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper', 'category': 'delivery',
                 'problem_summary': 'Package arrived damaged', 'date': today},
                {'feedback_id': '2', 'source_platform': 'webscraper', 'category': 'delivery',
                 'problem_summary': 'Package arrived damaged', 'date': today},
                {'feedback_id': '3', 'source_platform': 'manual_import', 'category': 'product',
                 'problem_summary': 'Broken on arrival', 'date': today},
            ]},
        ] + [{'Items': []}] * 6

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/entities',
            query_params={'source': 'webscraper', 'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # Only webscraper items counted (items 1 and 2)
        assert body['feedback_count'] == 2
        assert body['entities']['categories'] == {'delivery': 2}
        assert body['entities']['sources'] == {'webscraper': 2}
        # Issue deduplication: both have same problem_summary
        assert 'package arrived damaged' in body['entities']['issues']
        assert body['entities']['issues']['package arrived damaged'] == 2

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_returns_empty_entities_when_no_data(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Returns zero-value entities when aggregates have no data."""
        mock_agg.get_item.return_value = {}
        mock_agg.query.return_value = {'Items': []}
        mock_fb.query.return_value = {'Items': []}

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/feedback/entities',
            query_params={'days': '7'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['feedback_count'] == 0
        assert body['entities']['categories'] == {}
        assert body['entities']['sources'] == {}
        assert body['entities']['personas'] == {}
        assert body['entities']['issues'] == {}


class TestSentimentWithSourceFilter:
    """Tests for GET /metrics/sentiment with source filter."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_counts_sentiment_only_for_specified_source(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Excludes items from other sources when counting sentiment."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'source_platform': 'webscraper', 'sentiment_label': 'positive', 'date': today},
                {'source_platform': 'webscraper', 'sentiment_label': 'positive', 'date': today},
                {'source_platform': 'webscraper', 'sentiment_label': 'negative', 'date': today},
                {'source_platform': 'manual_import', 'sentiment_label': 'positive', 'date': today},
            ]},
        ] + [{'Items': []}] * 6

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/metrics/sentiment',
            query_params={'days': '7', 'source': 'webscraper'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # Only webscraper items: 2 positive, 1 negative, 0 neutral, 0 mixed
        assert body['breakdown']['positive'] == 2
        assert body['breakdown']['negative'] == 1
        assert body['breakdown']['neutral'] == 0
        assert body['breakdown']['mixed'] == 0
        assert body['total'] == 3


class TestCategoryWithSourceFilter:
    """Tests for GET /metrics/categories with source filter."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_counts_categories_only_for_specified_source(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Excludes items from other sources when counting categories."""
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        mock_fb.query.side_effect = [
            {'Items': [
                {'source_platform': 'webscraper', 'category': 'delivery', 'date': today},
                {'source_platform': 'webscraper', 'category': 'delivery', 'date': today},
                {'source_platform': 'webscraper', 'category': 'product', 'date': today},
                {'source_platform': 'manual_import', 'category': 'delivery', 'date': today},
            ]},
        ] + [{'Items': []}] * 6

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET', path='/metrics/categories',
            query_params={'days': '7', 'source': 'webscraper'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # Only webscraper: 2 delivery, 1 product (manual_import excluded)
        assert body['categories']['delivery'] == 2
        assert body['categories']['product'] == 1
        assert 'manual_import' not in str(body['categories'])


class TestProblemResolution:
    """Tests for problem resolution endpoints."""

    @patch('metrics_handler.aggregates_table')
    def test_lists_resolved_problems_with_all_fields(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """Returns resolved problems with problem_id extracted from SK."""
        mock_agg.query.return_value = {
            'Items': [
                {'sk': 'PROBLEM#p1', 'category': 'delivery', 'subcategory': 'late',
                 'problem_text': 'Late delivery', 'resolved_at': '2026-01-01T00:00:00Z',
                 'resolved_by': 'admin@test.com'},
            ]
        }

        from metrics_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/feedback/problems/resolved')

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert len(body['resolved']) == 1
        problem = body['resolved'][0]
        assert problem['problem_id'] == 'p1'
        assert problem['category'] == 'delivery'
        assert problem['subcategory'] == 'late'
        assert problem['problem_text'] == 'Late delivery'
        assert problem['resolved_by'] == 'admin@test.com'

    @patch('metrics_handler.aggregates_table')
    def test_resolves_problem_stores_correct_item(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """Stores resolved problem with correct PK/SK and metadata."""
        mock_agg.put_item.return_value = {}

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='PUT', path='/feedback/problems/prob-123/resolve',
            path_params={'problem_id': 'prob-123'},
            body={'category': 'delivery', 'problem_text': 'Late shipments'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['problem_id'] == 'prob-123'
        assert 'resolved_at' in body

        # Verify the DynamoDB item structure
        mock_agg.put_item.assert_called_once()
        stored_item = mock_agg.put_item.call_args.kwargs['Item']
        assert stored_item['pk'] == 'RESOLVED_PROBLEMS'
        assert stored_item['sk'] == 'PROBLEM#prob-123'
        assert stored_item['category'] == 'delivery'
        assert stored_item['problem_text'] == 'Late shipments'

    @patch('metrics_handler.aggregates_table')
    def test_unresolves_problem_deletes_correct_key(
        self, mock_agg, api_gateway_event, lambda_context
    ):
        """Deletes the resolved problem record using correct PK/SK."""
        mock_agg.delete_item.return_value = {}

        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='DELETE', path='/feedback/problems/prob-123/resolve',
            path_params={'problem_id': 'prob-123'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['problem_id'] == 'prob-123'

        # Verify the correct key was deleted
        mock_agg.delete_item.assert_called_once_with(Key={
            'pk': 'RESOLVED_PROBLEMS',
            'sk': 'PROBLEM#prob-123',
        })
