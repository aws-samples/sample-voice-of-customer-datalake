"""Mutation hardening for `shared/model_config.py`.

`test_model_config.py` pins the allowlist membership, the capability flags,
every surface default and the override precedence, but a mutation run found
behaviour none of those tests observe:

* the WIRE SHAPE of the allowlist rows. `GET /settings/model` returns
  ``ALLOWED_MODELS`` verbatim as ``available_models``, so every ``label`` and
  ``description`` is text an admin reads in the picker — the earlier tests
  pinned only ``sonnet55``. The whole list is pinned here literally, in order.
* the CONTEXT WINDOWS: ``200_000`` for seven of the eight models and the
  fallback for an unknown id, which no earlier test read at all.
* the DYNAMODB KEY the lookup reads (``SETTINGS#model`` / ``config`` under
  ``pk`` / ``sk``) — the settings handler writes the same key, so a drift
  here silently ignores every saved choice.
* the CACHE: the 60 s hit window and 10 s error window as exact boundaries
  (``now < expires``, so the read at exactly ``expires`` refetches), the
  import-time state, what ``clear_model_cache`` leaves behind, and that a
  Lambda without ``AGGREGATES_TABLE`` never builds a DynamoDB resource.
* the WORDING of every warning, including the 80-character cap on the
  rejected model id.
"""
import importlib.util
from pathlib import Path
from unittest.mock import patch

import pytest

from shared import model_config
from shared.model_config import (
    ALLOWED_MODELS,
    DEFAULT_SURFACE,
    FALLBACK_CONTEXT_WINDOW_TOKENS,
    MODEL_SETTINGS_PK,
    MODEL_SETTINGS_SK,
    SURFACE_DEFAULTS,
    clear_model_cache,
    context_window_tokens,
    get_active_model_id,
    surface_context_window_tokens,
    surface_default,
)
from shared.test.model_config_fixtures import stored_model_config

OPUS55 = 'global.anthropic.claude-opus-5-5'
SONNET55 = 'global.anthropic.claude-sonnet-5-5'
SONNET5 = 'global.anthropic.claude-sonnet-5'
SONNET46 = 'global.anthropic.claude-sonnet-4-6'
OPUS5 = 'global.anthropic.claude-opus-5'
OPUS48 = 'global.anthropic.claude-opus-4-8'
HAIKU55 = 'global.anthropic.claude-haiku-5-5'
HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0'


@pytest.fixture(autouse=True)
def _fresh_cache():
    clear_model_cache()
    yield
    clear_model_cache()


