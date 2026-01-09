"""
Tests for research_step_handler.py

These tests validate:
1. Shared module imports work correctly (the root cause of the production failure)
2. Bedrock retry logic with exponential backoff
3. Job status updates
4. Feedback data formatting
5. Step function routing
"""
import json
import pytest
from unittest.mock import patch, MagicMock, call
from decimal import Decimal
from botocore.exceptions import ClientError
import io


class TestSharedModuleImports:
    """Tests to validate shared module imports work correctly.
    
    This is critical - the production failure was caused by missing shared module.
    These tests ensure the imports work before deployment.
    """
    
    def test_shared_logging_imports(self):
        """Validates shared.logging module imports correctly."""
        from shared.logging import logger, tracer, metrics
        
        assert logger is not None
        assert tracer is not None
        assert metrics is not None
    
    def test_shared_aws_imports(self):
        """Validates shared.aws module imports correctly."""
        from shared.aws import get_dynamodb_resource, BEDROCK_MODEL_ID
        
        assert get_dynamodb_resource is not None
        assert BEDROCK_MODEL_ID is not None
        assert 'claude' in BEDROCK_MODEL_ID.lower()
    
    def test_research_handler_imports(self):
        """Validates research_step_handler imports without errors."""
        # This will fail if shared module is not available
        import research_step_handler
        
        assert hasattr(research_step_handler, 'lambda_handler')
        assert hasattr(research_step_handler, 'step_initialize')
        assert hasattr(research_step_handler, 'step_analyze')
        assert hasattr(research_step_handler, 'step_synthesize')
        assert hasattr(research_step_handler, 'step_validate')
        assert hasattr(research_step_handler, 'step_save')
        assert hasattr(research_step_handler, 'step_error')


class TestBedrockThrottlingException:
    """Tests for custom BedrockThrottlingException."""
    
    def test_exception_exists(self):
        """Validates BedrockThrottlingException is defined."""
        from research_step_handler import BedrockThrottlingException
        
        assert BedrockThrottlingException is not None
    
    def test_exception_is_raisable(self):
        """Validates exception can be raised and caught."""
        from research_step_handler import BedrockThrottlingException
        
        with pytest.raises(BedrockThrottlingException) as exc_info:
            raise BedrockThrottlingException("Test throttling error")
        
        assert "Test throttling error" in str(exc_info.value)


class TestInvokeBedrockWithRetry:
    """Tests for invoke_bedrock_with_retry function."""
    
    @patch('research_step_handler.bedrock')
    def test_successful_invocation(self, mock_bedrock):
        """Returns response on successful invocation."""
        from research_step_handler import invoke_bedrock_with_retry
        
        response_body = {'content': [{'text': 'Test response'}]}
        mock_bedrock.invoke_model.return_value = {
            'body': io.BytesIO(json.dumps(response_body).encode())
        }
        
        result = invoke_bedrock_with_retry("System prompt", "User message")
        
        assert result == 'Test response'
        mock_bedrock.invoke_model.assert_called_once()
    
    @patch('research_step_handler.time.sleep')
    @patch('research_step_handler.bedrock')
    def test_retries_on_throttling(self, mock_bedrock, mock_sleep):
        """Retries with backoff on ThrottlingException."""
        from research_step_handler import invoke_bedrock_with_retry
        
        # First call fails with throttling, second succeeds
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'InvokeModel'
        )
        response_body = {'content': [{'text': 'Success after retry'}]}
        
        mock_bedrock.invoke_model.side_effect = [
            throttle_error,
            {'body': io.BytesIO(json.dumps(response_body).encode())}
        ]
        
        result = invoke_bedrock_with_retry("System", "User", max_retries=3)
        
        assert result == 'Success after retry'
        assert mock_bedrock.invoke_model.call_count == 2
        mock_sleep.assert_called_once()  # Should have slept once between retries
    
    @patch('research_step_handler.time.sleep')
    @patch('research_step_handler.bedrock')
    def test_raises_after_max_retries(self, mock_bedrock, mock_sleep):
        """Raises BedrockThrottlingException after max retries exhausted."""
        from research_step_handler import invoke_bedrock_with_retry, BedrockThrottlingException
        
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'InvokeModel'
        )
        mock_bedrock.invoke_model.side_effect = throttle_error
        
        with pytest.raises(BedrockThrottlingException) as exc_info:
            invoke_bedrock_with_retry("System", "User", max_retries=2)
        
        assert "failed after 2 retries" in str(exc_info.value)
        assert mock_bedrock.invoke_model.call_count == 2
    
    @patch('research_step_handler.bedrock')
    def test_raises_immediately_on_non_retryable_error(self, mock_bedrock):
        """Raises immediately on non-retryable ClientError."""
        from research_step_handler import invoke_bedrock_with_retry
        
        access_denied = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'Access denied'}},
            'InvokeModel'
        )
        mock_bedrock.invoke_model.side_effect = access_denied
        
        with pytest.raises(ClientError) as exc_info:
            invoke_bedrock_with_retry("System", "User")
        
        assert exc_info.value.response['Error']['Code'] == 'AccessDeniedException'
        mock_bedrock.invoke_model.assert_called_once()


