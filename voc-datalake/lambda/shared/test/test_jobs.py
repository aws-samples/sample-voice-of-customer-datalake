"""
Tests for shared/jobs.py - Job utilities.

The exact shape of every DynamoDB request, every message and every boundary is
pinned in `test_jobs_mutation.py`; this file keeps the behaviours that file
does not cover (a pending job, the initiating caller, a lost claim, the
decorator's four-argument path and progress ordering).
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError


@pytest.mark.usefixtures("reset_table_cache")
class TestCreateJob:
    """Tests for create_job function."""

    @patch('shared.jobs.get_jobs_table')
    def test_records_who_initiated_the_job(self, mock_get_jobs_table):
        """The caller's subject is stored verbatim when given."""
        from shared.jobs import create_job

        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table

        create_job('proj_123', 'research', 'research_config', {}, initiated_by='caller-sub')

        assert mock_table.put_item.call_args[1]['Item']['initiated_by'] == 'caller-sub'

    @patch('shared.jobs.get_jobs_table')
    def test_creates_pending_job(self, mock_get_jobs_table):
        """Should create a job with pending status."""
        from shared.jobs import create_job

        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table

        create_job(
            project_id='proj_123',
            job_type='research',
            config_key='research_config',
            config={'question': 'test'},
            status='pending'
        )

        item = mock_table.put_item.call_args[1]['Item']
        assert item['status'] == 'pending'
        assert item['current_step'] == 'queued'
        assert item['gsi1pk'] == 'STATUS#pending'


@pytest.mark.usefixtures("reset_table_cache")
class TestJobContext:
    """Tests for JobContext class."""

    @patch('shared.jobs.update_job_status')
    def test_update_progress_calls_update_job_status(self, mock_update):
        """Should call update_job_status with correct parameters."""
        from shared.jobs import JobContext

        ctx = JobContext('proj_123', 'job_abc')
        ctx.update_progress(50, 'processing')

        mock_update.assert_called_once_with('proj_123', 'job_abc', 'running', 50, 'processing')


@pytest.mark.usefixtures("reset_table_cache")
class TestJobHandler:
    """Tests for job_handler decorator."""

    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger', MagicMock())
    def test_successful_job_updates_status_to_completed(self, mock_update):
        """Should update job status to completed on success."""
        from shared.jobs import JobContext, job_handler

        @job_handler(error_message='Test failed')
        def sample_job(_ctx: JobContext, _project_id: str, _job_id: str, _config: dict) -> dict:
            return {'result_key': 'result_value'}

        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {'test': True}
        }

        result = sample_job(event)

        assert result == {'success': True, 'result_key': 'result_value'}
        mock_update.assert_called_once_with(
            'proj_123', 'job_abc', 'completed', 100, 'complete',
            result={'result_key': 'result_value'}
        )

    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger', MagicMock())
    def test_context_allows_progress_updates(self, mock_update):
        """Should allow progress updates via context."""
        from shared.jobs import JobContext, job_handler

        @job_handler(error_message='Test failed')
        def sample_job(ctx: JobContext, _project_id: str, _job_id: str, _config: dict) -> dict:
            ctx.update_progress(25, 'step_1')
            ctx.update_progress(50, 'step_2')
            ctx.update_progress(75, 'step_3')
            return {'done': True}

        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {}
        }

        sample_job(event)

        # Should have 4 calls: 3 progress updates + 1 completed
        assert mock_update.call_count == 4

        # Check progress update calls
        calls = mock_update.call_args_list
        assert calls[0][0] == ('proj_123', 'job_abc', 'running', 25, 'step_1')
        assert calls[1][0] == ('proj_123', 'job_abc', 'running', 50, 'step_2')
        assert calls[2][0] == ('proj_123', 'job_abc', 'running', 75, 'step_3')

        # Check completed call
        assert calls[3][0][:5] == ('proj_123', 'job_abc', 'completed', 100, 'complete')


class TestJobExecutionClaim:
    @staticmethod
    def _context(remaining_ms=12_345):
        context = MagicMock()
        context.get_remaining_time_in_millis.return_value = remaining_ms
        context.aws_request_id = 'request-1'
        return context

    @patch('shared.jobs.get_jobs_table')
    def test_active_or_completed_job_loses_claim_without_error(
        self, mock_get_jobs_table,
    ):
        from shared.jobs import claim_job_execution

        table = MagicMock()
        table.update_item.side_effect = ClientError(
            {
                'Error': {
                    'Code': 'ConditionalCheckFailedException',
                    'Message': 'already claimed',
                },
            },
            'UpdateItem',
        )
        mock_get_jobs_table.return_value = table

        assert claim_job_execution('p1', 'j1', self._context()) is False

    @patch('shared.jobs.get_jobs_table')
    def test_nonconditional_claim_error_propagates(self, mock_get_jobs_table):
        from shared.jobs import claim_job_execution

        table = MagicMock()
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'denied'}},
            'UpdateItem',
        )
        mock_get_jobs_table.return_value = table

        with pytest.raises(ClientError):
            claim_job_execution('p1', 'j1', self._context())

    @patch('shared.jobs.recover_job_execution_claim', return_value=False)
    @patch('shared.jobs.claim_job_execution', return_value=False)
    @patch('shared.jobs.update_job_status')
    def test_decorator_skips_duplicate_before_body_or_status_writes(
        self, mock_update, mock_claim, mock_recover,
    ):
        from shared.jobs import JobContext, job_handler

        body = MagicMock(return_value={'result': 'unexpected'})

        @job_handler(error_message='failed')
        def sample_job(
            ctx: JobContext, project_id: str, job_id: str, config: dict,
        ) -> dict:
            return body(ctx, project_id, job_id, config)

        context = self._context()
        result = sample_job({
            'project_id': 'p1',
            'job_id': 'j1',
            'config': {},
        }, context)

        assert result == {'success': True, 'skipped': True}
        mock_claim.assert_called_once_with('p1', 'j1', context)
        mock_recover.assert_called_once_with({
            'project_id': 'p1',
            'job_id': 'j1',
            'config': {},
        }, context)
        body.assert_not_called()
        mock_update.assert_not_called()
