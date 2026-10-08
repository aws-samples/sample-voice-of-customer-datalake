"""Mutation hardening for `shared/converse.py`.

The earlier suites pin the request shape, the retry policy and the tier
fallback in broad strokes, but a mutation run found what they could not see:

* the LOG TRANSCRIPT. `[BEDROCK]`/`[CHAIN]` lines are the only trace an operator
  has of a Bedrock call (which step, which attempt, which budget, why a
  temperature vanished). No test read them, so any wording, number or step-name
  suffix (`_raise1`, `_cont2`) could drift. They are pinned here as literals, with
  the clock and the jitter frozen so every duration and delay is exact.
* the module's DEFAULTS as literals: 5 attempts, 8 continuations, 2 empty-budget
  raises, a 420 s raise deadline, 1 s base / 30 s max backoff, 2048 tokens at
  temperature 0.1 — earlier tests read the constants back, which pins nothing.
* the tier-refusal classifier per keyword (`service tier`, `servicetier`,
  `flex`, `SERVICE_TIER`), a reported tier that differs from the one sent, and
  the FlexFallback metric's value and namespace.
* that a ServiceUnavailable throttle is retried on the SAME model: without that
  assertion the model fallback hides a lost retry.
"""
import logging
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError

from shared import converse as converse_module
from shared import model_config
from shared.converse import (
    SERVICE_TIERS,
    ConverseResult,
    _empty_raise_past_deadline,
    _TierState,
    converse,
    converse_detailed,
)
from shared.test.converse_fixtures import metric_recorder

# Accepts temperature AND takes an explicit thinking budget.
MODEL = 'global.anthropic.claude-sonnet-4-6'
# Rejects temperature, adaptive thinking.
ADAPTIVE = 'global.anthropic.claude-sonnet-5'
FLEX_MODEL = 'test.flex-capable-model-v1:0'
NOW = 1000.0


def _answer(text: str, stop: str = 'end_turn', **extra: object) -> dict:
    return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': stop, **extra}


def _client_error(code: str, message: str = 'nope') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'Converse')


@pytest.fixture
def client() -> Iterator[MagicMock]:
    bedrock = MagicMock()
    with patch.object(converse_module, 'get_bedrock_client', return_value=bedrock), \
            patch.object(converse_module, 'get_active_model_id', return_value=MODEL):
        yield bedrock


@pytest.fixture
def clock() -> Iterator[MagicMock]:
    """converse's own `time` name only (the global module is untouched)."""
    fake = MagicMock()
    fake.time.return_value = NOW
    with patch.object(converse_module, 'time', fake):
        yield fake


@pytest.fixture
def jitter() -> Iterator[MagicMock]:
    rng = MagicMock()
    rng.uniform.return_value = 0.25
    with patch.object(converse_module, '_JITTER_RNG', rng):
        yield rng


@pytest.fixture
def logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger=converse_module.logger.name)
    return caplog


def _lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [f'{r.levelname} {r.getMessage()}' for r in caplog.records]