class TestAllowlistRowsAreTheSettingsApiPayload:
    def test_rows_are_pinned_literally_in_picker_order(self):
        assert ALLOWED_MODELS == [
            {
                'key': 'opus55',
                'id': OPUS55,
                'label': 'Claude Opus 5.5',
                'description': (
                    'Deepest reasoning — default for prototypes and the agent conductor and reviewer'
                ),
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'sonnet55',
                'id': SONNET55,
                'label': 'Claude Sonnet 5.5',
                'description': (
                    'Newest Sonnet with a 1M-token context — default for the AI assistant, documents and utilities'
                ),
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 1_000_000,
            },
            {
                'key': 'sonnet5',
                'id': SONNET5,
                'label': 'Claude Sonnet 5',
                'description': 'Previous-generation Sonnet — strong analysis and generation',
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'sonnet46',
                'id': SONNET46,
                'label': 'Claude Sonnet 4.6',
                'description': (
                    'Previous-generation Sonnet (4.6) — strong quality, accepts temperature tuning'
                ),
                'omit_temperature': False,
                'adaptive_thinking': False,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'opus5',
                'id': OPUS5,
                'label': 'Claude Opus 5',
                'description': (
                    'Previous-generation Opus — also the automatic fallback when Opus 5.5 declines a request'
                ),
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'opus48',
                'id': OPUS48,
                'label': 'Claude Opus 4.8',
                'description': (
                    'Previous-generation Opus (4.8) — the automatic fallback when Opus 5 declines a request'
                ),
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'haiku55',
                'id': HAIKU55,
                'label': 'Claude Haiku 5.5',
                'description': 'Fastest and cheapest — default for high-volume enrichment and memory',
                'omit_temperature': True,
                'adaptive_thinking': True,
                'supports_flex': False,
                'context_window': 200_000,
            },
            {
                'key': 'haiku45',
                'id': HAIKU45,
                'label': 'Claude Haiku 4.5',
                'description': 'Previous-generation Haiku — fast and cheap, accepts temperature tuning',
                'omit_temperature': False,
                'adaptive_thinking': False,
                'supports_flex': False,
                'context_window': 200_000,
            },
        ]

    def test_surface_defaults_table_is_pinned_literally(self):
        """Includes the internal 'default' bucket, which the picker never
        shows and which resolves to the same model as BEDROCK_MODEL_ID — so
        only a literal read of the table can tell a renamed key apart."""
        assert SURFACE_DEFAULTS == {
            'default': SONNET55,
            'chat': SONNET55,
            'documents': SONNET55,
            'prototype': OPUS55,
            'enrichment': HAIKU55,
            'utility': SONNET55,
            'memory': HAIKU55,
            'agent_orchestrator': OPUS55,
            'agent_worker': SONNET55,
            'agent_reviewer': OPUS55,
            'agent_persona': SONNET55,
        }

    def test_default_surface_is_the_default_bucket(self):
        assert DEFAULT_SURFACE == 'default'
        assert surface_default(DEFAULT_SURFACE) == SONNET55

    def test_unnamed_surface_resolves_through_the_default_bucket(self, monkeypatch):
        """A converse() caller that names no surface is routed to the 'default'
        bucket, so pinning that bucket moves it."""
        with stored_model_config(monkeypatch, {'surfaces': {'default': HAIKU45}}):
            assert get_active_model_id() == HAIKU45


class TestContextWindows:
    @pytest.mark.parametrize('model_id', [OPUS55, SONNET5, SONNET46, OPUS5, OPUS48, HAIKU55, HAIKU45])
    def test_every_model_but_sonnet55_has_a_200k_window(self, model_id):
        assert context_window_tokens(model_id) == 200_000

    def test_sonnet55_has_a_1m_window(self):
        assert context_window_tokens(SONNET55) == 1_000_000

    def test_fallback_is_the_narrowest_allowlisted_window(self):
        assert FALLBACK_CONTEXT_WINDOW_TOKENS == 200_000
        assert context_window_tokens('anthropic.not-in-the-allowlist') == 200_000

    def test_surface_window_follows_the_resolved_model(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'documents': SONNET55}}):
            assert surface_context_window_tokens('documents') == 1_000_000
            assert surface_context_window_tokens('prototype') == 200_000

    def test_surface_window_falls_back_and_says_why_when_resolution_raises(self):
        with patch('shared.model_config.get_active_model_id', side_effect=RuntimeError('boom')), \
                patch('shared.model_config.logger') as log:
            assert surface_context_window_tokens('documents') == 200_000
        log.warning.assert_called_once_with(
            "Could not resolve model for surface 'documents': boom"
        )


