"""voc-retention reaches a workspace's exports (TENETS.md D5; jobs/retention/exports.py): an erasure that deleted any
item of a workspace, or de-identified one of its memberships, marks its exports erased, aborts its open export upload and deletes every version of every
object under ``ws/{ws}/exports/``; a workspace it did not reach, and a daily retention run, keep theirs."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import copies, exports, handler, runs
from jobs.retention.test.conftest import BUCKET, erasure_job
from jobs.retention.test.test_workspace_erasure import WS, WS_TWO, _versions, put_workspace_feedback
from shared import export_jobs, retention
from shared.workspace import WorkspaceContext
from shared.ws_repo import WorkspaceScope, ws_table

JOB_ID = 'er_00000000e0e0'
DONE = 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D1'
RUNNING = 'ex_01JC3Q8ZK6V7W9X2Y4A5B6C7D2'


def _export(aws: dict[str, Any], ws: str, export_id: str, status: str) -> None:
    aws['aggregates'].put_item(Item={'pk': f'WS#{ws}#JOB#export', 'sk': export_id, 'export_id': export_id,
                                     'status': status, 'workspace_id': ws})


def _seed_exports(aws: dict[str, Any], ws: str) -> str:
    """A completed export (its zip written twice: two versions; one work object) and a running one (an open upload),
    in an active workspace (its META: an erasure takes the export lock of an active workspace only)."""
    aws['workspaces'].put_item(Item={'pk': f'WS#{ws}', 'sk': 'META', 'status': 'active'})
    prefix = f'ws/{ws}/exports/'
    for _ in range(2):
        aws['s3'].put_object(Bucket=BUCKET, Key=f'{prefix}{DONE}/workspace-export.zip', Body=b'PK zip')
    aws['s3'].put_object(Bucket=BUCKET, Key=f'{prefix}{DONE}/work/cd-0', Body=b'records')
    upload = aws['s3'].create_multipart_upload(Bucket=BUCKET, Key=f'{prefix}{RUNNING}/workspace-export.zip')
    _export(aws, ws, DONE, 'completed')
    _export(aws, ws, RUNNING, 'running')
    return str(upload['UploadId'])


def _uploads(aws: dict[str, Any], prefix: str) -> list[str]:
    return [upload['Key'] for upload in aws['s3'].list_multipart_uploads(Bucket=BUCKET, Prefix=prefix)
            .get('Uploads', [])]


def _statuses(aws: dict[str, Any], ws: str) -> dict[str, str]:
    rows = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(f'WS#{ws}#JOB#export'))['Items']
    return {str(row['sk']): str(row['status']) for row in rows if row['sk'] != 'LOCK'}


def _erase_jane_and_check_the_exports_are_gone(aws: dict[str, Any], worker_context: Any) -> dict[str, Any]:
    """Run the deployment's erasure of jane@example.com; it completes, and WS's exports hold no version or upload."""
    result = handler.handle_event(erasure_job(aws, JOB_ID, 'email', 'jane@example.com', legal_basis='GDPR'),
                                  worker_context)
    assert result['status'] == 'completed'
    assert _versions(aws, f'ws/{WS}/exports/') == []
    assert _uploads(aws, f'ws/{WS}/exports/') == []
    return result


def test_an_erasure_that_reaches_a_workspace_clears_its_exports(aws, worker_context):
    put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
    _seed_exports(aws, WS)
    _seed_exports(aws, WS_TWO)  # no item of Jane there: its exports stay
    result = _erase_jane_and_check_the_exports_are_gone(aws, worker_context)
    assert _statuses(aws, WS) == {DONE: 'erased', RUNNING: 'erased'}
    # Two keys held data (the zip, every version of it, and the work object).
    assert result['deleted_export_objects'] == 2
    job = aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']
    assert job['deleted_export_objects'] == 2
    assert _versions(aws, f'ws/{WS_TWO}/exports/') != []
    assert _uploads(aws, f'ws/{WS_TWO}/exports/') != []
    assert _statuses(aws, WS_TWO) == {DONE: 'completed', RUNNING: 'running'}


def test_an_erasure_that_reaches_no_workspace_item_touches_no_export(aws, worker_context):
    _seed_exports(aws, WS)
    result = handler.handle_event(erasure_job(aws, JOB_ID, 'email', 'nobody@example.com', legal_basis='GDPR'),
                                  worker_context)
    assert 'deleted_export_objects' not in result
    assert _statuses(aws, WS) == {DONE: 'completed', RUNNING: 'running'}
    assert _versions(aws, f'ws/{WS}/exports/') != []


def test_a_daily_retention_run_keeps_the_exports(aws, worker_context):
    put_workspace_feedback(aws, WS, 'f1')
    _seed_exports(aws, WS)
    profiles = [{'id': 'web', 'retention_days': 0, 'retention_legal_basis': 'contract'}]
    with patch.object(handler, 'load_source_profiles', return_value=profiles), \
            patch.object(handler.retention, 'retention_cutoffs', return_value={'web': '2999-01-01'}):
        handler.handle_event({'mode': 'retention'}, worker_context)
    assert _statuses(aws, WS) == {DONE: 'completed', RUNNING: 'running'}
    assert _versions(aws, f'ws/{WS}/exports/') != []


def _member(aws: dict[str, Any], ws: str, email: str) -> None:
    aws['workspaces'].put_item(Item={'pk': f'WS#{ws}', 'sk': 'MEMBER#sub-jane', 'role': 'viewer', 'email': email,
                                     'name': 'Jane Doe'})


def test_a_member_only_erasure_by_email_clears_the_workspaces_exports(aws, worker_context):
    """Jane has no feedback in the workspace, only a membership: its exports' members/ held her email."""
    _member(aws, WS, 'jane@example.com')
    _seed_exports(aws, WS)
    result = handler.handle_event(erasure_job(aws, JOB_ID, 'email', 'jane@example.com', legal_basis='GDPR'),
                                  worker_context)
    assert result['member_rows_deidentified'] == 1
    assert 'deleted_workspace_items' not in result
    assert _statuses(aws, WS) == {DONE: 'erased', RUNNING: 'erased'}
    assert _versions(aws, f'ws/{WS}/exports/') == []
    assert _uploads(aws, f'ws/{WS}/exports/') == []


