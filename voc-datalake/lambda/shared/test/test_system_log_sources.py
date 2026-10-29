"""shared/system_log_sources.py + shared/system_log_rows.py: every source `GET /logs/system` reads."""
from __future__ import annotations

import json

import pytest

from shared.system_log_groups import ERROR_LEVELS, WARNING_LEVELS, LogLine, classify
from shared.system_log_rows import (
    HTTP_LEVEL,
    MAX_CAUSE_CHARS,
    api_query,
    classify_api,
    classify_workflow,
    execution_name,
    normalized_path,
    workflow_query,
)
from shared.system_log_sources import LogSources, discover
from shared.system_logs import MAX_QUERIES, SearchRequest, parse_query_ids, search
from shared.test.system_logs_fake import ACCOUNT, PATTERN, SUFFIX, FakeLogs, group, row

ERRORS = ERROR_LEVELS
WARNINGS = WARNING_LEVELS

NOW = 1_800_000_000.0
API_GROUP = f'/aws/apigateway/voc-analytics-api{SUFFIX}'
WORKFLOW_PATTERN = f'/aws/stepfunctions/voc-*{SUFFIX}'
EXTRAS = ('product-doc-extractor=VocCoreStack-ProductDocExtractorLambdaLogs,'
          'cognito-custom-message=VocCoreStack-CustomMessageLambdaLogs')
DOC_GROUP = 'VocCoreStack-ProductDocExtractorLambdaLogs0B654126-AbCdEf123456'
MESSAGE_GROUP = 'VocCoreStack-CustomMessageLambdaLogs4575B1C3-ZyXw98765432'
PROVIDER_GROUP = 'VocCoreStack-AdminBootstrapProviderLogsA9E8A5ED-Qwerty123456'
WORKFLOW_GROUP = f'/aws/stepfunctions/voc-agent-run{SUFFIX}'
ERROR_WANTED = ('ERROR', 'CRITICAL', HTTP_LEVEL)
WARNING_WANTED = ('ERROR', 'CRITICAL', 'WARNING', HTTP_LEVEL)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', PATTERN)
    monkeypatch.setenv('SYSTEM_EXTRA_LOG_GROUPS', EXTRAS)
    monkeypatch.setenv('SYSTEM_WORKFLOW_LOG_GROUP_PATTERN', WORKFLOW_PATTERN)
    monkeypatch.setenv('SYSTEM_API_ACCESS_LOG_GROUP', API_GROUP)


def _fields(log_group: str, timestamp: str, **values: str) -> list[dict[str, str]]:
    return [{'field': k, 'value': v} for k, v in {'@timestamp': timestamp, '@log': f'{ACCOUNT}:{log_group}',
                                                   **values}.items()]


def _api_row(status: str, **values: str) -> dict[str, str]:
    return {'@timestamp': '2026-10-27 08:00:00.000', 'status': status, 'httpMethod': 'POST',
            'path': '/v1/projects/proj_1/personas/0b6a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/regenerate-avatar',
            'requestId': 'a1b2c3d4-0000-4000-8000-000000000001', 'userAgent': 'Mozilla/5.0', 'ip': '203.0.113.9',
            **values}


ALL_GROUPS = [group('projects-assist'), DOC_GROUP, MESSAGE_GROUP, PROVIDER_GROUP, WORKFLOW_GROUP, API_GROUP,
              f'/aws/apigateway/voc-analytics-api{SUFFIX}-old']


class TestDiscovery:
    def test_finds_every_kind_and_skips_provider_and_lookalike_groups(self):
        fake = FakeLogs(ALL_GROUPS)
        targets = discover(fake, LogSources.from_env())
        assert [(t.function, t.source) for t in targets] == [
            ('projects-assist', 'lambda'), ('cognito-custom-message', 'lambda'), ('product-doc-extractor', 'lambda'),
            ('agent-run', 'workflow'), ('api', 'api')]
        # One listing per kind: the two extra groups share one prefix.
        assert fake.prefixes == ['/aws/lambda/voc-', 'VocCoreStack-', '/aws/stepfunctions/voc-', API_GROUP]

    def test_optional_sources_are_skipped_when_not_configured(self, monkeypatch):
        for name in ('SYSTEM_EXTRA_LOG_GROUPS', 'SYSTEM_WORKFLOW_LOG_GROUP_PATTERN', 'SYSTEM_API_ACCESS_LOG_GROUP'):
            monkeypatch.delenv(name)
        fake = FakeLogs(ALL_GROUPS)
        assert [t.source for t in discover(fake, LogSources.from_env())] == ['lambda']
        assert fake.prefixes == ['/aws/lambda/voc-']

    @pytest.mark.parametrize(('pattern', 'expected'), [
        (PATTERN, None), (f'/aws/lambda/stg-voc-*{SUFFIX}', 'stg'), (f'/aws/lambda/a-b-voc-*{SUFFIX}', 'a-b')])
    def test_deployment_prefix(self, monkeypatch, pattern, expected):
        monkeypatch.setenv('SYSTEM_LOG_GROUP_PATTERN', pattern)
        assert LogSources.from_env().deployment_prefix() == expected

    def test_coverage_names_what_is_searched(self):
        assert LogSources.from_env().coverage() == {
            'lambda_log_group_pattern': '/aws/lambda/voc-*-<account>-us-east-1',
            'extra_lambda_functions': ['product-doc-extractor', 'cognito-custom-message'],
            'workflow_logs': True, 'api_access_log': True}


