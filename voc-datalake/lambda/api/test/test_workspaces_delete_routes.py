"""workspaces_handler.py: a workspace's hard delete, POST /me/workspaces/current/delete, and the platform's cancel and
resume (moto-backed; docs/multi-workspace.md, "Export and delete"; the job: lambda/jobs/workspace_delete/)."""
import os
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError
from moto import mock_aws
from moto_helpers import invoke, rest_event
from test_workspaces_members_routes import ADA, EDI, NOR, PAT, VIC, WS
from workspaces_api_world import workspaces_api

import workspaces_handler
from shared import workspace_deletes

DELETE = '/me/workspaces/current/delete'
CANCEL = f'/platform/workspaces/{WS}/delete/cancel'
RESUME = f'/platform/workspaces/{WS}/delete/resume'
FUNCTION = 'voc-workspace-delete'
BASIS = 'Customer contract ended (ticket 4512)'
BODY = {'confirm_slug': 'acme', 'legal_basis': BASIS}
FAULT = ClientError({'Error': {'Code': 'ServiceException', 'Message': 'arn:aws:lambda:us-east-1:1:function:x'}},
                    'Invoke')


@dataclass
class World:
    workspaces: Any
    aggregates: Any
    invoke: MagicMock


@pytest.fixture
def world() -> Iterator[World]:
    started = MagicMock()
    # The deployment flag on (-c workspaceHardDelete=true); the flag-off tests turn it off.
    with mock_aws(), patch.dict('os.environ', {'WORKSPACE_HARD_DELETE': 'true'}), \
            workspaces_api({'DELETE_FUNCTION': FUNCTION, 'invoke_lambda_async': started}) as (workspaces, aggregates):
        # The listing row a workspace's creation writes (shared/platform_workspaces.py), which the delete moves too.
        workspaces.put_item(Item={'pk': 'WORKSPACES', 'sk': f'acme outfitters#{WS}', 'workspace_id': WS,
                                  'name': 'Acme Outfitters', 'slug': 'acme', 'status': 'active'})
        yield World(workspaces, aggregates, started)


def _call(world, lambda_context, method='POST', path=DELETE, claims=ADA, ws: str | None = WS, body=None):
    event = rest_event(method, path, claims=claims, body=BODY if body is None and path == DELETE else body)
    if ws is not None:
        event['headers']['X-Workspace-Id'] = ws
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.workspaces)


def _rows(world, pk: str) -> list[dict]:
    return world.workspaces.query(KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': pk})['Items']


def _meta(world) -> dict:
    return world.workspaces.get_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})['Item']


def _listing(world) -> dict:
    return world.workspaces.get_item(Key={'pk': 'WORKSPACES', 'sk': f'acme outfitters#{WS}'})['Item']


def _job(world) -> dict:
    """The job row, or ``{}`` when there is none."""
    return world.workspaces.get_item(Key={'pk': 'WSDELETE', 'sk': WS}).get('Item') or {}


def _lock(world, kind: str) -> dict:
    """The lock row, or ``{}`` when there is none."""
    return world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#{kind}', 'sk': 'LOCK'}).get('Item') or {}


def _nothing_written(world) -> None:
    assert (_meta(world)['status'], _listing(world)['status'], _job(world)) == ('active', 'active', {})
    assert _rows(world, f'AUDIT#WS#{WS}') == []
    assert _rows(world, 'AUDIT#workspace-deletes') == []
    assert world.invoke.call_count == 0


# ── The deployment flag ──────────────────────────────────────────────────────────────────────────────────────

NOT_AVAILABLE = (403, {'success': False, 'error': 'Deleting a workspace is not available in this deployment'})


@pytest.mark.parametrize('value', [None, 'false', 'yes'])
@pytest.mark.parametrize(('path', 'claims', 'ws'), [(DELETE, ADA, WS), (DELETE, PAT, WS), (RESUME, PAT, None)])
def test_with_the_flag_off_the_request_and_the_resume_are_not_available_and_write_nothing(world, lambda_context,
                                                                                         value, path, claims, ws):
    env = {} if value is None else {'WORKSPACE_HARD_DELETE': value}
    with patch.dict('os.environ', env):
        if value is None:
            del os.environ['WORKSPACE_HARD_DELETE']
        before = world.workspaces.scan()['Items'], world.aggregates.scan()['Items']
        assert _call(world, lambda_context, path=path, claims=claims, ws=ws) == NOT_AVAILABLE
    # Not even a platform admin's entry row: the flag is read before anything else.
    assert (world.workspaces.scan()['Items'], world.aggregates.scan()['Items']) == before
    assert world.invoke.call_count == 0


