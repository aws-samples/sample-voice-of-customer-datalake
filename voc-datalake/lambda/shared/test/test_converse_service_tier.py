"""
Tests for the Bedrock service-tier support in shared.converse (Flex + recorded
fallback). Flex support is per model (``supports_flex`` on the allowlist rows;
no allowlisted Claude model has it per the Bedrock model cards), so a model
without it is sent 'default' up front. A model WITH it gets Flex, and if Bedrock
refuses anyway the call is re-sent exactly once on the default tier, the
FlexFallback metric is emitted, and the refusal is logged once at WARNING —
never at ERROR.
"""
import logging
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

# lambda/ is on sys.path via lambda/conftest.py.
from shared import converse as converse_module
from shared import model_config
from shared.converse import ConverseResult, bedrock_call_with_retry, converse, converse_detailed
from shared.model_config import (
    PICKER_SURFACES,
    SERVICE_TIERS,
    SURFACE_SERVICE_TIERS,
    surface_service_tier,
)
from shared.test.converse_fixtures import metric_recorder

_HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
# Stand-in for a model whose card lists Flex: none of the allowlisted Claude
# models does, so the Flex-capable path is exercised by marking this id capable.
_FLEX_CAPABLE = 'test.flex-capable-model-v1:0'
_REFUSAL = 'The provided service tier is not supported for this model'