class TestSearchAcrossSources:
    def _run(self, fake: FakeLogs, level: str = 'error') -> dict:
        return search(fake, SearchRequest(1, level, ()), now=NOW, budget=0.0, sleep=lambda _s: None,
                      clock=lambda: 0.0)

    def test_one_query_per_kind_with_its_own_query_string(self):
        fake = FakeLogs(ALL_GROUPS)
        body = self._run(fake)
        assert body['log_groups_by_source'] == {'lambda': 3, 'workflow': 1, 'api': 1}
        assert [q['logGroupNames'] for q in fake.started] == [
            sorted([group('projects-assist'), DOC_GROUP, MESSAGE_GROUP]), [WORKFLOW_GROUP], [API_GROUP]]
        assert fake.started[1]['queryString'] == workflow_query(10000)
        assert fake.started[2]['queryString'] == api_query('error', 10000)

    def test_rows_are_classified_by_their_log_group(self):
        fake = FakeLogs(ALL_GROUPS, rows=[
            row('projects-assist', '2026-10-27 08:00:00.000', level='ERROR', message='boom'),
            _fields(DOC_GROUP, '2026-10-27 08:00:01.000', level='ERROR', message='extract failed'),
            _fields(WORKFLOW_GROUP, '2026-10-27 08:00:02.000', type='TaskFailed', **{
                'details.error': 'States.TaskFailed', 'details.cause': 'Lambda.Unknown',
                'execution_arn': f'arn:aws:states:us-east-1:{ACCOUNT}:execution:voc-agent-run{SUFFIX}:run_abc12345'}),
            _fields(API_GROUP, '2026-10-27 08:00:03.000', status='502', httpMethod='GET', path='/v1/metrics/summary',
                    errorMessage='Internal server error', requestId='a1b2c3d4-0000-4000-8000-000000000001'),
            _fields(PROVIDER_GROUP, '2026-10-27 08:00:04.000', level='ERROR', message='not searched'),
        ])
        groups = self._run(fake)['groups']
        assert [(g['source'], g['function'], g['level']) for g in groups] == [
            ('api', 'api', 'HTTP'), ('workflow', 'agent-run', 'ERROR'),
            ('lambda', 'product-doc-extractor', 'ERROR'), ('lambda', 'projects-assist', 'ERROR')]
        # The status stays: an API row's code is the point of the row (→ 502, not → <n>).
        assert groups[0]['message'] == 'GET /v1/metrics/summary → 502 Internal server error'
        assert groups[1]['request_id'] == 'run_abc12345'

    def test_up_to_six_query_ids_poll_back(self):
        ids = ','.join(['0b6a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'] * MAX_QUERIES)
        assert len(parse_query_ids(ids)) == MAX_QUERIES == 6


class TestApiRows:
    def test_a_5xx_is_http_with_method_normalized_path_status_and_reason(self):
        line = classify_api(_api_row('502', errorMessage='Internal server error'), ERROR_WANTED)
        assert line is not None
        assert (line.function, line.level, line.source) == ('api', 'HTTP', 'api')
        assert line.text == 'POST /v1/projects/{id}/personas/{id}/regenerate-avatar → 502 Internal server error'
        assert line.request_id == 'a1b2c3d4-0000-4000-8000-000000000001'
        assert '203.0.113.9' not in line.sample

    def test_the_integration_status_when_the_gateway_has_no_message(self):
        line = classify_api(_api_row('504', errorMessage='-', integrationStatus='200'), ERROR_WANTED)
        assert line is not None
        assert line.text.endswith('→ 504 integration 200')

    @pytest.mark.parametrize('status', ['400', '422', '429'])
    def test_a_telling_4xx_is_a_warning_only_in_warning_mode(self, status):
        assert classify_api(_api_row(status), ERROR_WANTED) is None
        line = classify_api(_api_row(status), WARNING_WANTED)
        assert line is not None
        assert line.level == 'WARNING'

    # 409 (a stale edit, a live run) and 410 (an expired or closed link) are answers the API gives
    # on purpose, like 401 / 403 / 404 (5.47.00).
    @pytest.mark.parametrize('status', ['401', '403', '404', '409', '410', '200', '302', 'oops'])
    def test_ordinary_answers_are_never_shown(self, status):
        assert classify_api(_api_row(status), WARNING_WANTED) is None

    def test_e2e_traffic_is_dropped(self):
        assert classify_api(_api_row('500', userAgent='voc-e2e/run-42 Playwright'), ERROR_WANTED) is None

    def test_query_filters_status_and_e2e(self):
        assert 'status like /^5\\d\\d$/' in api_query('error', 10)
        assert 'not in ["401", "403", "404", "409", "410"]' in api_query('warning', 10)
        assert 'userAgent not like /voc-e2e\\//' in api_query('error', 10)

    @pytest.mark.parametrize(('path', 'expected'), [
        ('/v1/data-explorer/s3', '/v1/data-explorer/s3'),
        ('/v1/s3-import/files', '/v1/s3-import/files'),
        ('/v1/feedback/4f3c2a1b9d8e7f6012345678', '/v1/feedback/{id}'),
        ('/v1/scrapers/jobs/job_80cbfb058cf7408f', '/v1/scrapers/jobs/{id}'),
        ('/v1/webhooks/github_issues', '/v1/webhooks/github_issues'),
    ])
    def test_normalized_path(self, path, expected):
        assert normalized_path(path) == expected


