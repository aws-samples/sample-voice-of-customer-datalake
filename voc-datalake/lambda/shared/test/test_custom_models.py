"""The deployment's own models at run time (shared/custom_models.py, 7.65.00) and their family in shared/model_config.py.

The registry arrives as ``CUSTOM_MODELS``, the JSON the synth wrote (lib/test-support/custom-models-env.json is the
same value the CDK spec builds, so all three readers share it): read leniently, offered only on the surfaces each
model declares, never as the pick for all surfaces or the deployment's default, and shaping each request through
its capability flags.
"""
from __future__ import annotations

import json
from decimal import Decimal

import pytest

from shared import custom_models
from shared.custom_models import (
    CUSTOM_MODELS_ENV,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_OUTPUT_TOKENS,
    MAX_CUSTOM_MODELS,
    custom_ids_for,
    custom_model,
    custom_model_ids,
    picker_rows,
)
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    SURFACE_DEFAULTS,
    anthropic_model,
    clear_model_cache,
    context_window_tokens,
    fallback_chain,
    get_active_model_id,
    max_output_tokens,
    model_for_documents,
    model_label,
    omits_temperature,
    supports_flex,
    surface_allowlist,
    takes_thinking_budget,
    uses_adaptive_thinking,
)
from shared.test.model_config_fixtures import stored_model_config
from shared.test.repo_paths import repo_root

REGISTRY = (repo_root() / 'lib' / 'test-support' / 'custom-models-env.json').read_text(encoding='utf-8')
NOVA = 'amazon.nova-pro-v1:0'
LLAMA = 'us.meta.llama3-3-70b-instruct-v1:0'
MINE = 'arn:aws:bedrock:us-west-2:111111111111:imported-model/abc123def456'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
SONNET46 = 'global.anthropic.claude-sonnet-4-6'


@pytest.fixture(autouse=True)
def _registry(monkeypatch):
    monkeypatch.setenv(CUSTOM_MODELS_ENV, REGISTRY)
    clear_model_cache()
    yield
    clear_model_cache()


def entries() -> list[dict]:
    return json.loads(REGISTRY)


class TestTheRegistry:
    def test_reads_every_model_in_order(self):
        assert [model.id for model in custom_models.custom_models()] == [NOVA, LLAMA, MINE]
        assert custom_model_ids() == {NOVA, LLAMA, MINE}

    def test_reads_a_model_whole(self):
        model = custom_model(MINE)
        assert model is not None
        assert (model.key, model.kind, model.source, model.surfaces, model.regions) == (
            'mine', 'imported', 'imported', ('memory',), ('us-west-2',))
        assert (model.tools, model.documents, model.json, model.temperature) == (False, False, True, False)
        assert (model.price_in, model.price_out) == (Decimal('0.5'), Decimal('1.5'))
        assert (model.context_window, model.max_output_tokens) == (8192, 2048)

    def test_no_env_or_an_empty_list_is_no_model(self, monkeypatch):
        monkeypatch.delenv(CUSTOM_MODELS_ENV)
        assert custom_models.custom_models() == ()
        monkeypatch.setenv(CUSTOM_MODELS_ENV, '[]')
        assert custom_models.custom_models() == ()
        assert surface_allowlist('documents') is ALLOWED_MODEL_IDS

    @pytest.mark.parametrize('raw', ['{not json', '{"key": "x"}'])
    def test_an_unreadable_value_offers_nothing(self, monkeypatch, raw):
        monkeypatch.setenv(CUSTOM_MODELS_ENV, raw)
        assert custom_models.custom_models() == ()

    @pytest.mark.parametrize(('field', 'value'), [
        ('price', {'in': 'free', 'out': 1}), ('price', {'in': True, 'out': 1}), ('price', {'in': -1, 'out': 1}),
        ('capabilities', {'tools': 'yes'}), ('source', 'sagemaker'), ('source', None), ('surfaces', ['web_reviews_search']),
        ('surfaces', 'chat'), ('key', ''), ('eu', 'no'), ('contextWindow', 0), ('maxOutputTokens', True), ('price', None),
    ])
    def test_an_entry_it_cannot_read_is_skipped_and_the_rest_kept(self, monkeypatch, field, value):
        broken = entries()
        broken[0][field] = value
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps(broken))
        assert [model.id for model in custom_models.custom_models()] == [LLAMA, MINE]

    def test_a_repeated_key_or_id_and_a_non_object_are_skipped(self, monkeypatch):
        twice = entries()
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps([twice[0], {**twice[1], 'id': NOVA}, 'x', twice[2]]))
        assert [model.id for model in custom_models.custom_models()] == [NOVA, MINE]

    def test_reads_at_most_the_synth_limit_and_fills_the_defaults(self, monkeypatch):
        base = {k: v for k, v in entries()[0].items() if k not in ('contextWindow', 'maxOutputTokens')}
        many = [{**base, 'key': f'm{i}', 'id': f'amazon.nova-{i}-v1:0'} for i in range(MAX_CUSTOM_MODELS + 2)]
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps(many))
        models = custom_models.custom_models()
        assert len(models) == MAX_CUSTOM_MODELS
        assert {(m.context_window, m.max_output_tokens) for m in models} == {
            (DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS)}

    def test_lists_the_picker_rows(self):
        rows = picker_rows()
        assert rows[1] == {
            'key': 'llama', 'id': LLAMA, 'label': 'Llama 3.3 70B Instruct', 'description': '', 'kind': 'bedrock',
            'source': 'profile', 'surfaces': ['chat', 'agent_worker', 'enrichment'], 'eu': False,
            'regions': ['us-east-1', 'us-east-2', 'us-west-2'],
            'capabilities': {'tools': True, 'documents': False, 'json': True, 'temperature': True},
            'price': {'in': 0.72, 'out': 0.72},
        }
        json.dumps(rows)  # the route answers it as is