class TestUpdateJobStatus:
    """Tests for update_job_status function."""
    
    @patch('research_step_handler.jobs_table')
    def test_updates_basic_status(self, mock_jobs_table):
        """Updates job status with basic fields."""
        from research_step_handler import update_job_status
        
        update_job_status('proj_123', 'job_456', 'running', 50, 'analyzing')
        
        mock_jobs_table.update_item.assert_called_once()
        call_args = mock_jobs_table.update_item.call_args
        
        assert call_args.kwargs['Key'] == {'pk': 'PROJECT#proj_123', 'sk': 'JOB#job_456'}
        assert ':status' in call_args.kwargs['ExpressionAttributeValues']
        assert call_args.kwargs['ExpressionAttributeValues'][':status'] == 'running'
        assert call_args.kwargs['ExpressionAttributeValues'][':progress'] == 50
    
    @patch('research_step_handler.jobs_table')
    def test_updates_with_error(self, mock_jobs_table):
        """Updates job status with error message."""
        from research_step_handler import update_job_status
        
        update_job_status('proj_123', 'job_456', 'failed', 0, 'error', error='Something went wrong')
        
        call_args = mock_jobs_table.update_item.call_args
        assert ':error' in call_args.kwargs['ExpressionAttributeValues']
        assert call_args.kwargs['ExpressionAttributeValues'][':error'] == 'Something went wrong'
    
    @patch('research_step_handler.jobs_table')
    def test_updates_with_result(self, mock_jobs_table):
        """Updates job status with result."""
        from research_step_handler import update_job_status
        
        result = {'document_id': 'doc_123', 'title': 'Test Research'}
        update_job_status('proj_123', 'job_456', 'completed', 100, 'complete', result=result)
        
        call_args = mock_jobs_table.update_item.call_args
        assert ':result' in call_args.kwargs['ExpressionAttributeValues']
        assert call_args.kwargs['ExpressionAttributeValues'][':result'] == result
    
    @patch('research_step_handler.jobs_table', None)
    def test_handles_missing_table_gracefully(self):
        """Does not raise when jobs_table is None."""
        from research_step_handler import update_job_status
        
        # Should not raise
        update_job_status('proj_123', 'job_456', 'running', 50)


class TestFormatFeedbackForLLM:
    """Tests for format_feedback_for_llm function."""
    
    def test_formats_feedback_items(self, sample_feedback_items):
        """Formats feedback items into LLM-readable text."""
        from research_step_handler import format_feedback_for_llm
        
        result = format_feedback_for_llm(sample_feedback_items)
        
        assert '### Review 1' in result
        assert '### Review 2' in result
        assert 'test_source' in result
        assert 'Great service!' in result
        assert 'Late delivery' in result
    
    def test_includes_problem_summary_when_present(self, sample_feedback_items):
        """Includes problem summary for negative feedback."""
        from research_step_handler import format_feedback_for_llm
        
        result = format_feedback_for_llm(sample_feedback_items)
        
        assert 'Delivery was late' in result
        assert 'Logistics issues' in result
    
    def test_handles_empty_list(self):
        """Returns empty string for empty list."""
        from research_step_handler import format_feedback_for_llm
        
        result = format_feedback_for_llm([])
        
        assert result == ''


