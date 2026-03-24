"""
Additional coverage tests for shared.jobs module.
Targets uncovered lines: 128-129, 151-153, 213.
"""

import pytest
from unittest.mock import patch, MagicMock


class TestUpdateJobStatusException:
    """Tests for update_job_status exception handling (lines 128-129)."""

    def setup_method(self):
        from shared.tables import clear_table_cache
        clear_table_cache()

    @patch('shared.jobs.get_jobs_table')
    def test_logs_error_on_update_failure(self, mock_get_jobs_table):
        """Logs error and does not raise when update_item fails."""
        from shared.jobs import update_job_status

        mock_table = MagicMock()
        mock_table.update_item.side_effect = Exception("DynamoDB connection error")
        mock_get_jobs_table.return_value = mock_table

        # Should not raise
        update_job_status('proj_123', 'job_abc', 'running', 50, 'processing')

        mock_table.update_item.assert_called_once()


class TestGetJobException:
    """Tests for get_job exception handling (lines 151-153)."""

    def setup_method(self):
        from shared.tables import clear_table_cache
        clear_table_cache()

    @patch('shared.jobs.get_jobs_table')
    def test_returns_none_on_get_item_failure(self, mock_get_jobs_table):
        """Returns None when get_item raises an exception."""
        from shared.jobs import get_job

        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception("DynamoDB read error")
        mock_get_jobs_table.return_value = mock_table

        result = get_job('proj_123', 'job_abc')

        assert result is None


class TestJobHandlerNoConfig:
    """Tests for job_handler when no config key is found in event (line 213)."""

    def setup_method(self):
        from shared.tables import clear_table_cache
        clear_table_cache()

    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_calls_handler_without_config_when_no_key_found(self, mock_logger, mock_update):
        """Calls handler without config arg when no config key in event."""
        from shared.jobs import job_handler, JobContext

        received_args = []

        @job_handler(error_message='Test failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str) -> dict:
            received_args.append((project_id, job_id))
            return {'done': True}

        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            # No config key at all
        }

        result = test_job(event)

        assert result == {'success': True, 'done': True}
        assert received_args == [('proj_123', 'job_abc')]
