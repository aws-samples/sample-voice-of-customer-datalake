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
    def test_test_traffic_is_left_out_by_default(self, sweep):
        query = sweep.build_query('/ERROR/', include_tests=False, limit=5)
        assert query == ('fields @timestamp, @log, @message | filter @message like /ERROR/'
                         ' | filter not ispresent(test_run) | sort @timestamp desc | limit 5')

    def test_include_tests_keeps_every_line(self, sweep):
        assert 'test_run' not in sweep.build_query('/ERROR/', include_tests=True, limit=5)

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


class TestTheArguments:
    @pytest.mark.parametrize('argv', [['--hours', '0'], ['--limit', '0']])
    def test_a_non_positive_window_or_limit_is_refused(self, sweep, argv):
        with pytest.raises(SystemExit):
            sweep.parse_args(argv)

    def test_the_defaults(self, sweep):
        args = sweep.parse_args([])
        assert (args.hours, args.prefix, args.include_tests, args.limit) == (2.0, None, False, 80)
