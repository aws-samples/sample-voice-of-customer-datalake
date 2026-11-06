"""`GET /feedback` and `/feedback/search` hand the client an item's change stamp.

The Data Explorer editor sends back the ``updated_at`` it opened a record with, and
``PUT /data-explorer/feedback`` refuses a stale one (409). If the list dropped ``updated_at``, every
save of an edited record would 409. ``updated_by`` keeps only its ``kind`` (never a ``sub``).
"""
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import metrics_handler
from metrics_handler import lambda_handler
from shared.api import clear_categories_cache

STAMP = '2026-11-01T00:00:00+00:00'


def _today() -> str:
    return datetime.now(UTC).strftime('%Y-%m-%d')


def _items() -> list[dict]:
    return [{
        'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a', 'feedback_id': 'a', 'date': _today(), 'category': 'other',
        'source_platform': 'web',
        'sentiment_label': 'negative', 'original_text': 'The parcel was late',
        'updated_at': STAMP, 'updated_by': {'sub': 'sub-admin', 'kind': 'admin'}, 'change_reason': 'category_edit',
    }]


@pytest.fixture
def tables():
    clear_categories_cache()
    metrics_handler.app.clear_context()

    def feedback_query(**kwargs):
        partition = kwargs['KeyConditionExpression'].get_expression()['values'][1]
        return {'Items': _items() if partition == f'DATE#{_today()}' else [], 'ScannedCount': 0}

    with patch('metrics_handler.feedback_table') as fb, patch('metrics_handler.aggregates_table') as agg:
        fb.query.side_effect = feedback_query
        # The list reads slim rows, then the page's full items by key (BatchGetItem on the resource's client).
        fb.name = 'feedback'
        fb.meta.client.batch_get_item.side_effect = lambda RequestItems: {'Responses': {'feedback': [
            i for i in _items() if {'pk': i['pk'], 'sk': i['sk']} in RequestItems['feedback']['Keys']]}}
        agg.get_item.return_value = {}
        agg.query.return_value = {'Items': []}
        yield fb, agg
    clear_categories_cache()


@pytest.mark.usefixtures('tables')
@pytest.mark.parametrize(('path', 'params'), [('/feedback', {}), ('/feedback/search', {'q': 'parcel'})])
def test_the_listed_item_carries_its_change_stamp_without_the_sub(api_gateway_event, lambda_context, path, params):
    _, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                         query_params={'days': '1', **params})
    (item,) = body['items']
    assert item['updated_at'] == STAMP
    assert item['updated_by'] == {'kind': 'admin'}
