"""Administration → System → Logs keeps every workspace's content out of the deployment's diagnostics (TENETS.md D8).

The diagnostics span every workspace and are read by the deployment's ``admins`` (shared/system_log_scope.py):

* every line of the shared logger carries ``workspace_id``: the workspace the code resolved for this context
  (shared/usage_meter.py's attribution: ``DEPLOYMENT`` once a request or message resolved none, the workspace's id
  once it resolved one, ``UNATTRIBUTED`` before either, reset at each invocation's start), never a header's word;
* a failure queue shows the body of a message only when it parses, names no workspace and holds nothing encoded;
  every other sampled message is counted, never shown;
* a System errors line that names a workspace is dropped and counted; a line tagged ``DEPLOYMENT`` reads as before;
  Lambda's own fixed lines (a timeout, a REPORT) read as before; every other line shows its time, function, level and
  error type only (``withheld``; the page says why in the reader's language);
* a request's lines are withheld whole when any of them names a workspace, and an untagged line shows its level only.
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

import pytest

from shared import usage_meter
from shared.system_log_scope import error_type, names_a_workspace, queue_body_shown
from shared.system_logs import SearchRequest, search
from shared.system_queues import failure_queues
from shared.system_request_log import RequestLookup, lookup
from shared.test.system_logs_fake import PATTERN, SUFFIX, FakeLogs, group, row

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
REQUEST_ID = '1b2c3d4e-0000-4000-8000-000000000001'
AT_EPOCH = datetime(2026, 10, 27, 8, 44, 43, tzinfo=UTC).timestamp()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    monkeypatch.setenv('SYSTEM_WORKFLOW_LOG_GROUP_PATTERN', f'/aws/stepfunctions/voc-*{SUFFIX}')
    monkeypatch.setenv('SYSTEM_API_ACCESS_LOG_GROUP', f'/aws/apigateway/voc-analytics-api{SUFFIX}')


def _record(message: str, *, workspace: str | None, level: str = 'ERROR', **extra: str) -> str:
    record: dict[str, str] = {'level': level, 'message': message, **extra}
    if workspace is not None:
        record['workspace_id'] = workspace
    return json.dumps(record)


# ── The rules ──

@pytest.mark.parametrize(('text', 'named'), [
    (f'Failed to save {WS}', True), ('pk WS#ws_x#LOGS#validation#webscraper', True),
    (json.dumps({'workspace_id': WS}), True), ('Failed to save the brand', False),
    ('ws_short is no id', False), ('DEPLOYMENT', False), ('pk NEWS#item', False)])
def test_a_text_names_a_workspace_by_its_id_or_a_workspace_key(text, named):
    assert names_a_workspace(text) is named


@pytest.mark.parametrize(('body', 'shown'), [
    (json.dumps({'record': {'id': 'r1', 'text': 'late parcel'}}), True),
    (json.dumps({'requestPayload': {'workspace_id': WS, 'record': {'text': 'late parcel'}}}), False),
    (json.dumps({'requestPayload': {'pk': f'WS#{WS}#FEEDBACK'}}), False),
    # Encoded content (a base64 payload or cursor) could hold anything: not shown.
    (json.dumps({'cursor': 'eyJwayI6ICJXUyN3c18wMUpDM1E4Wks2Vjd' + 'X' * 40}), False),
    # A Lambda async failure's envelope names the function by its long generated name: no encoded run.
    (json.dumps({'requestContext': {'functionArn': 'arn:aws:lambda:us-east-1:123456789012:function:'
                                                   'VocCoreStack-ProcessorFunctionA1B2C3D4-AbCdEfGhIjKlMnOpQrSt'},
                 'responsePayload': {'errorType': 'KeyError'}}), True),
    ('not json: a late parcel', False), ('', False), (json.dumps(['a', 'list']), True)])
def test_a_queue_body_is_shown_only_when_it_parses_names_no_workspace_and_holds_nothing_encoded(body, shown):
    assert queue_body_shown(body) is shown


@pytest.mark.parametrize(('text', 'exception_name', 'found'), [
    ('boom', 'KeyError', 'KeyError'), ('Traceback ...\nbotocore.exceptions.ClientError: denied', '', 'ClientError'),
    ('ValidationException: the text of a review', '', 'ValidationException'), ('it failed', '', ''),
    # A word of the message never reads as the type: only a `Name:` at a line's start does.
    ('the parcel failed: PaymentTimeout and a LateDeliveryError', '', ''),
    ('boom', 'the review text', '')])
def test_the_error_type_is_the_exception_name_never_its_message(text, exception_name, found):
    assert error_type(text, exception_name) == found


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def records():
    from shared.logging import logger

    handler = _Records()
    logger._logger.addHandler(handler)
    yield handler.records
    logger._logger.removeHandler(handler)


def _tags(records: list[logging.LogRecord]) -> list[object]:
    return [getattr(record, 'workspace_id', None) for record in records]


def test_every_line_carries_the_workspace_its_code_resolved(records):
    from shared.logging import logger

    usage_meter.reset()
    logger.info('before anything resolved')
    usage_meter.attribute(None)
    logger.info('the deployment')
    usage_meter.attribute(WS)
    logger.info('a workspace')
    logger.info('a line naming its own', extra={'workspace_id': OTHER_WS})
    assert _tags(records) == ['UNATTRIBUTED', 'DEPLOYMENT', WS, OTHER_WS]
    # The tag is in the line the formatter writes (a JSON key Insights reads).
    assert json.loads(logger.registered_formatter.format(records[1]))['workspace_id'] == 'DEPLOYMENT'


def _context() -> MagicMock:
    return MagicMock(function_name='voc-settings-api', memory_limit_in_mb=256, aws_request_id='req-1',
                     invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-settings-api')


def test_a_request_is_tagged_by_what_it_resolved_never_by_its_header(records):
    """A job event that does not call ``message_scope`` (no headers, a workspace in its body) and a public route that
    finds its workspace from a stored row resolve nothing through the resolvers: UNATTRIBUTED, so their text is
    withheld. A request that resolved the deployment is DEPLOYMENT; the next invocation starts unattributed again."""
    from shared.api import api_handler
    from shared.logging import logger

    @api_handler
    def handler(event: dict, _context: object) -> dict:
        logger.info('first line')
        if event.get('resolve') == 'deployment':
            usage_meter.attribute(None)
        elif event.get('resolve') == 'workspace':
            usage_meter.attribute(WS)
        logger.info('after resolving')
        return {'statusCode': 200}

    for event in ({'headers': {'X-Workspace-Id': WS}}, {'workspace_id': WS, 'job_id': 'job_1'},
                  {'headers': {}, 'resolve': 'workspace'}, {'headers': {}, 'resolve': 'deployment'},
                  {'headers': None}):
        handler({'requestContext': {}, **event}, _context())
    mine = [record for record in records if record.getMessage() in {'first line', 'after resolving'}]
    assert _tags(mine) == ['UNATTRIBUTED'] * 4 + ['UNATTRIBUTED', WS, 'UNATTRIBUTED', 'DEPLOYMENT',
                                                  'UNATTRIBUTED', 'UNATTRIBUTED']


def test_no_line_after_an_invocation_carries_its_workspace(records):
    """The reset after the handler's last line (shared/invocation_cost.py): a line between invocations is
    unattributed, never the last invocation's workspace."""
    from shared.api import api_handler
    from shared.logging import logger

    @api_handler
    def handler(_event: dict, _context: object) -> dict:
        usage_meter.attribute(WS)
        return {'statusCode': 200}

    handler({'requestContext': {}, 'headers': {}}, _context())
    logger.info('between invocations')
    assert _tags([record for record in records if record.getMessage() == 'between invocations']) == ['UNATTRIBUTED']


