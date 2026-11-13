"""voc-workspace-export (jobs/workspace_export/handler.py): one workspace's data as JSONL files and a manifest in one
streaming ZIP64, resumed across invocations, every read in the workspace's own partitions and every object under its
exports; the job row, the lock, the generation claim, the deleting check and the notice."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError

from jobs.workspace_export import entities, handler
from jobs.workspace_export.entities import FEEDBACK_START_UNKNOWN
from jobs.workspace_export.test.conftest import (
    CREATED,
    EXPORT_ID,
    FEEDBACK_DAYS,
    FEEDBACK_PER_DAY,
    OTHER,
    WS,
    Budget,
    World,
    day,
    queue,
    seed,
)

ZIP_KEY = f'ws/{WS}/exports/{EXPORT_ID}/workspace-export.zip'
FEEDBACK_COUNT = FEEDBACK_DAYS * FEEDBACK_PER_DAY


def _row(world: World, export_id: str = EXPORT_ID) -> dict[str, Any]:
    return world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': export_id})['Item']


def _lock(world: World) -> dict[str, Any]:
    return world.aggregates.get_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': 'LOCK'})['Item']


def _run(world: World, event: dict[str, Any], checks: int | None = None, limit: int = 100) -> list[dict[str, Any]]:
    """Every invocation of one export: the first with ``event``, each next with the payload its predecessor
    invoked, each with its own budget of ``checks``."""
    results = []
    for _ in range(limit):
        world.invoke.reset_mock()
        result = handler.handle_event(event, Budget(checks))
        results.append(result)
        if result['status'] != 'continued':
            return results
        [(function_name, event)] = [call.args for call in world.invoke.call_args_list]
        assert function_name == 'voc-workspace-export'
    raise AssertionError('the export did not end')


def _unzip(world: World) -> dict[str, bytes]:
    body, tagging = world.s3.objects[ZIP_KEY]
    assert tagging == 'voc-export=true'
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        assert archive.testzip() is None, 'every CRC checks'
        return {info.filename: archive.read(info) for info in archive.infolist()}


def _jsonl(files: dict[str, bytes], entity: str) -> list[dict[str, Any]]:
    names = sorted(name for name in files if name.startswith(f'{entity}/'))
    return [json.loads(line) for name in names for line in files[name].decode().splitlines()]


#: The calls that only read the workspace's own objects (objects.py): its listing and its object reads.
_OBJECT_READS = ('list_objects_v2', 'get_object')


def _assert_only_this_workspaces_exports(world: World) -> None:
    """Every write under this export's folder, tagged; every read of the workspace's own objects under ``ws/{WS}/``
    (the listing's prefix exactly), never another workspace's."""
    calls = world.s3.calls
    assert calls
    for method, key in calls:
        if method == 'list_objects_v2' or (method == 'get_object' and not key.startswith(f'ws/{WS}/exports/')):
            assert key.startswith(f'ws/{WS}/')
        else:
            assert key.startswith(f'ws/{WS}/exports/{EXPORT_ID}/'), (method, key)
    assert all(tagging == 'voc-export=true' for key, (_body, tagging) in world.s3.objects.items()
               if key.startswith(f'ws/{WS}/exports/'))


def test_a_one_invocation_export_holds_every_entity_and_its_manifest(world):
    seed(world)
    [result] = _run(world, queue(world))
    assert result == {'status': 'completed', 'export_id': EXPORT_ID}
    files = _unzip(world)
    feedback = _jsonl(files, 'feedback')
    assert len(feedback) == FEEDBACK_COUNT
    assert {row['workspace_marker'] for row in feedback} == {WS}
    assert (feedback[0]['sentiment_score'], feedback[0]['tags']) == (0.25, ['checkout', 'mobile'])
    assert [row['sk'] for row in _jsonl(files, 'plugin_configs')] == ['webscraper']
    # Every list a save replaced, with who saved and who replaced it; never another workspace's.
    [history] = _jsonl(files, 'plugin_config_history')
    assert (history['pk'], history['configs'], history['updated_by'], history['superseded_by_sub']) == (
        f'WS#{WS}#PLUGIN_CONFIG#HISTORY', '[]', 'sub-ada', 'sub-ada')
    assert json.loads(files['manifest.json'])['entities']['plugin_config_history']['count'] == 1
    assert [row['form_id'] for row in _jsonl(files, 'feedback_forms')] == ['ff_1']
    # Each run's detail row (its errors too), the summary where the detail is gone.
    runs = _jsonl(files, 'import_runs')
    assert [(run['run_id'], run.get('errors')) for run in runs] == [('run1', ['row 3: empty']), ('run2', None)]
    # The erasure job without its value hash; its lock row is not a job.
    [erasure] = _jsonl(files, 'erasure_jobs')
    assert erasure['sk'] == 'er_0123456789ab'
    assert 'value_hash' not in erasure
    assert [row['sk'] for row in _jsonl(files, 'workspace')] == ['META']
    assert [row['sk'] for row in _jsonl(files, 'members')] == ['MEMBER#sub-ada', 'MEMBER#sub-vic']
    assert [row['kind'] for row in _jsonl(files, 'audit')] == ['workspace_created', 'member_added']
    manifest = json.loads(files['manifest.json'])
    assert manifest['workspace'] == {'id': WS, 'name': 'Acme Outfitters', 'slug': 'acme'}
    assert manifest['entities']['feedback'] == {'files': ['feedback/feedback-0001.jsonl'], 'count': FEEDBACK_COUNT}
    assert manifest['entities']['members']['count'] == 2
    assert manifest['counts_check'] | {'note': None} == {
        'feedback': FEEDBACK_COUNT, 'daily_total': FEEDBACK_COUNT, 'matches': True, 'note': None}
    assert 'raw_objects' not in manifest
    assert (manifest['objects']['count'], manifest['objects']['bytes'], manifest['objects']['not_included']) == (
        0, 0, [])
    assert 'older versions' in manifest['objects']['versions']
    assert 'credentials' in manifest['excluded']
    assert manifest['not_per_workspace']['projects_documents'] == {
        'status': 'not_per_workspace', 'phase': 3, 'count': 0}
    assert set(manifest['not_exported']) >= {'metrics', 'runs', 'logs', 'watermarks', 'idempotency', 'user_rows'}
    _assert_only_this_workspaces_exports(world)


def test_the_job_row_lock_and_notice_after_completion(world):
    seed(world)
    _run(world, queue(world))
    row = _row(world)
    assert row['status'] == 'completed'
    assert row['size_bytes'] == len(world.s3.objects[ZIP_KEY][0])
    assert row['counts']['feedback'] == FEEDBACK_COUNT
    # What a resume or a reader needs only: no counts check, no upload id, no finish time on the row.
    assert not {'counts_check', 'upload_id', 'finished_at'} & set(row)
    completed = row['completed_at']
    assert row['expires_at'] > completed
    assert 'released_at' in _lock(world)
    world.notify.assert_called_once_with('sub-ada', EXPORT_ID, 'completed', job_type='workspace_export')


def test_an_export_resumed_across_many_invocations_holds_the_same_rows(world):
    """A budget of a few clock checks per invocation: entries end at each hand-over, the tail and the
    central-directory records cross in work objects, and Python reads every entry back with its CRC."""
    seed(world)
    results = _run(world, queue(world), checks=7)
    assert len(results) >= 3
    assert results[-1]['status'] == 'completed'
    files = _unzip(world)
    feedback = _jsonl(files, 'feedback')
    assert sorted(row['feedback_id'] for row in feedback) == sorted(f'fb-{n}' for n in range(FEEDBACK_COUNT))
    assert len(feedback) == FEEDBACK_COUNT  # no row twice, none lost at a hand-over
    manifest = json.loads(files['manifest.json'])
    assert len(manifest['entities']['feedback']['files']) > 1
    assert manifest['entities']['feedback']['files'] == sorted(name for name in files if name.startswith('feedback/'))
    assert [row['kind'] for row in _jsonl(files, 'audit')] == ['workspace_created', 'member_added']
    # Several parts went up (2 KiB parts here); each hand-over kept its tail or sent it as a part.
    methods = [method for method, _key in world.s3.calls]
    assert methods.count('upload_part') >= 2
    assert methods.count('complete_multipart_upload') == 1
    assert any(key.endswith('/work/cd-0') for _method, key in world.s3.calls)
    assert _row(world)['generation'] == len(results) - 1
    world.notify.assert_called_once()
    _assert_only_this_workspaces_exports(world)


def test_a_one_shot_and_a_resumed_export_hold_identical_files(world):
    seed(world)
    _run(world, queue(world), checks=5)
    resumed = _unzip(world)
    world.s3.objects.clear()
    world.aggregates.delete_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID})
    _run(world, queue(world))
    one_shot = _unzip(world)
    rows = {entity: _jsonl(resumed, entity) for entity in ('feedback', 'members', 'audit', 'import_runs')}
    assert rows == {entity: _jsonl(one_shot, entity) for entity in rows}


def test_a_long_entity_continues_in_its_next_file(world):
    seed(world)
    with patch.object(handler, 'FILE_CAP', 1500):
        _run(world, queue(world))
    files = _unzip(world)
    names = sorted(name for name in files if name.startswith('feedback/'))
    assert len(names) > 1
    assert all(len(files[name]) <= 1500 for name in names)
    assert names[:2] == ['feedback/feedback-0001.jsonl', 'feedback/feedback-0002.jsonl']
    assert len(_jsonl(files, 'feedback')) == FEEDBACK_COUNT


def test_a_counts_mismatch_is_reported_not_fatal(world):
    seed(world, daily_total=FEEDBACK_COUNT + 3)
    _run(world, queue(world))
    row = _row(world)
    assert row['status'] == 'completed'
    check = json.loads(_unzip(world)['manifest.json'])['counts_check']
    assert (check['feedback'], check['daily_total'], check['matches']) == (FEEDBACK_COUNT, FEEDBACK_COUNT + 3, False)


def test_a_duplicate_or_stale_delivery_claims_nothing_and_does_nothing(world):
    seed(world)
    event = queue(world)
    _run(world, event)
    calls = list(world.s3.calls)
    assert handler.handle_event(event, Budget()) == {'status': 'not_claimed', 'export_id': EXPORT_ID}
    assert handler.handle_event({**event, 'run': {'generation': 4}}, Budget())['status'] == 'not_claimed'
    assert world.s3.calls == calls
    world.notify.assert_called_once()


def _deleting(world: World) -> None:
    world.workspaces.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :d',
                                 ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':d': 'deleting'})


def test_a_workspace_that_began_deleting_cancels_the_export_before_it_starts(world):
    seed(world)
    _deleting(world)
    [result] = _run(world, queue(world))
    assert result['status'] == 'cancelled'
    row = _row(world)
    assert (row['status'], row['error']) == ('cancelled', 'workspace_deleting')
    assert world.s3.calls == []
    assert 'released_at' in _lock(world)
    world.notify.assert_called_once_with('sub-ada', EXPORT_ID, 'cancelled', job_type='workspace_export')


def test_a_delete_that_begins_mid_export_aborts_the_upload_at_the_next_invocation(world):
    seed(world)
    event = queue(world)
    first = handler.handle_event(event, Budget(6))
    assert first['status'] == 'continued'
    _deleting(world)
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    world.invoke.reset_mock()
    assert handler.handle_event(following, Budget(6))['status'] == 'cancelled'
    assert world.s3.aborted == ['upload-1']
    assert ZIP_KEY not in world.s3.objects
    world.invoke.assert_not_called()


def test_a_delete_seen_before_a_hand_over_cancels_without_handing_over(world):
    seed(world)
    # Active at the start, deleting by the time the invocation would hand over.
    with patch.object(handler.ExportRun, '_deleting', side_effect=[False, True]):
        result = handler.handle_event(queue(world), Budget(6))
    assert result['status'] == 'cancelled'
    assert world.s3.aborted == ['upload-1']
    assert not any(key.endswith(('/work/tail-0', '/work/cd-0')) for _method, key in world.s3.calls)
    world.invoke.assert_not_called()


def test_a_delete_seen_before_completing_cancels(world):
    seed(world)
    with patch.object(handler.ExportRun, '_deleting', side_effect=[False, True]):
        assert handler.handle_event(queue(world), Budget())['status'] == 'cancelled'
    assert ZIP_KEY not in world.s3.objects
    assert world.s3.aborted == ['upload-1']


def test_a_hand_over_whose_row_was_erased_aborts_its_upload_and_deletes_its_work_objects(world):
    """An erasure marked the export erased mid-run: the next hand-over's progress is refused, and nothing it wrote
    may stay (the zip's parts with the upload, every work object it knows of)."""
    seed(world)
    first = handler.handle_event(queue(world), Budget(6))
    assert first['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    world.invoke.reset_mock()
    world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                 UpdateExpression='SET #s = :e', ExpressionAttributeNames={'#s': 'status'},
                                 ExpressionAttributeValues={':e': 'erased'})
    with patch.object(handler.export_jobs, 'claim_generation', return_value=_row(world)):
        assert handler.handle_event(following, Budget(6)) == {'status': 'stopped', 'export_id': EXPORT_ID}
    assert world.s3.aborted == ['upload-1']
    assert [key for key in world.s3.objects if '/work/' in key] == []
    assert any(method == 'delete_object' and key.endswith('/work/cd-0') for method, key in world.s3.calls)
    world.invoke.assert_not_called()
    assert _row(world)['status'] == 'erased'


def test_an_erasure_marked_after_the_last_entity_stops_the_completion(world):
    """D5: an erasure marks the export after its last entity is written but before the zip completes (its sweep may
    have run before this invocation's upload began): the row is re-checked right before completing, so the upload
    is aborted, never completed, and every work object goes."""
    seed(world)
    assert handler.handle_event(queue(world), Budget(6))['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    assert [key for key in world.s3.objects if '/work/' in key]
    real_list_parts = world.s3.list_parts

    def erased_meanwhile(**kwargs: Any) -> dict[str, Any]:
        world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                     UpdateExpression='SET #s = :e', ExpressionAttributeNames={'#s': 'status'},
                                     ExpressionAttributeValues={':e': 'erased'})
        return real_list_parts(**kwargs)

    with patch.object(world.s3, 'list_parts', side_effect=erased_meanwhile):
        assert handler.handle_event(following, Budget()) == {'status': 'stopped', 'export_id': EXPORT_ID}
    assert ZIP_KEY not in world.s3.objects
    assert not any(method == 'complete_multipart_upload' for method, _key in world.s3.calls)
    assert world.s3.aborted == ['upload-1']
    assert [key for key in world.s3.objects if '/work/' in key] == []
    assert _row(world)['status'] == 'erased'
    world.notify.assert_not_called()


def test_a_failure_whose_row_was_erased_deletes_its_work_objects_too(world):
    seed(world)
    assert handler.handle_event(queue(world), Budget(6))['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    assert [key for key in world.s3.objects if '/work/' in key]  # generation 0 left its work objects
    world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                 UpdateExpression='SET #s = :e', ExpressionAttributeNames={'#s': 'status'},
                                 ExpressionAttributeValues={':e': 'erased'})
    fault = ClientError({'Error': {'Code': 'InternalError', 'Message': 'x'}}, 'Query')
    with patch.object(handler.export_jobs, 'claim_generation', return_value=_row(world)), \
            patch.object(handler.ExportRun, '_write_entities', side_effect=fault):
        assert handler.handle_event(following, Budget())['status'] == 'failed'
    assert [key for key in world.s3.objects if '/work/' in key] == []
    assert world.s3.aborted == ['upload-1']
    assert _row(world)['status'] == 'erased'
    world.notify.assert_not_called()


def test_a_missing_workspace_cancels_too(world):
    seed(world)
    world.workspaces.delete_item(Key={'pk': f'WS#{WS}', 'sk': 'META'})
    assert _run(world, queue(world))[0]['status'] == 'cancelled'


def test_an_aws_fault_fails_the_job_with_its_type_only_and_aborts_the_upload(world):
    seed(world)
    world.s3.fail_on = 'complete_multipart_upload'
    world.s3.error = ClientError({'Error': {'Code': 'InternalError', 'Message': f'arn:aws:s3:::{WS}'}}, 'Complete')
    [result] = _run(world, queue(world))
    assert result['status'] == 'failed'
    row = _row(world)
    assert row['error'] == 'Export failed (ClientError)'
    assert world.s3.aborted == ['upload-1']
    assert 'released_at' in _lock(world)
    world.notify.assert_called_once_with('sub-ada', EXPORT_ID, 'failed', job_type='workspace_export')


def test_too_many_hand_overs_fail_the_job(world):
    seed(world)
    event = queue(world)
    world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                 UpdateExpression='SET #s = :r, #g = :g, progress_at = :p',
                                 ExpressionAttributeNames={'#s': 'status', '#g': 'generation'},
                                 ExpressionAttributeValues={':r': 'running', ':g': handler.MAX_GENERATIONS - 1,
                                                            ':p': CREATED.isoformat()})
    result = handler.handle_event({**event, 'run': {'generation': handler.MAX_GENERATIONS, 'upload_id': 'u-9'}},
                                  Budget())
    assert result['status'] == 'failed'
    assert _row(world)['error'] == 'Stopped after too many hand-overs'


@pytest.mark.parametrize('event', [
    {'export_id': EXPORT_ID},
    {'export_id': EXPORT_ID, 'workspace_id': 'ws_bogus'},
    {'export_id': EXPORT_ID, 'workspace_id': None},
    {'export_id': 'er_0123456789ab', 'workspace_id': WS},
])
def test_an_event_without_a_workspace_or_an_export_id_is_ignored(world, event):
    seed(world)
    assert handler.handle_event(event, Budget()) == {'status': 'ignored'}
    assert _row(world)['status'] == 'queued'


def test_a_row_that_names_another_workspace_fails_before_any_read(world):
    seed(world)
    event = queue(world, ws=OTHER)
    assert handler.handle_event(event, Budget())['status'] == 'failed'
    assert _row(world)['error'] == 'The job row names another workspace'
    assert world.s3.calls == []


def test_another_workspaces_event_finds_no_job_here(world):
    seed(world)
    queue(world)
    assert handler.handle_event({'export_id': EXPORT_ID, 'workspace_id': OTHER}, Budget())['status'] == 'not_claimed'


def _drop_feedback_days(world: World) -> None:
    """No earliest date and no daily counter: the workspace records no first day of feedback."""
    world.aggregates.delete_item(Key={'pk': f'WS#{WS}#METRIC#meta', 'sk': 'earliest_date'})
    for offset in (0, 1):
        world.aggregates.delete_item(Key={'pk': f'WS#{WS}#METRIC#daily_total', 'sk': day(offset)})


def test_a_workspace_without_feedback_exports_its_other_entities(world):
    seed(world)
    _drop_feedback_days(world)
    _run(world, queue(world))
    files = _unzip(world)
    assert _jsonl(files, 'feedback') == []
    assert json.loads(files['manifest.json'])['entities']['feedback'] == {'files': [], 'count': 0}
    assert CREATED.isoformat() == _row(world)['created_at']


def test_the_feedback_starts_at_the_first_counted_day_when_the_watermark_is_missing(world):
    seed(world)
    world.aggregates.delete_item(Key={'pk': f'WS#{WS}#METRIC#meta', 'sk': 'earliest_date'})
    _run(world, queue(world))
    # The counters' first day is a day after the oldest feedback: those two days are exported, the oldest is not.
    exported = {row['date'] for row in _jsonl(_unzip(world), 'feedback')}
    assert exported == {day(0), day(1)}


def test_the_feedback_starts_at_the_earlier_of_the_watermark_and_the_first_counted_day(world):
    seed(world)
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#METRIC#meta', 'sk': 'earliest_date', 'date': day(0)})
    _run(world, queue(world))
    assert {row['date'] for row in _jsonl(_unzip(world), 'feedback')} == {day(0), day(1)}


def test_counted_feedback_with_no_first_day_fails_with_a_clear_error(world):
    seed(world)
    _drop_feedback_days(world)
    world.aggregates.put_item(Item={'pk': f'WS#{WS}#METRIC#daily_total', 'sk': 'total', 'count': 3})
    [result] = _run(world, queue(world))
    assert result['status'] == 'failed'
    assert _row(world)['error'] == FEEDBACK_START_UNKNOWN
    assert world.s3.aborted == ['upload-1']


def test_a_late_start_exits_without_running(world):
    seed(world)
    event = queue(world)
    world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                 UpdateExpression='SET created_at = :c',
                                 ExpressionAttributeValues={':c': (CREATED - timedelta(hours=2)).isoformat()})
    assert handler.handle_event(event, Budget())['status'] == 'not_claimed'
    assert world.s3.calls == []
    assert _row(world)['status'] == 'queued'
    world.notify.assert_not_called()


