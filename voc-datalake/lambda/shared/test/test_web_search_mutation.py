"""Mutation hardening for `shared/web_search.py`.

`test_web_search.py` stubs `_signed_post` and pins the protocol handling
around it with `match=` fragments and relative assertions. A mutation run
found what that cannot see:

* the signed transport itself: `_signed_post` was never executed, so the
  HTTP method, the Content-Type/Accept headers, the UTF-8 body, the
  `bedrock-agentcore` service and gateway region in the SigV4 scope, the
  20-second timeout and the `Gateway request failed:` wrapper were all free
  to drift. They are pinned here against a frozen-clock signature.
* the WORDING of every WebSearchError, which callers log and the research
  job surfaces as the reason web grounding was skipped — pinned as the full
  string, including the 200/300-character truncation of gateway detail.
* the literal protocol constants: a 200-character query cap, a default of 8
  results, a cap of 10, `jsonrpc: 2.0` / `id: 1`, `maxResults` (not any
  other key), and the `_resolved_tool_name` / `_credentials_cache` dict
  shapes that container-lifetime caching relies on.
* the exact LLM formatting: header, `(date)`, `Source:` line, 1200-character
  snippet and the blank line between entries, as one literal string.
"""

import json
import urllib.error
from collections.abc import Sequence
from datetime import UTC, datetime
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.credentials import Credentials

from shared import web_search
from shared.web_search import WebSearchError, format_web_results_for_llm, search_web

GATEWAY_URL = 'https://gw-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'
WEST_GATEWAY_URL = 'https://gw-abc123.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp'
TOOL_NAME = 'web-search-tool___WebSearch'


def _tool_result(results: Sequence[object]) -> dict:
    """A tool result whose payload carries ``results`` verbatim — including
    deliberately malformed (non-dict) observations."""
    return {
        'isError': False,
        'content': [{'type': 'text', 'text': json.dumps({'id': 'abc', 'results': results})}],
    }


def _ok(results: list[dict]) -> dict:
    return {'jsonrpc': '2.0', 'id': 1, 'result': _tool_result(results)}


ONE_RESULT = [{'title': 'T', 'url': 'https://t.example', 'text': 'body', 'publishedDate': '2026-01-01'}]


