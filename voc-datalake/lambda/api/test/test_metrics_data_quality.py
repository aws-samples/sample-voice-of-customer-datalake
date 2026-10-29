"""`GET /metrics/data-quality`: the per-source usefulness distribution (docs/data-quality.md)."""
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, aggregates_with, restricted_to
from handler_events_fixtures import call_route

import metrics_handler
from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX
from shared.test.clock import today_utc

ADMIN = {'sub': 'admin-1', 'cognito:groups': 'admins'}


def _items() -> list[dict]:
    today = today_utc()
    base = {'date': today, 'source_created_at': f'{today}T08:00:00Z', 'sentiment_label': 'neutral'}
    return [
        {**base, 'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a', 'feedback_id': 'a', 'source_platform': 'web',
         'category': 'delivery', 'usefulness': 'high'},
        {**base, 'pk': 'SOURCE#web', 'sk': 'FEEDBACK#b', 'feedback_id': 'b', 'source_platform': 'web',
         'category': 'delivery'},  # stored before the band existed
        {**base, 'pk': 'SOURCE#app', 'sk': 'FEEDBACK#c', 'feedback_id': 'c', 'source_platform': 'app',
         'category': 'billing', 'usefulness': 'low'},
    ]


def _counter_rows(metric_type: str) -> list[dict]:
    today = today_utc()
    rows = {
        'source': [
            {'pk': 'METRIC#daily_source#web', 'sk': today, 'count': 6},
            {'pk': 'METRIC#daily_source#app', 'sk': today, 'count': 2},
            {'pk': 'METRIC#daily_source#web', 'sk': '2000-01-01', 'count': 99},  # outside the window
        ],
        'usefulness': [
            {'pk': 'METRIC#daily_usefulness#web#high', 'sk': today, 'count': 3},
            {'pk': 'METRIC#daily_usefulness#web#low', 'sk': today, 'count': 1},
            {'pk': 'METRIC#daily_usefulness#app#medium', 'sk': today, 'count': 2},
        ],
    }
    return rows.get(metric_type, [])


def _aggregates(base: MagicMock) -> MagicMock:
    """``base`` (its settings / access rows) answering the metric_type index with ``_counter_rows``."""
    def query(**kwargs):
        if kwargs.get('IndexName') == AGGREGATES_BY_METRIC_TYPE_INDEX:
            return {'Items': _counter_rows(kwargs['KeyConditionExpression'].get_expression()['values'][1])}
        return {'Items': []}
    base.query.side_effect = query
    return base


def _feedback_table() -> MagicMock:
    """Answers ``_items()`` for today's day partition only (the walk reads one per day)."""
    def query(**kwargs):
        partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        return {'Items': _items() if partition == f'DATE#{today_utc()}' else [], 'ScannedCount': 3}
    table = MagicMock()
    table.query.side_effect = query
    return table


@pytest.fixture(autouse=True)
def _fresh():
    clear_categories_cache()
    metrics_handler.app.clear_context()
    yield
    clear_categories_cache()


def _get(event, context, aggregates, *, claims=ADMIN, feedback=None, **params):
    feedback = feedback or _feedback_table()
    with patch('metrics_handler.feedback_table', feedback), patch('metrics_handler.aggregates_table', aggregates):
        response, body = call_route(lambda_handler, event, context, method='GET', path='/metrics/data-quality',
                                    query_params={'days': '7', **params}, claims=claims)
    return response, body, feedback


def _row(source: str, **bands: int) -> dict:
    """The answer's row for ``source``: the named band counts, every other band 0, and their total."""
    counts = {band: bands.get(band, 0) for band in ('low', 'medium', 'high', 'unrated')}
    return {'source': source, **counts, 'total': sum(counts.values())}


class TestCounters:
    def test_an_unrestricted_caller_reads_the_counters_not_the_items(self, api_gateway_event, lambda_context):
        response, body, feedback = _get(api_gateway_event, lambda_context, _aggregates(aggregates_with()))
        assert response['statusCode'] == 200
        assert body['sources'] == [_row('web', low=1, high=3, unrated=2), _row('app', medium=2)]
        assert body['overall'] == {'low': 1, 'medium': 2, 'high': 3, 'unrated': 2, 'total': 8}
        assert (body['period_days'], body['is_partial']) == (7, False)
        feedback.query.assert_not_called()

    def test_a_truncated_index_read_is_partial(self, api_gateway_event, lambda_context):
        aggregates = _aggregates(aggregates_with())
        inner = aggregates.query.side_effect
        aggregates.query.side_effect = lambda **kwargs: {**inner(**kwargs), 'LastEvaluatedKey': {'pk': 'x'}}
        _, body, _ = _get(api_gateway_event, lambda_context, aggregates)
        assert body['is_partial'] is True


class TestItems:
    def test_a_category_restricted_caller_counts_only_its_visible_items(self, api_gateway_event, lambda_context):
        _, body, feedback = _get(api_gateway_event, lambda_context, _aggregates(restricted_to('delivery')),
                                 claims=RESTRICTED_CLAIMS)
        assert body['sources'] == [_row('web', high=1, unrated=1)]
        feedback.query.assert_called()

    def test_the_item_read_projects_the_band(self, api_gateway_event, lambda_context):
        _, _, feedback = _get(api_gateway_event, lambda_context, _aggregates(restricted_to('delivery')),
                              claims=RESTRICTED_CLAIMS)
        projected = feedback.query.call_args.kwargs['ExpressionAttributeNames'].values()
        assert 'usefulness' in projected

    def test_the_review_basis_counts_the_items(self, api_gateway_event, lambda_context):
        _, body, _ = _get(api_gateway_event, lambda_context, _aggregates(aggregates_with()), date_basis='review')
        assert body['sources'] == [_row('web', high=1, unrated=1), _row('app', low=1)]


def test_an_empty_window_answers_no_sources(api_gateway_event, lambda_context):
    aggregates = aggregates_with()
    aggregates.query.return_value = {'Items': []}
    aggregates.query.side_effect = None
    _, body, _ = _get(api_gateway_event, lambda_context, aggregates)
    assert body['sources'] == []
    assert body['overall']['total'] == 0
