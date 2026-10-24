"""Tests for shared/reprocess_jobs.py against moto, so the lock's conditional
writes are really evaluated (a mock cannot refuse a write)."""
from datetime import timedelta

import pytest
from moto import mock_aws

from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table
from shared.test.reprocess_jobs_fixtures import NOW
from shared.test.reprocess_jobs_fixtures import present as _present
from shared.test.reprocess_jobs_fixtures import start as _start


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('test-aggregates-reprocess')


def _started(table, now=NOW, **overrides) -> dict:
    return _present(_start(table, now=now, **overrides))


def _view(table, job_id: str) -> dict:
    return jobs.job_view(_present(jobs.get_job(table, job_id)))


def test_job_id_is_prefixed_sortable_hex():
    first = jobs.new_job_id(NOW)
    later = jobs.new_job_id(NOW + timedelta(milliseconds=1))
    assert jobs.is_job_id(first)
    assert first < later
    assert not jobs.is_job_id('rp_xyz')
    assert not jobs.is_job_id(None)




def test_finishing_releases_the_lock(table):
    job = _started(table)
    jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED, counters={'scanned': 3, 'updated': 2})
    view = _view(table, job['sk'])
    assert view['status'] == 'completed'
    assert view['scanned'] == 3
    assert view['finished_at']
    assert _start(table, now=NOW + timedelta(seconds=5)) is not None



def test_lock_held_by_a_finished_job_is_reclaimed(table):
    job = _started(table)
    # Simulate a crash between the job update and the lock release.
    table.update_item(
        Key={'pk': jobs.JOB_PK, 'sk': job['sk']},
        UpdateExpression='SET #s = :done', ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':done': 'completed'},
    )
    assert _start(table, now=NOW + timedelta(seconds=1)) is not None


def test_latest_is_the_newest_job(table):
    first = _started(table)
    jobs.finish_job(table, first['sk'], jobs.STATUS_COMPLETED)
    second = _started(table, now=NOW + timedelta(minutes=1))
    assert _present(jobs.get_latest_job(table))['sk'] == second['sk']


def test_checkpoint_refused_after_cancel(table):
    job = _started(table)
    assert _present(jobs.claim_job(table, job['sk'], 'tok'))['status'] == 'running'
    checkpointed = _present(jobs.checkpoint(table, job['sk'], {'scanned': 5}, {'pk': 'a', 'sk': 'b'}, 'tok'))
    assert checkpointed['scanned'] == 5
    cancelled = _present(jobs.cancel_job(table, job['sk']))
    assert cancelled['status'] == 'cancelled'
    assert jobs.checkpoint(table, job['sk'], {'scanned': 9}, None, 'tok') is None
    assert jobs.claim_job(table, job['sk'], 'tok2', previous_token='tok') is None


def test_cancel_is_idempotent_and_missing_job_is_none(table):
    job = _started(table)
    jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED)
    assert _present(jobs.cancel_job(table, job['sk']))['status'] == 'completed'
    assert jobs.cancel_job(table, 'rp_000000000000') is None


def test_claim_is_a_compare_and_set_on_the_worker_token(table):
    job = _started(table)
    assert _present(jobs.claim_job(table, job['sk'], 'first'))['worker_token'] == 'first'
    # A duplicate first delivery cannot claim a job someone already holds.
    assert jobs.claim_job(table, job['sk'], 'dup') is None
    # A hand-over must present the current holder's token.
    assert jobs.claim_job(table, job['sk'], 'next', previous_token='stale') is None
    handed_over = _present(jobs.claim_job(table, job['sk'], 'next', previous_token='first'))
    assert handed_over['worker_token'] == 'next'
    # The superseded holder's checkpoint and finish are refused; the lock stays held.
    assert jobs.checkpoint(table, job['sk'], {'scanned': 1}, None, 'first') is None
    assert jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED, worker_token='first') is None
    assert _start(table, now=NOW + timedelta(seconds=5)) is None
    finished = _present(jobs.finish_job(table, job['sk'], jobs.STATUS_COMPLETED, worker_token='next'))
    assert finished['status'] == 'completed'