class TestSettingsItemKey:
    def test_key_constants(self):
        assert MODEL_SETTINGS_PK == 'SETTINGS#model'
        assert MODEL_SETTINGS_SK == 'config'

    def test_lookup_reads_the_settings_item_by_pk_and_sk(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}) as table:
            get_active_model_id('chat')
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#model', 'sk': 'config'})

    def test_no_table_env_never_builds_a_dynamodb_resource(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        with patch('shared.model_config.get_dynamodb_resource') as resource_factory:
            assert get_active_model_id('chat') == SONNET55
        resource_factory.assert_not_called()


class TestCacheWindows:
    def test_import_time_cache_is_empty_and_expired(self):
        """A fresh container must miss on its first read: load a second copy
        of the module from disk and read its cache before anything touches it."""
        spec = importlib.util.spec_from_file_location(
            'model_config_fresh_copy', Path(model_config.__file__),
        )
        assert spec is not None
        assert spec.loader is not None
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        assert fresh._cache == {'value': None, 'expires': 0.0}

    def test_clear_resets_both_cache_fields(self, monkeypatch):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}), \
                patch('shared.model_config.time.time', return_value=1000.0):
            get_active_model_id('chat')
            assert model_config._cache == {
                'value': {'surfaces': {'chat': HAIKU45}}, 'expires': 1060.0,
            }
        clear_model_cache()
        assert model_config._cache == {'value': None, 'expires': 0.0}

    @pytest.mark.parametrize(('second_read_at', 'reads'), [
        (1059.999, 1),   # still inside the 60 s window
        (1060.0, 2),     # `now < expires` — the read AT expiry refetches
    ])
    def test_a_successful_read_is_served_for_exactly_60_seconds(
        self, monkeypatch, second_read_at, reads,
    ):
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}) as table, \
                patch('shared.model_config.time.time') as now:
            now.return_value = 1000.0
            assert get_active_model_id('chat') == HAIKU45
            now.return_value = second_read_at
            assert get_active_model_id('chat') == HAIKU45
        assert table.get_item.call_count == reads

    @pytest.mark.parametrize(('second_read_at', 'reads'), [
        (1009.999, 1),   # still inside the 10 s error window
        (1010.0, 2),     # a throttling blip must not pin defaults for the full minute
    ])
    def test_a_failed_read_is_cached_for_exactly_10_seconds(
        self, monkeypatch, second_read_at, reads,
    ):
        error = Exception('ThrottlingException')
        with stored_model_config(monkeypatch, None, error=error) as table, \
                patch('shared.model_config.time.time') as now, \
                patch('shared.model_config.logger') as log:
            now.return_value = 1000.0
            assert get_active_model_id('chat') == SONNET55
            assert model_config._cache == {'value': {}, 'expires': 1010.0}
            now.return_value = second_read_at
            assert get_active_model_id('chat') == SONNET55
        assert table.get_item.call_count == reads
        assert log.warning.call_args_list[0].args == (
            'Model settings lookup failed; using defaults: ThrottlingException',
        )

    def test_a_none_value_is_never_a_cache_hit_even_before_expiry(self, monkeypatch):
        """The hit test is `value is not None AND now < expires`: an empty
        slot with a future expiry still goes to DynamoDB."""
        model_config._cache['value'] = None
        model_config._cache['expires'] = 1_000_000.0
        with stored_model_config(monkeypatch, {'surfaces': {'chat': HAIKU45}}) as table, \
                patch('shared.model_config.time.time', return_value=1000.0):
            assert get_active_model_id('chat') == HAIKU45
        assert table.get_item.call_count == 1

    def test_a_non_dict_item_is_cached_as_empty_settings(self, monkeypatch):
        with stored_model_config(monkeypatch, 'not-a-dict'), \
                patch('shared.model_config.time.time', return_value=1000.0):
            assert get_active_model_id('chat') == SONNET55
        assert model_config._cache == {'value': {}, 'expires': 1060.0}


class TestRejectedModelWarning:
    def test_warning_quotes_at_most_80_characters_of_the_rejected_id(self, monkeypatch):
        bogus = 'anthropic.' + 'x' * 90
        with stored_model_config(monkeypatch, {'surfaces': {'chat': bogus}}), \
                patch('shared.model_config.logger') as log:
            assert get_active_model_id('chat') == SONNET55
        log.warning.assert_called_once_with(
            f"Configured model '{bogus[:80]}' not in allowlist; ignoring"
        )
        assert len(bogus[:80]) == 80

    def test_a_non_string_value_is_stringified_in_the_warning(self, monkeypatch):
        with stored_model_config(monkeypatch, {'model_id': 42}), \
                patch('shared.model_config.logger') as log:
            assert get_active_model_id('enrichment') == HAIKU55
        log.warning.assert_called_once_with("Configured model '42' not in allowlist; ignoring")

    @pytest.mark.parametrize('empty', [None, '', 0, False])
    def test_an_empty_value_is_ignored_silently(self, monkeypatch, empty):
        with stored_model_config(monkeypatch, {'model_id': empty, 'surfaces': {'chat': empty}}), \
                patch('shared.model_config.logger') as log:
            assert get_active_model_id('chat') == SONNET55
        log.warning.assert_not_called()
