"""shared/assist_jobs.py → shared/realtime.py: a finished assist tells its starter, and a lost notice changes nothing."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from shared import assist_jobs as aj
from shared.exceptions import ValidationError
from shared.test.assist_job_fixtures import assist_jobs_table


@pytest.fixture
def table():
    with assist_jobs_table() as created:
        yield created


@pytest.fixture
def published():
    with patch.object(aj, 'invoke_lambda_async'), patch.object(aj.realtime, 'publish', return_value=True) as publish:
        yield publish


def _run(pk: str, work: aj.Work, *, initiated_by: str = 'starter-sub', project_id: str | None = None) -> dict:
    started = aj.start(pk, 'assist_categories', {}, worker_function='worker-fn',
                       initiated_by=initiated_by, project_id=project_id)
    aj.run({'action': aj.ASSIST_ACTION, 'pk': pk, 'job_id': started['job_id']}, {'assist_categories': work})
    return started


@pytest.mark.usefixtures('table')
class TestJobNotices:
    def test_a_completed_owned_assist_tells_the_sub_in_its_pk(self, published):
        started = _run(aj.owner_pk('owner-sub'), aj.Work(lambda _cfg: {'ok': True}, 'x'))
        published.assert_called_once_with('jobs', 'owner-sub', {
            'type': 'job', 'job_id': started['job_id'], 'job_type': 'assist_categories', 'status': 'completed'})

    def test_a_project_assist_tells_its_starter_with_the_project_id(self, published):
        started = _run('PROJECT#p1', aj.Work(lambda _cfg: {}, 'x'), project_id='p1')
        published.assert_called_once_with('jobs', 'starter-sub', {
            'type': 'job', 'job_id': started['job_id'], 'job_type': 'assist_categories', 'status': 'completed',
            'project_id': 'p1'})

    def test_a_failed_assist_tells_too(self, published):
        def refuse(_cfg: dict) -> dict:
            raise ValidationError('no')
        _run(aj.owner_pk('owner-sub'), aj.Work(refuse, 'x'))
        assert published.call_args.args[2]['status'] == 'failed'

    def test_an_unregistered_kind_tells_its_failure(self, published, table):
        started = aj.start(aj.owner_pk('owner-sub'), 'assist_other', {}, worker_function='w', initiated_by='owner-sub')
        aj.run({'action': aj.ASSIST_ACTION, 'pk': aj.owner_pk('owner-sub'), 'job_id': started['job_id']}, {})
        assert published.call_args.args[2]['status'] == 'failed'
        assert table.get_item(Key={'pk': aj.owner_pk('owner-sub'), 'sk': f"JOB#{started['job_id']}"})['Item']['status'] == 'failed'

    def test_a_lost_notice_leaves_the_recorded_outcome(self, published, table):
        published.return_value = False
        started = _run(aj.owner_pk('owner-sub'), aj.Work(lambda _cfg: {'n': 1}, 'x'))
        row = table.get_item(Key={'pk': aj.owner_pk('owner-sub'), 'sk': f"JOB#{started['job_id']}"})['Item']
        assert (row['status'], row['result']) == ('completed', {'n': 1})

    def test_a_skipped_redelivery_sends_nothing(self, published):
        started = _run(aj.owner_pk('owner-sub'), aj.Work(lambda _cfg: {}, 'x'))
        published.reset_mock()
        aj.run({'action': aj.ASSIST_ACTION, 'pk': aj.owner_pk('owner-sub'), 'job_id': started['job_id']}, {})
        published.assert_not_called()
