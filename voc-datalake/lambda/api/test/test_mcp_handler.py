"""
Tests for mcp_handler.py — MCP JSON-RPC server Lambda handler.
"""

import json
import hashlib
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TOKEN_PREFIX = 'voc_'
RAW_TOKEN = f'{TOKEN_PREFIX}test_secret_token_12345'
TOKEN_HASH = hashlib.sha256(RAW_TOKEN.encode()).hexdigest()

PROJECT_ID = 'proj_abc123'


def _make_event(
    method='POST',
    body=None,
    headers=None,
    resource='/mcp',
    path_params=None,
    query_params=None,
):
    """Build a minimal API Gateway proxy event."""
    return {
        'httpMethod': method,
        'resource': resource,
        'path': resource,
        'body': json.dumps(body) if body else None,
        'headers': headers or {},
        'pathParameters': path_params or {},
        'queryStringParameters': query_params or {},
        'requestContext': {'requestId': 'req-1', 'stage': 'test'},
        'isBase64Encoded': False,
    }


def _auth_headers():
    """Headers with valid Bearer token and project ID."""
    return {
        'authorization': f'Bearer {RAW_TOKEN}',
        'x-project-id': PROJECT_ID,
    }


def _jsonrpc_body(method, params=None, req_id=1):
    return {'jsonrpc': '2.0', 'id': req_id, 'method': method, 'params': params or {}}


def _parse(response):
    """Parse Lambda proxy response body."""
    return json.loads(response['body'])


# ---------------------------------------------------------------------------
# Module-level mocks — mcp_handler reads tables at import time
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _patch_module_globals():
    """Patch module-level DynamoDB tables and autoseed import."""
    mock_projects = MagicMock()
    mock_feedback = MagicMock()
    mock_aggregates = MagicMock()

    with patch('mcp_handler.projects_table', mock_projects), \
         patch('mcp_handler.feedback_table', mock_feedback), \
         patch('mcp_handler.aggregates_table', mock_aggregates):
        yield {
            'projects': mock_projects,
            'feedback': mock_feedback,
            'aggregates': mock_aggregates,
        }


@pytest.fixture
def tables(_patch_module_globals):
    return _patch_module_globals


# ---------------------------------------------------------------------------
# CORS & basic routing
# ---------------------------------------------------------------------------

class TestCorsAndRouting:

    def test_options_returns_200(self):
        from mcp_handler import lambda_handler
        resp = lambda_handler(_make_event(method='OPTIONS'), MagicMock())
        assert resp['statusCode'] == 200
        assert 'Access-Control-Allow-Origin' in resp['headers']

    def test_get_non_autoseed_returns_405(self):
        from mcp_handler import lambda_handler
        resp = lambda_handler(_make_event(method='GET', resource='/mcp'), MagicMock())
        assert resp['statusCode'] == 405

    def test_invalid_json_body_returns_400(self):
        from mcp_handler import lambda_handler
        event = _make_event()
        event['body'] = 'not json{'
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 400
        assert 'Parse error' in _parse(resp)['error']['message']


    def test_unknown_method_returns_error(self):
        from mcp_handler import lambda_handler
        event = _make_event(body=_jsonrpc_body('unknown/method'))
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 200
        body = _parse(resp)
        assert body['error']['code'] == -32601


# ---------------------------------------------------------------------------
# Non-auth MCP methods (initialize, ping, notifications)
# ---------------------------------------------------------------------------

class TestNonAuthMethods:

    def test_initialize(self):
        from mcp_handler import lambda_handler
        event = _make_event(body=_jsonrpc_body('initialize'))
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        assert 'result' in body
        assert body['result']['protocolVersion'] == '2024-11-05'
        assert body['result']['serverInfo']['name'] == 'voc-datalake'

    def test_ping(self):
        from mcp_handler import lambda_handler
        event = _make_event(body=_jsonrpc_body('ping'))
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        assert body['result'] == {}

    def test_notification_initialized(self):
        from mcp_handler import lambda_handler
        event = _make_event(body=_jsonrpc_body('notifications/initialized'))
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        assert 'result' in body


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

