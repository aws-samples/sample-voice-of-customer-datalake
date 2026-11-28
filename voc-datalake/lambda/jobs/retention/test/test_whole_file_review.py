"""voc-retention lists the whole files an erased item came from for review, in either scope (TENETS.md D5, D8).

A whole file holds every row of one upload: a CSV / JSON upload (``csv_upload/``, ``json_upload/``), a form import's
original (``feedback_form/import/{form_id}/{run}.{ext}``) and the paste confirm's
``manual_import/{y}/{m}/{d}/{job_id}.json``, under the deployment's ``raw/`` or a workspace's ``ws/{ws}/raw/``. An item
from one carries the file's URI as its ``s3_raw_uri`` (``shared/ingest_archive.py`` ``stamp_file_archive``), and a
paste's item its job id in its ``source_id`` (``manual-{job_id}-{n}``). A run that deletes such an item without being
the whole-source erasure of the file's source keeps the file and lists it on the job and audit rows (keys only); a key
under ``manual_import/`` that is not the item's own archive, and a key outside the item's own scope's raw root, are
listed too (fail closed). The per-item delete never deletes a whole file, and an item's own archive is never listed.
"""
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from jobs.retention import copies, handler
from jobs.retention.copies import ItemDeleter
from jobs.retention.runs import MODE_ERASE
from jobs.retention.test.conftest import BUCKET, days_ago, erasure_job, put_feedback, raw_keys
from shared import retention
from shared.digests import sha256_hex
from shared.retention import STORE_FEEDBACK

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
JOB_ID = 'er_00000000f11e'
BASIS = 'GDPR art. 17 request #456'
EMAIL = 'jane@example.com'
UPLOAD_JOB = '0b6f6c1e-9d55-4a1e-8f4b-2a7d1c3e5f60'
FORM = 'frm_0000000000aa'
DAY = '2026/01/01'
DIGEST = '0123456789abcdef'
DEPLOYMENT_JOBS = 'JOB#erasure'
WORKSPACE_JOBS = f'WS#{WS}#JOB#erasure'
WS_RAW = f'ws/{WS}/raw/'


def _put(aws, key: str) -> str:
    aws['s3'].put_object(Bucket=BUCKET, Key=key, Body=b'{"author": "Jane"}')
    return key


def _uri(key: str) -> str:
    return f's3://{BUCKET}/{key}'


def _ws_item(aws, feedback_id: str, source: str, key: str, **extra: Any) -> None:
    """A workspace review whose ``s3_raw_uri`` is ``key`` (its source id is its id unless ``extra`` says otherwise)."""
    aws['feedback'].put_item(Item={
        'pk': f'WS#{WS}#SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
        'source_id': feedback_id, 'source_platform': source, 'date': days_ago(1), 's3_raw_uri': _uri(key),
        'gsi1pk': f'WS#{WS}#DATE#{days_ago(1)}', **extra})


def _pasted(aws, key: str, n: int = 0, **extra: Any) -> None:
    """A deployment review of the paste ``UPLOAD_JOB`` whose ``s3_raw_uri`` is ``key``."""
    put_feedback(aws, f'p{n}', 'manual_import', source_id=_paste_id(n), ingestion_method='manual',
                 s3_raw_uri=_uri(key), **extra)


def _ws_pasted(aws, key: str, **extra: Any) -> None:
    """A workspace review of the paste ``UPLOAD_JOB`` whose ``s3_raw_uri`` is ``key``."""
    _ws_item(aws, _paste_id(), 'manual_import', key, ingestion_method='manual', **extra)


def _deployment_job(aws, field: str, value: str, source: str | None = None) -> dict:
    return erasure_job(aws, JOB_ID, field, value, legal_basis=BASIS, source=source)


def _workspace_job(aws, field: str, value: str) -> dict:
    """An erasure job naming ``WS``, in its own partition, as the settings API writes it."""
    aws['aggregates'].put_item(Item={
        'pk': WORKSPACE_JOBS, 'sk': JOB_ID, 'job_id': JOB_ID, 'status': 'queued', 'field': field,
        'value_hash': sha256_hex(value), 'legal_basis': BASIS, 'workspace_id': WS})
    return {'mode': 'erase', 'job_id': JOB_ID, 'value': value, 'workspace_id': WS}


