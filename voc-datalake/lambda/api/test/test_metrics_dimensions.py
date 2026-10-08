"""The channel / dims / tag filters and `GET /metrics/dimensions` (metrics_handler)."""
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import metrics_handler
from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')
DIMENSIONS = [
    {'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'user_type', 'label': 'User type', 'values': [{'name': 'customer'}]},
]


def _item(feedback_id: str, **extra) -> dict:
    return {'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id, 'date': TODAY,
            'sentiment_label': 'negative', 'category': 'other', **extra}


ITEMS = [
    _item('a', source_channel='email', dimensions={'product': 'App'}, tags=['VIP']),
    _item('b', source_channel='chat', dimensions={'product': 'Web', 'user_type': 'customer'},
          tags=['vip', 'beta'], sentiment_label='positive'),
    _item('c', source_channel='email'),
]


@pytest.fixture
def tables():
    """The feedback table answers ITEMS for today's date partition; the dimensions row is configured."""
    clear_categories_cache()
    metrics_handler.app.clear_context()

    def feedback_query(**kwargs):
        partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        return {'Items': ITEMS if partition == f'DATE#{TODAY}' else [], 'ScannedCount': 0}

    def settings_row(**kwargs):
        if kwargs['Key']['pk'] == 'SETTINGS#dimensions':
            return {'Item': {'dimensions': DIMENSIONS}}
        return {}

    with patch('metrics_handler.feedback_table') as fb, patch('metrics_handler.aggregates_table') as agg:
        fb.query.side_effect = feedback_query
        agg.get_item.side_effect = settings_row
        agg.query.return_value = {'Items': []}
        yield fb, agg
    clear_categories_cache()


def _get(event_factory, context, path, **params):
    return call_route(lambda_handler, event_factory, context, method='GET', path=path,
                      query_params={k: str(v) for k, v in params.items()})


def _ids(body: dict) -> list[str]:
    return sorted(item['feedback_id'] for item in body['items'])


@pytest.mark.usefixtures('tables')
class TestFilters:
    @pytest.mark.parametrize(('params', 'ids'), [
        ({'channel': 'email'}, ['a', 'c']),
        ({'dims': 'product:app'}, ['a']),
        ({'dims': 'product:Web,user_type:customer'}, ['b']),
        ({'tag': 'VIP'}, ['a', 'b']),
        ({'tag': 'beta', 'channel': 'email'}, []),
    ])
    def test_feedback_list(self, api_gateway_event, lambda_context, params, ids):
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=1, **params)
        assert _ids(body) == ids
        assert body['total'] == len(ids)

    @pytest.mark.parametrize('path', ['/feedback', '/feedback/urgent', '/feedback/entities',
                                      '/metrics/sentiment', '/metrics/categories', '/feedback/search'])
    def test_a_malformed_dims_is_400(self, api_gateway_event, lambda_context, path):
        response, body = _get(api_gateway_event, lambda_context, path, dims='product', q='charged')
        assert response['statusCode'] == 400
        assert body['success'] is False

    def test_search(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='feedback', days=1, tag='beta')
        assert body['count'] == 0

    def test_sentiment_is_counted_from_the_items(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sentiment', days=1, tag='vip')
        assert body['breakdown'] == {'positive': 1, 'neutral': 0, 'negative': 1, 'mixed': 0}

    def test_categories_are_counted_from_the_items(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1, channel='chat')
        assert body['categories'] == {'other': 1}

    def test_summary_is_counted_from_the_items(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/summary', days=1, channel='email')
        assert body['total_feedback'] == 2
        assert body['daily_totals'] == [{'date': TODAY, 'count': 2}]

    def test_sources_are_counted_from_the_items(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sources', days=1, dims='product:Web')
        assert body['sources'] == {'unknown': 1}

    def test_personas_are_counted_from_the_items(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/personas', days=1, tag='vip')
        assert sum(body['personas'].values()) == 2

    @pytest.mark.parametrize('path', ['/metrics/summary', '/metrics/sources', '/metrics/personas'])
    def test_a_source_filter_forces_the_item_path(self, tables, api_gateway_event, lambda_context, path):
        fb, _ = tables
        response, _ = _get(api_gateway_event, lambda_context, path, days=1, source='web')
        assert response['statusCode'] == 200
        assert fb.query.called

    @pytest.mark.parametrize('path', ['/metrics/summary', '/metrics/sources', '/metrics/personas'])
    def test_every_metric_view_rejects_a_malformed_dims(self, api_gateway_event, lambda_context, path):
        response, _ = _get(api_gateway_event, lambda_context, path, dims='product')
        assert response['statusCode'] == 400


@pytest.mark.usefixtures('tables')
class TestEntities:
    def test_the_scan_path_counts_channels_tags_and_dimensions(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=1, channel='email')
        entities = body['entities']
        assert entities['channels'] == {'email': 2}
        assert entities['tags'] == {'vip': 1}
        assert entities['dimensions'] == {'product': {'App': 1}, 'user_type': {}}

    def test_the_aggregates_path_reads_the_aggregator_rows(self, tables, api_gateway_event, lambda_context):
        _, agg = tables
        rows = {
            'channel': [{'pk': 'METRIC#daily_channel#email', 'sk': TODAY, 'count': 3}],
            'tag': [{'pk': 'METRIC#daily_tag#vip', 'sk': TODAY, 'count': 2}],
            'dim_sentiment#product': [
                {'pk': 'METRIC#daily_dim_sentiment#product#App#negative', 'sk': TODAY, 'count': 2},
                {'pk': 'METRIC#daily_dim_sentiment#product#App#positive', 'sk': TODAY, 'count': 1},
            ],
        }
        agg.query.side_effect = _metric_type_rows(rows)
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=1)
        assert body['entities']['channels'] == {'email': 3}
        assert body['entities']['tags'] == {'vip': 2}
        assert body['entities']['dimensions'] == {'product': {'App': 3}, 'user_type': {}}


def _metric_type_rows(rows: dict[str, list[dict]], total: int = 0):
    """`agg.query` answering the metric_type index from `rows`, and `METRIC#daily_total` with `total`."""
    def query(**kwargs):
        values = kwargs['KeyConditionExpression'].get_expression()['values']
        if kwargs.get('IndexName') == AGGREGATES_BY_METRIC_TYPE_INDEX:
            return {'Items': rows.get(values[1], [])}
        pk = values[0].get_expression()['values'][1]
        return {'Items': [{'pk': pk, 'sk': TODAY, 'count': total}] if pk == 'METRIC#daily_total' else []}
    return query


@pytest.mark.usefixtures('tables')
class TestDimensionMetrics:
    def test_the_item_path(self, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/metrics/dimensions', key='product', days=1, tag='vip')
        assert body['key'] == 'product'
        assert body['values'] == {
            'App': {'count': 1, 'positive': 0, 'neutral': 0, 'negative': 1, 'mixed': 0},
            'Web': {'count': 1, 'positive': 1, 'neutral': 0, 'negative': 0, 'mixed': 0},
        }
        assert body['unassigned'] == 0

    def test_the_aggregates_path(self, tables, api_gateway_event, lambda_context):
        _, agg = tables
        agg.query.side_effect = _metric_type_rows({'dim_sentiment#product': [
            {'pk': 'METRIC#daily_dim_sentiment#product#App#negative', 'sk': TODAY, 'count': 2},
            {'pk': 'METRIC#daily_dim_sentiment#product#Gone#weird', 'sk': TODAY, 'count': 1},
        ]}, total=5)
        _, body = _get(api_gateway_event, lambda_context, '/metrics/dimensions', key='product', days=1)
        assert body['values'] == {
            'App': {'count': 2, 'positive': 0, 'neutral': 0, 'negative': 2, 'mixed': 0},
            'Web': {'count': 0, 'positive': 0, 'neutral': 0, 'negative': 0, 'mixed': 0},
            'Gone': {'count': 1, 'positive': 0, 'neutral': 1, 'negative': 0, 'mixed': 0},
        }
        assert body['unassigned'] == 2
        assert body['is_partial'] is False

    @pytest.mark.parametrize('params', [{}, {'key': 'colour'}])
    def test_an_unknown_key_is_400(self, api_gateway_event, lambda_context, params):
        response, _ = _get(api_gateway_event, lambda_context, '/metrics/dimensions', **params)
        assert response['statusCode'] == 400


def test_an_unreadable_dimensions_row_reads_as_none():
    metrics_handler.app.clear_context()
    with patch('metrics_handler.aggregates_table') as agg:
        agg.get_item.return_value = {'Item': {'dimensions': 'corrupt'}}
        assert metrics_handler._dimensions_config() == []
    metrics_handler.app.clear_context()
