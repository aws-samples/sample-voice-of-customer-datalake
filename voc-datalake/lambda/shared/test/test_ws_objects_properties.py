"""Properties of a workspace's objects (shared/ws_repo.py ``ExportObjects`` and ``WorkspaceObjects``).

The export job reads every object of one workspace and writes one zip under its exports: an object of another team
read into it, an export zip read back into the next export, or a write or delete outside ``ws/{ws}/exports/`` would
leak or destroy a team's data. The S3 client is a recording double, so "no call reached S3" is checked directly.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from hypothesis import given
from hypothesis import strategies as st

from shared.test.ws_properties import PROPERTY, exactly, two_workspace_ids, workspace_ids
from shared.ws_repo import (
    EXPORT_TAGGING,
    ExportObjects,
    ListedObject,
    OutOfScopeError,
    WorkspaceObjects,
    WorkspaceScope,
    exports_prefix,
    s3_prefix,
)

BUCKET = 'voc-raw'
SEGMENT = st.text(alphabet='abcXYZ019-_.', min_size=1, max_size=8).filter(lambda part: part not in ('.', '..'))
OUTSIDE_EXPORTS = "a key outside the workspace's exports"
OUTSIDE_OWN = "a key outside the workspace's own objects"


@st.composite
def foreign_keys(draw: st.DrawFn, mine: WorkspaceScope, theirs: WorkspaceScope, under: str) -> str:
    """A key that is not under ``under`` of ``mine`` with clean segments: another workspace's, a climb out, an empty,
    ``.`` or ``..`` segment, a look-alike prefix, the bare prefix."""
    rest = draw(SEGMENT)
    return draw(st.sampled_from([
        f'{under.replace(mine.ws, theirs.ws)}{rest}', f'{under}../{rest}', f'{under}{rest}/../x', f'{under}./{rest}',
        f'{under}{rest}//x', f'{under}', f'{under[:-1]}x/{rest}', f'raw/{rest}', f'/{under}{rest}', rest,
    ]))


# Every export object the job touches is under its workspace's ``exports/``, with clean segments: an upload, a part,
# a listing of parts, a completion, a work object's put, read and delete, a presigned link. Any other key is refused
# before the call, and every object created carries the export tag the bucket's lifecycle expires.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.lists(SEGMENT, min_size=1, max_size=3))
def test_export_objects_stay_in_the_workspace_exports(data, pair, parts):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    s3 = MagicMock()
    s3.create_multipart_upload.return_value = {'UploadId': 'u1'}
    s3.upload_part.return_value = {'ETag': '"e1"'}
    s3.list_parts.return_value = {'Parts': [{'PartNumber': 2, 'ETag': 'b'}, {'PartNumber': 1, 'ETag': 'a'}]}
    s3.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value=b'zip'))}
    s3.generate_presigned_url.return_value = 'https://signed'
    objects = ExportObjects(mine, s3, BUCKET)
    key = objects.key(*parts)
    assert key == f"{exports_prefix(mine)}{'/'.join(parts)}"
    assert objects.start_upload(key, 'application/zip') == 'u1'
    s3.create_multipart_upload.assert_called_once_with(Bucket=BUCKET, Key=key, ContentType='application/zip',
                                                       Tagging=EXPORT_TAGGING)
    assert objects.upload_part(key, 'u1', 1, b'x') == '"e1"'
    assert objects.list_parts(key, 'u1') == [{'PartNumber': 1, 'ETag': 'a'}, {'PartNumber': 2, 'ETag': 'b'}]
    objects.put_work_object(key, b'tail')
    s3.put_object.assert_called_once_with(Bucket=BUCKET, Key=key, Body=b'tail', Tagging=EXPORT_TAGGING)
    assert objects.read_object(key) == b'zip'
    assert objects.presigned_download(key, 'Team X export.zip', 900) == 'https://signed'
    s3.generate_presigned_url.assert_called_once_with('get_object', ExpiresIn=900, Params={
        'Bucket': BUCKET, 'Key': key, 'ResponseContentDisposition': 'attachment; filename="Team X export.zip"'})
    objects.abort_multipart_upload(key, 'u1')
    s3.abort_multipart_upload.assert_called_once_with(Bucket=BUCKET, Key=key, UploadId='u1')

    s3 = MagicMock()
    objects = ExportObjects(mine, s3, BUCKET)
    bad = data.draw(foreign_keys(mine, theirs, exports_prefix(mine)))
    calls = [lambda: objects.start_upload(bad, 'application/zip'), lambda: objects.upload_part(bad, 'u', 1, b''),
             lambda: objects.list_parts(bad, 'u'), lambda: objects.complete_multipart_upload(bad, 'u', []),
             lambda: objects.abort_multipart_upload(bad, 'u'), lambda: objects.put_work_object(bad, b''),
             lambda: objects.delete_work_object(bad), lambda: objects.read_object(bad),
             lambda: objects.presigned_download(bad, 'export.zip', 900)]
    for call in calls:
        with pytest.raises(OutOfScopeError, match=exactly(OUTSIDE_EXPORTS)):
            call()
    assert s3.mock_calls == []


# Only a work object (``{export id}/work/{name}``) of an export may be deleted: never the zip, nothing deeper.
@PROPERTY
@given(workspace_ids(), SEGMENT, SEGMENT, st.sampled_from(['zip', 'deeper', 'other-folder', 'work']))
def test_only_a_work_object_is_deleted(ws, export_id, name, shape):
    scope = WorkspaceScope(ws)
    s3 = MagicMock()
    objects = ExportObjects(scope, s3, BUCKET)
    key = {'zip': objects.key(export_id, 'workspace-export.zip'), 'deeper': objects.key(export_id, 'work', name, 'x'),
           'other-folder': objects.key(export_id, 'parts', name), 'work': objects.key(export_id, 'work', name)}[shape]
    if shape == 'work':
        objects.delete_work_object(key)
        s3.delete_object.assert_called_once_with(Bucket=BUCKET, Key=key)
        return
    with pytest.raises(OutOfScopeError, match=exactly("not a work object of the workspace's exports")):
        objects.delete_work_object(key)
    assert s3.mock_calls == []


# A download is named by a plain file name only: a quote, a backslash, a slash or a line break would break the
# Content-Disposition header (or name a path), and an empty name is no name.
@PROPERTY
@given(workspace_ids(), st.text(alphabet='ab.-', max_size=4), st.sampled_from(['"', '\\', '/', '\r', '\n', '']))
def test_a_download_name_is_a_plain_file_name(ws, stem, bad):
    scope = WorkspaceScope(ws)
    s3 = MagicMock()
    objects = ExportObjects(scope, s3, BUCKET)
    with pytest.raises(ValueError, match=exactly('a download name is a plain file name')):
        objects.presigned_download(objects.key('x.zip'), f'{stem}{bad}' if bad else '', 60)
    assert s3.mock_calls == []


# Listing every open upload walks every page of the workspace's exports prefix only, and a listed key outside it is
# refused; an abort of an upload already gone is done, any other fault is raised.
@PROPERTY
@given(workspace_ids(), st.lists(SEGMENT, min_size=0, max_size=5, unique=True),
       st.sampled_from(['NoSuchUpload', 'AccessDenied', None]))
def test_open_uploads_are_the_workspace_exports_only(ws, names, abort_code):
    scope = WorkspaceScope(ws)
    s3 = MagicMock()
    objects = ExportObjects(scope, s3, BUCKET)
    uploads = [{'Key': objects.key(name), 'UploadId': f'u{n}'} for n, name in enumerate(names)]
    pages = [uploads[:2], uploads[2:]] if len(uploads) > 2 else [uploads]
    s3.list_multipart_uploads.side_effect = [
        {'Uploads': page, **({'IsTruncated': True, 'NextKeyMarker': 'k', 'NextUploadIdMarker': 'm'}
                             if index < len(pages) - 1 else {})} for index, page in enumerate(pages)]
    assert objects.open_uploads() == [(upload['Key'], upload['UploadId']) for upload in uploads]
    requests = [call.kwargs for call in s3.list_multipart_uploads.call_args_list]
    assert requests[0] == {'Bucket': BUCKET, 'Prefix': exports_prefix(scope)}
    assert all(request == {'Bucket': BUCKET, 'Prefix': exports_prefix(scope), 'KeyMarker': 'k',
                           'UploadIdMarker': 'm'} for request in requests[1:])
    # None: a fault whose answer carries no Error at all, raised as it came.
    response: Any = {} if abort_code is None else {'Error': {'Code': abort_code}}
    s3.abort_multipart_upload.side_effect = ClientError(response, 'AbortMultipartUpload')
    if abort_code == 'NoSuchUpload':
        objects.abort_multipart_upload(objects.key('x'), 'u')
    else:
        with pytest.raises(ClientError):
            objects.abort_multipart_upload(objects.key('x'), 'u')
    s3.list_multipart_uploads.side_effect = [{'Uploads': [{'Key': 'ws/elsewhere/exports/x', 'UploadId': 'u'}]}]
    with pytest.raises(OutOfScopeError, match=exactly(OUTSIDE_EXPORTS)):
        objects.open_uploads()


# A workspace's own objects are everything under ``ws/{ws}/`` except its exports: a listing pages that prefix only,
# leaves the exports out, refuses a listed key outside it and a cursor outside it; a read is refused for any key
# outside them (another team's, an export, a climb out) before any call.
@PROPERTY
@given(st.data(), two_workspace_ids(), st.lists(st.lists(SEGMENT, min_size=1, max_size=3), max_size=5),
       st.booleans())
def test_a_workspace_reads_its_own_objects_only(data, pair, paths, truncated):
    mine, theirs = WorkspaceScope(pair[0]), WorkspaceScope(pair[1])
    prefix = s3_prefix(mine)
    own = [f"{prefix}{'/'.join(path)}" for path in paths]
    exported = [f'{exports_prefix(mine)}e1/workspace-export.zip']
    s3 = MagicMock()
    s3.list_objects_v2.return_value = {'Contents': [{'Key': key, 'Size': n} for n, key in enumerate(own + exported)],
                                       'IsTruncated': truncated}
    objects = WorkspaceObjects(mine, s3, BUCKET)
    page = objects.list_page(None)
    assert page.objects == [ListedObject(key, n) for n, key in enumerate(own) if not key.startswith(exports_prefix(mine))]
    assert page.following == (exported[-1] if truncated else None)
    s3.list_objects_v2.assert_called_once_with(Bucket=BUCKET, Prefix=prefix, MaxKeys=1000)
    objects.list_page(f'{prefix}a')
    assert s3.list_objects_v2.call_args.kwargs == {'Bucket': BUCKET, 'Prefix': prefix, 'MaxKeys': 1000,
                                                   'StartAfter': f'{prefix}a'}

    s3 = MagicMock()
    objects = WorkspaceObjects(mine, s3, BUCKET)
    with pytest.raises(OutOfScopeError, match=exactly('a listing cursor outside the workspace')):
        objects.list_page(f'{s3_prefix(theirs)}a')
    for bad in (data.draw(foreign_keys(mine, theirs, prefix)), f'{exports_prefix(mine)}e1/workspace-export.zip'):
        with pytest.raises(OutOfScopeError, match=exactly(OUTSIDE_OWN)):
            objects.open(bad)
        with pytest.raises(OutOfScopeError, match=exactly(OUTSIDE_OWN)):
            objects.resume(bad, 0, '"etag"')
    assert s3.mock_calls == []
    s3.list_objects_v2.return_value = {'Contents': [{'Key': f'{s3_prefix(theirs)}x'}]}
    with pytest.raises(OutOfScopeError, match=exactly('a listed key outside the workspace')):
        objects.list_page(None)


# A read that S3 answers 403 is a missing object only when a listing of exactly that key does not find it (a role
# without an unconditioned ListBucket gets 403 for a missing key); found, the 403 is real and raised. A resume reads
# the rest of the same version only (``IfMatch``), from a byte offset of zero or more.
@PROPERTY
@given(workspace_ids(), SEGMENT, st.sampled_from(['NoSuchKey', 'AccessDenied', '403', 'SlowDown', None]),
       st.booleans(), st.integers(min_value=0, max_value=10**9))
def test_a_403_is_missing_only_when_the_key_is_not_listed(ws, name, code, listed, start):
    scope = WorkspaceScope(ws)
    key = f'{s3_prefix(scope)}raw/{name}'
    s3 = MagicMock()
    # None: a fault whose answer carries no Error at all, raised as it came.
    answer: Any = {} if code is None else {'Error': {'Code': code}}
    s3.get_object.side_effect = ClientError(answer, 'GetObject')
    s3.list_objects_v2.return_value = {'Contents': [{'Key': key if listed else f'{key}-longer'}]}
    objects = WorkspaceObjects(scope, s3, BUCKET)
    missing = code == 'NoSuchKey' or (code in ('AccessDenied', '403') and not listed)
    if missing:
        gone = objects.open(key)
        assert gone is None
    else:
        with pytest.raises(ClientError):
            objects.open(key)
    if code in ('AccessDenied', '403'):
        s3.list_objects_v2.assert_called_once_with(Bucket=BUCKET, Prefix=key, MaxKeys=1)
    s3.get_object.assert_called_once_with(Bucket=BUCKET, Key=key)
    s3.get_object.side_effect = None
    s3.get_object.return_value = {'Body': 'stream'}
    bare = objects.open(key)
    assert bare is not None
    assert (bare.content_type, bare.size, bare.etag) == ('', 0, '')
    s3.get_object.return_value = {'Body': 'stream', 'ContentType': 'application/json', 'ContentLength': 7,
                                  'ETag': '"v1"'}
    opened = objects.open(key)
    assert opened is not None
    assert (opened.body, opened.content_type, opened.size, opened.etag) == ('stream', 'application/json', 7, '"v1"')
    rest = objects.resume(key, start, '"v1"')
    assert rest == 'stream'
    assert s3.get_object.call_args.kwargs == {'Bucket': BUCKET, 'Key': key, 'Range': f'bytes={start}-',
                                              'IfMatch': '"v1"'}
    for bad_start, etag in ((start, ''), (-1 - start, '"v1"')):
        with pytest.raises(ValueError, match=exactly('a resume names the version read and a byte offset')):
            objects.resume(key, bad_start, etag)


def _needs_a_bucket(make: Any, message: str) -> None:
    with pytest.raises(ValueError, match=exactly(message)):
        make(WorkspaceScope('ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'), MagicMock(), '')


def test_both_views_need_their_bucket():
    """No bucket, no view: an empty name would send every call to S3's default."""
    _needs_a_bucket(ExportObjects, 'an export needs its bucket')
    _needs_a_bucket(WorkspaceObjects, 'a workspace has its objects in a bucket')