def _review(aws, partition: str = DEPLOYMENT_JOBS) -> list[str]:
    row = aws['aggregates'].get_item(Key={'pk': partition, 'sk': JOB_ID})['Item']
    return list(row.get('files_needing_review', {}).get('keys', []))


def _audit_review(aws) -> list[str]:
    [audit] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq('AUDIT#retention'))['Items']
    return list(audit.get('files_needing_review', {}).get('keys', []))


def _run(worker_context, event: dict) -> tuple[int, int]:
    """``(items deleted, raw files deleted)`` of one run of ``event``."""
    result = handler.handle_event(event, worker_context)
    return result['deleted_items'], result['deleted_objects']


def _after(aws, key: str, partition: str = DEPLOYMENT_JOBS) -> tuple[bool, list[str]]:
    """``(is key still in the bucket, the keys the job row lists for review)``."""
    return key in raw_keys(aws), _review(aws, partition)


def _paste_key(root: str) -> str:
    return f'{root}manual_import/{DAY}/{UPLOAD_JOB}.json'


def _form_file(root: str) -> str:
    return f'{root}feedback_form/import/{FORM}/{UPLOAD_JOB}.csv'


def _paste_id(n: int = 0) -> str:
    return f'manual-{UPLOAD_JOB}-{n}'


def _erasure_run(field: str, source: str | None = None) -> dict[str, Any]:
    return {'mode': MODE_ERASE, 'field': field, 'source': source, 'deleted_objects': 0, 'deleted_items': 0,
            'deleted_radar_items': 0, 'erased_sources': [], 'review_files': [], 'review_files_more': False}


def _deleted_alone(run: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """``run`` after ``ItemDeleter`` deletes ``item`` (the item's own delete a double, the whole-file rule real)."""
    deleter = ItemDeleter(run, MagicMock(), BUCKET, {STORE_FEEDBACK: MagicMock(), 'aggregates': MagicMock()})
    with patch.object(copies.retention, 'delete_item', return_value=(1, 0)), \
            patch.object(copies.retention, 'delete_whole_upload', side_effect=AssertionError('deleted')):
        deleter.delete(item, STORE_FEEDBACK)
    return run


# A workspace's whole-file uploads (sources with no window, PII allowed), listed by an erasure that reaches them.

def test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review(aws, worker_context):
    upload = _put(aws, f'{WS_RAW}csv_upload/{DAY}/{UPLOAD_JOB}.csv')
    _ws_item(aws, 'c1', 'tickets', upload, metadata={'email': EMAIL})
    _ws_item(aws, 'c2', 'tickets', upload, metadata={'email': 'john@example.com'})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, upload) == (True, [upload])
    assert _audit_review(aws) == [upload]


def test_an_erasure_by_email_lists_a_workspace_json_upload_for_review(aws, worker_context):
    upload = _put(aws, f'{WS_RAW}json_upload/{DAY}/{UPLOAD_JOB}.json')
    _ws_item(aws, 'j1', 'tickets', upload, metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, upload) == (True, [upload])


def test_an_erasure_by_source_id_in_a_workspace_lists_its_csv_upload_for_review(aws, worker_context):
    upload = _put(aws, f'{WS_RAW}csv_upload/{DAY}/{UPLOAD_JOB}.csv')
    _ws_item(aws, '12345', 'tickets', upload)
    assert _run(worker_context, _workspace_job(aws, 'source_id', '12345'))[0] == 1
    assert _after(aws, upload, WORKSPACE_JOBS) == (True, [upload])


def test_an_erasure_by_csv_row_in_a_workspace_lists_its_csv_upload_for_review(aws, worker_context):
    upload = _put(aws, f'{WS_RAW}csv_upload/{DAY}/{UPLOAD_JOB}.csv')
    _ws_item(aws, 'c1', 'tickets', upload, csv_row_id='row-7')
    assert _run(worker_context, _workspace_job(aws, 'csv_row_id', 'row-7'))[0] == 1
    assert _after(aws, upload, WORKSPACE_JOBS) == (True, [upload])


