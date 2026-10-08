"""
Tests for shared/model_config.py — per-surface Bedrock model selection (issue #96).

`lambda/` is on sys.path via lambda/conftest.py, so `shared` imports directly.
"""
from unittest.mock import MagicMock, patch

import pytest

from shared.aws import BEDROCK_MODEL_ID
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    ALLOWED_MODELS,
    PICKER_SURFACES,
    SURFACE_DEFAULTS,
    clear_model_cache,
    get_active_model_id,
    omits_temperature,
    supports_flex,
    surface_default,
    uses_adaptive_thinking,
)
from shared.test.model_config_fixtures import stored_model_config

OPUS55 = "global.anthropic.claude-opus-5-5"
SONNET55 = "global.anthropic.claude-sonnet-5-5"
SONNET5 = "global.anthropic.claude-sonnet-5"
SONNET46 = "global.anthropic.claude-sonnet-4-6"
OPUS5 = "global.anthropic.claude-opus-5"
OPUS48 = "global.anthropic.claude-opus-4-8"
HAIKU55 = "global.anthropic.claude-haiku-5-5"
HAIKU45 = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_model_cache()
    yield
    clear_model_cache()


class TestAllowlist:
    def test_default_model_is_allowlisted(self):
        assert BEDROCK_MODEL_ID in ALLOWED_MODEL_IDS

    def test_every_surface_default_is_allowlisted(self):
        """A surface whose Automatic default isn't invocable would break that
        surface out of the box."""
        for surface, model_id in SURFACE_DEFAULTS.items():
            assert model_id in ALLOWED_MODEL_IDS, surface


class TestCapabilityFlags:
    def test_adaptive_models_omit_temperature(self):
        """Sonnet 5 / 5.5 and both Opus generations run adaptive thinking always-on,
        which rules out sampling controls; sending `temperature` would 400."""
        assert omits_temperature(SONNET55)
        assert omits_temperature(SONNET5)
        assert omits_temperature(OPUS5)
        assert omits_temperature(OPUS48)

    def test_sonnet46_and_haiku_accept_temperature(self):
        assert not omits_temperature(SONNET46)
        assert not omits_temperature(HAIKU45)

    def test_adaptive_thinking_covers_sonnet5_and_both_opus(self):
        """Opus 4.7 and later reject a manual `thinking.budget_tokens` with a
        400, so converse() must skip the field for BOTH Opus generations as it
        does for Sonnet 5. Opus 4.8 being selectable makes this load-bearing:
        it was previously in the omit-temperature set only."""
        assert uses_adaptive_thinking(SONNET55)
        assert uses_adaptive_thinking(SONNET5)
        assert uses_adaptive_thinking(OPUS5)
        assert uses_adaptive_thinking(OPUS48)
        for model_id in (SONNET46, HAIKU45):
            assert not uses_adaptive_thinking(model_id)

    @pytest.mark.parametrize('model_id', [OPUS55, HAIKU55])
    def test_the_5_5_generation_omits_temperature_and_thinking_budget(self, model_id):
        """Probed on Bedrock: Opus 5.5 and Haiku 5.5 reject `temperature`
        ("deprecated for this model") and an explicit thinking budget — unlike
        Haiku 4.5, which accepted both."""
        assert omits_temperature(model_id)
        assert uses_adaptive_thinking(model_id)

    @pytest.mark.parametrize('model_id', [OPUS55, HAIKU55])
    def test_the_5_5_generation_never_requests_flex(self, model_id):
        """Both refuse the Flex service tier, so converse() must send 'default'."""
        assert not supports_flex(model_id)


class TestSurfaceDefaults:
    def test_prototype_defaults_to_opus(self):
        assert surface_default('prototype') == OPUS55

    def test_enrichment_defaults_to_haiku(self):
        """The high-volume enrichment path must stay on the cheap model by
        default — the picker must not silently upgrade its cost profile."""
        assert surface_default('enrichment') == HAIKU55

    def test_chat_defaults_to_sonnet55(self):
        """The unified AI assistant (chat surface) runs on Sonnet 5.5."""
        assert surface_default('chat') == SONNET55

    def test_default_documents_utility_default_to_sonnet55(self):
        for surface in ('default', 'documents', 'utility'):
            assert surface_default(surface) == SONNET55

    def test_memory_defaults_to_haiku(self):
        """Memory extraction is high-volume background work on Haiku 5.5. It
        asks for Flex, which Haiku 5.5 refuses, so it is sent as 'default'."""
        assert surface_default('memory') == HAIKU55
        assert not supports_flex(surface_default('memory'))

    def test_agent_surfaces_defaults(self):
        """Conductor + final reviewer decide and verify (Opus 5.5); crewmates and
        the persona panel do the work (Sonnet 5.5) — owner decision A8."""
        assert surface_default('agent_orchestrator') == OPUS55
        assert surface_default('agent_reviewer') == OPUS55
        assert surface_default('agent_worker') == SONNET55
        assert surface_default('agent_persona') == SONNET55

    def test_picker_lists_the_five_new_surfaces_in_order(self):
        assert PICKER_SURFACES == (
            'chat', 'documents', 'prototype', 'enrichment', 'utility',
            'memory', 'agent_orchestrator', 'agent_worker', 'agent_reviewer', 'agent_persona',
        )

    def test_unknown_surface_falls_back_to_global_default(self):
        assert surface_default('nonexistent') == BEDROCK_MODEL_ID


