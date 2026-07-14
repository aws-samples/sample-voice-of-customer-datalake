"""
Tests for the `date_basis` query parameter on metrics_handler endpoints.

Every feedback item carries two dates:
- `date` / import date: when the item was processed into the data lake
- `source_created_at` / review date: when the customer wrote the feedback

The default basis ('imported') preserves historical behavior. The 'review'
basis excludes items that were only *imported* recently but *written* long
ago (e.g. a backfill of 3-year-old reviews).
"""
import json
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import patch


def _day(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _item(feedback_id: str, imported_days_ago: int, written_days_ago: int, **overrides) -> dict:
    """Feedback item imported `imported_days_ago` but written `written_days_ago`."""
    item = {
        'pk': 'SOURCE#webscraper',
        'sk': f'FEEDBACK#{feedback_id}',
        'feedback_id': feedback_id,
        'source_platform': 'webscraper',
        'original_text': f'review text {feedback_id}',
        'sentiment_label': 'positive',
        'sentiment_score': Decimal('0.8'),
        'category': 'delivery',
        'urgency': 'low',
        'persona_name': 'Loyal Customer',
        'date': _day(imported_days_ago),
        'source_created_at': _iso(written_days_ago),
    }
    item.update(overrides)
    return item


def _side_effect_for_day_loop(items: list[dict], days: int) -> list[dict]:
    """Day-loop query responses: all items on the first (today) page."""
    return [{'Items': items}] + [{'Items': []}] * (days - 1)


class TestListFeedbackDateBasis:
    """GET /feedback with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_excludes_old_reviews_imported_recently(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """A 3-year-old review imported today is dropped under review basis."""
        items = [
            _item('recent', imported_days_ago=0, written_days_ago=2),
            _item('ancient', imported_days_ago=0, written_days_ago=1095),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == 'recent'

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_default_basis_keeps_old_reviews_imported_recently(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """Without date_basis the import window governs (regression guard)."""
        items = [
            _item('recent', imported_days_ago=0, written_days_ago=2),
            _item('ancient', imported_days_ago=0, written_days_ago=1095),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/feedback', query_params={'days': '7'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['count'] == 2
        assert {i['feedback_id'] for i in body['items']} == {'recent', 'ancient'}

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_invalid_basis_falls_back_to_imported(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """Unknown date_basis values behave like the default."""
        items = [_item('ancient', imported_days_ago=0, written_days_ago=1095)]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'date_basis': 'bogus'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['count'] == 1

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_keeps_items_missing_source_created_at(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """Items without a review date fall back to their import date."""
        no_source_date = _item('no-source-date', imported_days_ago=0, written_days_ago=0)
        del no_source_date['source_created_at']
        mock_fb.query.side_effect = _side_effect_for_day_loop([no_source_date], days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == 'no-source-date'

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_combines_with_source_filter(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """Review window and source filter apply together (AND)."""
        items = [
            _item('match', imported_days_ago=0, written_days_ago=1),
            _item('wrong-source', imported_days_ago=0, written_days_ago=1,
                  source_platform='manual_import'),
            _item('too-old', imported_days_ago=0, written_days_ago=400),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback',
            query_params={'days': '7', 'date_basis': 'review', 'source': 'webscraper'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['match']


class TestUrgentFeedbackDateBasis:
    """GET /feedback/urgent with date_basis."""

    def _wire_urgent_mocks(self, mock_fb, full_items: list[dict]):
        gsi_rows = [{'pk': i['pk'], 'sk': i['sk']} for i in full_items]
        mock_fb.query.return_value = {'Items': gsi_rows}
        mock_fb.get_item.side_effect = [{'Item': i} for i in full_items]

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_excludes_urgent_items_written_before_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('urgent-new', imported_days_ago=0, written_days_ago=3, urgency='high'),
            _item('urgent-old', imported_days_ago=0, written_days_ago=200, urgency='high'),
        ]
        self._wire_urgent_mocks(mock_fb, items)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/urgent', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['urgent-new']

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_imported_basis_keeps_urgent_items_written_before_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('urgent-old', imported_days_ago=0, written_days_ago=200, urgency='high'),
        ]
        self._wire_urgent_mocks(mock_fb, items)

        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/feedback/urgent', query_params={'days': '30'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['urgent-old']


class TestSearchFeedbackDateBasis:
    """GET /feedback/search with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_excludes_matches_written_before_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('hit-new', imported_days_ago=0, written_days_ago=2,
                  original_text='slow delivery again'),
            _item('hit-old', imported_days_ago=0, written_days_ago=500,
                  original_text='slow delivery years ago'),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=30)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/search',
            query_params={'q': 'slow', 'days': '30', 'date_basis': 'review'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['hit-new']


class TestEntitiesDateBasis:
    """GET /feedback/entities with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_computes_entities_from_items_within_review_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('a', imported_days_ago=0, written_days_ago=1,
                  category='delivery', persona_name='Loyal Customer'),
            _item('b', imported_days_ago=0, written_days_ago=2,
                  category='billing', source_platform='manual_import',
                  persona_name='New Customer'),
            _item('old', imported_days_ago=0, written_days_ago=900,
                  category='delivery'),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback/entities', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['feedback_count'] == 2
        assert body['entities']['categories'] == {'delivery': 1, 'billing': 1}
        assert body['entities']['sources'] == {'webscraper': 1, 'manual_import': 1}
        assert body['entities']['personas'] == {'Loyal Customer': 1, 'New Customer': 1}


class TestSummaryDateBasis:
    """GET /metrics/summary with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_buckets_daily_totals_by_review_date(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('a', imported_days_ago=0, written_days_ago=2),
            _item('b', imported_days_ago=0, written_days_ago=2),
            _item('c', imported_days_ago=0, written_days_ago=5, urgency='high'),
            _item('old', imported_days_ago=0, written_days_ago=400),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/summary', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['total_feedback'] == 3
        assert body['urgent_count'] == 1
        assert body['daily_totals'] == [
            {'date': _day(2), 'count': 2},
            {'date': _day(5), 'count': 1},
        ]
        # All items carry sentiment_score 0.8
        assert body['avg_sentiment'] == 0.8
        # Aggregates table is bypassed entirely under review basis
        mock_agg.get_item.assert_not_called()

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_imported_basis_still_reads_aggregates(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        mock_agg.get_item.return_value = {'Item': {'count': 5, 'sum': Decimal('2.5')}}

        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/metrics/summary', query_params={'days': '7'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['period_days'] == 7
        assert mock_agg.get_item.called
        mock_fb.query.assert_not_called()


class TestSentimentDateBasis:
    """GET /metrics/sentiment with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_counts_sentiment_from_items_within_review_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('a', imported_days_ago=0, written_days_ago=1, sentiment_label='positive'),
            _item('b', imported_days_ago=0, written_days_ago=2, sentiment_label='negative'),
            _item('old', imported_days_ago=0, written_days_ago=300, sentiment_label='negative'),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=30)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/sentiment', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['total'] == 2
        assert body['breakdown'] == {'positive': 1, 'neutral': 0, 'negative': 1, 'mixed': 0}


class TestCategoriesDateBasis:
    """GET /metrics/categories with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_counts_categories_from_items_within_review_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        from shared.api import clear_categories_cache
        clear_categories_cache()
        mock_agg.get_item.return_value = {}

        items = [
            _item('a', imported_days_ago=0, written_days_ago=1, category='delivery'),
            _item('b', imported_days_ago=0, written_days_ago=2, category='delivery'),
            _item('old', imported_days_ago=0, written_days_ago=300, category='billing'),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=30)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/categories', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['categories'] == {'delivery': 2}


class TestSourcesDateBasis:
    """GET /metrics/sources with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_counts_sources_from_items_within_review_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('a', imported_days_ago=0, written_days_ago=1),
            _item('b', imported_days_ago=0, written_days_ago=2,
                  source_platform='manual_import'),
            _item('old', imported_days_ago=0, written_days_ago=300),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=30)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/sources', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['sources'] == {'webscraper': 1, 'manual_import': 1}
        mock_agg.query.assert_not_called()

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_imported_basis_still_reads_source_aggregates(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        mock_agg.query.return_value = {'Items': [
            {'pk': 'METRIC#daily_source#webscraper', 'sk': _day(1), 'count': 4},
        ]}

        from metrics_handler import lambda_handler
        event = api_gateway_event(path='/metrics/sources', query_params={'days': '30'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['sources'] == {'webscraper': 4}
        mock_fb.query.assert_not_called()


class TestPersonasDateBasis:
    """GET /metrics/personas with date_basis."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_counts_personas_from_items_within_review_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('a', imported_days_ago=0, written_days_ago=1, persona_name='Loyal Customer'),
            _item('b', imported_days_ago=0, written_days_ago=2, persona_name='Loyal Customer'),
            _item('old', imported_days_ago=0, written_days_ago=300, persona_name='Bargain Hunter'),
        ]
        mock_fb.query.side_effect = _side_effect_for_day_loop(items, days=30)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/personas', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['personas'] == {'Loyal Customer': 2}
        mock_agg.query.assert_not_called()



class TestBasisDateEdgeCases:
    """Edge cases for the review-date fallback logic."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_falls_back_to_import_date_for_malformed_source_date(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """A truncated/garbage source_created_at behaves like a missing one."""
        malformed = _item('malformed', imported_days_ago=0, written_days_ago=0,
                          source_created_at='2023')
        mock_fb.query.side_effect = _side_effect_for_day_loop([malformed], days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        # Import date (today) is inside the window, so the item is kept.
        assert body['count'] == 1
        assert body['items'][0]['feedback_id'] == 'malformed'

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_review_basis_summary_returns_zeroes_for_empty_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """No matching items yields zeroed metrics without division errors."""
        mock_fb.query.side_effect = _side_effect_for_day_loop([], days=7)

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/summary', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['total_feedback'] == 0
        assert body['avg_sentiment'] == 0
        assert body['urgent_count'] == 0
        assert body['daily_totals'] == []
        assert body['daily_sentiment'] == []



class TestCategoryBranchDaysWindow:
    """The category-only GSI branch must honor the `days` window.

    Regression guard: the category branch queries a time-unbounded GSI and
    previously ignored `days` entirely, silently returning all-time results
    while the UI showed a 7-day window.
    """

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_category_filter_excludes_items_imported_before_window(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('in-window', imported_days_ago=1, written_days_ago=1, category='delivery'),
            _item('stale', imported_days_ago=60, written_days_ago=60, category='delivery'),
        ]
        mock_fb.query.return_value = {'Items': items}

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'category': 'delivery'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['in-window']
        # The category branch still uses the category GSI, not the date loop.
        assert mock_fb.query.call_args.kwargs['IndexName'] == 'gsi2-by-category'

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_category_filter_with_review_basis_excludes_old_reviews(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [
            _item('fresh-review', imported_days_ago=0, written_days_ago=2, category='delivery'),
            _item('old-review', imported_days_ago=0, written_days_ago=400, category='delivery'),
        ]
        mock_fb.query.return_value = {'Items': items}

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback',
            query_params={'days': '7', 'category': 'delivery', 'date_basis': 'review'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['fresh-review']



class TestDominatedPartitionSourceFilter:
    """Source-filtered reads must survive partitions dominated by one source.

    Regression guard for issue #99: each date partition used to be read with
    a single unpaged query and filtered in memory afterwards, so a partition
    whose first page was 100% one source returned zero results for every
    other source. The fix pushes the source filter into a server-side
    FilterExpression and pages via LastEvaluatedKey.
    """

    @staticmethod
    def _paged_responses(pages):
        """Build query side effects: every page but the last links onward."""
        responses = []
        for idx, items in enumerate(pages):
            response = {'Items': items, 'ScannedCount': max(len(items), 1)}
            if idx < len(pages) - 1:
                response['LastEvaluatedKey'] = {'pk': f'page-{idx}'}
            responses.append(response)
        return responses

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_feedback_list_finds_source_beyond_first_page_of_dominated_day(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """Items of the requested source on page 2 are returned, not starved."""
        dominant = [
            _item(f'c-{i}', imported_days_ago=0, written_days_ago=0,
                  source_platform='source_c')
            for i in range(3)
        ]
        wanted = [_item('a-1', imported_days_ago=0, written_days_ago=0,
                        source_platform='source_a')]
        # Server-side FilterExpression means page 1 yields no matches but
        # links to page 2 where the wanted row lives.
        day_pages = self._paged_responses([[], wanted])
        empty_days = [{'Items': [], 'ScannedCount': 0}] * 6
        mock_fb.query.side_effect = day_pages + empty_days
        del dominant  # dominant rows never surface: DynamoDB filters them

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'source': 'source_a'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [i['feedback_id'] for i in body['items']] == ['a-1']
        # The source filter must be pushed down to DynamoDB.
        first_call = mock_fb.query.call_args_list[0]
        assert 'FilterExpression' in first_call.kwargs

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_sentiment_metrics_count_source_rows_beyond_first_page(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        wanted = [
            _item('a-1', imported_days_ago=0, written_days_ago=0,
                  source_platform='source_a', sentiment_label='negative'),
            _item('a-2', imported_days_ago=0, written_days_ago=0,
                  source_platform='source_a', sentiment_label='positive'),
        ]
        day_pages = self._paged_responses([[], wanted])
        empty_days = [{'Items': [], 'ScannedCount': 0}] * 29
        mock_fb.query.side_effect = day_pages + empty_days

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/sentiment', query_params={'days': '30', 'source': 'source_a'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['total'] == 2
        assert body['breakdown']['negative'] == 1
        assert body['breakdown']['positive'] == 1

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_category_branch_pages_past_the_first_page(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """The category GSI is paged too — one query is only one page."""
        page1 = [_item('p1', imported_days_ago=0, written_days_ago=0, category='delivery')]
        page2 = [_item('p2', imported_days_ago=0, written_days_ago=0, category='delivery')]
        mock_fb.query.side_effect = self._paged_responses([page1, page2])

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '7', 'category': 'delivery'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert {i['feedback_id'] for i in body['items']} == {'p1', 'p2'}

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_partition_paging_stops_at_scan_ceiling(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """A pathological partition can't loop forever: the scan ceiling holds."""
        # Every page scans 5000 rows, matches nothing, and links onward.
        endless_page = {
            'Items': [], 'ScannedCount': 5000, 'LastEvaluatedKey': {'pk': 'next'},
        }
        mock_fb.query.side_effect = [endless_page] * 50

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/feedback', query_params={'days': '1', 'source': 'ghost'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['items'] == []
        # 10000-row ceiling per partition => exactly 2 pages of 5000 scanned.
        assert mock_fb.query.call_count == 2



class TestReviewMetricsPartiality:
    """Review-basis metrics must disclose when the scan was truncated.

    Aggregates are exact; the review-basis raw scan is budget-bounded. When
    the budget truncates the window the numbers are a lower bound, and the
    response must say so via `is_partial` instead of silently degrading.
    """

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_summary_flags_partial_when_scan_truncated(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        # First day: the partition hits the per-partition scan ceiling with
        # rows left behind (LastEvaluatedKey present) => truncated window.
        truncated_day = {
            'Items': [_item('a-1', imported_days_ago=0, written_days_ago=0)],
            'ScannedCount': 10000,
            'LastEvaluatedKey': {'pk': 'more'},
        }
        empty_days = [{'Items': [], 'ScannedCount': 0}] * 29
        mock_fb.query.side_effect = [truncated_day] + empty_days

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/summary', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is True
        assert body['total_feedback'] == 1

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_summary_not_partial_when_window_fully_scanned(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        items = [_item('a-1', imported_days_ago=0, written_days_ago=0)]
        mock_fb.query.side_effect = (
            [{'Items': items, 'ScannedCount': 1}]
            + [{'Items': [], 'ScannedCount': 0}] * 29
        )

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/summary', query_params={'days': '30', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is False
        assert body['total_feedback'] == 1

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_sentiment_metrics_flag_partial_scan(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        truncated_day = {
            'Items': [_item('a-1', imported_days_ago=0, written_days_ago=0,
                            sentiment_label='negative')],
            'ScannedCount': 10000,
            'LastEvaluatedKey': {'pk': 'more'},
        }
        empty_days = [{'Items': [], 'ScannedCount': 0}] * 29
        mock_fb.query.side_effect = [truncated_day] + empty_days

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/sentiment',
            query_params={'days': '30', 'source': 'webscraper'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is True
        assert body['breakdown']['negative'] == 1

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_aggregate_paths_report_complete(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        """The exact pre-computed aggregate branch is never partial."""
        mock_agg.get_item.return_value = {'Item': {'count': 5}}

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/sentiment', query_params={'days': '7'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is False
        mock_fb.query.assert_not_called()


class TestMalformedSourceCreatedAt:
    """Garbage source dates must fall back to the import date, not become
    lexicographic winners and pollute daily buckets (e.g. 'unavailable')."""

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_non_date_string_falls_back_to_import_date(
        self, mock_fb, mock_agg, api_gateway_event, lambda_context
    ):
        item = _item('weird', imported_days_ago=0, written_days_ago=0)
        item['source_created_at'] = 'unavailable-forever'
        mock_fb.query.side_effect = (
            [{'Items': [item], 'ScannedCount': 1}]
            + [{'Items': [], 'ScannedCount': 0}] * 6
        )

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            path='/metrics/summary', query_params={'days': '7', 'date_basis': 'review'}
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        # Fallback keeps the item (import date is in-window) and buckets it
        # under a real date rather than a garbage key.
        assert body['total_feedback'] == 1
        bucket_dates = [d['date'] for d in body['daily_totals']]
        assert all(len(d) == 10 and d[4] == '-' for d in bucket_dates)
