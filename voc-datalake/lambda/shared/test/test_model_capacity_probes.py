"""The Settings model test's probes (7.65.00, shared/model_capacity.py ``probe_model(model_id, probe)``).

``basic`` is the request it always was; ``json`` asks for the object ``{"ok": true}`` and ``tools`` offers one tool
and asks for its call; an answer that is not what the probe asked for is ``probe_failed``. A custom model
(shared/custom_models.py) is probed like a Claude one, its request shaped by its capabilities, with no Anthropic
quota looked up. The stubbed clients: model_capacity_fixtures.py.
"""
from __future__ import annotations

import pytest
from botocore.stub import ANY

from shared import model_capacity
from shared.custom_models import CUSTOM_MODELS_ENV, JSON_INSTRUCTION
from shared.model_config import clear_model_cache
from shared.test.model_capacity_fixtures import GLOBAL, OK_RESPONSE, OPUS55, quota_entry, stubbed_world
from shared.test.repo_paths import repo_root

REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
NOVA = 'amazon.nova-pro-v1:0'
LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0'  # (chat, agent_worker, enrichment: the fixture registry's chat model)
MINE = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)
    clear_model_cache()
    with stubbed_world(monkeypatch) as created:
        yield created


def _answer(*content: dict) -> dict:
    return {**OK_RESPONSE, 'output': {'message': {'role': 'assistant', 'content': list(content)}}}


def _expected(model_id: str, prompt: str, *, max_tokens: int, system: str | None = None, **extra: object) -> dict:
    inference: dict = {'maxTokens': max_tokens}
    request: dict = {'modelId': model_id, 'messages': [{'role': 'user', 'content': [{'text': prompt}]}],
                     'inferenceConfig': inference, **extra}
    if system is not None:
        request['system'] = [{'text': system}]
    return request


class TestJsonProbe:
    @pytest.mark.parametrize('text', ['{"ok": true}', 'Sure:\n```json\n{"ok": true}\n```'])
    def test_passes_on_the_object_as_the_app_reads_it(self, world, text):
        world.bedrock_stub.add_response('converse', _answer({'text': text}), _expected(
            NOVA, model_capacity.JSON_PROBE_PROMPT, max_tokens=model_capacity.CHECK_PROBE_MAX_TOKENS,
            system=JSON_INSTRUCTION) | {'inferenceConfig': {'maxTokens': 512, 'temperature': ANY}})
        result = model_capacity.probe_model(NOVA, 'json')
        assert (result['status'], result['ok'], result.get('probe'), result['quota']) == ('available', True, 'json', None)

    @pytest.mark.parametrize('text', ['OK', '{"ok": false}', '["ok"]', '{"ok": tr'])
    def test_fails_on_anything_else_with_its_latency(self, world, text):
        world.bedrock_stub.add_response('converse', _answer({'text': text}), None)
        result = model_capacity.probe_model(NOVA, 'json')
        assert (result['status'], result['ok']) == ('probe_failed', False)
        assert result['latency_ms'] is not None
        assert result['message'] == model_capacity.STATUS_MESSAGES['probe_failed']

    def test_a_claude_model_takes_the_json_probe_with_its_quota(self, world):
        world.bedrock_stub.add_response('converse', _answer({'text': '{"ok": true}'}), _expected(
            OPUS55, model_capacity.JSON_PROBE_PROMPT, max_tokens=model_capacity.CHECK_PROBE_MAX_TOKENS))
        world.list_quotas([quota_entry(GLOBAL + 'Claude Opus 5.5', 5000)])
        result = model_capacity.probe_model(OPUS55, 'json')
        assert (result['status'], result['quota']) == ('available', {'name': GLOBAL + 'Claude Opus 5.5', 'tokens_per_minute': 5000})


class TestToolsProbe:
    def test_passes_when_the_model_calls_the_tool_capped_at_its_output(self, world):
        tool_call = {'toolUse': {'toolUseId': 't1', 'name': model_capacity.TOOLS_PROBE_TOOL, 'input': {'ok': True}}}
        world.bedrock_stub.add_response('converse', _answer(tool_call), _expected(
            MINE, model_capacity.TOOLS_PROBE_PROMPT, max_tokens=512, system=JSON_INSTRUCTION,
            toolConfig=model_capacity._PROBE_TOOL_CONFIG))
        result = model_capacity.probe_model(MINE, 'tools')
        assert (result['status'], result.get('probe'), result['invoked_id']) == ('available', 'tools', MINE)

    def test_fails_on_a_text_answer_or_another_tool(self, world):
        world.bedrock_stub.add_response('converse', _answer({'text': 'I would call it.'}), None)
        world.bedrock_stub.add_response('converse', _answer(
            {'toolUse': {'toolUseId': 't1', 'name': 'other', 'input': {}}}), None)
        assert [model_capacity.probe_model(MINE, 'tools')['status'] for _ in range(2)] == ['probe_failed'] * 2


class TestTheStreamedToolsProbe:
    """A model that may serve chat (every Claude, a custom model declaring it) is checked the way the assistant sends
    tools, through ConverseStream: a model can take tools on Converse yet not on ConverseStream (7.65.00)."""

    @staticmethod
    def _streaming(monkeypatch, events: list[dict]) -> list[dict]:
        sent: list[dict] = []

        class _Client:
            def converse_stream(self, **kwargs):
                sent.append(kwargs)
                return {'stream': iter(events)}

        monkeypatch.setattr(model_capacity, '_bedrock_probe_client', _Client)
        return sent

    @pytest.mark.usefixtures('world')
    @pytest.mark.parametrize('model_id', [LLAMA, OPUS55])
    def test_a_chat_model_streams_the_tools_check(self, monkeypatch, model_id):
        sent = self._streaming(monkeypatch, [
            {'messageStart': {'role': 'assistant'}},
            {'contentBlockStart': {'start': {'toolUse': {'toolUseId': 't1', 'name': model_capacity.TOOLS_PROBE_TOOL}}}},
            {'messageStop': {'stopReason': 'tool_use'}}])
        result = model_capacity.probe_model(model_id, 'tools')
        assert [result['status'], sent[0]['toolConfig']] == ['available', model_capacity._PROBE_TOOL_CONFIG]

    @pytest.mark.usefixtures('world')
    def test_a_streamed_text_answer_fails_it(self, monkeypatch):
        self._streaming(monkeypatch, [{'contentBlockDelta': {'delta': {'text': 'I would call it.'}}}])
        assert model_capacity.probe_model(LLAMA, 'tools')['status'] == 'probe_failed'


class TestBasicProbe:
    def test_a_custom_model_answers_the_basic_probe_with_no_anthropic_quota(self, world):
        world.bedrock_stub.add_response('converse', OK_RESPONSE, _expected(
            MINE, model_capacity.PROBE_PROMPT, max_tokens=model_capacity.PROBE_MAX_TOKENS, system=JSON_INSTRUCTION))
        result = model_capacity.probe_model(MINE)
        assert (result['status'], result.get('probe'), result['quota']) == ('available', 'basic', None)

    def test_a_failing_custom_model_is_classified_like_any_other(self, world):
        world.converse_error('ModelNotReadyException', 'warming up')
        assert model_capacity.probe_model(MINE)['status'] == 'not_ready'

    @pytest.mark.usefixtures('world')
    def test_a_custom_model_has_no_quota_name(self):
        assert model_capacity.quota_name(NOVA) is None
