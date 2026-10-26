"""`shared/mcp_protocol.py`: the era decision and the 2026-07-28 result shapes, without the handler."""
from __future__ import annotations

import pytest

from shared import mcp_protocol as mp

MODERN_META = {'_meta': {'io.modelcontextprotocol/protocolVersion': '2026-07-28'}}


def _headers(**values: str):
    lowered = {key.replace('_', '-').lower(): value for key, value in values.items()}
    return lowered.get


class TestIsModern:
    def test_no_version_anywhere_is_legacy(self):
        assert mp.is_modern(_headers(), 'tools/list', {}) is False

    @pytest.mark.parametrize('version', mp.LEGACY_PROTOCOL_VERSIONS)
    def test_a_legacy_header_without_meta_is_legacy(self, version: str):
        assert mp.is_modern(_headers(mcp_protocol_version=version), 'tools/list', {}) is False

    def test_a_legacy_initialize_is_never_refused_for_its_header(self):
        assert mp.is_modern(_headers(mcp_protocol_version='1999'), 'initialize', {}) is False

    def test_a_complete_modern_request_is_modern(self):
        headers = _headers(mcp_protocol_version='2026-07-28', mcp_method='tools/list')
        assert mp.is_modern(headers, 'tools/list', MODERN_META) is True

    def test_an_unknown_header_without_meta_is_unsupported(self):
        with pytest.raises(mp.ProtocolRefusal) as refused:
            mp.is_modern(_headers(mcp_protocol_version='3000-01-01'), 'tools/list', {})
        assert (refused.value.code, refused.value.data['requested']) == (mp.UNSUPPORTED_PROTOCOL_VERSION, '3000-01-01')

    def test_a_non_string_meta_version_reads_as_absent(self):
        params = {'_meta': {'io.modelcontextprotocol/protocolVersion': 20260728}}
        assert mp.body_version(params) is None
        assert mp.is_modern(_headers(), 'tools/list', params) is False


class TestDecodedHeaderValue:
    @pytest.mark.parametrize(('raw', 'decoded'), [
        ('plain', 'plain'),
        ('=?base64?SGVsbG8sIOS4lueVjA==?=', 'Hello, 世界'),
        ('=?base64??=', ''),
        ('=?base64?', '=?base64?'),
    ])
    def test_values(self, raw: str, decoded: str):
        assert mp.decoded_header_value(raw) == decoded

    @pytest.mark.parametrize('raw', ['=?base64?not base64!?=', '=?base64?/w==?='])
    def test_an_invalid_sentinel_is_a_header_mismatch(self, raw: str):
        with pytest.raises(mp.ProtocolRefusal) as refused:
            mp.decoded_header_value(raw)
        assert refused.value.code == mp.HEADER_MISMATCH


class TestModernResult:
    def test_only_tools_list_gets_cache_hints(self):
        assert 'ttlMs' not in mp.modern_result({}, 'tools/call', name='n', version='1')
        listed = mp.modern_result({'tools': []}, 'tools/list', name='n', version='1')
        assert (listed['ttlMs'], listed['cacheScope']) == (mp.TOOLS_LIST_TTL_MS, 'private')

    def test_the_result_own_keys_and_meta_win(self):
        out = mp.modern_result({'resultType': 'input_required', '_meta': {'x/y': 1}}, 'tools/call',
                               name='n', version='1')
        assert out['resultType'] == 'input_required'
        assert out['_meta'] == {'io.modelcontextprotocol/serverInfo': {'name': 'n', 'version': '1'}, 'x/y': 1}

    def test_every_supported_version_is_listed_newest_era_first(self):
        assert mp.SUPPORTED_PROTOCOL_VERSIONS[0] == '2026-07-28'
        assert set(mp.SUPPORTED_PROTOCOL_VERSIONS) == {*mp.MODERN_PROTOCOL_VERSIONS, *mp.LEGACY_PROTOCOL_VERSIONS}
