"""Which sources are refreshed in place comes from the plugins' manifests (TENETS.md tenet 5).

The processing stack renders ``UPDATE_CAPABLE_SOURCES`` from every manifest declaring
``"capabilities": {"updatesItems": true}``; the backend suite's default (lambda/conftest.py)
must say the same, or these tests would exercise a deployment that does not exist.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from shared import source_updates

PLUGINS_DIR = Path(__file__).resolve().parents[3] / 'plugins'
ISSUE = {'source_platform': 'github_issues', 'id': '1', 'issue_attributes': {'updated_at': '2026-01-01T00:00:00Z'}}


def _declaring_manifests() -> list[str]:
    ids = []
    for manifest_path in sorted(PLUGINS_DIR.glob('*/manifest.json')):
        if manifest_path.parent.name.startswith('_'):
            continue
        manifest = json.loads(manifest_path.read_text())
        if (manifest.get('capabilities') or {}).get('updatesItems') is True:
            ids.append(manifest['id'])
    return ids


def test_the_suite_default_matches_the_manifests() -> None:
    assert json.loads(os.environ['UPDATE_CAPABLE_SOURCES']) == _declaring_manifests() == ['github_issues']


def test_a_declared_source_with_issue_attributes_is_update_capable() -> None:
    assert source_updates.is_update_capable(ISSUE) is True
    assert source_updates.idempotency_key_for(ISSUE).count(':') == 2


def test_issue_attributes_from_an_undeclared_source_are_not(monkeypatch: pytest.MonkeyPatch) -> None:
    assert source_updates.is_update_capable({**ISSUE, 'source_platform': 'manual_import'}) is False
    monkeypatch.setenv('UPDATE_CAPABLE_SOURCES', '["manual_import"]')
    assert source_updates.is_update_capable({**ISSUE, 'source_platform': 'manual_import'}) is True
    assert source_updates.is_update_capable(ISSUE) is False


@pytest.mark.parametrize('raw', ['', 'not json', '{"github_issues": true}', '[1, null, ""]'])
def test_an_unset_or_malformed_value_makes_no_source_update_capable(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    monkeypatch.setenv('UPDATE_CAPABLE_SOURCES', raw)
    assert source_updates.update_capable_sources() == frozenset()
    assert source_updates.is_update_capable(ISSUE) is False
    assert source_updates.idempotency_key_for(ISSUE) == 'github_issues:1'