def test_with_the_flag_turned_off_a_delete_in_its_fence_can_still_be_cancelled(world, lambda_context):
    """The flag on for the request, then off (the job gone): the cancel only restores the workspace, so it works."""
    assert _call(world, lambda_context)[0] == 202
    with patch.dict('os.environ', {'WORKSPACE_HARD_DELETE': 'false'}):
        status, body = _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)
        assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None) == NOT_AVAILABLE
    assert (status, body['delete']['status']) == (200, 'cancelled')
    assert (_meta(world)['status'], _listing(world)['status']) == ('active', 'active')
    assert 'released_at' in _lock(world, 'erasure')


# ── The request ──────────────────────────────────────────────────────────────────────────────────────────────

def test_an_admin_asks_and_the_workspace_is_deleting_its_job_waiting_both_audit_rows_written(world, lambda_context):
    status, body = _call(world, lambda_context)

    assert status == 202
    delete = body['delete']
    # The job's id (its workspace's: one delete per workspace), for a platform admin to follow, cancel or resume.
    assert (delete['job_id'], delete['workspace_id'], delete['status'], delete['phase']) == (WS, WS, 'waiting', 'fence')
    assert 'counters_rebuild' not in delete
    fence = datetime.fromisoformat(delete['fence_at']) - datetime.fromisoformat(delete['deleting_at'])
    assert fence == timedelta(minutes=21)
    assert not {'requested_by_sub', 'checkpoint', 'legal_basis', 'pk', 'sk'} & set(delete)
    meta, listing, job = _meta(world), _listing(world), _job(world)
    assert (meta['status'], listing['status']) == ('deleting', 'deleting')
    assert meta['deleting_at'] == listing['deleting_at'] == job['deleting_at']
    assert (job['requested_by_sub'], job['legal_basis'], job['slug'], job['workspace_id'], job['platform_admin']) == (
        'sub-ada', BASIS, 'acme', WS, False)
    [audit] = _rows(world, f'AUDIT#WS#{WS}')
    [platform] = _rows(world, 'AUDIT#workspace-deletes')
    assert (audit['kind'], audit['actor'], audit['legal_basis']) == ('workspace_delete_requested', 'sub-ada', BASIS)
    assert (platform['kind'], platform['workspace_id'], platform['slug']) == ('requested', WS, 'acme')
    assert (_lock(world, 'export')['job_id'], _lock(world, 'erasure')['job_id']) == (f'delete-{WS}', f'delete-{WS}')
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS})


def test_once_deleting_the_workspace_answers_the_one_404_and_nothing_more_is_written(world, lambda_context):
    assert _call(world, lambda_context)[0] == 202
    assert _call(world, lambda_context) == (404, {'success': False, 'error': 'Workspace not found'})
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', body=None)[0] == 404
    assert len(_rows(world, 'AUDIT#workspace-deletes')) == 1
    assert world.invoke.call_count == 1


@pytest.mark.parametrize('slug', ['Acme', 'acme ', 'birch', 'acm'])
def test_the_slug_must_be_typed_exactly(world, lambda_context, slug):
    assert _call(world, lambda_context, body={'confirm_slug': slug, 'legal_basis': BASIS}) == (
        400, {'success': False, 'error': "Type the workspace's slug exactly to confirm the delete"})
    _nothing_written(world)
    assert (_lock(world, 'export'), _lock(world, 'erasure')) == ({}, {})


