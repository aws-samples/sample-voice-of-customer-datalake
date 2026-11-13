"""shared/ws_repo.py, phase 4's additions: ``export_job_pk``, ``control_query`` (the workspace's two control-plane
partitions of voc-workspaces, read-only) and ``ExportObjects`` (``ws/{ws}/exports/`` only, every object tagged)."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from shared.test.export_s3_double import ExportS3
from shared.ws_repo import (
    EXPORT_TAGGING,
    ExportObjects,
    OutOfScopeError,
    WorkspaceScope,
    control_partition,
    control_query,
    export_job_pk,
    exports_prefix,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE = WorkspaceScope(WS)
BUCKET = 'raw-bucket'


def test_the_export_jobs_partition_is_the_workspaces():
    assert export_job_pk(SCOPE) == f'WS#{WS}#JOB#export'
    assert SCOPE.owns(export_job_pk(SCOPE))
    assert not WorkspaceScope(OTHER).owns(export_job_pk(SCOPE))


def test_the_control_partitions_are_built_by_the_layer():
    assert control_partition(SCOPE, 'meta') == f'WS#{WS}'
    assert control_partition(SCOPE, 'audit') == f'AUDIT#WS#{WS}'
    with pytest.raises(ValueError, match='control partition'):
        control_partition(SCOPE, 'users')


def test_a_control_query_reads_one_page_of_its_partition_only():
    table = MagicMock()
    table.query.return_value = {'Items': [{'pk': f'WS#{WS}', 'sk': 'META'}]}
    page = control_query(SCOPE, table, 'meta', sort_condition='#sk = :meta', ExpressionAttributeNames={'#sk': 'sk'},
                         ExpressionAttributeValues={':meta': 'META'}, ConsistentRead=True)
    assert page['Items'][0]['sk'] == 'META'
    table.query.assert_called_once_with(
        KeyConditionExpression='#p = :p AND #sk = :meta', ExpressionAttributeNames={'#sk': 'sk', '#p': 'pk'},
        ExpressionAttributeValues={':meta': 'META', ':p': f'WS#{WS}'}, ConsistentRead=True)
    # Read-only: nothing but a Query reaches the table.
    assert [name for name, *_ in table.method_calls] == ['query']


def test_a_control_query_resumes_only_inside_its_partition():
    table = MagicMock()
    table.query.return_value = {'Items': []}
    control_query(SCOPE, table, 'audit', ExclusiveStartKey={'pk': f'AUDIT#WS#{WS}', 'sk': '2026-11-13T09:00:00#ab'})
    for cursor in ({'pk': f'AUDIT#WS#{OTHER}', 'sk': 'x'}, {'pk': f'WS#{WS}', 'sk': 'META'}, 'not a key'):
        with pytest.raises(OutOfScopeError, match='cursor'):
            control_query(SCOPE, table, 'audit', ExclusiveStartKey=cursor)
    assert table.query.call_count == 1


@pytest.mark.parametrize('field', ['IndexName', 'KeyConditionExpression', 'TableName', 'RequestItems'])
def test_a_control_query_takes_no_index_key_condition_or_table(field):
    table = MagicMock()
    with pytest.raises(OutOfScopeError):
        control_query(SCOPE, table, 'meta', **{field: 'x'})
    table.query.assert_not_called()


def _objects(min_part: int = 1) -> tuple[ExportObjects, ExportS3]:
    s3 = ExportS3(BUCKET, min_part=min_part)
    return ExportObjects(SCOPE, s3, BUCKET), s3


def test_the_s3_double_refuses_a_part_under_the_minimum_but_the_last():
    objects, s3 = _objects(min_part=8)
    key = objects.key('ex_1', 'workspace-export.zip')
    upload = objects.create_multipart_upload(key, 'application/zip')
    objects.upload_part(key, upload, 1, b'short')
    objects.upload_part(key, upload, 2, b'last')
    with pytest.raises(ClientError, match='EntityTooSmall'):
        objects.complete_multipart_upload(key, upload, objects.list_parts(key, upload))
    assert key not in s3.objects
    upload = objects.create_multipart_upload(key, 'application/zip')
    objects.upload_part(key, upload, 1, b'long enough')
    objects.upload_part(key, upload, 2, b'last')
    objects.complete_multipart_upload(key, upload, objects.list_parts(key, upload))
    assert s3.objects[key][0] == b'long enoughlast'


def test_export_keys_live_under_the_workspaces_exports():
    objects, _ = _objects()
    assert exports_prefix(SCOPE) == f'ws/{WS}/exports/'
    assert objects.key('ex_1', 'workspace-export.zip') == f'ws/{WS}/exports/ex_1/workspace-export.zip'
    with pytest.raises(ValueError, match='non-empty segments'):
        objects.key('ex_1', '..', 'raw')


@pytest.mark.parametrize('key', [
    f'ws/{WS}/raw/web/2026/11/13/item/abc.json', f'ws/{OTHER}/exports/ex_1/workspace-export.zip',
    f'ws/{WS}/exports/../raw/x', f'ws/{WS}/exports/ex_1//x', f'ws/{WS}/exports/', 'exports/ex_1/x', f'ws/{WS}/exportsx/y',
])
def test_every_call_refuses_a_key_outside_the_exports(key):
    objects, s3 = _objects()
    calls = [
        lambda: objects.create_multipart_upload(key, 'application/zip'),
        lambda: objects.upload_part(key, 'u', 1, b'x'),
        lambda: objects.list_parts(key, 'u'),
        lambda: objects.complete_multipart_upload(key, 'u', []),
        lambda: objects.abort_multipart_upload(key, 'u'),
        lambda: objects.put_work_object(key, b'x'),
        lambda: objects.read_object(key),
        lambda: objects.presigned_download(key, 'a.zip', 900),
    ]
    for call in calls:
        with pytest.raises(OutOfScopeError):
            call()
    assert s3.calls == []


def test_an_upload_already_gone_is_aborted_and_any_other_fault_raises():
    """``NoSuchUpload`` (aborted or completed since it was listed) is done; every other fault still raises."""
    objects, s3 = _objects()
    key = objects.key('ex_1', 'workspace-export.zip')
    s3.fail_on = 'abort_multipart_upload'
    s3.error = ClientError({'Error': {'Code': 'NoSuchUpload', 'Message': 'x'}}, 'AbortMultipartUpload')
    objects.abort_multipart_upload(key, 'u')
    s3.fail_on = 'abort_multipart_upload'
    s3.error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'x'}}, 'AbortMultipartUpload')
    with pytest.raises(ClientError, match='AccessDenied'):
        objects.abort_multipart_upload(key, 'u')


def test_a_multipart_upload_round_trips_and_is_tagged():
    objects, s3 = _objects()
    key = objects.key('ex_1', 'workspace-export.zip')
    upload = objects.create_multipart_upload(key, 'application/zip')
    for number, body in ((1, b'first'), (2, b'second'), (3, b'third')):
        objects.upload_part(key, upload, number, body)
    parts = objects.list_parts(key, upload)
    assert [part['PartNumber'] for part in parts] == [1, 2, 3]
    objects.complete_multipart_upload(key, upload, parts)
    assert s3.objects[key] == (b'firstsecondthird', EXPORT_TAGGING)
    assert EXPORT_TAGGING == 'voc-export=true'


def test_list_parts_follows_every_page():
    objects, s3 = _objects()
    key = objects.key('ex_1', 'workspace-export.zip')
    upload = objects.create_multipart_upload(key, 'application/zip')
    for number in range(1, 2501):
        objects.upload_part(key, upload, number, b'x')
    parts = objects.list_parts(key, upload)
    assert [part['PartNumber'] for part in parts] == list(range(1, 2501))
    assert [method for method, _ in s3.calls].count('list_parts') == 3


def test_the_open_uploads_are_the_workspaces_exports_only():
    objects, s3 = _objects()
    first = objects.create_multipart_upload(objects.key('ex_1', 'workspace-export.zip'), 'application/zip')
    ExportObjects(WorkspaceScope(OTHER), s3, BUCKET).create_multipart_upload(
        f'ws/{OTHER}/exports/ex_2/workspace-export.zip', 'application/zip')
    assert objects.open_uploads() == [(f'ws/{WS}/exports/ex_1/workspace-export.zip', first)]


def test_only_a_work_object_can_be_deleted_never_the_zip():
    objects, s3 = _objects()
    work = objects.key('ex_1', 'work', 'cd-0')
    objects.put_work_object(work, b'records')
    objects.delete_work_object(work)
    assert work not in s3.objects
    for key in (objects.key('ex_1', 'workspace-export.zip'), objects.key('ex_1', 'work'),
                objects.key('ex_1', 'work', 'a', 'b'), f'ws/{OTHER}/exports/ex_1/work/cd-0'):
        with pytest.raises(OutOfScopeError):
            objects.delete_work_object(key)
    assert [method for method, _key in s3.calls].count('delete_object') == 1


def test_work_objects_are_tagged_and_read_back():
    objects, s3 = _objects()
    key = objects.key('ex_1', 'work', 'tail-0')
    objects.put_work_object(key, b'tail bytes')
    assert s3.objects[key] == (b'tail bytes', EXPORT_TAGGING)
    assert objects.read_object(key) == b'tail bytes'


def test_a_download_is_a_presigned_attachment():
    objects, s3 = _objects()
    key = objects.key('ex_1', 'workspace-export.zip')
    url = objects.presigned_download(key, 'acme-export-2026-11-13.zip', 900)
    assert url.startswith('https://')
    assert s3.last_presign == {'Bucket': BUCKET, 'Key': key, 'ExpiresIn': 900,
                               'ResponseContentDisposition': 'attachment; filename="acme-export-2026-11-13.zip"'}
    for name in ('', 'a"b.zip', 'a/b.zip', 'a\r\nb.zip'):
        with pytest.raises(ValueError, match='download name'):
            objects.presigned_download(key, name, 900)


def test_an_export_needs_its_bucket():
    with pytest.raises(ValueError, match='bucket'):
        ExportObjects(SCOPE, ExportS3(BUCKET), '')
