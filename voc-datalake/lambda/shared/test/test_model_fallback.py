"""
Capacity fallback for Bedrock text inference (shared.model_fallback, wired into
shared.converse.converse_detailed / converse_chain_detailed).

Bedrock can grant a model and still give the account zero capacity for it. A
model that cannot serve now must hand the request to the next model of the
surface's chain; a request the model rejects for its own content must not.
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

# lambda/ is on sys.path via lambda/conftest.py.
from shared import model_fallback
from shared.converse import BedrockThrottlingError, converse_chain_detailed, converse_detailed
from shared.model_config import ALLOWED_MODEL_IDS, MODEL_FALLBACK_ORDER, fallback_chain
from shared.test.converse_fixtures import metric_recorder

OPUS55 = 'global.anthropic.claude-opus-5-5'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
SONNET5 = 'global.anthropic.claude-sonnet-5'
SONNET46 = 'global.anthropic.claude-sonnet-4-6'
OPUS5 = 'global.anthropic.claude-opus-5'
OPUS48 = 'global.anthropic.claude-opus-4-8'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'


def _reply(text: str) -> dict:
    return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn'}


def _error(code: str, message: str = 'x') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': message}}, 'Converse')


class _Bedrock:
    """A Bedrock client whose answer depends on the model asked for.

    ``failing`` maps a model id to the ClientError every call to it raises; any
    other model answers ``"from <model>"``.
    """

    def __init__(self, failing: dict[str, ClientError]):
        self.failing = failing
        self.client = MagicMock()
        self.client.converse.side_effect = self._converse

    def _converse(self, **kwargs):
        model = kwargs['modelId']
        if model in self.failing:
            raise self.failing[model]
        return _reply(f'from {model}')

    @property
    def tried(self) -> list[str]:
        return [c.kwargs['modelId'] for c in self.client.converse.call_args_list]


@pytest.fixture
def emitted():
    """Capture ModelFallback metric emissions instead of printing EMF."""
    calls: list[dict] = []
    with patch.object(model_fallback, 'single_metric', metric_recorder(calls)):
        yield calls


@pytest.fixture
def bedrock():
    """Install a model-aware fake client; resolve every surface to Sonnet 5.5."""
    holder: dict = {}

    def install(failing: dict[str, ClientError]) -> _Bedrock:
        fake = _Bedrock(failing)
        holder['fake'] = fake
        return fake

    with patch('shared.converse.get_bedrock_client', side_effect=lambda: holder['fake'].client), \
            patch('shared.converse.get_active_model_id', return_value=SONNET55), \
            patch('shared.converse.time.sleep', MagicMock()):
        yield install


# --- The chain -----------------------------------------------------------------

class TestFallbackChain:
    def test_sonnet55_walks_the_default_order(self):
        assert MODEL_FALLBACK_ORDER == (SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45)
        assert fallback_chain(SONNET55, 'chat') == (SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45)

    def test_pinned_model_goes_first_then_the_surface_default(self):
        # enrichment defaults to Haiku 5.5: pinning Sonnet 4.6 keeps Haiku 5.5 as
        # the first stand-in (the model the app already chose for that workload).
        assert fallback_chain(SONNET46, 'enrichment') == (SONNET46, HAIKU55, SONNET55, SONNET5, HAIKU45)

    def test_opus_only_when_it_is_the_configured_choice(self):
        assert fallback_chain(OPUS55, 'prototype') == (OPUS55, SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45)
        for surface in ('chat', 'documents', 'enrichment', 'utility', 'memory'):
            chain = fallback_chain(SONNET5, surface)
            assert OPUS55 not in chain
            assert OPUS5 not in chain
            assert OPUS48 not in chain

    def test_older_opus_is_never_a_stand_in(self):
        # The previous Opus generations are Bedrock's own safety-fallback targets
        # (Opus 5.5 → 5 → 4.8), never capacity stand-ins in this chain.
        chain = fallback_chain(OPUS55, 'agent_orchestrator')
        assert OPUS5 not in chain
        assert OPUS48 not in chain
        assert OPUS48 not in fallback_chain(OPUS5, 'agent_orchestrator')

    def test_legacy_primary_is_kept_but_every_fallback_is_allowlisted(self):
        chain = fallback_chain('anthropic.claude-legacy-v1', 'unknown-surface')
        assert chain[0] == 'anthropic.claude-legacy-v1'
        assert set(chain[1:]) <= ALLOWED_MODEL_IDS
        assert set(MODEL_FALLBACK_ORDER) <= set(chain)


# --- Classification ------------------------------------------------------------

class TestClassification:
    @pytest.mark.parametrize('code', [
        'ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException',
        'ServiceQuotaExceededException', 'ResourceNotFoundException',
    ])
    def test_capacity_codes_fall_back(self, code):
        assert model_fallback.is_model_unavailable(_error(code))

    @pytest.mark.parametrize(('code', 'message'), [
        ('AccessDeniedException', "You don't have access to the model with the specified model ID."),
        ('AccessDeniedException', 'User: arn:aws:sts::1:assumed-role/r is not authorized to perform: '
                                  'bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:x'),
        ('ValidationException', "Invocation of model ID anthropic.claude-x with on-demand throughput "
                                "isn't supported. Retry your request with an inference profile."),
        ('ValidationException', 'The provided model identifier is invalid.'),
        ('ValidationException', 'This model version has reached the end of its life.'),
        ('ValidationException', 'The model is not enabled for this account.'),
    ])
    def test_model_availability_messages_fall_back(self, code, message):
        assert model_fallback.is_model_unavailable(_error(code, message))

    @pytest.mark.parametrize(('code', 'message'), [
        ('ValidationException', 'Input is too long for requested model.'),
        ('ValidationException', 'messages: text content blocks must be non-empty'),
        ('ValidationException', 'temperature: Extra inputs are not permitted'),
        ('AccessDeniedException', 'Request blocked by guardrail'),
        ('ModelErrorException', 'The model failed to process the request'),
        ('ModelStreamErrorException', 'stream broke'),
    ])
    def test_input_errors_do_not_fall_back(self, code, message):
        assert not model_fallback.is_model_unavailable(_error(code, message))

    def test_exhausted_throttle_is_recognised_through_its_cause(self):
        wrapped = BedrockThrottlingError('throttled after 5 retries')
        wrapped.__cause__ = _error('ThrottlingException')
        assert model_fallback.is_model_unavailable(wrapped)

    def test_exhausted_non_capacity_retry_is_not_a_fallback(self):
        wrapped = BedrockThrottlingError('failed after 5 retries')
        wrapped.__cause__ = _error('ModelStreamErrorException')
        assert not model_fallback.is_model_unavailable(wrapped)

    def test_non_bedrock_errors_do_not_fall_back(self):
        assert not model_fallback.is_model_unavailable(RuntimeError('boom'))


# --- converse_detailed ---------------------------------------------------------

class TestConverseDetailedFallback:
    def test_throttled_first_model_falls_back_and_reports_the_fallback_model(self, bedrock, emitted):
        fake = bedrock({SONNET55: _error('ThrottlingException', 'Too many requests')})
        result = converse_detailed('hi', surface='chat', max_retries=3)
        # The full retry budget is spent on the first model before falling back.
        assert fake.tried == [SONNET55, SONNET55, SONNET55, SONNET5]
        assert result.text == f'from {SONNET5}'
        assert result.model_id == SONNET5
        assert result.requested_model_id == SONNET55
        assert result.model_fallback is True
        assert emitted == [{
            'name': 'ModelFallback', 'unit': model_fallback.MetricUnit.Count, 'value': 1,
            'namespace': emitted[0]['namespace'],
            'dimensions': {'Surface': 'chat', 'From': SONNET55, 'To': SONNET5},
        }]

    def test_no_fallback_when_the_first_model_answers(self, bedrock, emitted):
        fake = bedrock({})
        result = converse_detailed('hi', surface='chat')
        assert fake.tried == [SONNET55]
        assert result.model_id == SONNET55
        assert result.model_fallback is False
        assert emitted == []

    def test_unavailable_model_falls_back_without_retrying(self, bedrock):
        fake = bedrock({SONNET55: _error('AccessDeniedException', "You don't have access to the model")})
        result = converse_detailed('hi', surface='chat', max_retries=5)
        assert fake.tried == [SONNET55, SONNET5]
        assert result.model_id == SONNET5

    def test_input_error_does_not_fall_back(self, bedrock, emitted):
        fake = bedrock({SONNET55: _error('ValidationException', 'Input is too long for requested model.')})
        with pytest.raises(ClientError) as raised:
            converse_detailed('hi', surface='chat')
        assert raised.value.response.get('Error', {}).get('Code') == 'ValidationException'
        assert fake.tried == [SONNET55]
        assert emitted == []
        assert not model_fallback.is_cooling_down(SONNET55)

    def test_explicit_model_id_also_falls_back(self, bedrock):
        fake = bedrock({HAIKU45: _error('ServiceUnavailableException')})
        result = converse_detailed('hi', surface='enrichment', model_id=HAIKU45, max_retries=1)
        # The enrichment default (Haiku 5.5) is the first stand-in.
        assert fake.tried == [HAIKU45, HAIKU55]
        assert result.requested_model_id == HAIKU45
        assert result.model_id == HAIKU55

    def test_cooldown_skips_the_bad_model_on_the_next_call(self, bedrock, emitted):
        fake = bedrock({SONNET55: _error('ModelNotReadyException')})
        converse_detailed('first', surface='chat')
        assert model_fallback.is_cooling_down(SONNET55)
        fake.client.converse.reset_mock()
        result = converse_detailed('second', surface='chat')
        assert fake.tried == [SONNET5]
        assert result.model_id == SONNET5
        assert result.requested_model_id == SONNET55
        # The skip is still a fallback and is counted as one.
        assert emitted[-1]['dimensions'] == {'Surface': 'chat', 'From': SONNET55, 'To': SONNET5}

    def test_cooldown_expires(self, bedrock):
        fake = bedrock({SONNET55: _error('ModelNotReadyException')})
        with patch('shared.model_fallback.time.time', return_value=1_000.0):
            converse_detailed('first', surface='chat')
        fake.failing.clear()  # capacity is back
        fake.client.converse.reset_mock()
        later = 1_000.0 + model_fallback.COOLDOWN_SECONDS + 1
        with patch('shared.model_fallback.time.time', return_value=later):
            result = converse_detailed('second', surface='chat')
        assert fake.tried == [SONNET55]
        assert result.model_fallback is False

    def test_all_models_failing_raises_the_original_error(self, bedrock):
        fake = bedrock({
            model: _error('ServiceQuotaExceededException', f'no quota for {model}')
            for model in fallback_chain(SONNET55, 'chat')
        })
        with pytest.raises(ClientError) as raised:
            converse_detailed('hi', surface='chat')
        assert raised.value.response.get('Error', {}).get('Message') == f'no quota for {SONNET55}'
        assert fake.tried == list(fallback_chain(SONNET55, 'chat'))

    def test_all_cooling_models_are_still_tried(self, bedrock):
        for model in fallback_chain(SONNET55, 'chat'):
            model_fallback.mark_unavailable(model)
        fake = bedrock({})
        result = converse_detailed('hi', surface='chat')
        assert fake.tried == [SONNET55]
        assert result.model_id == SONNET55

    def test_fallback_model_gets_its_own_request_shape(self, bedrock):
        """Sonnet 4.6 accepts temperature, Sonnet 5 does not — the re-run is
        rebuilt for the model it goes to, not replayed."""
        fake = bedrock({
            SONNET55: _error('ThrottlingException'), SONNET5: _error('ThrottlingException'),
        })
        converse_detailed('hi', surface='chat', max_retries=1, temperature=0.3)
        configs = {c.kwargs['modelId']: c.kwargs['inferenceConfig'] for c in fake.client.converse.call_args_list}
        assert 'temperature' not in configs[SONNET5]
        assert configs[SONNET46]['temperature'] == 0.3


class TestConverseChainFallback:
    def test_each_step_reports_the_model_that_ran(self, bedrock):
        fake = bedrock({SONNET55: _error('ThrottlingException')})
        steps = [
            {'step_name': 'one', 'user': 'first'},
            {'step_name': 'two', 'user': 'second {previous}'},
        ]
        results = converse_chain_detailed(steps, max_retries=2, surface='chat')
        assert [r.model_id for r in results] == [SONNET5, SONNET5]
        assert [r.requested_model_id for r in results] == [SONNET55, SONNET55]
        # Step two skipped the cooling Sonnet 5.5 instead of paying its retries again.
        assert fake.tried == [SONNET55, SONNET55, SONNET5, SONNET5]
        assert fake.client.converse.call_args_list[-1].kwargs['messages'][0]['content'][0]['text'] == (
            f'second from {SONNET5}'
        )

    def test_input_error_in_a_step_fails_the_chain(self, bedrock):
        fake = bedrock({SONNET55: _error('ValidationException', 'Input is too long for requested model.')})
        with pytest.raises(ClientError):
            converse_chain_detailed([{'step_name': 'one', 'user': 'x'}], surface='chat')
        assert fake.tried == [SONNET55]