@pytest.fixture(autouse=True)
def _configure(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_GATEWAY_URL', GATEWAY_URL)
    monkeypatch.setenv('WEB_SEARCH_TOOL_NAME', TOOL_NAME)
    monkeypatch.delenv('AWS_REGION', raising=False)
    web_search._resolved_tool_name['name'] = None
    web_search._credentials_cache['credentials'] = None
    yield
    web_search._resolved_tool_name['name'] = None
    web_search._credentials_cache['credentials'] = None


class TestProtocolConstants:
    def test_connector_limits_are_the_documented_literals(self):
        assert web_search.MAX_QUERY_LENGTH == 200
        assert web_search.DEFAULT_MAX_RESULTS == 8
        assert web_search.MAX_RESULTS_CAP == 10
        assert web_search._REQUEST_TIMEOUT_SECONDS == 20

    @patch.object(web_search, '_signed_post')
    def test_query_is_cut_to_exactly_200_characters(self, mock_post):
        mock_post.return_value = _ok([])
        search_web('  ' + 'q' * 500 + '  ')
        assert mock_post.call_args.args[1]['params']['arguments']['query'] == 'q' * 200

    @pytest.mark.parametrize(('requested', 'sent'), [(0, 1), (1, 1), (2, 2), (9, 9), (10, 10), (11, 10), (99, 10)])
    @patch.object(web_search, '_signed_post')
    def test_max_results_is_clamped_to_1_through_10(self, mock_post, requested, sent):
        mock_post.return_value = _ok([])
        search_web('query', max_results=requested)
        assert mock_post.call_args.args[1]['params']['arguments'] == {'query': 'query', 'maxResults': sent}

    @patch.object(web_search, '_signed_post')
    def test_default_is_8_results(self, mock_post):
        mock_post.return_value = _ok([])
        search_web('query')
        assert mock_post.call_args.args[1]['params']['arguments'] == {'query': 'query', 'maxResults': 8}

    @patch.object(web_search, '_signed_post')
    def test_rpc_envelope_is_jsonrpc_2_0_id_1_to_the_configured_gateway(self, mock_post):
        mock_post.return_value = _ok([])
        search_web('query')
        mock_post.assert_called_once_with(GATEWAY_URL, {
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'tools/call',
            'params': {'name': TOOL_NAME, 'arguments': {'query': 'query', 'maxResults': 8}},
        })

    def test_search_web_is_traced(self):
        # Read through the function's __dict__: functools.wraps stores the
        # original there, and a missing key fails the test just as loudly.
        assert vars(web_search.search_web)['__wrapped__'].__qualname__ == 'search_web'


class TestEnvironmentWiring:
    def test_gateway_url_is_read_from_its_variable(self, monkeypatch):
        assert web_search._gateway_url() == GATEWAY_URL
        monkeypatch.delenv('WEB_SEARCH_GATEWAY_URL')
        assert web_search._gateway_url() == ''

    def test_tool_name_is_read_from_its_variable_with_the_aws_default(self, monkeypatch):
        monkeypatch.setenv('WEB_SEARCH_TOOL_NAME', 'custom___WebSearch')
        assert web_search._configured_tool_name() == 'custom___WebSearch'
        monkeypatch.delenv('WEB_SEARCH_TOOL_NAME')
        assert web_search._configured_tool_name() == 'web-search-tool___WebSearch'

    def test_region_comes_from_the_gateway_host_not_the_lambda(self, monkeypatch):
        monkeypatch.setenv('AWS_REGION', 'eu-central-1')
        assert web_search._region_from_gateway_url(WEST_GATEWAY_URL) == 'us-west-2'

    def test_region_falls_back_to_us_east_1_without_aws_region(self):
        assert web_search._region_from_gateway_url('https://unrelated.example.com/mcp') == 'us-east-1'

    def test_hostless_url_falls_back_instead_of_crashing(self, monkeypatch):
        monkeypatch.setenv('AWS_REGION', 'eu-west-1')
        assert web_search._region_from_gateway_url('not-a-url') == 'eu-west-1'


class TestCredentialCache:
    def test_credentials_resolve_once_and_are_cached_under_their_key(self):
        creds = Credentials('AK', 'SK')
        with patch.object(web_search.boto3.session, 'Session') as session_cls:
            session_cls.return_value.get_credentials.return_value = creds
            first = web_search._get_credentials()
            second = web_search._get_credentials()
        assert first is creds
        assert second is creds
        session_cls.assert_called_once_with()
        assert web_search._credentials_cache == {'credentials': creds}

    def test_missing_credentials_refuse_to_sign(self):
        with patch.object(web_search, '_get_credentials', return_value=None), \
                patch.object(web_search.urllib.request, 'urlopen') as urlopen, \
                pytest.raises(WebSearchError) as exc_info:
            web_search._signed_post(GATEWAY_URL, {})
        assert str(exc_info.value) == 'No AWS credentials available to sign the gateway request'
        urlopen.assert_not_called()


FROZEN_NOW = datetime(2026, 3, 4, 5, 6, 7, tzinfo=UTC)
PAYLOAD = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}
EXPECTED_AUTHORIZATION = (
    'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260304/us-west-2/bedrock-agentcore/aws4_request, '
    'SignedHeaders=accept;content-type;host;x-amz-date, '
    'Signature=260ad47fa5cb2a4ca22c92fe2c6b8a08ad8f44627adb9a5933800b329af48bbe'
)


def _http_response(body: bytes, headers: dict) -> MagicMock:
    response = MagicMock()
    response.__enter__.return_value = response
    response.headers = headers
    response.read.return_value = body
    return response