# ── Failure queues ──

class _Sqs:
    def __init__(self, bodies: list[str]) -> None:
        self.bodies = bodies

    def get_queue_url(self, *, QueueName: str) -> dict:
        return {'QueueUrl': f'https://sqs/{QueueName}'}

    def get_queue_attributes(self, **_kwargs: Any) -> dict:
        return {'Attributes': {'ApproximateNumberOfMessages': str(len(self.bodies)),
                               'ApproximateNumberOfMessagesNotVisible': '0'}}

    def receive_message(self, **_kwargs: Any) -> dict:
        return {'Messages': [{'Body': body, 'Attributes': {'SentTimestamp': stamp}}
                             for body, stamp in zip(self.bodies, ('1800000000000', '1700000000000', '1750000000000'),
                                                    strict=False)]}


class _CloudWatch:
    def get_metric_data(self, **_kwargs: Any) -> dict:
        return {'MetricDataResults': []}


def test_a_dead_letter_queue_shows_the_deployments_body_and_counts_a_workspaces(monkeypatch):
    monkeypatch.setenv('OPS_ALERTS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:voc-ops')
    monkeypatch.setenv('OPS_ALERTS_ALARM_PREFIX', 'voc-alerts')
    monkeypatch.setenv('OPS_ALERTS_QUEUES', 'processing-dlq=voc-processing-dlq-1')
    deployment = json.dumps({'record': {'id': 'r1', 'text': 'the deployment parcel'}})
    workspace = json.dumps({'record': {'id': 'r2', 'text': 'the workspace parcel'}, 'workspace_id': WS})
    unreadable = 'gzip:the workspace parcel'
    now = datetime(2027, 1, 20, tzinfo=UTC)
    [queue] = failure_queues(_Sqs([deployment, workspace, unreadable]), _CloudWatch(), now=now)['queues']

    assert queue['messages'] == 3
    assert [json.loads(body)['record']['id'] for body in queue['sample']] == ['r1']
    assert queue['withheld'] == 2
    text = json.dumps(queue)
    assert 'workspace parcel' not in text
    assert WS not in text
    # The age still counts every sampled message (the oldest is a withheld one, sent in 2023).
    assert queue['oldest_age_seconds'] == int((now - datetime.fromtimestamp(1700000000, UTC)).total_seconds())
    assert queue['sample_sent_at'] == [datetime.fromtimestamp(1800000000, UTC).isoformat()]


