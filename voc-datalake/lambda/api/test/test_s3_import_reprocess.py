"""`POST /s3-import/reprocess` and `GET /s3-import/reprocess/<run_id>` (issue #144).

A reprocess re-runs one imported file through the `s3_import` ingestor with the S3
trigger's own event shape, recorded as a `SOURCE_RUN#s3_import` row.
"""
from __future__ import annotations

import json
import urllib.parse
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route

import s3_import_handler as h
from shared import s3_import_runs

BUCKET = 'test-bucket'
INGESTOR = 'voc-ingestor-s3_import-test'
RUN_ID = 'run_s3_import_20260310120000_0a1b2c3d'


def _missing() -> ClientError:
    return ClientError({'Error': {'Code': '404', 'Message': 'Not Found'}}, 'HeadObject')


@pytest.fixture
def s3() -> Iterator[MagicMock]:
    """Every key holds a 1 KB object unless a test says otherwise."""
    with patch.object(h, 's3_client') as client, patch.object(h, 'S3_IMPORT_BUCKET', BUCKET):
        client.head_object.return_value = {'ContentLength': 1024}
        yield client


@pytest.fixture
def table() -> Iterator[MagicMock]:
    aggregates = MagicMock()
    aggregates.query.return_value = {'Items': []}
    with patch.object(h, 'get_aggregates_table', return_value=aggregates), \
            patch.object(h, 'S3_IMPORT_INGESTOR_FUNCTION', INGESTOR):
        yield aggregates


@pytest.fixture
def invoke() -> Iterator[MagicMock]:
    with patch.object(s3_import_runs, 'invoke_lambda_async') as fn, \
            patch.object(s3_import_runs, 'timestamped_id', return_value=RUN_ID):
        yield fn


def _reprocess(api_gateway_event, lambda_context, body, claims=None) -> tuple[int, dict]:
    response, decoded = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                   method='POST', path='/s3-import/reprocess', body=body, claims=claims)
    return response['statusCode'], decoded


def _get_run(api_gateway_event, lambda_context, run_id: str) -> tuple[int, dict]:
    response, decoded = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                   method='GET', path=f'/s3-import/reprocess/{run_id}')
    return response['statusCode'], decoded