class TestTheDefaultsAreLiterals:
    @pytest.mark.parametrize('entry', [converse, converse_detailed])
    def test_a_bare_call_sends_2048_tokens_at_temperature_0_1_without_a_system_prompt(self, client, logs, entry):
        client.converse.return_value = _answer('ok')

        entry('Hi')

        client.converse.assert_called_once_with(
            modelId=MODEL,
            messages=[{'role': 'user', 'content': [{'text': 'Hi'}]}],
            inferenceConfig={'maxTokens': 2048, 'temperature': 0.1},
        )
        assert "INFO [BEDROCK] Attempt 1/5 for step 'unknown'" in _lines(logs)

    @pytest.mark.usefixtures('clock')
    def test_five_attempts_then_a_detailed_call_raises_by_default(self, client):
        client.converse.side_effect = _client_error('ThrottlingException')
        with patch.object(converse_module, 'fallback_chain', return_value=(MODEL,)), \
                pytest.raises(converse_module.BedrockThrottlingError):
            converse_detailed('Hi')
        assert client.converse.call_count == 5

    def test_eight_continuations_by_default(self, client, logs):
        client.converse.return_value = _answer('x', stop='max_tokens')

        assert converse('Hi', step_name='doc') == 'x' * 9

        assert client.converse.call_count == 9
        assert _lines(logs)[-2] == (
            "WARNING [BEDROCK] Step 'doc' still truncated after 8 continuation(s); "
            "output may be incomplete (9 chars)"
        )

    def test_two_empty_budget_raises_by_default(self, client, logs):
        client.converse.return_value = _answer('', stop='max_tokens')

        assert converse('Hi', step_name='doc', max_tokens=3000) == ''

        budgets = [c.kwargs['inferenceConfig']['maxTokens'] for c in client.converse.call_args_list]
        assert budgets == [3000, 6000, 12000]
        lines = _lines(logs)
        assert (
            "WARNING [BEDROCK] Step 'doc' hit maxTokens with no visible text (budget likely consumed "
            "by thinking); retrying with maxTokens=6000 (1/2)"
        ) in lines
        assert (
            "WARNING [BEDROCK] Step 'doc' hit maxTokens with no visible text (budget likely consumed "
            "by thinking); retrying with maxTokens=12000 (2/2)"
        ) in lines
        assert "INFO [BEDROCK] Attempt 1/5 for step 'doc_raise2'" in lines
        assert (
            "WARNING [BEDROCK] Step 'doc' still produced no visible text after 2 maxTokens raise(s); "
            "giving up on continuation"
        ) in lines

    def test_the_raise_deadline_is_420_seconds(self, client, clock, logs):
        readings = iter([NOW])
        clock.time.side_effect = lambda: next(readings, NOW + 420.5)
        client.converse.return_value = _answer('', stop='max_tokens')

        converse('Hi', step_name='doc')

        client.converse.assert_called_once()
        assert (
            "WARNING [BEDROCK] Step 'doc' produced no visible text but 420s of the invocation is "
            "already spent (deadline 420s); skipping the maxTokens raise to avoid a timeout"
        ) in _lines(logs)

    def test_exactly_at_the_deadline_is_not_past_it(self):
        assert _empty_raise_past_deadline(420.0, 420.0) is False


class TestResultDefaults:
    def test_a_bare_result_records_nothing(self):
        result = ConverseResult(text='t')
        assert (result.requested_tier, result.resolved_tier, result.flex_fallback,
                result.model_id, result.requested_model_id) == (None, None, False, None, None)
        assert result.model_fallback is False

    @pytest.mark.parametrize(('model_id', 'requested', 'fell_back'), [
        ('a', 'a', False),
        ('b', 'a', True),
        ('b', None, False),
    ])
    def test_model_fallback_is_a_different_model_than_requested(self, model_id, requested, fell_back):
        result = ConverseResult(text='t', model_id=model_id, requested_model_id=requested)
        assert result.model_fallback is fell_back

    def test_a_fresh_tier_state_has_resolved_nothing(self):
        state = _TierState(surface='s', sending=None)
        assert (state.requested, state.resolved, state.fell_back) == (None, None, False)