def test_an_export_started_between_the_member_and_exports_phases_cannot_keep_the_email(aws, worker_context):
    """The exports phase runs after the memberships: an export written while they were de-identified is swept."""
    _member(aws, WS, 'jane@example.com')
    real_erase = handler.members.MemberEraser.erase

    def erase_then_export(eraser: Any, row: Any) -> None:
        real_erase(eraser, row)
        # An export that read the row before it changed writes its zip now.
        aws['s3'].put_object(Bucket=BUCKET, Key=f'ws/{WS}/exports/{DONE}/workspace-export.zip', Body=b'jane@')
        _export(aws, WS, DONE, 'completed')

    with patch.object(handler.members.MemberEraser, 'erase', erase_then_export):
        handler.handle_event(erasure_job(aws, JOB_ID, 'email', 'jane@example.com', legal_basis='GDPR'),
                             worker_context)
    phases = handler._phases(handler.Walk(handler._tables(), worker_context, {}, {'mode': 'erase', 'field': 'email'},
                                          lambda store: retention.erase_filter('email', 'x', None, store), None))
    assert phases.index('members') < phases.index('exports') < phases.index('lineage')
    assert _versions(aws, f'ws/{WS}/exports/') == []
    assert _statuses(aws, WS) == {DONE: 'erased'}


def test_a_resumed_exports_phase_finishes_counts_once_and_keeps_its_list(aws):
    """A real resume: the time runs low between two delete pages; the carried run (through the hand-over's
    state) finishes the workspace, counts each object once, and leaves it off the list."""
    for n in range(3):
        aws['s3'].put_object(Bucket=BUCKET, Key=f'ws/{WS}/exports/{DONE}/work/cd-{n}', Body=b'records')
    _export(aws, WS, DONE, 'completed')
    run = runs.new_run({}, 'erase')
    run['erased_workspaces'] = [WS, WS_TWO]
    budget = iter([True, False])
    with patch.object(handler.retention, '_MAX_VERSIONS_PER_DELETE', 1):
        assert exports.clear(run, aws['s3'], BUCKET, aws['aggregates'], lambda: next(budget, True)) is False
        assert run['deleted_export_objects'] == 1
        carried = runs.new_run({'run': runs.carried_state(run)}, 'erase')
        assert carried['erased_workspaces'] == [WS, WS_TWO]
        assert exports.clear(carried, aws['s3'], BUCKET, aws['aggregates'], lambda: True) is True
    assert carried['deleted_export_objects'] == 3
    assert carried['erased_workspaces'] == []
    assert 'erased_workspaces' not in runs.carried_state(carried)
    assert _versions(aws, f'ws/{WS}/exports/') == []
    assert _statuses(aws, WS) == {DONE: 'erased'}


