"""Unified feedback filters on the metrics endpoints (shared/feedback_filters.py).

Covers what the shared model added on top of the single-valued filters:
multi-value source/category/sentiment, registry enrichment fields (usefulness,
including the `unscored` bucket), urgent-only, subcategory, the IN push-down of
several sources, and the filtered `/metrics/overview` breakdowns.
"""
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

import pytest


def _day(days_ago: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def _item(feedback_id: str, **overrides) -> dict:
    item = {
        'pk': 'SOURCE#webscraper',
        'sk': f'FEEDBACK#{feedback_id}',
        'feedback_id': feedback_id,
        'source_platform': 'webscraper',
        'original_text': f'text {feedback_id}',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.5'),
        'category': 'delivery',
        'subcategory': 'late',
        'urgency': 'low',
        'persona_type': 'existing_customer',
        'problem_summary': f'problem summary {feedback_id}',
        'date': _day(),
        'source_created_at': datetime.now(timezone.utc).isoformat(),
    }
    item.update(overrides)
    return item


CORPUS = [
    _item('a', usefulness='high'),
    _item('b', usefulness='low', source_platform='app_store', category='pricing'),
    _item('c', sentiment_label='positive', sentiment_score=Decimal('0.7'), urgency='high'),  # unscored
    _item('d', usefulness='medium', source_platform='manual_import', subcategory='lost',
          custom_fields={'region': 'EMEA'}),
]


def _day_loop(items: list[dict], days: int) -> list[dict]:
    return [{'Items': items}] + [{'Items': []}] * (days - 1)


def _call(path: str, params: dict, api_gateway_event, lambda_context) -> tuple[int, dict]:
    from metrics_handler import lambda_handler
    response = lambda_handler(api_gateway_event(path=path, query_params=params), lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.fixture
def feedback_table():
    with patch('metrics_handler.aggregates_table'), patch('metrics_handler.feedback_table') as table:
        table.query.side_effect = _day_loop(CORPUS, days=7)
        yield table


class TestListFeedbackFilters:
    @pytest.mark.parametrize('params,expected', [
        ({'sentiment': 'negative,positive'}, ['a', 'b', 'c', 'd']),
        ({'sentiment': 'positive'}, ['c']),
        ({'category': 'delivery,pricing'}, ['a', 'b', 'c', 'd']),
        ({'subcategory': 'lost'}, ['d']),
        ({'usefulness': 'high,medium'}, ['a', 'd']),
        ({'usefulness': 'unscored'}, ['c']),
        ({'urgent': 'true'}, ['c']),
        ({'cf_region': 'EMEA', 'usefulness': 'medium'}, ['d']),
        ({'source': 'app_store,manual_import'}, ['b', 'd']),
    ])
    def test_multi_value_and_enrichment_filters(
        self, params, expected, feedback_table, api_gateway_event, lambda_context,
    ):
        status, body = _call('/feedback', {'days': '7', **params}, api_gateway_event, lambda_context)
        assert status == 200
        assert sorted(i['feedback_id'] for i in body['items']) == expected
        assert body['total'] == len(expected)

    def test_several_sources_are_pushed_down_as_one_in_expression(
        self, feedback_table, api_gateway_event, lambda_context,
    ):
        _call('/feedback', {'days': '7', 'source': 'app_store,manual_import'}, api_gateway_event, lambda_context)
        expression = feedback_table.query.call_args_list[0].kwargs['FilterExpression']
        assert expression.expression_operator == 'IN'

    def test_an_undeclared_enrichment_value_is_a_400(self, feedback_table, api_gateway_event, lambda_context):
        status, _ = _call('/feedback', {'days': '7', 'usefulness': 'stellar'}, api_gateway_event, lambda_context)
        assert status == 400

    def test_multiple_categories_walk_the_date_index_not_one_category_partition(
        self, feedback_table, api_gateway_event, lambda_context,
    ):
        _call('/feedback', {'days': '7', 'category': 'delivery,pricing'}, api_gateway_event, lambda_context)
        assert all(
            call.kwargs['IndexName'] != 'gsi2-by-category'
            for call in feedback_table.query.call_args_list
        )


CUSTOM_FIELD_CORPUS = [
    _item('g', custom_fields={'tier': 'Gold', 'city': 'Las Vegas, NV'}),
    _item('p', custom_fields={'tier': 'Platinum', 'city': 'Reno'}),
    _item('d', custom_fields={'tier': 'Diamond', 'city': 'Las Vegas, NV'}),
    _item('n'),  # no custom fields at all
]


def _call_repeated(path: str, single: dict, multi: dict, api_gateway_event, lambda_context) -> tuple[int, dict]:
    """Like `_call`, with the multi-value query view a repeated param produces."""
    from metrics_handler import lambda_handler
    event = api_gateway_event(path=path, query_params=single)
    event['multiValueQueryStringParameters'] = multi
    response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


class TestMultiSelectCustomFields:
    """A multi-select custom field is a REPEATED `cf_<key>` param; API Gateway
    keeps only the last value in `queryStringParameters`, so the routes must
    read `multiValueQueryStringParameters`."""

    @pytest.fixture
    def table(self):
        with patch('metrics_handler.aggregates_table'), patch('metrics_handler.feedback_table') as table:
            table.query.side_effect = _day_loop(CUSTOM_FIELD_CORPUS, days=7)
            yield table

    def test_feedback_returns_items_matching_any_selected_value(self, table, api_gateway_event, lambda_context):
        status, body = _call_repeated(
            '/feedback',
            {'days': '7', 'cf_tier': 'Platinum'},
            {'days': ['7'], 'cf_tier': ['Gold', 'Platinum']},
            api_gateway_event, lambda_context,
        )
        assert status == 200
        assert sorted(i['feedback_id'] for i in body['items']) == ['g', 'p']

    def test_values_with_commas_match_exactly(self, table, api_gateway_event, lambda_context):
        status, body = _call_repeated(
            '/feedback',
            {'days': '7', 'cf_city': 'Las Vegas, NV'},
            {'days': ['7'], 'cf_city': ['Las Vegas, NV']},
            api_gateway_event, lambda_context,
        )
        assert status == 200
        assert sorted(i['feedback_id'] for i in body['items']) == ['d', 'g']

    def test_overview_counts_the_union_and_ands_across_keys(self, table, api_gateway_event, lambda_context):
        status, body = _call_repeated(
            '/metrics/overview',
            {'days': '7', 'cf_tier': 'Diamond', 'cf_city': 'Las Vegas, NV'},
            {'days': ['7'], 'cf_tier': ['Gold', 'Diamond'], 'cf_city': ['Las Vegas, NV']},
            api_gateway_event, lambda_context,
        )
        assert status == 200
        assert body['feedback_count'] == 2

    def test_a_single_cf_param_without_a_multi_value_view_still_filters(
        self, table, api_gateway_event, lambda_context,
    ):
        # The MCP delegate builds events with queryStringParameters only.
        status, body = _call('/feedback', {'days': '7', 'cf_tier': 'Gold'}, api_gateway_event, lambda_context)
        assert status == 200
        assert [i['feedback_id'] for i in body['items']] == ['g']


class TestUrgentAndSearchUseTheSameFilters:
    def test_urgent_applies_usefulness(self, api_gateway_event, lambda_context):
        urgent = [_item('u1', urgency='high', usefulness='high'), _item('u2', urgency='high')]
        with patch('metrics_handler.feedback_table') as table:
            table.query.return_value = {'Items': [{'pk': i['pk'], 'sk': i['sk']} for i in urgent]}
            table.get_item.side_effect = [{'Item': i} for i in urgent]
            status, body = _call('/feedback/urgent', {'days': '7', 'usefulness': 'unscored'},
                                 api_gateway_event, lambda_context)
        assert status == 200
        assert [i['feedback_id'] for i in body['items']] == ['u2']

    def test_search_applies_multi_value_sentiment(self, feedback_table, api_gateway_event, lambda_context):
        feedback_table.query.side_effect = _day_loop(CORPUS, days=30)
        status, body = _call('/feedback/search', {'q': 'text', 'days': '30', 'sentiment': 'positive,mixed'},
                             api_gateway_event, lambda_context)
        assert status == 200
        assert [i['feedback_id'] for i in body['items']] == ['c']


class TestProblemsFilters:
    def test_problems_aggregate_only_matching_rows(self, feedback_table, api_gateway_event, lambda_context):
        feedback_table.query.side_effect = _day_loop(CORPUS, days=30)
        status, body = _call('/feedback/problems', {'days': '30', 'usefulness': 'high,medium'},
                             api_gateway_event, lambda_context)
        assert status == 200
        assert body['feedback_count'] == 2
        assert sorted(p['problem'] for p in body['problems']) == [
            'problem summary a', 'problem summary d',
        ]


class TestMetricsOverview:
    def test_breakdowns_reflect_only_filtered_rows(self, feedback_table, api_gateway_event, lambda_context):
        status, body = _call('/metrics/overview', {'days': '7', 'category': 'delivery'},
                             api_gateway_event, lambda_context)
        assert status == 200
        assert body['feedback_count'] == 3
        assert body['categories'] == {'delivery': 3}
        assert body['sources'] == {'webscraper': 2, 'manual_import': 1}
        assert body['sentiment']['breakdown'] == {'positive': 1, 'neutral': 0, 'negative': 2, 'mixed': 0}
        assert body['sentiment']['total'] == 3
        assert body['summary']['total_feedback'] == 3
        assert body['summary']['urgent_count'] == 1
        assert body['enrichment']['usefulness'] == {'high': 1, 'unscored': 1, 'medium': 1}
        assert set(body['issues']) == {'problem summary a', 'problem summary c', 'problem summary d'}
        assert body['is_partial'] is False

    def test_unfiltered_overview_counts_the_whole_window(self, feedback_table, api_gateway_event, lambda_context):
        status, body = _call('/metrics/overview', {'days': '7'}, api_gateway_event, lambda_context)
        assert status == 200
        assert body['feedback_count'] == len(CORPUS)
        assert sum(body['enrichment']['usefulness'].values()) == len(CORPUS)

    def test_overview_rejects_invalid_filters(self, feedback_table, api_gateway_event, lambda_context):
        status, _ = _call('/metrics/overview', {'days': '7', 'usefulness': 'nope'},
                          api_gateway_event, lambda_context)
        assert status == 400
