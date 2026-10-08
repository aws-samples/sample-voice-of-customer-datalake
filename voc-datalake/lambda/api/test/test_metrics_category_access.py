"""Category access on the metrics API: restricted callers only see their categories."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import CATEGORIES_CONFIG, RESTRICTED_CLAIMS, aggregates_with, restricted_to
from handler_events_fixtures import call_route
from urgency_index_fixtures import wire_urgency_index

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.project_access import ACTING_SUBJECT_CLAIM

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')
ITEMS = [
    {'feedback_id': 'd1', 'category': 'delivery', 'date': TODAY, 'source_platform': 'web',
     'sentiment_label': 'negative', 'sentiment_score': -0.5, 'urgency': 'high', 'pk': 'p', 'sk': 'd1', 'original_text': 'parcel late'},
    {'feedback_id': 'b1', 'category': 'billing', 'date': TODAY, 'source_platform': 'app',
     'sentiment_label': 'positive', 'sentiment_score': 0.9, 'urgency': 'low', 'pk': 'p', 'sk': 'b1', 'original_text': 'parcel billed twice'},
    {'feedback_id': 'x1', 'date': TODAY, 'source_platform': 'web', 'pk': 'p', 'sk': 'x1'},
]

# The source half of `GET /feedback/access` when no source is hidden.
ALL_SOURCES = {'sources_all': True, 'sources': [], 'source_rule': 'all', 'sources_denied': []}


def _restricted_source(source_id: str) -> dict:
    """The source-profiles row with ``source_id`` marked restricted."""
    return {'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [
        {'id': source_id, 'label': source_id, 'restricted': True}]}


@pytest.fixture(autouse=True)
def _fresh_categories_cache():
    clear_categories_cache()
    yield
    clear_categories_cache()


def _feedback_table(items=ITEMS):
    table = MagicMock()

    def query(**kwargs):
        if kwargs.get('IndexName') == 'gsi4-by-feedback-id':
            wanted = kwargs['KeyConditionExpression'].get_expression()['values'][1]
            return {'Items': [i for i in items if i['feedback_id'] == wanted]}
        return {'Items': list(items)}

    wire_urgency_index(table, items)
    table.query.side_effect = query
    table.get_item.side_effect = lambda Key, **_: {'Item': next(i for i in items if i['sk'] == Key['sk'])}
    return table


def _call(api_gateway_event, lambda_context, path, aggregates, *, claims=RESTRICTED_CLAIMS, query=None):
    with patch('metrics_handler.feedback_table', _feedback_table()), \
            patch('metrics_handler.aggregates_table', aggregates):
        return call_route(lambda_handler, api_gateway_event, lambda_context,
                          method='GET', path=path, query_params=query or {'days': '1'}, claims=claims)


class TestFeedbackAccessRoute:
    def test_restricted_caller(self, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, '/feedback/access', restricted_to('delivery'))
        assert response['statusCode'] == 200
        assert body == {'all': False, 'categories': ['delivery'], **ALL_SOURCES}

    def test_no_row_is_all(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback/access', aggregates_with())
        assert body == {'all': True, 'categories': [], **ALL_SOURCES}

    def test_admin_without_any_read(self, api_gateway_event, lambda_context):
        aggregates = MagicMock()
        _, body = _call(api_gateway_event, lambda_context, '/feedback/access', aggregates,
                        claims={'sub': 'a', 'cognito:groups': 'admins'})
        assert body['all'] is True
        aggregates.get_item.assert_not_called()

    def test_source_restricted_caller_reports_the_source_rule(self, api_gateway_event, lambda_context):
        sources_row = _restricted_source('support_tickets')
        _, body = _call(api_gateway_event, lambda_context, '/feedback/access', aggregates_with(sources_row))
        assert (body['sources_all'], body['source_rule'], body['sources_denied']) == (
            False, 'deny', ['support_tickets'])
        granted = aggregates_with({**access_key(RESTRICTED_CLAIMS['sub']), 'sources': ['web']}, sources_row)
        _, body = _call(api_gateway_event, lambda_context, '/feedback/access', granted)
        assert (body['source_rule'], body['sources'], body['sources_denied']) == ('allow', ['web'], [])

    def test_mcp_credential_uses_its_minters_row(self, api_gateway_event, lambda_context):
        claims = {'sub': 'mcp:tok', 'cognito:groups': '', ACTING_SUBJECT_CLAIM: RESTRICTED_CLAIMS['sub']}
        _, body = _call(api_gateway_event, lambda_context, '/feedback/access', restricted_to('billing'),
                        claims=claims)
        assert body == {'all': False, 'categories': ['billing'], **ALL_SOURCES}


class TestItemRoutes:
    def test_list_hides_other_categories_and_uncategorised(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback', restricted_to('delivery'))
        assert [i['feedback_id'] for i in body['items']] == ['d1']
        assert body['total'] == 1

    def test_other_grant_sees_uncategorised(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback', restricted_to('other'))
        assert [i['feedback_id'] for i in body['items']] == ['x1']

    def test_get_forbidden_item_is_404(self, api_gateway_event, lambda_context):
        response, _ = _call(api_gateway_event, lambda_context, '/feedback/b1', restricted_to('delivery'))
        assert response['statusCode'] == 404
        response, body = _call(api_gateway_event, lambda_context, '/feedback/d1', restricted_to('delivery'))
        assert response['statusCode'] == 200
        assert body['feedback_id'] == 'd1'

    def test_similar_of_forbidden_item_is_404(self, api_gateway_event, lambda_context):
        response, _ = _call(api_gateway_event, lambda_context, '/feedback/b1/similar', restricted_to('delivery'))
        assert response['statusCode'] == 404

    def test_similar_results_are_filtered_to_the_scope(self, api_gateway_event, lambda_context):
        # The category partition (gsi2pk) can disagree with an item's `category`;
        # the fake returns every item for it, so only a results filter hides b1/x1.
        response, body = _call(api_gateway_event, lambda_context, '/feedback/d1/similar', restricted_to('delivery'))
        assert response['statusCode'] == 200
        assert body['items'] == []
        assert body['count'] == 0

    def test_search_and_urgent_filter(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback/search', restricted_to('delivery'),
                        query={'q': 'parcel', 'days': '1'})
        assert [i['feedback_id'] for i in body['items']] == ['d1']
        _, body = _call(api_gateway_event, lambda_context, '/feedback/urgent', restricted_to('delivery'))
        assert [i['feedback_id'] for i in body['items']] == ['d1']

    def test_entities_use_the_scan_path(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/feedback/entities', restricted_to('delivery'))
        assert body['feedback_count'] == 1
        assert body['entities']['categories'] == {'delivery': 1}


class TestMetricRoutes:
    def test_summary_is_computed_from_visible_items(self, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, '/metrics/summary', restricted_to('delivery'))
        assert body['total_feedback'] == 1
        assert body['urgent_count'] == 1

    @pytest.mark.parametrize(('path', 'key', 'expected'), [
        ('/metrics/sentiment', 'breakdown', {'positive': 0, 'neutral': 0, 'negative': 1, 'mixed': 0}),
        ('/metrics/sources', 'sources', {'web': 1}),
    ])
    def test_global_breakdowns_use_the_scan_path(self, api_gateway_event, lambda_context, path, key, expected):
        _, body = _call(api_gateway_event, lambda_context, path, restricted_to('delivery'))
        assert body[key] == expected

    def test_category_metrics_never_read_forbidden_partitions(self, api_gateway_event, lambda_context):
        aggregates = restricted_to('delivery')
        _, body = _call(api_gateway_event, lambda_context, '/metrics/categories', aggregates)
        partitions = {
            call.kwargs['KeyConditionExpression'].get_expression()['values'][0].get_expression()['values'][1]
            for call in aggregates.query.call_args_list
        }
        assert partitions == {'METRIC#daily_category#delivery'}
        assert body['categories'] == {}

    def test_source_restricted_category_metrics_use_the_item_path(self, api_gateway_event, lambda_context):
        sources_row = _restricted_source('app')
        aggregates = aggregates_with(sources_row, CATEGORIES_CONFIG)
        _, body = _call(api_gateway_event, lambda_context, '/metrics/categories', aggregates)
        assert body['categories'] == {'delivery': 1, 'other': 1}

    def test_unrestricted_caller_keeps_the_aggregate_path(self, api_gateway_event, lambda_context):
        feedback = _feedback_table()
        with patch('metrics_handler.feedback_table', feedback), \
                patch('metrics_handler.aggregates_table', aggregates_with()):
            call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                       path='/metrics/summary', query_params={'days': '1'}, claims=RESTRICTED_CLAIMS)
        feedback.query.assert_not_called()