class TestAuthentication:

    def test_missing_auth_header_returns_none(self):
        from mcp_handler import _authenticate
        assert _authenticate(_make_event(headers={})) is None

    def test_missing_project_id_returns_none(self):
        from mcp_handler import _authenticate
        event = _make_event(headers={'authorization': f'Bearer {RAW_TOKEN}'})
        assert _authenticate(event) is None

    def test_wrong_token_prefix_returns_none(self):
        from mcp_handler import _authenticate
        event = _make_event(headers={
            'authorization': 'Bearer wrong_prefix_token',
            'x-project-id': PROJECT_ID,
        })
        assert _authenticate(event) is None


    def test_no_projects_table_returns_none(self):
        from mcp_handler import _authenticate
        with patch('mcp_handler.projects_table', None):
            event = _make_event(headers=_auth_headers())
            assert _authenticate(event) is None

    def test_no_matching_hash_returns_none(self, tables):
        from mcp_handler import _authenticate
        tables['projects'].query.return_value = {
            'Items': [{'sk': 'TOKEN#t1', 'token_hash': 'wrong_hash'}]
        }
        event = _make_event(headers=_auth_headers())
        assert _authenticate(event) is None

    def test_valid_token_returns_item(self, tables):
        from mcp_handler import _authenticate
        tables['projects'].query.return_value = {
            'Items': [{'sk': 'TOKEN#t1', 'token_hash': TOKEN_HASH, 'scope': 'read'}]
        }
        event = _make_event(headers=_auth_headers())
        result = _authenticate(event)
        assert result is not None
        assert result['project_id'] == PROJECT_ID
        assert result['scope'] == 'read'

    def test_update_last_used_failure_does_not_break(self, tables):
        from mcp_handler import _authenticate
        tables['projects'].query.return_value = {
            'Items': [{'sk': 'TOKEN#t1', 'token_hash': TOKEN_HASH}]
        }
        tables['projects'].update_item.side_effect = Exception("DDB error")
        event = _make_event(headers=_auth_headers())
        result = _authenticate(event)
        assert result is not None

    def test_auth_methods_require_token(self):
        from mcp_handler import lambda_handler
        event = _make_event(
            body=_jsonrpc_body('tools/list'),
            headers={},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 401


# ---------------------------------------------------------------------------
# tools/list
# ---------------------------------------------------------------------------

class TestToolsList:

    @patch('mcp_handler._authenticate')
    def test_returns_tool_definitions(self, mock_auth):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        event = _make_event(body=_jsonrpc_body('tools/list'), headers=_auth_headers())
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        tools = body['result']['tools']
        names = [t['name'] for t in tools]
        assert 'search_feedback' in names
        assert 'get_metrics_summary' in names
        assert 'get_project' in names
        assert 'list_personas' in names
        assert 'get_feedback_detail' in names


# ---------------------------------------------------------------------------
# tools/call — search_feedback
# ---------------------------------------------------------------------------

class TestToolSearchFeedback:

    def test_no_feedback_table(self):
        from mcp_handler import _tool_search_feedback
        with patch('mcp_handler.feedback_table', None):
            result = _tool_search_feedback({}, {})
        assert 'not configured' in result[0]['text']

    def test_returns_items_by_date(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {
            'Items': [{
                'id': 'f1',
                'source_platform': 'webscraper',
                'original_text': 'Great product',
                'sentiment_label': 'positive',
                'sentiment_score': 0.9,
                'category': 'product_quality',
                'urgency': 'low',
                'source_created_at': '2026-03-20T00:00:00Z',
            }]
        }
        result = _tool_search_feedback({'days': 1}, {})
        parsed = json.loads(result[0]['text'])
        assert len(parsed) == 1
        assert parsed[0]['id'] == 'f1'

    def test_filters_by_category_only(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {
            'Items': [{'id': 'f1', 'category': 'delivery', 'original_text': 'Late'}]
        }
        result = _tool_search_feedback({'category': 'delivery'}, {})
        parsed = json.loads(result[0]['text'])
        assert len(parsed) >= 1

    def test_filters_by_source_and_category(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {
            'Items': [
                {'id': 'f1', 'source_platform': 'webscraper', 'category': 'delivery', 'original_text': 'Late'},
                {'id': 'f2', 'source_platform': 'manual', 'category': 'delivery', 'original_text': 'Slow'},
            ]
        }
        result = _tool_search_feedback({'source': 'webscraper', 'category': 'delivery'}, {})
        parsed = json.loads(result[0]['text'])
        assert all(r['source'] == 'webscraper' for r in parsed)

    def test_filters_by_sentiment(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {
            'Items': [
                {'id': 'f1', 'sentiment_label': 'positive', 'original_text': 'Good'},
                {'id': 'f2', 'sentiment_label': 'negative', 'original_text': 'Bad'},
            ]
        }
        result = _tool_search_feedback({'sentiment': 'negative'}, {})
        parsed = json.loads(result[0]['text'])
        assert all(r['sentiment'] == 'negative' for r in parsed)

    def test_filters_by_query_text(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {
            'Items': [
                {'id': 'f1', 'original_text': 'Delivery was slow'},
                {'id': 'f2', 'original_text': 'Great product'},
            ]
        }
        result = _tool_search_feedback({'query': 'delivery', 'days': 1}, {})
        parsed = json.loads(result[0]['text'])
        assert len(parsed) == 1

    def test_no_results_message(self, tables):
        from mcp_handler import _tool_search_feedback
        tables['feedback'].query.return_value = {'Items': []}
        result = _tool_search_feedback({'query': 'nonexistent'}, {})
        assert 'No feedback items found' in result[0]['text']


    def test_early_break_on_large_result_set(self, tables):
        from mcp_handler import _tool_search_feedback
        # Return enough items to trigger the early break (limit * 5)
        big_list = [{'id': f'f{i}', 'original_text': f'Item {i}'} for i in range(120)]
        tables['feedback'].query.return_value = {'Items': big_list}
        result = _tool_search_feedback({'days': 3, 'limit': 5}, {})
        parsed = json.loads(result[0]['text'])
        assert len(parsed) <= 5


# ---------------------------------------------------------------------------
# tools/call — get_metrics_summary
# ---------------------------------------------------------------------------

class TestToolGetMetricsSummary:

    def test_no_aggregates_table(self):
        from mcp_handler import _tool_get_metrics_summary
        with patch('mcp_handler.aggregates_table', None):
            result = _tool_get_metrics_summary({}, {})
        assert 'not configured' in result[0]['text']

    def test_returns_summary(self, tables):
        from mcp_handler import _tool_get_metrics_summary
        tables['aggregates'].get_item.return_value = {'Item': {'count': 10}}
        tables['aggregates'].query.return_value = {
            'Items': [{'categories': {'delivery': 5, 'pricing': 3}}]
        }
        result = _tool_get_metrics_summary({'days': 1}, {})
        parsed = json.loads(result[0]['text'])
        assert parsed['period_days'] == 1
        assert 'total_feedback' in parsed
        assert 'sentiment_breakdown' in parsed
        assert 'top_categories' in parsed

    def test_handles_exceptions_gracefully(self, tables):
        from mcp_handler import _tool_get_metrics_summary
        tables['aggregates'].get_item.side_effect = Exception("DDB error")
        tables['aggregates'].query.side_effect = Exception("DDB error")
        result = _tool_get_metrics_summary({'days': 1}, {})
        parsed = json.loads(result[0]['text'])
        assert parsed['total_feedback'] == 0


# ---------------------------------------------------------------------------
# tools/call — get_project
# ---------------------------------------------------------------------------

class TestToolGetProject:

    def test_no_projects_table(self):
        from mcp_handler import _tool_get_project
        with patch('mcp_handler.projects_table', None):
            result = _tool_get_project({}, {'project_id': PROJECT_ID})
        assert 'not configured' in result[0]['text']

    def test_project_not_found(self, tables):
        from mcp_handler import _tool_get_project
        tables['projects'].query.return_value = {'Items': []}
        result = _tool_get_project({}, {'project_id': PROJECT_ID})
        assert 'not found' in result[0]['text']

    def test_returns_project_with_personas_and_docs(self, tables):
        from mcp_handler import _tool_get_project
        tables['projects'].query.return_value = {
            'Items': [
                {'sk': 'META', 'name': 'Test Project', 'description': 'Desc', 'created_at': '2026-01-01'},
                {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'Alice', 'type': 'buyer'},
                {'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'PRD v1', 'type': 'prd'},
                {'sk': 'PRFAQ#d2', 'document_id': 'd2', 'title': 'FAQ', 'type': 'prfaq'},
            ]
        }
        result = _tool_get_project({}, {'project_id': PROJECT_ID})
        parsed = json.loads(result[0]['text'])
        assert parsed['name'] == 'Test Project'
        assert parsed['persona_count'] == 1
        assert parsed['document_count'] == 2


# ---------------------------------------------------------------------------
# tools/call — list_personas
# ---------------------------------------------------------------------------

class TestToolListPersonas:

    def test_no_projects_table(self):
        from mcp_handler import _tool_list_personas
        with patch('mcp_handler.projects_table', None):
            result = _tool_list_personas({}, {'project_id': PROJECT_ID})
        assert 'not configured' in result[0]['text']

    def test_no_personas_found(self, tables):
        from mcp_handler import _tool_list_personas
        tables['projects'].query.return_value = {'Items': []}
        result = _tool_list_personas({}, {'project_id': PROJECT_ID})
        assert 'No personas found' in result[0]['text']

    def test_returns_persona_details(self, tables):
        from mcp_handler import _tool_list_personas
        tables['projects'].query.return_value = {
            'Items': [{
                'persona_id': 'p1',
                'name': 'Alice',
                'type': 'buyer',
                'age_range': '25-34',
                'occupation': 'Engineer',
                'goals': ['Save time'],
                'pain_points': ['Slow delivery'],
                'behaviors': ['Shops online'],
                'quote': 'I want fast shipping',
                'journey_stage': 'consideration',
            }]
        }
        result = _tool_list_personas({}, {'project_id': PROJECT_ID})
        parsed = json.loads(result[0]['text'])
        assert len(parsed) == 1
        assert parsed[0]['name'] == 'Alice'
        assert parsed[0]['goals'] == ['Save time']


# ---------------------------------------------------------------------------
# tools/call — get_feedback_detail
# ---------------------------------------------------------------------------

class TestToolGetFeedbackDetail:

    def test_missing_feedback_id(self):
        from mcp_handler import _tool_get_feedback_detail
        result = _tool_get_feedback_detail({}, {})
        assert 'required' in result[0]['text']

    def test_no_feedback_table(self):
        from mcp_handler import _tool_get_feedback_detail
        with patch('mcp_handler.feedback_table', None):
            result = _tool_get_feedback_detail({'feedback_id': 'f1'}, {})
        assert 'not configured' in result[0]['text']

    def test_feedback_not_found(self, tables):
        from mcp_handler import _tool_get_feedback_detail
        tables['feedback'].query.return_value = {'Items': []}
        result = _tool_get_feedback_detail({'feedback_id': 'f1'}, {})
        assert 'not found' in result[0]['text']

    def test_returns_full_detail(self, tables):
        from mcp_handler import _tool_get_feedback_detail
        tables['feedback'].query.return_value = {
            'Items': [{
                'id': 'f1',
                'source_platform': 'webscraper',
                'source_created_at': '2026-03-20',
                'sentiment_label': 'negative',
                'sentiment_score': -0.8,
                'category': 'delivery',
                'urgency': 'high',
                'rating': 2,
                'persona_type': 'impatient_buyer',
                'journey_stage': 'post_purchase',
                'original_text': 'Package arrived damaged',
                'problem_summary': 'Damaged package',
                'problem_root_cause_hypothesis': 'Poor packaging',
                'direct_customer_quote': 'This is unacceptable',
                'keywords': ['damaged', 'package'],
            }]
        }
        result = _tool_get_feedback_detail({'feedback_id': 'f1'}, {})
        parsed = json.loads(result[0]['text'])
        assert parsed['id'] == 'f1'
        assert parsed['problem_root_cause'] == 'Poor packaging'
        assert parsed['keywords'] == ['damaged', 'package']


# ---------------------------------------------------------------------------
# tools/call — dispatch & error handling
# ---------------------------------------------------------------------------

class TestToolsCallDispatch:

    @patch('mcp_handler._authenticate')
    def test_unknown_tool_returns_error(self, mock_auth):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        event = _make_event(
            body=_jsonrpc_body('tools/call', {'name': 'nonexistent_tool', 'arguments': {}}),
            headers=_auth_headers(),
        )
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        assert body['error']['code'] == -32602
        assert 'Unknown tool' in body['error']['message']

    @patch('mcp_handler._authenticate')
    def test_tool_exception_returns_is_error(self, mock_auth, tables):
        from mcp_handler import lambda_handler, TOOL_HANDLERS
        mock_auth.return_value = {'project_id': PROJECT_ID}
        original = TOOL_HANDLERS['search_feedback']
        TOOL_HANDLERS['search_feedback'] = MagicMock(side_effect=RuntimeError("Boom"))
        try:
            event = _make_event(
                body=_jsonrpc_body('tools/call', {'name': 'search_feedback', 'arguments': {}}),
                headers=_auth_headers(),
            )
            resp = lambda_handler(event, MagicMock())
            body = _parse(resp)
            assert body['result']['isError'] is True
            assert 'Error' in body['result']['content'][0]['text']
        finally:
            TOOL_HANDLERS['search_feedback'] = original

    @patch('mcp_handler._authenticate')
    def test_successful_tool_call(self, mock_auth, tables):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        tables['feedback'].query.return_value = {'Items': []}
        event = _make_event(
            body=_jsonrpc_body('tools/call', {'name': 'search_feedback', 'arguments': {'days': 1}}),
            headers=_auth_headers(),
        )
        resp = lambda_handler(event, MagicMock())
        body = _parse(resp)
        assert body['result']['isError'] is False


# ---------------------------------------------------------------------------
# Autoseed endpoint
# ---------------------------------------------------------------------------

class TestAutoseed:

    def test_unauthenticated_returns_401(self):
        from mcp_handler import lambda_handler
        event = _make_event(
            method='GET',
            resource='/mcp/autoseed/{project_id}',
            headers={},
            path_params={'project_id': PROJECT_ID},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 401

    @patch('mcp_handler._authenticate')
    def test_mismatched_project_returns_403(self, mock_auth):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': 'other_project'}
        event = _make_event(
            method='GET',
            resource='/mcp/autoseed/{project_id}',
            headers=_auth_headers(),
            path_params={'project_id': PROJECT_ID},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 403

    @patch('mcp_handler.autoseed_project')
    @patch('mcp_handler._authenticate')
    def test_successful_autoseed(self, mock_auth, mock_autoseed):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        mock_autoseed.return_value = {'files': []}
        event = _make_event(
            method='GET',
            resource='/mcp/autoseed/{project_id}',
            headers=_auth_headers(),
            path_params={'project_id': PROJECT_ID},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 200
        assert _parse(resp)['files'] == []

    @patch('mcp_handler.autoseed_project')
    @patch('mcp_handler._authenticate')
    def test_autoseed_with_query_params(self, mock_auth, mock_autoseed):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        mock_autoseed.return_value = {'files': []}
        event = _make_event(
            method='GET',
            resource='/mcp/autoseed/{project_id}',
            headers=_auth_headers(),
            path_params={'project_id': PROJECT_ID},
            query_params={'persona_ids': 'p1,p2', 'document_ids': 'd1'},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 200
        mock_autoseed.assert_called_once_with(
            PROJECT_ID, persona_ids=['p1', 'p2'], document_ids=['d1']
        )

    @patch('mcp_handler.autoseed_project')
    @patch('mcp_handler._authenticate')
    def test_autoseed_exception_returns_500(self, mock_auth, mock_autoseed):
        from mcp_handler import lambda_handler
        mock_auth.return_value = {'project_id': PROJECT_ID}
        mock_autoseed.side_effect = RuntimeError("DB error")
        event = _make_event(
            method='GET',
            resource='/mcp/autoseed/{project_id}',
            headers=_auth_headers(),
            path_params={'project_id': PROJECT_ID},
        )
        resp = lambda_handler(event, MagicMock())
        assert resp['statusCode'] == 500


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

class TestHelpers:

    def test_hash_token(self):
        from shared.tokens import hash_token
        result = hash_token('test')
        assert result == hashlib.sha256(b'test').hexdigest()

    def test_cors_response_structure(self):
        from mcp_handler import _cors_response
        resp = _cors_response({'ok': True}, 201)
        assert resp['statusCode'] == 201
        assert resp['headers']['Content-Type'] == 'application/json'
        assert resp['headers']['Access-Control-Allow-Origin'] == '*'
        body = json.loads(resp['body'])
        assert body['ok'] is True

    def test_jsonrpc_error_format(self):
        from mcp_handler import _jsonrpc_error
        result = _jsonrpc_error(42, -32600, 'Bad request')
        assert result['jsonrpc'] == '2.0'
        assert result['id'] == 42
        assert result['error']['code'] == -32600

    def test_jsonrpc_result_format(self):
        from mcp_handler import _jsonrpc_result
        result = _jsonrpc_result(7, {'data': 'ok'})
        assert result['jsonrpc'] == '2.0'
        assert result['id'] == 7
        assert result['result']['data'] == 'ok'