class TestTheRequestOnTheWire:
    def test_a_one_token_budget_is_still_explicit_thinking(self, client, logs):
        client.converse.return_value = _answer('ok')

        converse('Hi', model_id=MODEL, thinking_budget=1)

        kwargs = client.converse.call_args.kwargs
        assert kwargs['additionalModelRequestFields'] == {'thinking': {'type': 'enabled', 'budget_tokens': 1}}
        assert 'temperature' not in kwargs['inferenceConfig']
        assert "INFO [BEDROCK] Effective params: temperature=omitted (explicit thinking), thinking=1" in _lines(logs)

    @pytest.mark.parametrize(('model_id', 'temperature', 'budget', 'line'), [
        (MODEL, 0.1, 0, 'temperature=0.1, thinking=omitted'),
        (MODEL, None, 5000, 'temperature=omitted (caller passed None), thinking=5000'),
        (ADAPTIVE, 0.1, 5000, 'temperature=omitted (model rejects it), thinking=omitted'),
    ])
    def test_the_effective_params_line_names_what_was_sent(self, client, logs, model_id, temperature, budget, line):
        client.converse.return_value = _answer('ok')

        converse('Hi', model_id=model_id, temperature=temperature, thinking_budget=budget)

        assert f'INFO [BEDROCK] Effective params: {line}' in _lines(logs)

    def test_a_continuation_replays_the_prompt_the_answer_and_the_exact_nudge(self, client, logs):
        client.converse.side_effect = [_answer('Part one', stop='max_tokens'), _answer(' two')]

        assert converse('Hi', model_id=MODEL, step_name='doc') == 'Part one two'

        assert client.converse.call_args_list[1].kwargs['messages'] == [
            {'role': 'user', 'content': [{'text': 'Hi'}]},
            {'role': 'assistant', 'content': [{'text': 'Part one'}]},
            {'role': 'user', 'content': [{'text': (
                'Continue the document exactly where you left off. Do not repeat any text you '
                'already wrote and do not add a preamble — resume from the next character.'
            )}]},
        ]
        lines = _lines(logs)
        assert "WARNING [BEDROCK] Step 'doc' hit maxTokens — auto-continuing (1/8), 8 chars so far" in lines
        assert "INFO [BEDROCK] Attempt 1/5 for step 'doc_cont1'" in lines

    def test_an_empty_continuation_stops_at_once(self, client, logs):
        client.converse.side_effect = [_answer('Part', stop='max_tokens'), _answer('', stop='max_tokens')]

        assert converse('Hi', model_id=MODEL, step_name='doc') == 'Part'

        assert client.converse.call_count == 2
        assert "WARNING [BEDROCK] Step 'doc' continuation returned no text; stopping" in _lines(logs)


