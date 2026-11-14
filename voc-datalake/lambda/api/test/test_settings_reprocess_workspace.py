"""The category reprocess routes inside and outside a workspace (7.13.00, TENETS.md D3; docs/multi-workspace.md).

In the cross-workspace suite's settings world (cross_workspace_worlds.py ``settings_world``: workspaces A and B, a
finished reprocess job in the deployment's and in each workspace's own job partition): with ``X-Workspace-Id`` the
three routes act on the workspace's own jobs, ``WS#{ws}#JOB#category_reprocess``, for its admins only (an editor, a
viewer and a delegated caller are refused; the deployment's ``admins`` group grants nothing there), a member of
another workspace gets the one 404, the job row and the worker's event name the workspace from the resolved
membership, never the body, and one job runs per workspace; without the header the deployment's job, as before.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import patch

import boto3
import pytest
from cross_workspace_worlds import (
    ADA,
    ADA_MEMBER_ONLY,
    B_MARK,
    BEA,
    REPROCESS_JOB_A,
    WORLDS,
    WS_A,
    WS_B,
    table_snapshot,
)

from shared import reprocess_jobs
from shared.project_access import Caller
from shared.workspace import NOT_FOUND

BASE = '/settings/categories/reprocess'
START = {'mode': 'processed', 'days': 0}
EDI = {'sub': 'sub-edi', 'cognito:username': 'edi', 'cognito:groups': '[admins, users]'}
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': '[admins, users]'}
BEA_MEMBER = {**BEA, 'cognito:groups': 'users'}
JOB_NOT_FOUND = (404, {'success': False, 'error': 'Reprocess job not found'})


@pytest.fixture
def world(lambda_context):
    with WORLDS['settings_handler.py'](lambda_context) as built:
        # A's editor (the world seeds A's admin and viewer): an editor writes feedback, never an admin's settings.
        members = boto3.resource('dynamodb', region_name='us-east-1').Table('workspaces')
        members.put_item(Item={'pk': f'WS#{WS_A}', 'sk': 'MEMBER#sub-edi', 'role': 'editor',
                               'email': 'edi@example.com', 'name': 'sub-edi'})
        yield built


def _aggregates() -> Any:
    return boto3.resource('dynamodb', region_name='us-east-1').Table('aggregates')


def _jobs(partition: str) -> list[dict[str, Any]]:
    rows = _aggregates().query(KeyConditionExpression='pk = :p', ExpressionAttributeValues={':p': partition},
                               ConsistentRead=True)['Items']
    return [row for row in rows if str(row['sk']).startswith('rp_')]


def _new_job(partition: str) -> dict[str, Any]:
    [job] = [row for row in _jobs(partition) if row['status'] == 'queued']
    return job


class TestStartInAWorkspace:
    def test_the_job_is_the_workspaces_and_the_worker_is_told_which(self, world):
        status, body = world.call('POST', BASE, ws=WS_A, body={**START, 'workspace_id': WS_B}, caller=ADA_MEMBER_ONLY)

        assert status == 202, body
        job = _new_job(f'WS#{WS_A}#JOB#category_reprocess')
        assert job['workspace_id'] == WS_A  # the resolved membership's, never the body's
        assert job['sk'] == body['job']['job_id']
        assert 'workspace_id' not in body['job']
        world.doubles['lambda'].assert_called_once_with(
            'voc-category-reprocess', {'job_id': job['sk'], 'workspace_id': WS_A})
        # Nothing reached the deployment's jobs or B's.
        assert [row['status'] for row in _jobs('JOB#category_reprocess')] == ['completed']
        assert [row['status'] for row in _jobs(f'WS#{WS_B}#JOB#category_reprocess')] == ['completed']

    def test_one_live_job_per_workspace_beside_the_deployments_and_another_workspaces(self, world):
        first = world.call('POST', BASE, ws=WS_A, body=START, caller=ADA)
        second = world.call('POST', BASE, ws=WS_A, body={**START, 'mode': 'raw'}, caller=ADA)
        in_b = world.call('POST', BASE, ws=WS_B, body=START, caller=BEA_MEMBER)
        deployment = world.call('POST', BASE, ws=None, body=START, caller=ADA)

        assert first[0] == 202
        assert second == (409, {'success': False, 'error': 'A reprocess job is already queued or running'})
        assert in_b[0] == 202
        assert deployment[0] == 202

    @pytest.mark.parametrize('caller', [EDI, VIC], ids=['editor', 'viewer'])
    def test_an_editor_or_a_viewer_is_refused_even_in_the_deployments_admins(self, world, caller):
        before = table_snapshot()

        status, body = world.call('POST', BASE, ws=WS_A, body=START, caller=caller)

        assert status == 403, body
        assert table_snapshot() == before
        world.doubles['lambda'].assert_not_called()

    @pytest.mark.parametrize(('method', 'path', 'body'), [
        ('POST', BASE, START), ('GET', BASE, None), ('POST', f'{BASE}/{REPROCESS_JOB_A}/cancel', None),
    ], ids=['start', 'latest', 'cancel'])
    def test_a_member_of_another_workspace_gets_the_one_404(self, world, method, path, body):
        before = table_snapshot()

        answer = world.call(method, path, ws=WS_A, body=body, caller=BEA)

        assert answer == (404, {'success': False, 'error': NOT_FOUND})
        assert table_snapshot() == before
        world.doubles['lambda'].assert_not_called()

    def test_a_worker_that_cannot_be_started_fails_the_job_and_frees_the_workspaces_lock(self, world):
        world.doubles['lambda'].side_effect = RuntimeError('the worker is not there')

        status, body = world.call('POST', BASE, ws=WS_A, body=START, caller=ADA)
        lock = _aggregates().get_item(Key={'pk': f'WS#{WS_A}#JOB#category_reprocess', 'sk': 'LOCK'},
                                      ConsistentRead=True).get('Item') or {}
        new_rows = [row for row in _jobs(f'WS#{WS_A}#JOB#category_reprocess') if row['sk'] != REPROCESS_JOB_A]

        assert (status, body) == (500, {'success': False, 'error': 'Failed to start reprocess job'})
        assert [(row['status'], row['error']) for row in new_rows] == [('failed', 'Could not start the reprocess worker')]
        assert lock  # the start took the workspace's lock ...
        assert 'active_job_id' not in lock  # ... and the failure released it
        assert _jobs('JOB#category_reprocess')[0]['status'] == 'completed'  # the deployment's job untouched

    def test_a_delegated_caller_cannot_start_one(self, world):
        from shared import request_workspace

        before = table_snapshot()
        with patch.object(request_workspace, 'caller_from_event',
                          return_value=Caller(subject='sub-ada', is_admin=False, delegated=True)):
            status, body = world.call('POST', BASE, ws=WS_A, body=START, caller=ADA)

        assert status == 403, body
        assert 'delegated' in body['error']
        assert table_snapshot() == before

    def test_a_resume_names_only_a_job_of_its_own_workspace(self, world):
        for ws in (WS_A, WS_B):
            _aggregates().put_item(Item={
                'pk': f'WS#{ws}#JOB#category_reprocess', 'sk': 'rp_0000000000c1', 'status': 'partial',
                'mode': 'processed', 'days': 0, 'resume_from': {'pk': f'WS#{ws}#SOURCE#web', 'sk': 'FEEDBACK#x'},
                'created_at': '2026-11-12T00:00:00+00:00', 'workspace_id': ws})

        status, body = world.call('POST', BASE, ws=WS_A, body={'resume': 'rp_0000000000c1'}, caller=ADA)
        b_job = world.call('POST', BASE, ws=WS_A, body={'resume': 'rp_0000000000b1'}, caller=ADA)

        assert status == 202, body
        assert body['job']['resumed_from'] == 'rp_0000000000c1'
        stored_b = _aggregates().get_item(Key={'pk': f'WS#{WS_B}#JOB#category_reprocess', 'sk': 'rp_0000000000c1'})
        assert 'resumed_by' not in stored_b['Item']
        assert b_job == JOB_NOT_FOUND


class TestProgressStaysInItsWorkspace:
    def test_the_latest_job_is_the_workspaces_own(self, world):
        status, body = world.call('GET', BASE, ws=WS_A, caller=ADA_MEMBER_ONLY)

        assert status == 200, body
        assert body['job']['started_by'] == 'ada'
        assert B_MARK not in repr(body)

    def test_without_the_header_the_deployments_job(self, world):
        status, body = world.call('GET', BASE, ws=None, caller=ADA)

        assert status == 200, body
        assert body['job']['started_by'] == 'before-workspaces-admin'

    def test_a_viewer_does_not_see_it(self, world):
        status, _body = world.call('GET', BASE, ws=WS_A, caller=VIC)

        assert status == 403

    def test_a_cancel_reaches_only_the_workspaces_own_job(self, world):
        started = world.call('POST', BASE, ws=WS_A, body=START, caller=ADA)
        live_a = _new_job(f'WS#{WS_A}#JOB#category_reprocess')['sk']

        b_cancel = world.call('POST', f'{BASE}/rp_0000000000b1/cancel', ws=WS_A, caller=ADA)
        status, body = world.call('POST', f'{BASE}/{live_a}/cancel', ws=WS_A, caller=ADA)
        restarted = world.call('POST', BASE, ws=WS_A, body=START, caller=ADA)

        assert started[0] == 202
        assert b_cancel == JOB_NOT_FOUND
        assert (status, body['job']['status']) == (200, 'cancelled')
        assert restarted[0] == 202  # the workspace's lock was freed by the cancel


class TestTheDeploymentsJobIsUnchanged:
    def test_without_the_header_the_row_and_the_event_name_no_workspace(self, world):
        status, body = world.call('POST', BASE, ws=None, body=START, caller=ADA)

        assert status == 202, body
        job = _new_job(reprocess_jobs.JOB_PK)
        assert 'workspace_id' not in job
        world.doubles['lambda'].assert_called_once_with('voc-category-reprocess', {'job_id': job['sk']})
        assert [row['status'] for row in _jobs(f'WS#{WS_A}#JOB#category_reprocess')] == ['completed']

    def test_without_the_header_a_workspace_admin_outside_the_deployments_admins_is_refused(self, world):
        status, _body = world.call('POST', BASE, ws=None, body=START, caller=ADA_MEMBER_ONLY)

        assert status == 403
