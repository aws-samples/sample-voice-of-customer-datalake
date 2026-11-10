"""shared/system_request_log.py, system_queues.py, system_environment.py: the System → Logs diagnostics."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from shared import system_environment
from shared.exceptions import NotFoundError, ValidationError
from shared.system_log_sources import LogTarget
from shared.system_queues import MAX_BODY_CHARS, UNREADABLE, failure_queues
from shared.system_request_log import (
    MAX_LINE_CHARS,
    MAX_LINES,
    WINDOW_SECONDS,
    RequestLookup,
    lookup,
    parse_lookup,
    request_query,
)
from shared.test.system_logs_fake import ACCOUNT, PATTERN, SUFFIX, FakeLogs, group, row

REQUEST_ID = '1b2c3d4e-0000-4000-8000-000000000001'
AT = '2026-10-27T08:44:43.123Z'
AT_EPOCH = datetime(2026, 10, 27, 8, 44, 43, 123000, tzinfo=UTC).timestamp()
WORKFLOW_GROUP = f'/aws/stepfunctions/voc-agent-run{SUFFIX}'
API_GROUP = f'/aws/apigateway/voc-analytics-api{SUFFIX}'


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    monkeypatch.setenv('SYSTEM_WORKFLOW_LOG_GROUP_PATTERN', f'/aws/stepfunctions/voc-*{SUFFIX}')
    monkeypatch.setenv('SYSTEM_API_ACCESS_LOG_GROUP', API_GROUP)


def _lookup(fake: FakeLogs, function: str = 'projects-assist', query_id: str | None = None,
            now: float = AT_EPOCH + 3600) -> dict:
    return lookup(fake, RequestLookup(function, REQUEST_ID, AT_EPOCH, query_id), now=now, budget=0.0,
                  sleep=lambda _s: None, clock=lambda: 0.0)


class TestRequestParams:
    def test_parses_a_lookup(self):
        parsed = parse_lookup({'function': 'projects-assist', 'request_id': REQUEST_ID, 'at': AT})
        assert parsed == RequestLookup('projects-assist', REQUEST_ID, AT_EPOCH, None)

    @pytest.mark.parametrize('params', [
        {'request_id': REQUEST_ID, 'at': AT},
        {'function': 'Projects Assist', 'request_id': REQUEST_ID, 'at': AT},
        {'function': 'x', 'request_id': 'a"b or 1=1', 'at': AT},
        {'function': 'x', 'request_id': 'short', 'at': AT},
        {'function': 'x', 'request_id': REQUEST_ID},
        {'function': 'x', 'request_id': REQUEST_ID, 'at': 'yesterday'},
        {'function': 'x', 'request_id': REQUEST_ID, 'at': AT, 'query_id': 'nope'},
    ])
    def test_bad_params_are_a_400(self, params):
        with pytest.raises(ValidationError):
            parse_lookup(params)

    def test_query_matches_the_request_id_or_the_execution_name(self):
        lambda_query = request_query(LogTarget('g', 'f', 'lambda'), REQUEST_ID)
        assert f'@requestId = "{REQUEST_ID}"' in lambda_query
        assert f'function_request_id = "{REQUEST_ID}"' in lambda_query
        assert 'sort @timestamp asc' in lambda_query
        assert f'limit {MAX_LINES + 1}' in lambda_query
        assert 'execution_arn like "run_abc12345"' in request_query(LogTarget('g', 'f', 'workflow'), 'run_abc12345')


class TestRequestLookup:
    def test_every_line_of_the_request_oldest_first_redacted(self):
        fake = FakeLogs([group('projects-assist')], rows=[
            row('projects-assist', '2026-10-27 08:44:40.000', 'START RequestId: x Version: $LATEST'),
            row('projects-assist', '2026-10-27 08:44:41.000', '{"level":"INFO","message":"invite ops@example.com"}',
                level='INFO'),
            row('projects-assist', '2026-10-27 08:44:43.000', '{"level":"ERROR","message":"boom"}', level='ERROR'),
        ])
        body = _lookup(fake)
        assert body['status'] == 'complete'
        assert body['source'] == 'lambda'
        assert [(line['level'], line['timestamp']) for line in body['lines']] == [
            ('PLATFORM', '2026-10-27T08:44:40.000Z'), ('INFO', '2026-10-27T08:44:41.000Z'),
            ('ERROR', '2026-10-27T08:44:43.000Z')]
        assert 'ops@example.com' not in str(body)
        started = fake.started[0]
        assert started['logGroupNames'] == [group('projects-assist')]
        assert (started['startTime'], started['endTime']) == (int(AT_EPOCH) - WINDOW_SECONDS,
                                                             int(AT_EPOCH) + WINDOW_SECONDS)

    def test_the_window_never_ends_in_the_future(self):
        fake = FakeLogs([group('projects-assist')])
        _lookup(fake, now=AT_EPOCH + 60)
        assert fake.started[0]['endTime'] == int(AT_EPOCH) + 60

    def test_more_than_the_cap_is_truncated_and_lines_are_cut(self):
        rows = [row('projects-assist', '2026-10-27 08:44:41.000', 'x' * (MAX_LINE_CHARS + 5))] * (MAX_LINES + 1)
        body = _lookup(FakeLogs([group('projects-assist')], rows=rows))
        assert body['truncated'] is True
        assert len(body['lines']) == MAX_LINES
        assert len(body['lines'][0]['message']) == MAX_LINE_CHARS

    def test_rows_of_another_group_are_dropped(self):
        rows = [row('other', '2026-10-27 08:44:41.000', 'not this function')]
        assert _lookup(FakeLogs([group('projects-assist'), group('other')], rows=rows))['lines'] == []

    def test_a_workflow_function_resolves_to_its_state_machine_group(self):
        fake = FakeLogs([WORKFLOW_GROUP])
        assert _lookup(fake, function='agent-run')['source'] == 'workflow'
        assert fake.started[0]['logGroupNames'] == [WORKFLOW_GROUP]

    @pytest.mark.parametrize('function', ['nope', 'api'])
    def test_an_unknown_function_or_the_api_is_a_404(self, function):
        with pytest.raises(NotFoundError):
            _lookup(FakeLogs([group('projects-assist'), API_GROUP]), function=function)

    def test_running_then_poll(self):
        fake = FakeLogs([group('projects-assist')], statuses=['Running'])
        first = _lookup(fake)
        assert (first['status'], first['query_id'], first['lines']) == ('running', fake.started[0]['queryId'], [])
        fake.statuses = ['Complete']
        second = _lookup(fake, query_id=first['query_id'])
        assert second['status'] == 'complete'
        assert len(fake.started) == 1

    def test_an_aws_error_is_failed_without_its_text(self):
        fake = FakeLogs([group('projects-assist')])
        fake.fail_start = True
        body = _lookup(fake)
        assert body['status'] == 'failed'
        assert 'secret detail' not in str(body)


class FakeSqs:
    def __init__(self, counts: dict[str, int], bodies: list[str] | None = None, broken: str = '') -> None:
        self.counts, self.bodies, self.broken = counts, bodies or [], broken
        self.received: list[dict[str, Any]] = []

    def get_queue_url(self, *, QueueName: str) -> dict:
        if QueueName == self.broken:
            raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'arn detail'}}, 'GetQueueUrl')
        return {'QueueUrl': f'https://sqs/{QueueName}'}

    def get_queue_attributes(self, *, QueueUrl: str, **_kwargs: Any) -> dict:
        return {'Attributes': {'ApproximateNumberOfMessages': str(self.counts[QueueUrl.rsplit('/', 1)[1]]),
                               'ApproximateNumberOfMessagesNotVisible': '0'}}

    def receive_message(self, **kwargs: Any) -> dict:
        self.received.append(kwargs)
        return {'Messages': [{'Body': body, 'Attributes': {'SentTimestamp': '1800000000000'}}
                             for body in self.bodies]}


class FakeCloudWatch:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.queries: list[dict] = []

    def get_metric_data(self, **kwargs: Any) -> dict:
        if self.fail:
            raise ClientError({'Error': {'Code': 'Throttling', 'Message': 'x'}}, 'GetMetricData')
        self.queries = kwargs['MetricDataQueries']
        return {'MetricDataResults': [{'Id': 'q0', 'Values': [4321.0, 10.0]}]}


QUEUE_PAIRS = (('processing-dlq', 'voc-processing-dlq-1'), ('api-async-failures', 'voc-api-async-failures-1'),
               ('briefing-dlq', 'voc-briefing-1'))
QUEUES = ','.join(f'{slug}={name}' for slug, name in QUEUE_PAIRS)


class TestFailureQueues:
    @pytest.fixture(autouse=True)
    def _queues(self, monkeypatch):
        monkeypatch.setenv('OPS_ALERTS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:voc-ops')
        monkeypatch.setenv('OPS_ALERTS_ALARM_PREFIX', 'voc-alerts')
        monkeypatch.setenv('OPS_ALERTS_QUEUES', QUEUES)

    def test_counts_ages_and_redacted_samples_without_deleting(self):
        body = '{"responsePayload": {"errorMessage": "Task timed out", "email": "jane.doe@example.com"}}'
        sqs = FakeSqs({'voc-processing-dlq-1': 0, 'voc-api-async-failures-1': 2}, bodies=[body, 'y' * 3000],
                      broken='voc-briefing-1')
        cloudwatch = FakeCloudWatch()
        queues = failure_queues(sqs, cloudwatch, now=datetime(2026, 10, 27, tzinfo=UTC))['queues']
        assert [q['name'] for q in queues] == ['processing-dlq', 'api-async-failures', 'briefing-dlq']
        empty, holding, broken = queues
        assert (empty['messages'], empty['sample']) == (0, [])
        assert 'oldest_age_seconds' not in empty
        assert holding['messages'] == 2
        assert holding['oldest_age_seconds'] == 4321
        assert 'Task timed out' in holding['sample'][0]
        assert 'jane.doe@example.com' not in str(queues)
        assert len(holding['sample'][1]) == MAX_BODY_CHARS
        assert holding['sample_sent_at'][0].startswith('2027-01-15T')
        assert broken == {'name': 'briefing-dlq', 'messages': None, 'sample': [], 'error': UNREADABLE}
        # A peek, never a consume (FakeSqs has no delete_message: a call would raise).
        assert sqs.received == [{'QueueUrl': 'https://sqs/voc-api-async-failures-1', 'MaxNumberOfMessages': 3,
                                 'VisibilityTimeout': 0, 'WaitTimeSeconds': 1, 'AttributeNames': ['SentTimestamp']}]
        assert [q['MetricStat']['Metric']['Dimensions'][0]['Value'] for q in cloudwatch.queries] == [
            'voc-api-async-failures-1']

    def test_the_sampled_send_time_gives_the_age_when_cloudwatch_fails(self):
        sqs = FakeSqs({'voc-processing-dlq-1': 1, 'voc-api-async-failures-1': 0, 'voc-briefing-1': 0}, bodies=['x'])
        # FakeSqs sends at 1800000000000 ms (2027-01-15T08:00:00Z); one hour later.
        now = datetime(2027, 1, 15, 9, 0, tzinfo=UTC)
        queues = failure_queues(sqs, FakeCloudWatch(fail=True), now=now)['queues']
        assert (queues[0]['messages'], queues[0]['oldest_age_seconds']) == (1, 3600)

    def test_a_peeked_message_never_reads_younger_than_its_send_time(self):
        # Once a message has been received 3+ times, CloudWatch's age points at the second-oldest
        # message: a three-day-old dead letter read "4321 s" on the live deployment.
        sqs = FakeSqs({'voc-processing-dlq-1': 0, 'voc-api-async-failures-1': 1, 'voc-briefing-1': 0}, bodies=['x'])
        three_days_later = datetime(2027, 1, 18, 8, 0, tzinfo=UTC)
        queues = failure_queues(sqs, FakeCloudWatch(), now=three_days_later)['queues']
        assert queues[1]['oldest_age_seconds'] == 3 * 86400

    def test_no_age_without_cloudwatch_or_a_send_time(self):
        sqs = FakeSqs({'voc-processing-dlq-1': 1, 'voc-api-async-failures-1': 0, 'voc-briefing-1': 0}, bodies=[])
        queues = failure_queues(sqs, FakeCloudWatch(fail=True))['queues']
        assert queues[0]['messages'] == 1
        assert 'oldest_age_seconds' not in queues[0]

    def test_no_alerting_config_is_no_queues(self, monkeypatch):
        monkeypatch.delenv('OPS_ALERTS_TOPIC_ARN')
        assert failure_queues(FakeSqs({}), FakeCloudWatch()) == {'queues': []}


class FakeTable:
    def __init__(self, items: dict[str, dict]) -> None:
        self.items = items

    def get_item(self, *, Key: dict) -> dict:
        item = self.items.get(Key['pk'])
        return {'Item': item} if item is not None else {}


class FakeAlarms:
    def get_paginator(self, _name: str) -> FakeAlarms:
        return self

    def paginate(self, **_kwargs: Any) -> list[dict]:
        return [{'MetricAlarms': [{'AlarmName': 'voc-alerts-processing-dlq', 'StateValue': 'ALARM'},
                                  {'AlarmName': 'voc-alerts-briefing-dlq', 'StateValue': 'OK'}]}]


class TestEnvironment:
    ARN = f'arn:aws:lambda:us-east-1:{ACCOUNT}:function:voc-logs-api{SUFFIX}'

    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch):
        monkeypatch.setenv('AWS_REGION', 'us-east-1')
        monkeypatch.setenv('WEB_SEARCH_ENABLED', 'true')
        monkeypatch.setenv('OPS_ALERTS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:voc-ops')
        monkeypatch.setenv('OPS_ALERTS_ALARM_PREFIX', 'voc-alerts')
        circuits = {'app_reviews_ios': {'tripped': True, 'tripped_at': '2026-10-27T08:00:00Z', 'failure_count': 5,
                                        'last_error': 'HTTP 429 for ops@example.com'},
                    'webscraper': {'tripped': False, 'tripped_at': None, 'failure_count': 0, 'last_error': None}}
        with patch.object(system_environment, 'read_circuits', lambda *_a, **_k: circuits), \
                patch.object(system_environment, 'default_source_ids', lambda: ['webscraper', 'app_reviews_ios']), \
                patch.object(system_environment, 'get_active_model_id', lambda surface: f'model-for-{surface}'):
            yield

    def test_the_whole_answer(self):
        table = FakeTable({'SETTINGS#alerts': {'enabled': True},
                           'SETTINGS#model': {'surfaces': {'chat': 'not-allowlisted'}}})
        body = system_environment.environment(table, FakeAlarms(), self.ARN)
        assert body['region'] == 'us-east-1'
        assert body['account_suffix'] == ACCOUNT[-4:]
        assert ACCOUNT not in str(body)
        assert body['deployment_prefix'] is None
        assert body['enabled_sources'] == ['webscraper', 'app_reviews_ios']
        assert body['web_search'] is True
        assert body['inference_scope'] == 'global'
        assert set(body['image_model']) == {'id', 'region', 'avatars_enabled'}
        assert body['models']['effective']['chat'] == 'model-for-chat'
        assert body['models']['overrides'] == {}
        assert body['alerting'] == {'configured': True, 'enabled': True, 'in_alarm': 1, 'alarms': [
            {'name': 'processing-dlq', 'state': 'ALARM'}, {'name': 'briefing-dlq', 'state': 'OK'}]}
        assert body['open_circuits'] == [{'source': 'app_reviews_ios', 'tripped_at': '2026-10-27T08:00:00Z',
                                          'failure_count': 5, 'last_error': body['open_circuits'][0]['last_error']}]
        assert 'ops@example.com' not in str(body)
        assert body['log_coverage']['api_access_log'] is True

    def test_an_unreadable_section_does_not_fail_the_answer(self):
        class Broken:
            def get_item(self, **_kwargs: Any) -> dict:
                raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'x'}}, 'GetItem')

        body = system_environment.environment(Broken(), FakeAlarms(), 'not-an-arn')
        assert body['models'] == {'unavailable': True}
        assert body['alerting'] == {'unavailable': True}
        assert body['account_suffix'] is None
        assert body['region'] == 'us-east-1'
