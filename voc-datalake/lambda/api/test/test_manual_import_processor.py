"""
Tests for manual_import_processor.py - Async LLM parsing of pasted reviews.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestParseLlmResponse:
    """Tests for parse_llm_response helper function."""

    def test_parses_valid_json_directly(self):
        """Parses valid JSON response directly."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from manual_import_processor import parse_llm_response
        
        response = '{"reviews": [{"text": "Great!"}], "unparsed_sections": []}'
        result = parse_llm_response(response)
        
        assert len(result['reviews']) == 1
        assert result['reviews'][0]['text'] == 'Great!'

    def test_extracts_json_from_markdown_code_block(self):
        """Extracts JSON from markdown code block."""
        from manual_import_processor import parse_llm_response
        
        response = '''Here is the parsed data:
```json
{"reviews": [{"text": "Good product"}], "unparsed_sections": []}
```'''
        result = parse_llm_response(response)
        
        assert len(result['reviews']) == 1
        assert result['reviews'][0]['text'] == 'Good product'

    def test_returns_empty_result_for_invalid_json(self):
        """Returns empty result when JSON parsing fails."""
        from manual_import_processor import parse_llm_response
        
        response = 'This is not valid JSON at all'
        result = parse_llm_response(response)
        
        assert result['reviews'] == []
        assert len(result['unparsed_sections']) > 0

    def test_handles_empty_response(self):
        """Handles empty response string."""
        from manual_import_processor import parse_llm_response
        
        result = parse_llm_response('')
        
        assert result['reviews'] == []


class TestProcessJob:
    """Tests for process_job function."""

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_processes_job_successfully(self, mock_table, mock_bedrock):
        """Processes job and updates with parsed reviews."""
        mock_table.get_item.return_value = {
            'Item': {
                'raw_text': 'Great product! 5 stars. - John',
                'source_origin': 'g2'
            }
        }
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=lambda: json.dumps({
                'content': [{'type': 'text', 'text': '{"reviews": [{"text": "Great product!", "rating": 5, "author": "John"}], "unparsed_sections": []}'}]
            }).encode())
        }
        
        from manual_import_processor import process_job
        
        process_job('job-123')
        
        # Verify job was updated with completed status
        update_call = mock_table.update_item.call_args
        assert ':status' in update_call.kwargs['ExpressionAttributeValues']
        assert update_call.kwargs['ExpressionAttributeValues'][':status'] == 'completed'

    @patch('manual_import_processor.aggregates_table')
    def test_handles_missing_job(self, mock_table):
        """Handles case when job doesn't exist."""
        mock_table.get_item.return_value = {}
        
        from manual_import_processor import process_job
        
        # Should not raise, just log and return
        process_job('nonexistent-job')
        
        # Verify no update was attempted
        mock_table.update_item.assert_not_called()

    @patch('manual_import_processor.aggregates_table')
    def test_handles_empty_raw_text(self, mock_table):
        """Handles job with empty raw text."""
        mock_table.get_item.return_value = {
            'Item': {
                'raw_text': '',
                'source_origin': 'g2'
            }
        }
        
        from manual_import_processor import process_job
        
        process_job('job-123')
        
        # Verify job was updated with failed status
        update_call = mock_table.update_item.call_args
        assert update_call.kwargs['ExpressionAttributeValues'][':status'] == 'failed'

    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_handles_bedrock_failure(self, mock_table, mock_bedrock):
        """Handles Bedrock invocation failure."""
        mock_table.get_item.return_value = {
            'Item': {
                'raw_text': 'Some review text',
                'source_origin': 'g2'
            }
        }
        mock_bedrock.invoke_model.side_effect = Exception('Bedrock unavailable')
        
        from manual_import_processor import process_job
        
        process_job('job-123')
        
        # Verify job was updated with failed status
        update_calls = mock_table.update_item.call_args_list
        # Last call should be the failure update
        last_call = update_calls[-1]
        assert last_call.kwargs['ExpressionAttributeValues'][':status'] == 'failed'

    @patch('manual_import_processor.aggregates_table', None)
    def test_handles_unconfigured_table(self):
        """Handles case when aggregates table is not configured."""
        from manual_import_processor import process_job
        
        # Should not raise, just log and return
        process_job('job-123')


