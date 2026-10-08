"""GET /feedback/urgent reads its candidates in pages and hydrates them in batches.

Issue #267 item 2: the route did one `get_item` per GSI row (N+1) and read only the
first page of the urgency partition. It now pages the partition with
`_query_partition`, bounded server-side to the window by `gsi3sk`, and reads the
full items with BatchGetItem in 100-key chunks, retrying UnprocessedKeys.
"""
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key
from handler_events_fixtures import call_route
from urgency_index_fixtures import batch_get_key_counts, wire_urgency_index

from metrics_handler import lambda_handler
from shared.feedback import window_cutoff

RECENT = (datetime.now(UTC) - timedelta(days=1)).strftime('%Y-%m-%d')


@pytest.fixture(autouse=True)
def _no_aggregates_reads():
    """The window watermark and category scope read aggregates; keep them offline."""
    with patch('metrics_handler.aggregates_table', new=MagicMock()):
        yield


def _rows(count: int, **fields) -> list[dict]:
    return [
        {'pk': 'SOURCE#webscraper', 'sk': f'FEEDBACK#{i}', 'feedback_id': str(i), 'date': RECENT,
         'sentiment_label': 'negative', **fields}
        for i in range(count)
    ]


def _urgent(api_gateway_event, lambda_context, **query: str) -> dict:
    _, body = call_route(lambda_handler, api_gateway_event, lambda_context,
                         path='/feedback/urgent', query_params=query)
    return body


@patch('metrics_handler.feedback_table')
def test_rows_are_hydrated_in_one_batch_not_one_read_each(mock_fb, api_gateway_event, lambda_context):
    wire_urgency_index(mock_fb, _rows(7))

    body = _urgent(api_gateway_event, lambda_context)

    assert body['count'] == 7
    assert batch_get_key_counts(mock_fb) == [7]
    mock_fb.get_item.assert_not_called()


@patch('metrics_handler.feedback_table')
def test_batches_are_chunked_at_the_100_key_ceiling(mock_fb, api_gateway_event, lambda_context):
    # A post-filter (sentiment) over-fetches 5 x limit = 300 candidates.
    wire_urgency_index(mock_fb, _rows(250))

    body = _urgent(api_gateway_event, lambda_context, limit='60', sentiment='negative')

    assert batch_get_key_counts(mock_fb) == [100, 100, 50]
    assert body['count'] == 60


@patch('metrics_handler.time.sleep', new=MagicMock())
@patch('metrics_handler.feedback_table')
def test_unprocessed_keys_are_retried(mock_fb, api_gateway_event, lambda_context):
    wire_urgency_index(mock_fb, _rows(3), unprocessed_rounds=2)

    body = _urgent(api_gateway_event, lambda_context)

    assert [i['feedback_id'] for i in body['items']] == ['0', '1', '2']
    assert batch_get_key_counts(mock_fb) == [3, 3, 3]


@patch('metrics_handler.time.sleep', new=MagicMock())
@patch('metrics_handler.feedback_table')
def test_keys_still_unprocessed_after_every_attempt_shorten_the_page(
    mock_fb, api_gateway_event, lambda_context,
):
    wire_urgency_index(mock_fb, _rows(3), unprocessed_rounds=99)

    body = _urgent(api_gateway_event, lambda_context)

    assert body == {'count': 0, 'items': []}


@patch('metrics_handler.feedback_table')
def test_rows_beyond_the_first_page_are_read(mock_fb, api_gateway_event, lambda_context):
    rows = _rows(4)
    wire_urgency_index(mock_fb, rows)
    keys = [{'pk': r['pk'], 'sk': r['sk']} for r in rows]
    mock_fb.query.side_effect = [
        {'Items': keys[:2], 'LastEvaluatedKey': keys[1]},
        {'Items': keys[2:]},
    ]

    body = _urgent(api_gateway_event, lambda_context, sentiment='negative')

    assert [i['feedback_id'] for i in body['items']] == ['0', '1', '2', '3']
    assert mock_fb.query.call_args.kwargs['ExclusiveStartKey'] == keys[1]


@patch('metrics_handler.feedback_table')
def test_the_index_read_is_bounded_to_the_window(mock_fb, api_gateway_event, lambda_context):
    wire_urgency_index(mock_fb, [])

    _urgent(api_gateway_event, lambda_context, days='7')

    assert mock_fb.query.call_args.kwargs['KeyConditionExpression'] == (
        Key('gsi3pk').eq('URGENCY#high') & Key('gsi3sk').gte(window_cutoff(7))
    )