def test_the_second_sweep_deletes_a_work_object_written_after_the_first(aws):
    """A running export's last invocation writes its tail just after the first sweep's last page: the second sweep
    deletes it (with ``_SWEEPS = 1`` it would stay)."""
    _seed_exports(aws, WS)
    real_page = retention.delete_raw_prefix_page
    late = {'written': False}

    def page_then_late_write(*args: Any, **kwargs: Any) -> tuple[int, bool]:
        deleted, more = real_page(*args, **kwargs)
        if not more and not late['written']:
            late['written'] = True
            aws['s3'].put_object(Bucket=BUCKET, Key=f'ws/{WS}/exports/{RUNNING}/work/tail-0', Body=b'tail')
        return deleted, more

    run = runs.new_run({}, 'erase')
    run['erased_workspaces'] = [WS]
    with patch.object(exports.retention, 'delete_raw_prefix_page', page_then_late_write):
        assert exports.clear(run, aws['s3'], BUCKET, aws['aggregates'], lambda: True) is True
    assert late['written']
    assert _versions(aws, f'ws/{WS}/exports/') == []


def test_an_export_started_during_the_sweep_is_refused_and_the_lock_is_freed_after_it(aws):
    """The erasure holds the export lock from before it marks the exports until after its last sweep: a start in
    between answers 409 (the sweep would destroy it), and the workspace may export again once it is done."""
    _seed_exports(aws, WS)
    view = ws_table(WorkspaceScope(WS), aws['aggregates'])
    context = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
    real_page = retention.delete_raw_prefix_page
    outcomes: list[str] = []

    def page_while_an_admin_starts(*args: Any, **kwargs: Any) -> tuple[int, bool]:
        try:
            export_jobs.start_export(view, aws['workspaces'], context, 'sub-ada', MagicMock(), datetime.now(UTC))
        except export_jobs.ExportRunning:
            outcomes.append('409')
        else:
            outcomes.append('started')
        return real_page(*args, **kwargs)

    run = runs.new_run({}, 'erase')
    run['erased_workspaces'] = [WS]
    with patch.object(exports.retention, 'delete_raw_prefix_page', page_while_an_admin_starts):
        assert exports.clear(run, aws['s3'], BUCKET, aws['aggregates'], lambda: True) is True
    assert outcomes == ['409', '409']  # one page per sweep, both refused
    assert _statuses(aws, WS) == {DONE: 'erased', RUNNING: 'erased'}
    lock = aws['aggregates'].get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'})['Item']
    assert lock['job_id'] == f"erasure-{run['run_id']}"
    assert 'released_at' in lock
    export_jobs.start_export(view, aws['workspaces'], context, 'sub-ada', MagicMock(), datetime.now(UTC))


def test_no_link_is_signed_mid_erasure_for_a_zip_that_holds_what_it_deletes(aws, worker_context):
    """The workspace's exports close when the erasure first meets the workspace, before its item goes (long before
    the exports phase): a link asked for while the item is deleted is refused (the route's 409)."""
    put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
    now = datetime.now(UTC)
    aws['s3'].put_object(Bucket=BUCKET, Key=f'ws/{WS}/exports/{DONE}/workspace-export.zip', Body=b'PK jane@')
    aws['aggregates'].put_item(Item={'pk': f'WS#{WS}#JOB#export', 'sk': DONE, 'export_id': DONE,
                                     'status': 'completed', 'workspace_id': WS, 'created_at': now.isoformat(),
                                     'expires_at': export_jobs.expires_at(now)})
    view = ws_table(WorkspaceScope(WS), aws['aggregates'])
    context = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
    objects = exports.ExportObjects(WorkspaceScope(WS), aws['s3'], BUCKET)
    assert export_jobs.issue_link(view, aws['workspaces'], objects, context, 'sub-ada', now)['id'] == DONE
    real_delete = retention.delete_item
    asked: list[str] = []

    def delete_while_an_admin_asks(*args: Any, **kwargs: Any) -> Any:
        try:
            export_jobs.issue_link(view, aws['workspaces'], objects, context, 'sub-ada', datetime.now(UTC))
        except export_jobs.LinkUnavailable:
            asked.append('409')
        else:
            asked.append('signed')
        return real_delete(*args, **kwargs)

    with patch.object(copies.retention, 'delete_item', delete_while_an_admin_asks):
        _erase_jane_and_check_the_exports_are_gone(aws, worker_context)
    assert asked == ['409']


def _export_lock(aws: dict[str, Any]) -> dict[str, Any]:
    return aws['aggregates'].get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'})['Item']


