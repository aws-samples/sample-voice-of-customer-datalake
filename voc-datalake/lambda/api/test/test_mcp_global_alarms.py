"""Alarms on the global MCP endpoint (docs/mcp.md → Alarms and concurrency).

The alarms are runtime-managed like every other alert (shared/ops_alerts.py: created when an admin
turns alerting on, under the deployment's ``voc-alerts-…`` prefix). This pins:

* the four alarm definitions, their thresholds and the metric dimension they filter on;
* that every metric an alarm watches is one the handler really emits (``AuthDenied``, ``RateLimited``,
  ``ToolCall_<outcome>``), so a renamed metric cannot leave an alarm watching nothing;
* that ``AuthDenied`` counts a refused credential once: an authorizer Deny, a handler 401 or a 403 Origin.
"""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import mcp_global_handler as h
from shared import mcp_global_tokens as gt
from shared import ops_alerts

PREFIX = 'voc-alerts-123456789012-us-east-1'
TOPIC = 'arn:aws:sns:us-east-1:123456789012:voc-ops-alarms-123456789012-us-east-1'
ENV = {'OPS_ALERTS_TOPIC_ARN': TOPIC, 'OPS_ALERTS_ALARM_PREFIX': PREFIX, 'OPS_ALERTS_MCP_SERVICE': 'voc-mcp-global-api'}


def _mcp_alarms(env: dict[str, str]) -> dict[str, dict]:
    targets = ops_alerts.load_targets(env)
    assert targets is not None
    return {d['AlarmName'].removeprefix(f'{PREFIX}-'): d for d in ops_alerts.alarm_definitions(targets)}


class TestAlarmDefinitions:
    def test_four_spike_alarms_with_their_named_thresholds(self):
        alarms = _mcp_alarms(ENV)
        assert {slug: (a['MetricName'], a['Threshold']) for slug, a in alarms.items()} == {
            'mcp-auth-denied': ('AuthDenied', 50),
            'mcp-tool-denied': ('ToolCall_denied', 20),
            'mcp-tool-failed': ('ToolCall_failed', 5),
            'mcp-rate-limited': ('RateLimited', 30),
        }

    def test_each_is_a_five_minute_sum_on_the_endpoint_service(self):
        alarm = _mcp_alarms(ENV)['mcp-auth-denied']
        assert {k: alarm[k] for k in ('Namespace', 'Dimensions', 'Period', 'Statistic', 'ComparisonOperator',
                                      'EvaluationPeriods', 'DatapointsToAlarm', 'TreatMissingData',
                                      'AlarmActions')} == {
            'Namespace': 'VoC-MCP-Global', 'Dimensions': [{'Name': 'service', 'Value': 'voc-mcp-global-api'}],
            'Period': 300, 'Statistic': 'Sum', 'ComparisonOperator': 'GreaterThanThreshold',
            'EvaluationPeriods': 1, 'DatapointsToAlarm': 1, 'TreatMissingData': 'notBreaching',
            'AlarmActions': [TOPIC]}
        assert alarm['AlarmDescription'].startswith('Many refused MCP credentials')

    def test_no_mcp_alarm_without_the_service(self):
        assert _mcp_alarms({k: v for k, v in ENV.items() if k != 'OPS_ALERTS_MCP_SERVICE'}) == {}

    def test_each_mcp_alarm_bills_one_metric(self):
        targets = ops_alerts.load_targets(ENV)
        assert targets is not None
        assert ops_alerts.billed_metric_count(ops_alerts.alarm_definitions(targets)) == 4

    def test_every_watched_metric_is_emitted_by_the_handler(self):
        emitted = {h.AUTH_DENIED_METRIC, 'RateLimited', *(f'ToolCall_{o}' for o in gt.OUTCOMES)}
        assert {metric for _, metric, _, _ in ops_alerts.MCP_ALARMS} <= emitted
        assert h.metrics.namespace == ops_alerts.MCP_METRICS_NAMESPACE


def _metric_names(add_metric: MagicMock) -> list[str]:
    return [c.kwargs['name'] for c in add_metric.call_args_list]


class TestAuthDeniedMetric:
    @pytest.fixture
    def add_metric(self):
        with patch.object(h.metrics, 'add_metric') as mocked:
            yield mocked

    def test_an_authorizer_deny_counts_once(self, add_metric: MagicMock):
        with patch.object(h, '_authenticate', return_value=None):
            answer = h._authorize({'type': 'TOKEN', 'methodArn': 'arn:x', 'authorizationToken': 'Bearer nope'})
        assert answer['policyDocument']['Statement'][0]['Effect'] == 'Deny'
        assert _metric_names(add_metric) == ['AuthDenied']

    def test_an_authorizer_allow_counts_nothing(self, add_metric: MagicMock):
        with patch.object(h, '_authenticate', return_value={'token_id': 'tok_1'}):
            h._authorize({'type': 'TOKEN', 'methodArn': 'arn:x', 'authorizationToken': 'Bearer ok'})
        assert _metric_names(add_metric) == []

    @pytest.mark.parametrize(('status', 'counted'), [(401, True), (403, True), (200, False), (429, False),
                                                     (400, False), (500, False)])
    def test_handler_refusals_count(self, add_metric: MagicMock, status: int, counted: bool):
        h._response(status, {})
        assert _metric_names(add_metric) == (['AuthDenied'] if counted else [])

    def test_a_foreign_origin_is_counted(self, add_metric: MagicMock, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv('ALLOWED_ORIGIN', 'https://voc.example.com')
        event: dict[str, Any] = {'httpMethod': 'POST', 'headers': {'Origin': 'https://evil.example'},
                                 'body': json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})}
        assert h._proxy_response(event)['statusCode'] == 403
        assert _metric_names(add_metric) == ['AuthDenied']