@pytest.mark.parametrize(('body', 'says'), [
    ({'confirm_slug': 'acme'}, 'legal_basis is required'),
    ({'confirm_slug': 'acme', 'legal_basis': '  '}, 'legal_basis is required'),
    ({'confirm_slug': 'acme', 'legal_basis': 'asked by ada@example.com'}, 'must not contain personal data'),
    ({'confirm_slug': 'acme', 'legal_basis': 'x' * 301}, 'at most 300'),
    ({'legal_basis': BASIS}, 'confirm_slug is required'),
    ({**BODY, 'workspace_id': 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'}, 'Unknown field'),
])
def test_a_bad_body_is_a_400_that_says_what_to_fix(world, lambda_context, body, says):
    status, answer = _call(world, lambda_context, body=body)
    assert status == 400
    assert says in answer['error']
    _nothing_written(world)


@pytest.mark.parametrize('claims', [EDI, VIC], ids=['editor', 'viewer'])
def test_editors_and_viewers_get_403(world, lambda_context, claims):
    assert _call(world, lambda_context, claims=claims) == (
        403, {'success': False, 'error': 'Workspace admin access required'})
    _nothing_written(world)


def test_a_non_member_gets_the_one_404_even_a_deployment_admin(world, lambda_context):
    assert _call(world, lambda_context, claims=NOR) == (404, {'success': False, 'error': 'Workspace not found'})
    assert _call(world, lambda_context, ws=None)[0] == 400
    _nothing_written(world)


def test_a_platform_admin_enters_audited_and_deletes(world, lambda_context):
    assert _call(world, lambda_context, claims=PAT)[0] == 202
    kinds = {row['kind']: row for row in _rows(world, f'AUDIT#WS#{WS}')}
    assert set(kinds) == {'platform_admin_entry', 'workspace_delete_requested'}
    assert kinds['workspace_delete_requested']['platform_admin'] is True
    assert _job(world)['platform_admin'] is True


def test_the_role_is_read_from_the_table_not_the_cache(world, lambda_context):
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', body=None)[0] == 200
    world.workspaces.put_item(Item={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'viewer'})
    assert _call(world, lambda_context)[0] == 403


@pytest.mark.parametrize(('kind', 'holder', 'says'), [
    ('export', 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'An export of this workspace is running'),
    ('export', 'erasure-0a1b2c3d4e5f', 'An erasure is running in this workspace'),
    ('erasure', 'er_0123456789ab', 'An erasure is running in this workspace'),
])
def test_while_an_export_or_an_erasure_runs_it_is_a_409_and_nothing_changes(world, lambda_context, kind, holder,
                                                                             says):
    held = {'pk': f'WS#{WS}#JOB#{kind}', 'sk': 'LOCK', 'job_id': holder, 'locked_at': datetime.now(UTC).isoformat()}
    world.aggregates.put_item(Item=held)
    status, body = _call(world, lambda_context)
    assert status == 409
    assert body['error'].startswith(says)
    _nothing_written(world)
    assert _lock(world, kind) == held
    other = 'erasure' if kind == 'export' else 'export'
    # A lock the request took before it met the held one is freed again.
    assert _lock(world, other) == {} or 'released_at' in _lock(world, other)


def test_a_stale_or_released_lock_does_not_block(world, lambda_context):
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK', 'job_id': 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8',
                                    'locked_at': (datetime.now(UTC) - timedelta(hours=2)).isoformat()})
    assert _call(world, lambda_context)[0] == 202


def test_a_failed_invoke_is_a_500_naming_who_can_act_and_leaves_a_job_a_platform_admin_can_cancel_or_resume(
        world, lambda_context):
    world.invoke.side_effect = FAULT
    assert _call(world, lambda_context) == (500, {'success': False, 'error': (
        'The workspace is marked for deletion, but its delete could not start. '
        'Ask a platform admin to cancel or resume it.')})
    job = _job(world)
    assert (job['status'], job['phase']) == ('failed', 'fence')
    world.invoke.side_effect = None
    assert _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)[0] == 200
    assert _meta(world)['status'] == 'active'


def test_a_workspace_changed_meanwhile_is_a_409_and_frees_the_locks(world, lambda_context):
    """The transaction finds META no longer active (another change won): nothing of it is written."""
    real = world.workspaces.meta.client.transact_write_items

    def changed_first(**request):
        world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :p',
                                     ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':p': 'paused'})
        return real(**request)

    with patch.object(world.workspaces.meta.client, 'transact_write_items', changed_first):
        status, body = _call(world, lambda_context)
    assert status == 409
    assert 'changed while the delete was being requested' in body['error']
    assert _job(world) == {}
    assert 'released_at' in _lock(world, 'export')
    assert 'released_at' in _lock(world, 'erasure')


