"""workspaces_handler.py: a workspace's export under /me/workspaces/current/export (moto-backed; docs/multi-workspace.md,
"Export and delete"; the rules: shared/test/test_export_jobs.py, the job: lambda/jobs/workspace_export/test/)."""
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, rest_event
from test_workspaces_members_routes import ADA, EDI, NOR, PAT, VIC, WS
from workspaces_api_world import workspaces_api

import workspaces_handler
from shared.test.export_s3_double import ExportS3

# The callers are the members routes' (ADA the admin, EDI an editor, VIC a viewer, NOR a deployment admin who is
# not a member, PAT a platform admin).
EXPORT = '/me/workspaces/current/export'
LINK = '/me/workspaces/current/export/link'
BUCKET = 'raw-bucket'
FUNCTION = 'voc-workspace-export'
FAULT = ClientError({'Error': {'Code': 'ServiceException', 'Message': 'arn:aws:lambda:us-east-1:1:function:x'}},
                    'Invoke')


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    s3: ExportS3
    invoke: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    started = MagicMock()
    with mock_aws():
        s3 = ExportS3(BUCKET)
        with workspaces_api({'RAW_DATA_BUCKET': BUCKET, 'EXPORT_FUNCTION': FUNCTION, 'invoke_lambda_async': started},
                            {'get_s3_client': s3}) as (workspaces, aggregates):
            yield World(workspaces, aggregates, s3, started)


def _call(world, lambda_context, method, path=EXPORT, claims=ADA, ws: str | None = WS):
    event = rest_event(method, path, claims=claims)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.workspaces)


def _audit_rows(world):
    return world.workspaces.query(KeyConditionExpression='pk = :pk',
                                  ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']


def _jobs(world):
    return world.aggregates.query(KeyConditionExpression='pk = :pk',
                                  ExpressionAttributeValues={':pk': f'WS#{WS}#JOB#export'})['Items']


# ── POST: start ──────────────────────────────────────────────────────────────────────────────────────────────

def test_an_admin_starts_an_export_and_the_job_is_invoked_with_the_resolved_workspace(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST')
    assert status == 202
    export = body['export']
    assert export['status'] == 'queued'
    assert export['id'].startswith('ex_')
    world.invoke.assert_called_once_with(FUNCTION, {'export_id': export['id'], 'workspace_id': WS})
    rows = {row['sk']: row for row in _jobs(world)}
    assert rows['LOCK']['job_id'] == export['id']
    assert (rows[export['id']]['status'], rows[export['id']]['started_by_sub']) == ('queued', 'sub-ada')
    [audit] = _audit_rows(world)
    assert (audit['kind'], audit['actor'], audit['export_id']) == ('export_requested', 'sub-ada', export['id'])


def test_a_second_start_while_one_is_live_is_a_409(world, lambda_context):
    _call(world, lambda_context, 'POST')
    assert _call(world, lambda_context, 'POST') == (409, {'success': False, 'error': workspaces_handler.EXPORT_ALREADY_RUNNING})
    assert world.invoke.call_count == 1
    assert len([row for row in _jobs(world) if row['sk'].startswith('ex_')]) == 1


def test_a_start_while_an_erasure_holds_the_lock_says_an_erasure_is_running(world, lambda_context):
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK', 'job_id': 'erasure-0a1b2c3d4e5f',
                                    'locked_at': datetime.now(UTC).isoformat()})
    assert _call(world, lambda_context, 'POST') == (
        409, {'success': False, 'error': 'An erasure is running in this workspace: start the export when it ends'})
    assert world.invoke.call_count == 0


def test_a_body_never_chooses_the_workspace(world, lambda_context):
    event = rest_event('POST', EXPORT, claims=ADA, body={'workspace_id': 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'})
    event['headers']['X-Workspace-Id'] = WS
    status, _ = invoke(workspaces_handler, event, lambda_context, workspaces=world.workspaces)
    assert status == 202
    assert world.invoke.call_args.args[1]['workspace_id'] == WS


def test_a_failed_invoke_is_a_fixed_500_and_frees_the_workspace_for_another_export(world, lambda_context):
    world.invoke.side_effect = FAULT
    assert _call(world, lambda_context, 'POST') == (500, {'success': False, 'error': 'Failed to start the export'})
    [job] = [row for row in _jobs(world) if row['sk'].startswith('ex_')]
    assert job['status'] == 'failed'
    world.invoke.side_effect = None
    assert _call(world, lambda_context, 'POST')[0] == 202


# ── Who may ──────────────────────────────────────────────────────────────────────────────────────────────────

ROUTES = [('POST', EXPORT), ('GET', EXPORT), ('POST', LINK)]


@pytest.mark.parametrize(('method', 'path'), ROUTES)
@pytest.mark.parametrize('claims', [EDI, VIC], ids=['editor', 'viewer'])
def test_editors_and_viewers_get_403(world, lambda_context, method, path, claims):
    assert _call(world, lambda_context, method, path, claims=claims) == (
        403, {'success': False, 'error': 'Workspace admin access required'})
    assert _jobs(world) == []
    assert world.invoke.call_count == 0
    assert _audit_rows(world) == []


@pytest.mark.parametrize(('method', 'path'), ROUTES)
def test_a_non_member_gets_the_one_404_even_a_deployment_admin(world, lambda_context, method, path):
    assert _call(world, lambda_context, method, path, claims=NOR) == (
        404, {'success': False, 'error': 'Workspace not found'})
    assert _call(world, lambda_context, method, path, ws='ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9') == (
        404, {'success': False, 'error': 'Workspace not found'})


@pytest.mark.parametrize(('method', 'path'), ROUTES)
def test_the_header_is_required(world, lambda_context, method, path):
    assert _call(world, lambda_context, method, path, ws=None)[0] == 400


def test_a_platform_admin_enters_audited_and_exports(world, lambda_context):
    status, body = _call(world, lambda_context, 'POST', claims=PAT)
    assert status == 202
    kinds = {row['kind']: row for row in _audit_rows(world)}
    assert set(kinds) == {'platform_admin_entry', 'export_requested'}
    assert kinds['export_requested']['platform_admin'] is True
    assert world.invoke.call_args.args[1] == {'export_id': body['export']['id'], 'workspace_id': WS}


def test_the_role_of_a_start_or_a_link_is_read_from_the_table_not_the_cache(world, lambda_context):
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current')[0] == 200  # ada's admin role is cached
    world.workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'viewer'})
    assert _call(world, lambda_context, 'POST')[0] == 403
    assert _call(world, lambda_context, 'POST', LINK)[0] == 403