@pytest.mark.usefixtures('clock')
class TestTheTranscript:
    def test_one_clean_call(self, client, logs):
        client.converse.return_value = _answer('Hello', usage={'inputTokens': 3, 'outputTokens': 4})

        converse('Hi', system_prompt='Sys', model_id=MODEL, step_name='s')

        assert _lines(logs) == [
            f"INFO [BEDROCK] Starting converse call for step 's' with model {MODEL} (surface=default, service_tier=None)",
            'INFO [BEDROCK] Requested params: max_tokens=2048, temperature=0.1, thinking_budget=0',
            'INFO [BEDROCK] Prompt length: 2 chars, system_prompt length: 3 chars',
            'INFO [BEDROCK] Got Bedrock client successfully',
            'INFO [BEDROCK] Effective params: temperature=0.1, thinking=omitted',
            "INFO [BEDROCK] Invoking Bedrock converse API for step 's'...",
            "INFO [BEDROCK] Attempt 1/5 for step 's'",
            "INFO [BEDROCK] Calling client.converse() for step 's'...",
            "INFO [BEDROCK] Response received for step 's' in 0.00s",
            'INFO [BEDROCK] Usage: input_tokens=3, output_tokens=4, stop_reason=end_turn',
            "INFO [BEDROCK] Extracted 5 chars from response for step 's' (stop_reason=end_turn)",
            "INFO [BEDROCK] Step 's' completed in 0.00s, response length: 5 chars",
        ]

    def test_a_reply_without_usage_or_stop_reason(self, client, logs):
        client.converse.return_value = {'output': {'message': {'content': [{'text': 'ok'}]}}}

        converse('Hi', model_id=MODEL, step_name='s')

        lines = _lines(logs)
        assert 'INFO [BEDROCK] Usage: input_tokens=0, output_tokens=0, stop_reason=unknown' in lines
        assert "INFO [BEDROCK] Extracted 2 chars from response for step 's' (stop_reason=)" in lines

    def test_a_throttle_retried_on_the_same_model(self, client, clock, jitter, logs):
        client.converse.side_effect = [_client_error('ThrottlingException', 'Rate exceeded'), _answer('ok')]

        converse('Hi', model_id=MODEL, step_name='s')

        assert _lines(logs)[6:16] == [
            "INFO [BEDROCK] Attempt 1/5 for step 's'",
            "INFO [BEDROCK] Calling client.converse() for step 's'...",
            "ERROR [BEDROCK] ClientError for step 's' after 0.00s: ThrottlingException - Rate exceeded",
            "WARNING [BEDROCK] Retryable error ThrottlingException for step 's' (attempt 1/5), retrying in 1.25s",
            "INFO [BEDROCK] Attempt 2/5 for step 's'",
            "INFO [BEDROCK] Calling client.converse() for step 's'...",
            "INFO [BEDROCK] Response received for step 's' in 0.00s",
            "INFO [BEDROCK] Bedrock succeeded after 2 attempts for step 's'",
            'INFO [BEDROCK] Usage: input_tokens=0, output_tokens=0, stop_reason=end_turn',
            "INFO [BEDROCK] Extracted 2 chars from response for step 's' (stop_reason=end_turn)",
        ]
        clock.sleep.assert_called_once_with(1.25)
        jitter.uniform.assert_called_once_with(0, 1)

    def test_service_unavailable_is_retried_not_fallen_back(self, client):
        client.converse.side_effect = [_client_error('ServiceUnavailableException'), _answer('ok')]

        result = converse_detailed('Hi', model_id=MODEL)

        assert [c.kwargs['modelId'] for c in client.converse.call_args_list] == [MODEL, MODEL]
        assert result.model_fallback is False

    def test_a_failed_call_names_the_step_the_error_and_the_time(self, client, logs):
        error = _client_error('AccessDeniedException')
        client.converse.side_effect = error

        with pytest.raises(ClientError):
            converse('Hi', model_id=MODEL, step_name='s')

        lines = _lines(logs)
        assert "ERROR [BEDROCK] Non-retryable error for step 's': AccessDeniedException - nope" in lines
        assert lines[-1] == f"ERROR [BEDROCK] Step 's' FAILED after 0.00s: ClientError: {error}"

    def test_a_client_that_cannot_be_built_is_logged(self, logs):
        with patch.object(converse_module, 'get_bedrock_client', side_effect=RuntimeError('boom')), \
                pytest.raises(RuntimeError):
            converse('Hi', model_id=MODEL)

        assert _lines(logs)[-1] == 'ERROR [BEDROCK] Failed to get Bedrock client'

    def test_the_raise_ceiling_message(self, client, logs):
        client.converse.return_value = _answer('', stop='max_tokens')

        converse('Hi', model_id=MODEL, step_name='doc', max_tokens=64000)

        assert (
            "WARNING [BEDROCK] Step 'doc' produced no visible text at maxTokens=64000, which is "
            "already at/above the raise ceiling (64000); no headroom to retry"
        ) in _lines(logs)

    def test_the_deadline_message(self, client, logs):
        client.converse.return_value = _answer('', stop='max_tokens')

        converse('Hi', model_id=MODEL, step_name='doc', empty_raise_deadline_seconds=-1)

        assert (
            "WARNING [BEDROCK] Step 'doc' produced no visible text but 0s of the invocation is "
            "already spent (deadline -1s); skipping the maxTokens raise to avoid a timeout"
        ) in _lines(logs)

    def test_a_rejected_raise_message(self, client, logs):
        rejection = _client_error('ValidationException', 'too big')
        client.converse.side_effect = [_answer('', stop='max_tokens'), rejection]

        assert converse('Hi', model_id=MODEL, step_name='doc', max_tokens=3000) == ''

        assert (
            f"WARNING [BEDROCK] Step 'doc' rejected maxTokens=6000 (model {MODEL} caps output below "
            f"the raise ceiling): {rejection}; returning the empty result instead of raising"
        ) in _lines(logs)


class TestTheBackoff:
    @pytest.mark.parametrize(('attempt', 'delay'), [(0, 1.25), (1, 2.25), (2, 4.25), (5, 30.0)])
    def test_one_second_doubling_capped_at_thirty(self, jitter, attempt, delay):
        assert converse_module._calculate_backoff(attempt) == delay
        jitter.uniform.assert_called_once_with(0, 1)