def _request(world, now: datetime, started: MagicMock | None = None) -> dict:
    """``request_delete`` called directly, as the route calls it (ada, the workspace's admin)."""
    from shared.ingest_tables import ingest_table
    from shared.workspace import WorkspaceContext
    from shared.workspace_deletes import DeleteRequest, request_delete
    from shared.ws_repo import WorkspaceScope

    context = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
    jobs = ingest_table(WorkspaceScope(WS), workspaces_handler.get_dynamodb_resource(), 'aggregates')
    return request_delete(world.workspaces, jobs, context, 'sub-ada', DeleteRequest('acme', BASIS),
                          started or MagicMock(), now)


def test_a_repeat_whose_transaction_meets_the_same_job_answers_that_job(world):
    """Two requests that both resolved the workspace active: the second's transaction meets the first's job row and
    answers it, writing nothing and invoking nothing."""
    now = datetime.now(UTC)
    first = _request(world, now)
    started = MagicMock()
    again = _request(world, now + timedelta(seconds=1), started)
    assert again == first
    started.assert_not_called()
    assert len(_rows(world, 'AUDIT#workspace-deletes')) == 1
    assert _lock(world, 'export')['job_id'] == f'delete-{WS}'


def _transaction(world, fault: Exception, *, commit_first: bool):
    """The request's transaction, committed first or not, then answering ``fault`` (a lost answer, a timeout, or a
    botocore retry meeting the rows its own first attempt wrote); the requests it was sent with."""
    real, sent = world.workspaces.meta.client.transact_write_items, []

    def faulty(**request):
        sent.append(request)
        if commit_first:
            real(**request)
        raise fault

    return patch.object(world.workspaces.meta.client, 'transact_write_items', faulty), sent


CANCELLED_BY_ITS_OWN_ROWS = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'x'},
                                         'CancellationReasons': [{'Code': 'ConditionalCheckFailed'}]},
                                        'TransactWriteItems')


@pytest.mark.parametrize('fault', [BotoCoreError(), CANCELLED_BY_ITS_OWN_ROWS], ids=['lost-answer', 'retry-canceled'])
def test_a_transaction_that_committed_before_its_error_still_invokes_the_job(world, lambda_context, fault):
    patched, sent = _transaction(world, fault, commit_first=True)
    with patched:
        status, body = _call(world, lambda_context)
    assert (status, body['delete']['status']) == (202, 'waiting')
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS})
    assert (_meta(world)['status'], _job(world)['status']) == ('deleting', 'waiting')
    # Idempotent at DynamoDB: one token per request (a botocore retry sends the same one).
    assert [len(str(request['ClientRequestToken'])) for request in sent] == [36]
    # The locks stay with the delete.
    assert (_lock(world, 'export')['job_id'], _lock(world, 'erasure')['job_id']) == (f'delete-{WS}', f'delete-{WS}')
    assert 'released_at' not in _lock(world, 'export')


@pytest.mark.parametrize(('other', 'why'), [
    ({'requested_by_sub': 'sub-other'}, 'the same requested_at, another requester'),
    ({'requested_at': '2026-01-01T00:00:00+00:00'}, 'the same requester, an older requested_at'),
    ({}, 'the same requested_at and requester, another token'),
], ids=['other-sub', 'older', 'other-token'])
def test_a_row_is_this_requests_own_by_its_token_alone(world, other, why):
    """The transaction fails without committing, and the job row is another request's: whatever its requested_at and
    requester, only the token makes a row this request's own, so this request answers that job and starts nothing."""
    def another_requests_row_then_fail(**request):
        put = next(item['Put'] for item in request['TransactItems']
                   if 'Put' in item and item['Put']['Item'].get('pk') == 'WSDELETE')
        world.workspaces.put_item(Item={**put['Item'], 'request_token': 'another-request', **other})
        raise BotoCoreError

    started = MagicMock()
    with patch.object(world.workspaces.meta.client, 'transact_write_items', another_requests_row_then_fail):
        answer = _request(world, datetime.now(UTC), started)
    started.assert_not_called()
    assert (answer['status'], _job(world)['request_token']) == ('waiting', 'another-request'), why


