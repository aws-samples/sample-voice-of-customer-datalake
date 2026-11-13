"""shared/export_jobs.py: a workspace's export job row, its one-at-a-time lock, the generation claim and its freshness,
what a reader sees, and the link (moto-backed; the routes: lambda/api/test/test_workspaces_export_routes.py, the job:
lambda/jobs/workspace_export/test/)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import export_jobs
from shared.erasure_jobs import acquire_lock, refresh_lock, release_lock
from shared.test.export_s3_double import ExportS3
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import WorkspaceContext
from shared.ws_repo import ExportObjects, WorkspaceScope, export_job_pk, ws_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
SCOPE = WorkspaceScope(WS)
PARTITION = export_job_pk(SCOPE)
CONTEXT = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
NOW = datetime(2026, 11, 13, 9, 0, tzinfo=UTC)
FAULT = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'arn of a table'}}, 'Invoke')
UPDATE_FAULT = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}}, 'Update')


@pytest.fixture
def tables():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = create_pk_sk_table('aggregates', resource)
        workspaces = create_pk_sk_table('workspaces', resource)
        yield ws_table(SCOPE, aggregates), aggregates, workspaces


def _present[T](value: T | None) -> T:
    """``value``, which the case expects to be there."""
    assert value is not None
    return value


def _lock(aggregates):
    return aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'}).get('Item')


def _audits(workspaces):
    return workspaces.query(KeyConditionExpression='pk = :pk',
                            ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']


def test_an_export_id_is_ex_and_a_ulid_and_sorts_by_time():
    first, second = export_jobs.new_export_id(1_000), export_jobs.new_export_id(2_000)
    assert [export_jobs.is_export_id(first), export_jobs.is_export_id(second)] == [True, True]
    assert first < second
    for bad in ('ex_', 'er_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7DU', None, 7):
        assert not export_jobs.is_export_id(bad)
    with pytest.raises(ValueError, match='export id'):
        export_jobs.job_key(SCOPE, 'LOCK')


def _held() -> export_jobs.ExportRunning:
    return export_jobs.ExportRunning(WS)


def test_one_live_export_per_workspace_through_the_shared_lock(tables):
    view, aggregates, _ = tables
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW, _held())
    with pytest.raises(export_jobs.ExportRunning):
        acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', NOW, _held())
    # Released: the next export may start; a stale lock (an hour without renewal) is free too.
    release_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW)
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', NOW, _held())
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7DA', NOW + timedelta(hours=1, minutes=1), _held())
    assert _lock(aggregates)['job_id'] == 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'


def test_a_release_or_renewal_touches_only_its_own_lock(tables):
    view, aggregates, _ = tables
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW, _held())
    release_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', NOW)
    refresh_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', NOW + timedelta(minutes=5))
    lock = _lock(aggregates)
    assert 'released_at' not in lock
    assert lock['locked_at'] == NOW.isoformat()
    refresh_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW + timedelta(minutes=5))
    assert _lock(aggregates)['locked_at'] == (NOW + timedelta(minutes=5)).isoformat()


def _queued(view, export_id='ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', created=NOW):
    row = export_jobs.new_job_row(CONTEXT, export_id, 'sub-ada', created.isoformat())
    export_jobs.put_job_row(view, row)
    return export_id


def test_the_row_names_the_resolved_workspace_after_every_field(tables):
    view, aggregates, _ = tables
    row = export_jobs.new_job_row(CONTEXT, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'sub-ada', NOW.isoformat())
    assert list(row)[-1] == 'workspace_id'
    assert row['workspace_id'] == WS
    export_jobs.put_job_row(view, row)
    with pytest.raises(ClientError):
        export_jobs.put_job_row(view, row)  # never over an existing row
    stored = aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'})['Item']
    assert (stored['status'], stored['started_by_sub']) == ('queued', 'sub-ada')


def test_each_generation_is_claimed_once_and_in_order(tables):
    view, _, _ = tables
    export_id = _queued(view)
    assert export_jobs.claim_generation(view, export_id, 1, NOW) is None  # not before 0
    claimed = _present(export_jobs.claim_generation(view, export_id, 0, NOW))
    assert (claimed['status'], claimed['generation']) == ('running', 0)
    assert export_jobs.claim_generation(view, export_id, 0, NOW) is None  # a duplicate delivery
    assert export_jobs.claim_generation(view, export_id, 2, NOW) is None  # a skipped one
    assert _present(export_jobs.claim_generation(view, export_id, 1, NOW))['generation'] == 1
    assert export_jobs.claim_generation(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9', 0, NOW) is None


def test_a_late_start_or_hand_over_claims_nothing(tables):
    """A start held up past the lock's hour (a throttled invoke) never runs beside the export that took the freed
    lock; nor does a hand-over that arrives an hour after its predecessor moved."""
    view, _, _ = tables
    export_id = _queued(view, created=NOW - timedelta(hours=1, seconds=1))
    assert export_jobs.claim_generation(view, export_id, 0, NOW) is None
    fresh = _queued(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
    assert export_jobs.claim_generation(view, fresh, 0, NOW) is not None
    assert export_jobs.claim_generation(view, fresh, 1, NOW + timedelta(hours=1, seconds=1)) is None
    assert export_jobs.claim_generation(view, fresh, 1, NOW + timedelta(minutes=50)) is not None


def test_progress_lands_only_at_the_running_generation_and_a_finish_only_once(tables):
    view, aggregates, _ = tables
    export_id = _queued(view)
    export_jobs.claim_generation(view, export_id, 0, NOW)
    assert export_jobs.record_progress(view, export_id, 0, {'phase': 'feedback', 'counts': {'feedback': 3}})
    assert not export_jobs.record_progress(view, export_id, 1, {'phase': 'members'})
    assert export_jobs.finish_job(view, export_id, 'completed', {'size_bytes': 10})
    assert not export_jobs.finish_job(view, export_id, 'failed', {'error': 'late'})
    row = aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': export_id})['Item']
    assert (row['status'], row['phase'], row['size_bytes']) == ('completed', 'feedback', 10)


def test_the_newest_export_is_read_and_the_lock_is_never_listed(tables):
    view, _, _ = tables
    assert export_jobs.latest_job(view) is None
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW, _held())
    assert export_jobs.latest_job(view) is None
    _queued(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8')
    _queued(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9')
    assert _present(export_jobs.latest_job(view))['export_id'] == 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'


@pytest.mark.parametrize(('row', 'status', 'error'), [
    ({'status': 'completed', 'expires_at': (NOW + timedelta(days=1)).isoformat()}, 'completed', None),
    ({'status': 'completed', 'expires_at': (NOW - timedelta(seconds=1)).isoformat()}, 'expired', None),
    ({'status': 'running', 'progress_at': (NOW - timedelta(minutes=5)).isoformat()}, 'running', None),
    ({'status': 'running', 'progress_at': (NOW - timedelta(hours=2)).isoformat()}, 'failed',
     export_jobs.STALLED_ERROR),
    # A start dropped unrun (throttled past maxEventAge): it never claimed generation 0.
    ({'status': 'queued', 'created_at': (NOW - timedelta(hours=2)).isoformat()}, 'failed',
     export_jobs.NOT_STARTED_ERROR),
    ({'status': 'queued', 'created_at': (NOW - timedelta(minutes=50)).isoformat()}, 'queued', None),
    ({'status': 'cancelled', 'error': 'workspace_deleting'}, 'cancelled', 'workspace_deleting'),
    ({'status': 'erased', 'erased_at': NOW.isoformat()}, 'erased', None),
])
def test_what_a_reader_sees(row, status, error):
    shown = export_jobs.job_view({'export_id': 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', 'pk': 'x', 'sk': 'y',
                                  'started_by_sub': 'sub-ada', 'upload_id': 'u', **row}, NOW)
    assert (shown['status'], shown.get('error')) == (status, error)
    assert not {'pk', 'sk', 'started_by_sub', 'upload_id', 'workspace_id'} & set(shown)


def test_a_start_takes_the_lock_audits_writes_the_row_and_invokes_with_the_resolved_workspace(tables):
    view, aggregates, workspaces = tables
    invoke = MagicMock()
    shown = export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', invoke, NOW)
    assert shown['status'] == 'queued'
    assert export_jobs.is_export_id(shown['id'])
    invoke.assert_called_once_with({'export_id': shown['id'], 'workspace_id': WS})
    assert _lock(aggregates)['job_id'] == shown['id']
    [audit] = _audits(workspaces)
    assert (audit['kind'], audit['actor'], audit['export_id'], audit['platform_admin']) == (
        'export_requested', 'sub-ada', shown['id'], False)
    with pytest.raises(export_jobs.ExportRunning):
        export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', invoke, NOW)
    assert len(_audits(workspaces)) == 1


def test_a_dropped_hand_over_reads_failed_once_stale_and_a_new_start_works(tables):
    """A running export whose hand-over Lambda dropped (throttled past maxEventAge): nothing more is written, so past
    STALE_AFTER the reader sees it failed, "stopped before it finished" (not "did not start"), and the lock it held,
    renewed at that hand-over, is stale: a new start takes it."""
    view, aggregates, workspaces = tables
    shown = export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), NOW)
    export_jobs.claim_generation(view, shown['id'], 0, NOW)
    handed_over = NOW + timedelta(minutes=13)
    refresh_lock(view, PARTITION, shown['id'], handed_over)
    export_jobs.record_progress(view, shown['id'], 0, {'progress_at': handed_over.isoformat()})
    # The next generation never runs. Within the hour the export still reads running, and a start gets 409.
    within = handed_over + timedelta(minutes=59)
    assert _present(export_jobs.export_status(view, within))['status'] == 'running'
    with pytest.raises(export_jobs.ExportRunning):
        export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), within)
    later = handed_over + timedelta(hours=1, seconds=1)
    stalled = _present(export_jobs.export_status(view, later))
    assert (stalled['status'], stalled['error']) == ('failed', 'The export stopped before it finished. Start it again.')
    assert stalled['error'] != export_jobs.NOT_STARTED_ERROR
    again = export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), later)
    assert _lock(aggregates)['job_id'] == again['id']


def test_a_failed_invoke_fails_the_row_and_frees_the_lock(tables):
    view, aggregates, workspaces = tables
    with pytest.raises(ClientError):
        export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(side_effect=FAULT), NOW)
    row = _present(export_jobs.latest_job(view))
    assert (row['status'], row['error']) == ('failed', export_jobs.START_FAILED)
    assert 'released_at' in _lock(aggregates)
    export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), NOW)


def test_a_failed_finish_after_a_failed_invoke_still_frees_the_lock_and_raises_the_invoke_error(tables):
    view, aggregates, workspaces = tables
    with patch.object(export_jobs, 'finish_job', side_effect=UPDATE_FAULT), \
            pytest.raises(ClientError) as raised:
        export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(side_effect=FAULT), NOW)
    assert raised.value is FAULT
    assert 'released_at' in _lock(aggregates)


def _completed(view, export_id='ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', created=NOW):
    _queued(view, export_id, created)
    export_jobs.claim_generation(view, export_id, 0, created)
    export_jobs.finish_job(view, export_id, 'completed', {
        'completed_at': created.isoformat(), 'expires_at': export_jobs.expires_at(created)})
    return export_id


def test_the_status_is_read_only(tables):
    view, _, workspaces = tables
    assert export_jobs.export_status(view, NOW) is None
    _completed(view)
    shown = _present(export_jobs.export_status(view, NOW + timedelta(days=1)))
    assert shown['status'] == 'completed'
    assert 'url' not in shown
    assert 'download' not in shown
    assert _audits(workspaces) == []


def test_a_completed_export_gets_a_fresh_short_link_each_time_each_audited(tables):
    view, _, workspaces = tables
    export_id = _completed(view)
    s3 = ExportS3('raw-bucket')
    objects = ExportObjects(SCOPE, s3, 'raw-bucket')
    later = NOW + timedelta(days=6)
    link = export_jobs.issue_link(view, workspaces, objects, CONTEXT, 'sub-ada', later)
    assert (link['id'], link['expires_in']) == (export_id, 900)
    assert link['expires_at'] == (later + timedelta(minutes=15)).isoformat()
    assert s3.last_presign['Key'] == f'ws/{WS}/exports/{export_id}/workspace-export.zip'
    assert s3.last_presign['ResponseContentDisposition'] == 'attachment; filename="acme-export-2026-11-13.zip"'
    export_jobs.issue_link(view, workspaces, objects, CONTEXT, 'sub-ada', later)
    kinds = sorted(audit['kind'] for audit in _audits(workspaces))
    assert kinds == ['export_link_issued', 'export_link_issued']


def test_no_link_past_the_window_for_an_unfinished_or_erased_export_or_without_its_audit_row(tables):
    view, _, workspaces = tables
    s3 = ExportS3('raw-bucket')
    objects = ExportObjects(SCOPE, s3, 'raw-bucket')
    with pytest.raises(export_jobs.LinkUnavailable):
        export_jobs.issue_link(view, workspaces, objects, CONTEXT, 'sub-ada', NOW)
    _completed(view)
    with pytest.raises(export_jobs.LinkUnavailable):
        export_jobs.issue_link(view, workspaces, objects, CONTEXT, 'sub-ada', NOW + timedelta(days=7))
    broken = MagicMock()
    broken.put_item.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'x'}}, 'PutItem')
    with pytest.raises(ClientError):
        export_jobs.issue_link(view, broken, objects, CONTEXT, 'sub-ada', NOW + timedelta(days=1))
    export_jobs.mark_erased(view, NOW + timedelta(days=1))
    with pytest.raises(export_jobs.LinkUnavailable):
        export_jobs.issue_link(view, workspaces, objects, CONTEXT, 'sub-ada', NOW + timedelta(days=1))
    assert [method for method, _ in s3.calls] == []
    assert _audits(workspaces) == []


def test_an_erasure_marks_every_export_that_may_hold_objects(tables):
    view, aggregates, _ = tables
    _completed(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D1')
    _queued(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2')
    failed = _queued(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D3')
    export_jobs.finish_job(view, failed, 'failed', {'error': 'x'})
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2', NOW, _held())
    export_jobs.mark_erased(view, NOW)
    rows = {row['sk']: row for row in aggregates.query(
        KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': PARTITION})['Items']}
    # The one still under way says why it stopped; the completed one, erased after the fact, needs no error.
    assert export_jobs.job_view(rows['ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2'], NOW)['error'] == (
        "The workspace's data was erased during the export. Start a new one.")
    assert 'error' not in rows['ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D1']
    statuses = {sk: row['status'] for sk, row in rows.items() if sk != 'LOCK'}
    assert statuses == {'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D1': 'erased', 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2': 'erased',
                        'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D3': 'failed'}
    # A job marked erased can no longer record itself completed; the lock stays held until the erasure's last sweep.
    assert not export_jobs.finish_job(view, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2', 'completed', {})
    assert 'released_at' not in _lock(aggregates)
    export_jobs.mark_erased(view, NOW)  # once more: nothing left to mark, nothing changes
    assert {row['sk']: row['status'] for row in aggregates.query(
        KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': PARTITION})['Items']
        if row['sk'] != 'LOCK'} == statuses


def test_an_export_that_completes_between_the_read_and_the_mark_is_still_marked(tables):
    view, aggregates, _ = tables
    export_id = _queued(view)
    export_jobs.claim_generation(view, export_id, 0, NOW)
    acquire_lock(view, PARTITION, export_id, NOW, _held())
    read_while_running = list(view.iter_query('pk', PARTITION))
    export_jobs.finish_job(view, export_id, 'completed', {})  # it completes after the read
    # A WorkspaceTable is frozen (shared/ws_repo.py): a double that wraps it answers the stale read.
    stale = MagicMock(wraps=view)
    stale.scope = view.scope
    stale.iter_query.return_value = iter(read_while_running)
    export_jobs.mark_erased(stale, NOW)
    row = aggregates.get_item(Key={'pk': PARTITION, 'sk': export_id})['Item']
    assert row['status'] == 'erased'


def test_an_erasure_holds_the_lock_whoever_held_it_and_frees_only_its_own(tables):
    view, aggregates, workspaces = tables
    acquire_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW, _held())
    export_jobs.hold_for_erasure(view, 'erasure-run1', NOW)
    assert (_lock(aggregates)['job_id'], 'released_at' in _lock(aggregates)) == ('erasure-run1', False)
    with pytest.raises(export_jobs.ExportRunning):  # a start during the sweep: the usual 409
        export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), NOW)
    release_lock(view, PARTITION, 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', NOW)  # the erased export's own release: no-op
    assert 'released_at' not in _lock(aggregates)
    export_jobs.release_after_erasure(view, 'erasure-run1', NOW)
    export_jobs.start_export(view, workspaces, CONTEXT, 'sub-ada', MagicMock(), NOW)
    # A released lock taken again by a later pass (a hand-over) is held again.
    export_jobs.hold_for_erasure(view, 'erasure-run2', NOW)
    assert 'released_at' not in _lock(aggregates)