def test_a_retention_windows_run_lists_a_workspace_json_upload_on_its_audit_row(aws, worker_context):
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                     'sources': [{'id': 'tickets', 'retention_days': 30}]})
    upload = _put(aws, f'{WS_RAW}json_upload/{DAY}/{UPLOAD_JOB}.json')
    _ws_item(aws, 'j1', 'tickets', upload, date=days_ago(40))
    assert _run(worker_context, {'mode': 'retention'})[0] == 1
    assert upload in raw_keys(aws)
    assert _audit_review(aws) == [upload]


# The form import's original file, in either scope.

def test_an_erasure_by_email_lists_a_workspace_form_import_file_for_review(aws, worker_context):
    original = _put(aws, _form_file(WS_RAW))
    _ws_item(aws, 'fimp_1', 'feedback_form', original, ingestion_method='form_import', metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, original) == (True, [original])


def test_an_erasure_by_author_lists_a_deployment_form_import_file_for_review(aws, worker_context):
    original = _put(aws, _form_file('raw/'))
    put_feedback(aws, 'fimp_1', 'feedback_form', ingestion_method='form_import', author='Jane Doe',
                 s3_raw_uri=_uri(original))
    assert _run(worker_context, _deployment_job(aws, 'author', 'Jane Doe')) == (1, 0)
    assert _after(aws, original) == (True, [original])


def test_a_whole_source_erasure_of_feedback_form_sweeps_its_import_file_and_lists_nothing(aws, worker_context):
    original = _put(aws, _form_file('raw/'))
    put_feedback(aws, 'fimp_1', 'feedback_form', ingestion_method='form_import', s3_raw_uri=_uri(original))
    assert _run(worker_context, _deployment_job(aws, 'source', 'feedback_form', 'feedback_form'))[0] == 1
    assert _after(aws, original) == (False, [])


def test_a_form_import_file_named_like_the_item_is_never_its_own_archive():
    item = {'pk': 'SOURCE#feedback_form', 'sk': 'FEEDBACK#x', 'source_id': UPLOAD_JOB,
            's3_raw_uri': _uri(f'raw/feedback_form/import/{FORM}/{UPLOAD_JOB}.json')}
    assert retention.item_raw_objects(item, BUCKET) is None


# The paste confirm's whole file, in either scope.

def test_an_erasure_by_email_lists_a_workspace_paste_file_for_review(aws, worker_context):
    paste = _put(aws, _paste_key(WS_RAW))
    _ws_pasted(aws, paste, metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, paste) == (True, [paste])


def test_an_erasure_by_author_in_a_workspace_lists_its_paste_file_for_review(aws, worker_context):
    paste = _put(aws, _paste_key(WS_RAW))
    _ws_pasted(aws, paste, author='Jane Doe')
    assert _run(worker_context, _workspace_job(aws, 'author', 'Jane Doe'))[0] == 1
    assert _after(aws, paste, WORKSPACE_JOBS) == (True, [paste])


def test_an_erasure_by_source_id_lists_a_deployment_paste_file_for_review(aws, worker_context):
    paste = _put(aws, _paste_key('raw/'))
    _pasted(aws, paste)
    _pasted(aws, paste, 1)
    assert _run(worker_context, _deployment_job(aws, 'source_id', _paste_id())) == (1, 0)
    assert _after(aws, paste) == (True, [paste])
    assert _audit_review(aws) == [paste]


def test_an_erasure_by_email_lists_a_deployment_paste_file_for_review(aws, worker_context):
    paste = _put(aws, _paste_key('raw/'))
    _pasted(aws, paste, metadata={'email': EMAIL})
    result = handler.handle_event(_deployment_job(aws, 'email', EMAIL), worker_context)
    assert (result['deleted_items'], result['deleted_objects'], _review(aws)) == (1, 0, [paste])
    assert paste in raw_keys(aws)


def test_a_whole_source_erasure_of_manual_import_sweeps_the_paste_file_and_lists_nothing(aws, worker_context):
    paste = _put(aws, _paste_key('raw/'))
    _pasted(aws, paste)
    assert _run(worker_context, _deployment_job(aws, 'source', 'manual_import', 'manual_import'))[0] == 1
    assert _after(aws, paste) == (False, [])