def test_a_transaction_that_failed_before_committing_frees_the_locks_and_writes_nothing(world, lambda_context):
    patched, _sent = _transaction(world, BotoCoreError(), commit_first=False)
    with patched, patch.object(workspace_deletes.time, 'sleep') as waited:
        status, _body = _call(world, lambda_context)
    assert status == 500
    _nothing_written(world)
    assert 'released_at' in _lock(world, 'export')
    assert 'released_at' in _lock(world, 'erasure')
    # The job row was read again after the wait before the locks went.
    waited.assert_called_once_with(workspace_deletes.CONFIRM_FAILURE_WAIT_SECONDS)


def test_a_failed_read_before_the_transaction_frees_the_locks_and_writes_nothing(world, lambda_context):
    with patch.object(workspace_deletes, '_read_job', side_effect=BotoCoreError):
        status, _body = _call(world, lambda_context)
    assert status == 500
    _nothing_written(world)
    assert 'released_at' in _lock(world, 'export')
    assert 'released_at' in _lock(world, 'erasure')


def test_a_concurrent_request_committing_after_this_ones_failure_keeps_its_locks(world):
    """The first request's transaction fails; a second request's, in flight meanwhile, commits during the first's
    wait. The first finds that job on its second read: it answers it and frees nothing, so the job keeps its locks."""
    real = world.workspaces.meta.client.transact_write_items
    calls: list[int] = []

    def first_fails(**request):
        calls.append(1)
        if len(calls) == 1:
            raise BotoCoreError
        return real(**request)

    now = datetime.now(UTC)
    second: dict = {}
    with patch.object(world.workspaces.meta.client, 'transact_write_items', first_fails), \
            patch.object(workspace_deletes.time, 'sleep',
                         side_effect=lambda _seconds: second.update(_request(world, now + timedelta(seconds=1)))):
        first = _request(world, now)
    assert first == second
    assert _job(world)['requested_at'] == (now + timedelta(seconds=1)).isoformat()
    for kind in ('export', 'erasure'):
        assert (_lock(world, kind)['job_id'], 'released_at' in _lock(world, kind)) == (f'delete-{WS}', False)


def test_a_workspace_whose_delete_was_cancelled_can_be_deleted_again(world, lambda_context):
    assert _call(world, lambda_context)[0] == 202
    assert _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)[0] == 200
    world.invoke.reset_mock()
    status, body = _call(world, lambda_context)
    assert (status, body['delete']['status']) == (202, 'waiting')
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS})
    assert [row['kind'] for row in _rows(world, 'AUDIT#workspace-deletes')].count('requested') == 2
    # The cancel's rebuild marker is not lost with the cancelled row the new request replaces.
    assert _job(world)['counters_rebuild'].endswith(f'--workspace {WS} --apply')
    assert body['delete']['counters_rebuild'] == _job(world)['counters_rebuild']


# ── Cancel ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_platform_admin_cancels_during_the_fence_and_the_workspace_is_active_again(world, lambda_context):
    _call(world, lambda_context)
    with patch('shared.workspace_deletes.metrics.add_metric') as add_metric:
        status, body = _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)

    assert (status, body['delete']['status']) == (200, 'cancelled')
    # The answer says the counters need the operator's rebuild, and a metric counts it.
    assert body['delete']['counters_rebuild'].endswith(f'rebuild_aggregates.py --workspace {WS} --apply')
    add_metric.assert_any_call(name='WorkspaceCountersRebuildRequired', unit='Count', value=1)
    assert (_meta(world)['status'], _listing(world)['status']) == ('active', 'active')
    assert 'deleting_at' not in _meta(world)
    cancelled = {row['kind']: row for row in _rows(world, 'AUDIT#workspace-deletes')}['cancelled']
    assert (cancelled['actor'], cancelled['platform_admin']) == ('sub-pat', True)
    assert cancelled['dropped_messages'] == 0
    assert cancelled['counters_rebuild'].endswith(f'rebuild_aggregates.py --workspace {WS} --apply')
    assert 'workspace_delete_cancelled' in {row['kind'] for row in _rows(world, f'AUDIT#WS#{WS}')}
    assert 'released_at' in _lock(world, 'export')
    assert 'released_at' in _lock(world, 'erasure')
    assert _call(world, lambda_context, 'GET', '/me/workspaces/current', body=None)[0] == 200


def _counter(world) -> dict:
    """The workspace's drop counter, ``WS#{ws}`` / ``WSDELETE_DROPS``, or ``{}``."""
    return world.workspaces.get_item(Key={'pk': f'WS#{WS}', 'sk': 'WSDELETE_DROPS'}).get('Item') or {}


