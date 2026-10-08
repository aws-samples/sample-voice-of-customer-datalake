"""Regression tests for issue #263 on logs_handler.py.

- Query params go through the shared validate_days/validate_limit: a raw `int()`
  on `?days=abc` raised outside any `try` and answered 500.
- DELETE /logs/validation/<source> follows `LastEvaluatedKey`, so a backlog over
  one 1 MB page is fully cleared and the `deleted` count is true.
"""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route, clear_validation_logs
from logs_fixtures import LIST_ROUTES

from logs_handler import lambda_handler


def _call(path: str, path_params: dict, query: dict, api_gateway_event, lambda_context):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method='GET', path=path, path_params=path_params, query_params=query)


class TestQueryParamsNeverCrash:

    @pytest.mark.parametrize(('path', 'path_params'), LIST_ROUTES)
    @pytest.mark.parametrize('query', [
        {'days': 'abc'}, {'limit': 'abc'}, {'days': '1e3', 'limit': '[]'},
    ])
    @patch('logs_handler.aggregates_table')
    def test_unreadable_values_fall_back_to_defaults(
        self, mock_table, path, path_params, query, api_gateway_event, lambda_context
    ):
        mock_table.query.return_value = {'Items': []}
        response, _ = _call(path, path_params, query, api_gateway_event, lambda_context)
        assert response['statusCode'] == 200

    @patch('logs_handler.aggregates_table')
    def test_unreadable_days_uses_the_seven_day_default(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': []}
        _, body = _call('/logs/validation', {}, {'days': 'abc'}, api_gateway_event, lambda_context)
        assert body['days'] == 7

    @pytest.mark.parametrize(('raw', 'expected'), [('0', 1), ('-5', 1), ('3', 3)])
    @patch('logs_handler.aggregates_table')
    def test_days_is_clamped_to_at_least_one(self, mock_table, raw, expected, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': []}
        _, body = _call('/logs/summary', {}, {'days': raw}, api_gateway_event, lambda_context)
        assert body['days'] == expected

    @pytest.mark.parametrize(('raw', 'expected'), [('0', 1), ('-3', 1), ('100000', 200), ('25', 25)])
    @patch('logs_handler.aggregates_table')
    def test_scraper_limit_is_clamped_into_range(
        self, mock_table, raw, expected, api_gateway_event, lambda_context
    ):
        """DynamoDB rejects Limit < 1, so a raw `?limit=0` used to reach it and 500."""
        mock_table.query.return_value = {'Items': []}
        response, _ = _call('/logs/scraper/s-1', {'scraper_id': 's-1'}, {'limit': raw},
                            api_gateway_event, lambda_context)
        assert response['statusCode'] == 200
        assert mock_table.query.call_args.kwargs['Limit'] == expected

    @patch('logs_handler.aggregates_table')
    def test_source_listing_limit_is_capped_at_500(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.return_value = {'Items': []}
        _call('/logs/validation', {}, {'source': 'webscraper', 'limit': '1000'}, api_gateway_event, lambda_context)
        assert mock_table.query.call_args.kwargs['Limit'] == 500


class TestClearValidationLogsPaging:

    @patch('logs_handler.aggregates_table')
    def test_follows_last_evaluated_key_across_pages(self, mock_table, api_gateway_event, lambda_context):
        pk = 'LOGS#validation#webscraper'
        page_one = {'Items': [{'pk': pk, 'sk': 'a'}, {'pk': pk, 'sk': 'b'}],
                    'LastEvaluatedKey': {'pk': pk, 'sk': 'b'}}
        page_two = {'Items': [{'pk': pk, 'sk': 'c'}]}
        mock_table.query.side_effect = [page_one, page_two]

        response, body, batch = clear_validation_logs(lambda_handler, mock_table, api_gateway_event, lambda_context)

        assert response['statusCode'] == 200
        assert body['deleted'] == 3
        assert [c.kwargs['Key']['sk'] for c in batch.delete_item.call_args_list] == ['a', 'b', 'c']
        first, second = mock_table.query.call_args_list
        assert 'ExclusiveStartKey' not in first.kwargs
        assert second.kwargs['ExclusiveStartKey'] == {'pk': pk, 'sk': 'b'}
