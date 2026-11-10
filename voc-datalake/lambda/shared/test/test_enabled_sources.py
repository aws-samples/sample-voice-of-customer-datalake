"""Tests for shared/enabled_sources.py — the default source list (issue #256)."""
import json

from shared.enabled_sources import ENABLED_SOURCES_ENV_VAR, default_source_ids


def test_enabled_plugins_come_first_in_deploy_order(monkeypatch):
    monkeypatch.setenv(ENABLED_SOURCES_ENV_VAR, json.dumps(['synthetic_reviews', 'app_reviews_ios']))

    assert default_source_ids() == ['synthetic_reviews', 'app_reviews_ios', 'manual_import']


def test_malformed_and_repeated_entries_are_dropped_individually(monkeypatch):
    monkeypatch.setenv(
        ENABLED_SOURCES_ENV_VAR,
        json.dumps(['webscraper', '../etc', 7, 'webscraper', 'manual_import', 's3_import']),
    )

    assert default_source_ids() == ['webscraper', 'manual_import', 's3_import']
