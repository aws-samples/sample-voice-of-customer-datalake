"""POST /settings/categories/reprocess: replay slices and resume (E-C2), against a moto aggregates table."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table

BASE = '/settings/categories/reprocess'


@pytest.fixture
def table():
    with mock_aws():
        moto_table = create_pk_sk_table('test-aggregates-settings-reprocess-slices')
        with patch.object(settings_handler, 'aggregates_table', moto_table), \
             patch.object(settings_handler, 'CATEGORY_REPROCESS_FUNCTION', 'voc-job-category-reprocess'), \
             patch.object(settings_handler, 'invoke_lambda_async', MagicMock()):
            yield moto_table


@pytest.fixture
def post(api_gateway_event, lambda_context):
    def _post(body):
        return call_route(lambda_handler, api_gateway_event, lambda_context, method='POST', path=BASE, body=body)
    return _post


def _partial_job(table) -> str:
    """A finished job that stopped at the item ceiling with a cursor."""
    job = jobs.start_job(table, mode='raw', days=0, include_manual=True, started_by='alice', now=datetime.now(UTC),
                         job_slice=settings_handler.reprocess_slices.ReprocessSlice(sources=('web',)))
    assert job is not None
    jobs.claim_job(table, job['sk'], 'tok')
    jobs.finish_job(table, job['sk'], jobs.STATUS_PARTIAL, counters={'scanned': 2}, worker_token='tok',
                    stopped_at_ceiling=True, resume_from={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#b'})
    return job['sk']


@pytest.mark.usefixtures('table')
class TestSlices:
    def test_a_sliced_job_stores_its_slice_and_its_starter(self, post, table):
        response, body = post({'mode': 'processed', 'sources': ['web', 'app'], 'categories': ['billing'],
                               'date_from': '2026-02-01', 'date_to': '2026-02-28', 'date_basis': 'review'})
        assert response['statusCode'] == 202
        job = body['job']
        assert job['sources'] == ['web', 'app']
        assert job['categories'] == ['billing']
        assert (job['date_from'], job['date_to'], job['date_basis']) == ('2026-02-01', '2026-02-28', 'review')
        stored = jobs.get_job(table, job['job_id']) or {}
        assert stored['started_by_sub']

    def test_the_default_basis_is_processed(self, post):
        _response, body = post({'mode': 'processed', 'days': 7})
        assert body['job']['date_basis'] == 'processed'
        assert 'sources' not in body['job']

    @pytest.mark.parametrize('body', [
        {'mode': 'processed', 'days': 7, 'date_from': '2026-02-01'},
        {'mode': 'processed', 'date_from': '2026-03-01', 'date_to': '2026-02-01'},
        {'mode': 'processed', 'days': 7, 'sources': [f's{i}' for i in range(51)]},
        {'mode': 'processed', 'days': 7, 'categories': 'billing'},
        {'mode': 'processed', 'days': 7, 'date_basis': 'imported'},
        {'mode': 'processed', 'date_to': '2026-13-01'},
    ])
    def test_a_malformed_slice_is_a_400(self, post, body):
        response, payload = post(body)
        assert response['statusCode'] == 400
        assert payload['success'] is False


@pytest.mark.usefixtures('table')
class TestResume:
    def test_a_resume_continues_the_partial_job_with_its_mode_and_slice(self, post, table):
        partial = _partial_job(table)
        response, body = post({'resume': partial})
        assert response['statusCode'] == 202
        job = body['job']
        assert job['resumed_from'] == partial
        assert (job['mode'], job['include_manual'], job['sources']) == ('raw', True, ['web'])
        stored = jobs.get_job(table, job['job_id']) or {}
        assert stored['cursor'] == {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#b'}
        assert jobs.job_view(jobs.get_job(table, partial) or {})['resumed_by'] == job['job_id']

    def test_a_job_is_resumed_once(self, post, table):
        partial = _partial_job(table)
        _response, body = post({'resume': partial})
        jobs.cancel_job(table, body['job']['job_id'])
        response, _ = post({'resume': partial})
        assert response['statusCode'] == 409

    def test_a_completed_job_cannot_be_resumed(self, post, table):
        _response, body = post({'mode': 'processed', 'days': 0})
        jobs.cancel_job(table, body['job']['job_id'])
        response, _ = post({'resume': body['job']['job_id']})
        assert response['statusCode'] == 409

    @pytest.mark.parametrize(('body', 'status'), [
        ({'resume': 'rp_000000000001'}, 404),
        ({'resume': 'nope'}, 400),
        ({'resume': 'rp_000000000001', 'mode': 'raw'}, 400),
    ])
    def test_refusals(self, post, body, status):
        response, _ = post(body)
        assert response['statusCode'] == status