# ── System errors ──

def _search(rows: list[list[dict[str, str]]], names: list[str] | None = None) -> dict[str, Any]:
    fake = FakeLogs(names or [group('processor'), group('settings-api')], rows=rows)
    return search(fake, SearchRequest(days=1, level='error', query_ids=()), now=AT_EPOCH, budget=0.0,
                  sleep=lambda _s: None, clock=lambda: 0.0)


def _absent(body: dict[str, Any], *words: str) -> None:
    text = json.dumps(body)
    for word in words:
        assert word not in text, word


def test_a_line_that_names_a_workspace_is_dropped_and_counted():
    body = _search([
        row('settings-api', '2026-10-27 08:44:41.000', _record('Failed to save', workspace=WS), level='ERROR',
            workspace_id=WS),
        row('processor', '2026-10-27 08:44:42.000', f'[ERROR] Failed on WS#{OTHER_WS}#FEEDBACK the late parcel'),
        # Insights extracts a JSON record's `message` field (the fake's `message` is the raw @message).
        [*row('settings-api', '2026-10-27 08:44:43.000', _record('Failed to save the brand', workspace='DEPLOYMENT'),
              level='ERROR', workspace_id='DEPLOYMENT'), {'field': 'message', 'value': 'Failed to save the brand'}],
    ])
    assert body['status'] == 'complete'
    assert body['withheld_workspace_lines'] == 2
    assert [(g['function'], g['message'], g['withheld']) for g in body['groups']] == [
        ('settings-api', 'Failed to save the brand', False)]
    _absent(body, WS, OTHER_WS, 'parcel')


def test_an_unattributed_line_shows_its_metadata_only():
    body = _search([
        row('processor', '2026-10-27 08:44:41.000',
            _record('Could not categorize "the late parcel from Ridgeway"', workspace='UNATTRIBUTED',
                    exception_name='ValidationException'), level='ERROR', exception_name='ValidationException',
            workspace_id='UNATTRIBUTED'),
        row('processor', '2026-10-27 08:44:42.000', '2026-10-27T08:44:42Z\tabc\tERROR\tthe late parcel failed'),
    ])
    assert body['withheld_workspace_lines'] == 0
    groups = sorted(body['groups'], key=lambda g: g['message'])
    assert [(g['function'], g['level'], g['message'], g['sample'], g['withheld']) for g in groups] == [
        ('processor', 'ERROR', '', '', True), ('processor', 'ERROR', 'ValidationException', '', True)]
    _absent(body, 'parcel', 'Ridgeway')
    assert all(g['last_seen'].startswith('2026-10-27T08:44:4') for g in groups)


@pytest.mark.parametrize('raw', [
    '2026-10-27T08:44:41.000Z 1b2c3d4e-0000-4000-8000-000000000001 Task timed out after 30.03 seconds',
    'REPORT RequestId: 1b2c3d4e-0000-4000-8000-000000000001\tDuration: 900000.00 ms\tStatus: timeout'])
def test_lambdas_own_fixed_lines_stay_as_they_are(raw):
    [line] = _search([row('processor', '2026-10-27 08:44:41.000', raw)])['groups']
    assert (line['level'], line['withheld']) == ('PLATFORM', False)
    assert line['message']
    assert line['sample']


@pytest.mark.parametrize('raw', [
    'REPORT RequestId: 1b2c3d4e-0000-4000-8000-000000000001\tDuration: 1.00 ms\tthe late parcel from Ridgeway',
    'REPORT RequestId: 1b2c3d4e-0000-4000-8000-000000000001\tDuration: 1.00 ms\n{"message": "the late parcel"}',
    '2026-10-27T08:44:41.000Z 1b2c3d4e-0000-4000-8000-000000000001 Task timed out after 30.03 seconds: the parcel'])
