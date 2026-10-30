"""voc-retention: the whole-source erasure (``field = 'source'``) against moto tables and a versioned bucket."""
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from jobs.retention import handler
from jobs.retention.test.conftest import BUCKET, days_ago
from shared import retention
from shared.digests import sha256_hex
from shared.source_erasure import (
    STALE_AFTER,
    SourceLocked,
    acquire_source_lock,
    release_source_lock,
    source_lock_key,
)

JOB_ID = 'er_00000000abcd'
SOURCE = 'web_trustpilot_example_air'


def _seed(aws, feedback_id: str, source: str, *, pk: str | None = None) -> str:
    """An item of ``source`` with its per-item archive (two versions); ``pk`` defaults to ``SOURCE#{source}``."""
    key = f'raw/{source}/2026/01/01/{feedback_id}.json'
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'v1')
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'v2')
    aws['feedback'].put_item(Item={
        'pk': pk or f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'source_id': feedback_id, 'source_platform': source, 'date': days_ago(1),
        's3_raw_uri': f's3://{BUCKET}/{key}'})
    return key


def _job(aws, status: str = 'queued') -> None:
    aws['aggregates'].put_item(Item={
        'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': status, 'field': 'source',
        'source': SOURCE, 'value_hash': sha256_hex(SOURCE)})


def _job_row(aws) -> dict:
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']


def _ids(aws) -> set[str]:
    return {item['feedback_id'] for item in aws['feedback'].scan()['Items']}


def _keys(aws) -> set[str]:
    page = aws['s3'].list_object_versions(Bucket=BUCKET)
    return {entry['Key'] for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])]}


EVENT = {'mode': 'erase', 'job_id': JOB_ID, 'value': SOURCE}


def test_every_item_of_the_source_goes_whatever_partition_it_is_stored_in(aws, worker_context):
    """A brand name puts plugin items in `SOURCE#<brand>`; the match is on `source_platform`."""
    _job(aws)
    _seed(aws, 'own', SOURCE)
    _seed(aws, 'branded', SOURCE, pk='SOURCE#Example Air')
    _seed(aws, 'neighbour', 'web_trustpilot_example_air_2', pk='SOURCE#Example Air')
    _seed(aws, 'other', 'tickets')
    result = handler.handle_event(EVENT, worker_context)
    assert (result['status'], result['deleted_items']) == ('completed', 2)
    assert _ids(aws) == {'neighbour', 'other'}


def test_the_raw_folder_is_swept_but_never_a_neighbour_or_a_whole_upload(aws, worker_context):
    _job(aws)
    _seed(aws, 'own', SOURCE)
    orphan = f'raw/{SOURCE}/2025/12/31/no-item.json'
    aws['s3'].put_object(Bucket=BUCKET, Key=orphan, Body=b'x')
    aws['s3'].put_object(Bucket=BUCKET, Key=orphan, Body=b'y')
    neighbour = _seed(aws, 'neighbour', f'{SOURCE}_2')
    aws['s3'].put_object(Bucket=BUCKET, Key='raw/csv_upload/2026/01/01/job.csv', Body=b'x')
    result = handler.handle_event(EVENT, worker_context)
    # One per-item archive with its item, one orphan from the sweep.
    assert (result['deleted_items'], result['deleted_objects']) == (1, 2)
    assert _keys(aws) == {neighbour, 'raw/csv_upload/2026/01/01/job.csv'}
    job = _job_row(aws)
    assert (job['status'], job['deleted_items'], job['deleted_objects'], job['phase']) == ('completed', 1, 2, 'raw')


def test_the_item_scan_pages_through_the_table(aws, worker_context):
    _job(aws)
    for n in range(5):
        _seed(aws, f'i{n}', SOURCE)
    _seed(aws, 'other', 'tickets')
    with patch.object(handler, 'PAGE_SIZE', 2):
        result = handler.handle_event(EVENT, worker_context)
    assert (result['status'], result['deleted_items']) == ('completed', 5)
    assert _ids(aws) == {'other'}


def test_a_low_budget_in_the_raw_sweep_hands_over_to_the_raw_phase(aws, worker_context, invoke_mock):
    _job(aws)
    for n in range(3):
        aws['s3'].put_object(Bucket=BUCKET, Key=f'raw/{SOURCE}/2026/01/0{n + 1}/orphan.json', Body=b'x')
    # No items, so the only budget checks are the sweep's: one listing page, then none.
    budget = iter([900_000, 0])
    worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
    with patch('shared.retention._MAX_VERSIONS_PER_DELETE', 2):
        result = handler.handle_event(EVENT, worker_context)
        assert result['status'] == 'continued'
        payload = invoke_mock.call_args.args[1]
        assert (payload['phase'], payload['cursor']) == ('raw', None)
        assert payload['run']['deleted_objects'] == 2
        running = _job_row(aws)
        assert (running['status'], running['deleted_objects'], running['phase']) == ('running', 2, 'raw')
        assert running['progress_at']
        worker_context.get_remaining_time_in_millis.side_effect = None
        final = handler.handle_event(payload, worker_context)
    assert (final['status'], final['deleted_objects']) == ('completed', 3)
    assert _keys(aws) == set()
    assert _job_row(aws)['deleted_objects'] == 3


def test_a_raw_phase_hand_over_does_not_rescan_the_items(aws, worker_context):
    _job(aws, status='running')
    _seed(aws, 'late', SOURCE)
    result = handler.handle_event({**EVENT, 'phase': 'raw'}, worker_context)
    # The item that arrived after the scan stays; its archive went with the sweep.
    assert (result['status'], result['deleted_items'], result['deleted_objects']) == ('completed', 0, 1)
    assert _ids(aws) == {'late'}


