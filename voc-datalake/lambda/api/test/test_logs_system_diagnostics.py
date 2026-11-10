"""`GET /logs/system/request|queues|environment` through logs_handler: admin-only, no-store, wired."""
from __future__ import annotations

from functools import partial
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import logs_handler
from logs_handler import lambda_handler
from shared.system_request_log import lookup
from shared.test.system_logs_fake import PATTERN, FakeLogs, group, row

USER_CLAIMS = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}
REQUEST_ID = '1b2c3d4e-0000-4000-8000-000000000001'
PATHS = ('/logs/system/request', '/logs/system/queues', '/logs/system/environment')


@pytest.fixture
def logs(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    fake = FakeLogs([group('projects-assist')], rows=[
        row('projects-assist', '2026-10-27 08:44:41.000', '{"level":"INFO","message":"step for ops@example.com"}'),
    ])
    with patch.object(logs_handler, '_logs_client', lambda: fake), \
            patch.object(logs_handler, 'lookup_request_lines', partial(lookup, budget=0.0)), \
            patch.object(logs_handler, 'failure_queues', lambda _sqs, _cw: {'queues': []}), \
            patch.object(logs_handler, 'system_environment', lambda *_a: {'region': 'us-east-1'}):
        yield fake


def _get(api_gateway_event, lambda_context, path: str, query: dict | None = None, claims=None):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method='GET', path=path, query_params=query, claims=claims)


@pytest.mark.parametrize('path', PATHS)
def test_refuses_a_non_admin_with_403(logs, api_gateway_event, lambda_context, path):
    response, _ = _get(api_gateway_event, lambda_context, path, {'function': 'projects-assist',
                                                                 'request_id': REQUEST_ID, 'at': '2026-10-27T08:44:43Z'},
                       claims=USER_CLAIMS)
    assert response['statusCode'] == 403
    assert logs.started == []


@pytest.mark.usefixtures('logs')
@pytest.mark.parametrize('path', PATHS[1:])
def test_queues_and_environment_answer_no_store(api_gateway_event, lambda_context, path):
    response, body = _get(api_gateway_event, lambda_context, path)
    assert response['statusCode'] == 200
    assert response['multiValueHeaders']['Cache-Control'] == ['private, no-store']
    assert body in ({'queues': []}, {'region': 'us-east-1'})


@pytest.mark.usefixtures('logs')
def test_request_lines_are_redacted_and_no_store(api_gateway_event, lambda_context):
    response, body = _get(api_gateway_event, lambda_context, '/logs/system/request',
                          {'function': 'projects-assist', 'request_id': REQUEST_ID, 'at': '2026-10-27T08:44:43Z'})
    assert response['statusCode'] == 200
    assert response['multiValueHeaders']['Cache-Control'] == ['private, no-store']
    assert body['status'] == 'complete'
    assert [line['level'] for line in body['lines']] == ['INFO']
    assert 'ops@example.com' not in response['body']


@pytest.mark.parametrize(('query', 'status'), [
    ({'function': 'projects-assist', 'request_id': 'x"y', 'at': '2026-10-27T08:44:43Z'}, 400),
    ({'function': 'projects-assist', 'request_id': REQUEST_ID}, 400),
    ({'function': 'unknown-fn', 'request_id': REQUEST_ID, 'at': '2026-10-27T08:44:43Z'}, 404),
])
def test_request_lookup_errors(logs, api_gateway_event, lambda_context, query, status):
    response, _ = _get(api_gateway_event, lambda_context, '/logs/system/request', query)
    assert response['statusCode'] == status
    assert logs.started == []
