"""shared/reprocess_jobs.py → shared/job_notices.py: a reprocess job's end tells its starter, best effort."""
from unittest.mock import patch

import pytest
from moto import mock_aws

from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table
from shared.test.reprocess_jobs_fixtures import present
from shared.test.reprocess_jobs_fixtures import start as _start


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('test-aggregates-reprocess')


@pytest.fixture
def published():
    with patch.object(jobs.job_notices.realtime, 'publish', return_value=True) as publish:
        yield publish


@pytest.mark.parametrize('status', [jobs.STATUS_COMPLETED, jobs.STATUS_FAILED, jobs.STATUS_PARTIAL])
def test_a_finished_job_tells_its_starter(table, published, status):
    job = present(_start(table, started_by_sub='sub-1'))
    jobs.finish_job(table, job['sk'], status)
    published.assert_called_once_with('jobs', 'sub-1', {
        'type': 'job', 'job_id': job['sk'], 'status': status, 'job_type': 'category_reprocess'})


def test_a_cancel_tells_too(table, published):
    job = present(_start(table, started_by_sub='sub-1'))
    jobs.cancel_job(table, job['sk'])
    assert published.call_args.args[2]['status'] == jobs.STATUS_CANCELLED


def test_a_refused_finish_sends_nothing(table, published):
    job = present(_start(table, started_by_sub='sub-1'))
    jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED)
    published.reset_mock()
    assert jobs.finish_job(table, job['sk'], jobs.STATUS_FAILED) is None
    published.assert_not_called()


def test_a_lost_notice_leaves_the_outcome(table, published):
    published.return_value = False
    job = present(_start(table, started_by_sub='sub-1'))
    assert present(jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED))['status'] == 'completed'


def test_unconfigured_it_is_a_no_op(table, monkeypatch):
    monkeypatch.delenv('REALTIME_HTTP_DNS', raising=False)
    job = present(_start(table, started_by_sub='sub-1'))
    with patch.object(jobs.job_notices.realtime.requests, 'post') as post:
        assert present(jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED))['status'] == 'completed'
    post.assert_not_called()