def test_a_whole_source_erasure_lists_a_paste_file_its_sweep_cannot_reach():
    # A source whose raw folder is no sweep's (raw_source_prefix: None): the file stays, so it is listed.
    item = {'pk': 'SOURCE#csv_upload', 'sk': 'FEEDBACK#p0', 'source_id': _paste_id(), 'source_platform': 'csv_upload',
            's3_raw_uri': _uri(_paste_key('raw/'))}
    assert _deleted_alone(_erasure_run('source', 'csv_upload'), item)['review_files'] == [_paste_key('raw/')]


def test_a_whole_source_erasure_lists_a_paste_file_outside_the_sources_folder():
    item = {'pk': 'SOURCE#tickets', 'sk': 'FEEDBACK#p0', 'source_id': _paste_id(), 'source_platform': 'tickets',
            's3_raw_uri': _uri(_paste_key('raw/'))}
    assert _deleted_alone(_erasure_run('source', 'tickets'), item)['review_files'] == [_paste_key('raw/')]


# Keys under manual_import/ that are not the item's paste file.

def test_a_legacy_per_item_key_under_manual_import_is_deleted_as_the_items_own_and_not_listed(aws, worker_context):
    own = _put(aws, f'raw/manual_import/{DAY}/{_paste_id()}.json')
    _pasted(aws, own)
    assert _run(worker_context, _deployment_job(aws, 'source_id', _paste_id())) == (1, 1)
    assert _after(aws, own) == (False, [])


def test_a_workspace_per_item_folder_under_manual_import_is_deleted_as_the_items_own_and_not_listed(
        aws, worker_context):
    own = _put(aws, f'{WS_RAW}manual_import/{DAY}/{_paste_id()}/{DIGEST}.json')
    _ws_pasted(aws, own, metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 1)
    assert _after(aws, own) == (False, [])


def test_an_unrecognised_key_under_manual_import_is_kept_and_listed_for_review(aws, worker_context):
    other = _put(aws, f'raw/manual_import/{DAY}/someone-else.json')
    _pasted(aws, other)
    assert _run(worker_context, _deployment_job(aws, 'source_id', _paste_id())) == (1, 0)
    assert _after(aws, other) == (True, [other])


# A key outside the item's own scope's raw root: never a whole file of its scope, listed as unknown (fail closed).

def test_a_workspace_items_key_in_another_workspace_is_listed_and_kept(aws, worker_context):
    foreign = _put(aws, f'ws/{OTHER_WS}/raw/csv_upload/{DAY}/{UPLOAD_JOB}.csv')
    _ws_item(aws, 'c1', 'tickets', foreign, metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, foreign) == (True, [foreign])


def test_a_deployment_items_key_under_a_workspace_root_is_listed_and_kept(aws, worker_context):
    foreign = _put(aws, f'{WS_RAW}json_upload/{DAY}/{UPLOAD_JOB}.json')
    put_feedback(aws, 'j1', 'tickets', s3_raw_uri=_uri(foreign))
    assert _run(worker_context, _deployment_job(aws, 'source_id', 'j1')) == (1, 0)
    assert _after(aws, foreign) == (True, [foreign])


def test_a_key_under_an_invalid_workspace_id_is_listed_as_unknown():
    key = f'ws/not-a-workspace/raw/csv_upload/{DAY}/{UPLOAD_JOB}.csv'
    item = {'pk': 'SOURCE#tickets', 'sk': 'FEEDBACK#c1', 'source_id': 'c1', 's3_raw_uri': _uri(key)}
    assert retention.whole_upload_key(item, BUCKET) == key


def test_a_folder_uri_is_no_whole_file():
    item = {'pk': 'SOURCE#tickets', 'sk': 'FEEDBACK#c1', 'source_id': 'c1',
            's3_raw_uri': _uri(f'raw/csv_upload/{DAY}/')}
    assert retention.whole_upload_key(item, BUCKET) is None


# The deployment's own whole-file uploads, as before.

