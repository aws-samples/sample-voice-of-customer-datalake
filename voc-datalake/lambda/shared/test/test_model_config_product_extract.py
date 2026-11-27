"""The product extract's model surface and the effort flag (7.104.00, shared/model_config.py; owner decision 9).

``product_extract`` is its own entry in Settings → AI models, defaulting to Sonnet 5.5: a pick for it applies, but
neither the pick for all surfaces nor the deployment's default replaces it; the e2e model profile still does. Its
capacity fallback is Sonnet 5 alone, and it takes no custom model. ``supports_effort`` says which models take which
``output_config.effort`` level: Haiku 4.5 takes none, Sonnet 4.6 no ``xhigh``.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from shared import model_config
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    PICKER_SURFACES,
    PRODUCT_EXTRACT_SURFACE,
    clear_model_cache,
    fallback_chain,
    get_active_model_id,
    keeps_own_default,
    refusal_fallback,
    supports_effort,
    surface_allowlist,
)
from shared.model_profile import E2E_PROFILE, model_profile_scope
from shared.test.model_config_fixtures import stored_model_config

SONNET55 = 'global.anthropic.claude-sonnet-5-5'
SONNET5 = 'global.anthropic.claude-sonnet-5'
SONNET46 = 'global.anthropic.claude-sonnet-4-6'
OPUS55 = 'global.anthropic.claude-opus-5-5'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_model_cache()
    yield
    clear_model_cache()


class TestTheSurface:
    def test_it_is_offered_in_the_picker_after_documents(self):
        assert PRODUCT_EXTRACT_SURFACE == 'product_extract'
        assert PICKER_SURFACES.index('product_extract') == PICKER_SURFACES.index('documents') + 1

    def test_it_defaults_to_sonnet_55(self, monkeypatch):
        with stored_model_config(monkeypatch, None):
            assert get_active_model_id('product_extract') == SONNET55

    def test_its_own_pick_applies(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'product_extract': OPUS55}}):
            assert get_active_model_id('product_extract') == OPUS55

    def test_the_pick_for_all_surfaces_does_not_replace_its_default(self, monkeypatch):
        with stored_model_config(monkeypatch, {'model_id': HAIKU45}):
            assert get_active_model_id('product_extract') == SONNET55
            assert get_active_model_id('documents') == HAIKU45

    def test_the_deployments_default_does_not_replace_its_default(self, monkeypatch):
        with stored_model_config(monkeypatch, None, default={'model_id': HAIKU55}):
            assert get_active_model_id('product_extract') == SONNET55
            assert get_active_model_id('documents') == HAIKU55

    def test_a_pick_outside_the_claude_allowlist_is_ignored(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'product_extract': 'openai.gpt-5.6-luna'}}):
            assert get_active_model_id('product_extract') == SONNET55

    def test_the_e2e_profile_runs_it_on_haiku_55(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'product_extract': OPUS55}}), \
                model_profile_scope(E2E_PROFILE):
            assert get_active_model_id('product_extract') == HAIKU55

    def test_the_settings_page_is_told_its_automatic_follows_no_pin(self):
        # GET /settings/model answers own_default, so "Automatic → …" names its own default, never the pin.
        assert {surface for surface in PICKER_SURFACES if keeps_own_default(surface)} == {
            'product_extract', 'web_reviews_search'}

    def test_it_takes_no_custom_model(self):
        with patch.object(model_config, 'custom_ids_for', return_value=frozenset({'custom.model'})):
            assert surface_allowlist('product_extract') == ALLOWED_MODEL_IDS


class TestItsCapacityFallback:
    def test_sonnet_55_falls_back_to_sonnet_5_only(self):
        assert fallback_chain(SONNET55, 'product_extract') == (SONNET55, SONNET5)

    def test_a_picked_opus_falls_back_to_the_default_then_sonnet_5(self):
        assert fallback_chain(OPUS55, 'product_extract') == (OPUS55, SONNET55, SONNET5)

    def test_it_never_steps_down_to_a_haiku(self):
        chain = fallback_chain(SONNET55, 'product_extract')
        assert [model for model in chain if 'haiku' in model] == []

    def test_under_the_e2e_profile_it_walks_the_profiles_models(self):
        with model_profile_scope(E2E_PROFILE):
            assert fallback_chain(HAIKU55, 'product_extract') == (HAIKU55, HAIKU45)


class TestTheEffortFlag:
    @pytest.mark.parametrize('model', [SONNET55, SONNET5, OPUS55, HAIKU55, 'global.anthropic.claude-opus-5',
                                       'global.anthropic.claude-opus-4-8'])
    @pytest.mark.parametrize('level', ['max', 'xhigh'])
    def test_the_5_x_models_and_opus_48_take_max_and_xhigh(self, model, level):
        assert supports_effort(model, level)

    @pytest.mark.parametrize('level', ['low', 'medium', 'high', 'xhigh', 'max'])
    def test_haiku_45_takes_no_effort(self, level):
        assert not supports_effort(HAIKU45, level)

    def test_sonnet_46_takes_max_but_not_xhigh(self):
        assert (supports_effort(SONNET46, 'max'), supports_effort(SONNET46, 'xhigh')) == (True, False)

    def test_an_unknown_model_or_level_takes_none(self):
        assert (supports_effort('custom.model', 'max'), supports_effort(SONNET55, 'turbo')) == (False, False)


class TestTheRefusalFallback:
    def test_a_refusal_on_sonnet_55_is_asked_again_on_sonnet_5(self):
        assert refusal_fallback('product_extract', SONNET55) == SONNET5

    def test_a_refusal_on_sonnet_5_has_no_second_model(self):
        assert refusal_fallback('product_extract', SONNET5) is None

    def test_under_the_e2e_profile_there_is_no_second_model(self):
        with model_profile_scope(E2E_PROFILE):
            assert refusal_fallback('product_extract', HAIKU55) is None

    def test_another_surface_asks_no_second_model(self):
        assert refusal_fallback('documents', SONNET55) is None
