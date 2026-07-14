"""Tests for shared/web_search.py — AgentCore Gateway web search client.

The gateway is an external HTTP boundary, so these tests stub the signed
transport (_signed_post) and pin the protocol handling around it: JSON-RPC
envelopes, SSE-vs-JSON response bodies, the MCP result unwrapping, the
tool-name discovery fallback, input clamping, and LLM formatting.
"""

import json
from unittest.mock import patch

import pytest

from shared import web_search
from shared.web_search import (
    MAX_QUERY_LENGTH,
    WebSearchError,
    format_web_results_for_llm,
    is_web_search_configured,
    search_web,
)

GATEWAY_URL = 'https://gw-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
TOOL_NAME = 'web-search-tool___WebSearch'


def _tool_result(results: list[dict]) -> dict:
    """The gateway's tools/call result: results doc serialized inside
    content[0].text (the MCP envelope from the AWS docs)."""
    return {
        'isError': False,
        'content': [{'type': 'text', 'text': json.dumps({'id': 'abc', 'results': results})}],
    }


SAMPLE_RESULTS = [
    {
        'title': 'Python 3.13 Release Highlights',
        'url': 'https://example.com/python/releases/3.13',
        'text': 'Python 3.13 was released on October 7, 2024...',
        'publishedDate': '2024-10-07',
    },
    # Knowledge-graph observation: null title/url, structured facts in text.
    {'title': None, 'url': None, 'text': 'Founded: 1994. Founder: Jeff Bezos.'},
]