class TestCapabilityAwareBedrockBody:
    """The raw invoke_model body must match the resolved model's capabilities.

    Regression for the Sonnet 5 default bump: an explicit `temperature` or
    `thinking` budget in the request body 400s on adaptive-thinking /
    temperature-restricted models. These tests fail if either field is
    reintroduced unconditionally or the model stops routing through the
    utility-surface picker.
    """

    JOB_ITEM = {
        'Item': {
            'raw_text': 'Great product! 5 stars. - John',
            'source_origin': 'g2',
        }
    }
    BEDROCK_RESPONSE = {
        'body': MagicMock(read=lambda: json.dumps({
            'content': [{'type': 'text', 'text': '{"reviews": [], "unparsed_sections": []}'}]
        }).encode())
    }

    def _invoke_and_capture_body(self, mock_table, mock_bedrock):
        mock_table.get_item.return_value = self.JOB_ITEM
        mock_bedrock.invoke_model.return_value = self.BEDROCK_RESPONSE

        from manual_import_processor import process_job
        process_job('job-123')

        kwargs = mock_bedrock.invoke_model.call_args.kwargs
        return kwargs, json.loads(kwargs['body'])

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_routes_model_through_utility_surface(self, mock_table, mock_bedrock, mock_resolve):
        """Model ID comes from get_active_model_id('utility'), not a hardcoded env."""
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        kwargs, _ = self._invoke_and_capture_body(mock_table, mock_bedrock)

        mock_resolve.assert_called_once_with('utility')
        assert kwargs['modelId'] == 'global.anthropic.claude-sonnet-5'

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_adaptive_thinking_model_omits_thinking_and_temperature(
        self, mock_table, mock_bedrock, mock_resolve
    ):
        """Sonnet 5 (adaptive thinking always-on) rejects both params."""
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        _, body = self._invoke_and_capture_body(mock_table, mock_bedrock)

        assert 'thinking' not in body
        assert 'temperature' not in body

    @patch('manual_import_processor.get_active_model_id')
    @patch('manual_import_processor.bedrock')
    @patch('manual_import_processor.aggregates_table')
    def test_budgeted_thinking_model_keeps_thinking_but_omits_temperature(
        self, mock_table, mock_bedrock, mock_resolve
    ):
        """Haiku 4.5 accepts an explicit thinking budget; temperature stays
        omitted everywhere (defaults to 1, the only value thinking accepts)."""
        mock_resolve.return_value = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

        _, body = self._invoke_and_capture_body(mock_table, mock_bedrock)

        assert body['thinking'] == {'type': 'enabled', 'budget_tokens': 5000}
        assert 'temperature' not in body


class TestLambdaHandler:
    """Tests for the main Lambda handler."""

    @patch('manual_import_processor.process_job')
    def test_invokes_process_job(self, mock_process_job):
        """Invokes process_job with job_id from event."""
        from manual_import_processor import lambda_handler
        
        event = {'job_id': 'job-123'}
        context = MagicMock()
        
        result = lambda_handler(event, context)
        
        assert result['success'] is True
        assert result['job_id'] == 'job-123'
        mock_process_job.assert_called_once_with('job-123')

    @patch('manual_import_processor.process_job')
    def test_raises_error_when_job_id_missing(self, mock_process_job):
        """Raises ValidationError when job_id not in event."""
        from manual_import_processor import lambda_handler
        from shared.exceptions import ValidationError
        
        event = {}
        context = MagicMock()
        
        with pytest.raises(ValidationError) as exc_info:
            lambda_handler(event, context)
        
        assert 'No job_id' in str(exc_info.value)
        mock_process_job.assert_not_called()
