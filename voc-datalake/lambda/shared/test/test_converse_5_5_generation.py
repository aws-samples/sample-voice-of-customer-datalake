"""Opus 5.5 and Haiku 5.5 on the wire (3.07.00 model move).

Probed on Bedrock (us-east-1 + eu-central-1): both reject ``temperature``
("deprecated for this model"), reject an explicit ``thinking`` budget (adaptive
thinking only) and refuse the Flex service tier. converse() must therefore send
neither field and never put Flex on the wire for them — including on the
memory surface, which asks for Flex and now defaults to Haiku 5.5.
"""
from unittest.mock import MagicMock, patch

import pytest

from shared import model_config
from shared.converse import converse_detailed

OPUS55 = 'global.anthropic.claude-opus-5-5'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'


def _reply(text: str = 'ok') -> dict:
    return {
        'output': {'message': {'content': [{'text': text}]}},
        'stopReason': 'end_turn',
        'serviceTier': {'type': 'default'},
    }


@pytest.fixture(autouse=True)
def _fresh_cache():
    model_config.clear_model_cache()
    yield
    model_config.clear_model_cache()


@pytest.fixture
def client():
    mock_client = MagicMock()
    mock_client.converse.return_value = _reply()
    with patch('shared.converse.get_bedrock_client', return_value=mock_client):
        yield mock_client


@pytest.mark.parametrize('model_id', [OPUS55, HAIKU55])
class TestRequestShape:
    def test_temperature_is_never_sent(self, client, model_id):
        converse_detailed('hi', model_id=model_id, temperature=0.3)
        kwargs = client.converse.call_args.kwargs
        assert kwargs['modelId'] == model_id
        assert 'temperature' not in kwargs['inferenceConfig']

    def test_an_explicit_thinking_budget_is_never_sent(self, client, model_id):
        converse_detailed('hi', model_id=model_id, thinking_budget=4000, temperature=None)
        kwargs = client.converse.call_args.kwargs
        assert 'thinking' not in kwargs.get('additionalModelRequestFields', {})
        assert 'temperature' not in kwargs['inferenceConfig']

    def test_flex_is_downgraded_to_default(self, client, model_id):
        result = converse_detailed('hi', model_id=model_id, service_tier='flex')
        assert client.converse.call_count == 1
        assert client.converse.call_args.kwargs['serviceTier'] == {'type': 'default'}
        assert (result.requested_tier, result.resolved_tier, result.flex_fallback) == ('flex', 'default', False)


class TestPositiveControl:
    """Haiku 4.5 still takes both fields, so the absence checks above observe
    the real wire keys rather than passing vacuously."""

    def test_haiku45_still_carries_temperature_and_a_thinking_budget(self, client):
        converse_detailed('hi', model_id=HAIKU45, temperature=0.3)
        assert client.converse.call_args.kwargs['inferenceConfig']['temperature'] == 0.3
        converse_detailed('hi', model_id=HAIKU45, thinking_budget=4000, temperature=None)
        fields = client.converse.call_args.kwargs['additionalModelRequestFields']
        assert fields['thinking'] == {'type': 'enabled', 'budget_tokens': 4000}


class TestMemorySurfaceOnHaiku55:
    def test_the_unpinned_memory_surface_runs_haiku55_on_the_default_tier(self, client, monkeypatch):
        """No AGGREGATES_TABLE → the built-in default. Memory asks for Flex; Haiku
        5.5 cannot serve it, so exactly one call goes out on 'default'."""
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        result = converse_detailed('hi', surface='memory')
        assert client.converse.call_count == 1
        kwargs = client.converse.call_args.kwargs
        assert kwargs['modelId'] == HAIKU55
        assert kwargs['serviceTier'] == {'type': 'default'}
        assert 'temperature' not in kwargs['inferenceConfig']
        assert result.model_id == HAIKU55
        assert (result.requested_tier, result.resolved_tier, result.flex_fallback) == ('flex', 'default', False)
