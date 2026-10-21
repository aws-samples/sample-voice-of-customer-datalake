"""
Tests for metrics_handler.py - /feedback/* and /metrics/* endpoints.
"""
import json
import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

# conftest.py puts lambda/api on sys.path, so the handler imports at module load.
# The per-method `import sys/os` blocks in the older tests predate that and are
# left as-is; new tests below use this top-level import.
from metrics_handler import lambda_handler as metrics_lambda_handler


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
        # One query per metric partition (see _query_metric_window), not one
        # get_item per day.
        mock_agg_table.query.return_value = {
            'Items': [{'sk': '2026-01-07', 'count': 50, 'sum': 25.0}]
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
        assert body['period_days'] == 7
        # Exact values, not just key presence: the single item the stubbed query
        # returns carries count=50, so every derived figure is determined.
        assert body['total_feedback'] == 50
        assert body['urgent_count'] == 50
        assert body['daily_totals'] == [{'date': '2026-01-07', 'count': 50}]

    @patch('metrics_handler.aggregates_table')
    def test_returns_zero_totals_when_no_data(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns zero values when no aggregates exist."""
        mock_agg_table.query.return_value = {'Items': []}
        
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
        # Stub at the window helper: it takes the pk as a plain string, whereas
        # the pk inside a real query's KeyConditionExpression is buried in a
        # boto3 Condition object. The query shape itself is covered by
        # TestQueryMetricWindow.
        counts = {'positive': 60, 'negative': 20, 'neutral': 15, 'mixed': 5}
        
        def window_side_effect(pk, days, current_date):
            # `(items, truncated)` — the helper reports truncation to its caller
            # now, so a stub returning a bare list would report the tuple itself
            # as the window.
            label = pk.rsplit('#', 1)[-1]
            return [{'sk': '2026-01-07', 'count': counts[label]}], False
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET', 
            path='/metrics/sentiment', 
            query_params={'days': '7'}
        )
        
        with patch('metrics_handler._query_metric_window',
                   side_effect=window_side_effect) as mock_window:
            response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        # Exact breakdown, so a mis-keyed window would fail rather than pass on
        # mere key presence.
        assert body['breakdown'] == counts
        assert body['total'] == 100
        # The FULL partition keys, not just the trailing label: the stub above
        # derives its label with rsplit, so 'METRIC#sentiment#positive' would
        # satisfy it just as well as the real 'METRIC#daily_sentiment#positive'.
        # Without this, the endpoint-to-partition mapping is unasserted.
        assert [c.args[0] for c in mock_window.call_args_list] == [
            'METRIC#daily_sentiment#positive',
            'METRIC#daily_sentiment#neutral',
            'METRIC#daily_sentiment#negative',
            'METRIC#daily_sentiment#mixed',
        ]


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
    def test_count_is_the_returned_page_length_not_the_window_total(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """`count` reports how many items this page returned, NOT the window total.

        Pinning deliberately-surprising behaviour. The handler returns
        ``{'count': len(items), 'items': items[:limit]}`` and stops scanning once
        it has ``limit`` items, so ``count`` is bounded by ``limit`` and cannot
        express "how many urgent items exist".

        This is a trap for consumers: the sidebar urgent badge read this field
        with ``limit=10`` and could therefore never display more than 10, no
        matter how many urgent items the window held. The frontend now takes its
        count from ``/metrics/summary`` (which sums the exact ``METRIC#urgent``
        aggregates) instead. Until this field is renamed or given a companion
        total, that remains the only correct source for a total, and this test
        exists so the constraint is discoverable from the backend tests.

        DELETE THIS TEST when ``count`` is fixed to report a true window total
        (or replaced by ``total``/``has_more``). It pins today's deliberately
        surprising behaviour, so the intended future fix SHOULD fail it — that
        failure is the reminder to update the frontend's source of truth at the
        same time, not a regression.
        """
        # Ten urgent items available, but the caller asks for three.
        mock_fb_table.query.return_value = {
            'Items': [
                {'pk': 'SOURCE#webscraper', 'sk': f'FEEDBACK#{i}', 'urgency': 'high'}
                for i in range(10)
            ]
        }
        # The date must be computed, not hardcoded: the handler drops anything
        # older than the window, so a fixed date silently empties the result and
        # the assertions below would pass against zero items.
        recent = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%d')
        mock_fb_table.get_item.return_value = {
            'Item': {
                'feedback_id': '1', 'urgency': 'high',
                'original_text': 'Urgent issue!', 'date': recent,
            }
        }
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler

        event = api_gateway_event(
            method='GET',
            path='/feedback/urgent',
            query_params={'limit': '3'},
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        # Exactly the requested page, not "at most" — ten items were available.
        assert len(body['items']) == 3
        # The point: `count` tracks the page, not the window, so it reports 3
        # while ten urgent items exist. It must not be read as a total.
        assert body['count'] == 3

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
        assert 'items' in body
        # The limit must actually reach the query (no filters -> no over-fetch).
        assert mock_fb_table.query.call_args.kwargs['Limit'] == 5

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
        # get_configured_categories memoizes in a module-level cache that other
        # test modules populate, so the stub below is only authoritative once
        # the cache is cleared. Same pattern as shared/test/test_api.py.
        from shared.api import clear_categories_cache
        clear_categories_cache()
        
        # The configured-category list is still a get_item; only the per-day
        # count walk became a windowed query.
        def get_item_side_effect(Key):
            if Key.get('pk', '') == 'SETTINGS#categories':
                return {'Item': {'categories': [{'name': 'product'}, {'name': 'delivery'}]}}
            return {}
        
        mock_agg_table.get_item.side_effect = get_item_side_effect
        
        counts = {'product': 50, 'delivery': 30}
        
        def window_side_effect(pk, days, current_date):
            # `(items, truncated)`; see the sentiment stub above.
            category = pk.rsplit('#', 1)[-1]
            return [{'sk': '2026-01-07', 'count': counts[category]}], False
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from metrics_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/metrics/categories',
            query_params={'days': '7'}
        )
        
        try:
            with patch('metrics_handler._query_metric_window',
                       side_effect=window_side_effect) as mock_window:
                response = lambda_handler(event, lambda_context)
        finally:
            # Clearing on the way in fixed the inbound leak; clearing on the way
            # out stops this test from handing {product, delivery} to whatever
            # runs next. Same bug class, other direction.
            clear_categories_cache()
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        # Exact values and descending-by-count ordering, both of which the
        # previous 'categories' in body assertion could not see.
        assert body['categories'] == {'product': 50, 'delivery': 30}
        assert list(body['categories']) == ['product', 'delivery']
        # Full partition keys: the stub derives its category with rsplit, so a
        # wrong prefix would otherwise pass.
        assert [c.args[0] for c in mock_window.call_args_list] == [
            'METRIC#daily_category#product',
            'METRIC#daily_category#delivery',
        ]


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


class TestQueryMetricWindow:
    """Tests for _query_metric_window - the per-day fan-out replacement.

    The aggregates table is (pk, sk) with sk = 'YYYY-MM-DD'. Because ISO dates
    sort lexicographically a trailing window is one contiguous sort-key range,
    so a whole window costs ONE request instead of one get_item per day.
    """

    def test_reads_a_whole_window_in_one_query_with_inclusive_iso_bounds(self):
        """One query, exact pk, and bounds spanning exactly `days` dates."""
        # conftest.py already puts lambda/ and lambda/api/ on sys.path (:13-16),
        # so the per-test path insertion the older tests carry is redundant.
        from boto3.dynamodb.conditions import Key
        from metrics_handler import _query_metric_window

        current = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
        with patch('metrics_handler.aggregates_table') as mock_table:
            mock_table.query.return_value = {'Items': [{'sk': '2026-03-10', 'count': 2}]}
            items, truncated = _query_metric_window('METRIC#urgent', 7, current)

        assert mock_table.query.call_count == 1
        assert mock_table.get_item.call_count == 0
        kwargs = mock_table.query.call_args.kwargs
        # 7 days ending 2026-03-10 is 03-04..03-10 inclusive, i.e. the same set
        # the replaced `for i in range(days)` loop visited. Comparing whole
        # Condition objects pins the pk, both bounds and the operators at once.
        assert kwargs['KeyConditionExpression'] == (
            Key('pk').eq('METRIC#urgent') & Key('sk').between('2026-03-04', '2026-03-10')
        )
        assert items == [{'sk': '2026-03-10', 'count': 2}]
        assert truncated is False

    def test_requests_newest_first_because_the_charts_read_that_order(self):
        """ScanIndexForward=False: a default query would silently reverse charts.

        The loops this replaced counted `i` up from 0 (today), so `daily_totals`
        and `daily_sentiment` reach the client newest-first. DynamoDB's default
        is ascending, which would invert both series without changing any total.
        """
        from metrics_handler import _query_metric_window

        with patch('metrics_handler.aggregates_table') as mock_table:
            mock_table.query.return_value = {'Items': []}
            _query_metric_window('METRIC#daily_total', 30,
                                 datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_args.kwargs['ScanIndexForward'] is False

    def test_follows_last_evaluated_key_so_a_window_cannot_truncate(self):
        """Paged windows are concatenated, in order, and the cursor is passed on.

        A 365-day window of counter items fits one 1 MB page today, but that
        rests on item width the aggregator controls, so a dropped page would be
        a silently wrong total. A window that PAGED to completion is not partial:
        every row was read, just not in one request.
        """
        from metrics_handler import _query_metric_window

        pages = [
            {'Items': [{'sk': '2026-03-10', 'count': 1}], 'LastEvaluatedKey': {'pk': 'p', 'sk': '2026-03-10'}},
            {'Items': [{'sk': '2026-03-09', 'count': 2}]},
        ]
        with patch('metrics_handler.aggregates_table') as mock_table:
            mock_table.query.side_effect = pages
            items, truncated = _query_metric_window(
                'METRIC#urgent', 7, datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 2
        assert items == [
            {'sk': '2026-03-10', 'count': 1},
            {'sk': '2026-03-09', 'count': 2},
        ]
        assert truncated is False
        # Second call resumes from the first page's cursor.
        assert mock_table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {
            'pk': 'p', 'sk': '2026-03-10'
        }
        # ...and the first does not carry one.
        assert 'ExclusiveStartKey' not in mock_table.query.call_args_list[0].kwargs

    def test_warns_when_the_paging_bound_is_hit_with_a_cursor_still_open(self):
        """A bounded loop must not turn truncation back into a silent short read.

        By the bound's own invariant this is unreachable (a window of `days`
        dates cannot span more than `days` pages), so if it ever happens an
        assumption has broken and that needs to be visible. The warning is now
        the OPERATOR's copy of the fact; `truncated` is the caller's, and
        `TestAggregatePathReportsPagingTruncation` covers what the endpoints do
        with it.
        """
        from metrics_handler import _query_metric_window

        # Every page reports another cursor, so the bound is what stops it.
        with patch('metrics_handler.aggregates_table') as mock_table, \
             patch('metrics_handler.logger') as mock_logger:
            mock_table.query.return_value = {
                'Items': [{'sk': '2026-03-10', 'count': 1}],
                'LastEvaluatedKey': {'pk': 'p', 'sk': '2026-03-10'},
            }
            items, truncated = _query_metric_window(
                'METRIC#urgent', 3, datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 3, 'bound should cap pages at `days`'
        assert len(items) == 3
        assert truncated is True, 'the caller must be told, not just CloudWatch'
        assert mock_logger.warning.called, 'a partial window must not be silent'

    def test_does_not_warn_when_the_window_completes(self):
        """The warning must be specific to truncation, not fire on every read."""
        from metrics_handler import _query_metric_window

        with patch('metrics_handler.aggregates_table') as mock_table, \
             patch('metrics_handler.logger') as mock_logger:
            mock_table.query.return_value = {'Items': [{'sk': '2026-03-10', 'count': 1}]}
            _, truncated = _query_metric_window(
                'METRIC#urgent', 3, datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 1
        assert truncated is False
        assert not mock_logger.warning.called

    def test_a_single_day_window_is_the_current_date_alone(self):
        """days=1 must not read a zero-width or off-by-one range."""
        from boto3.dynamodb.conditions import Key
        from metrics_handler import _query_metric_window

        with patch('metrics_handler.aggregates_table') as mock_table:
            mock_table.query.return_value = {'Items': []}
            _query_metric_window('METRIC#urgent', 1,
                                 datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_args.kwargs['KeyConditionExpression'] == (
            Key('pk').eq('METRIC#urgent') & Key('sk').between('2026-03-10', '2026-03-10')
        )


class TestMetricsRequestCountIsIndependentOfWindow:
    """The point of the change: round-trips must not scale with `days`.

    Before this, /metrics/summary issued 3 x days sequential get_item calls
    (~270 at a 90-day window, measured at 2609ms on 6,234 items). These tests
    fail if that shape comes back.
    """

    @patch('metrics_handler.aggregates_table')
    def test_summary_issues_three_queries_whatever_the_window(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """One query per metric partition, and zero per-day get_items."""
        from metrics_handler import lambda_handler

        counts = []
        for days in ('1', '7', '90', '365'):
            mock_agg_table.reset_mock()
            mock_agg_table.query.return_value = {'Items': [{'sk': '2026-03-10', 'count': 3, 'sum': 1.5}]}
            event = api_gateway_event(
                method='GET', path='/metrics/summary', query_params={'days': days}
            )
            response = lambda_handler(event, lambda_context)
            assert response['statusCode'] == 200
            counts.append(mock_agg_table.query.call_count)
            # Scoped to METRIC# partitions rather than all get_item calls: the
            # fan-out being guarded against was per-day METRIC# reads, and a
            # legitimate single-shot settings read (SETTINGS#...) moving onto
            # this table later should not fail this test.
            metric_get_items = [
                c for c in mock_agg_table.get_item.call_args_list
                if str(c.kwargs.get('Key', {}).get('pk', '')).startswith('METRIC#')
            ]
            assert metric_get_items == [], f'per-day METRIC# get_item returned at days={days}'

        # daily_total + daily_sentiment_avg + urgent = 3, flat across windows.
        assert counts == [3, 3, 3, 3]

    @patch('metrics_handler.aggregates_table')
    def test_sentiment_issues_one_query_per_label_whatever_the_window(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Was 4 labels x days (360 reads at 90d); now 4 regardless."""
        from metrics_handler import lambda_handler

        counts = []
        for days in ('7', '90'):
            mock_agg_table.reset_mock()
            mock_agg_table.query.return_value = {'Items': [{'sk': '2026-03-10', 'count': 1}]}
            event = api_gateway_event(
                method='GET', path='/metrics/sentiment', query_params={'days': days}
            )
            response = lambda_handler(event, lambda_context)
            assert response['statusCode'] == 200
            counts.append(mock_agg_table.query.call_count)

        assert counts == [4, 4]

    @patch('metrics_handler.aggregates_table')
    def test_summary_keeps_daily_series_newest_first(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """The handler must not re-sort what the query already ordered."""
        from metrics_handler import lambda_handler

        mock_agg_table.query.return_value = {'Items': [
            {'sk': '2026-03-10', 'count': 5, 'sum': 2.5},
            {'sk': '2026-03-09', 'count': 3, 'sum': 1.5},
        ]}
        event = api_gateway_event(
            method='GET', path='/metrics/summary', query_params={'days': '7'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert [t['date'] for t in body['daily_totals']] == ['2026-03-10', '2026-03-09']
        assert [s['date'] for s in body['daily_sentiment']] == ['2026-03-10', '2026-03-09']

    @patch('metrics_handler.aggregates_table')
    def test_urgent_count_sums_the_window_exactly(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """urgent_count is the sidebar badge AND the Dashboard heading (#278).

        Those two must stay equal, so this value is a published contract: it is
        the sum of METRIC#urgent over the window, not a page length.
        """
        from metrics_handler import lambda_handler

        mock_agg_table.query.return_value = {'Items': [
            {'sk': '2026-03-10', 'count': 7},
            {'sk': '2026-03-09', 'count': 4},
            {'sk': '2026-03-08', 'count': 1},
        ]}
        event = api_gateway_event(
            method='GET', path='/metrics/summary', query_params={'days': '30'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['urgent_count'] == 12


class TestSearchQueryMinimumLength:
    """GET /feedback/search and a query shorter than the documented minimum.

    The route answered `{'count': 0, 'items': []}` with HTTP 200, which is a
    claim about the CORPUS ("nothing matches") standing in for a fact about the
    REQUEST ("that search was never run"). A human typing in a search box infers
    the difference from their own one-character input; a model calling the MCP
    tool receives a successful empty result and reports that no customer
    mentioned the thing.
    """

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_one_character_query_is_refused_rather_than_answered_empty(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/feedback/search', query_params={'q': 'a'})

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 400
        assert json.loads(response['body'])['success'] is False
        assert mock_fb.query.call_count == 0, "a refused search must not scan the corpus"

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_refusal_states_the_minimum_so_a_caller_can_correct_itself(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The adapter relays this message verbatim to the model, so it has to
        say what the rule is rather than merely that a rule was broken."""
        from metrics_handler import lambda_handler
        from shared.api import SEARCH_QUERY_MIN_LENGTH
        event = api_gateway_event(path='/feedback/search', query_params={'q': 'a'})

        error = json.loads(lambda_handler(event, lambda_context)['body'])['error']

        assert str(SEARCH_QUERY_MIN_LENGTH) in error

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_whitespace_that_trims_below_the_minimum_is_refused(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The route trims before measuring, so `' a '` is one character.

        This is the case the frontend can actually produce: its own gate counts
        raw `.length`, so two typed spaces around one letter passes the client
        check and arrives here as a single character.
        """
        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/feedback/search', query_params={'q': '  a  '})

        assert lambda_handler(event, lambda_context)['statusCode'] == 400

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_blank_query_is_still_a_successful_empty_answer(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Deliberately NOT an error: no search term means no search was asked
        for, and the filter-only answer belongs to `/feedback` — which is where
        the MCP adapter routes such a call. Only a term that is PRESENT and too
        short is a refusal.
        """
        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/feedback/search', query_params={'q': '   '})

        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['count'] == 0

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_query_at_the_minimum_is_accepted(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The boundary itself, so the guard cannot drift into off-by-one."""
        from metrics_handler import lambda_handler
        from shared.api import SEARCH_QUERY_MIN_LENGTH
        mock_fb.query.return_value = {'Items': []}
        event = api_gateway_event(
            path='/feedback/search',
            query_params={'q': 'a' * SEARCH_QUERY_MIN_LENGTH, 'days': '1'},
        )

        assert lambda_handler(event, lambda_context)['statusCode'] == 200


class TestSearchScansTheRequestedWindow:
    """GET /feedback/search read `min(days, 30)` while its cutoff used `days`.

    The two disagreed, so at `days=365` the filter admitted a year of items and
    the candidate set only ever held thirty days of them. Anything older was
    unreachable by text search at ANY `days` value, and the answer was a plain
    `count: 0` — indistinguishable from "no customer said that".
    """

    @staticmethod
    def _day_partitions(mock_fb):
        """The `DATE#` partitions the route actually queried, in order."""
        return [
            call.kwargs['KeyConditionExpression']._values[1]
            for call in mock_fb.query.call_args_list
        ]

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_match_older_than_thirty_days_is_now_reachable(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The reported symptom, as a test: on the corpus this was found on, a
        5,240-item import sat 37 days back and no text search could see it."""
        old_day = (datetime.now(timezone.utc) - timedelta(days=37)).strftime('%Y-%m-%d')

        def by_day(**kwargs):
            queried = kwargs['KeyConditionExpression']._values[1]
            if queried == f'DATE#{old_day}':
                return {'Items': [{
                    'feedback_id': 'old-hit', 'original_text': 'slow delivery',
                    # `date` is the import date and mirrors the gsi1 partition, so
                    # a row living in `DATE#{old_day}` carries that same day. It is
                    # what the default `imported` basis filters on — omitting it
                    # makes `basis_date` return `''`, which is below every cutoff.
                    'date': old_day,
                    'source_created_at': f'{old_day}T00:00:00Z', 'category': 'delivery',
                }]}
            return {'Items': []}

        mock_fb.query.side_effect = by_day
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/search', query_params={'q': 'delivery', 'days': '90'}
        )

        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['old-hit']

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_scan_covers_every_requested_day_not_thirty(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """Asserted on the PARTITIONS queried rather than on a call count, so it
        says which window was read instead of merely how many reads happened."""
        mock_fb.query.return_value = {'Items': []}
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/search', query_params={'q': 'delivery', 'days': '60'}
        )

        lambda_handler(event, lambda_context)

        assert len(self._day_partitions(mock_fb)) == 60, "the requested window, not a hidden 30"

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_complete_scan_reports_itself_as_complete(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        mock_fb.query.return_value = {'Items': []}
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/search', query_params={'q': 'delivery', 'days': '7'}
        )

        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial_window'] is False

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_scan_that_stops_on_the_soft_cap_says_so(
        self, mock_agg, mock_fb, api_gateway_event, lambda_context
    ):
        """The load-bearing half of the fix.

        The soft cap still bounds how many candidates are collected, so widening
        the window without reporting an early stop would only make an incomplete
        answer slower. `count: 0` and "the scan gave up" must be distinguishable.
        """
        from metrics_handler import CANDIDATES_SOFT_CAP
        # `date` is OMITTED on purpose, and that is load-bearing: the default
        # `imported` basis reads `item['date']`, so `basis_date` returns `''`,
        # every row falls below the cutoff, and `count` is 0 for a reason that has
        # nothing to do with the search term. That is exactly the state under test
        # — zero matches out of a scan that also truncated. Adding `date` here
        # would make the rows pass the cutoff and test something else.
        dense_day = [
            {'feedback_id': f'f{i}', 'original_text': 'nothing to match here',
             'source_created_at': '2026-08-01T00:00:00Z'}
            for i in range(300)
        ]
        mock_fb.query.return_value = {'Items': dense_day}
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/search', query_params={'q': 'delivery', 'days': '365'}
        )

        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['count'] == 0, "no item contains the term"
        assert body['is_partial_window'] is True, (
            "zero matches out of a truncated scan must not read as zero matches in the window"
        )
        assert len(self._day_partitions(mock_fb)) < 365, (
            f"the soft cap of {CANDIDATES_SOFT_CAP} should have stopped the scan early"
        )


class TestGetLatestDateEndpoint:
    """Tests for GET /metrics/latest-date — the empty-window fallback probe."""

    @patch('metrics_handler.aggregates_table')
    def test_returns_newest_populated_date_imported_basis(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """Returns the newest METRIC#daily_total sk via a descending Limit=1 query."""
        mock_agg_table.query.return_value = {'Items': [{'sk': '2026-09-21', 'count': 296}]}

        event = api_gateway_event(method='GET', path='/metrics/latest-date')
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['latest_date'] == '2026-09-21'
        assert body['date_basis'] == 'imported'
        # The probe must be a single descending read bounded to one row — not a
        # full partition scan — so the newest date is row zero.
        _, kwargs = mock_agg_table.query.call_args
        assert kwargs['ScanIndexForward'] is False
        assert kwargs['Limit'] == 1

    @patch('metrics_handler.aggregates_table')
    def test_returns_null_when_no_aggregates_exist(
        self, mock_agg_table, api_gateway_event, lambda_context
    ):
        """latest_date is null when no date has data (empty / fully-expired)."""
        mock_agg_table.query.return_value = {'Items': []}

        event = api_gateway_event(method='GET', path='/metrics/latest-date')
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['latest_date'] is None
        assert body['date_basis'] == 'imported'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_review_basis_uses_feedback_date_gsi_not_aggregates(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Review basis walks the feedback date GSI and returns the max review date.

        Reviews are keyed by IMPORT date, so the newest review date is the max of
        the review dates in the newest non-empty import partition — not the
        import date itself, and not the aggregates sentinel.
        """
        # Newest import partition carries two items whose REVIEW dates differ;
        # the later one wins.
        mock_fb_table.query.return_value = {
            'Items': [
                {'source_created_at': '2026-09-18T10:00:00Z', 'date': '2026-09-21'},
                {'source_created_at': '2026-09-20T10:00:00Z', 'date': '2026-09-21'},
            ]
        }

        event = api_gateway_event(
            method='GET', path='/metrics/latest-date',
            query_params={'date_basis': 'review'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['date_basis'] == 'review'
        # Max review date across the partition, not the import date (2026-09-21).
        assert body['latest_date'] == '2026-09-20'
        # Review basis must NOT consult the aggregates sentinel.
        mock_agg_table.query.assert_not_called()

    @patch('metrics_handler.feedback_table')
    def test_review_basis_returns_null_when_no_recent_feedback(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Review basis returns null when every scanned partition is empty."""
        mock_fb_table.query.return_value = {'Items': []}

        event = api_gateway_event(
            method='GET', path='/metrics/latest-date',
            query_params={'date_basis': 'review'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['latest_date'] is None


class TestRankCustomFieldCandidates:
    """Tests for _rank_custom_field_candidates() — the facet recommender."""

    @staticmethod
    def _items(*custom_fields_list):
        return [{'custom_fields': cf} for cf in custom_fields_list]

    def test_returns_empty_for_no_items(self):
        from metrics_handler import _rank_custom_field_candidates
        assert _rank_custom_field_candidates([]) == []

    def test_recommends_a_moderate_cardinality_field(self):
        from metrics_handler import _rank_custom_field_candidates
        items = self._items(
            {'region': 'EMEA'}, {'region': 'EMEA'}, {'region': 'APAC'}, {'region': 'APAC'},
        )
        result = _rank_custom_field_candidates(items)
        assert len(result) == 1
        rec = result[0]
        assert rec['key'] == 'region'
        assert rec['distinct_values'] == 2
        assert rec['coverage'] == 1.0
        # Top values previewed with counts, most common first.
        assert {'value': 'EMEA', 'count': 2} in rec['top_values']

    def test_excludes_a_near_unique_id_field(self):
        from metrics_handler import _rank_custom_field_candidates
        # 60 distinct values across 60 rows — an id, not a facet.
        items = self._items(*[{'order_id': f'o{i}'} for i in range(60)])
        result = _rank_custom_field_candidates(items)
        assert all(c['key'] != 'order_id' for c in result)

    def test_excludes_a_single_value_field(self):
        from metrics_handler import _rank_custom_field_candidates
        items = self._items(*[{'env': 'prod'} for _ in range(10)])
        assert _rank_custom_field_candidates(items) == []

    def test_excludes_a_sparse_field_below_coverage_floor(self):
        from metrics_handler import _rank_custom_field_candidates
        # 'plan' present on only 1 of 20 records → below the coverage floor.
        items = self._items({'plan': 'enterprise'}, *[{'region': 'EMEA'} for _ in range(19)])
        keys = {c['key'] for c in _rank_custom_field_candidates(items)}
        assert 'plan' not in keys

    def test_ranks_wider_coverage_first(self):
        from metrics_handler import _rank_custom_field_candidates
        # Both qualify; 'region' covers all 4, 'tier' covers 2 → region first.
        items = self._items(
            {'region': 'EMEA', 'tier': 'gold'},
            {'region': 'APAC', 'tier': 'gold'},
            {'region': 'EMEA'},
            {'region': 'APAC'},
        )
        result = _rank_custom_field_candidates(items)
        assert [c['key'] for c in result][0] == 'region'

    def test_ignores_items_without_custom_fields(self):
        from metrics_handler import _rank_custom_field_candidates
        items = [{'text': 'no fields'}, {'custom_fields': None}, {'custom_fields': {'region': 'EMEA'}}]
        # Only one item has a usable value → coverage 1/3, single value → excluded.
        # Confirms non-dict custom_fields don't crash the tally.
        assert _rank_custom_field_candidates(items) == []

    def test_null_and_empty_values_do_not_count_toward_coverage(self):
        from metrics_handler import _rank_custom_field_candidates
        # 'region' has two real values on 2 of 4 rows; the None and '' rows are
        # skipped, so coverage is 2/4 (not 4/4) and the empty values never seed a
        # phantom distinct value.
        items = self._items(
            {'region': 'EMEA'}, {'region': 'APAC'}, {'region': None}, {'region': ''},
        )
        result = _rank_custom_field_candidates(items)
        assert len(result) == 1
        rec = result[0]
        assert rec['key'] == 'region'
        assert rec['distinct_values'] == 2
        assert rec['coverage'] == 0.5
        assert all(tv['value'] not in (None, '') for tv in rec['top_values'])

    def test_numeric_and_string_twins_bucket_together(self):
        from metrics_handler import _rank_custom_field_candidates
        # 5 and "5" are the same facet value — the ranker str()s before tallying,
        # matching how the filter compares. Two distinct values (5, 7), not three.
        items = self._items(
            {'tier': 5}, {'tier': '5'}, {'tier': 7}, {'tier': 7},
        )
        result = _rank_custom_field_candidates(items)
        assert len(result) == 1
        rec = result[0]
        assert rec['distinct_values'] == 2
        assert {'value': '5', 'count': 2} in rec['top_values']


class TestAggregateProblems:
    """Tests for _aggregate_problems() — the finest-grain problem bucketer."""

    @staticmethod
    def _row(**kw):
        return kw

    def test_returns_empty_for_no_items(self):
        from metrics_handler import _aggregate_problems
        assert _aggregate_problems([]) == []

    def test_skips_rows_without_problem_summary(self):
        from metrics_handler import _aggregate_problems
        rows = [
            {'category': 'delivery', 'problem_summary': ''},
            {'category': 'delivery'},  # no key at all
            {'category': 'delivery', 'problem_summary': '   '},  # whitespace only
        ]
        assert _aggregate_problems(rows) == []

    def test_buckets_by_category_subcategory_and_exact_problem(self):
        from metrics_handler import _aggregate_problems
        rows = [
            {'category': 'delivery', 'subcategory': 'late', 'problem_summary': 'order arrived late', 'sentiment_score': -0.5},
            {'category': 'delivery', 'subcategory': 'late', 'problem_summary': 'order arrived late', 'sentiment_score': -0.9},
            {'category': 'delivery', 'subcategory': 'damaged', 'problem_summary': 'order arrived late', 'sentiment_score': -0.1},
        ]
        result = _aggregate_problems(rows)
        # Same text but different subcategory → two leaves, not one.
        assert len(result) == 2
        late = next(r for r in result if r['subcategory'] == 'late')
        assert late['count'] == 2
        assert late['avg_sentiment'] == pytest.approx(-0.7)

    def test_defaults_missing_category_and_subcategory(self):
        from metrics_handler import _aggregate_problems
        result = _aggregate_problems([{'problem_summary': 'something broke'}])
        assert result[0]['category'] == 'uncategorized'
        assert result[0]['subcategory'] == 'general'

    def test_counts_urgent_and_captures_first_root_cause(self):
        from metrics_handler import _aggregate_problems
        rows = [
            {'problem_summary': 'app crashes', 'urgency': 'high'},
            {'problem_summary': 'app crashes', 'urgency': 'low',
             'problem_root_cause_hypothesis': 'memory leak'},
            {'problem_summary': 'app crashes', 'urgency': 'high',
             'problem_root_cause_hypothesis': 'ignored (first non-empty wins)'},
        ]
        leaf = _aggregate_problems(rows)[0]
        assert leaf['count'] == 3
        assert leaf['urgent_count'] == 2
        assert leaf['root_cause'] == 'memory leak'

    def test_emits_keywords_for_client_merge(self):
        from metrics_handler import _aggregate_problems
        leaf = _aggregate_problems([{'problem_summary': 'The delivery was very late'}])[0]
        # Stopwords dropped, sorted; matches shared.problem_clustering.extract_keywords.
        assert leaf['keywords'] == ['delivery', 'late']

    def test_tolerates_missing_or_nonnumeric_sentiment(self):
        from metrics_handler import _aggregate_problems
        rows = [
            {'problem_summary': 'x'},  # no sentiment_score
            {'problem_summary': 'x', 'sentiment_score': None},
            {'problem_summary': 'x', 'sentiment_score': 0.6},
        ]
        leaf = _aggregate_problems(rows)[0]
        assert leaf['count'] == 3
        assert leaf['avg_sentiment'] == pytest.approx(0.2)

    def test_sorts_biggest_problem_first(self):
        from metrics_handler import _aggregate_problems
        rows = (
            [{'problem_summary': 'rare'}]
            + [{'problem_summary': 'common'} for _ in range(5)]
        )
        result = _aggregate_problems(rows)
        assert [r['problem'] for r in result] == ['common', 'rare']


class TestProblemsEndpoint:
    """Tests for GET /feedback/problems."""

    @patch('metrics_handler.feedback_table')
    def test_returns_aggregated_problems_from_the_window(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        rows = [
            {'pk': 'SOURCE#x', 'sk': f'FEEDBACK#{i}', 'category': 'delivery',
             'subcategory': 'late', 'problem_summary': 'order late', 'urgency': 'high'}
            for i in range(3)
        ]
        mock_fb_table.query.return_value = {'Items': rows}
        event = api_gateway_event(
            method='GET', path='/feedback/problems', query_params={'days': '1'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['feedback_count'] == 3
        assert len(body['problems']) == 1
        assert body['problems'][0]['count'] == 3
        assert body['problems'][0]['urgent_count'] == 3
        assert body['problems'][0]['keywords'] == ['late', 'order']

    @patch('metrics_handler.feedback_table')
    def test_applies_custom_field_filter_before_aggregation(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        # Two rows, same problem, different custom_fields.tier — a cf_tier filter
        # must keep only the matching row, and the aggregated count must reflect
        # that (the filter is applied before bucketing, not after).
        rows = [
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#1', 'category': 'delivery',
             'subcategory': 'late', 'problem_summary': 'order late',
             'custom_fields': {'tier': 'Gold'}},
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#2', 'category': 'delivery',
             'subcategory': 'late', 'problem_summary': 'order late',
             'custom_fields': {'tier': 'Platinum'}},
        ]
        mock_fb_table.query.return_value = {'Items': rows}
        event = api_gateway_event(
            method='GET', path='/feedback/problems',
            query_params={'days': '1', 'cf_tier': 'Gold'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['feedback_count'] == 1
        assert len(body['problems']) == 1
        assert body['problems'][0]['count'] == 1


class TestParseCustomFieldFilters:
    """Tests for _parse_custom_field_filters() — cf_<key> query-param extraction."""

    def test_extracts_prefixed_params_and_strips_prefix(self):
        from shared.feedback_filters import (
            parse_custom_field_filters as _parse_custom_field_filters,
        )
        result = _parse_custom_field_filters({'cf_region': 'EMEA', 'cf_tier': 'gold'})
        assert result == {'region': ('EMEA',), 'tier': ('gold',)}

    def test_ignores_non_prefixed_params(self):
        from shared.feedback_filters import (
            parse_custom_field_filters as _parse_custom_field_filters,
        )
        result = _parse_custom_field_filters({'source': 'webscraper', 'days': '7', 'cf_region': 'EMEA'})
        assert result == {'region': ('EMEA',)}

    def test_drops_empty_and_none_values(self):
        from shared.feedback_filters import (
            parse_custom_field_filters as _parse_custom_field_filters,
        )
        # An empty value is the UI's "no selection" — it must not filter.
        result = _parse_custom_field_filters({'cf_region': '', 'cf_tier': None, 'cf_plan': 'pro'})
        assert result == {'plan': ('pro',)}

    def test_ignores_bare_prefix_with_empty_key(self):
        from shared.feedback_filters import (
            parse_custom_field_filters as _parse_custom_field_filters,
        )
        result = _parse_custom_field_filters({'cf_': 'value'})
        assert result == {}

    def test_returns_empty_for_no_matching_params(self):
        from shared.feedback_filters import (
            parse_custom_field_filters as _parse_custom_field_filters,
        )
        assert _parse_custom_field_filters({'days': '7'}) == {}


class TestItemMatchesCustomFields:
    """Tests for _item_matches_custom_fields() — the per-item AND match."""

    def test_matches_when_all_filters_satisfied(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        item = {'custom_fields': {'region': 'EMEA', 'tier': 'gold'}}
        assert _item_matches_custom_fields(item, {'region': 'EMEA', 'tier': 'gold'}) is True

    def test_fails_when_any_filter_unsatisfied(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        item = {'custom_fields': {'region': 'EMEA', 'tier': 'silver'}}
        assert _item_matches_custom_fields(item, {'region': 'EMEA', 'tier': 'gold'}) is False

    def test_matches_numeric_value_against_string_filter(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        # Stored 5 (number) matches requested "5" (query params are strings).
        item = {'custom_fields': {'tier': 5}}
        assert _item_matches_custom_fields(item, {'tier': '5'}) is True

    def test_fails_when_field_missing(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        item = {'custom_fields': {'region': 'EMEA'}}
        assert _item_matches_custom_fields(item, {'tier': 'gold'}) is False

    def test_fails_when_field_value_is_none(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        item = {'custom_fields': {'region': None}}
        assert _item_matches_custom_fields(item, {'region': 'EMEA'}) is False

    def test_fails_when_item_has_no_custom_fields_map(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        assert _item_matches_custom_fields({'text': 'x'}, {'region': 'EMEA'}) is False
        assert _item_matches_custom_fields({'custom_fields': None}, {'region': 'EMEA'}) is False

    def test_matches_everything_when_no_filters(self):
        from shared.feedback_filters import (
            item_matches_custom_fields as _item_matches_custom_fields,
        )
        # No active custom filters → every item passes, even one with no map.
        assert _item_matches_custom_fields({'text': 'x'}, {}) is True


class TestCustomFieldFilteringEndpoints:
    """cf_<key> filtering applied by /feedback, /feedback/urgent, /feedback/search."""

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_list_feedback_narrows_to_matching_custom_field(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        rows = [
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#1', 'date': '2025-01-01', 'custom_fields': {'region': 'EMEA'}},
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#2', 'date': '2025-01-01', 'custom_fields': {'region': 'APAC'}},
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#3', 'date': '2025-01-01', 'custom_fields': {'region': 'EMEA'}},
        ]
        # One day with rows, then empty for the remaining days of the window.
        mock_fb_table.query.side_effect = [{'Items': rows}] + [{'Items': []}] * 10
        event = api_gateway_event(
            method='GET', path='/feedback', query_params={'cf_region': 'EMEA', 'days': '7'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['total'] == 2
        assert all(i['custom_fields']['region'] == 'EMEA' for i in body['items'])

    @patch('metrics_handler.feedback_table')
    def test_urgent_feedback_narrows_to_matching_custom_field(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        gsi_rows = [{'pk': 'SOURCE#x', 'sk': f'FEEDBACK#{i}'} for i in range(2)]
        full = {
            ('SOURCE#x', 'FEEDBACK#0'): {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#0', 'date': today,
                                         'custom_fields': {'region': 'EMEA'}},
            ('SOURCE#x', 'FEEDBACK#1'): {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#1', 'date': today,
                                         'custom_fields': {'region': 'APAC'}},
        }
        mock_fb_table.query.return_value = {'Items': gsi_rows}
        mock_fb_table.get_item.side_effect = lambda Key: {
            'Item': full[(Key['pk'], Key['sk'])]
        }
        event = api_gateway_event(
            method='GET', path='/feedback/urgent', query_params={'cf_region': 'EMEA'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['items'][0]['custom_fields']['region'] == 'EMEA'

    @patch('metrics_handler.feedback_table')
    def test_search_feedback_narrows_to_matching_custom_field(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        rows = [
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#1', 'date': today, 'original_text': 'slow checkout',
             'custom_fields': {'region': 'EMEA'}},
            {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#2', 'date': today, 'original_text': 'slow checkout',
             'custom_fields': {'region': 'APAC'}},
        ]
        mock_fb_table.query.side_effect = [{'Items': rows}] + [{'Items': []}] * 40
        event = api_gateway_event(
            method='GET', path='/feedback/search',
            query_params={'q': 'checkout', 'cf_region': 'EMEA', 'days': '30'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['items'][0]['custom_fields']['region'] == 'EMEA'


class TestCustomFieldCandidatesEndpoint:
    """Tests for GET /feedback/custom-field-candidates."""

    @patch('metrics_handler.feedback_table')
    def test_returns_ranked_candidates_from_sampled_records(
        self, mock_fb_table, api_gateway_event, lambda_context
    ):
        # One day partition of records carrying a repeating custom field.
        rows = [
            {'pk': 'SOURCE#x', 'sk': f'FEEDBACK#{i}', 'custom_fields': {'region': 'EMEA' if i % 2 else 'APAC'}}
            for i in range(6)
        ]
        mock_fb_table.query.return_value = {'Items': rows}

        event = api_gateway_event(
            method='GET', path='/feedback/custom-field-candidates', query_params={'days': '1'},
        )
        response = metrics_lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['sampled_count'] == 6
        keys = [c['key'] for c in body['candidates']]
        assert 'region' in keys