@pytest.mark.usefixtures('clock', 'jitter')
class TestTheRetryLoopTranscript:
    def test_the_defaults_name_the_call_and_the_step(self, logs):
        call = MagicMock(return_value={'ok': 1})

        assert converse_module.bedrock_call_with_retry(call) == {'ok': 1}

        assert _lines(logs) == [
            "INFO [BEDROCK] Attempt 1/5 for step 'unknown'",
            "INFO [BEDROCK] Calling the Bedrock call for step 'unknown'...",
            "INFO [BEDROCK] Response received for step 'unknown' in 0.00s",
        ]

    def test_an_unexpected_error_is_retried_then_raised(self, logs):
        call = MagicMock(side_effect=ConnectionError('net'))

        with pytest.raises(ConnectionError):
            converse_module.bedrock_call_with_retry(call, max_retries=2, step_name='s')

        assert [line for line in _lines(logs) if not line.startswith('INFO')] == [
            "ERROR [BEDROCK] Unexpected error for step 's' after 0.00s: ConnectionError: net",
            "WARNING [BEDROCK] Retrying step 's' in 1.25s (attempt 1/2)",
            "ERROR [BEDROCK] Unexpected error for step 's' after 0.00s: ConnectionError: net",
            "ERROR [BEDROCK] Step 's' failed after 2 attempts: net",
        ]

    def test_sustained_throttling_names_the_budget(self, logs):
        throttle = _client_error('ThrottlingException', 'slow')
        call = MagicMock(side_effect=throttle)

        with pytest.raises(converse_module.BedrockThrottlingError) as raised:
            converse_module.bedrock_call_with_retry(call, max_retries=2, step_name='s')

        assert str(raised.value) == "Bedrock throttled after 2 retries for step 's'"
        assert raised.value.__cause__ is throttle
        assert _lines(logs)[-1] == "ERROR [BEDROCK] Step 's' throttled after 2 attempts"

    def test_throttling_without_raising_logs_the_exhaustion(self, logs):
        call = MagicMock(side_effect=_client_error('ThrottlingException'))

        assert converse_module.bedrock_call_with_retry(
            call, max_retries=1, raise_on_throttle=False, step_name='s',
        ) is None

        assert _lines(logs)[-1] == "ERROR [BEDROCK] Step 's' exhausted all retries without success"

    def test_a_zero_budget_says_no_attempt_was_made(self):
        with pytest.raises(converse_module.BedrockThrottlingError) as raised:
            converse_module.bedrock_call_with_retry(MagicMock(), max_retries=0, step_name='s')

        assert str(raised.value) == "Bedrock failed after 0 retries for step 's' (no attempt was made)"

    @pytest.mark.parametrize('error', [
        ClientError({'Error': {'Message': 'm'}}, 'Converse'),
        ClientError({}, 'Converse'),
    ])
    def test_a_client_error_without_a_code_is_not_retried(self, logs, error):
        call = MagicMock(side_effect=error)

        with pytest.raises(ClientError):
            converse_module.bedrock_call_with_retry(call, step_name='s')

        detail = error.response.get('Error', {}).get('Message', str(error))
        assert [line for line in _lines(logs) if line.startswith('ERROR')] == [
            f"ERROR [BEDROCK] ClientError for step 's' after 0.00s:  - {detail}",
            f"ERROR [BEDROCK] Non-retryable error for step 's':  - {detail}",
        ]

    def test_a_read_timeout_explains_itself(self, logs):
        call = MagicMock(side_effect=ReadTimeoutError(endpoint_url='https://bedrock'))

        with pytest.raises(ReadTimeoutError):
            converse_module.bedrock_call_with_retry(call, step_name='s')

        assert _lines(logs)[-1] == (
            "ERROR [BEDROCK] Read timeout for step 's' after 0.00s — not retried: a non-streaming "
            "generation that exceeded the read budget will exceed it again. Reduce max_tokens for "
            "this step or split it."
        )


@pytest.fixture
def flex_client() -> Iterator[MagicMock]:
    bedrock = MagicMock()
    with patch.object(converse_module, 'get_bedrock_client', return_value=bedrock), \
            patch.object(model_config, '_FLEX_IDS', {FLEX_MODEL}):
        yield bedrock


