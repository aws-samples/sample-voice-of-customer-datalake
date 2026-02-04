"""
Tests for shared/jobs.py - Job utilities.
"""
import os
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone


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


class TestGetJob:
    """Tests for get_job function."""
    
    def setup_method(self):
        """Reset module state before each test."""
        from shared.tables import clear_table_cache
        clear_table_cache()
    
    @patch('shared.jobs.get_jobs_table')
    def test_returns_job_item(self, mock_get_jobs_table):
        """Should return job item when found."""
        from shared.jobs import get_job
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'job_id': 'job_abc', 'status': 'running'}
        }
        mock_get_jobs_table.return_value = mock_table
        
        result = get_job('proj_123', 'job_abc')
        
        assert result == {'job_id': 'job_abc', 'status': 'running'}
        mock_table.get_item.assert_called_once_with(
            Key={'pk': 'PROJECT#proj_123', 'sk': 'JOB#job_abc'}
        )
    
    @patch('shared.jobs.get_jobs_table')
    def test_returns_none_when_not_found(self, mock_get_jobs_table):
        """Should return None when job is not found."""
        from shared.jobs import get_job
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_get_jobs_table.return_value = mock_table
        
        result = get_job('proj_123', 'job_abc')
        
        assert result is None
    
    @patch('shared.jobs.get_jobs_table')
    def test_returns_none_when_table_not_configured(self, mock_get_jobs_table):
        """Should return None when table is not configured."""
        from shared.jobs import get_job
        
        mock_get_jobs_table.return_value = None
        
        result = get_job('proj_123', 'job_abc')
        
        assert result is None