def test_the_deployments_csv_upload_is_still_listed_by_an_erasure_by_source_id(aws, worker_context):
    upload = _put(aws, f'raw/csv_upload/{DAY}/{UPLOAD_JOB}.csv')
    put_feedback(aws, 'c1', 'tickets', s3_raw_uri=_uri(upload))
    assert _run(worker_context, _deployment_job(aws, 'source_id', 'c1')) == (1, 0)
    assert _after(aws, upload) == (True, [upload])


def test_the_deployments_json_upload_is_still_deleted_by_its_whole_source_erasure(aws, worker_context):
    upload = _put(aws, f'raw/json_upload/{DAY}/{UPLOAD_JOB}.json')
    put_feedback(aws, 'j1', 'tickets', s3_raw_uri=_uri(upload))
    assert _run(worker_context, _deployment_job(aws, 'source', 'tickets', 'tickets'))[0] == 1
    assert _after(aws, upload) == (False, [])


# The per-item delete never takes a whole file for an item's own archive.

def test_a_workspace_json_upload_named_like_the_item_is_never_its_own_archive():
    item = {'pk': f'WS#{WS}#SOURCE#tickets', 'sk': 'FEEDBACK#x', 'source_id': UPLOAD_JOB,
            's3_raw_uri': _uri(f'{WS_RAW}json_upload/{DAY}/{UPLOAD_JOB}.json')}
    assert retention.item_raw_objects(item, BUCKET) is None


def test_a_deployment_paste_file_is_its_items_whole_file():
    item = {'pk': 'SOURCE#manual_import', 'sk': 'FEEDBACK#x', 'source_id': _paste_id(),
            's3_raw_uri': _uri(_paste_key('raw/'))}
    assert retention.whole_upload_key(item, BUCKET) == _paste_key('raw/')


def test_a_deployment_json_upload_named_like_the_item_is_never_its_own_archive():
    item = {'pk': 'SOURCE#tickets', 'sk': 'FEEDBACK#x', 'source_id': UPLOAD_JOB,
            's3_raw_uri': _uri(f'raw/json_upload/{DAY}/{UPLOAD_JOB}.json')}
    assert retention.item_raw_objects(item, BUCKET) is None


# A workspace source stored under a reserved id archived its items' own versioned copies in that folder: the versioned
# shape ({stem}/{sha16}.{ext}) is never a whole file's, so such a copy goes with its item and is not listed.

def test_a_workspace_items_own_versioned_copy_under_csv_upload_is_deleted_with_it(aws, worker_context):
    own = _put(aws, f'{WS_RAW}csv_upload/{DAY}/r1/{DIGEST}.json')
    _ws_item(aws, 'r1', 'csv_upload', own)
    assert _run(worker_context, _workspace_job(aws, 'source_id', 'r1')) == (1, 1)
    assert _after(aws, own, WORKSPACE_JOBS) == (False, [])


def test_a_deployment_items_versioned_copy_under_json_upload_is_still_kept_and_listed(aws, worker_context):
    # The deployment's rule is unchanged: nothing under raw/json_upload/ is ever an item's own copy.
    copy = _put(aws, f'raw/json_upload/{DAY}/r1/{DIGEST}.json')
    put_feedback(aws, 'r1', 'json_upload', s3_raw_uri=_uri(copy))
    assert _run(worker_context, _deployment_job(aws, 'source_id', 'r1')) == (1, 0)
    assert _after(aws, copy) == (True, [copy])


def test_another_items_versioned_copy_under_csv_upload_is_listed_not_deleted(aws, worker_context):
    other = _put(aws, f'{WS_RAW}csv_upload/{DAY}/r9/{DIGEST}.json')
    _ws_item(aws, 'r1', 'csv_upload', other, metadata={'email': EMAIL})
    assert _run(worker_context, _deployment_job(aws, 'email', EMAIL)) == (1, 0)
    assert _after(aws, other) == (True, [other])


def test_an_item_with_a_malformed_workspace_key_is_refused_not_read_as_the_deployments():
    item = {'pk': 'WS#not-a-workspace#SOURCE#tickets', 'sk': 'FEEDBACK#x', 'source_id': 'x',
            's3_raw_uri': _uri(f'raw/csv_upload/{DAY}/{UPLOAD_JOB}.csv')}
    with pytest.raises(ValueError, match='not a workspace id'):
        retention.whole_upload_key(item, BUCKET)
