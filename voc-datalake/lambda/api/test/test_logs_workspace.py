"""A workspace's logs in the workspace (api/logs_handler.py; shared/processing_logs.py; docs/multi-workspace.md).

The readers first, directly; then the routes, in the cross-workspace suite's logs world (cross_workspace_worlds.py
``logs_world``: the deployment's trail and A's and B's, each marked with its scope's word): with ``X-Workspace-Id``
the listings, the summary and a scraper's runs are the workspace's own, and only its admins clear its validation
trail (an editor, a viewer, a demoted admin and a delegated caller are refused; the deployment's ``admins`` group
grants nothing there), audited in ``AUDIT#WS#{ws}`` first; without the header the deployment's, as before.
"""
from __future__ import annotations

from contextlib import nullcontext
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError
from cross_workspace_worlds import (
    A_MARK,
    ADA,
    ADA_MEMBER_ONLY,
    B_MARK,
    BEA,
    LOG_SOURCE,
    WORLDS,
    WS_A,
    WS_B,
    table_snapshot,
)
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


# ── The routes ──

VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': '[admins, users]'}
DEPLOYMENT = 'before workspaces'
CLEAR = f'/logs/validation/{LOG_SOURCE}'


@pytest.fixture
def world(lambda_context):
    with WORLDS['logs_handler.py'](lambda_context) as built:
        yield built


def _table(name: str) -> Any:
    return boto3.resource('dynamodb', region_name='us-east-1').Table(name)


def _rows(table: str, pk: str) -> list[dict[str, Any]]:
    return _table(table).query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': pk},
                               ConsistentRead=True)['Items']


def _trail(kind: str, ws: str | None) -> list[str]:
    scope = None if ws is None else WorkspaceScope(ws)
    return [row['message_id'] for row in _rows('aggregates', log_partition(kind, LOG_SOURCE, scope))]


@pytest.mark.parametrize('kind', ['validation', 'processing'])
@pytest.mark.parametrize(('ws', 'caller', 'mark'), [(None, ADA, DEPLOYMENT), (WS_A, ADA_MEMBER_ONLY, A_MARK),
                                                     (WS_A, VIC, A_MARK), (WS_B, BEA, B_MARK)])
def test_a_listing_is_the_trail_of_the_workspace_the_request_names(world, kind, ws, caller, mark):
    status, body = world.call('GET', f'/logs/{kind}', ws=ws, caller=caller)

    assert status == 200, body
    assert [log['message_id'] for log in body['logs']] == [f'msg-{mark}']


@pytest.mark.parametrize(('ws', 'caller', 'count'), [(None, ADA, 1), (WS_A, ADA_MEMBER_ONLY, 2), (WS_B, BEA, 1)])
def test_the_summary_counts_the_workspaces_own_rows(world, ws, caller, count):
    # A second row of A's: A's count differs from the deployment's and B's.
    _table('aggregates').put_item(Item={'pk': log_partition('validation', LOG_SOURCE, WorkspaceScope(WS_A)),
                                        'sk': RECENT, 'message_id': 'msg-a2'})
    status, body = world.call('GET', '/logs/summary', ws=ws, caller=caller)

    assert status == 200, body
    assert body['summary']['validation_failures'] == {LOG_SOURCE: count}
    assert body['summary']['total_validation_failures'] == count
    assert body['summary']['total_processing_errors'] == 1


@pytest.mark.parametrize(('ws', 'caller', 'scraper', 'runs'), [
    (None, ADA, 'scr_a1', [f'run-{DEPLOYMENT}']), (WS_A, ADA_MEMBER_ONLY, 'scr_a1', [f'run-{A_MARK}']),
    (WS_A, ADA_MEMBER_ONLY, 'scr_b1', []), (WS_B, BEA, 'scr_b1', [f'run-{B_MARK}'])])
