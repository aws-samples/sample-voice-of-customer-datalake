"""GET /feedback/urgent pages with an opaque `next_token` and publishes `total` / `has_more`.

Production finding (5.09.00): Categories → "Urgent only" said "Showing 100 of 100"
while the window held 110 urgent items; the route had no cursor and no total, so
the last 10 could not be reached.
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from urgency_index_fixtures import wire_urgency_index

from metrics_handler import lambda_handler
from shared.feedback_cursor import encode_key_cursor

MAX_PAGES = 20


def _recent(minutes: int) -> str:
    return (datetime.now(UTC) - timedelta(hours=1, minutes=minutes)).isoformat()


def _rows(count: int, **fields) -> list[dict]:
    """`count` urgent items, newest first, each carrying its index key."""
    rows = []
    for i in range(count):
        stamp = _recent(i)
        rows.append({'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{i}', 'gsi3pk': 'URGENCY#high', 'gsi3sk': stamp,
                     'feedback_id': str(i), 'date': stamp[:10], 'sentiment_label': 'negative', **fields})
    return rows


@pytest.fixture(autouse=True)
def _no_aggregates_reads():
    with patch('metrics_handler.aggregates_table', new=MagicMock()):
        yield


@pytest.fixture
def fb():
    with patch('metrics_handler.feedback_table') as table:
        yield table


def _urgent(api_gateway_event, lambda_context, **query: str) -> tuple[int, dict]:
    response, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                                path='/feedback/urgent', query_params={'days': '7', **query})
    return response['statusCode'], body


def _walk(api_gateway_event, lambda_context, **query: str) -> list[dict]:
    """Every page, following next_token until has_more is false (bounded, so a regression cannot spin)."""
    pages = []
    token = None
    for _ in range(MAX_PAGES):
        params = {**query, **({'next_token': token} if token else {})}
        _, body = _urgent(api_gateway_event, lambda_context, **params)
        pages.append(body)
        token = body['next_token']
        if not body['has_more']:
            return pages
    raise AssertionError(f'still has_more after {MAX_PAGES} pages')


def test_the_first_page_names_the_window_total_and_the_next_page_reaches_the_rest(
        fb, api_gateway_event, lambda_context):
    wire_urgency_index(fb, _rows(110))

    pages = _walk(api_gateway_event, lambda_context, limit='100')

    assert [(p['count'], p['total'], p['has_more']) for p in pages] == [(100, 110, True), (10, None, False)]
    ids = [item['feedback_id'] for page in pages for item in page['items']]
    assert ids == [str(i) for i in range(110)]


def test_a_page_that_fills_part_way_through_an_index_page_resumes_at_the_next_row(
        fb, api_gateway_event, lambda_context):
    # Every other item is positive; the sentiment filter over-fetches 5 x limit rows,
    # so each page fills in the MIDDLE of an index page.
    rows = [{**row, 'sentiment_label': 'negative' if i % 2 == 0 else 'positive'} for i, row in enumerate(_rows(40))]
    wire_urgency_index(fb, rows)

    pages = _walk(api_gateway_event, lambda_context, limit='3', sentiment='negative')

    ids = [item['feedback_id'] for page in pages for item in page['items']]
    assert ids == [str(i) for i in range(0, 40, 2)]
    assert pages[0]['total'] is None


def test_a_window_that_fits_one_page_is_exact_without_a_count_read(fb, api_gateway_event, lambda_context):
    wire_urgency_index(fb, _rows(4))

    _, body = _urgent(api_gateway_event, lambda_context, sentiment='negative')

    assert (body['count'], body['total'], body['has_more'], body['next_token']) == (4, 4, False, None)
    assert all(call.kwargs.get('Select') != 'COUNT' for call in fb.query.call_args_list)


@pytest.mark.parametrize('token', [
    'not-a-cursor',
    encode_key_cursor({'pk': 'p', 'sk': 's'}),
    encode_key_cursor({'pk': 'p', 'sk': 's', 'gsi3pk': 'URGENCY#low', 'gsi3sk': '2999-01-01T00:00:00'}),
    encode_key_cursor({'pk': 'p', 'sk': 's', 'gsi3pk': 'URGENCY#high', 'gsi3sk': '2000-01-01T00:00:00'}),
], ids=['garbage', 'missing-index-key', 'other-partition', 'outside-the-window'])
def test_a_token_this_window_did_not_issue_is_refused(fb, api_gateway_event, lambda_context, token):
    wire_urgency_index(fb, _rows(3))

    status, _ = _urgent(api_gateway_event, lambda_context, next_token=token)

    assert status == 400
    fb.query.assert_not_called()