def test_the_cancels_audit_rows_report_the_processors_count_and_the_counter_goes(world, lambda_context):
    """The request puts the counter at 0, the processor adds each batch's drops (``count_dropped``), the cancel
    records at least that count and deletes the counter in its own transaction; later drops are not counted."""
    _call(world, lambda_context)
    assert _counter(world) == {'pk': f'WS#{WS}', 'sk': 'WSDELETE_DROPS', 'dropped': 0}
    assert workspace_deletes.count_dropped(world.workspaces, WS, 3) is True
    assert workspace_deletes.count_dropped(world.workspaces, WS, 2) is True
    assert workspace_deletes.count_dropped(world.workspaces, WS, 0) is False
    assert 'dropped' not in _job(world)  # the job row is never touched by the count
    _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)
    cancelled = {row['kind']: row for row in _rows(world, 'AUDIT#workspace-deletes')}['cancelled']
    assert cancelled['dropped_messages'] == 5
    [workspace_row] = [row for row in _rows(world, f'AUDIT#WS#{WS}') if row['kind'] == 'workspace_delete_cancelled']
    assert workspace_row['dropped_messages'] == 5
    assert _counter(world) == {}
    # A batch that lands after the cancel counts nowhere and makes no counter (the count is a lower bound).
    assert workspace_deletes.count_dropped(world.workspaces, WS, 4) is False
    assert _counter(world) == {}


def test_no_counter_is_ever_made_for_a_workspace_with_no_delete(world):
    assert workspace_deletes.count_dropped(world.workspaces, WS, 1) is False
    assert (_counter(world), _job(world)) == ({}, {})


def test_a_repeated_cancel_answers_the_cancelled_job(world, lambda_context):
    _call(world, lambda_context)
    _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)
    status, body = _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)
    assert (status, body['delete']['status']) == (200, 'cancelled')
    assert [row['kind'] for row in _rows(world, 'AUDIT#workspace-deletes')].count('cancelled') == 1


@pytest.mark.parametrize('job', [
    {'status': 'running', 'phase': 'feedback'},  # the job began
    {'status': 'failed', 'phase': 'feedback'},  # it began, then stopped
    {'status': 'completed', 'phase': 'complete'},
])
def test_once_the_job_began_a_cancel_is_a_409_and_changes_nothing(world, lambda_context, job):
    _call(world, lambda_context)
    world.workspaces.put_item(Item={**_job(world), **job})
    assert _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None) == (
        409, {'success': False, 'error': 'The delete has begun deleting: it can no longer be cancelled'})
    assert _meta(world)['status'] == 'deleting'
    assert 'cancelled' not in {row['kind'] for row in _rows(world, 'AUDIT#workspace-deletes')}


@pytest.mark.parametrize('job', [
    {'status': 'waiting'},  # its start was never claimed (an invoke dropped, the flag turned off)
    {'status': 'failed', 'error': 'The delete could not start. A platform admin can resume it.'},  # START_FAILED
], ids=['never-claimed', 'start-failed'])
def test_a_delete_that_never_began_is_cancelled_past_its_fence(world, lambda_context, job):
    """Past ``fence_at`` with the row still in the fence phase nothing was deleted, so the cancel still restores the
    workspace (with the flag off the resume is refused: without this it would stay ``deleting`` for good)."""
    _call(world, lambda_context)
    world.workspaces.put_item(Item={**_job(world), 'phase': 'fence',
                                    'fence_at': (datetime.now(UTC) - timedelta(minutes=5)).isoformat(), **job})
    status, body = _call(world, lambda_context, path=CANCEL, claims=PAT, ws=None)
    assert (status, body['delete']['status']) == (200, 'cancelled')
    assert (_meta(world)['status'], _listing(world)['status']) == ('active', 'active')


@pytest.mark.parametrize('path', [CANCEL, RESUME])
@pytest.mark.parametrize('claims', [ADA, NOR], ids=['member-admin', 'deployment-admin'])
def test_cancel_and_resume_are_for_platform_admins_only(world, lambda_context, path, claims):
    _call(world, lambda_context)
    assert _call(world, lambda_context, path=path, claims=claims, ws=None)[0] == 403
    assert _job(world)['status'] == 'waiting'


