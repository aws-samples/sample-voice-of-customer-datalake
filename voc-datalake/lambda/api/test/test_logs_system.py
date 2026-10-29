"""`GET /logs/system` in logs_handler.py: admin gate, params, no-store, the search wiring.

The search itself is covered by shared/test/test_system_logs.py; here the Logs client
is the fake at the module boundary (`_logs_client`).
"""
from __future__ import annotations

from functools import partial
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import logs_handler
from logs_handler import lambda_handler
from shared.system_logs import search
from shared.test.system_logs_fake import PATTERN, FakeLogs, group, row

USER_CLAIMS = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}
QUERY_ID = '0b6a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'


@pytest.fixture
def logs(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    fake = FakeLogs([group('projects-assist')], rows=[
        row('projects-assist', '2026-10-27 09:01:02.456', level='ERROR', function_request_id='req-1',
            message='[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException for ops@example.com'),
    ])
    # A zero poll budget: a `running` query answers at once instead of sleeping for real.
    with patch.object(logs_handler, '_logs_client', lambda: fake), \
            patch.object(logs_handler, 'search_system_logs', partial(search, budget=0.0)):
        yield fake


def _get(api_gateway_event, lambda_context, query: dict | None = None, claims=None):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method='GET', path='/logs/system', query_params=query, claims=claims)


def test_refuses_a_non_admin_with_403_before_any_search(logs, api_gateway_event, lambda_context):
    response, _ = _get(api_gateway_event, lambda_context, claims=USER_CLAIMS)
    assert response['statusCode'] == 403
    assert logs.prefixes == []
    assert logs.started == []


@pytest.mark.usefixtures('logs')
def test_admin_gets_redacted_groups_and_no_store(api_gateway_event, lambda_context):
    response, body = _get(api_gateway_event, lambda_context)
    assert response['statusCode'] == 200
    assert response['multiValueHeaders']['Cache-Control'] == ['private, no-store']
    assert 'ETag' not in response['multiValueHeaders']
    assert body['status'] == 'complete'
    assert (body['days'], body['level'], body['log_groups'], body['count']) == (1, 'error', 1, 1)
    only = body['groups'][0]
    assert only['function'] == 'projects-assist'
    assert only['request_id'] == 'req-1'
    assert only['message'].startswith('[PERSONA_AVATAR] FAILED - Avatar generation error: AccessDeniedException')
    assert 'ops@example.com' not in response['body']


@pytest.mark.parametrize(('days', 'expected'), [('7', 7), ('30', 30), ('365', 30), ('0', 1), ('abc', 1), (None, 1)])
def test_days_default_to_one_and_clamp_to_thirty(logs, api_gateway_event, lambda_context, days, expected):
    query = {} if days is None else {'days': days}
    _, body = _get(api_gateway_event, lambda_context, query)
    assert body['days'] == expected
    start, end = logs.started[0]['startTime'], logs.started[0]['endTime']
    assert end - start == expected * 86400


@pytest.mark.parametrize('query', [{'level': 'debug'}, {'query_id': 'nope'}, {'query_id': ','.join([QUERY_ID] * 7)}])
def test_bad_level_or_query_id_is_a_400(logs, api_gateway_event, lambda_context, query):
    response, _ = _get(api_gateway_event, lambda_context, query)
    assert response['statusCode'] == 400
    assert logs.started == []


def test_running_then_poll_with_the_query_id(logs, api_gateway_event, lambda_context):
    logs.statuses = ['Running']
    _, first = _get(api_gateway_event, lambda_context, {'level': 'warning'})
    assert first['status'] == 'running'
    assert first['level'] == 'warning'
    assert first['query_id'] == logs.started[0]['queryId']
    logs.statuses = ['Complete']
    _, second = _get(api_gateway_event, lambda_context, {'level': 'warning', 'query_id': first['query_id']})
    assert second['status'] == 'complete'
    assert len(logs.started) == 1


def test_unconfigured_deployment_is_a_configuration_error(monkeypatch, api_gateway_event, lambda_context):
    monkeypatch.delenv('SYSTEM_LOG_GROUP_PATTERN', raising=False)
    with patch.object(logs_handler, '_logs_client', lambda: FakeLogs([])):
        response, _ = _get(api_gateway_event, lambda_context)
    assert response['statusCode'] == 500
