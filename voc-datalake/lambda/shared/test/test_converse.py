"""
Tests for shared.converse module.
"""

import pytest
from unittest.mock import patch, MagicMock
from botocore.exceptions import ClientError


class TestConverse:
    """Tests for converse function."""

    @patch('shared.converse.get_bedrock_client')
    def test_basic_completion(self, mock_get_client):
        """Returns text from basic completion."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {
                'message': {
                    'content': [{'text': 'Hello, world!'}]
                }
            }
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Say hello')
        
        assert result == 'Hello, world!'
        mock_client.converse.assert_called_once()

    @patch('shared.converse.get_bedrock_client')
    def test_includes_system_prompt(self, mock_get_client):
        """Includes system prompt when provided."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Hello', system_prompt='You are helpful.')
        
        call_args = mock_client.converse.call_args
        assert call_args.kwargs['system'] == [{'text': 'You are helpful.'}]

    @patch('shared.converse.get_bedrock_client')
    def test_extended_thinking_budget(self, mock_get_client):
        """Includes extended thinking when budget > 0."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Thoughtful response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Complex question', thinking_budget=5000)
        
        call_args = mock_client.converse.call_args
        assert 'additionalModelRequestFields' in call_args.kwargs
        thinking = call_args.kwargs['additionalModelRequestFields']['thinking']
        assert thinking['type'] == 'enabled'
        assert thinking['budget_tokens'] == 5000

    @patch('shared.converse.get_bedrock_client')
    def test_no_thinking_when_budget_zero(self, mock_get_client):
        """Does not include thinking when budget is 0."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Simple question', thinking_budget=0)
        
        call_args = mock_client.converse.call_args
        assert 'additionalModelRequestFields' not in call_args.kwargs


class TestConverseRetry:
    """Tests for converse retry functionality."""

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_retries_on_throttling(self, mock_get_client, mock_sleep):
        """Retries on ThrottlingException."""
        mock_client = MagicMock()
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'Converse'
        )
        mock_client.converse.side_effect = [
            throttle_error,
            {'output': {'message': {'content': [{'text': 'Success'}]}}}
        ]
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Test', max_retries=3)
        
        assert result == 'Success'
        assert mock_client.converse.call_count == 2
        mock_sleep.assert_called_once()

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_raises_after_max_retries(self, mock_get_client, mock_sleep):
        """Raises BedrockThrottlingError after max retries."""
        mock_client = MagicMock()
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'Converse'
        )
        mock_client.converse.side_effect = throttle_error
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse, BedrockThrottlingError
        
        with pytest.raises(BedrockThrottlingError):
            converse('Test', max_retries=2)
        
        assert mock_client.converse.call_count == 2

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_returns_empty_when_raise_disabled(self, mock_get_client, mock_sleep):
        """Returns empty string when raise_on_throttle=False."""
        mock_client = MagicMock()
        throttle_error = ClientError(
            {'Error': {'Code': 'ThrottlingException', 'Message': 'Rate exceeded'}},
            'Converse'
        )
        mock_client.converse.side_effect = throttle_error
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Test', max_retries=2, raise_on_throttle=False)
        
        assert result == ''

    @patch('shared.converse.get_bedrock_client')
    def test_raises_non_retryable_errors(self, mock_get_client):
        """Raises non-retryable errors immediately."""
        mock_client = MagicMock()
        access_error = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'No access'}},
            'Converse'
        )
        mock_client.converse.side_effect = access_error
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        
        with pytest.raises(ClientError) as exc_info:
            converse('Test', max_retries=3)
        
        assert exc_info.value.response['Error']['Code'] == 'AccessDeniedException'
        assert mock_client.converse.call_count == 1

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_retries_on_service_unavailable(self, mock_get_client, mock_sleep):
        """Retries on ServiceUnavailableException."""
        mock_client = MagicMock()
        service_error = ClientError(
            {'Error': {'Code': 'ServiceUnavailableException', 'Message': 'Service down'}},
            'Converse'
        )
        mock_client.converse.side_effect = [
            service_error,
            {'output': {'message': {'content': [{'text': 'Success'}]}}}
        ]
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Test', max_retries=3)
        
        assert result == 'Success'
        assert mock_client.converse.call_count == 2


