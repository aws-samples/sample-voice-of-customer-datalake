"""
Tests for shared/jobs.py - Job utilities.
"""
import pytest
from unittest.mock import MagicMock, patch


class TestCreateJob:
    """Tests for create_job function."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    @patch('shared.jobs.get_jobs_table')
    def test_creates_job_with_defaults(self, mock_get_jobs_table):
        """Should create a job with default values."""
        from shared.jobs import create_job
        
        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table
        
        job_id, created_at = create_job(
            project_id='proj_123',
            job_type='generate_personas',
            config_key='filters',
            config={'days': 30}
        )
        
        assert job_id.startswith('job_')
        assert len(job_id) == 20  # 'job_' + 16 hex chars
        assert created_at is not None
        
        # Verify put_item was called
        mock_table.put_item.assert_called_once()
        item = mock_table.put_item.call_args[1]['Item']
        
        assert item['pk'] == 'PROJECT#proj_123'
        assert item['sk'] == f'JOB#{job_id}'
        assert item['job_type'] == 'generate_personas'
        assert item['status'] == 'running'
        assert item['progress'] == 0
        assert item['current_step'] == 'starting'
        assert item['filters'] == {'days': 30}
    
    @patch('shared.jobs.get_jobs_table')
    def test_creates_pending_job(self, mock_get_jobs_table):
        """Should create a job with pending status."""
        from shared.jobs import create_job
        
        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table
        
        job_id, _ = create_job(
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
    
    @patch('shared.jobs.get_jobs_table')
    def test_raises_when_table_not_configured(self, mock_get_jobs_table):
        """Should raise ValueError when JOBS_TABLE is not configured."""
        from shared.jobs import create_job
        
        mock_get_jobs_table.return_value = None
        
        with pytest.raises(ValueError, match="JOBS_TABLE environment variable not configured"):
            create_job('proj_123', 'test', 'config', {})


class TestUpdateJobStatus:
    """Tests for update_job_status function."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    @patch('shared.jobs.get_jobs_table')
    def test_updates_basic_status(self, mock_get_jobs_table):
        """Should update job status with basic fields."""
        from shared.jobs import update_job_status
        
        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table
        
        update_job_status('proj_123', 'job_abc', 'running', 50, 'processing')
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        
        assert call_kwargs['Key'] == {'pk': 'PROJECT#proj_123', 'sk': 'JOB#job_abc'}
        assert ':status' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':status'] == 'running'
        assert call_kwargs['ExpressionAttributeValues'][':progress'] == 50
    
    @patch('shared.jobs.get_jobs_table')
    def test_updates_with_error(self, mock_get_jobs_table):
        """Should update job status with error message."""
        from shared.jobs import update_job_status
        
        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table
        
        update_job_status('proj_123', 'job_abc', 'failed', 0, 'error', error='Something went wrong')
        
        call_kwargs = mock_table.update_item.call_args[1]
        assert ':error' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':error'] == 'Something went wrong'
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']
    
    @patch('shared.jobs.get_jobs_table')
    def test_updates_with_result(self, mock_get_jobs_table):
        """Should update job status with result dict."""
        from shared.jobs import update_job_status
        
        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table
        
        result = {'document_id': 'doc_123', 'title': 'Test'}
        update_job_status('proj_123', 'job_abc', 'completed', 100, 'complete', result=result)
        
        call_kwargs = mock_table.update_item.call_args[1]
        assert ':result' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':result'] == result
    
    @patch('shared.jobs.get_jobs_table')
    @patch('shared.jobs.logger')
    def test_handles_missing_table_gracefully(self, mock_logger, mock_get_jobs_table):
        """Should log warning when table is not configured."""
        from shared.jobs import update_job_status
        
        mock_get_jobs_table.return_value = None
        
        # Should not raise
        update_job_status('proj_123', 'job_abc', 'running', 50, 'processing')
        
        mock_logger.warning.assert_called_once()


