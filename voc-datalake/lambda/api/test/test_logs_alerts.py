"""Settings → Logs → Alerts: `/logs/alerts*` in logs_handler.py (shared/ops_alerts*.py).

CloudWatch and DynamoDB are moto; SNS is a small fake because moto does not model
an email subscription waiting for confirmation, which is the state this feature
has to show and cancel.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

import logs_handler
from logs_handler import lambda_handler
from shared.ops_alerts import (
    MAX_SUBSCRIBERS,
    PENDING_CONFIRMATION,
    alarm_definitions,
    billed_metric_count,
    load_targets,
)

TOPIC = 'arn:aws:sns:us-east-1:123456789012:voc-ops-alarms-123456789012-us-east-1'
PREFIX = 'voc-alerts-123456789012-us-east-1'
QUEUES = ('processing-dlq=voc-processing-dlq-123456789012-us-east-1,'
          'aggregator-stream-failures=voc-aggregator-stream-failures-123456789012-us-east-1')
INGESTORS = 'voc-ingestor-webscraper-123456789012-us-east-1,voc-ingestor-github_issues-123456789012-us-east-1'
ALERT_ENV = {
    'OPS_ALERTS_TOPIC_ARN': TOPIC,
    'OPS_ALERTS_ALARM_PREFIX': PREFIX,
    'OPS_ALERTS_QUEUES': QUEUES,
    'OPS_ALERTS_PROCESSOR_FUNCTION': 'voc-feedback-processor-123456789012-us-east-1',
    'OPS_ALERTS_AGGREGATOR_FUNCTION': 'voc-aggregation-processor-123456789012-us-east-1',
    'OPS_ALERTS_INGESTOR_FUNCTIONS': INGESTORS,
}
# 2 queues + processor errors + aggregator errors + aggregator iterator age + 1 ingestor SUM.
EXPECTED_ALARMS = 6
USER_CLAIMS = {'sub': 'user-1', 'email': 'user@example.com', 'cognito:groups': 'users'}


class FakeSns:
    """Email subscriptions as SNS reports them: pending ones list as PendingConfirmation."""

    def __init__(self) -> None:
        self.subs: list[dict[str, Any]] = []
        self.unsubscribed: list[str] = []

    def subscribe(self, *, TopicArn: str, Protocol: str, Endpoint: str, ReturnSubscriptionArn: bool) -> dict:
        assert (TopicArn, Protocol, ReturnSubscriptionArn) == (TOPIC, 'email', True)
        arn = f'{TOPIC}:sub-{len(self.subs)}'
        self.subs.append({'email': Endpoint, 'arn': arn, 'confirmed': False})
        return {'SubscriptionArn': arn}

    def confirm(self, email: str) -> None:
        for sub in self.subs:
            if sub['email'] == email:
                sub['confirmed'] = True

    def unsubscribe(self, *, SubscriptionArn: str) -> None:
        self.unsubscribed.append(SubscriptionArn)
        self.subs = [sub for sub in self.subs if sub['arn'] != SubscriptionArn]

    def get_paginator(self, name: str) -> FakeSns:
        assert name == 'list_subscriptions_by_topic'
        return self

    def paginate(self, *, TopicArn: str) -> Iterator[dict]:
        assert TopicArn == TOPIC
        yield {'Subscriptions': [{
            'Protocol': 'email', 'Endpoint': sub['email'],
            'SubscriptionArn': sub['arn'] if sub['confirmed'] else PENDING_CONFIRMATION,
        } for sub in self.subs] + [{'Protocol': 'https', 'Endpoint': 'https://hook.example.com', 'SubscriptionArn': 'x'}]}


@pytest.fixture
def world(monkeypatch):
    """moto CloudWatch + aggregates table, the fake SNS, and the alert env vars."""
    for key, value in ALERT_ENV.items():
        monkeypatch.setenv(key, value)
    with mock_aws():
        table = pk_sk_table('test-aggregates')
        cloudwatch = boto3.client('cloudwatch', region_name='us-east-1')
        sns = FakeSns()
        with patch.object(logs_handler, 'aggregates_table', table), \
                patch.object(logs_handler, '_alert_clients', lambda: (cloudwatch, sns)):
            yield {'table': table, 'cloudwatch': cloudwatch, 'sns': sns}


def _call(api_gateway_event, lambda_context, method: str, path: str, body: dict | None = None, claims=None):
    return call_route(lambda_handler, api_gateway_event, lambda_context,
                      method=method, path=path, body=body, claims=claims)


def _alarm_names(cloudwatch) -> list[str]:
    return sorted(alarm['AlarmName'] for alarm in cloudwatch.describe_alarms()['MetricAlarms'])


class TestAdminOnly:
    @pytest.mark.parametrize(('method', 'path', 'body'), [
        ('GET', '/logs/alerts', None),
        ('PUT', '/logs/alerts', {'enabled': True}),
        ('POST', '/logs/alerts/recipients', {'email': 'ops@example.com'}),
        ('POST', '/logs/alerts/recipients/remove', {'email': 'ops@example.com'}),
    ])
    def test_refuses_a_non_admin_with_403_and_changes_nothing(
        self, world, api_gateway_event, lambda_context, method, path, body,
    ):
        response, _ = _call(api_gateway_event, lambda_context, method, path, body, claims=USER_CLAIMS)
        assert response['statusCode'] == 403
        assert _alarm_names(world['cloudwatch']) == []
        assert world['sns'].subs == []


class TestAlarmLifecycle:
    def test_reports_not_configured_when_the_lambda_has_no_alert_targets(
        self, monkeypatch, api_gateway_event, lambda_context,
    ):
        monkeypatch.delenv('OPS_ALERTS_TOPIC_ARN', raising=False)
        response, body = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert response['statusCode'] == 200
        assert body['configured'] is False
        assert body['enabled'] is False

    def test_is_off_with_no_alarms_until_an_admin_turns_it_on(self, world, api_gateway_event, lambda_context):
        _, body = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert (body['configured'], body['enabled'], body['alarms']) == (True, False, [])
        assert body['expected_alarm_count'] == EXPECTED_ALARMS
        assert _alarm_names(world['cloudwatch']) == []

    def test_turning_on_creates_every_alarm_under_the_prefix_and_records_who(
        self, world, api_gateway_event, lambda_context,
    ):
        response, body = _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        assert response['statusCode'] == 200
        assert body['alarm_count'] == EXPECTED_ALARMS
        names = _alarm_names(world['cloudwatch'])
        assert names == sorted(f'{PREFIX}-{slug}' for slug in (
            'processing-dlq', 'aggregator-stream-failures', 'processor-errors',
            'aggregator-errors', 'aggregator-iterator-age', 'ingestor-errors'))
        row = world['table'].get_item(Key={'pk': 'SETTINGS#alerts', 'sk': 'config'})['Item']
        assert (row['enabled'], row['updated_by']) == (True, 'test@example.com')

    def test_turning_on_twice_leaves_the_same_alarms(self, world, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        assert len(_alarm_names(world['cloudwatch'])) == EXPECTED_ALARMS

    def test_turning_on_removes_an_owned_alarm_whose_target_is_gone(self, world, api_gateway_event, lambda_context):
        stale = {**alarm_definitions(load_targets() or pytest.fail('targets'))[0], 'AlarmName': f'{PREFIX}-old-queue'}
        world['cloudwatch'].put_metric_alarm(**stale)
        _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        assert f'{PREFIX}-old-queue' not in _alarm_names(world['cloudwatch'])

    def test_turning_off_deletes_exactly_the_owned_alarms(self, world, api_gateway_event, lambda_context):
        foreign = {**alarm_definitions(load_targets() or pytest.fail('targets'))[0], 'AlarmName': 'voc-someone-else'}
        world['cloudwatch'].put_metric_alarm(**foreign)
        _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        response, body = _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': False})
        assert response['statusCode'] == 200
        assert body['deleted_count'] == EXPECTED_ALARMS
        assert _alarm_names(world['cloudwatch']) == ['voc-someone-else']
        _, status = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert status['enabled'] is False

    def test_reads_on_from_the_alarms_when_the_settings_row_is_missing(self, world, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', {'enabled': True})
        world['table'].delete_item(Key={'pk': 'SETTINGS#alerts', 'sk': 'config'})
        _, body = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert body['enabled'] is True
        assert len(body['alarms']) == EXPECTED_ALARMS

    @pytest.mark.parametrize('body', [{}, {'enabled': 'yes'}, {'enabled': 1}])
    def test_rejects_an_enabled_value_that_is_not_a_boolean(self, world, api_gateway_event, lambda_context, body):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', '/logs/alerts', body)
        assert response['statusCode'] == 400
        assert _alarm_names(world['cloudwatch']) == []


class TestAlarmDefinitions:
    def _by_slug(self) -> dict[str, dict]:
        targets = load_targets(ALERT_ENV)
        assert targets is not None
        return {d['AlarmName'].removeprefix(f'{PREFIX}-'): d for d in alarm_definitions(targets)}

    def test_queue_alarm_matches_the_depth_alarm_cdk_used_to_deploy(self):
        alarm = self._by_slug()['processing-dlq']
        assert {k: alarm[k] for k in (
            'Namespace', 'MetricName', 'Period', 'Statistic', 'Threshold', 'ComparisonOperator',
            'EvaluationPeriods', 'DatapointsToAlarm', 'TreatMissingData', 'AlarmActions', 'Dimensions')} == {
            'Namespace': 'AWS/SQS', 'MetricName': 'ApproximateNumberOfMessagesVisible', 'Period': 300,
            'Statistic': 'Maximum', 'Threshold': 0, 'ComparisonOperator': 'GreaterThanThreshold',
            'EvaluationPeriods': 1, 'DatapointsToAlarm': 1, 'TreatMissingData': 'notBreaching',
            'AlarmActions': [TOPIC],
            'Dimensions': [{'Name': 'QueueName', 'Value': 'voc-processing-dlq-123456789012-us-east-1'}],
        }

    def test_ingestor_alarm_sums_every_ingestor_errors_in_one_alarm(self):
        alarm = self._by_slug()['ingestor-errors']
        stats = [m for m in alarm['Metrics'] if 'MetricStat' in m]
        assert [m['MetricStat']['Metric']['Dimensions'][0]['Value'] for m in stats] == INGESTORS.split(',')
        assert alarm['Metrics'][-1]['Expression'] == 'SUM([m0,m1])'

    def test_more_than_ten_ingestors_split_into_further_alarms(self):
        many = ','.join(f'voc-ingestor-p{i}' for i in range(12))
        targets = load_targets({**ALERT_ENV, 'OPS_ALERTS_INGESTOR_FUNCTIONS': many})
        assert targets is not None
        ingestor = [d for d in alarm_definitions(targets) if 'Metrics' in d]
        assert [d['AlarmName'] for d in ingestor] == [f'{PREFIX}-ingestor-errors', f'{PREFIX}-ingestor-errors-2']

    def test_bills_one_metric_per_alarm_plus_one_per_summed_ingestor(self):
        targets = load_targets(ALERT_ENV)
        assert targets is not None
        assert billed_metric_count(alarm_definitions(targets)) == 5 + 2

    def test_iterator_age_alarm_needs_three_periods_over_fifteen_minutes(self):
        alarm = self._by_slug()['aggregator-iterator-age']
        assert (alarm['MetricName'], alarm['Threshold'], alarm['EvaluationPeriods'], alarm['DatapointsToAlarm']) == (
            'IteratorAge', 900_000, 3, 3)


class TestRecipients:
    def test_adding_a_recipient_subscribes_it_and_shows_it_pending(self, world, api_gateway_event, lambda_context):
        response, body = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients',
                               {'email': ' Ops@Example.com '})
        assert (response['statusCode'], body['status']) == (200, 'pending')
        _, status = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert status['subscribers'] == [{'email': 'ops@example.com', 'status': 'pending'}]
        world['sns'].confirm('ops@example.com')
        _, status = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert status['subscribers'] == [{'email': 'ops@example.com', 'status': 'confirmed'}]

    def test_adding_a_confirmed_recipient_again_subscribes_nothing(self, world, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients', {'email': 'ops@example.com'})
        world['sns'].confirm('ops@example.com')
        _, body = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients',
                        {'email': 'ops@example.com'})
        assert body['status'] == 'confirmed'
        assert len(world['sns'].subs) == 1

    @pytest.mark.parametrize('email', ['', 'not-an-address', 'a@b', 'a b@example.com', 'x' * 250 + '@example.com', 42])
    def test_rejects_an_invalid_address_without_echoing_it(self, world, api_gateway_event, lambda_context, email):
        response, body = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients', {'email': email})
        assert response['statusCode'] == 400
        assert body['error'] in {'email is not a valid address', 'email must be a string'}
        assert world['sns'].subs == []

    def test_refuses_a_recipient_beyond_the_cap(self, world, api_gateway_event, lambda_context):
        for index in range(MAX_SUBSCRIBERS):
            _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients',
                  {'email': f'ops{index}@example.com'})
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients',
                            {'email': 'one-more@example.com'})
        assert response['statusCode'] == 400
        assert len(world['sns'].subs) == MAX_SUBSCRIBERS

    def test_removes_a_pending_recipient_by_the_arn_recorded_at_subscribe(self, world, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients', {'email': 'ops@example.com'})
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients/remove',
                            {'email': 'ops@example.com'})
        assert response['statusCode'] == 200
        assert world['sns'].unsubscribed == [f'{TOPIC}:sub-0']
        row = world['table'].get_item(Key={'pk': 'SETTINGS#alerts', 'sk': 'config'})['Item']
        assert row['pending'] == {}

    def test_removes_a_confirmed_recipient_by_its_listed_arn(self, world, api_gateway_event, lambda_context):
        _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients', {'email': 'ops@example.com'})
        world['sns'].confirm('ops@example.com')
        world['table'].delete_item(Key={'pk': 'SETTINGS#alerts', 'sk': 'config'})
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients/remove',
                            {'email': 'ops@example.com'})
        assert response['statusCode'] == 200
        assert world['sns'].subs == []

    def test_answers_409_for_a_pending_recipient_with_no_recorded_arn(self, world, api_gateway_event, lambda_context):
        world['sns'].subs.append({'email': 'console@example.com', 'arn': f'{TOPIC}:console', 'confirmed': False})
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients/remove',
                            {'email': 'console@example.com'})
        assert response['statusCode'] == 409
        assert world['sns'].unsubscribed == []

    @pytest.mark.usefixtures('world')
    def test_answers_404_for_an_unknown_recipient(self, api_gateway_event, lambda_context):
        response, _ = _call(api_gateway_event, lambda_context, 'POST', '/logs/alerts/recipients/remove',
                            {'email': 'nobody@example.com'})
        assert response['statusCode'] == 404

    def test_lists_only_email_subscriptions(self, world, api_gateway_event, lambda_context):
        # The fake always lists one https subscription besides the email ones.
        assert world['sns'].subs == []
        _, body = _call(api_gateway_event, lambda_context, 'GET', '/logs/alerts')
        assert body['subscribers'] == []