@pytest.fixture
def emitted() -> Iterator[list[dict]]:
    calls: list[dict] = []
    with patch.object(converse_module, 'single_metric', metric_recorder(calls)):
        yield calls


def _tiers(bedrock: MagicMock) -> list[dict]:
    return [c.kwargs['serviceTier'] for c in bedrock.converse.call_args_list]


class TestTheTierRefusal:
    @pytest.mark.parametrize('message', [
        'Invalid SERVICE_TIER value', 'Unsupported serviceTier', 'Flex unavailable here',
    ])
    @pytest.mark.usefixtures('emitted')
    def test_each_keyword_marks_a_refusal(self, flex_client, message):
        flex_client.converse.side_effect = [_client_error('ValidationException', message), _answer('ok')]

        result = converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        assert _tiers(flex_client) == [{'type': 'flex'}, {'type': 'default'}]
        assert result.flex_fallback is True

    def test_an_unrelated_validation_error_on_flex_is_raised(self, flex_client):
        flex_client.converse.side_effect = _client_error('ValidationException', 'messages must be non-empty')

        with pytest.raises(ClientError):
            converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        assert flex_client.converse.call_count == 1

    @pytest.mark.usefixtures('clock')
    def test_a_throttle_on_flex_is_retried_on_flex(self, flex_client):
        flex_client.converse.side_effect = [_client_error('ThrottlingException', 'flex busy'), _answer('ok')]

        result = converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        assert _tiers(flex_client) == [{'type': 'flex'}, {'type': 'flex'}]
        assert result.flex_fallback is False

    def test_the_fallback_is_logged_with_its_surface_and_a_200_char_reason(self, flex_client, emitted, logs):
        message = 'service tier ' + 'x' * 300
        flex_client.converse.side_effect = [_client_error('ValidationException', message), _answer('ok')]

        with patch.object(converse_module, 'metrics', MagicMock(namespace='NS')):
            converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        [record] = [r for r in logs.records if r.levelno == logging.WARNING]
        assert record.getMessage() == '[BEDROCK] Flex service tier refused; retrying on the default tier'
        assert (record.__dict__['surface'], record.__dict__['reason']) == ('memory', message[:200])
        assert emitted == [{
            'name': 'FlexFallback', 'unit': converse_module.MetricUnit.Count, 'value': 1,
            'namespace': 'NS', 'dimensions': {'Surface': 'memory'},
        }]

    def test_the_metric_namespace_falls_back_to_voc(self, flex_client, emitted):
        flex_client.converse.side_effect = [_client_error('ValidationException', 'flex'), _answer('ok')]

        with patch.object(converse_module, 'metrics', MagicMock(namespace=None)):
            converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        assert [e['namespace'] for e in emitted] == ['VoC']

    def test_a_metric_failure_is_logged(self, flex_client, logs):
        flex_client.converse.side_effect = [_client_error('ValidationException', 'flex'), _answer('ok')]

        with patch.object(converse_module, 'single_metric', side_effect=RuntimeError('boom')):
            converse_detailed('Hi', model_id=FLEX_MODEL, surface='memory')

        assert 'WARNING [BEDROCK] Could not emit FlexFallback: boom' in _lines(logs)


class TestTheTierBookkeeping:
    def test_the_reported_tier_wins_over_the_one_sent(self, client):
        client.converse.return_value = _answer('ok', serviceTier={'type': 'flex'})

        result = converse_detailed('Hi', model_id=MODEL, service_tier='default')

        assert result.resolved_tier == 'flex'

    @pytest.mark.parametrize('reported', ['flex', {'type': 5}])
    def test_a_malformed_report_falls_back_to_the_tier_sent(self, client, reported):
        client.converse.return_value = _answer('ok', serviceTier=reported)

        assert converse_detailed('Hi', model_id=MODEL, service_tier='default').resolved_tier == 'default'

    def test_a_model_without_flex_is_sent_default_and_says_so(self, client, logs):
        client.converse.return_value = _answer('ok')

        converse_detailed('Hi', model_id=MODEL, service_tier='flex')

        assert _tiers(client) == [{'type': 'default'}]
        assert (
            f"INFO [BEDROCK] Model {MODEL} does not support the Flex service tier; sending 'default'"
        ) in _lines(logs)

    def test_an_unknown_tier_names_the_allowed_ones(self):
        with pytest.raises(ValueError, match='priority') as raised:
            converse_detailed('Hi', model_id=MODEL, service_tier='priority')

        assert str(raised.value) == f"service_tier must be one of {SERVICE_TIERS} or None, got 'priority'"