class TestWorkflowRows:
    ARN = f'arn:aws:states:us-east-1:{ACCOUNT}:execution:voc-agent-run{SUFFIX}:run_abc12345'

    def test_a_failure_event_from_the_query_fields(self):
        line = classify_workflow({'@timestamp': '2026-10-27 08:00:00.000', 'type': 'ExecutionFailed',
                                  'details.error': 'States.Timeout', 'details.cause': 'x' * (MAX_CAUSE_CHARS + 9),
                                  'execution_arn': self.ARN}, 'agent-run', ERRORS)
        assert line is not None
        assert (line.function, line.level, line.source, line.request_id) == (
            'agent-run', 'ERROR', 'workflow', 'run_abc12345')
        assert line.text.startswith('ExecutionFailed: States.Timeout - xxx')
        assert len(line.text) == len('ExecutionFailed: States.Timeout - ') + MAX_CAUSE_CHARS

    def test_falls_back_to_the_raw_json_line(self):
        message = json.dumps({'type': 'LambdaFunctionFailed', 'execution_arn': self.ARN,
                              'details': {'error': 'Lambda.Unknown', 'cause': 'out of memory'}})
        line = classify_workflow({'@timestamp': '2026-10-27 08:00:00.000', '@message': message}, 'agent-run', ERRORS)
        assert line is not None
        assert line.text == 'LambdaFunctionFailed: Lambda.Unknown - out of memory'

    @pytest.mark.parametrize('message', ['{"type": "TaskSucceeded"}', 'not json', '[1]'])
    def test_other_events_are_dropped(self, message):
        assert classify_workflow({'@message': message}, 'agent-run', WARNINGS) is None

    def test_execution_name(self):
        assert execution_name(self.ARN) == 'run_abc12345'
        assert execution_name('nope') is None

    def test_an_aborted_execution_is_a_warning_listed_in_warning_mode_only(self):
        event = {'@timestamp': '2026-10-27 08:00:00.000', 'type': 'ExecutionAborted',
                 'details.cause': 'Cancelled by an admin', 'execution_arn': self.ARN}
        assert classify_workflow(event, 'agent-run', ERRORS) is None
        line = classify_workflow(event, 'agent-run', WARNINGS)
        assert line is not None
        assert (line.level, line.text) == ('WARNING', 'ExecutionAborted - Cancelled by an admin')


class TestExpectedRefusals:
    """A designed refusal (the board PreSignUp trigger raising to refuse an address) is not an error."""

    REFUSAL = '[ERROR] SignUpRefusedError: domain_not_allowed Traceback (most recent call last):'

    @pytest.mark.parametrize('fields', [
        {'@message': REFUSAL},
        {'level': 'ERROR', 'message': 'SignUpRefusedError: domain_not_allowed', '@message': '{}'},
    ])
    def test_a_refused_sign_up_reads_as_a_warning(self, fields):
        row_ = {'@timestamp': '2026-10-25 23:23:00.000', **fields}
        assert classify(row_, 'board-pre-signup', ERRORS) is None
        line = classify(row_, 'board-pre-signup', WARNINGS)
        assert isinstance(line, LogLine)
        assert line.level == 'WARNING'

    def test_another_error_of_the_same_function_stays_an_error(self):
        line = classify({'@timestamp': '2026-10-25 23:23:00.000', 'level': 'ERROR', 'message': 'KeyError: email'},
                        'board-pre-signup', ERRORS)
        assert line is not None
        assert line.level == 'ERROR'