class TestConverseChain:
    """Tests for converse_chain function."""

    @patch('shared.converse.converse')
    def test_executes_chain_of_steps(self, mock_converse):
        """Executes chain of LLM calls."""
        mock_converse.side_effect = ['Step 1 result', 'Step 2 result']
        
        from shared.converse import converse_chain
        steps = [
            {'system': 'System 1', 'user': 'User 1', 'max_tokens': 1000},
            {'system': 'System 2', 'user': 'Previous: {previous}', 'max_tokens': 2000},
        ]
        
        results = converse_chain(steps)
        
        assert len(results) == 2
        assert results[0] == 'Step 1 result'
        assert results[1] == 'Step 2 result'
        assert mock_converse.call_count == 2

    @patch('shared.converse.converse')
    def test_injects_previous_result(self, mock_converse):
        """Injects previous result into {previous} placeholder."""
        mock_converse.side_effect = ['First output', 'Second output']
        
        from shared.converse import converse_chain
        steps = [
            {'system': 'S1', 'user': 'Start'},
            {'system': 'S2', 'user': 'Continue from: {previous}'},
        ]
        
        converse_chain(steps)
        
        # Second call should have the first result injected
        second_call = mock_converse.call_args_list[1]
        assert 'Continue from: First output' == second_call.kwargs['prompt']

    @patch('shared.converse.converse')
    def test_calls_progress_callback(self, mock_converse):
        """Calls progress callback for each step."""
        mock_converse.return_value = 'Result'
        progress_calls = []
        
        def progress_callback(progress, step):
            progress_calls.append((progress, step))
        
        from shared.converse import converse_chain
        steps = [
            {'system': 'S1', 'user': 'U1', 'step_name': 'analysis'},
            {'system': 'S2', 'user': 'U2', 'step_name': 'synthesis'},
        ]
        
        converse_chain(steps, progress_callback=progress_callback)
        
        assert len(progress_calls) == 2
        assert progress_calls[0][1] == 'analysis'
        assert progress_calls[1][1] == 'synthesis'

    @patch('shared.converse.converse')
    def test_passes_thinking_budget(self, mock_converse):
        """Passes thinking_budget to converse."""
        mock_converse.return_value = 'Result'
        
        from shared.converse import converse_chain
        steps = [
            {'system': 'S1', 'user': 'U1', 'thinking_budget': 3000},
        ]
        
        converse_chain(steps)
        
        call_args = mock_converse.call_args
        assert call_args.kwargs['thinking_budget'] == 3000


class TestExtractText:
    """Tests for _extract_text helper function."""

    def test_extracts_single_text_block(self):
        """Extracts text from single content block."""
        from shared.converse import _extract_text
        
        content = [{'text': 'Hello world'}]
        assert _extract_text(content) == 'Hello world'

    def test_concatenates_multiple_text_blocks(self):
        """Concatenates text from multiple blocks."""
        from shared.converse import _extract_text
        
        content = [{'text': 'Hello '}, {'text': 'world'}]
        assert _extract_text(content) == 'Hello world'

    def test_ignores_non_text_blocks(self):
        """Ignores blocks without text key."""
        from shared.converse import _extract_text
        
        content = [
            {'text': 'Hello'},
            {'toolUse': {'name': 'search'}},
            {'text': ' world'}
        ]
        assert _extract_text(content) == 'Hello world'

    def test_returns_empty_for_empty_content(self):
        """Returns empty string for empty content list."""
        from shared.converse import _extract_text
        
        assert _extract_text([]) == ''

    def test_returns_empty_for_no_text_blocks(self):
        """Returns empty string when no text blocks present."""
        from shared.converse import _extract_text
        
        content = [{'toolUse': {'name': 'search'}}]
        assert _extract_text(content) == ''


class TestCalculateBackoff:
    """Tests for _calculate_backoff helper function."""

    def test_first_attempt_returns_base_delay_plus_jitter(self):
        """First attempt returns approximately base delay."""
        from shared.converse import _calculate_backoff, DEFAULT_BASE_DELAY
        
        delay = _calculate_backoff(0)
        # Base delay (1.0) + jitter (0-1)
        assert DEFAULT_BASE_DELAY <= delay <= DEFAULT_BASE_DELAY + 1

    def test_exponential_increase(self):
        """Delay increases exponentially with attempts."""
        from shared.converse import _calculate_backoff
        
        delay_0 = _calculate_backoff(0)
        delay_1 = _calculate_backoff(1)
        delay_2 = _calculate_backoff(2)
        
        # Each should roughly double (accounting for jitter)
        assert delay_1 > delay_0
        assert delay_2 > delay_1

    def test_caps_at_max_delay(self):
        """Delay is capped at maximum value."""
        from shared.converse import _calculate_backoff, DEFAULT_MAX_DELAY
        
        # Very high attempt number
        delay = _calculate_backoff(100)
        assert delay <= DEFAULT_MAX_DELAY + 1  # +1 for jitter


