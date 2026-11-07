"""shared/job_notices.py: a project job's end reaches its starter, best effort, and nothing happens unconfigured."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import job_notices
from shared import jobs as jobs_module
from shared.exceptions import ValidationError
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def table():
    with mock_aws():
        created = create_pk_sk_table('test-jobs')
        with patch.object(job_notices, 'get_jobs_table', return_value=created), \
                patch.object(jobs_module, 'get_jobs_table', return_value=created):
            yield created


@pytest.fixture
def published():
    with patch.object(job_notices.realtime, 'configured', return_value=True), \
            patch.object(job_notices.realtime, 'publish', return_value=True) as publish:
        yield publish


def _job(table, *, initiated_by: str | None = 'starter-sub', job_type: str = 'generate_personas') -> None:
    item = {'pk': 'PROJECT#p1', 'sk': 'JOB#job_1', 'job_id': 'job_1', 'job_type': job_type, 'status': 'running'}
    if initiated_by:
        item['initiated_by'] = initiated_by
    table.put_item(Item=item)


class TestNotify:
    def test_the_notice_shape(self, published):
        assert job_notices.notify('s1', 'j1', 'completed', job_type='erasure', project_id='p1') is True
        published.assert_called_once_with('jobs', 's1', {
            'type': 'job', 'job_id': 'j1', 'status': 'completed', 'job_type': 'erasure', 'project_id': 'p1'})

    def test_optional_fields_are_left_out(self, published):
        job_notices.notify('s1', 'j1', 'failed')
        assert published.call_args.args[2] == {'type': 'job', 'job_id': 'j1', 'status': 'failed'}

    @pytest.mark.parametrize(('job_id', 'status'), [('', 'completed'), (None, 'completed'), ('j1', ''), ('j1', 3)])
    def test_no_id_or_status_sends_nothing(self, published, job_id, status):
        assert job_notices.notify('s1', job_id, status) is False
        published.assert_not_called()


class TestNotifyProjectJob:
    def test_tells_the_rows_initiated_by(self, table, published):
        _job(table)
        assert job_notices.notify_project_job('p1', 'job_1', 'completed') is True
        published.assert_called_once_with('jobs', 'starter-sub', {
            'type': 'job', 'job_id': 'job_1', 'status': 'completed', 'job_type': 'generate_personas',
            'project_id': 'p1'})

    def test_no_starter_no_notice(self, table, published):
        _job(table, initiated_by=None)
        assert job_notices.notify_project_job('p1', 'job_1', 'completed') is False
        published.assert_not_called()

    @pytest.mark.usefixtures('table')
    def test_a_missing_row_sends_nothing(self, published):
        assert job_notices.notify_project_job('p1', 'gone', 'failed') is False
        published.assert_not_called()

    def test_an_unreadable_row_never_raises(self, published):
        class Broken:
            def get_item(self, **_kwargs):
                raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'GetItem')
        with patch.object(job_notices, 'get_jobs_table', return_value=Broken()):
            assert job_notices.notify_project_job('p1', 'job_1', 'failed') is False
        published.assert_not_called()

    def test_unconfigured_reads_nothing(self):
        with patch.object(job_notices, 'get_jobs_table') as get_table, \
                patch.object(job_notices.realtime, 'publish') as publish:
            assert job_notices.notify_project_job('p1', 'job_1', 'completed') is False
        get_table.assert_not_called()
        publish.assert_not_called()


class TestJobHandlerNotices:
    """`job_handler` (persona generation / import, document generation / merge) tells the starter how it ended."""

    def test_a_completed_job(self, table, published):
        _job(table)

        @jobs_module.job_handler()
        def work(_ctx, _project_id, _job_id):
            return {'n': 1}

        work({'project_id': 'p1', 'job_id': 'job_1'})
        assert published.call_args.args[2]['status'] == 'completed'
        assert table.get_item(Key={'pk': 'PROJECT#p1', 'sk': 'JOB#job_1'})['Item']['status'] == 'completed'

    def test_a_refused_job(self, table, published):
        _job(table)

        @jobs_module.job_handler()
        def work(_ctx, _project_id, _job_id):
            raise ValidationError('no feedback')

        assert work({'project_id': 'p1', 'job_id': 'job_1'})['success'] is False
        assert published.call_args.args[2]['status'] == 'failed'

    def test_a_crashed_job_still_raises_after_the_notice(self, table, published):
        _job(table)

        @jobs_module.job_handler()
        def work(_ctx, _project_id, _job_id):
            raise RuntimeError('boom')

        with pytest.raises(jobs_module.ServiceError):
            work({'project_id': 'p1', 'job_id': 'job_1'})
        assert published.call_args.args[2]['status'] == 'failed'

    def test_a_lost_notice_changes_nothing(self, table, published):
        _job(table)
        published.return_value = False

        @jobs_module.job_handler()
        def work(_ctx, _project_id, _job_id):
            return {'n': 2}

        assert work({'project_id': 'p1', 'job_id': 'job_1'}) == {'success': True, 'n': 2}
