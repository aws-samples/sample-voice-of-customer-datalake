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
        """Includes extended thinking when budget > 0 (explicit-budget model)."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Thoughtful response'}]}}
        }
        mock_get_client.return_value = mock_client
        
        from shared.converse import converse
        converse('Complex question', thinking_budget=5000,
                 model_id='global.anthropic.claude-sonnet-4-6')
        
        call_args = mock_client.converse.call_args
        assert 'additionalModelRequestFields' in call_args.kwargs
        thinking = call_args.kwargs['additionalModelRequestFields']['thinking']
        assert thinking['type'] == 'enabled'
        assert thinking['budget_tokens'] == 5000

    @patch('shared.converse.get_bedrock_client')
    def test_skips_explicit_thinking_for_adaptive_models(self, mock_get_client):
        """Sonnet 5 runs adaptive thinking always-on and rejects an explicit
        budget — the field must be omitted so the call can't 400."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Thoughtful response'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        converse('Complex question', thinking_budget=5000,
                 model_id='global.anthropic.claude-sonnet-5')

        call_args = mock_client.converse.call_args
        assert 'additionalModelRequestFields' not in call_args.kwargs

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

    @patch('shared.converse.get_bedrock_client')
    def test_includes_temperature_by_default(self, mock_get_client):
        """Temperature is sent in inferenceConfig when the model accepts it."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'R'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        converse('Hi', temperature=0.4,
                 model_id='global.anthropic.claude-sonnet-4-6')

        cfg = mock_client.converse.call_args.kwargs['inferenceConfig']
        assert cfg['temperature'] == 0.4

    @patch('shared.converse.get_bedrock_client')
    def test_auto_omits_temperature_for_restricted_models(self, mock_get_client):
        """Sonnet 5 / Opus 4.8 reject `temperature` — converse() drops it
        automatically so any surface can be pointed at them via the picker
        without every caller special-casing the param."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'R'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        for model in ('global.anthropic.claude-sonnet-5',
                      'global.anthropic.claude-opus-4-8'):
            converse('Hi', temperature=0.4, model_id=model)
            cfg = mock_client.converse.call_args.kwargs['inferenceConfig']
            assert 'temperature' not in cfg, model
            assert cfg['maxTokens']  # other config still present

    @patch('shared.converse.get_bedrock_client')
    def test_omits_temperature_when_none(self, mock_get_client):
        """temperature=None omits the param entirely (e.g. for Opus 4.8)."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'R'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        converse('Hi', temperature=None)

        cfg = mock_client.converse.call_args.kwargs['inferenceConfig']
        assert 'temperature' not in cfg
        assert cfg['maxTokens']  # other config still present


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
        converse('Hello', max_tokens=500, temperature=0.7,
                 model_id='global.anthropic.claude-sonnet-4-6')
        
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


class TestConverseAutoContinuation:
    """Tests for auto-continuation when the model hits the maxTokens ceiling."""

    @staticmethod
    def _resp(text, stop_reason='end_turn'):
        return {
            'output': {'message': {'content': [{'text': text}]}},
            'stopReason': stop_reason,
        }

    @patch('shared.converse.get_bedrock_client')
    def test_resumes_when_truncated_then_concatenates(self, mock_get_client):
        """A max_tokens stop triggers a continuation; chunks are concatenated."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('Part one ', stop_reason='max_tokens'),
            self._resp('and part two.', stop_reason='end_turn'),
        ]
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Write a long doc', step_name='prd_document')

        assert result == 'Part one and part two.'
        assert mock_client.converse.call_count == 2

    @patch('shared.converse.get_bedrock_client')
    def test_continuation_replays_prior_text(self, mock_get_client):
        """The continuation turn includes the prior assistant text and a resume nudge."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('First chunk', stop_reason='max_tokens'),
            self._resp(' done', stop_reason='end_turn'),
        ]
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        converse('prompt text', step_name='prd_document')

        second_call_messages = mock_client.converse.call_args_list[1].kwargs['messages']
        roles = [m['role'] for m in second_call_messages]
        assert roles == ['user', 'assistant', 'user']
        assert second_call_messages[1]['content'][0]['text'] == 'First chunk'

    @patch('shared.converse.get_bedrock_client')
    def test_stops_at_max_continuations(self, mock_get_client):
        """Never loops forever: stops after max_continuations even if still truncated."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('x', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Write a long doc', step_name='prd_document', max_continuations=2)

        # 1 initial call + 2 continuations
        assert mock_client.converse.call_count == 3
        assert result == 'xxx'

    @patch('shared.converse.get_bedrock_client')
    def test_no_continuation_on_normal_stop(self, mock_get_client):
        """A normal end_turn does not trigger any continuation."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('Complete answer', stop_reason='end_turn')
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Hello', step_name='test')

        assert result == 'Complete answer'
        mock_client.converse.assert_called_once()

    @patch('shared.converse.get_bedrock_client')
    def test_continuation_disabled_with_thinking_budget(self, mock_get_client):
        """Continuation is skipped when EXPLICIT extended thinking is sent
        (thinking-block replay is unsupported). Uses a model that accepts an
        explicit budget — adaptive-thinking models never send the field and
        so keep continuation."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('partial', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Hello', step_name='test', thinking_budget=5000,
                          model_id='global.anthropic.claude-sonnet-4-6')

        assert result == 'partial'
        mock_client.converse.assert_called_once()





class TestConverseSurfaceRouting:
    """converse() resolves its model through the per-surface picker (issue #96)."""

    @staticmethod
    def _client(text='R'):
        client = MagicMock()
        client.converse.return_value = {
            'output': {'message': {'content': [{'text': text}]}}
        }
        return client

    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_resolves_model_for_named_surface(self, mock_get_client, mock_resolve):
        mock_get_client.return_value = self._client()
        mock_resolve.return_value = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

        from shared.converse import converse
        converse('Hi', surface='enrichment')

        mock_resolve.assert_called_once_with('enrichment')
        call = mock_get_client.return_value.converse.call_args
        assert call.kwargs['modelId'] == 'global.anthropic.claude-haiku-4-5-20251001-v1:0'

    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_explicit_model_id_bypasses_surface_resolution(self, mock_get_client, mock_resolve):
        """explicit arg > configured surface — the documented precedence."""
        mock_get_client.return_value = self._client()

        from shared.converse import converse
        converse('Hi', surface='chat', model_id='global.anthropic.claude-opus-4-8')

        mock_resolve.assert_not_called()
        call = mock_get_client.return_value.converse.call_args
        assert call.kwargs['modelId'] == 'global.anthropic.claude-opus-4-8'

    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_chain_threads_surface_to_every_step(self, mock_get_client, mock_resolve):
        mock_get_client.return_value = self._client()
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        from shared.converse import converse_chain
        converse_chain(
            [{'system': '', 'user': 'a'}, {'system': '', 'user': 'b'}],
            surface='documents',
        )

        assert mock_resolve.call_count == 2
        assert all(c.args == ('documents',) for c in mock_resolve.call_args_list)

    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_chain_step_surface_overrides_chain_surface(self, mock_get_client, mock_resolve):
        mock_get_client.return_value = self._client()
        mock_resolve.return_value = 'global.anthropic.claude-sonnet-5'

        from shared.converse import converse_chain
        converse_chain(
            [{'system': '', 'user': 'a', 'surface': 'prototype'}],
            surface='documents',
        )

        mock_resolve.assert_called_once_with('prototype')
