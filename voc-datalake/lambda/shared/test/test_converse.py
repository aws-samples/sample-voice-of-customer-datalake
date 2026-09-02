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

    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_explicit_model_id_takes_precedence_over_surface(
        self, mock_get_client, mock_get_active_model_id
    ):
        """Does not resolve the surface when model_id is explicit."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Done'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Say hello', surface='documents', model_id='explicit-model')

        assert result == 'Done'
        mock_get_active_model_id.assert_not_called()
        assert mock_client.converse.call_args.kwargs['modelId'] == 'explicit-model'

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
        """Sonnet 5 and Opus 5 run adaptive thinking always-on and reject an
        explicit budget (a manual `thinking.budget_tokens` is a 400 on Opus 4.7
        and later) — the field must be omitted so the call can't 400.

        Covers EVERY model in the capability set rather than a single id:
        Opus 5 is the prototype-surface default, so dropping it out of
        _ADAPTIVE_THINKING_IDS would 400 every prototype build.
        """
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'Thoughtful response'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        from shared.model_config import ALLOWED_MODELS, uses_adaptive_thinking

        adaptive_ids = {m['id'] for m in ALLOWED_MODELS
                        if uses_adaptive_thinking(m['id'])}
        # Guards against the set silently shrinking to one entry.
        assert {'global.anthropic.claude-sonnet-5',
                'global.anthropic.claude-opus-5'} <= adaptive_ids

        for model_id in sorted(adaptive_ids):
            mock_client.converse.reset_mock()
            converse('Complex question', thinking_budget=5000, model_id=model_id)
            call_args = mock_client.converse.call_args
            assert 'additionalModelRequestFields' not in call_args.kwargs, model_id

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
        """Sonnet 5 / Opus 5 reject `temperature` — converse() drops it
        automatically so any surface can be pointed at them via the picker
        without every caller special-casing the param."""
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'R'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        for model in ('global.anthropic.claude-sonnet-5',
                      'global.anthropic.claude-opus-5'):
            converse('Hi', temperature=0.4, model_id=model)
            cfg = mock_client.converse.call_args.kwargs['inferenceConfig']
            assert 'temperature' not in cfg, model
            assert cfg['maxTokens']  # other config still present

    @patch('shared.converse.get_bedrock_client')
    def test_omits_temperature_when_none(self, mock_get_client):
        """temperature=None omits the param entirely (e.g. for Opus 5)."""
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

    @patch('shared.converse.get_bedrock_client')
    def test_temperature_and_thinking_sent_exactly_when_legal(self, mock_get_client):
        """Full truth table for the two request fields, over EVERY allowlisted
        model at both budgets.

        Anthropic permits only temperature=1 alongside extended thinking, so
        sending both is a hard 400 ("`temperature` may only be set to 1 when
        thinking is enabled"). That is a COMBINATION failure: both capability
        flags were individually correct and nothing stated that the request they
        JOINTLY produce has to be valid. A capability table cannot express a
        constraint between capabilities, so the invariant belongs here.

        Asserting BOTH directions matters. "Never both fields" alone is also
        satisfied by a regression that drops temperature for every model, which
        would silently discard sampling control everywhere — so each case pins
        what must be PRESENT as well as what must be absent.

        Driven off the capability data rather than hardcoded model ids, so a
        newly allowlisted model is covered on arrival and a retired one does not
        turn this into a false negative.
        """
        mock_client = MagicMock()
        mock_client.converse.return_value = {
            'output': {'message': {'content': [{'text': 'R'}]}}
        }
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        from shared.model_config import (
            ALLOWED_MODELS,
            omits_temperature,
            uses_adaptive_thinking,
        )

        # The loop count below proves the loop RAN, but not that any model can
        # actually reach the illegal pairing — if every model that accepts
        # temperature stops taking an explicit budget, case 1 goes quietly
        # vacuous. Data-driven so no id is pinned. If this fires, the allowlist
        # no longer contains a model that can produce the bug: confirm that is
        # intended, then this test's regression half can be retired with it.
        assert any(
            not omits_temperature(m['id']) and not uses_adaptive_thinking(m['id'])
            for m in ALLOWED_MODELS
        ), "no allowlisted model can pair temperature with an explicit thinking budget"

        checked = 0
        for model in ALLOWED_MODELS:
            model_id = model['id']
            for budget in (0, 5000):
                mock_client.converse.reset_mock()
                converse('Q', temperature=0.1, thinking_budget=budget,
                         model_id=model_id)
                kwargs = mock_client.converse.call_args.kwargs
                sent_temperature = 'temperature' in kwargs['inferenceConfig']
                # Read the nested key rather than testing for the container, so
                # an unrelated additionalModelRequestFields entry added later
                # can't be mistaken for a thinking budget.
                thinking = kwargs.get('additionalModelRequestFields', {}).get('thinking')

                # 1. The bug itself: the two fields must never travel together.
                assert not (sent_temperature and thinking), (
                    f"{model_id} at budget={budget} sent both temperature and an "
                    f"explicit thinking budget, which Bedrock rejects"
                )

                # 2. An explicit budget is sent exactly when the model takes one
                #    — so suppressing temperature can never come at the cost of
                #    silently disabling the thinking the caller asked for.
                expect_thinking = budget > 0 and not uses_adaptive_thinking(model_id)
                assert bool(thinking) == expect_thinking, (
                    f"{model_id} at budget={budget}: expected explicit thinking="
                    f"{expect_thinking}"
                )
                if expect_thinking:
                    assert thinking['budget_tokens'] == budget, model_id
                    # Thinking is in play, so temperature is illegal regardless
                    # of what the model would otherwise accept.
                    assert not sent_temperature, model_id
                else:
                    # No thinking in play, so the ONLY legitimate reason to drop
                    # temperature is the model rejecting the parameter.
                    assert sent_temperature == (not omits_temperature(model_id)), (
                        f"{model_id} at budget={budget}: temperature presence "
                        f"should follow omits_temperature() when thinking is off"
                    )
                checked += 1
        # Guards against the loop silently iterating nothing.
        assert checked == len(ALLOWED_MODELS) * 2

    def test_temperature_note_names_the_actual_suppression_cause(self):
        """The `Effective params` log exists to tell an operator WHY temperature
        vanished, so attributing it to the wrong cause is worse than silence.

        Causes can co-occur — `temperature=None` with an explicit budget is
        reachable today — so this pins each one against a case where a naive
        first-match-wins order would misreport it.
        """
        from shared.converse import _temperature_note

        # What is under test is the ORDER the causes are checked in, not the
        # capability lookup, so the lookup is stubbed and the ids are synthetic.
        # Sourcing a real "rejects temperature" model from ALLOWED_MODELS would
        # couple this to the allowlist's contents and fail if every model ever
        # accepts temperature — the same false negative the invariant test's
        # guard is careful to make deliberate, but here it would be incidental
        # rather than meaningful: fixture availability says nothing about the
        # system. Real models are covered by the invariant test above.
        ACCEPTS = 'model-that-accepts-temperature'
        REJECTS = 'model-that-rejects-temperature'

        with patch('shared.converse.omits_temperature',
                   lambda model_id: model_id == REJECTS):
            # Sent: report the value, not a reason.
            assert _temperature_note(True, 0.1, ACCEPTS, False) == '0.1'

            # None wins over a co-occurring explicit budget — the caller's choice
            # is the reason, and blaming thinking here would send an operator
            # hunting a model-capability problem that does not exist.
            assert _temperature_note(False, None, ACCEPTS, True) == 'omitted (caller passed None)'
            assert _temperature_note(False, None, ACCEPTS, False) == 'omitted (caller passed None)'

            # Model capability, including alongside an explicit budget.
            assert _temperature_note(False, 0.1, REJECTS, False) == 'omitted (model rejects it)'
            assert _temperature_note(False, 0.1, REJECTS, True) == 'omitted (model rejects it)'

            # Only when the caller asked for it and the model accepts it is
            # thinking the real cause.
            assert _temperature_note(False, 0.1, ACCEPTS, True) == 'omitted (explicit thinking)'


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

    @patch('shared.converse.converse')
    def test_pins_explicit_model_id(self, mock_converse):
        """Forwards an explicit model_id to every step."""
        mock_converse.side_effect = ['First output', 'Second output']

        from shared.converse import converse_chain
        steps = [
            {'system': 'S1', 'user': 'U1'},
            {'system': 'S2', 'user': 'U2'},
        ]

        converse_chain(steps, surface='documents', model_id='resolved-model')

        assert [c.kwargs['model_id'] for c in mock_converse.call_args_list] == [
            'resolved-model',
            'resolved-model',
        ]
        assert [c.kwargs['surface'] for c in mock_converse.call_args_list] == [
            'documents',
            'documents',
        ]

    @patch('shared.converse.converse')
    def test_chain_model_id_overrides_step_model(self, mock_converse):
        """A pinned chain model keeps every step on the recorded model."""
        mock_converse.side_effect = ['First output', 'Second output']

        from shared.converse import converse_chain
        steps = [
            {'system': 'S1', 'user': 'U1'},
            {'system': 'S2', 'user': 'U2', 'model': 'step-model'},
        ]

        converse_chain(steps, surface='documents', model_id='chain-model')

        assert [c.kwargs['model_id'] for c in mock_converse.call_args_list] == [
            'chain-model',
            'chain-model',
        ]


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

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_retries_with_raised_ceiling(self, mock_get_client):
        """Adaptive-thinking models can burn the whole maxTokens budget on
        thinking and return zero visible text. Instead of replaying an empty
        assistant turn (rejected by Converse: 'text content blocks must be
        non-empty'), the request is re-run single-turn with a doubled ceiling."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('', stop_reason='max_tokens'),
            self._resp('Full answer.', stop_reason='end_turn'),
        ]
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Analyze this', step_name='research_analyze', max_tokens=3000)

        assert result == 'Full answer.'
        assert mock_client.converse.call_count == 2
        # Retry is single-turn (no assistant replay) with a doubled budget.
        retry_kwargs = mock_client.converse.call_args_list[1].kwargs
        assert [m['role'] for m in retry_kwargs['messages']] == ['user']
        assert retry_kwargs['inferenceConfig']['maxTokens'] == 6000

    @pytest.mark.parametrize('current_max, expected', [
        (3000, 6000),        # room to double
        (32000, 64000),      # the build_prototype budget doubles onto the ceiling
        (40000, 64000),      # doubling overshoots — capped, but still a raise
        (64000, None),       # AT the ceiling: a retry would be byte-identical
        (100000, None),      # ABOVE it: a cap would LOWER the budget
    ])
    def test_raised_empty_budget_never_lowers_the_ceiling(self, current_max, expected):
        """The empty-text retry must clamp UPWARD ONLY.

        A bare min(current * 2, CEILING) reduces any above-ceiling budget, which
        makes the empty-text outcome strictly MORE likely — the opposite of the
        retry's purpose. A caller sitting exactly at the ceiling would instead get
        a byte-identical retry. Both must decline (None) rather than shrink or
        duplicate."""
        from shared.converse import _raised_empty_budget
        assert _raised_empty_budget(current_max) == expected

    def test_raise_ceiling_clears_the_largest_known_caller_budget(self):
        """The ceiling must sit ABOVE the largest known caller, or the retry is
        inert precisely where it is needed most.

        `build_prototype` asks for 32000 on the 'prototype' surface, whose default
        is Opus 5 — adaptive thinking, i.e. the likeliest caller to spend the whole
        budget on thinking and land in the empty-text branch. A ceiling at or below
        32000 means that caller can never be retried.

        Scope is deliberately "known", not "every": the budget below is
        hand-maintained rather than grepped out of the callers, because `shared/`
        is bundled into many Lambdas and sibling handler paths are not reliably
        present when these tests run. A NEW caller above the ceiling would not
        trip this — it is caught instead by the ValidationException fallback,
        which degrades to the empty result rather than crashing."""
        from shared.converse import _EMPTY_RAISE_CEILING, _raised_empty_budget
        largest_known_caller_budget = 32000  # jobs/document_generator/handler.py
        assert _EMPTY_RAISE_CEILING > largest_known_caller_budget
        assert _raised_empty_budget(largest_known_caller_budget) is not None

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_retries_the_prototype_budget(self, mock_get_client):
        """The 32000-token prototype caller DOES get a raise (to 64000).

        This is the surface the whole branch exists for; an earlier ceiling of
        16384 left it with no retry at all."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('', stop_reason='max_tokens'),
            self._resp('<html>...</html>', stop_reason='end_turn'),
        ]
        mock_get_client.return_value = mock_client
        from shared.converse import converse
        result = converse('Build this', step_name='build_prototype', max_tokens=32000)
        assert result == '<html>...</html>'
        budgets = [c.kwargs['inferenceConfig']['maxTokens']
                   for c in mock_client.converse.call_args_list]
        assert budgets == [32000, 64000]

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_does_not_retry_without_headroom(self, mock_get_client):
        """A caller at/above the ceiling gets no retry — one Bedrock call, no
        wasted duplicate, and crucially no shrunken budget. The
        empty-assistant-replay crash is still avoided (returns '')."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client
        from shared.converse import converse, _EMPTY_RAISE_CEILING
        over_ceiling = _EMPTY_RAISE_CEILING + 1000
        result = converse('Build this', step_name='huge', max_tokens=over_ceiling)
        assert result == ''
        mock_client.converse.assert_called_once()
        # And the single call kept the caller's own, larger budget.
        sent = mock_client.converse.call_args.kwargs['inferenceConfig']['maxTokens']
        assert sent == over_ceiling

    @pytest.mark.parametrize('elapsed, deadline, past', [
        (0.0, 420.0, False),
        (419.0, 420.0, False),
        (421.0, 420.0, True),
        # A short-timeout caller can pass its own, smaller deadline.
        (20.0, 15.0, True),
        (10.0, 15.0, False),
    ])
    def test_empty_raise_deadline_predicate(self, elapsed, deadline, past):
        """The deadline is a pure decision, so it is tested as one.

        NOT tested by patching `shared.converse.time.time`: that module attribute
        IS the global `time` module, so patching it monkeypatches `time.time`
        process-wide and botocore's TLS clock breaks (SystemTimeWarning, SSL
        verification failures)."""
        from shared.converse import _empty_raise_past_deadline
        assert _empty_raise_past_deadline(elapsed, deadline) is past

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_skips_the_raise_past_the_deadline(self, mock_get_client):
        """Headroom alone is not enough to retry — the invocation must also have
        time left. A timeout mid-retry returns nothing at all, which is worse
        than returning ''.

        Forced via the caller-facing `empty_raise_deadline_seconds` argument, so
        no module state or clock is patched."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client
        from shared.converse import converse, _raised_empty_budget
        # Headroom DOES exist at this budget (32000 -> 64000), so only the
        # deadline can be what stops the retry.
        assert _raised_empty_budget(32000) == 64000
        result = converse('Build this', step_name='build_prototype', max_tokens=32000,
                          empty_raise_deadline_seconds=-1)
        assert result == ''
        mock_client.converse.assert_called_once()

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_raise_rejected_by_model_returns_empty(self, mock_get_client):
        """If the resolved model caps output below the raised budget, Bedrock
        400s the retry — degrade to the pre-retry outcome rather than crashing.

        _EMPTY_RAISE_CEILING is sized against Opus 5's 128K output limit, but this
        branch is reachable for ANY resolved model, including an arbitrary
        `model_id=` override outside the allowlist. Turning a harmless empty
        result into a ValidationException would be worse than the failure the
        retry was trying to fix."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('', stop_reason='max_tokens'),
            ClientError(
                {'Error': {'Code': 'ValidationException',
                           'Message': 'max_tokens: 64000 > 32000, the maximum for this model'}},
                'Converse',
            ),
        ]
        mock_get_client.return_value = mock_client
        from shared.converse import converse
        result = converse('Build this', step_name='build_prototype', max_tokens=32000)
        assert result == ''
        assert mock_client.converse.call_count == 2

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_raise_still_propagates_other_client_errors(self, mock_get_client):
        """Only ValidationException is absorbed. An AccessDenied on the retry is a
        real misconfiguration and must not be masked as an empty result."""
        mock_client = MagicMock()
        mock_client.converse.side_effect = [
            self._resp('', stop_reason='max_tokens'),
            ClientError(
                {'Error': {'Code': 'AccessDeniedException', 'Message': 'no model access'}},
                'Converse',
            ),
        ]
        mock_get_client.return_value = mock_client
        from shared.converse import converse
        with pytest.raises(ClientError):
            converse('Build this', step_name='build_prototype', max_tokens=32000)

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_stops_once_the_raise_hits_the_ceiling(self, mock_get_client):
        """A caller BELOW the ceiling raises until it reaches the ceiling, then
        stops — it does not spend its remaining allowance on identical requests.

        Half the ceiling doubles onto it exactly, so the second raise has nowhere
        to go: 2 calls, not the 3 that _MAX_EMPTY_BUDGET_RAISES would allow. The
        start budget is derived from the ceiling so this cannot rot when the
        ceiling moves (it already did, 16384 -> 64000)."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client
        from shared.converse import converse, _EMPTY_RAISE_CEILING
        half_ceiling = _EMPTY_RAISE_CEILING // 2
        result = converse('Analyze this', step_name='research_analyze', max_tokens=half_ceiling)
        assert result == ''
        budgets = [c.kwargs['inferenceConfig']['maxTokens']
                   for c in mock_client.converse.call_args_list]
        assert budgets == [half_ceiling, _EMPTY_RAISE_CEILING]

    @patch('shared.converse.get_bedrock_client')
    def test_empty_max_tokens_result_gives_up_after_max_raises(self, mock_get_client):
        """If the model keeps returning empty text at the ceiling, stop after
        the raise limit instead of looping — returns empty rather than crashing."""
        mock_client = MagicMock()
        mock_client.converse.return_value = self._resp('', stop_reason='max_tokens')
        mock_get_client.return_value = mock_client

        from shared.converse import converse
        result = converse('Analyze this', step_name='research_analyze', max_tokens=3000)

        # 1 initial + _MAX_EMPTY_BUDGET_RAISES retries, no ValidationException.
        from shared.converse import _MAX_EMPTY_BUDGET_RAISES
        assert mock_client.converse.call_count == 1 + _MAX_EMPTY_BUDGET_RAISES
        assert result == ''





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
        converse('Hi', surface='chat', model_id='global.anthropic.claude-opus-5')

        mock_resolve.assert_not_called()
        call = mock_get_client.return_value.converse.call_args
        assert call.kwargs['modelId'] == 'global.anthropic.claude-opus-5'

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

    @patch('shared.converse.logger')
    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_chain_step_surface_under_pinned_model_id_is_flagged(
        self, mock_get_client, mock_resolve, mock_logger,
    ):
        """A pinned chain model_id beats a per-step surface (explicit model >
        surface resolution); the inert override is logged, not eaten quietly."""
        mock_get_client.return_value = self._client()

        from shared.converse import converse_chain
        result = converse_chain(
            [{'system': '', 'user': 'a', 'surface': 'prototype'}],
            surface='documents',
            model_id='pinned-model',
        )

        assert result == ['R']
        mock_resolve.assert_not_called()
        flagged = [c for c in mock_logger.warning.call_args_list if 'drops inert overrides' in str(c)]
        assert flagged, 'expected a warning naming the ignored surface override'

    @patch('shared.converse.logger')
    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_chain_step_surface_under_step_model_id_is_flagged(
        self, mock_get_client, mock_resolve, mock_logger,
    ):
        """A step model also beats that step's surface, even with no chain pin."""
        mock_get_client.return_value = self._client()

        from shared.converse import converse_chain
        converse_chain(
            [{'system': '', 'user': 'a', 'surface': 'prototype', 'model': 'step-model'}],
            surface='documents',
        )

        mock_resolve.assert_not_called()
        flagged = [c for c in mock_logger.warning.call_args_list if 'drops inert overrides' in str(c)]
        assert flagged, 'expected a warning naming the ignored surface override'

    @patch('shared.converse.logger')
    @patch('shared.converse.get_active_model_id')
    @patch('shared.converse.get_bedrock_client')
    def test_chain_step_overrides_under_pinned_model_emit_one_warning(
        self, mock_get_client, mock_resolve, mock_logger,
    ):
        """A step carrying BOTH a model and a surface under a chain pin logs
        one combined warning naming everything dropped, not one per key."""
        mock_get_client.return_value = self._client()

        from shared.converse import converse_chain
        result = converse_chain(
            [{'system': '', 'user': 'a', 'surface': 'prototype', 'model': 'step-model'}],
            surface='documents',
            model_id='pinned-model',
        )

        assert result == ['R']
        combined = [c for c in mock_logger.warning.call_args_list if 'drops inert overrides' in str(c)]
        assert len(combined) == 1, 'expected exactly one combined warning'
        assert "surface='prototype'" in str(combined[0])
        assert 'model_id/model' in str(combined[0])