class TestGetFeedbackStatistics:
    """Tests for get_feedback_statistics function."""
    
    def test_generates_statistics(self, sample_feedback_items):
        """Generates statistics from feedback items."""
        from research_step_handler import get_feedback_statistics
        
        result = get_feedback_statistics(sample_feedback_items)
        
        assert 'n=2' in result
        assert 'positive' in result
        assert 'negative' in result
        assert 'customer_service' in result
        assert 'delivery' in result
    
    def test_handles_empty_list(self):
        """Returns message for empty list."""
        from research_step_handler import get_feedback_statistics
        
        result = get_feedback_statistics([])
        
        assert 'No feedback data available' in result


class TestDecimalEncoder:
    """Tests for DecimalEncoder JSON encoder."""
    
    def test_encodes_decimal_as_float(self):
        """Converts Decimal to float in JSON."""
        from research_step_handler import DecimalEncoder
        
        data = {'score': Decimal('0.95'), 'rating': Decimal('5')}
        result = json.dumps(data, cls=DecimalEncoder)
        
        assert '0.95' in result
        assert '5' in result or '5.0' in result


class TestLambdaHandler:
    """Tests for main lambda_handler routing."""
    
    @patch('research_step_handler.step_initialize')
    def test_routes_to_initialize(self, mock_step, lambda_context):
        """Routes initialize step correctly."""
        from research_step_handler import lambda_handler
        
        mock_step.return_value = {'feedback_count': 10}
        event = {'step': 'initialize', 'project_id': 'p1', 'job_id': 'j1', 'research_config': {}}
        
        result = lambda_handler(event, lambda_context)
        
        mock_step.assert_called_once_with(event)
        assert result == {'feedback_count': 10}
    
    @patch('research_step_handler.step_analyze')
    def test_routes_to_analyze(self, mock_step, lambda_context):
        """Routes analyze step correctly."""
        from research_step_handler import lambda_handler
        
        mock_step.return_value = {'analysis': 'test'}
        event = {'step': 'analyze', 'project_id': 'p1', 'job_id': 'j1'}
        
        result = lambda_handler(event, lambda_context)
        
        mock_step.assert_called_once()
    
    @patch('research_step_handler.step_error')
    def test_routes_to_error(self, mock_step, lambda_context):
        """Routes error step correctly."""
        from research_step_handler import lambda_handler
        
        mock_step.return_value = {'success': False}
        event = {'step': 'error', 'project_id': 'p1', 'job_id': 'j1', 'error': {'Cause': 'Test error'}}
        
        result = lambda_handler(event, lambda_context)
        
        mock_step.assert_called_once()
    
    def test_raises_on_unknown_step(self, lambda_context):
        """Raises ValueError for unknown step."""
        from research_step_handler import lambda_handler
        
        event = {'step': 'unknown_step'}
        
        with pytest.raises(ValueError) as exc_info:
            lambda_handler(event, lambda_context)
        
        assert 'Unknown step' in str(exc_info.value)


class TestStepError:
    """Tests for step_error function."""
    
    @patch('research_step_handler.update_job_status')
    def test_updates_job_as_failed(self, mock_update):
        """Updates job status to failed with error message."""
        from research_step_handler import step_error
        
        event = {
            'project_id': 'proj_123',
            'job_id': 'job_456',
            'error': {'Cause': 'Lambda timeout', 'Error': 'States.Timeout'}
        }
        
        result = step_error(event)
        
        assert result['success'] is False
        assert 'Lambda timeout' in result['error']
        mock_update.assert_called_once()
        call_args = mock_update.call_args
        assert call_args[0][2] == 'failed'  # status
        assert 'Lambda timeout' in call_args[1]['error']
