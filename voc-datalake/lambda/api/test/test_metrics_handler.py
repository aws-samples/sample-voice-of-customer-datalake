"""
Tests for metrics_handler.py - /feedback/* and /metrics/* endpoints.
"""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch


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
            label = pk.rsplit('#', 1)[-1]
            return [{'sk': '2026-01-07', 'count': counts[label]}]
        
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
            category = pk.rsplit('#', 1)[-1]
            return [{'sk': '2026-01-07', 'count': counts[category]}]
        
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
            items = _query_metric_window('METRIC#urgent', 7, current)

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
        rests on item width the aggregator controls. If a page boundary ever
        appears these endpoints have no is_partial signal, so a dropped page
        would be a silently wrong total.
        """
        from metrics_handler import _query_metric_window

        pages = [
            {'Items': [{'sk': '2026-03-10', 'count': 1}], 'LastEvaluatedKey': {'pk': 'p', 'sk': '2026-03-10'}},
            {'Items': [{'sk': '2026-03-09', 'count': 2}]},
        ]
        with patch('metrics_handler.aggregates_table') as mock_table:
            mock_table.query.side_effect = pages
            items = _query_metric_window('METRIC#urgent', 7,
                                         datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 2
        assert items == [
            {'sk': '2026-03-10', 'count': 1},
            {'sk': '2026-03-09', 'count': 2},
        ]
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
        assumption has broken and that needs to be visible — these endpoints
        have no is_partial field to carry the fact.
        """
        from metrics_handler import _query_metric_window

        # Every page reports another cursor, so the bound is what stops it.
        with patch('metrics_handler.aggregates_table') as mock_table, \
             patch('metrics_handler.logger') as mock_logger:
            mock_table.query.return_value = {
                'Items': [{'sk': '2026-03-10', 'count': 1}],
                'LastEvaluatedKey': {'pk': 'p', 'sk': '2026-03-10'},
            }
            items = _query_metric_window('METRIC#urgent', 3,
                                         datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 3, 'bound should cap pages at `days`'
        assert len(items) == 3
        assert mock_logger.warning.called, 'a partial window must not be silent'

    def test_does_not_warn_when_the_window_completes(self):
        """The warning must be specific to truncation, not fire on every read."""
        from metrics_handler import _query_metric_window

        with patch('metrics_handler.aggregates_table') as mock_table, \
             patch('metrics_handler.logger') as mock_logger:
            mock_table.query.return_value = {'Items': [{'sk': '2026-03-10', 'count': 1}]}
            _query_metric_window('METRIC#urgent', 3,
                                 datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert mock_table.query.call_count == 1
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