def test_a_platform_admins_status_polls_read_the_cached_membership_and_add_no_entry_rows(world, lambda_context):
    """The status GET is a read, resolved as the other reads are: a platform admin's polling writes one entry row
    (the first resolve), not one per poll."""
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', claims=PAT)[0] == 200
    entries = len(_audit_rows(world))
    assert entries == 1
    for _ in range(3):
        assert _call(world, lambda_context, 'GET', claims=PAT) == (200, {'export': None})
    assert len(_audit_rows(world)) == entries


# ── GET: the status; POST …/link: the link ───────────────────────────────────────────────────────────────────

def test_a_workspace_that_never_exported_answers_no_export(world, lambda_context):
    assert _call(world, lambda_context, 'GET') == (200, {'export': None})
    assert _audit_rows(world) == []


def _finish(world, export_id, **fields):
    world.aggregates.update_item(
        Key={'pk': f'WS#{WS}#JOB#export', 'sk': export_id},
        UpdateExpression='SET ' + ', '.join(f'#f{n} = :f{n}' for n in range(len(fields))),
        ExpressionAttributeNames={f'#f{n}': name for n, name in enumerate(fields)},
        ExpressionAttributeValues={f':f{n}': value for n, value in enumerate(fields.values())})


def test_a_running_export_shows_its_status_without_a_link(world, lambda_context):
    _, started = _call(world, lambda_context, 'POST')
    _finish(world, started['export']['id'], status='running', phase='feedback',
            progress_at=datetime.now(UTC).isoformat())
    status, body = _call(world, lambda_context, 'GET')
    assert status == 200
    assert (body['export']['status'], body['export']['phase']) == ('running', 'feedback')
    assert 'download' not in body['export']
    assert world.s3.calls == []


def _completed(world, lambda_context, completed: datetime) -> str:
    _, started = _call(world, lambda_context, 'POST')
    export_id = started['export']['id']
    _finish(world, export_id, status='completed', completed_at=completed.isoformat(),
            expires_at=(completed + timedelta(days=7)).isoformat(), size_bytes=1234, counts={'feedback': 3})
    return export_id


def test_the_status_of_a_completed_export_signs_nothing_and_writes_nothing(world, lambda_context):
    _completed(world, lambda_context, datetime.now(UTC))
    audits = len(_audit_rows(world))
    status, body = _call(world, lambda_context, 'GET')
    assert status == 200
    export = body['export']
    assert (export['status'], export['size_bytes'], export['counts']) == ('completed', 1234, {'feedback': 3})
    assert not {'download', 'url', 'started_by_sub', 'upload_id', 'workspace_id', 'pk', 'sk'} & set(export)
    assert world.s3.calls == []
    assert len(_audit_rows(world)) == audits


def test_a_completed_export_gets_a_fresh_15_minute_link_each_audited(world, lambda_context):
    export_id = _completed(world, lambda_context, datetime.now(UTC))
    status, body = _call(world, lambda_context, 'POST', LINK)
    assert status == 200
    link = body['link']
    assert (link['id'], link['expires_in']) == (export_id, 900)
    assert link['url'].endswith(f'ws/{WS}/exports/{export_id}/workspace-export.zip?X-Amz-Expires=900')
    assert world.s3.last_presign['ResponseContentDisposition'].startswith('attachment; filename="acme-export-')
    _call(world, lambda_context, 'POST', LINK)
    issued = [row for row in _audit_rows(world) if row['kind'] == 'export_link_issued']
    assert len(issued) == 2
    assert {row['export_id'] for row in issued} == {export_id}


def test_past_its_window_the_export_reads_expired_and_gets_no_link(world, lambda_context):
    _completed(world, lambda_context, datetime.now(UTC) - timedelta(days=8))
    _, body = _call(world, lambda_context, 'GET')
    assert body['export']['status'] == 'expired'
    assert _call(world, lambda_context, 'POST', LINK) == (
        409, {'success': False, 'error': workspaces_handler.EXPORT_NOT_DOWNLOADABLE})
    assert world.s3.calls == []
    assert [row for row in _audit_rows(world) if row['kind'] == 'export_link_issued'] == []


def test_no_link_for_a_running_export_or_none_at_all(world, lambda_context):
    assert _call(world, lambda_context, 'POST', LINK)[0] == 409
    _call(world, lambda_context, 'POST')
    assert _call(world, lambda_context, 'POST', LINK)[0] == 409
    assert world.s3.calls == []
