"""A workspace's logs can be read in the workspace (api/logs_handler.py; shared/processing_logs.py).

Plumbing: no route passes a workspace until phase 2's cut-over moves the writers (docs/multi-workspace.md); these
read the internal readers directly.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

import logs_handler
from shared.processing_logs import log_partition
from shared.ws_repo import OutOfScopeError, WorkspaceScope

A = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
B = WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
SOURCE = 'webscraper'
RECENT = '2099-01-01T00:00:00+00:00'


@pytest.fixture
def aggregates():
    with mock_aws():
        table = pk_sk_table('aggregates')
        for workspace, mark in ((None, 'deployment'), (A, 'alderbrook'), (B, 'bramblewood')):
            for kind in ('validation', 'processing'):
                table.put_item(Item={'pk': log_partition(kind, SOURCE, workspace), 'sk': RECENT,
                                     'message_id': f'm-{mark}', 'timestamp': RECENT, 'errors': ['x']})
            run_pk = 'SCRAPER_RUN#scr_1' if workspace is None else workspace.key('SCRAPER_RUN', 'scr_1')
            table.put_item(Item={'pk': run_pk, 'sk': f'run-{mark}', 'started_at': RECENT})
        with patch.object(logs_handler, 'aggregates_table', table):
            yield table


def test_the_log_partition_is_the_deployments_or_the_workspaces():
    assert log_partition('validation', SOURCE) == f'LOGS#validation#{SOURCE}'
    assert log_partition('validation', SOURCE, A) == f'WS#{A.ws}#LOGS#validation#{SOURCE}'


@pytest.mark.usefixtures('aggregates')
@pytest.mark.parametrize(('workspace', 'mark'), [(None, 'deployment'), (A, 'alderbrook'), (B, 'bramblewood')])
def test_each_reader_reads_only_its_own_partitions(workspace, mark):
    for kind in ('validation', 'processing'):
        logs = logs_handler._query_logs_for_source(kind, SOURCE, 7, 10, workspace)
        assert [log['message_id'] for log in logs] == [f'm-{mark}']
        assert logs_handler._count_logs_for_source(kind, SOURCE, 7, 10, workspace) == 1
    assert [run['sk'] for run in logs_handler._scraper_runs('scr_1', 10, workspace)] == [f'run-{mark}']


@pytest.mark.parametrize('workspace', [None, A])
@pytest.mark.parametrize('source', [SOURCE, ''])
def test_the_readers_key_is_the_one_the_processor_writes(workspace, source):
    """LOCKSTEP with processor/handler.py ``_log_row_base``, which spells the key itself (another track's module),
    a message with no source included."""
    from processor import handler as processor

    for kind in ('validation', 'processing'):
        assert processor._log_row_base(kind, source, 'm-1', workspace)['pk'] == log_partition(kind, source, workspace)


@pytest.mark.parametrize('workspace', [None, A])
def test_a_row_older_than_the_window_is_left_out(aggregates, workspace):
    aggregates.put_item(Item={'pk': log_partition('validation', SOURCE, workspace), 'sk': '2000-01-01T00:00:00+00:00',
                              'message_id': 'm-old', 'timestamp': '2000-01-01T00:00:00+00:00', 'errors': ['x']})
    logs = logs_handler._query_logs_for_source('validation', SOURCE, 7, 10, workspace)
    assert 'm-old' not in [log['message_id'] for log in logs]
    assert logs_handler._count_logs_for_source('validation', SOURCE, 7, 10, workspace) == 1


def test_a_partition_outside_the_workspace_never_reaches_dynamodb(aggregates):
    with patch.object(aggregates, 'query') as query, pytest.raises(OutOfScopeError):
        logs_handler._partition_page(A, log_partition('validation', SOURCE, B))
    query.assert_not_called()


@pytest.mark.usefixtures('aggregates')
def test_the_routes_still_read_the_deployments_logs_whatever_the_header(lambda_context):
    from moto_helpers import invoke, rest_event

    event = rest_event('GET', '/logs/validation', claims={'sub': 'sub-ada', 'cognito:groups': 'users'})
    event['headers']['X-Workspace-Id'] = A.ws
    with patch.dict('os.environ', {'ENABLED_SOURCES': f'["{SOURCE}"]'}):
        status, body = invoke(logs_handler, event, lambda_context)
    assert status == 200
    assert [log['message_id'] for log in body['logs']] == ['m-deployment']
