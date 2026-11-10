"""The optional connector filters (web-search connector 1.2.0+) on search_web.

An unfiltered call must keep sending exactly ``{query, maxResults}`` — that
shape is pinned in test_web_search_mutation.py; these cases pin the filtered one.
"""
import json
from unittest.mock import patch

import pytest

from shared import web_search
from shared.web_search import WebSearchError, build_filters, search_web

GATEWAY_URL = 'https://gw-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'


@pytest.fixture(autouse=True)
def _configure(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_GATEWAY_URL', GATEWAY_URL)
    monkeypatch.setenv('WEB_SEARCH_TOOL_NAME', 'web-search-tool___WebSearch')
    web_search._resolved_tool_name['name'] = None
    yield
    web_search._resolved_tool_name['name'] = None


def _ok() -> dict:
    text = json.dumps({'id': 'x', 'results': []})
    return {'jsonrpc': '2.0', 'id': 1, 'result': {'isError': False, 'content': [{'type': 'text', 'text': text}]}}


class TestBuildFilters:
    def test_no_filters_is_empty(self):
        assert build_filters() == {}

    def test_full_shape(self):
        assert build_filters(include_domains=['WWW.Example.com', 'example.com', 'docs.example.org'],
                             exclude_domains=['spam.example.net'],
                             published_after='2026-07-01', published_before='2026-10-01T12:00:00Z') == {
            'domainFilter': {'include': ['example.com', 'docs.example.org'], 'exclude': ['spam.example.net']},
            'publishedDateFilter': {'from': '2026-07-01T00:00:00Z', 'to': '2026-10-01T12:00:00Z'},
        }

    @pytest.mark.parametrize('bad', ['https://example.com', 'exa mple.com', 'localhost', ''])
    def test_rejects_non_domains(self, bad):
        with pytest.raises(WebSearchError, match='include_domains entry is not a domain name'):
            build_filters(include_domains=[bad])

    def test_rejects_too_many_domains(self):
        with pytest.raises(WebSearchError, match='exclude_domains may hold at most 100 domains'):
            build_filters(exclude_domains=[f'd{i}.example.com' for i in range(101)])

    @pytest.mark.parametrize('bad', ['July 2026', '2026-07-01T00:00:00', '2026/07/01'])
    def test_rejects_non_iso_dates(self, bad):
        with pytest.raises(WebSearchError, match='published_after must be YYYY-MM-DD'):
            build_filters(published_after=bad)


class TestSearchWebSendsFilters:
    @patch.object(web_search, '_signed_post')
    def test_filters_ride_the_arguments(self, mock_post):
        mock_post.return_value = _ok()
        search_web('acme new features', max_results=5, published_after='2026-07-01')
        assert mock_post.call_args.args[1]['params']['arguments'] == {
            'query': 'acme new features', 'maxResults': 5,
            'filters': {'publishedDateFilter': {'from': '2026-07-01T00:00:00Z'}},
        }

    @patch.object(web_search, '_signed_post')
    def test_bad_filter_never_calls_the_gateway(self, mock_post):
        with pytest.raises(WebSearchError):
            search_web('q', include_domains=['not a domain'])
        mock_post.assert_not_called()