class TestSignedTransport:
    @pytest.fixture(autouse=True)
    def _freeze_signing_inputs(self):
        web_search._credentials_cache['credentials'] = Credentials(
            'AKIAEXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        )
        with patch('botocore.auth.get_current_datetime', return_value=FROZEN_NOW):
            yield

    def test_posts_the_utf8_json_body_with_a_sigv4_signature_for_the_gateway_region(self):
        response = _http_response(b'{"result": {"tools": []}}', {'Content-Type': 'application/json'})
        with patch.object(web_search.urllib.request, 'urlopen', return_value=response) as urlopen:
            result = web_search._signed_post(WEST_GATEWAY_URL, PAYLOAD)

        assert result == {'result': {'tools': []}}
        assert urlopen.call_args.kwargs == {'timeout': 20}
        request = urlopen.call_args.args[0]
        assert request.full_url == WEST_GATEWAY_URL
        assert request.get_method() == 'POST'
        assert request.data == b'{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}'
        assert request.headers == {
            'Content-type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'X-amz-date': '20260304T050607Z',
            'Authorization': EXPECTED_AUTHORIZATION,
        }

    def test_sse_content_type_header_selects_sse_parsing(self):
        body = b': keepalive\ndata: {"result": {"ok": 1}}\n\n'
        response = _http_response(body, {'Content-Type': 'text/event-stream'})
        with patch.object(web_search.urllib.request, 'urlopen', return_value=response):
            assert web_search._signed_post(WEST_GATEWAY_URL, PAYLOAD) == {'result': {'ok': 1}}

    def test_transport_failure_is_wrapped_with_its_cause(self):
        with patch.object(web_search.urllib.request, 'urlopen', side_effect=urllib.error.URLError('boom')), \
                pytest.raises(WebSearchError) as exc_info:
            web_search._signed_post(WEST_GATEWAY_URL, PAYLOAD)
        assert str(exc_info.value) == 'Gateway request failed: <urlopen error boom>'
        assert isinstance(exc_info.value.__cause__, urllib.error.URLError)


class TestResponseParsing:
    def test_first_data_frame_wins(self):
        raw = 'data: {"result": 1}\ndata: {"result": 2}'
        assert web_search._parse_jsonrpc_response(raw, 'text/event-stream') == {'result': 1}

    def test_event_prefix_alone_marks_sse(self):
        raw = 'event: message\ndata: {"result": 1}'
        assert web_search._parse_jsonrpc_response(raw, '') == {'result': 1}

    def test_comment_only_sse_body_is_sse_because_of_the_header(self):
        raw = ': hi\ndata: {"result": 1}'
        assert web_search._parse_jsonrpc_response(raw, 'text/event-stream; charset=utf-8') == {'result': 1}
        with pytest.raises(WebSearchError):
            web_search._parse_jsonrpc_response(raw, 'application/json')

    def test_non_json_message_quotes_exactly_200_characters(self):
        with pytest.raises(WebSearchError) as exc_info:
            web_search._parse_jsonrpc_response('<' * 300, 'text/html')
        assert str(exc_info.value) == 'Gateway returned non-JSON response: ' + '<' * 200

    def test_non_object_message(self):
        with pytest.raises(WebSearchError) as exc_info:
            web_search._parse_jsonrpc_response('[1]', 'application/json')
        assert str(exc_info.value) == 'Gateway returned unexpected JSON-RPC shape'


class TestEveryRpcRefusalNamesItsCause:
    @pytest.mark.parametrize(('response', 'message'), [
        ({'error': {'code': -32000, 'message': 'throttled'}}, 'Gateway tools/call error: throttled'),
        ({'error': {'code': -32000}}, "Gateway tools/call error: {'code': -32000}"),
        ({'error': 'access denied'}, 'Gateway tools/call error: access denied'),
        ({'result': None}, 'Gateway tools/call returned no result'),
        ({'jsonrpc': '2.0', 'id': 1}, 'Gateway tools/call returned no result'),
        ({'result': 'text'}, 'Gateway tools/call returned no result'),
    ])
    @patch.object(web_search, '_signed_post')
    def test_tools_call(self, mock_post, response, message):
        mock_post.return_value = response
        with pytest.raises(WebSearchError) as exc_info:
            search_web('query')
        assert str(exc_info.value) == message

    @patch.object(web_search, '_signed_post')
    def test_tools_list_names_its_own_method(self, mock_post):
        mock_post.side_effect = [{'error': {'message': 'unknown tool'}}, {'result': []}]
        with pytest.raises(WebSearchError) as exc_info:
            search_web('query')
        assert str(exc_info.value) == 'Gateway tools/list returned no result'


class TestEveryToolResultRefusalNamesItsCause:
    @pytest.mark.parametrize(('tool_result', 'message'), [
        ({'isError': True, 'content': [{'type': 'text', 'text': 'quota exceeded'}]},
         'Web search tool error: quota exceeded'),
        ({'isError': True, 'content': [{'type': 'text', 'text': 'x' * 400}]},
         'Web search tool error: ' + 'x' * 300),
        ({'isError': True, 'content': [{'type': 'text'}]}, 'Web search tool error: '),
        ({'isError': True, 'content': []}, 'Web search tool error: '),
        ({'isError': True, 'content': ['plain']}, 'Web search tool error: '),
        ({'isError': True}, 'Web search tool error: '),
        ({'content': []}, 'Web search returned an empty MCP content block'),
        ({'content': ['plain']}, 'Web search returned an empty MCP content block'),
        ({}, 'Web search returned an empty MCP content block'),
        ({'content': [{'type': 'text', 'text': 'not json'}]}, 'Web search returned non-JSON result text'),
        ({'content': [{'type': 'text'}]}, 'Web search returned non-JSON result text'),
    ])
    def test_message(self, tool_result, message):
        with pytest.raises(WebSearchError) as exc_info:
            web_search._extract_results(tool_result)
        assert str(exc_info.value) == message

    def test_non_dict_observations_are_skipped_not_terminal(self):
        tool_result = _tool_result([5, 'str', {'text': ''}, {'text': None}, {'title': 'no text'}, {'title': 'T', 'text': 'kept'}])
        assert web_search._extract_results(tool_result) == [
            {'title': 'T', 'url': '', 'text': 'kept', 'published_date': ''},
        ]

    def test_non_object_payload_yields_no_results(self):
        assert web_search._extract_results({'content': [{'text': '[1, 2]'}]}) == []


class TestSearchWebRefusals:
    def test_unconfigured_message(self, monkeypatch):
        monkeypatch.delenv('WEB_SEARCH_GATEWAY_URL')
        with pytest.raises(WebSearchError) as exc_info:
            search_web('query')
        assert str(exc_info.value) == 'Web search is not configured (WEB_SEARCH_GATEWAY_URL unset)'

    def test_empty_query_message(self):
        with pytest.raises(WebSearchError) as exc_info:
            search_web(' \n ')
        assert str(exc_info.value) == 'Web search query is empty'


class TestToolNameResolution:
    @patch.object(web_search, '_signed_post')
    def test_success_caches_the_configured_name_under_name(self, mock_post):
        mock_post.return_value = _ok(ONE_RESULT)
        with patch.object(web_search.logger, 'info') as info:
            search_web('query')
        assert web_search._resolved_tool_name == {'name': TOOL_NAME}
        assert info.call_args_list == [call('Web search returned 1 results for query (5 chars)')]

    @patch.object(web_search, '_signed_post')
    def test_discovery_logs_retries_with_the_same_arguments_and_caches(self, mock_post):
        mock_post.side_effect = [
            {'error': {'message': "Tool 'x' not found"}},
            {'result': {'tools': ['garbage', {'type': 'tool'}, {'name': 'other___Thing'}, {'name': 'new___WebSearch'}]}},
            _ok(ONE_RESULT),
        ]
        with patch.object(web_search.logger, 'info') as info:
            results = search_web('query', max_results=3)

        assert results == [{'title': 'T', 'url': 'https://t.example', 'text': 'body', 'published_date': '2026-01-01'}]
        assert mock_post.call_args_list[1].args[1] == {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}
        assert mock_post.call_args_list[2].args[1]['params'] == {
            'name': 'new___WebSearch',
            'arguments': {'query': 'query', 'maxResults': 3},
        }
        assert web_search._resolved_tool_name == {'name': 'new___WebSearch'}
        assert info.call_args_list == [
            call('Web search tool name resolved via tools/list: new___WebSearch'),
            call('Web search returned 1 results for query (5 chars)'),
        ]

    @pytest.mark.parametrize('tools', [
        [{'name': 'other___Thing'}],
        [{'type': 'tool'}],
        ['garbage'],
        [],
    ])
    @patch.object(web_search, '_signed_post')
    def test_no_websearch_tool_message(self, mock_post, tools):
        mock_post.side_effect = [{'error': {'message': 'unknown tool'}}, {'result': {'tools': tools}}]
        with pytest.raises(WebSearchError) as exc_info:
            search_web('query')
        assert str(exc_info.value) == 'No WebSearch tool exposed by the gateway'

    @pytest.mark.parametrize(('message', 'is_unknown_tool'), [
        ("tool 'x' not found", True),
        ('Unknown tool: x', True),
        ('tool quota exceeded', False),
        ('resource not found', False),
    ])
    def test_unknown_tool_detection(self, message, is_unknown_tool):
        assert web_search._is_unknown_tool_error(WebSearchError(message)) is is_unknown_tool


class TestLlmFormatting:
    def test_exact_layout(self):
        results = [
            {'title': 'A Title', 'url': 'https://a.example', 'text': 'Snippet A', 'published_date': '2026-01-01'},
            {'title': '', 'url': '', 'text': 'A fact', 'published_date': ''},
            {'title': 'No text'},
        ]
        assert format_web_results_for_llm(results) == (
            '1. A Title (2026-01-01)\n   Source: https://a.example\n   Snippet A'
            '\n\n'
            '2. Knowledge graph fact\n   A fact'
            '\n\n'
            '3. No text\n   '
        )

    def test_snippet_is_cut_to_exactly_1200_characters(self):
        formatted = format_web_results_for_llm([{'title': 'T', 'text': 'x' * 1300}])
        assert formatted == '1. T\n   ' + 'x' * 1200