class TestTheFamily:
    def test_each_surface_offers_the_custom_models_that_declare_it(self):
        assert custom_ids_for('documents') == {NOVA}
        assert surface_allowlist('documents') == ALLOWED_MODEL_IDS | {NOVA}
        assert surface_allowlist('chat') == ALLOWED_MODEL_IDS | {LLAMA}
        assert surface_allowlist('agent_reviewer') is ALLOWED_MODEL_IDS
        assert not surface_allowlist('web_reviews_search') & custom_model_ids()

    def test_a_surface_resolves_to_its_custom_pick(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'documents': NOVA, 'memory': MINE}}):
            assert (get_active_model_id('documents'), get_active_model_id('memory')) == (NOVA, MINE)

    def test_a_hand_edited_surface_the_model_cannot_serve_is_not_offered(self, monkeypatch):
        widened = entries()
        widened[0]['surfaces'] = ['documents', 'chat']          # Nova calls no tools
        widened[2]['surfaces'] = ['memory', 'agent_worker']     # the imported model: no tools either
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps(widened))
        assert (custom_ids_for('chat'), custom_ids_for('agent_worker'), custom_ids_for('documents')) == (
            {LLAMA}, {LLAMA}, {NOVA})

    def test_a_model_without_json_serves_only_the_surfaces_that_parse_none(self, monkeypatch):
        plain = entries()
        plain[0]['capabilities']['json'] = False
        plain[0]['surfaces'] = ['documents', 'prototype']
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps(plain))
        assert (custom_ids_for('documents'), custom_ids_for('prototype')) == (frozenset(), {NOVA})

    def test_a_custom_pick_on_a_surface_it_does_not_declare_falls_back(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': NOVA}}):
            assert get_active_model_id('chat') == SURFACE_DEFAULTS['chat']

    def test_a_removed_custom_model_falls_back_to_the_surface_default_and_says_so(self, monkeypatch, caplog):
        monkeypatch.setenv(CUSTOM_MODELS_ENV, json.dumps(entries()[1:]))
        with stored_model_config(monkeypatch, {'surfaces': {'documents': NOVA}}):
            assert get_active_model_id('documents') == SURFACE_DEFAULTS['documents']
        assert f"Configured model '{NOVA}' not in allowlist" in caplog.text

    def test_the_pick_for_all_surfaces_and_the_deployment_default_stay_claude(self, monkeypatch):
        with stored_model_config(monkeypatch, {'model_id': NOVA}, default=NOVA):
            assert get_active_model_id('documents') == SURFACE_DEFAULTS['documents']

    def test_the_fallback_chain_after_a_custom_model_is_claude(self):
        chain = fallback_chain(NOVA, 'documents')
        assert chain[0] == NOVA
        assert set(chain[1:]) <= ALLOWED_MODEL_IDS


class TestCapabilities:
    def test_temperature_only_where_the_model_takes_one(self):
        assert (omits_temperature(NOVA), omits_temperature(MINE)) == (False, True)

    def test_never_a_thinking_budget_nor_flex(self):
        for model_id in (NOVA, LLAMA, MINE):
            assert not takes_thinking_budget(model_id)
            assert not uses_adaptive_thinking(model_id)
            assert not supports_flex(model_id)
        assert takes_thinking_budget(SONNET46)
        assert not takes_thinking_budget(SONNET55)

    def test_the_window_the_output_cap_and_the_label(self):
        assert (context_window_tokens(NOVA), max_output_tokens(NOVA), model_label(NOVA)) == (
            300_000, 10_000, 'Amazon Nova Pro')
        assert max_output_tokens(SONNET55) is None
        assert model_label(SONNET55) == 'Claude Sonnet 5.5'

    def test_documents_and_images_go_to_the_surface_default_when_the_model_reads_none(self):
        assert model_for_documents(NOVA, 'documents') == NOVA
        assert model_for_documents(LLAMA, 'enrichment') == SURFACE_DEFAULTS['enrichment']
        assert model_for_documents(SONNET55, 'documents') == SONNET55

    def test_an_anthropic_request_body_never_goes_to_a_custom_model(self):
        assert anthropic_model(NOVA, 'utility') == SURFACE_DEFAULTS['utility']
        assert anthropic_model(SONNET46, 'utility') == SONNET46