@pytest.mark.usefixtures('s3', 'table', 'invoke')
class TestStartingAReprocess:
    def test_a_staged_file_starts_a_run_and_answers_202_with_it(self, api_gateway_event, lambda_context, s3):
        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/june.csv'})

        assert status == 202
        assert body['success'] is True
        assert body['run'] == {
            'run_id': RUN_ID, 'key': 'reviews/june.csv', 'status': 'running', 'items_found': 0,
            'started_at': body['run']['started_at'], 'completed_at': None, 'errors': [],
        }
        s3.head_object.assert_called_once_with(Bucket=BUCKET, Key='reviews/june.csv')

    def test_the_run_row_is_the_source_run_record_written_before_the_invoke(
            self, api_gateway_event, lambda_context, table, invoke):
        order = MagicMock()
        table.put_item.side_effect = lambda **_: order('put')
        invoke.side_effect = lambda *_: order('invoke')

        _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/june.csv'})

        assert [c.args[0] for c in order.call_args_list] == ['put', 'invoke']
        item = table.put_item.call_args.kwargs['Item']
        assert item['pk'] == 'SOURCE_RUN#s3_import'
        assert item['sk'] == RUN_ID
        assert item['status'] == 'running'
        assert item['file_key'] == 'reviews/june.csv'

    def test_the_ingestor_gets_the_s3_trigger_event_shape_for_the_key(self, api_gateway_event, lambda_context, invoke):
        _reprocess(api_gateway_event, lambda_context, {'key': 'support_tickets/q2+.json'})

        function_name, payload = invoke.call_args.args
        assert function_name == INGESTOR
        assert payload['execution_id'] == RUN_ID
        assert payload['reprocess'] is True
        [record] = payload['Records']
        assert record['eventSource'] == 'aws:s3'
        assert record['eventName'] == 'ObjectCreated:Put'
        assert record['s3']['bucket']['name'] == BUCKET
        # Encoded as S3 encodes a notification key; the ingestor decodes it with unquote_plus.
        assert urllib.parse.unquote_plus(record['s3']['object']['key']) == 'support_tickets/q2+.json'
        assert json.dumps(payload)  # an async invoke payload must be JSON

    def test_an_archived_processed_file_can_be_reprocessed(self, api_gateway_event, lambda_context):
        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'processed/reviews/may.csv'})

        assert status == 202
        assert body['run']['key'] == 'processed/reviews/may.csv'

    @pytest.mark.parametrize('key', [
        '../reviews/a.csv', '/reviews/a.csv', 'reviews/../a.csv', 'a.csv', 'reviews/sub/a.csv',
        'reviews/a.txt', 'processed/a.csv', 'processed/processed/a.csv', 'processed/../a.csv',
        'reviews/', 'reviews/a\\b.csv', 'reviews/a\x00.csv',
    ])
    def test_a_key_outside_the_import_layout_is_refused_before_any_call(
            self, api_gateway_event, lambda_context, s3, table, invoke, key):
        status, body = _reprocess(api_gateway_event, lambda_context, {'key': key})

        assert status == 400
        assert h.INVALID_KEY in json.dumps(body)
        s3.head_object.assert_not_called()
        table.put_item.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize('body', [{}, {'key': ''}, {'key': '   '}, {'key': 7}])
    def test_a_missing_key_is_a_400(self, api_gateway_event, lambda_context, invoke, body):
        status, decoded = _reprocess(api_gateway_event, lambda_context, body)

        assert status == 400
        assert 'key is required' in json.dumps(decoded)
        invoke.assert_not_called()

    def test_a_file_that_does_not_exist_is_a_404_and_starts_nothing(
            self, api_gateway_event, lambda_context, s3, table, invoke):
        s3.head_object.side_effect = _missing()

        status, _ = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/gone.csv'})

        assert status == 404
        table.put_item.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize(('size', 'reason'), [(0, 'empty'), (50 * 1024 * 1024 + 1, '50 MB')])
    def test_a_file_the_ingestor_would_skip_is_refused(
            self, api_gateway_event, lambda_context, s3, invoke, size, reason):
        s3.head_object.return_value = {'ContentLength': size}

        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 400
        assert reason in json.dumps(body)
        invoke.assert_not_called()

    def test_a_failed_invoke_closes_the_run_as_an_error_and_answers_500(
            self, api_gateway_event, lambda_context, table, invoke):
        invoke.side_effect = RuntimeError('throttled')

        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 500
        assert 'Failed to start reprocessing' in json.dumps(body)
        update = table.update_item.call_args.kwargs
        assert update['Key'] == {'pk': 'SOURCE_RUN#s3_import', 'sk': RUN_ID}
        assert update['ExpressionAttributeValues'][':s'] == 'error'
        assert update['ExpressionAttributeValues'][':e'] == ['InvokeFailed']

    def test_without_the_ingestor_configured_nothing_is_started(self, api_gateway_event, lambda_context, invoke):
        with patch.object(h, 'S3_IMPORT_INGESTOR_FUNCTION', ''), \
                patch.object(h, 'get_aggregates_table', return_value=MagicMock()):
            status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 500
        assert 'S3 import ingestor not configured' in json.dumps(body)
        invoke.assert_not_called()

    def test_a_non_admin_is_refused_with_403(self, api_gateway_event, lambda_context, invoke):
        claims = {'sub': 'u-1', 'email': 'user@example.com', 'cognito:groups': 'users'}

        status, _ = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'}, claims=claims)

        assert status == 403
        invoke.assert_not_called()


def _run_row(status: str, started_ago: timedelta, key: str = 'reviews/a.csv') -> dict:
    started = (datetime.now(UTC) - started_ago).isoformat()
    return {'pk': 'SOURCE_RUN#s3_import', 'sk': 'run_s3_import_20260310115500_ffffffff',
            'status': status, 'file_key': key, 'started_at': started}


