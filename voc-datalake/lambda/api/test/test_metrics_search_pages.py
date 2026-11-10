"""GET /feedback/search counts every match in the window and pages with `next_token`.

Production finding (5.09.00): a filtered list showed "3 of 200+" / "5 of 100"
because the filter ran only over rows already loaded. Search and the rating
filter now run server-side, so `total` counts what matches, not what was loaded.
"""
from unittest.mock import MagicMock, patch

import pytest
from feedback_page_fixtures import serve_page_by_key, with_keys
from handler_events_fixtures import call_route

from metrics_handler import lambda_handler
from shared.feedback_cursor import encode_offset_cursor
from shared.test.clock import today_utc


@pytest.fixture
def fb():
    """The feedback table double; the aggregates reads (window watermark, category scope) stay offline."""
    with patch('metrics_handler.aggregates_table', new=MagicMock()), patch('metrics_handler.feedback_table') as table:
        yield table


def _item(i: int, text: str, rating: int | None = None) -> dict:
    item = {'feedback_id': str(i), 'date': today_utc(), 'original_text': text}
    return item if rating is None else {**item, 'rating': rating}


def _search(api_gateway_event, lambda_context, **query: str) -> tuple[int, dict]:
    response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                path='/feedback/search', query_params={'days': '1', **query})
    return response['statusCode'], body


def test_total_counts_every_match_and_next_token_reaches_the_rest(fb, api_gateway_event, lambda_context):
    fb.query.return_value = {'Items': [_item(i, 'checkout failed' if i % 3 == 0 else 'fine') for i in range(30)]}

    _, first = _search(api_gateway_event, lambda_context, q='checkout', limit='4')
    _, second = _search(api_gateway_event, lambda_context, q='checkout', limit='4', next_token=first['next_token'])
    _, last = _search(api_gateway_event, lambda_context, q='checkout', limit='4', next_token=second['next_token'])

    assert [(p['count'], p['total'], p['has_more']) for p in (first, second, last)] == [
        (4, 10, True), (4, 10, True), (2, 10, False)]
    assert [i['feedback_id'] for p in (first, second, last) for i in p['items']] == [str(i) for i in range(0, 30, 3)]


def test_the_rating_filter_narrows_the_total_server_side(fb, api_gateway_event, lambda_context):
    fb.query.return_value = {'Items': [_item(1, 'checkout', 5), _item(2, 'checkout', 2), _item(3, 'checkout')]}

    _, body = _search(api_gateway_event, lambda_context, q='checkout', rating_min='4')

    assert (body['total'], [i['feedback_id'] for i in body['items']]) == (1, ['1'])


@pytest.mark.parametrize('token', ['garbage', encode_offset_cursor(-1), encode_offset_cursor(10**9)])
def test_a_malformed_token_is_refused(fb, api_gateway_event, lambda_context, token):
    fb.query.return_value = {'Items': []}

    status, _ = _search(api_gateway_event, lambda_context, q='checkout', next_token=token)

    assert status == 400


def test_a_malformed_rating_bound_is_a_400(fb, api_gateway_event, lambda_context):
    fb.query.return_value = {'Items': []}

    status, _ = _search(api_gateway_event, lambda_context, q='checkout', rating_min='9')

    assert status == 400


def test_the_list_route_applies_the_rating_filter_before_counting(fb, api_gateway_event, lambda_context):
    items = with_keys([_item(1, 'a', 4), _item(2, 'b', 5), _item(3, 'c', 3), _item(4, 'd')])
    fb.query.return_value = {'Items': items}
    serve_page_by_key(fb, items)

    response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                path='/feedback', query_params={'days': '1', 'rating_max': '4'})

    assert response['statusCode'] == 200
    assert (body['total'], [i['feedback_id'] for i in body['items']]) == (2, ['1', '3'])
