"""voc-retention erase mode → shared/job_notices.py: the erasure job's end tells the admin who started it.

Best effort: a lost notice changes neither the deletes nor the job row, and a retention run (no job) sends none.
"""
from unittest.mock import patch

import pytest

from jobs.retention import handler, runs
from shared.digests import sha256_hex

JOB_ID = 'er_0123456789ab'


@pytest.fixture
def published():
    with patch.object(runs.job_notices.realtime, 'publish', return_value=True) as publish:
        yield publish


def _job(aws, *, starter: str | None = 'admin-sub') -> None:
    aws['aggregates'].put_item(Item={
        'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': 'author',
        'value_hash': sha256_hex('Jane'), **({'started_by_sub': starter} if starter else {})})


def _status(aws) -> str:
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']['status']


def test_a_finished_erasure_tells_its_starter(aws, worker_context, published):
    _job(aws)
    handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)
    published.assert_called_once_with('jobs', 'admin-sub', {
        'type': 'job', 'job_id': JOB_ID, 'status': 'completed', 'job_type': 'erasure'})


def test_a_failed_erasure_tells_its_starter(aws, worker_context, published):
    _job(aws)
    with patch.object(handler, '_walk_phases', side_effect=RuntimeError('boom')):
        handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)
    assert published.call_args.args[2]['status'] == 'failed'
    assert _status(aws) == 'failed'


def test_a_lost_notice_leaves_the_outcome(aws, worker_context, published):
    published.return_value = False
    _job(aws)
    assert handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)['status'] == 'completed'
    assert _status(aws) == 'completed'


def test_an_older_job_without_a_starter_sends_nothing_to_anyone(aws, worker_context, monkeypatch):
    monkeypatch.setenv('REALTIME_HTTP_DNS', 'abc.appsync-api.us-east-1.amazonaws.com')
    _job(aws, starter=None)
    with patch.object(runs.job_notices.realtime.requests, 'post') as post:
        handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)
    post.assert_not_called()
    assert _status(aws) == 'completed'


@pytest.mark.usefixtures('aws')
def test_a_retention_run_sends_none(worker_context, published):
    handler.handle_event({'mode': 'retention'}, worker_context)
    published.assert_not_called()
