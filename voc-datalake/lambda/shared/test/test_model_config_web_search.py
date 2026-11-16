"""The web search surface (7.42.00): ``web_reviews_search`` picks an OpenAI GPT model in Administration -> AI models.

* its allowlist is the GPT family alone, and no other surface's holds a GPT model (two separate lists);
* it resolves to its own pick, else Luna: the pick for all surfaces, the deployment's default and a model
  profile are Claude models and never reach it, and a Claude value stored for it is ignored;
* its capacity fallback walks Luna, Terra, Sol, GPT-5.5, GPT-5.4 after the resolved model;
* it is offered in the picker only while a deployed plugin reads with it (``WEB_SEARCH_MODELS_OFFERED``);
* the local mock serves the same models (frontend/mock-server.js).
"""
import re
from pathlib import Path
from unittest.mock import patch

import pytest

from shared.model_config import (
    ALLOWED_MODEL_IDS,
    PICKER_SURFACES,
    WEB_SEARCH_FALLBACK_ORDER,
    WEB_SEARCH_MODEL_IDS,
    WEB_SEARCH_MODELS,
    WEB_SEARCH_SURFACE,
    clear_model_cache,
    fallback_chain,
    get_active_model_id,
    offered_picker_surfaces,
    surface_allowlist,
)
from shared.test.model_config_fixtures import stored_model_config

LUNA = 'openai.gpt-5.6-luna'
TERRA = 'openai.gpt-5.6-terra'
SOL = 'openai.gpt-5.6-sol'
GPT55 = 'openai.gpt-5.5'
GPT54 = 'openai.gpt-5.4'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_model_cache()
    yield
    clear_model_cache()


class TestTwoSeparateAllowlists:
    def test_the_surface_picks_the_gpt_family_alone_in_the_fallback_order(self):
        assert [m['id'] for m in WEB_SEARCH_MODELS] == [LUNA, TERRA, SOL, GPT55, GPT54]
        assert WEB_SEARCH_FALLBACK_ORDER == (LUNA, TERRA, SOL, GPT55, GPT54)
        assert surface_allowlist(WEB_SEARCH_SURFACE) == WEB_SEARCH_MODEL_IDS == frozenset(WEB_SEARCH_FALLBACK_ORDER)
        assert [m['label'] for m in WEB_SEARCH_MODELS] == [
            'OpenAI GPT-5.6 Luna', 'OpenAI GPT-5.6 Terra', 'OpenAI GPT-5.6 Sol', 'OpenAI GPT-5.5', 'OpenAI GPT-5.4']

    @pytest.mark.parametrize('surface', [s for s in PICKER_SURFACES if s != WEB_SEARCH_SURFACE])
    def test_every_other_surface_picks_claude_only(self, surface):
        assert surface_allowlist(surface) == ALLOWED_MODEL_IDS
        assert not surface_allowlist(surface) & WEB_SEARCH_MODEL_IDS

    def test_the_lists_share_no_model(self):
        assert not ALLOWED_MODEL_IDS & WEB_SEARCH_MODEL_IDS


class TestResolution:
    def test_luna_without_a_pick(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert get_active_model_id(WEB_SEARCH_SURFACE) == LUNA

    def test_its_own_pick(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {WEB_SEARCH_SURFACE: SOL}}):
            assert get_active_model_id(WEB_SEARCH_SURFACE) == SOL

    def test_never_the_pick_for_all_surfaces_nor_the_deployments_default(self, monkeypatch):
        with stored_model_config(monkeypatch, {'model_id': HAIKU55}, default=SONNET55):
            assert get_active_model_id(WEB_SEARCH_SURFACE) == LUNA
            assert get_active_model_id('chat') == HAIKU55

    def test_a_claude_model_stored_for_it_is_ignored(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {WEB_SEARCH_SURFACE: SONNET55}}):
            assert get_active_model_id(WEB_SEARCH_SURFACE) == LUNA

    def test_a_gpt_model_stored_for_a_claude_surface_is_ignored(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': TERRA}}):
            assert get_active_model_id('chat') == SONNET55

    def test_a_model_profile_does_not_reach_it(self):
        with patch('shared.model_config.profile_model_id', return_value=HAIKU55), \
                patch('shared.model_config.active_profile', return_value='e2e'):
            assert get_active_model_id(WEB_SEARCH_SURFACE) == LUNA
            assert get_active_model_id('chat') == HAIKU55
            assert fallback_chain(TERRA, WEB_SEARCH_SURFACE) == (TERRA, LUNA, SOL, GPT55, GPT54)


class TestCapacityFallback:
    def test_luna_steps_down_the_family(self):
        assert fallback_chain(LUNA, WEB_SEARCH_SURFACE) == (LUNA, TERRA, SOL, GPT55, GPT54)

    def test_another_pick_goes_first_then_the_default_then_the_rest(self):
        assert fallback_chain(SOL, WEB_SEARCH_SURFACE) == (SOL, LUNA, TERRA, GPT55, GPT54)

    def test_no_claude_model_and_no_gpt_model_on_the_other_side(self):
        assert not set(fallback_chain(LUNA, WEB_SEARCH_SURFACE)) & ALLOWED_MODEL_IDS
        assert not set(fallback_chain(HAIKU55, 'enrichment')) & WEB_SEARCH_MODEL_IDS


class TestOffered:
    def test_absent_from_the_picker_unless_a_deployed_plugin_reads_with_it(self, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_MODELS_OFFERED', raising=False)
        assert WEB_SEARCH_SURFACE not in offered_picker_surfaces()
        monkeypatch.setenv('WEB_SEARCH_MODELS_OFFERED', 'True')
        assert WEB_SEARCH_SURFACE not in offered_picker_surfaces()

    def test_offered_last_when_the_settings_lambda_says_so(self, monkeypatch):
        monkeypatch.setenv('WEB_SEARCH_MODELS_OFFERED', 'true')
        assert offered_picker_surfaces() == PICKER_SURFACES
        assert offered_picker_surfaces()[-1] == WEB_SEARCH_SURFACE


def test_the_local_mock_serves_the_same_gpt_models():
    """frontend/mock-server.js mirrors the rows (ids and labels, in order) like it mirrors the Claude ones."""
    source = (REPO / 'frontend' / 'mock-server.js').read_text()
    block = source.split('mockWebSearchModels = [')[1].split('];')[0]
    assert re.findall(r"id: '([^']+)', label: '([^']+)'", block) == [(m['id'], m['label']) for m in WEB_SEARCH_MODELS]
