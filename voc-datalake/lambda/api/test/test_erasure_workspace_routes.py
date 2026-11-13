"""POST and GET /settings/erasure on both paths (shared/erasure_scope.py; docs/source-policies.md, "Workspace items").

With ``X-Workspace-Id`` the workspace's member admins (a platform admin is never elevated here) start an erasure by
author, source_id, csv_row_id or email whose job row lives in the workspace's own partition (``WS#{ws}#JOB#erasure``)
and names that workspace (from the resolved membership, never the body), one live erasure per workspace (409 for a
second), and list that workspace's jobs only; an editor or a viewer is refused (403), a non-member (the deployment's
``admins`` included) gets the one 404, a whole-source erasure is refused (400) before anything is read. Without the
header both routes are the deployment's, exactly as before.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

import settings_handler
from settings_handler import lambda_handler
from shared import erasure_scope, workspace_request
from shared.erasure_jobs import acquire_workspace_lock, refresh_workspace_lock, release_workspace_lock
from shared.exceptions import AuthorizationError, ValidationError
from shared.source_erasure import blocking_job
from shared.test.moto_tables import create_aggregates_table_with_metric_index
from shared.workspace import MEMBER_READ_ATTRIBUTES, META_READ_ATTRIBUTES, WorkspaceContext
from shared.workspace_request import RequestWorkspace

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
BASIS = 'GDPR art. 17 request #123'
ADMIN_A = {'sub': 'sub-ad', 'cognito:groups': 'users', 'cognito:username': 'ad'}
ADMIN_B = {'sub': 'sub-bo', 'cognito:groups': 'users', 'cognito:username': 'bo'}
EDITOR_A = {'sub': 'sub-ed', 'cognito:groups': 'users', 'cognito:username': 'ed'}
DEPLOYMENT_ADMIN = {'sub': 'sub-dep', 'cognito:groups': 'admins', 'cognito:username': 'dep'}
PLATFORM_ADMIN = {'sub': 'sub-pa', 'cognito:groups': 'platform-admins', 'cognito:username': 'pa'}
AUTHOR = {'field': 'author', 'value': 'Jane Doe', 'legal_basis': BASIS}


@pytest.fixture
def world() -> Iterator[tuple[Any, MagicMock, Any]]:
    with mock_aws():
        aggregates = create_aggregates_table_with_metric_index('test-aggregates-erasure-workspace')
        workspaces = pk_sk_table('workspaces')
        for ws in (WS_A, WS_B):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active', 'name': ws, 'slug': ws[-6:]})
        for ws, member, role in ((WS_A, ADMIN_A, 'admin'), (WS_A, EDITOR_A, 'editor'), (WS_A, PLATFORM_ADMIN, 'editor'),
                                 (WS_B, ADMIN_B, 'admin')):
            workspaces.put_item(Item={'pk': f'WS#{ws}', 'sk': f"MEMBER#{member['sub']}", 'role': role})
        # The module's own live check (never elevates): only the table is the test's.
        resolver = RequestWorkspace(table=lambda: workspaces,
                                    confirm_platform_admin=erasure_scope.no_platform_admin_entry)
        with patch.object(settings_handler, 'aggregates_table', aggregates), \
                patch.object(settings_handler, 'RETENTION_FUNCTION', 'voc-retention'), \
                patch.object(settings_handler, '_erasure_workspace', resolver), \
                patch.object(settings_handler, 'invoke_lambda_async', MagicMock()) as invoke:
            yield aggregates, invoke, workspaces


@pytest.fixture
def route(api_gateway_event, lambda_context):
    """``route(method, body=None, claims=…, ws=None)`` -> ``(status, decoded body)``."""
    def call(method: str, *, claims: dict, ws: str | None = None, body: dict | None = None) -> tuple[int, Any]:
        headers = {'X-Workspace-Id': ws} if ws is not None else {}
        response, answer = call_route(lambda_handler, api_gateway_event, lambda_context, method=method,
                                      path='/settings/erasure', body=body, claims=claims, headers=headers)
        return response['statusCode'], answer
    return call


def _partition(ws: str | None) -> str:
    return 'JOB#erasure' if ws is None else f'WS#{ws}#JOB#erasure'


def _row(aggregates, job_id: str, ws: str | None = WS_A) -> dict:
    return aggregates.get_item(Key={'pk': _partition(ws), 'sk': job_id})['Item']


def _lock(aggregates, ws: str = WS_A) -> dict | None:
    return aggregates.get_item(Key={'pk': _partition(ws), 'sk': 'LOCK'}).get('Item')


def _context(ws: str = WS_A) -> WorkspaceContext:
    return WorkspaceContext(ws=ws, role='admin', name='a', slug='a', platform_admin=False)


class TestStartingAnErasureInAWorkspace:
    @pytest.mark.parametrize('body', [
        AUTHOR,
        {'field': 'source_id', 'value': '12345', 'source': 'tickets', 'legal_basis': BASIS},
        {'field': 'csv_row_id', 'value': 'row-7', 'source': 'tickets', 'legal_basis': BASIS},
        {'field': 'email', 'value': 'jane@example.com', 'legal_basis': BASIS},
    ])
    def test_its_admin_starts_a_job_in_the_workspaces_partition(self, world, route, body):
        aggregates, invoke, _workspaces = world
        status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body=body)

        assert status == 202, answer
        job = answer['job']
        assert job['workspace_id'] == WS_A
        assert _row(aggregates, job['job_id'])['workspace_id'] == WS_A
        assert aggregates.get_item(Key={'pk': 'JOB#erasure', 'sk': job['job_id']}).get('Item') is None
        lock = _lock(aggregates)
        assert lock is not None
        assert lock['job_id'] == job['job_id']
        # The value travels in the event only; the workspace names the partition the worker reads the row from.
        invoke.assert_called_once_with('voc-retention', {'mode': 'erase', 'job_id': job['job_id'],
                                                         'value': body['value'], 'workspace_id': WS_A})

    def test_a_workspace_id_in_the_body_never_reaches_the_job(self, world, route):
        aggregates, invoke, _workspaces = world
        status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body={**AUTHOR, 'workspace_id': WS_B})
        assert status == 202
        assert _row(aggregates, answer['job']['job_id'])['workspace_id'] == WS_A
        assert invoke.call_args.args[1]['workspace_id'] == WS_A

        status, answer = route('POST', claims=DEPLOYMENT_ADMIN, body={**AUTHOR, 'workspace_id': WS_B})
        assert status == 202
        assert 'workspace_id' not in _row(aggregates, answer['job']['job_id'], None)
        assert 'workspace_id' not in invoke.call_args.args[1]

    def test_one_live_erasure_per_workspace(self, world, route):
        aggregates, invoke, _workspaces = world
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)[0] == 202
        status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        assert (status, answer['error']) == (409, erasure_scope.WORKSPACE_ERASURE_RUNNING)
        assert invoke.call_count == 1
        # Another workspace and the deployment are not held up by it.
        assert route('POST', claims=ADMIN_B, ws=WS_B, body=AUTHOR)[0] == 202
        assert route('POST', claims=DEPLOYMENT_ADMIN, body=AUTHOR)[0] == 202
        assert len([row for row in aggregates.scan()['Items'] if row['sk'].startswith('er_')]) == 3

    def test_a_released_or_stale_lock_lets_the_next_erasure_start(self, world, route):
        aggregates, _invoke, _workspaces = world
        stale = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
        aggregates.put_item(Item={'pk': _partition(WS_A), 'sk': 'LOCK', 'job_id': 'er_000000000001',
                                  'locked_at': stale})
        aggregates.put_item(Item={'pk': _partition(WS_B), 'sk': 'LOCK', 'job_id': 'er_000000000002',
                                  'locked_at': datetime.now(UTC).isoformat(), 'released_at': stale})
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)[0] == 202
        assert route('POST', claims=ADMIN_B, ws=WS_B, body=AUTHOR)[0] == 202

    def test_a_failed_invoke_fails_the_job_and_frees_the_lock(self, world, route):
        aggregates, invoke, _workspaces = world
        invoke.side_effect = RuntimeError('down')
        status, _ = route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        assert status == 500
        [job] = [row for row in aggregates.scan()['Items'] if row['sk'].startswith('er_')]
        assert (job['pk'], job['status'], job['error']) == (_partition(WS_A), 'failed',
                                                           'Could not start the erasure worker')
        lock = _lock(aggregates)
        assert lock is not None
        assert lock['released_at']
        invoke.side_effect = None
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)[0] == 202

    def test_a_platform_admin_is_never_elevated_and_nothing_is_written(self, world, route):
        """A platform admin acts with their own membership here: not a member, the one 404; an editor, 403. No entry
        audit row is written (the settings role holds no put in voc-workspaces)."""
        _aggregates, invoke, workspaces = world
        before = workspaces.scan()['Items']
        assert route('POST', claims=PLATFORM_ADMIN, ws=WS_B, body=AUTHOR)[0] == 404
        assert route('POST', claims=PLATFORM_ADMIN, ws=WS_A, body=AUTHOR)[0] == 403
        assert route('GET', claims=PLATFORM_ADMIN, ws=WS_B)[0] == 404
        invoke.assert_not_called()
        assert workspaces.scan()['Items'] == before

    def test_an_editor_is_refused_and_nothing_starts(self, world, route):
        aggregates, invoke, _workspaces = world
        status, _ = route('POST', claims=EDITOR_A, ws=WS_A, body=AUTHOR)
        assert status == 403
        invoke.assert_not_called()
        assert aggregates.scan()['Count'] == 0

    @pytest.mark.parametrize(('claims', 'ws'), [
        (DEPLOYMENT_ADMIN, WS_A),  # the deployment's admins grant nothing inside a workspace
        (ADMIN_A, WS_B),  # another workspace
        (ADMIN_A, 'ws_not-an-id'),
    ])
    def test_a_non_member_gets_the_one_404(self, world, route, claims, ws):
        _aggregates, invoke, _workspaces = world
        status, answer = route('POST', claims=claims, ws=ws, body={'field': 'nonsense'})
        assert (status, answer['error']) == (404, 'Workspace not found')
        invoke.assert_not_called()

    def test_a_whole_source_erasure_is_refused_in_a_workspace_before_anything_is_read(self, world, route):
        aggregates, invoke, _workspaces = world
        with patch.object(settings_handler, '_erasable_sources') as sources:
            status, answer = route('POST', claims=ADMIN_A, ws=WS_A,
                                   body={'field': 'source', 'value': 'web', 'confirm': 'web', 'legal_basis': BASIS})
        assert (status, answer['error']) == (400, erasure_scope.WHOLE_SOURCE_NOT_IN_WORKSPACES)
        sources.assert_not_called()
        invoke.assert_not_called()
        assert aggregates.scan()['Count'] == 0

    @pytest.mark.parametrize('field', ['name', None, 7])
    def test_an_unknown_or_missing_field_gets_the_deployments_answer(self, world, route, field):
        body = {'value': 'x', 'legal_basis': BASIS, **({} if field is None else {'field': field})}
        in_workspace = route('POST', claims=ADMIN_A, ws=WS_A, body=body)
        deployment = route('POST', claims=DEPLOYMENT_ADMIN, body=body)
        assert in_workspace == deployment
        assert in_workspace[0] == 400
        assert in_workspace[1]['error'].startswith('field must be one of: ')
        world[1].assert_not_called()

    def test_without_the_header_the_deployments_admins_start_it_as_before(self, world, route):
        aggregates, _invoke, _workspaces = world
        status, answer = route('POST', claims=DEPLOYMENT_ADMIN, body=AUTHOR)
        assert status == 202
        assert 'workspace_id' not in answer['job']
        assert 'workspace_id' not in _row(aggregates, answer['job']['job_id'], None)
        status, _ = route('POST', claims=ADMIN_A, body=AUTHOR)
        assert status == 403


class TestAWorkspaceJobNeverBlocksTheDeployment:
    def test_a_live_workspace_job_on_a_source_does_not_block_its_whole_source_erasure(self, world, route):
        aggregates, _invoke, _workspaces = world
        aggregates.put_item(Item={'pk': 'METRIC#daily_source#web', 'sk': '2026-01-01', 'metric_type': 'source'})
        body = {'field': 'source_id', 'value': '12345', 'source': 'web', 'legal_basis': BASIS}
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=body)[0] == 202

        status, answer = route('POST', claims=DEPLOYMENT_ADMIN,
                               body={'field': 'source', 'value': 'web', 'confirm': 'web', 'legal_basis': BASIS})
        assert status == 202, answer

    def test_the_live_job_check_leaves_out_a_row_that_names_a_workspace(self, world):
        aggregates = world[0]
        now = datetime.now(UTC)
        aggregates.put_item(Item={'pk': 'JOB#erasure', 'sk': 'er_000000000001', 'job_id': 'er_000000000001',
                                  'status': 'running', 'source': 'web', 'workspace_id': WS_A,
                                  'created_at': now.isoformat()})
        assert blocking_job(aggregates, 'web', now) is None
        aggregates.put_item(Item={'pk': 'JOB#erasure', 'sk': 'er_000000000002', 'job_id': 'er_000000000002',
                                  'status': 'running', 'source': 'web', 'created_at': now.isoformat()})
        assert blocking_job(aggregates, 'web', now) == 'er_000000000002'


class TestListingTheJobs:
    @staticmethod
    def _seed(aggregates) -> None:
        for n, ws in enumerate((None, WS_A, WS_B, WS_A, None)):
            aggregates.put_item(Item={'pk': _partition(ws), 'sk': f'er_00000000000{n}', 'job_id': f'er_00000000000{n}',
                                      'status': 'completed', **({'workspace_id': ws} if ws else {})})
        aggregates.put_item(Item={'pk': _partition(WS_A), 'sk': 'LOCK', 'job_id': 'er_000000000003'})

    def test_a_workspace_sees_its_own_jobs_and_no_source(self, world, route):
        self._seed(world[0])
        status, answer = route('GET', claims=ADMIN_A, ws=WS_A)
        assert status == 200
        assert [job['job_id'] for job in answer['jobs']] == ['er_000000000003', 'er_000000000001']
        assert {job['workspace_id'] for job in answer['jobs']} == {WS_A}
        assert answer['sources'] == []

    def test_the_deployment_sees_its_own_partition(self, world, route):
        self._seed(world[0])
        status, answer = route('GET', claims=DEPLOYMENT_ADMIN)
        assert status == 200
        assert [job['job_id'] for job in answer['jobs']] == ['er_000000000004', 'er_000000000000']

    @pytest.mark.usefixtures('world')
    def test_an_editor_or_a_non_member_cannot_list(self, route):
        assert route('GET', claims=EDITOR_A, ws=WS_A)[0] == 403
        assert route('GET', claims=DEPLOYMENT_ADMIN, ws=WS_A)[0] == 404

    @pytest.mark.parametrize('ws', [WS_A, None])
    def test_each_list_is_one_bounded_query_of_its_own_partition(self, world, ws):
        aggregates = world[0]
        for n in range(25):
            for scope in (WS_A, WS_B, None):
                aggregates.put_item(Item={'pk': _partition(scope), 'sk': f'er_{n:012x}', 'job_id': f'er_{n:012x}'})
        query = MagicMock(wraps=aggregates.query)
        with patch.object(aggregates, 'query', query):
            jobs = erasure_scope.listed_jobs(aggregates, _context() if ws else None, 20)
        assert [job['job_id'] for job in jobs] == [f'er_{n:012x}' for n in range(24, 4, -1)]
        assert {job['pk'] for job in jobs} == {_partition(ws)}
        # One page of at most the 20 asked for: another scope's volume, or more of its own, is never read.
        assert query.call_count == 1
        assert query.call_args.kwargs['Limit'] == 20
        assert query.call_args.kwargs['ExpressionAttributeValues'][':p'] == _partition(ws)


class TestTheWorkspaceLock:
    def test_a_job_put_that_fails_frees_the_lock_and_the_next_start_goes_through(self, world, route):
        aggregates, invoke, _workspaces = world
        job_id, fixed = _a_job_started_at_the_same_moment(aggregates)
        with patch.object(settings_handler, 'datetime', fixed):
            status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        assert (status, answer['error']) == (409, 'An erasure job was started at the same moment; retry')
        lock = _lock(aggregates)
        assert lock is not None
        assert (lock['job_id'], bool(lock.get('released_at'))) == (job_id, True)
        invoke.assert_not_called()
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)[0] == 202

    def test_the_renewal_never_touches_a_released_lock(self, world):
        aggregates = world[0]
        scope_of_a = erasure_scope.scope_of(_context())
        earlier, later = datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 1, 2, tzinfo=UTC)
        acquire_workspace_lock(aggregates, scope_of_a, 'er_000000000001', earlier)
        release_workspace_lock(aggregates, scope_of_a, 'er_000000000001', earlier)
        refresh_workspace_lock(aggregates, scope_of_a, 'er_000000000001', later)
        lock = _lock(aggregates)
        assert lock is not None
        assert lock['locked_at'] == earlier.isoformat()
        # ...nor another job's.
        acquire_workspace_lock(aggregates, scope_of_a, 'er_000000000002', later)
        refresh_workspace_lock(aggregates, scope_of_a, 'er_000000000001', later + timedelta(hours=1))
        lock = _lock(aggregates)
        assert lock is not None
        assert (lock['job_id'], lock['locked_at']) == ('er_000000000002', later.isoformat())

    @pytest.mark.parametrize('ws', [WS_A, None])
    def test_a_failed_invoke_whose_row_update_also_fails_still_answers_the_invoke_error(self, world, route, ws):
        """In a workspace the lock is freed too; without the header (a deployment admin) the same answer as before."""
        aggregates, invoke, _workspaces = world
        invoke.side_effect = RuntimeError('down')
        with patch.object(erasure_scope, 'table_view', _failing_view('update_item', THROTTLE)):
            status, answer = route('POST', claims=ADMIN_A if ws else DEPLOYMENT_ADMIN, ws=ws, body=AUTHOR)
        # The invoke's failure is the one reported.
        assert (status, answer['error']) == (500, 'Failed to start the erasure job')
        if ws:
            lock = _lock(aggregates)
            assert lock is not None
            assert lock['released_at']

    def test_a_throttled_release_never_hides_the_409(self, world, route):
        _job_id, fixed = _a_job_started_at_the_same_moment(world[0])
        with patch.object(settings_handler, 'datetime', fixed), \
                patch.object(erasure_scope, 'release_workspace_lock', side_effect=THROTTLE) as release:
            status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        assert (status, answer['error']) == (409, 'An erasure job was started at the same moment; retry')
        release.assert_called_once()

    def test_a_throttled_release_never_hides_the_failed_start(self, world, route):
        _aggregates, invoke, _workspaces = world
        invoke.side_effect = RuntimeError('down')
        with patch.object(erasure_scope, 'release_workspace_lock', side_effect=THROTTLE) as release:
            status, answer = route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        assert (status, answer['error']) == (500, 'Failed to start the erasure job')
        release.assert_called_once()

    def test_a_connection_fault_on_the_job_put_frees_the_lock_and_the_next_start_goes_through(self, world, route):
        aggregates, invoke, _workspaces = world
        fault = EndpointConnectionError(endpoint_url='https://dynamodb.us-east-1.amazonaws.com')
        # The original fault is what the caller gets (the handler lets an unexpected AWS fault through).
        with patch.object(erasure_scope, 'table_view', _failing_view('put_item', fault)), \
                pytest.raises(EndpointConnectionError):
            route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)
        invoke.assert_not_called()
        lock = _lock(aggregates)
        assert lock is not None
        assert lock['released_at']
        assert route('POST', claims=ADMIN_A, ws=WS_A, body=AUTHOR)[0] == 202


THROTTLE = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'UpdateItem')


def _a_job_started_at_the_same_moment(aggregates: Any) -> tuple[str, MagicMock]:
    """A workspace job row already at the id the next start will take, and the clock (``settings_handler.datetime``)
    that makes it take that id: ``(job id, the clock)``."""
    moment = datetime(2026, 1, 1, 12, tzinfo=UTC)
    job_id = f'er_{int(moment.timestamp() * 1000):012x}'
    aggregates.put_item(Item={'pk': _partition(WS_A), 'sk': job_id, 'job_id': job_id, 'status': 'completed'})
    fixed = MagicMock(wraps=datetime)
    fixed.now.return_value = moment
    return job_id, fixed


def _failing_view(method: str, error: Exception) -> Any:
    """``erasure_scope.table_view`` whose job-row ``method`` raises ``error`` (the lock's own calls go through
    ``ws_table`` in shared/erasure_jobs.py and still work)."""
    real_view = erasure_scope.table_view

    def view(scope: Any, table: Any) -> Any:
        # A stand-in over the real view: a workspace table's state is fixed (shared/ws_repo.py), so its method is
        # replaced on a wrapper, never on the view itself.
        seen = real_view(scope, table)
        return MagicMock(wraps=seen, **{method: MagicMock(side_effect=error)})
    return view


class TestTheModulesOwnResolver:
    """The settings API's real `_erasure_workspace` (only the table is a double): a platform admin is never elevated
    and Cognito is never asked; a member admin gets in."""

    @pytest.fixture
    def real(self, api_gateway_event, lambda_context) -> Iterator[tuple[Any, MagicMock, MagicMock, Any]]:
        with mock_aws():
            aggregates = create_aggregates_table_with_metric_index('test-aggregates-erasure-real')
            workspaces = pk_sk_table('workspaces-real')
            workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': 'META', 'status': 'active', 'name': 'A', 'slug': 'a'})
            workspaces.put_item(Item={'pk': f'WS#{WS_A}', 'sk': f"MEMBER#{ADMIN_A['sub']}", 'role': 'admin',
                                      'email': 'ad@example.com', 'name': 'Ad Min'})
            cognito = MagicMock()
            with patch.object(settings_handler, 'aggregates_table', aggregates), \
                    patch.object(settings_handler, 'RETENTION_FUNCTION', 'voc-retention'), \
                    patch.object(workspace_request, 'get_workspaces_table', return_value=workspaces), \
                    patch('shared.platform_admin_gate.get_cognito_idp_client', return_value=cognito), \
                    patch.object(settings_handler, 'invoke_lambda_async', MagicMock()) as invoke:

                def call(claims: dict) -> int:
                    response, _ = call_route(lambda_handler, api_gateway_event, lambda_context, method='POST',
                                             path='/settings/erasure', body=AUTHOR, claims=claims,
                                             headers={'X-Workspace-Id': WS_A})
                    return response['statusCode']

                yield call, invoke, cognito, workspaces

    def test_a_platform_admin_without_a_membership_gets_the_one_404_and_an_admin_member_gets_in(self, real):
        call, invoke, cognito, _workspaces = real
        assert call(PLATFORM_ADMIN) == 404
        cognito.assert_not_called()
        invoke.assert_not_called()
        assert call(ADMIN_A) == 202
        invoke.assert_called_once()

    def test_the_resolver_reads_only_the_role_and_the_meta_it_uses(self, real):
        call, _invoke, _cognito, workspaces = real
        with patch.object(workspaces, 'get_item', wraps=workspaces.get_item) as get_item:
            assert call(ADMIN_A) == 202
        projected = [set(kwargs['ExpressionAttributeNames'].values()) for _args, kwargs in get_item.call_args_list]
        assert projected == [set(MEMBER_READ_ATTRIBUTES), set(META_READ_ATTRIBUTES)]
        assert all(kwargs['ConsistentRead'] for _args, kwargs in get_item.call_args_list)
        assert 'email' not in set(MEMBER_READ_ATTRIBUTES) | set(META_READ_ATTRIBUTES)


class TestTheJobRow:
    def test_the_workspace_comes_from_the_resolved_membership_only(self):
        row = {'pk': 'JOB#erasure', 'field': 'author', 'workspace_id': WS_B}
        assert erasure_scope.scoped_job_row(row, _context()) == {
            'pk': _partition(WS_A), 'field': 'author', 'workspace_id': WS_A}
        assert erasure_scope.scoped_job_row(row, None) == {'pk': 'JOB#erasure', 'field': 'author'}

    def test_a_whole_source_row_never_names_a_workspace(self):
        with pytest.raises(ValidationError):
            erasure_scope.scoped_job_row({'field': 'source'}, _context())


class TestADelegatedCaller:
    """A start in a workspace is the member admin's own act (an erasure cannot be undone): a delegated caller (an MCP
    token, an agent, a plan step acting for the admin) gets 403, as for the workspace's admin settings; reading the
    jobs, and the deployment's path, are unchanged."""

    MCP_FOR_ADMIN: Final = {'sub': 'mcp:tok_1', 'cognito:username': 'ad', 'voc:acting_subject': ADMIN_A['sub']}

    @staticmethod
    def _event(claims: dict) -> dict:
        return {'headers': {'X-Workspace-Id': WS_A}, 'requestContext': {'authorizer': {'claims': claims}}}

    def test_a_delegated_start_in_a_workspace_is_refused(self):
        workspace = MagicMock(context=MagicMock(return_value=_context()))
        with pytest.raises(AuthorizationError, match='delegated caller'):
            erasure_scope.require_erasure_admin(workspace, self._event(self.MCP_FOR_ADMIN), write=True)

    def test_the_member_admin_starts_it_and_a_delegated_caller_still_reads_the_jobs(self):
        workspace = MagicMock(context=MagicMock(return_value=_context()))
        assert erasure_scope.require_erasure_admin(workspace, self._event(ADMIN_A), write=True) == _context()
        assert erasure_scope.require_erasure_admin(workspace, self._event(self.MCP_FOR_ADMIN)) == _context()
