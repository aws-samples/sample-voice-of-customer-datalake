"""
Tests for shared/model_config.py — per-surface Bedrock model selection (issue #96).
"""
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shared.model_config import (  # noqa: E402
    ALLOWED_MODELS, ALLOWED_MODEL_IDS, PICKER_SURFACES, SURFACE_DEFAULTS,
    clear_model_cache, get_active_model_id, omits_temperature,
    uses_adaptive_thinking, surface_default,
)
from shared.aws import BEDROCK_MODEL_ID  # noqa: E402

SONNET5 = "global.anthropic.claude-sonnet-5"
SONNET46 = "global.anthropic.claude-sonnet-4-6"
OPUS48 = "global.anthropic.claude-opus-4-8"
HAIKU45 = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_model_cache()
    yield
    clear_model_cache()


def _table_returning(item):
    table = MagicMock()
    table.get_item.return_value = {'Item': item} if item else {}
    resource = MagicMock()
    resource.Table.return_value = table
    return resource, table


class TestAllowlist:
    def test_default_model_is_allowlisted(self):
        assert BEDROCK_MODEL_ID in ALLOWED_MODEL_IDS

    def test_allowlist_has_all_four_models(self):
        assert ALLOWED_MODEL_IDS == {SONNET5, SONNET46, OPUS48, HAIKU45}

    def test_every_surface_default_is_allowlisted(self):
        """A surface whose Automatic default isn't invocable would break that
        surface out of the box."""
        for surface, model_id in SURFACE_DEFAULTS.items():
            assert model_id in ALLOWED_MODEL_IDS, surface

    def test_every_picker_surface_has_a_default(self):
        for surface in PICKER_SURFACES:
            assert surface in SURFACE_DEFAULTS

    def test_model_entries_carry_stable_keys(self):
        keys = [m['key'] for m in ALLOWED_MODELS]
        assert keys == ['sonnet5', 'sonnet46', 'opus48', 'haiku45']


class TestCapabilityFlags:
    def test_sonnet5_and_opus48_omit_temperature(self):
        """Sonnet 5 (adaptive thinking always-on) and Opus 4.8 (deprecated
        param) reject `temperature`; sending it would 400 every call."""
        assert omits_temperature(SONNET5)
        assert omits_temperature(OPUS48)

    def test_sonnet46_and_haiku_accept_temperature(self):
        assert not omits_temperature(SONNET46)
        assert not omits_temperature(HAIKU45)

    def test_only_sonnet5_uses_adaptive_thinking(self):
        assert uses_adaptive_thinking(SONNET5)
        for model_id in (SONNET46, OPUS48, HAIKU45):
            assert not uses_adaptive_thinking(model_id)


class TestSurfaceDefaults:
    def test_prototype_defaults_to_opus(self):
        assert surface_default('prototype') == OPUS48

    def test_enrichment_defaults_to_haiku(self):
        """The high-volume enrichment path must stay on the cheap model by
        default — the picker must not silently upgrade its cost profile."""
        assert surface_default('enrichment') == HAIKU45

    def test_chat_documents_utility_default_to_sonnet5(self):
        for surface in ('chat', 'documents', 'utility'):
            assert surface_default(surface) == SONNET5

    def test_unknown_surface_falls_back_to_global_default(self):
        assert surface_default('nonexistent') == BEDROCK_MODEL_ID


class TestGetActiveModelId:
    def test_returns_surface_default_without_table_env(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert get_active_model_id('prototype') == OPUS48
        assert get_active_model_id('enrichment') == HAIKU45
        assert get_active_model_id() == BEDROCK_MODEL_ID

    def test_returns_per_surface_override(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({'surfaces': {'chat': HAIKU45}})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == HAIKU45

    def test_surfaces_are_independent(self, monkeypatch):
        """Pinning one surface must not move any other surface."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({'surfaces': {'chat': HAIKU45}})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == HAIKU45
            assert get_active_model_id('documents') == SONNET5
            assert get_active_model_id('prototype') == OPUS48
            assert get_active_model_id('enrichment') == HAIKU45

    def test_legacy_global_override_applies_to_unpinned_surfaces(self, monkeypatch):
        """A model_id written by the older single-model picker still works,
        but a per-surface pin beats it."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({
            'model_id': SONNET46,
            'surfaces': {'prototype': OPUS48},
        })
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == SONNET46          # global fallback
            assert get_active_model_id('enrichment') == SONNET46    # global fallback
            assert get_active_model_id('prototype') == OPUS48       # per-surface wins

    def test_rejects_surface_value_outside_allowlist(self, monkeypatch):
        """A tampered or stale DB value must not reach Bedrock."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({'surfaces': {'chat': 'anthropic.evil-model-v9'}})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == SONNET5

    def test_rejects_legacy_global_outside_allowlist(self, monkeypatch):
        """A stale global from before a model was delisted falls back to the
        surface default — e.g. an old Sonnet 4.5 pin after the bump."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning(
            {'model_id': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'}
        )
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == SONNET5
            assert get_active_model_id('enrichment') == HAIKU45

    def test_falls_back_to_defaults_when_lookup_fails(self, monkeypatch):
        """No read permission / throttling must never break inference."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource = MagicMock()
        resource.Table.return_value.get_item.side_effect = Exception('AccessDenied')
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == SONNET5
            assert get_active_model_id('prototype') == OPUS48

    def test_caches_lookup_within_ttl(self, monkeypatch):
        """One DynamoDB read serves every surface within the TTL."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, table = _table_returning({'surfaces': {'chat': HAIKU45}})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id('chat') == HAIKU45
            assert get_active_model_id('documents') == SONNET5
            assert get_active_model_id('chat') == HAIKU45
        assert table.get_item.call_count == 1

    def test_clear_cache_forces_refetch(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, table = _table_returning({'surfaces': {'chat': HAIKU45}})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
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

    def test_ts_capability_sets_match_python(self):
        import re
        ts_source = (
            self._repo_root() / 'lambda' / 'stream' / 'src' / 'bedrock' / 'model-override.ts'
        ).read_text()
        omit_block = ts_source.split('OMIT_TEMPERATURE_IDS')[1].split(']);')[0]
        ts_omit = set(re.findall(r"'(global\.anthropic\.[^']+)'", omit_block))
        py_omit = {m['id'] for m in ALLOWED_MODELS if m['omit_temperature']}
        assert ts_omit == py_omit

    def test_cdk_allowlist_matches_python(self):
        import re
        cdk_source = (
            self._repo_root() / 'lib' / 'utils' / 'model-allowlist.ts'
        ).read_text()
        allowlist_block = cdk_source.split('ALLOWED_MODEL_IDS')[1].split('];')[0]
        cdk_ids = set(re.findall(r"'(global\.anthropic\.[^']+)'", allowlist_block))
        assert cdk_ids == ALLOWED_MODEL_IDS

    def test_nag_suppressions_cover_every_foundation_model(self):
        """cdk-nag suppressions enumerate the foundation-model ARNs by string;
        a missing one fails synth with an unsuppressed IAM5 finding."""
        import re
        nag_source = (
            self._repo_root() / 'lib' / 'utils' / 'nag-suppressions.ts'
        ).read_text()
        suppressed = set(re.findall(
            r"foundation-model/(anthropic\.[^']+)'", nag_source
        ))
        expected = {m['id'].replace('global.', '') for m in ALLOWED_MODELS}
        assert expected <= suppressed
