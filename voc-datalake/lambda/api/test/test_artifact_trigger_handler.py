"""
Tests for artifact_trigger_handler.py - ECS task trigger from SQS.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestUpdateJobStatus:
    """Tests for update_job_status helper function."""

    @patch('artifact_trigger_handler.jobs_table')
    def test_updates_status_in_dynamodb(self, mock_table):
        """Updates job status in DynamoDB."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from artifact_trigger_handler import update_job_status
        
        update_job_status('job-123', 'generating')
        
        mock_table.update_item.assert_called_once()
        call_args = mock_table.update_item.call_args
        assert call_args.kwargs['Key'] == {'pk': 'JOB#job-123', 'sk': 'META'}
        assert ':status' in call_args.kwargs['ExpressionAttributeValues']
        assert call_args.kwargs['ExpressionAttributeValues'][':status'] == 'generating'

    @patch('artifact_trigger_handler.jobs_table')
    def test_includes_error_when_provided(self, mock_table):
        """Includes error message when provided."""
        from artifact_trigger_handler import update_job_status
        
        update_job_status('job-123', 'failed', error='Task failed to start')
        
        call_args = mock_table.update_item.call_args
        assert ':error' in call_args.kwargs['ExpressionAttributeValues']
        assert call_args.kwargs['ExpressionAttributeValues'][':error'] == 'Task failed to start'


class TestRecordHandler:
    """Tests for record_handler SQS message processor."""

    @patch('artifact_trigger_handler.jobs_table')
    @patch('artifact_trigger_handler.ecs')
    def test_starts_ecs_task_successfully(self, mock_ecs, mock_table):
        """Starts ECS Fargate task for job."""
        mock_ecs.run_task.return_value = {
            'tasks': [{'taskArn': 'arn:aws:ecs:us-east-1:123:task/cluster/task-id'}],
            'failures': []
        }
        
        from artifact_trigger_handler import record_handler
        
        record = MagicMock()
        record.body = json.dumps({'job_id': 'job-123'})
        
        result = record_handler(record)
        
        assert result['status'] == 'success'
        assert result['job_id'] == 'job-123'
        assert 'task_arn' in result
        mock_ecs.run_task.assert_called_once()

    @patch('artifact_trigger_handler.jobs_table')
    @patch('artifact_trigger_handler.ecs')
    def test_handles_ecs_task_failure(self, mock_ecs, mock_table):
        """Handles ECS task start failure."""
        mock_ecs.run_task.return_value = {
            'tasks': [],
            'failures': [{'reason': 'Capacity unavailable'}]
        }
        
        from artifact_trigger_handler import record_handler
        
        record = MagicMock()
        record.body = json.dumps({'job_id': 'job-123'})
        
        result = record_handler(record)
        
        assert result['status'] == 'error'
        # Verify job status was updated to failed
        update_calls = mock_table.update_item.call_args_list
        assert any(':status' in str(call) for call in update_calls)

    @patch('artifact_trigger_handler.jobs_table')
    def test_returns_error_when_job_id_missing(self, mock_table):
        """Returns error when job_id not in message."""
        from artifact_trigger_handler import record_handler
        
        record = MagicMock()
        record.body = json.dumps({})
        
        result = record_handler(record)
        
        assert result['status'] == 'error'
        assert 'No job_id' in result['message']

    @patch('artifact_trigger_handler.jobs_table')
    @patch('artifact_trigger_handler.ecs')
    def test_stores_task_arn_in_job_record(self, mock_ecs, mock_table):
        """Stores ECS task ARN in job record."""
        task_arn = 'arn:aws:ecs:us-east-1:123:task/cluster/task-id'
        mock_ecs.run_task.return_value = {
            'tasks': [{'taskArn': task_arn}],
            'failures': []
        }
        
        from artifact_trigger_handler import record_handler
        
        record = MagicMock()
        record.body = json.dumps({'job_id': 'job-123'})
        
        record_handler(record)
        
        # Find the call that stores the task ARN
        update_calls = mock_table.update_item.call_args_list
        arn_stored = any(
            ':arn' in str(call) and task_arn in str(call)
            for call in update_calls
        )
        assert arn_stored

    @patch('artifact_trigger_handler.jobs_table')
    @patch('artifact_trigger_handler.ecs')
    def test_handles_ecs_exception(self, mock_ecs, mock_table):
        """Handles ECS client exception."""
        mock_ecs.run_task.side_effect = Exception('ECS service unavailable')
        
        from artifact_trigger_handler import record_handler
        
        record = MagicMock()
        record.body = json.dumps({'job_id': 'job-123'})
        
        with pytest.raises(Exception):
            record_handler(record)
        
        # Verify job status was updated to failed
        update_calls = mock_table.update_item.call_args_list
        assert len(update_calls) >= 2  # At least 'generating' and 'failed' updates


class TestLambdaHandler:
    """Tests for the main Lambda handler."""

    @patch('artifact_trigger_handler.processor')
    @patch('artifact_trigger_handler.jobs_table')
    @patch('artifact_trigger_handler.ecs')
    def test_processes_sqs_batch(self, mock_ecs, mock_table, mock_processor):
        """Processes SQS batch of messages."""
        mock_processor.response.return_value = {'batchItemFailures': []}
        mock_ecs.run_task.return_value = {
            'tasks': [{'taskArn': 'arn:aws:ecs:us-east-1:123:task/cluster/task-id'}],
            'failures': []
        }
        
        from artifact_trigger_handler import lambda_handler
        
        event = {
            'Records': [
                {'body': json.dumps({'job_id': 'job-1'})},
                {'body': json.dumps({'job_id': 'job-2'})}
            ]
        }
        context = MagicMock()
        
        result = lambda_handler(event, context)
        
        assert 'batchItemFailures' in result
