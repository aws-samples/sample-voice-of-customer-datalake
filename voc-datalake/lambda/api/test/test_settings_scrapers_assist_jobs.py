"""Category generation and URL analysis run as assist jobs.

`POST /settings/categories/generate` and `POST /scrapers/analyze-url` answer 202
`{success, job_id, status: 'pending'}` after their synchronous checks, the worker twin
(`ASSIST_WORKER_FUNCTION`) runs the model call, and `GET /settings/jobs/{id}` /
`GET /scrapers/jobs/{id}` return the old body as `result` — to the caller who started
it only. A design-reference refresh is handed to the same twin.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from assist_worker_fixtures import WORKER_FUNCTION, inline_assist_worker, start_and_poll

import scrapers_handler
import settings_handler

CALLER = 'test-user-id'  # the conftest event's default (admin) caller
OTHER = {'sub': 'other-sub', 'email': 'other@example.com', 'cognito:groups': 'admins'}
CATEGORIES = [{'id': 'fit', 'name': 'fit', 'description': 'Fit', 'subcategories': []}]


@pytest.fixture
def aggregates():
    with patch.object(settings_handler, 'aggregates_table', MagicMock()) as table:
        yield table


@pytest.fixture
def public_url():
    with patch.object(scrapers_handler, 'validate_url', return_value=(True, '')):
        yield


def _generate(api_gateway_event, lambda_context, body, **kw):
    return start_and_poll(settings_handler, api_gateway_event, lambda_context,
                          path='/settings/categories/generate', body=body, poll_prefix='/settings/jobs', **kw)


def _analyze(api_gateway_event, lambda_context, body, **kw):
    return start_and_poll(scrapers_handler, api_gateway_event, lambda_context,
                          path='/scrapers/analyze-url', body=body, poll_prefix='/scrapers/jobs', **kw)


@pytest.mark.usefixtures('aggregates')
class TestCategoriesGenerate:
    def test_the_start_is_a_202_with_a_pending_job_owned_by_the_caller(self, api_gateway_event, lambda_context):
        with inline_assist_worker(settings_handler, lambda_context, run_worker=False) as jobs:
            status, started, polled = _generate(api_gateway_event, lambda_context, {'company_description': 'Acme air'})
            [row] = jobs.table.scan()['Items']
        assert (status, started) == (202, {'success': True, 'job_id': started['job_id'], 'status': 'pending'})
        assert (row['pk'], row['job_type'], row['config'], row['initiated_by']) == (
            f'ASSIST#{CALLER}', 'assist_categories', {'company_description': 'Acme air'}, CALLER)
        jobs.invoke.assert_called_once_with(
            WORKER_FUNCTION, {'action': 'assist_job', 'pk': f'ASSIST#{CALLER}', 'job_id': started['job_id']})
        assert (polled['statusCode'], polled['status'], polled['result']) == (200, 'pending', None)

    def test_the_worker_runs_the_model_and_the_poll_returns_the_old_body(self, api_gateway_event, lambda_context):
        answer = '{"categories": [{"id": "fit", "name": "fit", "description": "Fit", "subcategories": []}]}'
        with inline_assist_worker(settings_handler, lambda_context), \
                patch('shared.converse.converse', return_value=answer) as converse:
            _, _, polled = _generate(api_gateway_event, lambda_context, {'company_description': 'Acme air'})
        converse.assert_called_once()
        assert polled == {
            'statusCode': 200, 'success': True, 'job_id': polled['job_id'], 'job_type': 'assist_categories',
            'status': 'completed', 'created_at': polled['created_at'], 'updated_at': polled['updated_at'],
            'completed_at': polled['completed_at'], 'error': None,
            'result': {'success': True, 'categories': CATEGORIES},
        }

    def test_a_model_failure_is_the_failed_job_with_the_generic_message(self, api_gateway_event, lambda_context):
        with inline_assist_worker(settings_handler, lambda_context), \
                patch('shared.converse.converse', side_effect=RuntimeError('boom')):
            _, _, polled = _generate(api_gateway_event, lambda_context, {'company_description': 'Acme air'})
        assert (polled['status'], polled['error'], polled['result']) == (
            'failed', 'Failed to generate categories', None)

    def test_a_missing_description_is_a_synchronous_400_and_no_job(self, api_gateway_event, lambda_context):
        with inline_assist_worker(settings_handler, lambda_context) as jobs:
            status, body, polled = _generate(api_gateway_event, lambda_context, {'company': 'Acme'})
            assert jobs.table.scan()['Items'] == []
        assert (status, body['error'], polled) == (400, 'Company description is required', {})
        jobs.invoke.assert_not_called()

    def test_another_callers_job_is_a_404(self, api_gateway_event, lambda_context):
        with inline_assist_worker(settings_handler, lambda_context, run_worker=False):
            _, _, polled = _generate(api_gateway_event, lambda_context, {'company_description': 'Acme air'},
                                     poll_claims=OTHER)
        assert (polled['statusCode'], polled['error']) == (404, 'Job not found')

    def test_an_unconfigured_worker_is_a_500_and_no_job(self, api_gateway_event, lambda_context, monkeypatch):
        with inline_assist_worker(settings_handler, lambda_context) as jobs:
            monkeypatch.setenv('ASSIST_WORKER_FUNCTION', '')
            status, body, _ = _generate(api_gateway_event, lambda_context, {'company_description': 'Acme air'})
            assert jobs.table.scan()['Items'] == []
        assert (status, body['error']) == (500, 'Assist worker not configured')


@pytest.mark.usefixtures('public_url')
class TestAnalyzeUrl:
    def test_the_start_is_a_202_and_the_poll_returns_the_old_body(self, api_gateway_event, lambda_context):
        with inline_assist_worker(scrapers_handler, lambda_context) as jobs, \
                patch.object(scrapers_handler, '_fetch_html', return_value='<html></html>'), \
                patch('shared.converse.converse', return_value='{"container_selector": ".r"}'):
            status, started, polled = _analyze(api_gateway_event, lambda_context, {'url': 'https://a.example/'})
            [row] = jobs.table.scan()['Items']
        assert (status, started['status']) == (202, 'pending')
        assert (row['pk'], row['job_type'], row['config']) == (
            f'ASSIST#{CALLER}', 'assist_analyze_url', {'url': 'https://a.example/'})
        assert (polled['statusCode'], polled['status'], polled['result']) == (
            200, 'completed', {'success': True, 'selectors': {'container_selector': '.r'}})

    def test_a_refused_url_is_a_synchronous_400_and_no_job(self, api_gateway_event, lambda_context):
        with inline_assist_worker(scrapers_handler, lambda_context) as jobs, \
                patch.object(scrapers_handler, 'validate_url', return_value=(False, 'Blocked')):
            status, body, _ = _analyze(api_gateway_event, lambda_context, {'url': 'http://10.0.0.1/'})
            assert jobs.table.scan()['Items'] == []
        assert (status, body['error']) == (400, 'Blocked')

    def test_another_callers_job_is_a_404(self, api_gateway_event, lambda_context):
        with inline_assist_worker(scrapers_handler, lambda_context, run_worker=False):
            _, _, polled = _analyze(api_gateway_event, lambda_context, {'url': 'https://a.example/'},
                                    poll_claims=OTHER)
        assert (polled['statusCode'], polled['error']) == (404, 'Job not found')

    def test_a_poll_of_an_unknown_id_is_a_404(self, api_gateway_event, lambda_context):
        with inline_assist_worker(scrapers_handler, lambda_context):
            response = scrapers_handler.lambda_handler(
                api_gateway_event(method='GET', path='/scrapers/jobs/not-a-job'), lambda_context)
        assert response['statusCode'] == 404


class TestTheDesignReferenceRefreshRunsOnTheWorker:
    def test_the_refresh_is_invoked_on_the_worker_function(self, monkeypatch):
        monkeypatch.setenv('ASSIST_WORKER_FUNCTION', 'voc-settings-assist')
        monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-settings-api')
        with patch.object(settings_handler, 'invoke_lambda_async') as invoke:
            settings_handler._start_reference_refresh(MagicMock(), 'ref_0123456789ab')
        invoke.assert_called_once_with(
            'voc-settings-assist', {'action': 'design_reference_refresh', 'ref_id': 'ref_0123456789ab'})

    def test_without_a_worker_the_api_function_invokes_itself(self, monkeypatch):
        monkeypatch.delenv('ASSIST_WORKER_FUNCTION', raising=False)
        monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-settings-api')
        with patch.object(settings_handler, 'invoke_lambda_async') as invoke:
            settings_handler._start_reference_refresh(MagicMock(), 'ref_0123456789ab')
        assert invoke.call_args.args[0] == 'voc-settings-api'
