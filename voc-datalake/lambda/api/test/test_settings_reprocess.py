"""Tests for the category reprocess routes in settings_handler.py
(/settings/categories/reprocess*), against a moto aggregates table."""
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table

BASE = '/settings/categories/reprocess'
USER_CLAIMS = {'sub': 'user-1', 'cognito:username': 'casey', 'cognito:groups': 'users'}


@pytest.fixture
def table():
    with mock_aws():
        moto_table = create_pk_sk_table('test-aggregates-settings-reprocess')
        with patch.object(settings_handler, 'aggregates_table', moto_table), \
             patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'voc-job-category-reprocess'):
            yield moto_table


@pytest.fixture
def invoke():
    mock = MagicMock()
    with patch.object(settings_handler, 'invoke_lambda_async', mock):
        yield mock


@pytest.fixture
def route(api_gateway_event, lambda_context):
    def _call(method, path, body=None, claims=None, path_params=None, resource=None):
        return call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method=method, path=path, body=body, claims=claims,
            path_params=path_params, resource=resource,
        )
    return _call


def _start(route, **body):
    return route('POST', BASE, body={'mode': 'processed', 'days': 30, **body})


@pytest.mark.usefixtures('table')
class TestStart:
    def test_starts_job_and_invokes_worker(self, route, invoke):
        response, body = _start(route, include_manual=True)
        assert response['statusCode'] == 202
        job = body['job']
        assert jobs.is_job_id(job['job_id'])
        assert job['status'] == 'queued'
        assert job['mode'] == 'processed'
        assert job['days'] == 30
        assert job['include_manual'] is True
        assert job['scanned'] == 0
        invoke.assert_called_once_with('voc-job-category-reprocess', {'job_id': job['job_id']})

    @pytest.mark.usefixtures('invoke')
    def test_second_start_conflicts(self, route):
        _start(route)
        response, _ = _start(route, mode='raw', days=0)
        assert response['statusCode'] == 409

    @pytest.mark.usefixtures('invoke')
    def test_non_admin_forbidden(self, route):
        response, _ = route('POST', BASE, body={'mode': 'raw', 'days': 0}, claims=USER_CLAIMS)
        assert response['statusCode'] == 403

    def test_all_time_and_max_window_accepted(self, route, invoke):
        response, body = _start(route, days=9999)
        assert response['statusCode'] == 202
        assert body['job']['days'] == 9999
        assert invoke.call_count == 1

    def test_worker_invoke_failure_fails_job_and_frees_lock(self, route, invoke):
        invoke.side_effect = RuntimeError('lambda down')
        response, _ = _start(route)
        assert response['statusCode'] == 500
        _, latest = route('GET', BASE)
        assert latest['job']['status'] == 'failed'
        invoke.side_effect = None
        assert _start(route)[0]['statusCode'] == 202


@pytest.mark.usefixtures('table', 'invoke')
class TestReadAndCancel:
    def _get(self, route, job_id):
        return route('GET', f'{BASE}/{job_id}', path_params={'job_id': job_id},
                     resource=f'{BASE}/{{job_id}}')

    def _cancel(self, route, job_id):
        return route('POST', f'{BASE}/{job_id}/cancel', path_params={'job_id': job_id},
                     resource=f'{BASE}/{{job_id}}/cancel')

    def test_latest_is_null_before_any_job(self, route):
        response, body = route('GET', BASE)
        assert response['statusCode'] == 200
        assert body == {'job': None}

    def test_latest_and_get_return_the_job(self, route):
        job_id = _start(route)[1]['job']['job_id']
        assert route('GET', BASE)[1]['job']['job_id'] == job_id
        response, body = self._get(route, job_id)
        assert response['statusCode'] == 200
        assert body['job']['job_id'] == job_id
        assert 'cursor' not in body['job']

    def test_unknown_or_malformed_job_is_404(self, route):
        assert self._get(route, 'rp_000000000000')[0]['statusCode'] == 404
        assert self._get(route, 'not-a-job')[0]['statusCode'] == 404
        assert self._cancel(route, 'rp_000000000000')[0]['statusCode'] == 404

    def test_cancel_then_restart(self, route):
        job_id = _start(route)[1]['job']['job_id']
        response, body = self._cancel(route, job_id)
        assert response['statusCode'] == 200
        assert body['job']['status'] == 'cancelled'
        assert body['job']['finished_at']
        # Idempotent, and the lock is free again.
        assert self._cancel(route, job_id)[1]['job']['status'] == 'cancelled'
        assert _start(route)[0]['statusCode'] == 202

    def test_reads_are_admin_only(self, route):
        assert route('GET', BASE, claims=USER_CLAIMS)[0]['statusCode'] == 403
