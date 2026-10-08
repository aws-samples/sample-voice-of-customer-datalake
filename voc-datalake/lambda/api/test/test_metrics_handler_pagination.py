"""
Tests for offset/limit pagination on GET /feedback in metrics_handler.py.

Covers the `offset`, `total`, and `is_partial_window` semantics added by the
pagination slice, plus backward compatibility of the `count`/`items` fields.
"""
import os
import sys
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from handler_events_fixtures import call_route

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _items(n, source='webscraper', sentiment='positive', category='delivery'):
    """Build n feedback items with sequential ids for slice assertions.

    Items carry today's import date so they fall inside every `days` window
    (the category branch now enforces the window on its time-unbounded GSI).
    """
    today = datetime.now(UTC).strftime('%Y-%m-%d')
    return [
        {
            'feedback_id': str(i),
            'source_platform': source,
            'sentiment_label': sentiment,
            'category': category,
            'date': today,
            'text': f'item {i}',
        }
        for i in range(n)
    ]


class TestListFeedbackPagination:
    """Pagination metadata and slicing for GET /feedback."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_returns_full_pagination_metadata_with_defaults(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(2)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback', query_params={'days': '1'},
        )

        assert body['count'] == 2
        assert body['total'] == 2
        assert body['offset'] == 0
        assert body['limit'] == 50
        assert body['is_partial_window'] is False
        assert len(body['items']) == 2

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_offset_slices_the_requested_page(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(10)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'offset': '4', 'limit': '3'},
        )

        assert body['offset'] == 4
        assert body['limit'] == 3
        assert body['total'] == 10
        assert body['count'] == 3
        assert [i['feedback_id'] for i in body['items']] == ['4', '5', '6']

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_offset_past_end_returns_empty_page_but_real_total(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(5)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'offset': '10', 'limit': '50'},
        )

        assert body['count'] == 0
        assert body['items'] == []
        assert body['total'] == 5
        assert body['offset'] == 10

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_total_reflects_source_filtered_candidates(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mixed = _items(3, source='webscraper') + _items(2, source='feedback_form')
        mock_fb.query.return_value = {'Items': mixed}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'source': 'webscraper'},
        )

        assert body['total'] == 3
        assert all(i['source_platform'] == 'webscraper' for i in body['items'])

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_total_reflects_sentiment_filtered_candidates(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mixed = _items(4, sentiment='positive') + _items(1, sentiment='negative')
        mock_fb.query.return_value = {'Items': mixed}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'sentiment': 'negative'},
        )

        assert body['total'] == 1
        assert body['items'][0]['sentiment_label'] == 'negative'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_clamps_offset_above_maximum(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(1)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'offset': '999999'},
        )

        assert body['offset'] == 5000  # MAX_FEEDBACK_OFFSET

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_clamps_negative_offset_to_zero(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(3)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '1', 'offset': '-5'},
        )

        assert body['offset'] == 0
        assert body['count'] == 3

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_is_partial_window_true_when_date_window_truncated(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        # First day already fills the candidate cap (>=100 for default offset+limit),
        # and more days remain -> window is truncated.
        mock_fb.query.return_value = {'Items': _items(100)}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback', query_params={'days': '3'},
        )

        assert body['is_partial_window'] is True
        assert body['total'] == 100

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_source_filter_does_not_over_flag_partial_window(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        # Regression for "N of N+": each day returns a full page where only one
        # item matches the source filter. The pre-filter window would hit the
        # small overshoot cap, but because a filter is applied we scan the full
        # day range, so the filtered total is exact and the window is not flagged
        # partial.
        page = _items(99, source='webscraper') + _items(1, source='manual_import')
        mock_fb.query.return_value = {'Items': page}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '3', 'source': 'manual_import'},
        )

        # 1 matching item per day across 3 scanned days.
        assert body['total'] == 3
        assert body['count'] == 3
        assert body['is_partial_window'] is False
        assert all(i['source_platform'] == 'manual_import' for i in body['items'])

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_filtered_query_still_flags_partial_window_at_hard_cap(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        # When even a filtered scan hits the MAX_FEEDBACK_OFFSET hard cap before
        # exhausting the day range, the window is genuinely partial and must be
        # flagged so the UI treats `total` as a lower bound.
        mock_fb.query.return_value = {'Items': _items(3000, source='manual_import')}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '3', 'source': 'manual_import'},
        )

        # Day 0 (3000) + day 1 (3000) >= 5000 cap, with day 2 still unscanned.
        assert body['is_partial_window'] is True

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table', new=MagicMock())
    def test_category_only_filter_uses_category_gsi(
        self, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': _items(3, category='delivery')}
        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/feedback',
            query_params={'days': '7', 'category': 'delivery'},
        )

        assert body['total'] == 3
        assert body['is_partial_window'] is False
        # category-only path queries the category GSI exactly once
        assert mock_fb.query.call_count == 1
        assert mock_fb.query.call_args.kwargs['IndexName'] == 'gsi2-by-category'