def test_a_scrapers_runs_are_the_workspaces_own(world, ws, caller, scraper, runs):
    status, body = world.call('GET', f'/logs/scraper/{scraper}', ws=ws, caller=caller)

    assert status == 200, body
    # The id is the caller's own and never echoed: B's id inside A answers exactly as an unknown one.
    assert sorted(body) == ['count', 'logs']
    assert [log['run_id'] for log in body['logs']] == runs
    assert body['count'] == len(runs)


def test_a_workspaces_admin_clears_its_validation_trail_only_and_it_is_audited(world):
    status, body = world.call('DELETE', CLEAR, ws=WS_A, caller=ADA_MEMBER_ONLY)

    assert (status, body) == (200, {'success': True, 'deleted': 1})
    assert _trail('validation', WS_A) == []
    assert _trail('processing', WS_A) == [f'msg-{A_MARK}']
    assert _trail('validation', None) == [f'msg-{DEPLOYMENT}']
    assert _trail('validation', WS_B) == [f'msg-{B_MARK}']
    [audit] = _rows('workspaces', f'AUDIT#WS#{WS_A}')
    assert {key: audit[key] for key in ('kind', 'actor', 'platform_admin', 'source', 'count')} == {
        'kind': 'validation_logs_cleared', 'actor': 'sub-ada', 'platform_admin': False, 'source': LOG_SOURCE,
        'count': 1}
    assert _rows('workspaces', f'AUDIT#WS#{WS_B}') == []


def test_without_a_workspace_the_deployments_admins_clear_the_deployments_trail(world):
    status, body = world.call('DELETE', CLEAR, ws=None, caller=ADA)

    assert (status, body) == (200, {'success': True, 'deleted': 1})
    assert _trail('validation', None) == []
    assert _trail('validation', WS_A) == [f'msg-{A_MARK}']
    assert _rows('workspaces', f'AUDIT#WS#{WS_A}') == []


@pytest.mark.parametrize(('caller', 'role', 'delegated'), [(VIC, 'viewer', False), (VIC, 'editor', False),
                                                         (ADA_MEMBER_ONLY, 'admin', True)],
                         ids=['viewer', 'editor', 'a delegated admin'])
def test_only_an_admin_acting_as_themselves_clears_the_trail(world, caller, role, delegated):
    """Whatever the deployment's group (VIC is in ``admins``); a delegated credential (an MCP token, an agent acting
    for A's admin) never clears."""
    from shared import request_workspace
    from shared.project_access import Caller

    _table('workspaces').put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{caller['sub']}", 'role': role,
                                        'email': 'member@example.com', 'name': caller['sub']})
    token = Caller(subject=caller['sub'], is_admin=False, delegated=True)
    acting = patch.object(request_workspace, 'caller_from_event', return_value=token) if delegated else nullcontext()
    before = table_snapshot()
    with acting:
        status, body = world.call('DELETE', CLEAR, ws=WS_A, caller=caller)

    assert status == 403, body
    assert table_snapshot() == before


def test_an_admin_demoted_since_a_cached_read_clears_nothing(world):
    """The clear resolves fresh: a read filled the warm membership cache with A's admin, then the role changed."""
    assert world.call('GET', '/logs/validation', ws=WS_A, caller=ADA_MEMBER_ONLY)[0] == 200
    _table('workspaces').update_item(Key={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-ada'},
                                     UpdateExpression='SET #r = :r', ExpressionAttributeNames={'#r': 'role'},
                                     ExpressionAttributeValues={':r': 'viewer'})
    before = table_snapshot()
    status, body = world.call('DELETE', CLEAR, ws=WS_A, caller=ADA_MEMBER_ONLY)

    assert status == 403, body
    assert table_snapshot() == before


def test_an_audit_row_that_cannot_be_written_clears_nothing(world):
    refused = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'PutItem')
    with patch.object(logs_handler, 'put_new_audit_row', side_effect=refused):
        status, body = world.call('DELETE', CLEAR, ws=WS_A, caller=ADA_MEMBER_ONLY)

    assert (status, body) == (500, {'success': False, 'error': 'Failed to clear logs'})
    assert _trail('validation', WS_A) == [f'msg-{A_MARK}']
