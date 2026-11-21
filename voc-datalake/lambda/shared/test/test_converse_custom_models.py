"""A request to one of the deployment's own models (7.65.00): its capability flags shape what goes on the wire.

shared/converse.py and shared/custom_models.py: no ``thinking`` field ever, ``temperature`` only when the model takes
one, ``maxTokens`` capped at its ``maxOutputTokens``, the JSON instruction after the system prompt when it returns
JSON, and no document or image block to a model that reads none (that request goes to the surface's default).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from shared.converse import build_blocks_request, converse_blocks, converse_detailed
from shared.custom_models import CUSTOM_MODELS_ENV, JSON_INSTRUCTION
from shared.model_config import SURFACE_DEFAULTS, clear_model_cache
from shared.test.repo_paths import repo_root

REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
NOVA = 'amazon.nova-pro-v1:0'          # documents and images, JSON, temperature, 10,000 output tokens
LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0'   # no documents
MINE = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'   # no temperature, 2,048 output tokens
SONNET46 = 'global.anthropic.claude-sonnet-4-6'
PDF = {'document': {'format': 'pdf', 'name': 'brief', 'source': {'bytes': b'%PDF'}, 'citations': {'enabled': True}}}


@pytest.fixture(autouse=True)
def _registry(monkeypatch):
    monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)
    monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
    clear_model_cache()


def _reply(text: str = '{"ok": true}') -> dict:
    return {'output': {'message': {'content': [{'text': text}]}}, 'stopReason': 'end_turn',
            'usage': {'inputTokens': 1, 'outputTokens': 1}}


@pytest.fixture
def client():
    bedrock = MagicMock()
    bedrock.converse.return_value = _reply()
    with patch('shared.converse.get_bedrock_client', return_value=bedrock):
        yield bedrock


class TestTheRequest:
    def test_caps_max_tokens_and_adds_the_json_instruction(self):
        kwargs = build_blocks_request(MINE, messages=[], system_prompt='Rules.', max_tokens=16_000, temperature=0.2)
        assert kwargs['inferenceConfig'] == {'maxTokens': 2_048}
        assert kwargs['system'] == [{'text': f'Rules.\n\n{JSON_INSTRUCTION}'}]
        assert kwargs['modelId'] == MINE

    def test_the_json_instruction_alone_without_a_system_prompt_and_a_temperature_where_taken(self):
        kwargs = build_blocks_request(NOVA, messages=[], system_prompt='', max_tokens=100, temperature=0.2)
        assert kwargs['system'] == [{'text': JSON_INSTRUCTION}]
        assert kwargs['inferenceConfig'] == {'maxTokens': 100, 'temperature': 0.2}

    def test_a_claude_request_is_unchanged(self):
        kwargs = build_blocks_request(SONNET46, messages=[], system_prompt='', max_tokens=50_000, temperature=0.2)
        assert 'system' not in kwargs
        assert kwargs['inferenceConfig'] == {'maxTokens': 50_000, 'temperature': 0.2}

    def test_never_a_thinking_budget(self, client):
        converse_detailed(prompt='p', system_prompt='s', max_tokens=500, thinking_budget=4_000, model_id=NOVA,
                          surface='documents', step_name='t')
        sent = client.converse.call_args.kwargs
        assert 'additionalModelRequestFields' not in sent
        assert sent['inferenceConfig'] == {'maxTokens': 500, 'temperature': 0.1}

    def test_no_service_tier_even_where_the_surface_asks_for_flex(self, client):
        converse_detailed(prompt='p', max_tokens=100, model_id=MINE, surface='memory', step_name='t')
        assert 'serviceTier' not in client.converse.call_args.kwargs

    def test_a_claude_model_still_takes_its_budget(self, client):
        converse_detailed(prompt='p', max_tokens=500, thinking_budget=4_000, model_id=SONNET46, step_name='t')
        assert client.converse.call_args.kwargs['additionalModelRequestFields'] == {
            'thinking': {'type': 'enabled', 'budget_tokens': 4_000}}


class TestDocumentBlocks:
    def test_a_model_that_reads_documents_gets_a_plain_document(self):
        bedrock = MagicMock(converse=MagicMock(return_value=_reply()))
        plain = {'document': {k: v for k, v in PDF['document'].items() if k != 'citations'}}
        converse_blocks(bedrock, [plain, {'text': 'Read it.'}], surface='documents', system_prompt='', max_tokens=100,
                        step_name='t', model_id=NOVA, max_retries=1)
        assert [bedrock.converse.call_args.kwargs['modelId'], bedrock.converse.call_args.kwargs['messages'][0]['content'][0]] == [
            NOVA, plain]

    def test_a_pdf_read_with_its_pages_goes_to_the_surface_s_claude_with_its_citations(self):
        # (a scanned PDF's transcription: a custom model would get the text layer alone, and a scanned page has none)
        bedrock = MagicMock(converse=MagicMock(return_value=_reply()))
        converse_blocks(bedrock, [PDF, {'text': 'Read it.'}], surface='documents', system_prompt='', max_tokens=100,
                        step_name='t', model_id=NOVA, max_retries=1)
        sent = bedrock.converse.call_args.kwargs
        assert [sent['modelId'], sent['messages'][0]['content'][0]] == [SURFACE_DEFAULTS['documents'], PDF]

    def test_a_model_that_reads_none_leaves_them_to_the_surface_default(self):
        bedrock = MagicMock(converse=MagicMock(return_value=_reply()))
        converse_blocks(bedrock, [PDF, {'text': 'Read it.'}], surface='enrichment', system_prompt='', max_tokens=100,
                        step_name='t', model_id=LLAMA, max_retries=1)
        sent = bedrock.converse.call_args.kwargs
        assert sent['modelId'] == SURFACE_DEFAULTS['enrichment']
        assert sent['messages'][0]['content'][0] == PDF   # Claude keeps its citations

    def test_a_text_only_turn_stays_on_the_custom_model(self):
        bedrock = MagicMock(converse=MagicMock(return_value=_reply()))
        converse_blocks(bedrock, [{'text': 'Summarise.'}], surface='enrichment', system_prompt='', max_tokens=100,
                        step_name='t', model_id=LLAMA, max_retries=1)
        assert bedrock.converse.call_args.kwargs['modelId'] == LLAMA