def test_a_fixed_line_with_anything_appended_is_no_runtime_line(raw):
    from shared.system_log_scope import runtime_line

    assert runtime_line(raw) is False


@pytest.mark.parametrize(('raw', 'kind'), [
    ('[ERROR] the late parcel from Ridgeway: Task timed out waiting', ''),
    (('2026-10-27T08:44:41.000Z\tabc\tERROR\tInvoke Error {"errorType":"Runtime.UnhandledPromiseRejection",'
      '"errorMessage":"the late parcel from Ridgeway"}'), ''),
    ('[ERROR] Runtime.ImportModuleError: the late parcel from Ridgeway', 'Runtime.ImportModuleError')])
def test_a_line_that_only_mentions_a_runtime_phrase_shows_its_type_only(raw, kind):
    [line] = _search([row('processor', '2026-10-27 08:44:41.000', raw)])['groups']
    assert (line['message'], line['sample'], line['withheld']) == (kind, '', True)


def test_a_workflow_failure_shows_its_type_and_error_not_its_cause():
    workflow = f'/aws/stepfunctions/voc-agent-run{SUFFIX}'
    failure = json.dumps({'type': 'ExecutionFailed', 'execution_arn': 'arn:aws:states:x:execution:voc-agent-run:e1',
                          'details': {'error': 'States.TaskFailed', 'cause': 'the late parcel from Ridgeway'}})
    fields = [{'field': '@timestamp', 'value': '2026-10-27 08:44:41.000'},
              {'field': '@log', 'value': f'123456789012:{workflow}'}, {'field': '@message', 'value': failure}]
    [group_] = _search([fields], names=[workflow])['groups']
    assert (group_['message'], group_['sample'], group_['withheld']) == ('ExecutionFailed: States.TaskFailed', '', True)
    odd = json.dumps({'type': 'ExecutionFailed', 'execution_arn': 'arn:aws:states:x:execution:voc-agent-run:e2',
                      'details': {'error': 'the late parcel from Ridgeway', 'cause': 'x'}})
    [other] = _search([[*fields[:2], {'field': '@message', 'value': odd}]], names=[workflow])['groups']
    assert other['message'] == 'ExecutionFailed'
    assert 'parcel' not in json.dumps(group_)


def test_the_query_reads_the_workspace_tag():
    fake = FakeLogs([group('processor')], rows=[])
    search(fake, SearchRequest(days=1, level='error', query_ids=()), now=AT_EPOCH, budget=0.0,
           sleep=lambda _s: None, clock=lambda: 0.0)
    assert all('workspace_id' in started['queryString'] for started in fake.started
               if 'fields @timestamp, @log, level' in started['queryString'])


# ── One request's lines ──

def _lookup(rows: list[list[dict[str, str]]]) -> dict[str, Any]:
    fake = FakeLogs([group('settings-api')], rows=rows)
    return lookup(fake, RequestLookup('settings-api', REQUEST_ID, AT_EPOCH, None), now=AT_EPOCH + 3600, budget=0.0,
                  sleep=lambda _s: None, clock=lambda: 0.0)


def test_a_request_of_a_workspace_is_withheld_whole():
    body = _lookup([
        row('settings-api', '2026-10-27 08:44:40.000', f'START RequestId: {REQUEST_ID} Version: $LATEST'),
        row('settings-api', '2026-10-27 08:44:41.000', _record('saving', workspace=WS, level='INFO')),
        row('settings-api', '2026-10-27 08:44:43.000', _record('boom', workspace=WS)),
    ])
    assert body['status'] == 'complete'
    assert (body['lines'], body['withheld_workspace_lines']) == ([], 3)
    assert WS not in json.dumps(body)


def test_a_deployment_request_reads_as_before_and_an_untagged_line_shows_its_level_only():
    deployment = _record('saving the brand', workspace='DEPLOYMENT', level='INFO')
    body = _lookup([
        row('settings-api', '2026-10-27 08:44:40.000', f'START RequestId: {REQUEST_ID} Version: $LATEST'),
        row('settings-api', '2026-10-27 08:44:41.000', deployment),
        row('settings-api', '2026-10-27 08:44:42.000', _record('the late parcel', workspace=None, level='WARNING')),
        row('settings-api', '2026-10-27 08:44:43.000', 'START of the late parcel from Ridgeway'),
    ])
    assert body['withheld_workspace_lines'] == 0
    assert [(line['level'], line['message'], line['withheld']) for line in body['lines']] == [
        ('PLATFORM', f'START RequestId: {REQUEST_ID} Version: $LATEST', False), ('INFO', deployment, False),
        ('WARNING', '', True), ('PLATFORM', '', True)]
    _absent(body, 'parcel', 'Ridgeway')