def test_a_late_hand_over_exits_without_running(world):
    seed(world)
    first = handler.handle_event(queue(world), Budget(6))
    assert first['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    world.aggregates.update_item(Key={'pk': f'WS#{WS}#JOB#export', 'sk': EXPORT_ID},
                                 UpdateExpression='SET progress_at = :p',
                                 ExpressionAttributeValues={':p': (CREATED - timedelta(hours=2)).isoformat()})
    calls = len(world.s3.calls)
    assert handler.handle_event(following, Budget())['status'] == 'not_claimed'
    assert len(world.s3.calls) == calls


def test_too_little_time_to_complete_hands_over_once_more(world):
    """Every entity written, the time short: the next invocation (phase == len(ENTITIES)) only completes the zip."""
    seed(world)
    with patch.object(handler, 'ENTITIES', ()):
        first = handler.handle_event(queue(world), Budget(0))
        assert first['status'] == 'continued'
        [(_, following)] = [call.args for call in world.invoke.call_args_list]
        assert following['run']['phase'] == 0
        assert handler.handle_event(following, Budget())['status'] == 'completed'
    assert set(_unzip(world)) == {'manifest.json'}


def test_an_export_checkpointed_at_the_old_end_writes_the_config_history(world):
    """An export that wrote the eight entities of the release before (phase 8, then handed over to complete) and
    resumes after the deploy: phase 8 is now plugin_config_history, written before the zip completes."""
    seed(world)
    before = tuple(entity for entity in entities.ENTITIES if entity != 'plugin_config_history')
    assert (*before, 'plugin_config_history') == entities.ENTITIES
    write_entities = handler.ExportRun._write_entities

    def then_out_of_time(run: handler.ExportRun, writer: Any) -> None:
        write_entities(run, writer)
        run.context = Budget(0)

    with patch.object(handler, 'ENTITIES', before), \
            patch.object(handler.ExportRun, '_write_entities', then_out_of_time):
        assert handler.handle_event(queue(world), Budget())['status'] == 'continued'
    [(_, following)] = [call.args for call in world.invoke.call_args_list]
    assert following['run']['phase'] == len(before)

    assert handler.handle_event(following, Budget())['status'] == 'completed'
    files = _unzip(world)
    assert [row['configs'] for row in _jsonl(files, 'plugin_config_history')] == ['[]']
    assert json.loads(files['manifest.json'])['entities']['plugin_config_history']['count'] == 1


def test_an_audit_rows_email_hash_is_never_exported(world):
    seed(world)
    world.workspaces.put_item(Item={'pk': f'AUDIT#WS#{WS}', 'sk': '2026-11-03T09:00:00#cc', 'kind': 'account_created',
                                    'actor': 'sub-ada', 'email_sha256': 'a' * 64})
    _run(world, queue(world))
    audit = _jsonl(_unzip(world), 'audit')
    assert [row['kind'] for row in audit] == ['workspace_created', 'member_added', 'account_created']
    assert all('email_sha256' not in row for row in audit)


def test_a_day_longer_than_a_page_continues_within_the_day(world):
    seed(world)
    with patch.object(entities, 'PAGE_LIMIT', 3):
        _run(world, queue(world), checks=9)
    feedback = _jsonl(_unzip(world), 'feedback')
    assert sorted(row['feedback_id'] for row in feedback) == sorted(f'fb-{n}' for n in range(FEEDBACK_COUNT))