def test_each_hand_over_renews_the_export_lock_and_marks_an_export_that_slipped_in(aws, worker_context,
                                                                                 invoke_mock):
    """The run met the workspace almost an hour ago (its export lock 59 minutes old) and is still on its way to the
    exports phase: its hand-over renews the lock, so a start more than an hour after the first close still gets
    409, and an export queued meanwhile is marked erased before it can complete."""
    run = runs.new_run({}, 'erase')
    exports.note_workspace(run, WorkspaceScope(WS), aws['aggregates'])
    now = datetime.now(UTC)
    aws['aggregates'].update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'},
                                  UpdateExpression='SET locked_at = :t',
                                  ExpressionAttributeValues={':t': (now - timedelta(minutes=59)).isoformat()})
    _export(aws, WS, RUNNING, 'queued')  # slipped in (the lock read stale to its start)
    walk = handler.Walk(handler._tables(), worker_context, {'mode': 'erase'}, run,
                        lambda store: retention.erase_filter('email', 'x', None, store), None)
    assert handler._hand_over(walk, handler.PHASE_ITEMS, None)['status'] == 'continued'
    assert invoke_mock.call_count == 1
    assert _statuses(aws, WS) == {RUNNING: 'erased'}
    view = ws_table(WorkspaceScope(WS), aws['aggregates'])
    context = WorkspaceContext(ws=WS, role='admin', name='Acme Outfitters', slug='acme', platform_admin=False)
    with pytest.raises(export_jobs.ErasureHoldsExports):
        export_jobs.start_export(view, aws['workspaces'], context, 'sub-ada', MagicMock(), now + timedelta(minutes=30))
    assert _export_lock(aws)['job_id'] == f"erasure-{run['run_id']}"


def test_the_members_path_closes_the_exports_before_the_row_changes(aws, worker_context):
    _member(aws, WS, 'jane@example.com')
    _export(aws, WS, DONE, 'completed')
    seen: list[str] = []
    real_deidentify = handler.members.deidentify

    def deidentify_after_the_close(table: Any, row: Any) -> bool:
        seen.append(_statuses(aws, WS)[DONE])
        return real_deidentify(table, row)

    with patch.object(handler.members, 'deidentify', deidentify_after_the_close):
        handler.handle_event(erasure_job(aws, JOB_ID, 'email', 'jane@example.com', legal_basis='GDPR'),
                             worker_context)
    assert seen == ['erased']


def _after_the_first_listing(then: Any) -> Any:
    """``ExportObjects.open_uploads`` that runs ``then(uploads)`` once, right after the sweep's first listing."""
    real_open_uploads = exports.ExportObjects.open_uploads
    done = {'ran': False}

    def listed_then(objects: Any) -> list[tuple[str, str]]:
        uploads = real_open_uploads(objects)
        if uploads and not done['ran']:
            done['ran'] = True
            then(uploads)
        return uploads

    return listed_then


def test_an_upload_the_export_aborted_first_does_not_fail_the_erasure(aws, worker_context):
    """The export read its row erased and aborted its own upload between the sweep's list and its abort: S3 answers
    NoSuchUpload, which is done; the erasure still completes and deletes every version under the prefix."""
    put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
    _seed_exports(aws, WS)

    def export_aborts(uploads: list[tuple[str, str]]) -> None:
        for key, upload_id in uploads:
            aws['s3'].abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload_id)

    with patch.object(exports.ExportObjects, 'open_uploads', _after_the_first_listing(export_aborts)):
        _erase_jane_and_check_the_exports_are_gone(aws, worker_context)


def test_a_zip_completed_between_the_list_and_the_abort_is_deleted(aws):
    upload_id = _seed_exports(aws, WS)
    zip_key = f'ws/{WS}/exports/{RUNNING}/workspace-export.zip'

    def export_completes(_uploads: list[tuple[str, str]]) -> None:
        part = aws['s3'].upload_part(Bucket=BUCKET, Key=zip_key, UploadId=upload_id, PartNumber=1, Body=b'PK jane@')
        aws['s3'].complete_multipart_upload(Bucket=BUCKET, Key=zip_key, UploadId=upload_id, MultipartUpload={
            'Parts': [{'PartNumber': 1, 'ETag': part['ETag']}]})

    run = runs.new_run({}, 'erase')
    run['erased_workspaces'] = [WS]
    with patch.object(exports.ExportObjects, 'open_uploads', _after_the_first_listing(export_completes)):
        assert exports.clear(run, aws['s3'], BUCKET, aws['aggregates'], lambda: True) is True
    assert _versions(aws, f'ws/{WS}/exports/') == []


def test_the_exports_phase_hands_over_when_the_time_runs_low_and_resumes(aws, worker_context, invoke_mock):
    put_workspace_feedback(aws, WS, 'f1', metadata={'email': 'jane@example.com'})
    _seed_exports(aws, WS)
    event = erasure_job(aws, JOB_ID, 'email', 'jane@example.com', legal_basis='GDPR')
    with patch.object(handler.exports, 'clear', side_effect=[False, True]) as clear:
        first = handler.handle_event(event, worker_context)
        assert first['status'] == 'continued'
        [(_name, payload)] = [call.args for call in invoke_mock.call_args_list]
        assert payload['phase'] == 'exports'
        assert payload['run']['erased_workspaces'] == [WS]
        assert handler.handle_event(payload, worker_context)['status'] == 'completed'
    assert clear.call_count == 2
