"""Tests for the Data Quality routes in settings_handler.py."""
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from shared import data_quality as dq

QUEUE = 'https://sqs.example/dq'


def _conditional_failure() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'PutItem')


@pytest.fixture
def backend():
    """Mocked aggregates table and SQS, with the queue configured."""
    table = MagicMock(name='aggregates_table')
    sqs = MagicMock(name='sqs')
    with patch('settings_handler.aggregates_table', table), \
            patch('settings_handler.DATA_QUALITY_QUEUE_URL', QUEUE), \
            patch('settings_handler.get_sqs_client', return_value=sqs):
        yield table, sqs


def _call(api_gateway_event, lambda_context, method, path, body=None, admin=True):
    from settings_handler import lambda_handler
    event = api_gateway_event(method=method, path=path, body=body)
    event['requestContext']['authorizer']['claims']['sub'] = 'user-sub'
    if not admin:
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
    response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


class TestGetDataQuality:
    def test_returns_registry_fields_snapshot_and_jobs(self, backend, api_gateway_event, lambda_context):
        table, _ = backend
        table.get_item.return_value = {'Item': {
            'pk': dq.STATS_PK, 'sk': dq.STATS_SK, 'generated_at': '2026-10-16T00:00:00+00:00',
            'scanned': 3, 'sources': [{'source': 'a', 'count': 3, 'ratings': {'5': 3}}],
        }}
        table.query.return_value = {'Items': [{
            'pk': dq.JOBS_PK, 'sk': 'j', 'job_id': 'j', 'kind': 'enrich', 'status': 'running',
            'total': 10, 'processed': 4, 'updated': 4, 'skipped': 0, 'failed': 0, 'planned': True,
        }]}
        status, body = _call(api_gateway_event, lambda_context, 'GET', '/settings/data-quality')
        assert status == 200
        assert body['fields'] == [{'name': 'usefulness', 'values': ['high', 'medium', 'low']}]
        assert body['stats']['sources'][0]['ratings'] == {'5': 3}
        assert body['jobs'][0]['processed'] == 4 and body['jobs'][0]['planned'] is True
        assert 'pk' not in body['jobs'][0]

    def test_no_snapshot_yet(self, backend, api_gateway_event, lambda_context):
        table, _ = backend
        table.get_item.return_value = {}
        table.query.return_value = {'Items': []}
        status, body = _call(api_gateway_event, lambda_context, 'GET', '/settings/data-quality')
        assert status == 200 and body['stats'] is None and body['jobs'] == []

    def test_non_admin_is_403(self, backend, api_gateway_event, lambda_context):
        status, _ = _call(api_gateway_event, lambda_context, 'GET', '/settings/data-quality', admin=False)
        assert status == 403


class TestStartJob:
    def test_starts_an_enrich_job_and_enqueues_its_plan(self, backend, api_gateway_event, lambda_context):
        table, sqs = backend
        body = {'kind': 'enrich', 'source': 'webscraper', 'field': 'usefulness', 'mode': 'missing'}
        status, response = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', body)
        assert status == 200
        job = response['job']
        assert job['status'] == 'running' and job['source'] == 'webscraper'
        lock = table.put_item.call_args_list[0].kwargs['Item']
        assert lock['pk'] == dq.LOCK_PK and lock['sk'] == 'enrich#webscraper#usefulness'
        record = table.put_item.call_args_list[1].kwargs['Item']
        assert record['started_by'] == 'user-sub'
        message = json.loads(sqs.send_message.call_args.kwargs['MessageBody'])
        assert message == {'type': 'enrich_plan', 'job_id': job['job_id'], 'source': 'webscraper',
                           'field': 'usefulness', 'mode': 'missing'}

    def test_starts_a_profile_job(self, backend, api_gateway_event, lambda_context):
        _, sqs = backend
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', {'kind': 'profile'})
        assert status == 200
        assert json.loads(sqs.send_message.call_args.kwargs['MessageBody'])['type'] == 'profile_scan'

    @pytest.mark.parametrize('body', [
        {'kind': 'nope'},
        {'kind': 'enrich', 'source': 'a', 'field': 'category', 'mode': 'all'},
        {'kind': 'enrich', 'source': 'a', 'field': 'usefulness', 'mode': 'some'},
        {'kind': 'enrich', 'source': '', 'field': 'usefulness', 'mode': 'all'},
        {'kind': 'enrich', 'source': 'x' * 300, 'field': 'usefulness', 'mode': 'all'},
    ])
    def test_rejects_invalid_requests(self, body, backend, api_gateway_event, lambda_context):
        table, sqs = backend
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', body)
        assert status == 400
        table.put_item.assert_not_called()
        sqs.send_message.assert_not_called()

    def test_a_running_job_for_the_same_target_is_409(self, backend, api_gateway_event, lambda_context):
        table, sqs = backend
        table.put_item.side_effect = _conditional_failure()
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', {'kind': 'profile'})
        assert status == 409
        sqs.send_message.assert_not_called()

    def test_an_enqueue_failure_marks_the_job_failed_and_frees_the_target(
        self, backend, api_gateway_event, lambda_context,
    ):
        table, sqs = backend
        sqs.send_message.side_effect = ClientError({'Error': {'Code': 'InternalError'}}, 'SendMessage')
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', {'kind': 'profile'})
        assert status == 500
        assert table.update_item.call_args.kwargs['ExpressionAttributeValues'][':status'] == 'failed'
        assert table.delete_item.call_args.kwargs['Key']['pk'] == dq.LOCK_PK

    def test_non_admin_cannot_start(self, backend, api_gateway_event, lambda_context):
        _, sqs = backend
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs',
                          {'kind': 'profile'}, admin=False)
        assert status == 403
        sqs.send_message.assert_not_called()

    def test_unconfigured_queue_is_a_500(self, api_gateway_event, lambda_context):
        with patch('settings_handler.aggregates_table', MagicMock()), \
                patch('settings_handler.DATA_QUALITY_QUEUE_URL', ''):
            status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs', {'kind': 'profile'})
        assert status == 500


class TestCancelJob:
    JOB_ID = 'dq_20261016000000_abcdef12'

    def test_cancels_a_running_job(self, backend, api_gateway_event, lambda_context):
        table, _ = backend
        table.get_item.return_value = {'Item': {'job_id': self.JOB_ID, 'status': 'running', 'kind': 'profile'}}
        status, body = _call(api_gateway_event, lambda_context, 'POST',
                             f'/settings/data-quality/jobs/{self.JOB_ID}/cancel')
        assert status == 200 and body['job']['status'] == 'cancelled'

    def test_a_finished_job_is_409(self, backend, api_gateway_event, lambda_context):
        table, _ = backend
        table.get_item.return_value = {'Item': {'job_id': self.JOB_ID, 'status': 'completed'}}
        table.update_item.side_effect = _conditional_failure()
        status, _ = _call(api_gateway_event, lambda_context, 'POST',
                          f'/settings/data-quality/jobs/{self.JOB_ID}/cancel')
        assert status == 409

    def test_unknown_job_is_404_and_bad_id_is_400(self, backend, api_gateway_event, lambda_context):
        table, _ = backend
        table.get_item.return_value = {}
        status, _ = _call(api_gateway_event, lambda_context, 'POST',
                          f'/settings/data-quality/jobs/{self.JOB_ID}/cancel')
        assert status == 404
        status, _ = _call(api_gateway_event, lambda_context, 'POST', '/settings/data-quality/jobs/bad/cancel')
        assert status == 400