@pytest.fixture
def chain_step() -> Iterator[MagicMock]:
    with patch.object(converse_module, 'converse_detailed') as step:
        yield step


@pytest.mark.usefixtures('clock')
class TestTheChain:
    def test_an_empty_step_takes_every_default(self, chain_step):
        chain_step.return_value = ConverseResult(text='out')

        converse_module.converse_chain_detailed([{}])

        chain_step.assert_called_once_with(
            prompt='', system_prompt='', max_tokens=4096, thinking_budget=0,
            surface='default', max_retries=5, step_name='llm_step_1',
        )

    def test_a_steps_own_budget_and_no_previous_text_on_the_first_step(self, chain_step):
        chain_step.return_value = ConverseResult(text='out')

        converse_module.converse_chain_detailed([{'user': 'a{previous}b', 'max_tokens': 1000}])

        assert chain_step.call_args.kwargs['prompt'] == 'ab'
        assert chain_step.call_args.kwargs['max_tokens'] == 1000

    def test_progress_spreads_15_to_75_percent_across_the_steps(self, chain_step):
        chain_step.return_value = ConverseResult(text='out')
        reported: list[int] = []

        converse_module.converse_chain_detailed(
            [{}] * 7, progress_callback=lambda progress, _step: reported.append(progress),
        )

        assert reported == [15, 23, 32, 40, 49, 57, 66]

    def test_the_transcript_of_a_fallen_back_step(self, chain_step, logs):
        chain_step.return_value = ConverseResult(text='out', model_id='b', requested_model_id='a')

        converse_module.converse_chain_detailed(
            [{'step_name': 'one', 'system': 'S', 'user': 'U'}], progress_callback=MagicMock(),
        )

        assert _lines(logs) == [
            'INFO [CHAIN] Starting LLM chain with 1 steps',
            'INFO [CHAIN] ========== STEP 1/1: one ==========',
            "INFO [CHAIN] Reporting progress: 15% for step 'one'",
            "INFO [CHAIN] Progress callback succeeded for step 'one'",
            "INFO [CHAIN] Step 'one' config: max_tokens=4096, thinking_budget=0",
            "INFO [CHAIN] Step 'one' system_prompt length: 1 chars",
            "INFO [CHAIN] Step 'one' user_prompt length: 1 chars",
            "INFO [CHAIN] Step 'one' completed in 0.00s on b (fallback from a), output length: 3 chars",
            'INFO [CHAIN] LLM chain completed: 1 steps in 0.00s',
        ]

    def test_a_step_on_its_own_model_names_no_fallback(self, chain_step, logs):
        chain_step.return_value = ConverseResult(text='out', model_id='a', requested_model_id='a')

        converse_module.converse_chain_detailed([{'step_name': 'one'}])

        assert "INFO [CHAIN] Step 'one' completed in 0.00s on a, output length: 3 chars" in _lines(logs)

    def test_failures_are_logged(self, chain_step, logs):
        chain_step.side_effect = RuntimeError('boom')

        with pytest.raises(RuntimeError):
            converse_module.converse_chain_detailed(
                [{'step_name': 'one'}], progress_callback=MagicMock(side_effect=ValueError('cb')),
            )

        assert [line for line in _lines(logs) if line.startswith('ERROR')] == [
            "ERROR [CHAIN] Progress callback failed for step 'one' (non-fatal)",
            "ERROR [CHAIN] Step 'one' FAILED after 0.00s: RuntimeError: boom",
        ]