def test_progress_is_written_to_the_running_job_between_pages(aws, worker_context):
    _job(aws)
    for n in range(2):
        _seed(aws, f'i{n}', SOURCE)
    seen: list[int] = []
    real = handler.record_progress

    def spy(table, run, phase, **kwargs):
        real(table, run, phase, **kwargs)
        if phase == 'items':
            seen.append(int(_job_row(aws)['deleted_items']))

    with patch.object(handler, 'PAGE_SIZE', 1), patch.object(handler, 'record_progress', spy):
        handler.handle_event(EVENT, worker_context)
    assert seen[:2] == [1, 2]


def test_progress_never_recreates_a_finished_job(aws):
    _job(aws, status='completed')
    run = {'job_id': JOB_ID, 'deleted_items': 9, 'deleted_objects': 9}
    handler.record_progress(aws['aggregates'], run, 'items')
    assert _job_row(aws).get('deleted_items') is None


@pytest.mark.parametrize(('source', 'prefix'), [
    ('tickets', 'raw/tickets/'),
    ('csv_upload', None),
    ('json_upload', None),
    ('', None),
    ('a/b', None),
    ('..', None),
])
def test_the_raw_folder_of_a_source(source, prefix):
    assert retention.raw_source_prefix(source) == prefix


def test_a_partial_raw_delete_fails_the_page():
    s3 = MagicMock()
    s3.list_object_versions.return_value = {'Versions': [{'Key': 'raw/t/a.json', 'VersionId': 'v', 'IsLatest': True}]}
    s3.delete_objects.return_value = {'Errors': [{'Key': 'raw/t/a.json'}]}
    with pytest.raises(RuntimeError, match='1 raw object versions could not be deleted'):
        retention.delete_raw_prefix_page(s3, 'bkt', 'raw/t/')


def test_an_empty_page_is_the_end_even_when_marked_truncated():
    s3 = MagicMock()
    s3.list_object_versions.return_value = {'IsTruncated': True}
    assert retention.delete_raw_prefix_page(s3, 'bkt', 'raw/t/') == (0, False)
    s3.delete_objects.assert_not_called()


# ---- Defence in depth + the source lock (security review) ----

def _lock(aws) -> dict:
    """The source's lock row (fails the test when there is none)."""
    item = aws['aggregates'].get_item(Key=source_lock_key(SOURCE)).get('Item')
    assert isinstance(item, dict)
    return item


def _hold_lock(aws, job_id: str = JOB_ID) -> None:
    acquire_source_lock(aws['aggregates'], SOURCE, job_id, datetime.now(UTC))


@pytest.mark.parametrize(('row_source', 'value'), [
    ('tickets', SOURCE),        # the job row names another source than the invoke
    (None, SOURCE),             # the job row names no source at all
    ('Bad Id', 'Bad Id'),       # not a source id, though row and invoke agree
])
def test_a_whole_source_job_that_does_not_name_the_invoked_source_id_fails_without_deleting(
        aws, worker_context, row_source, value):
    item = {'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': 'source',
            'value_hash': sha256_hex(value)}
    if row_source is not None:
        item['source'] = row_source
    aws['aggregates'].put_item(Item=item)
    _seed(aws, 'own', SOURCE)
    _seed(aws, 'ticket', 'tickets')
    result = handler.handle_event({**EVENT, 'value': value}, worker_context)
    assert (result['status'], result['deleted_items'], result['deleted_objects']) == ('failed', 0, 0)
    job = _job_row(aws)
    # The error TYPE only, never the value.
    assert (job['status'], job['error']) == ('failed', 'Run failed (ValueError)')
    assert _ids(aws) == {'own', 'ticket'}


def test_a_completed_job_releases_its_source_lock(aws, worker_context):
    _job(aws)
    _hold_lock(aws)
    handler.handle_event(EVENT, worker_context)
    lock = _lock(aws)
    assert lock['job_id'] == JOB_ID
    assert lock['released_at']


def test_a_failed_job_releases_its_source_lock(aws, worker_context):
    _job(aws)
    _hold_lock(aws)
    _seed(aws, 'own', SOURCE)
    with patch.object(handler, '_scan_page', side_effect=RuntimeError('boom')):
        result = handler.handle_event(EVENT, worker_context)
    assert result['status'] == 'failed'
    assert _lock(aws)['released_at']


@pytest.mark.usefixtures('invoke_mock')
def test_a_hand_over_keeps_the_source_lock(aws, worker_context):
    _job(aws)
    _hold_lock(aws)
    _seed(aws, 'own', SOURCE)
    worker_context.get_remaining_time_in_millis.return_value = 0
    result = handler.handle_event(EVENT, worker_context)
    assert result['status'] == 'continued'
    assert 'released_at' not in _lock(aws)


def test_a_job_never_frees_a_lock_a_later_job_took_over(aws, worker_context):
    _job(aws)
    _hold_lock(aws, job_id='er_00000000ffff')
    handler.handle_event(EVENT, worker_context)
    lock = _lock(aws)
    assert lock['job_id'] == 'er_00000000ffff'
    assert 'released_at' not in lock


def test_a_released_or_stale_lock_can_be_taken_and_a_held_one_cannot(aws):
    table, now = aws['aggregates'], datetime.now(UTC)
    acquire_source_lock(table, SOURCE, 'er_a', now)
    with pytest.raises(SourceLocked):
        acquire_source_lock(table, SOURCE, 'er_b', now)
    release_source_lock(table, SOURCE, 'er_a', now)
    acquire_source_lock(table, SOURCE, 'er_b', now)
    # Held by er_b, but taken more than STALE_AFTER ago: its holder died.
    acquire_source_lock(table, SOURCE, 'er_c', now + STALE_AFTER + timedelta(seconds=1))
    assert _lock(aws)['job_id'] == 'er_c'