@pytest.mark.usefixtures('s3', 'table', 'invoke')
class TestOneLiveRunPerFile:
    def test_a_running_reprocess_of_the_same_file_is_a_409_and_starts_nothing(
            self, api_gateway_event, lambda_context, table, invoke):
        table.query.return_value = {'Items': [_run_row('running', timedelta(seconds=30))]}

        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 409
        assert 'already being reprocessed' in json.dumps(body)
        table.put_item.assert_not_called()
        invoke.assert_not_called()

    @pytest.mark.parametrize('row', [
        _run_row('running', timedelta(seconds=s3_import_runs.INGESTOR_TIMEOUT_SECONDS + 1)),
        _run_row('completed', timedelta(seconds=30)),
        _run_row('error', timedelta(seconds=30)),
        _run_row('running', timedelta(seconds=30), key='reviews/other.csv'),
        {**_run_row('running', timedelta(seconds=30)), 'started_at': 'not-a-time'},
    ], ids=['stale-running', 'completed', 'error', 'other-file', 'unreadable-start'])
    def test_a_stale_finished_or_unrelated_run_does_not_block(
            self, api_gateway_event, lambda_context, table, invoke, row):
        table.query.return_value = {'Items': [row]}

        status, _ = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 202
        invoke.assert_called_once()

    def test_a_running_row_on_a_later_page_still_blocks(self, api_gateway_event, lambda_context, table, invoke):
        table.query.side_effect = [
            {'Items': [], 'LastEvaluatedKey': {'pk': 'SOURCE_RUN#s3_import', 'sk': 'x'}},
            {'Items': [_run_row('running', timedelta(seconds=5))]},
        ]

        status, _ = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 409
        assert table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {'pk': 'SOURCE_RUN#s3_import', 'sk': 'x'}
        invoke.assert_not_called()

    def test_the_check_reads_only_recent_run_ids_of_the_run_partition(self, table):
        now = datetime(2026, 3, 10, 12, 0, 0, tzinfo=UTC)

        s3_import_runs.refuse_running_duplicate(table, 'reviews/a.csv', now=now)

        condition = table.query.call_args.kwargs['KeyConditionExpression'].get_expression()
        pk, sk = condition['values']
        assert pk.get_expression()['values'][1] == 'SOURCE_RUN#s3_import'
        lower, upper = sk.get_expression()['values'][1:]
        assert lower == 'run_s3_import_20260310114000'
        assert upper == 'run_s3_import_99999999999999~'

    def test_an_unreadable_run_partition_is_a_500_and_starts_nothing(
            self, api_gateway_event, lambda_context, table, invoke):
        table.query.side_effect = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException',
                                                         'Message': 'slow down'}}, 'Query')

        status, body = _reprocess(api_gateway_event, lambda_context, {'key': 'reviews/a.csv'})

        assert status == 500
        assert 'Failed to start reprocessing' in json.dumps(body)
        invoke.assert_not_called()

    def test_the_window_is_the_ingestor_timeout_its_manifest_sets(self):
        manifest = Path(__file__).resolve().parents[3] / 'plugins' / 's3_import' / 'manifest.json'
        timeout = json.loads(manifest.read_text())['infrastructure']['ingestor']['timeout']
        assert timeout == s3_import_runs.INGESTOR_TIMEOUT_SECONDS


class TestPollingARun:
    def test_a_finished_run_answers_its_outcome(self, api_gateway_event, lambda_context, table):
        table.get_item.return_value = {'Item': {
            'pk': 'SOURCE_RUN#s3_import', 'sk': RUN_ID, 'status': 'completed', 'items_found': 42,
            'started_at': 's', 'completed_at': 'c', 'file_key': 'reviews/a.csv',
        }}

        status, body = _get_run(api_gateway_event, lambda_context, RUN_ID)

        assert status == 200
        assert body['run'] == {
            'run_id': RUN_ID, 'key': 'reviews/a.csv', 'status': 'completed', 'items_found': 42,
            'started_at': 's', 'completed_at': 'c', 'errors': [],
        }
        table.get_item.assert_called_once_with(Key={'pk': 'SOURCE_RUN#s3_import', 'sk': RUN_ID})

    def test_an_unknown_run_is_a_404(self, api_gateway_event, lambda_context, table):
        table.get_item.return_value = {}

        status, _ = _get_run(api_gateway_event, lambda_context, RUN_ID)

        assert status == 404

    @pytest.mark.parametrize('run_id', ['run_webscraper_20260310120000_0a1b2c3d', 'x', 'run_s3_import_1_zz'])
    def test_an_id_of_another_shape_is_a_404_without_a_read(self, api_gateway_event, lambda_context, table, run_id):
        status, _ = _get_run(api_gateway_event, lambda_context, run_id)

        assert status == 404
        table.get_item.assert_not_called()