class TestGetActiveModelId:
    def test_returns_surface_default_without_table_env(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert get_active_model_id('prototype') == OPUS55
        assert get_active_model_id('enrichment') == HAIKU55
        assert get_active_model_id() == BEDROCK_MODEL_ID

    def test_surfaces_are_independent(self, monkeypatch):
        """Pinning one surface must not move any other surface."""
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}):
            assert get_active_model_id('chat') == HAIKU45
            assert get_active_model_id('documents') == SONNET55
            assert get_active_model_id('prototype') == OPUS55
            assert get_active_model_id('enrichment') == HAIKU55

    def test_legacy_global_override_applies_to_unpinned_surfaces(self, monkeypatch):
        """A model_id written by the older single-model picker still works,
        but a per-surface pin beats it."""
        with stored_model_config(monkeypatch, {
            'model_id': SONNET46,
            'surfaces': {'prototype': OPUS5},
        }):
            assert get_active_model_id('chat') == SONNET46          # global fallback
            assert get_active_model_id('enrichment') == SONNET46    # global fallback
            assert get_active_model_id('prototype') == OPUS5       # per-surface wins

    def test_rejects_surface_value_outside_allowlist(self, monkeypatch):
        """A tampered or stale DB value must not reach Bedrock."""
        with stored_model_config(monkeypatch, {'surfaces': {'chat': 'anthropic.evil-model-v9'}}):
            assert get_active_model_id('chat') == SONNET55

    def test_rejects_legacy_global_outside_allowlist(self, monkeypatch):
        """A stale global from before a model was delisted falls back to the
        surface default — e.g. an old Sonnet 4.5 pin after the bump."""
        with stored_model_config(
            monkeypatch, {'model_id': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'},
        ):
            assert get_active_model_id('chat') == SONNET55
            assert get_active_model_id('enrichment') == HAIKU55

    def test_falls_back_to_defaults_when_lookup_fails(self, monkeypatch):
        """No read permission / throttling must never break inference."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource = MagicMock()
        resource.Table.return_value.get_item.side_effect = Exception('AccessDenied')
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == SONNET55
            assert get_active_model_id('prototype') == OPUS55

    def test_clear_cache_forces_refetch(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}) as table:
            get_active_model_id('chat')
            clear_model_cache()
            get_active_model_id('chat')
        assert table.get_item.call_count == 2


class TestAllowlistLockstep:
    """The allowlist exists in three places; drift AccessDenies at runtime.

    Python (this module) drives REST-API/job inference, the TS mirror drives
    streaming chat, and the shared CDK helper grants the IAM invoke
    permissions AND the BedrockAccessStack agreements. These tests read the
    other two sources so a model added to one place fails the build until
    all three agree.
    """

    @staticmethod
    def _repo_root():
        from pathlib import Path
        return Path(__file__).resolve().parents[3]

    def test_ts_stream_allowlist_matches_python(self):
        import re
        ts_source = (
            self._repo_root() / 'lambda' / 'stream' / 'src' / 'bedrock' / 'model-override.ts'
        ).read_text()
        # Only the ALLOWED_MODEL_IDS set constitutes the allowlist — the
        # capability sets (OMIT_TEMPERATURE/ADAPTIVE_THINKING) are subsets.
        allowlist_block = ts_source.split('ALLOWED_MODEL_IDS')[1].split(']);')[0]
        ts_ids = set(re.findall(r"'(global\.anthropic\.[^']+)'", allowlist_block))
        assert ts_ids == ALLOWED_MODEL_IDS

    def test_ts_adaptive_thinking_set_matches_python(self):
        """The adaptive-thinking set gates whether an explicit `thinking` budget
        is sent. If the streaming mirror drifts from Python, one path 400s while
        the other works — so pin them to each other like the allowlist."""
        import re
        ts_source = (
            self._repo_root() / 'lambda' / 'stream' / 'src' / 'bedrock' / 'model-override.ts'
        ).read_text()
        adaptive_block = ts_source.split('ADAPTIVE_THINKING_IDS')[1].split(']);')[0]
        ts_adaptive = set(re.findall(r"'(global\.anthropic\.[^']+)'", adaptive_block))
        py_adaptive = {m['id'] for m in ALLOWED_MODELS if uses_adaptive_thinking(m['id'])}
        assert ts_adaptive == py_adaptive

    def test_cdk_allowlist_matches_python(self):
        import re
        cdk_source = (
            self._repo_root() / 'lib' / 'utils' / 'model-allowlist.ts'
        ).read_text()
        allowlist_block = cdk_source.split('ALLOWED_MODEL_IDS')[1].split('];')[0]
        cdk_ids = set(re.findall(r"'(global\.anthropic\.[^']+)'", allowlist_block))
        assert cdk_ids == ALLOWED_MODEL_IDS

    def test_opus_fallback_targets_are_invocable(self):
        """Opus's safety classifiers RE-RUN a declined request on the previous
        Opus generation: Opus 5.5 → Opus 5 → Opus 4.8. Every hop must be in the
        allowlist (and therefore granted + agreed) or the fallback turns into an
        AccessDenied mid-request.

        In this app each target is also a normal picker option, so one list
        covers both roles. repo-review takes the opposite stance and grants it
        for fallback only — see its lib/config.ts.
        """
        for model_id in (OPUS55, OPUS5, OPUS48):
            assert model_id in ALLOWED_MODEL_IDS

    def test_mock_server_models_match_python(self):
        """The local mock's /settings/model fixture is a THIRD mirror of this
        allowlist, and it silently drifted: after the Opus 5 swap it still served
        the old 4-model list with prototype defaulting to Opus 4.8, so local dev
        showed a picker that no longer matched production.

        Unlike the TS mirrors it had no lockstep test — hence this one.
        """
        import re
        mock_source = (
            self._repo_root() / 'frontend' / 'mock-server.js'
        ).read_text()

        block = mock_source.split('mockAvailableModels')[1].split('];')[0]
        mock_ids = set(re.findall(r"id: '(global\.anthropic\.[^']+)'", block))
        assert mock_ids == ALLOWED_MODEL_IDS, (
            f'mock-server.js drifted from model_config.py: '
            f'only-in-mock={mock_ids - ALLOWED_MODEL_IDS}, '
            f'missing-from-mock={ALLOWED_MODEL_IDS - mock_ids}'
        )

        # Surface defaults matter too: a stale default is what made the local
        # picker claim the prototype builder still ran on Opus 4.8.
        defaults_block = mock_source.split('mockSurfaceDefaults')[1].split('};')[0]
        # PICKER_SURFACES only — the internal "default" bucket isn't exposed.
        for surface in PICKER_SURFACES:
            expected = SURFACE_DEFAULTS[surface]
            found = re.search(rf"{surface}: '([^']+)'", defaults_block)
            assert found, f'mock-server.js has no default for surface {surface!r}'
            assert found.group(1) == expected, (
                f'mock default for {surface!r} is {found.group(1)!r}, '
                f'model_config.py says {expected!r}'
            )

    def test_nag_suppressions_are_derived_not_hardcoded(self):
        """cdk-nag suppressions must DERIVE their foundation-model ARNs from
        model-allowlist.ts, never re-hardcode them.

        This replaces an older string-scrape assertion. A hand-listed set drifts
        silently: add a model, forget the suppression, and synth fails with an
        unsuppressed IAM5 finding at deploy time. The per-model value coverage
        now lives in lib/utils/model-allowlist.test.ts, which checks the
        suppression targets against the ARNs the policy actually emits.
        """
        nag_source = (
            self._repo_root() / 'lib' / 'utils' / 'nag-suppressions.ts'
        ).read_text()
        assert 'bedrockFoundationModelSuppressionTargets' in nag_source, (
            'bedrockModelSuppressions must call '
            'bedrockFoundationModelSuppressionTargets() from model-allowlist.ts'
        )
        # Guard the regression this replaces: no literal model ARNs.
        assert 'foundation-model/anthropic.' not in nag_source, (
            'foundation-model ARNs are hardcoded again — derive them instead'
        )
