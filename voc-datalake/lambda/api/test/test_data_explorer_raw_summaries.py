"""GET /data-explorer/s3 says what a raw review file is about (title + date).

Live finding: raw files are named after the source's item id, so the S3 tab was
a list of opaque ``<id>.json`` names. Small raw JSON files now carry a
``summary`` read from the file itself; anything unreadable carries none.
"""
import io
import json
from datetime import UTC, datetime
from unittest.mock import patch

from botocore.exceptions import ClientError

from shared.raw_object_summary import MAX_SUMMARIES, summarize_record

LISTED = datetime(2026, 1, 5, tzinfo=UTC)


def _contents(*names: str, size: int = 400) -> list[dict]:
    return [{'Key': f'raw/web_trustpilot_acme/2026/01/04/{n}', 'Size': size, 'LastModified': LISTED} for n in names]


def _list(api_gateway_event, lambda_context) -> list[dict]:
    from data_explorer_handler import lambda_handler

    response = lambda_handler(api_gateway_event(
        method='GET', path='/data-explorer/s3',
        query_params={'bucket': 'raw-data', 'prefix': 'raw/web_trustpilot_acme/2026/01/04'},
    ), lambda_context)
    assert response['statusCode'] == 200
    return json.loads(response['body'])['objects']


def _body(payload: object) -> dict:
    return {'Body': io.BytesIO(json.dumps(payload).encode())}


@patch('data_explorer_handler.s3_client')
def test_a_raw_review_file_carries_its_title_and_date(mock_s3, api_gateway_event, lambda_context):
    def get_object(**kwargs: str) -> dict:
        if kwargs['Key'].endswith('a1.json'):
            return _body({'raw_item': {'title': 'Battery drains overnight', 'created_at': '2026-01-04T08:00:00Z'}})
        return _body({'text': 'Love   it', 'date': '2026-01-03'})

    mock_s3.list_objects_v2.return_value = {'CommonPrefixes': [], 'Contents': _contents('a1.json', 'b2.json')}
    mock_s3.get_object.side_effect = get_object

    objects = _list(api_gateway_event, lambda_context)

    assert [o.get('summary') for o in objects] == [
        {'title': 'Battery drains overnight', 'date': '2026-01-04T08:00:00Z'},
        {'title': 'Love it', 'date': '2026-01-03'},
    ]


@patch('data_explorer_handler.s3_client')
def test_an_unreadable_or_large_file_has_no_summary_and_the_listing_still_answers(
    mock_s3, api_gateway_event, lambda_context,
):
    mock_s3.list_objects_v2.return_value = {
        'CommonPrefixes': [], 'Contents': _contents('bad.json') + _contents('big.json', size=10_000_000),
    }
    mock_s3.get_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')

    objects = _list(api_gateway_event, lambda_context)

    assert [('summary' in o) for o in objects] == [False, False]
    assert mock_s3.get_object.call_count == 1  # the large file is never read


@patch('data_explorer_handler.s3_client')
def test_at_most_fifty_files_are_read_per_listing(mock_s3, api_gateway_event, lambda_context):
    names = [f'{i:03d}.json' for i in range(MAX_SUMMARIES + 5)]
    mock_s3.list_objects_v2.return_value = {'CommonPrefixes': [], 'Contents': _contents(*names)}
    mock_s3.get_object.side_effect = lambda **_: _body({'title': 'x'})

    _list(api_gateway_event, lambda_context)

    assert mock_s3.get_object.call_count == MAX_SUMMARIES


def test_a_long_text_is_clipped_and_a_record_without_either_has_no_summary():
    clipped = summarize_record({'text': 'word ' * 100})
    assert clipped is not None
    assert len(clipped['title']) == 120
    assert clipped['title'].endswith('…')
    assert summarize_record({'rating': 5}) is None
    assert summarize_record(['not', 'a', 'record']) is None
