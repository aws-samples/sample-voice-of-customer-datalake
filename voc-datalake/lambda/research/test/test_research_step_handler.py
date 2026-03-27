"""
Tests for research_step_handler.py

Tests: Bedrock retry/error handling, job status updates, step function routing, error step.
Removed: import/existence checks (TestSharedModuleImports, TestBedrockThrottlingException.test_exception_exists),
         mock-passthrough test (TestInvokeBedrockWithRetry.test_successful_invocation).
"""
import json
import pytest
from unittest.mock import patch, MagicMock, call
from decimal import Decimal
from botocore.exceptions import ClientError


class TestInvokeBedrockWithRetry:
    """Tests for invoke_bedrock_with_retry — error handling and argument forwarding."""

    @patch('research_step_handler.converse')
    def test_forwards_custom_max_tokens_and_retries(self, mock_converse):
        """Passes custom max_tokens and max_retries to the converse module."""
        from research_step_handler import invoke_bedrock_with_retry

        mock_converse.return_value = 'Response'
        invoke_bedrock_with_retry("System", "User", max_tokens=2000, max_retries=5)

        call_args = mock_converse.call_args
        assert call_args.kwargs['max_tokens'] == 2000
        assert call_args.kwargs['max_retries'] == 5

    @patch('research_step_handler.converse')
    def test_converts_shared_throttling_to_local_exception(self, mock_converse):
        """Translates shared BedrockThrottlingError into handler-specific BedrockThrottlingException."""
        from research_step_handler import invoke_bedrock_with_retry, BedrockThrottlingException
        from shared.converse import BedrockThrottlingError

        mock_converse.side_effect = BedrockThrottlingError("Throttled")

        with pytest.raises(BedrockThrottlingException):
            invoke_bedrock_with_retry("System", "User")

    @patch('research_step_handler.converse')
    def test_propagates_non_retryable_errors(self, mock_converse):
        """Non-retryable errors like AccessDeniedException propagate immediately."""
        from research_step_handler import invoke_bedrock_with_retry

        access_denied = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'Access denied'}},
            'Converse'
        )
        mock_converse.side_effect = access_denied

        with pytest.raises(ClientError) as exc_info:
            invoke_bedrock_with_retry("System", "User")

        assert exc_info.value.response['Error']['Code'] == 'AccessDeniedException'


class TestUpdateJobStatus:
    """Tests for update_job_status — DynamoDB key structure and optional fields."""

    @patch('shared.jobs.get_jobs_table')
    def test_writes_correct_composite_key_and_status(self, mock_get_jobs_table):
        """Uses PROJECT#/JOB# composite key and writes status + progress."""
        from research_step_handler import update_job_status

        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table

        update_job_status('proj_123', 'job_456', 'running', 50, 'analyzing')

        call_args = mock_table.update_item.call_args.kwargs
        assert call_args['Key'] == {'pk': 'PROJECT#proj_123', 'sk': 'JOB#job_456'}
        assert call_args['ExpressionAttributeValues'][':status'] == 'running'
        assert call_args['ExpressionAttributeValues'][':progress'] == 50

    @patch('shared.jobs.get_jobs_table')
    def test_includes_error_field_when_provided(self, mock_get_jobs_table):
        """Includes error message in the update expression when error kwarg is set."""
        from research_step_handler import update_job_status

        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table

        update_job_status('proj_123', 'job_456', 'failed', 0, 'error', error='Something went wrong')

        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':error'] == 'Something went wrong'

    @patch('shared.jobs.get_jobs_table')
    def test_includes_result_field_when_provided(self, mock_get_jobs_table):
        """Includes result dict in the update expression when result kwarg is set."""
        from research_step_handler import update_job_status

        mock_table = MagicMock()
        mock_get_jobs_table.return_value = mock_table

        result = {'document_id': 'doc_123', 'title': 'Test Research'}
        update_job_status('proj_123', 'job_456', 'completed', 100, 'complete', result=result)

        expr_values = mock_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert expr_values[':result'] == result

    @patch('shared.jobs.get_jobs_table')
    @patch('shared.jobs.logger')
    def test_handles_missing_table_without_raising(self, mock_logger, mock_get_jobs_table):
        """Logs warning instead of crashing when jobs table is not configured."""
        from research_step_handler import update_job_status

        mock_get_jobs_table.return_value = None
        update_job_status('proj_123', 'job_456', 'running', 50)

        mock_logger.warning.assert_called_once()


class TestLambdaHandler:
    """Tests for main lambda_handler step routing."""

    @patch('research_step_handler.step_initialize')
    def test_routes_initialize_step_and_returns_result(self, mock_step, lambda_context):
        """Routes 'initialize' step to step_initialize and returns its result."""
        from research_step_handler import lambda_handler

        mock_step.return_value = {'feedback_count': 10}
        event = {'step': 'initialize', 'project_id': 'p1', 'job_id': 'j1', 'research_config': {}}

        result = lambda_handler(event, lambda_context)

        mock_step.assert_called_once_with(event)
        assert result == {'feedback_count': 10}

    def test_raises_value_error_for_unknown_step(self, lambda_context):
        """Raises ValueError with descriptive message for unrecognized step names."""
        from research_step_handler import lambda_handler

        with pytest.raises(ValueError, match='Unknown step'):
            lambda_handler({'step': 'unknown_step'}, lambda_context)


class TestStepError:
    """Tests for step_error function."""

    @patch('research_step_handler.update_job_status')
    def test_marks_job_as_failed_with_error_details(self, mock_update):
        """Sets job status to 'failed' and includes the error cause in the result."""
        from research_step_handler import step_error

        event = {
            'project_id': 'proj_123',
            'job_id': 'job_456',
            'error': {'Cause': 'Lambda timeout', 'Error': 'States.Timeout'}
        }

        result = step_error(event)

        assert result['success'] is False
        assert 'Lambda timeout' in result['error']
        call_args = mock_update.call_args
        assert call_args[0][2] == 'failed'
        assert 'Lambda timeout' in call_args[1]['error']
