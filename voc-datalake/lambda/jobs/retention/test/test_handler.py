"""voc-retention: retention + erase modes against moto tables and a versioned bucket."""
import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import handler
from jobs.retention.test.conftest import BUCKET, days_ago
from shared.retention import value_hash

JOB_ID = 'er_0123456789ab'


def _seed(aws, feedback_id: str, source: str, date: str, *, archive: bool = True, **extra) -> str:
    key = f'raw/{source}/2026/01/01/{feedback_id}.json'
    item = {'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'source_id': feedback_id, 'source_platform': source, 'date': date, **extra}
    if archive:
        aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'v1')
        aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'v2')
        item['s3_raw_uri'] = f's3://{BUCKET}/{key}'
    aws['feedback'].put_item(Item=item)
    return key


def _ids(aws) -> set[str]:
    return {item['feedback_id'] for item in aws['feedback'].scan()['Items']}


def _versions(aws, key: str) -> int:
    page = aws['s3'].list_object_versions(Bucket=BUCKET, Prefix=key)
    return len(page.get('Versions', [])) + len(page.get('DeleteMarkers', []))


def _profiles(aws, *profiles: dict) -> None:
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': list(profiles)})


def _audit(aws) -> list[dict]:
    return aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#retention'))['Items']


def test_retention_deletes_only_old_items_of_retained_sources_and_every_raw_version(aws, worker_context):
    _profiles(aws, {'id': 'tickets', 'retention_days': 30}, {'id': 'web'})
    old_key = _seed(aws, 'old', 'tickets', days_ago(31))
    _seed(aws, 'fresh', 'tickets', days_ago(29))
    _seed(aws, 'web_old', 'web', days_ago(400))
    result = handler.handle_event({'mode': 'retention'}, worker_context)
    assert (result['status'], result['deleted_items'], result['deleted_objects']) == ('completed', 1, 1)
    assert _ids(aws) == {'fresh', 'web_old'}
    assert _versions(aws, old_key) == 0
    [audit] = _audit(aws)
    assert (audit['mode'], audit['deleted_items'], audit['cutoffs']) == ('retention', 1, {'tickets': days_ago(30)})


def test_retention_with_no_retained_source_deletes_nothing_but_audits(aws, worker_context):
    _profiles(aws, {'id': 'web'})
    _seed(aws, 'a', 'web', days_ago(4000))
    assert handler.handle_event({}, worker_context)['deleted_items'] == 0
    assert _ids(aws) == {'a'}
    assert len(_audit(aws)) == 1


def test_unreadable_profiles_fail_the_run_without_deleting(aws, worker_context):
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [{'id': 'BAD ID'}]})
    _seed(aws, 'a', 'web', days_ago(4000))
    assert handler.handle_event({'mode': 'retention'}, worker_context)['status'] == 'failed'
    assert _ids(aws) == {'a'}
    assert _audit(aws)[0]['error'] == 'Run failed (ValueError)'


def test_whole_upload_and_foreign_archives_are_never_deleted(aws, worker_context):
    _profiles(aws, {'id': 'manual_import', 'retention_days': 30})
    aws['s3'].put_object(Bucket=BUCKET, Key='raw/csv_upload/2026/01/01/job.csv', Body=b'x')
    aws['feedback'].put_item(Item={
        'pk': 'SOURCE#manual_import', 'sk': 'FEEDBACK#c1', 'feedback_id': 'c1', 'source_id': 'row1',
        'source_platform': 'manual_import', 'date': days_ago(90),
        's3_raw_uri': f's3://{BUCKET}/raw/csv_upload/2026/01/01/job.csv'})
    result = handler.handle_event({'mode': 'retention'}, worker_context)
    assert (result['deleted_items'], result['deleted_objects']) == (1, 0)
    assert _versions(aws, 'raw/csv_upload/2026/01/01/job.csv') == 1


def _erasure_job(aws, field: str, value: str, source: str | None = None, status: str = 'queued') -> None:
    aws['aggregates'].put_item(Item={
        'pk': 'JOB#erasure', 'sk': JOB_ID, 'job_id': JOB_ID, 'status': status, 'field': field,
        'value_hash': value_hash(value), **({'source': source} if source else {})})


def _job(aws) -> dict:
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': JOB_ID})['Item']