@pytest.fixture(autouse=True)
def _configure(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_GATEWAY_URL', GATEWAY_URL)
    monkeypatch.setenv('WEB_SEARCH_TOOL_NAME', TOOL_NAME)
    # The tool-name cache is per-container state; isolate every test.
    web_search._resolved_tool_name['name'] = None
    yield
    web_search._resolved_tool_name['name'] = None


class TestConfiguration:
    def test_configured_when_gateway_url_set(self):
        assert is_web_search_configured() is True

    def test_not_configured_without_gateway_url(self, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_GATEWAY_URL')
        assert is_web_search_configured() is False

    def test_search_refuses_when_unconfigured(self, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_GATEWAY_URL')
        with pytest.raises(WebSearchError, match='not configured'):
            search_web('anything')

    def test_region_parsed_from_gateway_url(self):
        assert web_search._region_from_gateway_url(GATEWAY_URL) == 'us-east-1'

    def test_region_falls_back_to_lambda_region(self, monkeypatch):
        monkeypatch.setenv('AWS_REGION', 'eu-west-1')
        assert web_search._region_from_gateway_url('https://unrelated.example.com/mcp') == 'eu-west-1'


class TestSearchWeb:
    @patch.object(web_search, '_signed_post')
    def test_calls_the_configured_tool_and_normalizes_results(self, mock_post):
        mock_post.return_value = {'jsonrpc': '2.0', 'id': 1, 'result': _tool_result(SAMPLE_RESULTS)}

        results = search_web('python 3.13 release', max_results=5)

        payload = mock_post.call_args[0][1]
        assert payload['method'] == 'tools/call'
        assert payload['params']['name'] == TOOL_NAME
        assert payload['params']['arguments'] == {'query': 'python 3.13 release', 'maxResults': 5}
        assert results == [
            {
                'title': 'Python 3.13 Release Highlights',
                'url': 'https://example.com/python/releases/3.13',
                'text': 'Python 3.13 was released on October 7, 2024...',
                'published_date': '2024-10-07',
            },
            # Knowledge-graph fact kept, with empty (not None) title/url.
            {'title': '', 'url': '', 'text': 'Founded: 1994. Founder: Jeff Bezos.', 'published_date': ''},
        ]

    @patch.object(web_search, '_signed_post')
    def test_query_is_trimmed_and_clamped_to_connector_limit(self, mock_post):
        mock_post.return_value = {'result': _tool_result([])}

        search_web('  ' + 'q' * 500 + '  ', max_results=99)

        arguments = mock_post.call_args[0][1]['params']['arguments']
        assert len(arguments['query']) == MAX_QUERY_LENGTH
        assert arguments['maxResults'] == web_search.MAX_RESULTS_CAP

    def test_empty_query_is_rejected_without_a_network_call(self):
        with patch.object(web_search, '_signed_post') as mock_post:
            with pytest.raises(WebSearchError, match='empty'):
                search_web('   ')
        mock_post.assert_not_called()

    @patch.object(web_search, '_signed_post')
    def test_jsonrpc_error_raises(self, mock_post):
        mock_post.return_value = {'error': {'code': -32000, 'message': 'throttled'}}
        with pytest.raises(WebSearchError, match='throttled'):
            search_web('query')

    @patch.object(web_search, '_signed_post')
    def test_tool_level_error_raises(self, mock_post):
        mock_post.return_value = {
            'result': {'isError': True, 'content': [{'type': 'text', 'text': 'quota exceeded'}]},
        }
        with pytest.raises(WebSearchError, match='quota exceeded'):
            search_web('query')

    @patch.object(web_search, '_signed_post')
    def test_results_missing_text_are_dropped(self, mock_post):
        mock_post.return_value = {
            'result': _tool_result([{'title': 'No text', 'url': 'https://x.example'}, SAMPLE_RESULTS[0]]),
        }
        results = search_web('query')
        assert len(results) == 1
        assert results[0]['title'] == 'Python 3.13 Release Highlights'


class TestToolNameDiscoveryFallback:
    @patch.object(web_search, '_signed_post')
    def test_unknown_tool_triggers_one_discovery_then_retry(self, mock_post):
        actual_name = 'renamed-target___WebSearch'
        mock_post.side_effect = [
            {'error': {'message': "tool 'web-search-tool___WebSearch' not found"}},
            {'result': {'tools': [{'name': 'other___Thing'}, {'name': actual_name}]}},
            {'result': _tool_result(SAMPLE_RESULTS)},
        ]

        results = search_web('query')

        methods = [call.args[1]['method'] for call in mock_post.call_args_list]
        assert methods == ['tools/call', 'tools/list', 'tools/call']
        assert mock_post.call_args_list[2].args[1]['params']['name'] == actual_name
        assert len(results) == 2
        # Cached for the rest of the container lifetime.
        assert web_search._resolved_tool_name['name'] == actual_name

    @patch.object(web_search, '_signed_post')
    def test_non_name_errors_do_not_trigger_discovery(self, mock_post):
        mock_post.return_value = {'error': {'message': 'access denied'}}
        with pytest.raises(WebSearchError, match='access denied'):
            search_web('query')
        assert mock_post.call_count == 1

    @patch.object(web_search, '_signed_post')
    def test_discovery_without_websearch_tool_raises(self, mock_post):
        mock_post.side_effect = [
            {'error': {'message': 'unknown tool'}},
            {'result': {'tools': [{'name': 'other___Thing'}]}},
        ]
        with pytest.raises(WebSearchError, match='No WebSearch tool'):
            search_web('query')


class TestResponseParsing:
    def test_plain_json_body(self):
        parsed = web_search._parse_jsonrpc_response('{"result": {"ok": true}}', 'application/json')
        assert parsed == {'result': {'ok': True}}

    def test_sse_framed_body(self):
        raw = 'event: message\ndata: {"result": {"ok": true}}\n\n'
        parsed = web_search._parse_jsonrpc_response(raw, 'text/event-stream')
        assert parsed == {'result': {'ok': True}}

    def test_sse_detected_without_content_type(self):
        raw = 'data: {"result": 1}'
        assert web_search._parse_jsonrpc_response(raw, '') == {'result': 1}

    def test_non_json_raises(self):
        with pytest.raises(WebSearchError, match='non-JSON'):
            web_search._parse_jsonrpc_response('<html>502</html>', 'text/html')

    def test_non_object_json_raises(self):
        with pytest.raises(WebSearchError, match='unexpected'):
            web_search._parse_jsonrpc_response('[1, 2]', 'application/json')


class TestFormatting:
    def test_formats_citations_with_urls_and_dates(self):
        results = [
            {'title': 'A Title', 'url': 'https://a.example', 'text': 'Snippet A', 'published_date': '2026-01-01'},
            {'title': '', 'url': '', 'text': 'A knowledge graph fact', 'published_date': ''},
        ]
        formatted = format_web_results_for_llm(results)
        assert '1. A Title (2026-01-01)' in formatted
        assert 'Source: https://a.example' in formatted
        assert '2. Knowledge graph fact' in formatted
        assert 'A knowledge graph fact' in formatted

    def test_empty_results_format_to_empty_string(self):
        assert format_web_results_for_llm([]) == ''

    def test_snippets_are_truncated(self):
        results = [{'title': 'T', 'url': 'https://t.example', 'text': 'x' * 5000, 'published_date': ''}]
        formatted = format_web_results_for_llm(results)
        assert len(formatted) < 1500
