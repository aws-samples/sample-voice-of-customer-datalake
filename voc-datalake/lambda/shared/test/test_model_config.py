"""
Tests for shared/model_config.py — runtime Bedrock model selection (issue #96).
"""
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shared.model_config import (  # noqa: E402
    ALLOWED_MODEL_IDS, clear_model_cache, get_active_model_id,
)
from shared.aws import BEDROCK_MODEL_ID  # noqa: E402

SONNET = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


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

    def test_allowlist_has_sonnet_and_haiku(self):
        assert SONNET in ALLOWED_MODEL_IDS
        assert HAIKU in ALLOWED_MODEL_IDS


class TestGetActiveModelId:
    def test_returns_default_without_table_env(self, monkeypatch):
        monkeypatch.delenv('AGGREGATES_TABLE', raising=False)
        assert get_active_model_id() == BEDROCK_MODEL_ID

    def test_returns_configured_allowlisted_model(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({'model_id': HAIKU})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id() == HAIKU

    def test_rejects_model_outside_allowlist(self, monkeypatch):
        """A tampered or stale DB value must not reach Bedrock."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, _ = _table_returning({'model_id': 'anthropic.evil-model-v9'})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id() == BEDROCK_MODEL_ID

    def test_falls_back_to_default_when_lookup_fails(self, monkeypatch):
        """No read permission / throttling must never break inference."""
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource = MagicMock()
        resource.Table.return_value.get_item.side_effect = Exception('AccessDenied')
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id() == BEDROCK_MODEL_ID

    def test_caches_lookup_within_ttl(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, table = _table_returning({'model_id': HAIKU})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            assert get_active_model_id() == HAIKU
            assert get_active_model_id() == HAIKU
        assert table.get_item.call_count == 1

    def test_clear_cache_forces_refetch(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
        resource, table = _table_returning({'model_id': HAIKU})
        with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
            get_active_model_id()
            clear_model_cache()
            get_active_model_id()
        assert table.get_item.call_count == 2



class TestAllowlistLockstep:
    """The allowlist exists in three places; drift AccessDenies at runtime.

    Python (this module) drives REST-API inference, the TS mirror drives
    streaming chat, and the CDK helper grants the IAM invoke permissions.
    These tests read the other two sources so a model added to one place
    fails the build until all three agree (review feedback on #154).
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
        ts_ids = set(re.findall(r"'(global\.anthropic\.[^']+)'", ts_source))
        assert ts_ids == ALLOWED_MODEL_IDS

    def test_cdk_iam_grants_cover_every_allowlisted_model(self):
        import re
        cdk_source = (
            self._repo_root() / 'lib' / 'stacks' / 'api-stack.ts'
        ).read_text()
        helper_start = cdk_source.index('private allowlistedModelArns()')
        # Slice generously to the next method; `${...}` braces defeat naive
        # matching of the closing brace.
        helper_body = cdk_source[helper_start:helper_start + 1500]
        granted = set(re.findall(r'inference-profile/(global\.anthropic\.[^`\']+)', helper_body))
        assert granted == ALLOWED_MODEL_IDS
