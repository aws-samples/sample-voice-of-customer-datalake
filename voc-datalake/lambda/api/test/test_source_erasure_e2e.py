"""Delete all data from a source, end to end: the settings route starts the job and the real
voc-retention worker runs the invoke it was handed, against ONE set of moto tables and a
versioned raw bucket. Covers the lock across both Lambdas (taken at start, held while the job
is live even when the live-job check is raced, released on completion so the next start works).
"""
from unittest.mock import MagicMock, patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from jobs.retention import handler as worker
from settings_handler import lambda_handler
from shared.source_erasure import source_lock_key
from shared.test.moto_s3 import create_versioned_bucket, version_keys
from shared.test.moto_tables import create_aggregates_table_with_metric_index, create_pk_sk_table

SOURCE = 'web_reviews_example_air'
OTHER = 'support_tickets'
BUCKET = 'test-raw-data-bucket-e2e'
UPLOAD_KEY = 'raw/csv_upload/2026/01/01/import.csv'


@pytest.fixture
def aws():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = create_versioned_bucket(BUCKET)
        aggregates = create_aggregates_table_with_metric_index(worker.AGGREGATES_TABLE, resource)
        feedback = create_pk_sk_table(worker.FEEDBACK_TABLE, resource)
        invoke = MagicMock()
        with patch.object(settings_handler, 'aggregates_table', aggregates), \
                patch.object(settings_handler, 'RETENTION_FUNCTION', 'voc-retention'), \
                patch.object(settings_handler, 'invoke_lambda_async', invoke), \
                patch.object(worker, 'get_dynamodb_resource', return_value=resource), \
                patch.object(worker, 'get_s3_client', return_value=s3), \
                patch.object(worker, 'RAW_DATA_BUCKET', BUCKET):
            yield {'aggregates': aggregates, 'feedback': feedback, 's3': s3, 'invoke': invoke}


@pytest.fixture
def route(api_gateway_event, lambda_context):
    return lambda method, path, **event: call_route(
        lambda_handler, api_gateway_event, lambda_context, method=method, path=path, **event)


@pytest.fixture
def worker_context():
    context = MagicMock()
    context.function_name = 'voc-retention'
    context.get_remaining_time_in_millis.return_value = 900_000
    return context


def _seed(aws, feedback_id: str, source: str) -> str:
    key = f'raw/{source}/2026/01/01/{feedback_id}.json'
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'{}')
    aws['feedback'].put_item(Item={
        'pk': 'SOURCE#Example Air', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'source_platform': source, 'date': '2026-01-01', 's3_raw_uri': f's3://{BUCKET}/{key}'})
    aws['aggregates'].put_item(Item={'pk': f'METRIC#daily_source#{source}', 'sk': '2026-01-01',
                                     'metric_type': 'source', 'count': 1})
    return key


def _keys(aws) -> set[str]:
    return version_keys(aws['s3'], BUCKET)


def _start(route) -> tuple[int, dict]:
    response, body = route('POST', '/settings/erasure',
                           body={'field': 'source', 'value': SOURCE, 'confirm': SOURCE})
    return response['statusCode'], body


def test_a_source_is_erased_end_to_end_and_its_lock_spans_both_lambdas(aws, route, worker_context):
    _seed(aws, 'a', SOURCE)
    _seed(aws, 'b', SOURCE)
    kept = _seed(aws, 'c', OTHER)
    aws['s3'].put_object(Bucket=BUCKET, Key=f'raw/{SOURCE}/2025/12/31/orphan.json', Body=b'{}')
    aws['s3'].put_object(Bucket=BUCKET, Key=UPLOAD_KEY, Body=b'x')

    _, listed = route('GET', '/settings/erasure')
    assert listed['sources'] == sorted([SOURCE, OTHER])

    status, body = _start(route)
    assert status == 202
    job_id = body['job']['job_id']
    payload = aws['invoke'].call_args.args[1]
    assert payload == {'mode': 'erase', 'job_id': job_id, 'value': SOURCE}

    # A second start is refused while the job is queued, by the live-job check...
    assert _start(route)[0] == 409
    # ...and by the lock when that check is raced (both requests passed it).
    with patch.object(settings_handler, 'blocking_job', return_value=None):
        assert _start(route)[0] == 409
    assert aws['invoke'].call_count == 1

    result = worker.handle_event(payload, worker_context)
    assert (result['status'], result['deleted_items'], result['deleted_objects']) == ('completed', 2, 3)
    assert {item['feedback_id'] for item in aws['feedback'].scan()['Items']} == {'c'}
    assert _keys(aws) == {kept, UPLOAD_KEY}

    lock = aws['aggregates'].get_item(Key=source_lock_key(SOURCE))['Item']
    assert lock['job_id'] == job_id
    assert lock['released_at']
    _, listed = route('GET', '/settings/erasure')
    assert [(job['job_id'], job['status'], job['phase']) for job in listed['jobs']] == [(job_id, 'completed', 'raw')]

    # Released: the next erasure of the source may start.
    status, again = _start(route)
    assert status == 202
    assert again['job']['job_id'] != job_id