class TestJobContext:
    """Tests for JobContext class."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    @patch('shared.jobs.update_job_status')
    def test_update_progress_calls_update_job_status(self, mock_update):
        """Should call update_job_status with correct parameters."""
        from shared.jobs import JobContext
        
        ctx = JobContext('proj_123', 'job_abc')
        ctx.update_progress(50, 'processing')
        
        mock_update.assert_called_once_with('proj_123', 'job_abc', 'running', 50, 'processing')
    
    def test_stores_project_and_job_ids(self):
        """Should store project_id and job_id."""
        from shared.jobs import JobContext
        
        ctx = JobContext('proj_123', 'job_abc')
        
        assert ctx.project_id == 'proj_123'
        assert ctx.job_id == 'job_abc'


class TestJobHandler:
    """Tests for job_handler decorator."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_successful_job_updates_status_to_completed(self, mock_logger, mock_update):
        """Should update job status to completed on success."""
        from shared.jobs import job_handler, JobContext
        
        @job_handler(error_message='Test failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str, config: dict) -> dict:
            return {'result_key': 'result_value'}
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {'test': True}
        }
        
        result = test_job(event)
        
        assert result == {'success': True, 'result_key': 'result_value'}
        mock_update.assert_called_once_with(
            'proj_123', 'job_abc', 'completed', 100, 'complete',
            result={'result_key': 'result_value'}
        )
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_failed_job_updates_status_to_failed(self, mock_logger, mock_update):
        """Should update job status to failed on exception."""
        from shared.jobs import job_handler, JobContext
        from shared.exceptions import ServiceError
        
        @job_handler(error_message='Custom error message')
        def test_job(ctx: JobContext, project_id: str, job_id: str, config: dict) -> dict:
            raise ValueError('Something went wrong')
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {'test': True}
        }
        
        with pytest.raises(ServiceError, match='Custom error message'):
            test_job(event)
        
        mock_update.assert_called_once()
        call_args = mock_update.call_args
        assert call_args[0][0] == 'proj_123'
        assert call_args[0][1] == 'job_abc'
        assert call_args[0][2] == 'failed'
        assert call_args[0][3] == 0
        assert call_args[0][4] == 'error'
        assert 'Custom error message' in call_args[1]['error']
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_extracts_filters_config(self, mock_logger, mock_update):
        """Should extract 'filters' config key from event."""
        from shared.jobs import job_handler, JobContext
        
        received_config = None
        
        @job_handler(error_message='Test failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str, filters: dict) -> dict:
            nonlocal received_config
            received_config = filters
            return {}
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'filters': {'days': 30, 'sources': ['web']}
        }
        
        test_job(event)
        
        assert received_config == {'days': 30, 'sources': ['web']}
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_extracts_doc_config(self, mock_logger, mock_update):
        """Should extract 'doc_config' config key from event."""
        from shared.jobs import job_handler, JobContext
        
        received_config = None
        
        @job_handler(error_message='Test failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str, doc_config: dict) -> dict:
            nonlocal received_config
            received_config = doc_config
            return {}
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'doc_config': {'doc_type': 'prd', 'title': 'Test'}
        }
        
        test_job(event)
        
        assert received_config == {'doc_type': 'prd', 'title': 'Test'}
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_context_allows_progress_updates(self, mock_logger, mock_update):
        """Should allow progress updates via context."""
        from shared.jobs import job_handler, JobContext
        
        @job_handler(error_message='Test failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str, config: dict) -> dict:
            ctx.update_progress(25, 'step_1')
            ctx.update_progress(50, 'step_2')
            ctx.update_progress(75, 'step_3')
            return {'done': True}
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {}
        }
        
        test_job(event)
        
        # Should have 4 calls: 3 progress updates + 1 completed
        assert mock_update.call_count == 4
        
        # Check progress update calls
        calls = mock_update.call_args_list
        assert calls[0][0] == ('proj_123', 'job_abc', 'running', 25, 'step_1')
        assert calls[1][0] == ('proj_123', 'job_abc', 'running', 50, 'step_2')
        assert calls[2][0] == ('proj_123', 'job_abc', 'running', 75, 'step_3')
        
        # Check completed call
        assert calls[3][0][:5] == ('proj_123', 'job_abc', 'completed', 100, 'complete')
    
    @patch('shared.jobs.update_job_status')
    @patch('shared.jobs.logger')
    def test_truncates_long_error_messages(self, mock_logger, mock_update):
        """Should truncate error messages longer than 200 chars."""
        from shared.jobs import job_handler, JobContext
        from shared.exceptions import ServiceError
        
        long_error = 'x' * 500
        
        @job_handler(error_message='Job failed')
        def test_job(ctx: JobContext, project_id: str, job_id: str, config: dict) -> dict:
            raise ValueError(long_error)
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_abc',
            'config': {}
        }
        
        with pytest.raises(ServiceError):
            test_job(event)
        
        error_arg = mock_update.call_args[1]['error']
        # Error message should be truncated
        assert len(error_arg) < 250  # 'Job failed: ' + 200 chars max