class TestConverseEdgeCases:
    """Tests for edge cases in converse function."""

    @patch('shared.converse.get_bedrock_client')
    def test_uses_custom_model_id(self, mock_get_client):
        """Uses custom model ID when provided."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Hello', model_id='custom-model-123')
        
        call_args = mock_client.converse.call_args
        assert call_args.kwargs['modelId'] == 'custom-model-123'

    @patch('shared.converse.get_bedrock_client')
    def test_handles_empty_response_content(self, mock_get_client):
        """Handles empty content in response."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': []}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Hello')
        
        assert result == ''

    @patch('shared.converse.get_bedrock_client')
    def test_omits_system_when_empty(self, mock_get_client):
        """Does not include system key when system_prompt is empty."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Hello', system_prompt='')
        
        call_args = mock_client.converse.call_args
        assert 'system' not in call_args.kwargs

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_retries_on_model_stream_error(self, mock_get_client, mock_sleep):
        """Retries on ModelStreamErrorException."""
        mock_client = MagicMock()
        stream_error = ClientError(
            {'Error': {'Code': 'ModelStreamErrorException', 'Message': 'Stream error'}},
            'Converse'
        )
        mock_client.converse.side_effect = [
            stream_error,
            {'output': {'message': {'content': [{'text': 'Success'}]}}}
        ]
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Test', max_retries=3)
        
        assert result == 'Success'
        assert mock_client.converse.call_count == 2

    @patch('shared.converse.get_bedrock_client')
    def test_passes_inference_config(self, mock_get_client):
        """Passes max_tokens and temperature in inferenceConfig."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Hello', max_tokens=500, temperature=0.7)
        
        call_args = mock_client.converse.call_args
        assert call_args.kwargs['inferenceConfig']['maxTokens'] == 500
        assert call_args.kwargs['inferenceConfig']['temperature'] == 0.7

    @patch('shared.converse.time.sleep')
    @patch('shared.converse.get_bedrock_client')
    def test_retries_generic_exceptions(self, mock_get_client, mock_sleep):
        """Retries on generic exceptions (not just ClientError)."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            ConnectionError("Network error"),
            {'output': {'message': {'content': [{'text': 'Success'}]}}}
        ]
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        result = converse('Test', max_retries=3)
        
        assert result == 'Success'
        assert mock_client.converse.call_count == 2


class TestConverseChainEdgeCases:
    """Tests for edge cases in converse_chain function."""

    @patch('shared.converse.converse')
    def test_handles_empty_steps_list(self, mock_converse):
        """Returns empty list for empty steps."""
        from shared.converse import converse_chain
        
        results = converse_chain([])
        
        assert results == []
        mock_converse.assert_not_called()

    @patch('shared.converse.converse')
    def test_uses_default_step_name(self, mock_converse):
        """Uses default step name when not provided."""
        mock_converse.return_value = 'Result'
        progress_calls = []
        
        from shared.converse import converse_chain
        steps = [{'system': 'S1', 'user': 'U1'}]  # No step_name
        
        converse_chain(steps, progress_callback=lambda p, s: progress_calls.append(s))
        
        assert progress_calls[0] == 'llm_step_1'

    @patch('shared.converse.converse')
    def test_handles_progress_callback_error(self, mock_converse):
        """Continues execution when progress callback raises."""
        mock_converse.return_value = 'Result'
        
        def failing_callback(progress, step):
            raise ValueError("Callback failed")
        
        from shared.converse import converse_chain
        steps = [{'system': 'S1', 'user': 'U1'}]
        
        # Should not raise, should continue
        results = converse_chain(steps, progress_callback=failing_callback)
        
        assert results == ['Result']

    @patch('shared.converse.converse')
    def test_passes_max_retries_to_converse(self, mock_converse):
        """Passes max_retries parameter to converse calls."""
        mock_converse.return_value = 'Result'
        
        from shared.converse import converse_chain
        steps = [{'system': 'S1', 'user': 'U1'}]
        
        converse_chain(steps, max_retries=10)
        
        call_args = mock_converse.call_args
        assert call_args.kwargs['max_retries'] == 10