def _reply(text: str, tier: str | None = None, stop: str = 'end_turn') -> dict:
    response = {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': stop}
    if tier:
        response['serviceTier'] = {'type': tier}
    return response


def _validation(message: str) -> ClientError:
    return ClientError({'Error': {'Code': 'ValidationException', 'Message': message}}, 'Converse')


@pytest.fixture
def client():
    mock_client = MagicMock()
    with patch('shared.converse.get_bedrock_client', return_value=mock_client), \
            patch('shared.converse.get_active_model_id', return_value=_HAIKU):
        yield mock_client


@pytest.fixture
def flex_client():
    """Bedrock client stub with the call resolving to a Flex-capable model."""
    mock_client = MagicMock()
    with patch('shared.converse.get_bedrock_client', return_value=mock_client), \
            patch('shared.converse.get_active_model_id', return_value=_FLEX_CAPABLE), \
            patch.object(model_config, '_FLEX_IDS', {_FLEX_CAPABLE}):
        yield mock_client


@pytest.fixture
def converse_logs(caplog):
    """Every record shared.converse logs (powertools logger propagates)."""
    caplog.set_level(logging.DEBUG, logger=converse_module.logger.name)
    return caplog


@pytest.fixture
def emitted():
    """Capture FlexFallback emissions instead of printing EMF."""
    calls: list[dict] = []
    with patch.object(converse_module, 'single_metric', metric_recorder(calls)):
        yield calls


class TestSurfaceTiers:
    def test_memory_surface_requests_flex(self):
        assert surface_service_tier('memory') == 'flex'

    def test_interactive_surfaces_send_no_tier(self):
        for surface in ('chat', 'documents', 'prototype', 'agent_orchestrator'):
            assert surface_service_tier(surface) is None

    def test_tier_table_only_names_known_surfaces_and_tiers(self):
        for surface, tier in SURFACE_SERVICE_TIERS.items():
            assert surface in PICKER_SURFACES
            assert tier in SERVICE_TIERS


class TestServiceTier:
    def test_no_tier_sent_by_default(self, client):
        client.converse.return_value = _reply('ok')
        result = converse_detailed('hi', surface='documents')
        assert 'serviceTier' not in client.converse.call_args.kwargs
        assert result == ConverseResult(text='ok', requested_tier=None, resolved_tier=None, flex_fallback=False,
                                        model_id=_HAIKU, requested_model_id=_HAIKU)

    def test_surface_default_flex_is_sent_and_resolved(self, flex_client):
        flex_client.converse.return_value = _reply('ok', tier='flex')
        result = converse_detailed('hi', surface='memory')
        assert flex_client.converse.call_args.kwargs['serviceTier'] == {'type': 'flex'}
        assert result.requested_tier == 'flex'
        assert result.resolved_tier == 'flex'
        assert result.flex_fallback is False

    def test_explicit_tier_overrides_surface_default(self, client):
        client.converse.return_value = _reply('ok')
        result = converse_detailed('hi', surface='memory', service_tier='default')
        assert client.converse.call_args.kwargs['serviceTier'] == {'type': 'default'}
        # No tier in the response → what was sent.
        assert result.resolved_tier == 'default'

    def test_flex_refusal_falls_back_once_and_is_recorded(self, flex_client, emitted):
        flex_client.converse.side_effect = [
            _validation('The provided service tier is not supported for this model'),
            _reply('ok', tier='default'),
        ]
        result = converse_detailed('hi', surface='memory')
        assert flex_client.converse.call_count == 2
        assert flex_client.converse.call_args_list[0].kwargs['serviceTier'] == {'type': 'flex'}
        assert flex_client.converse.call_args_list[1].kwargs['serviceTier'] == {'type': 'default'}
        assert result == ConverseResult(text='ok', requested_tier='flex', resolved_tier='default', flex_fallback=True,
                                        model_id=_FLEX_CAPABLE, requested_model_id=_FLEX_CAPABLE)
        assert len(emitted) == 1
        assert emitted[0]['name'] == 'FlexFallback'
        assert emitted[0]['dimensions'] == {'Surface': 'memory'}

    def test_unrelated_validation_error_is_not_swallowed(self, client, emitted):
        client.converse.side_effect = _validation('messages: text content blocks must be non-empty')
        with pytest.raises(ClientError):
            converse_detailed('hi', surface='memory')
        assert client.converse.call_count == 1
        assert emitted == []

    def test_refusal_on_default_tier_is_not_retried(self, client):
        client.converse.side_effect = _validation('service tier default is unavailable')
        with pytest.raises(ClientError):
            converse_detailed('hi', surface='documents', service_tier='default')
        assert client.converse.call_count == 1

    def test_continuations_stay_on_the_fallback_tier(self, flex_client, emitted):
        flex_client.converse.side_effect = [
            _validation('serviceTier flex not supported'),
            _reply('part one ', stop='max_tokens'),
            _reply('part two'),
        ]
        result = converse_detailed('hi', surface='memory')
        assert result.text == 'part one part two'
        tiers = [c.kwargs['serviceTier'] for c in flex_client.converse.call_args_list]
        assert tiers == [{'type': 'flex'}, {'type': 'default'}, {'type': 'default'}]
        assert len(emitted) == 1

    def test_metric_failure_never_breaks_inference(self, flex_client):
        flex_client.converse.side_effect = [_validation('service tier not supported'), _reply('ok')]
        with patch.object(converse_module, 'single_metric', side_effect=RuntimeError('boom')):
            assert converse_detailed('hi', surface='memory').flex_fallback is True

    def test_unknown_tier_is_rejected(self, client):
        with pytest.raises(ValueError, match=r"service_tier must be one of .* got 'priority'"):
            converse_detailed('hi', service_tier='priority')
        client.converse.assert_not_called()

    def test_converse_returns_text_only(self, client):
        client.converse.return_value = _reply('just text', tier='flex')
        assert converse('hi', surface='memory') == 'just text'


class TestFlexCapability:
    """Flex goes on the wire only for a model whose Bedrock card lists it."""

    def test_no_allowlisted_model_supports_flex(self):
        # Every Claude model card on Bedrock lists Flex as unsupported
        # (checked 2026-10-06). Flip a row only from its model card.
        assert [m['key'] for m in model_config.ALLOWED_MODELS if model_config.supports_flex(m['id'])] == []
        assert model_config.supports_flex('some.unknown-model') is False

    def test_haiku45_memory_call_carries_no_flex_tier(self, client, emitted, converse_logs):
        """The production bug: Haiku 4.5 refused Flex on every memory call.
        It must be sent 'default' once — no refused round trip, no fallback."""
        client.converse.return_value = _reply('ok', tier='default')
        result = converse_detailed('hi', surface='memory')
        assert client.converse.call_count == 1
        assert client.converse.call_args.kwargs['serviceTier'] == {'type': 'default'}
        assert result == ConverseResult(text='ok', requested_tier='flex', resolved_tier='default', flex_fallback=False,
                                        model_id=_HAIKU, requested_model_id=_HAIKU)
        assert emitted == []
        assert [r for r in converse_logs.records if r.levelno >= logging.WARNING] == []

    def test_explicit_flex_on_haiku45_is_also_downgraded(self, client):
        """memory_store passes service_tier='flex' explicitly, not via the surface."""
        client.converse.return_value = _reply('ok')
        converse_detailed('hi', surface='memory', service_tier='flex', model_id=_HAIKU)
        assert client.converse.call_args.kwargs['serviceTier'] == {'type': 'default'}

    def test_flex_capable_model_still_gets_flex(self, flex_client):
        flex_client.converse.return_value = _reply('ok', tier='flex')
        result = converse_detailed('hi', surface='memory')
        assert flex_client.converse.call_count == 1
        assert flex_client.converse.call_args.kwargs['serviceTier'] == {'type': 'flex'}
        assert (result.requested_tier, result.resolved_tier, result.flex_fallback) == ('flex', 'flex', False)


class TestFlexRefusalLogging:
    def test_refusal_logs_one_warning_and_no_error_then_returns_default_tier_result(
        self, flex_client, emitted, converse_logs,
    ):
        flex_client.converse.side_effect = [_validation(_REFUSAL), _reply('served on default', tier='default')]
        result = converse_detailed('hi', surface='memory')

        assert result.text == 'served on default'
        assert (result.resolved_tier, result.flex_fallback) == ('default', True)
        assert [c.kwargs['serviceTier'] for c in flex_client.converse.call_args_list] == [
            {'type': 'flex'}, {'type': 'default'},
        ]
        errors = [r.getMessage() for r in converse_logs.records if r.levelno >= logging.ERROR]
        warnings = [r.getMessage() for r in converse_logs.records if r.levelno == logging.WARNING]
        assert errors == []
        assert warnings == ['[BEDROCK] Flex service tier refused; retrying on the default tier']
        assert [m['name'] for m in emitted] == ['FlexFallback']

    def test_expected_error_is_reraised_unretried_without_error_logs(self, converse_logs):
        refusal = _validation(_REFUSAL)
        call = MagicMock(side_effect=refusal)
        with pytest.raises(ClientError) as raised:
            bedrock_call_with_retry(call, max_retries=3, step_name='t', is_expected_error=lambda e: e is refusal)
        assert raised.value is refusal
        assert call.call_count == 1
        assert [r for r in converse_logs.records if r.levelno >= logging.WARNING] == []

    def test_unexpected_error_still_logs_at_error(self, converse_logs):
        call = MagicMock(side_effect=_validation('messages: text content blocks must be non-empty'))
        with pytest.raises(ClientError):
            bedrock_call_with_retry(call, max_retries=3, step_name='t', is_expected_error=lambda _error: False)
        assert any(r.levelno == logging.ERROR for r in converse_logs.records)