@pytest.mark.parametrize('path', [CANCEL, RESUME])
@pytest.mark.parametrize('ws', ['ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', 'not-a-workspace'])
def test_a_workspace_with_no_delete_is_a_404(world, lambda_context, path, ws):
    assert _call(world, lambda_context, path=path.replace(WS, ws), claims=PAT, ws=None) == (
        404, {'success': False, 'error': 'No delete of this workspace'})


# ── Resume ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_failed_job_resumes_from_its_checkpoint_at_its_next_generation(world, lambda_context):
    _call(world, lambda_context)
    world.workspaces.put_item(Item={**_job(world), 'status': 'failed', 'phase': 'objects', 'generation': 6,
                                    'checkpoint': {'phase': 'objects', 'cursor': {'failed_rounds': 0},
                                                   'counts': {'feedback': 9}},
                                    'error': 'The delete failed in objects (ClientError)'})
    assert _resume_status(world, lambda_context) == (200, 'running')
    # The generation only: the job reads its checkpoint from the row, never from the event.
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS, 'run': {'generation': 7}})
    assert _job(world)['checkpoint']['phase'] == 'objects'
    assert _job(world)['resumes'] == 1
    assert 'resumed' in {row['kind'] for row in _rows(world, 'AUDIT#workspace-deletes')}


def test_a_stalled_job_resumes_and_a_moving_or_finished_one_does_not(world, lambda_context):
    _call(world, lambda_context)
    world.workspaces.put_item(Item={**_job(world), 'status': 'running', 'phase': 'memory', 'generation': 2,
                                    'progress_at': datetime.now(UTC).isoformat()})
    assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None)[0] == 409
    world.workspaces.put_item(Item={**_job(world), 'progress_at': (datetime.now(UTC) - timedelta(hours=2)).isoformat()})
    assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None)[0] == 200
    world.workspaces.put_item(Item={**_job(world), 'status': 'completed'})
    assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None)[0] == 409


@pytest.mark.parametrize('with_progress_at', [True, False])
def test_a_start_never_claimed_reads_stalled_and_resumes(world, lambda_context, with_progress_at):
    """The start invoke was throttled past its event age (or the invocation died before its claim): a waiting row
    with no generation, requested two hours ago, resumes with 200 (a row written before the request wrote
    progress_at too), and the job then claims generation 0."""
    assert _call(world, lambda_context)[0] == 202
    assert _job(world)['progress_at'] == _job(world)['requested_at']
    two_hours_ago = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    row = {**_job(world), 'requested_at': two_hours_ago, 'progress_at': two_hours_ago}
    if not with_progress_at:
        del row['progress_at']
    world.workspaces.put_item(Item=row)
    assert _resume_status(world, lambda_context) == (200, 'waiting')
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS})
    assert workspace_deletes.claim_generation(world.workspaces, WS, 0, datetime.now(UTC)) is not None


def _resume_status(world, lambda_context) -> tuple[int, str]:
    """A platform admin's resume (the invoke mock reset first): its status code and the job's status."""
    world.invoke.reset_mock()
    status, body = _call(world, lambda_context, path=RESUME, claims=PAT, ws=None)
    return status, body['delete']['status']


def test_a_resume_whose_invoke_fails_leaves_the_job_failed_and_resumable_at_once(world, lambda_context):
    _call(world, lambda_context)
    world.workspaces.put_item(Item={**_job(world), 'status': 'failed', 'phase': 'objects', 'generation': 3})
    world.invoke.side_effect = FAULT
    assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None) == (
        500, {'success': False, 'error': 'The delete could not be resumed. Try the resume again.'})
    assert (_job(world)['status'], _job(world)['resumes']) == ('failed', 1)
    world.invoke.side_effect = None
    assert _resume_status(world, lambda_context) == (200, 'running')


def test_a_resume_of_a_job_never_started_starts_it_at_generation_0(world, lambda_context):
    world.invoke.side_effect = FAULT
    _call(world, lambda_context)
    world.invoke.side_effect = None
    world.invoke.reset_mock()
    assert _call(world, lambda_context, path=RESUME, claims=PAT, ws=None)[0] == 200
    world.invoke.assert_called_once_with(FUNCTION, {'workspace_id': WS})
    assert _job(world)['status'] == 'waiting'
