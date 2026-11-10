"""Tests for `scripts/ops/log_sweep.py`, the read-only post-deploy log sweep.

Lives under `lambda/` so the default `testpaths` (lambda, plugins) runs it; the
script is loaded by path because `scripts/` is not a package.
"""
import sys
from unittest.mock import MagicMock

import pytest

from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'ops' / 'log_sweep.py'


@pytest.fixture(scope='module')
def sweep():
    module = load_module_from_path('log_sweep', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


def _paginator(pages: dict[str, list[dict]]) -> MagicMock:
    """A paginator whose paginate() answers the pages listed for its call's keyword (or the only key)."""
    paginator = MagicMock()

    def paginate(**kwargs):
        key = kwargs.get('logGroupNamePrefix', '')
        return pages.get(key, [])
    paginator.paginate.side_effect = paginate
    return paginator


class TestTheDeploymentsNames:
    def test_an_unprefixed_deployment_uses_the_bare_names(self, sweep):
        assert sweep.name_prefix(None) == 'voc-'
        assert sweep.stack_prefixes(None) == [
            '/aws/stepfunctions/voc-', 'VocCoreStack-', 'VocIngestionStack-', 'VocProcessingStack-', 'VocApiStack-']

    def test_a_prefixed_deployment_prefixes_every_name(self, sweep):
        assert sweep.name_prefix('acme') == 'acme-voc-'
        assert sweep.stack_prefixes('acme')[:2] == ['/aws/stepfunctions/acme-voc-', 'acme-VocCoreStack-']

    def test_only_the_deployments_functions_count_and_their_real_group_wins(self, sweep):
        functions = [
            {'FunctionName': 'voc-metrics-api-1-r'},
            {'FunctionName': 'voc-board-pre-sign-up-1-r', 'LoggingConfig': {'LogGroup': 'VocCoreStack-BoardLogs'}},
            {'FunctionName': 'acme-voc-metrics-api-1-r'},
            {'FunctionName': 'other-app'},
        ]
        assert sweep.function_log_groups(functions, None) == {'/aws/lambda/voc-metrics-api-1-r', 'VocCoreStack-BoardLogs'}
        assert sweep.function_log_groups(functions, 'acme') == {'/aws/lambda/acme-voc-metrics-api-1-r'}


class TestTheQuery:
    def test_every_matching_line_is_kept_e2e_included_with_its_run_tag(self, sweep):
        query = sweep.build_query('/ERROR/', limit=5)
        assert query == ('fields @timestamp, @log, @message, test_run | filter @message like /ERROR/'
                         ' | sort @timestamp desc | limit 5')
        assert 'not ispresent' not in query

    def test_an_e2e_line_is_marked_with_its_run(self, sweep):
        row = sweep.row_of([{'field': '@message', 'value': 'boom'}, {'field': 'test_run', 'value': 'e2e-1'}])
        assert row[2] == '[e2e e2e-1] boom'

    def test_groups_go_fifty_to_a_query(self, sweep):
        groups = [f'g{i}' for i in range(120)]
        assert [len(chunk) for chunk in sweep.chunks(groups)] == [50, 50, 20]

    def test_a_result_row_is_clipped_to_one_line(self, sweep):
        row = sweep.row_of([{'field': '@timestamp', 'value': 't'}, {'field': '@log', 'value': '123:/aws/lambda/f'},
                            {'field': '@message', 'value': 'a\nb' + 'x' * 400}])
        assert row[:2] == ('t', '/aws/lambda/f')
        assert '\n' not in row[2]
        assert len(row[2]) == sweep.MESSAGE_CHARS


class TestRunningAQuery:
    def test_it_polls_until_complete(self, sweep):
        logs = MagicMock()
        logs.start_query.return_value = {'queryId': 'q1'}
        logs.get_query_results.side_effect = [
            {'status': 'Running'},
            {'status': 'Complete', 'results': [[{'field': '@message', 'value': 'boom'}]]},
        ]
        sleeps = []
        assert sweep.run_query(logs, ['g'], 1, 2, 'q', sleep=sleeps.append) == [('', '', 'boom')]
        assert sleeps == [sweep.POLL_SECONDS]

    def test_a_failed_query_raises_instead_of_reporting_clean(self, sweep):
        logs = MagicMock()
        logs.start_query.return_value = {'queryId': 'q1'}
        logs.get_query_results.return_value = {'status': 'Failed'}
        with pytest.raises(RuntimeError, match='ended Failed'):
            sweep.run_query(logs, ['g'], 1, 2, 'q', sleep=lambda _s: None)


class TestTheGroupsSwept:
    def test_a_function_without_a_log_group_is_skipped_and_stack_groups_are_kept(self, sweep):
        lambda_client = MagicMock()
        lambda_client.get_paginator.return_value = MagicMock(paginate=lambda: [{'Functions': [
            {'FunctionName': 'voc-metrics-api-1-r'}, {'FunctionName': 'voc-never-ran-1-r'}]}])
        logs = MagicMock()
        logs.get_paginator.return_value = _paginator({
            '/aws/lambda/voc-': [{'logGroups': [{'logGroupName': '/aws/lambda/voc-metrics-api-1-r'},
                                                {'logGroupName': '/aws/lambda/voc-deleted-fn-1-r'}]}],
            'VocCoreStack-': [{'logGroups': [{'logGroupName': 'VocCoreStack-BoardLogs'}]}],
        })
        assert sweep.existing_groups(logs, lambda_client, None) == ['/aws/lambda/voc-metrics-api-1-r', 'VocCoreStack-BoardLogs']


class TestTheExitCode:
    def _run(self, sweep, monkeypatch, groups, rows, access=()):
        boto3 = MagicMock()
        monkeypatch.setitem(sys.modules, 'boto3', boto3)
        monkeypatch.setattr(sweep, 'existing_groups', lambda *_a: groups)
        monkeypatch.setattr(sweep, 'run_query', lambda *_a, **_k: rows)
        monkeypatch.setattr(sweep, 'access_log_groups', lambda *_a: ['/aws/apigateway/voc-analytics-api-1-r'])
        monkeypatch.setattr(sweep, 'run_insights', lambda *_a, **_k: list(access))
        return sweep.main(['--hours', '1'])

    def test_a_5xx_or_an_undeclared_e2e_4xx_fails_the_sweep(self, sweep, monkeypatch):
        assert self._run(sweep, monkeypatch, ['g'], [], [_stat(502, e2e=False)]) == 1
        assert self._run(sweep, monkeypatch, ['g'], [], [_stat(403, e2e=True)]) == 1

    def test_declared_e2e_4xx_and_real_4xx_do_not_fail_it(self, sweep, monkeypatch):
        access = [_stat(403, e2e=True, declared='403'), _stat(401, e2e=False)]
        assert self._run(sweep, monkeypatch, ['g'], [], access) == 0

    def test_no_log_groups_is_an_error_not_clean(self, sweep, monkeypatch, capsys):
        assert self._run(sweep, monkeypatch, [], []) == 2
        assert 'no log groups found' in capsys.readouterr().err

    def test_matching_lines_exit_1_and_none_exit_0(self, sweep, monkeypatch):
        assert self._run(sweep, monkeypatch, ['g'], [('t', 'g', 'boom')]) == 1
        assert self._run(sweep, monkeypatch, ['g'], []) == 0


def _stat(status, *, e2e, declared=None, n=1, method='GET', route='/x'):
    fields = {'status': str(status), 'httpMethod': method, 'resourcePath': route, 'e2e': '1' if e2e else '0', 'n': str(n)}
    if declared is not None:
        fields['declared'] = declared
    return [{'field': key, 'value': value} for key, value in fields.items()]


class TestTheAccessLogClassification:
    def test_an_e2e_4xx_with_its_status_declared_is_counted_not_listed(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(403, e2e=True, declared='403,404', n=7))])
        assert findings.expected_count == 7
        assert findings.unexpected_e2e == []

    def test_an_e2e_4xx_with_another_status_declared_is_listed(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(400, e2e=True, declared='403'))])
        assert [g.status for g in findings.unexpected_e2e] == [400]
        assert findings.expected_count == 0

    def test_an_e2e_4xx_with_nothing_declared_is_listed(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(404, e2e=True))])
        assert [g.status for g in findings.unexpected_e2e] == [404]

    def test_a_5xx_is_always_listed_even_if_declared(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(500, e2e=True, declared='500')),
                                   sweep.request_group(_stat(502, e2e=False))])
        assert sorted(g.status for g in findings.server_errors) == [500, 502]

    def test_a_declared_token_on_real_traffic_never_hides_a_4xx(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(403, e2e=False, declared='403'))])
        assert [g.status for g in findings.real_client_errors] == [403]
        assert findings.expected_count == 0

    def test_totals_are_per_traffic_and_status_class(self, sweep):
        findings = sweep.classify([sweep.request_group(_stat(200, e2e=False, n=3)),
                                   sweep.request_group(_stat(204, e2e=False, n=2)),
                                   sweep.request_group(_stat(404, e2e=True, declared='404', n=4))])
        assert findings.totals == {('real', '2xx'): 5, ('e2e', '4xx'): 4}

    @pytest.mark.parametrize(('declared', 'statuses'), [
        ('403', {403}), ('403,404', {403, 404}), ('500', set()), ('4031', set()), ('', set()), (None, set()),
    ])
    def test_only_4xx_lists_are_read_as_declared(self, sweep, declared, statuses):
        assert sweep.declared_statuses(declared) == statuses

    def test_a_row_without_a_numeric_status_is_skipped(self, sweep):
        assert sweep.request_group([{'field': 'status', 'value': '-'}]) is None

    def test_the_access_log_group_follows_the_prefix(self, sweep):
        assert sweep.access_log_prefix(None) == '/aws/apigateway/voc-analytics-api'
        assert sweep.access_log_prefix('acme') == '/aws/apigateway/acme-voc-analytics-api'


class TestTheArguments:
    @pytest.mark.parametrize('argv', [['--hours', '0'], ['--limit', '0']])
    def test_a_non_positive_window_or_limit_is_refused(self, sweep, argv):
        with pytest.raises(SystemExit):
            sweep.parse_args(argv)

    def test_the_defaults(self, sweep):
        args = sweep.parse_args([])
        assert (args.hours, args.prefix, args.limit) == (2.0, None, 80)