@pytest.mark.parametrize(('field', 'extra'), [
    ('author', {'author': 'Jane'}),
    ('csv_row_id', {'csv_row_id': 'Jane'}),
    ('email', {'metadata': {'email': 'Jane'}}),
    ('email', {'metadata': {'submitter_email': 'Jane'}}),
])
def test_erase_deletes_matching_items_and_records_the_job(aws, worker_context, field, extra):
    _erasure_job(aws, field, 'Jane')
    _seed(aws, 'hit', 'web', days_ago(1), **extra)
    _seed(aws, 'miss', 'web', days_ago(1), author='John')
    result = handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)
    assert result['status'] == 'completed'
    assert _ids(aws) == {'miss'}
    job = _job(aws)
    assert (job['status'], job['deleted_items'], job['deleted_objects']) == ('completed', 1, 1)
    assert 'Jane' not in str(_audit(aws))


def test_an_email_erasure_is_case_insensitive(aws, worker_context):
    """Stored lower-cased at intake (and a pre-normalisation item as typed): both match any spelling."""
    _erasure_job(aws, 'email', 'Jane@Example.COM')
    _seed(aws, 'normalised', 'web', days_ago(1), metadata={'submitter_email': 'jane@example.com'})
    _seed(aws, 'legacy', 'web', days_ago(1), metadata={'email': 'Jane@Example.COM'})
    _seed(aws, 'other', 'web', days_ago(1), metadata={'email': 'john@example.com'})
    handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane@Example.COM'}, worker_context)
    assert _ids(aws) == {'other'}


def test_erase_by_source_id_within_one_source(aws, worker_context):
    _erasure_job(aws, 'source_id', 'x1', source='tickets')
    _seed(aws, 'x1', 'tickets', days_ago(1))
    aws['feedback'].put_item(Item={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#w', 'feedback_id': 'w', 'source_id': 'x1',
                                   'source_platform': 'web', 'date': days_ago(1)})
    handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'x1'}, worker_context)
    assert _ids(aws) == {'w'}


def test_a_value_that_does_not_match_the_job_fails_it_and_deletes_nothing(aws, worker_context):
    _erasure_job(aws, 'author', 'Jane')
    _seed(aws, 'hit', 'web', days_ago(1), author='Mallory')
    result = handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Mallory'}, worker_context)
    assert result['status'] == 'failed'
    assert _ids(aws) == {'hit'}
    assert _job(aws)['status'] == 'failed'


@pytest.mark.parametrize('event', [
    {'mode': 'erase', 'job_id': 'nope', 'value': 'x'},
    {'mode': 'erase', 'job_id': JOB_ID},
    {'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'},  # job finished already
])
def test_an_erase_event_that_cannot_run_changes_nothing(aws, worker_context, event):
    _erasure_job(aws, 'author', 'Jane', status='completed')
    _seed(aws, 'hit', 'web', days_ago(1), author='Jane')
    assert handler.handle_event(event, worker_context) == {'status': 'nothing_to_do'}
    assert _ids(aws) == {'hit'}


def test_an_unknown_mode_is_ignored(aws, worker_context):
    assert handler.handle_event({'mode': 'purge'}, worker_context) == {'status': 'ignored'}
    assert _audit(aws) == []


def test_a_low_budget_hands_over_with_the_cursor_and_counters(aws, worker_context, invoke_mock) -> None:
    _profiles(aws, {'id': 'tickets', 'retention_days': 30})
    for n in range(3):
        _seed(aws, f'old{n}', 'tickets', days_ago(60), archive=False)
    budget = iter([900_000, 0])
    worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
    result = handler.handle_event({'mode': 'retention'}, worker_context)
    assert result['status'] == 'continued'
    payload = invoke_mock.call_args.args[1]
    assert invoke_mock.call_args.args[0] == 'voc-retention'
    assert (payload['mode'], payload['run']['deleted_items'], payload['run']['generation']) == ('retention', 1, 1)
    worker_context.get_remaining_time_in_millis.side_effect = None
    handler.handle_event(payload, worker_context)
    assert _ids(aws) == set()
    assert _audit(aws)[0]['deleted_items'] == 3


def test_a_runaway_chain_stops(aws, worker_context):
    result = handler.handle_event({'mode': 'retention', 'run': {'generation': handler.MAX_GENERATIONS}},
                                  worker_context)
    assert result['status'] == 'failed'
    assert _audit(aws)[0]['error'] == 'Stopped after too many hand-overs'


def test_a_second_run_is_a_no_op(aws, worker_context):
    _profiles(aws, {'id': 'tickets', 'retention_days': 30})
    _seed(aws, 'old', 'tickets', days_ago(60))
    handler.handle_event({}, worker_context)
    assert handler.handle_event({}, worker_context)['deleted_items'] == 0
