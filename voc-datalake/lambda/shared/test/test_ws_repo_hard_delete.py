"""shared/ws_repo.py, the checked deletes of the workspace hard delete (slice 4d-2, docs/multi-workspace.md, "Export
and delete"): ``WorkspaceTable.batch_delete``, ``WorkspaceObjectVersions``, ``WorkspaceControlRows``,
``WorkspaceTombstones`` and ``delete_work_pk``. Their caller is lambda/jobs/workspace_delete/."""
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table
from shared.ws_repo import (
    BATCH_WRITE_ATTEMPTS,
    MAX_BATCH_WRITE_ITEMS,
    VERSIONS_PAGE,
    ObjectVersion,
    OutOfScopeError,
    UnprocessedItemsError,
    WorkspaceControlRows,
    WorkspaceObjectVersions,
    WorkspaceScope,
    WorkspaceTombstones,
    delete_work_pk,
    feedback_key,
    watermark_key,
    workspace_tombstone_key,
    ws_table,
)

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
A = WorkspaceScope(WS)
B = WorkspaceScope(OTHER_WS)
BUCKET = 'voc-raw-hard-delete'


def _key(scope: WorkspaceScope, n: int) -> dict[str, str]:
    return feedback_key(scope, 'web', f'f{n}')


def _backing() -> MagicMock:
    backing = MagicMock()
    backing.name = 'voc-feedback'
    backing.meta.client.batch_write_item.return_value = {'UnprocessedItems': {}}
    return backing


def _deletes(keys: list[dict]) -> dict:
    return {'voc-feedback': [{'DeleteRequest': {'Key': key}} for key in keys]}


def _failure(code: str, operation: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'x'}}, operation)


class TestTheBatchDelete:
    def test_deletes_every_key_against_a_real_table(self):
        with mock_aws():
            table = create_pk_sk_table('voc-feedback')
            for scope in (A, B):
                for n in range(30):
                    table.put_item(Item={**_key(scope, n), 'text': 'Late parcel'})
            sent = ws_table(A, table).batch_delete([_key(A, n) for n in range(30)])
            left = table.scan()['Items']

        assert sent == 30
        assert {str(item['pk']) for item in left} == {f'WS#{OTHER_WS}#SOURCE#web'}
        assert len(left) == 30

    def test_sends_requests_of_25_on_its_own_table(self):
        backing = _backing()
        keys = [_key(A, n) for n in range(MAX_BATCH_WRITE_ITEMS + 1)]

        ws_table(A, backing).batch_delete(keys)

        assert [call.kwargs for call in backing.meta.client.batch_write_item.call_args_list] == [
            {'RequestItems': _deletes(keys[:MAX_BATCH_WRITE_ITEMS])},
            {'RequestItems': _deletes(keys[MAX_BATCH_WRITE_ITEMS:])},
        ]

    def test_one_key_outside_the_scope_refuses_the_whole_call(self):
        backing = _backing()
        with pytest.raises(OutOfScopeError, match='outside the workspace'):
            ws_table(A, backing).batch_delete([_key(A, 1), _key(B, 2)])
        backing.meta.client.batch_write_item.assert_not_called()

    @pytest.mark.parametrize('key', [
        {'pk': f'WS#{WS}#SOURCE#web'},  # no sort key
        {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'FEEDBACK#f1', 'text': 'x'},  # more than the key
        {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'},  # the deployment's
        {'pk': 'AUDIT#tombstone#web', 'sk': f'{WS}#f1'},  # a tombstone, never through a view
    ])
    def test_a_key_that_is_not_exactly_one_of_the_workspace_is_refused(self, key):
        backing = _backing()
        with pytest.raises((OutOfScopeError, ValueError)):
            ws_table(A, backing).batch_delete([key])
        backing.meta.client.batch_write_item.assert_not_called()

    def test_a_key_named_twice_is_refused(self):
        backing = _backing()
        with pytest.raises(ValueError, match='names one item twice'):
            ws_table(A, backing).batch_delete([_key(A, 1), _key(A, 1)])
        backing.meta.client.batch_write_item.assert_not_called()

    def test_on_voc_watermarks_the_key_is_source_alone(self):
        backing = _backing()
        backing.name = 'voc-watermarks'
        view = ws_table(A, backing, 'source')

        sent = view.batch_delete([{'source': watermark_key(A, 'webscraper', 'last_id')}])
        assert sent == 1
        with pytest.raises(ValueError, match='by its key alone'):
            view.batch_delete([{'source': watermark_key(A, 'webscraper', 'last_id'), 'value': '7'}])
        with pytest.raises(OutOfScopeError):
            view.batch_delete([{'source': watermark_key(B, 'webscraper', 'last_id')}])

    def test_unprocessed_items_are_sent_again_with_a_backoff(self):
        backing = _backing()
        keys = [_key(A, n) for n in range(3)]
        backing.meta.client.batch_write_item.side_effect = [
            {'UnprocessedItems': _deletes(keys[1:])},
            {'UnprocessedItems': _deletes(keys[2:])},
            {'UnprocessedItems': {}},
        ]
        with patch('shared.batch_get.time.sleep') as sleep:
            assert ws_table(A, backing).batch_delete(keys) == 3

        assert [call.kwargs['RequestItems'] for call in backing.meta.client.batch_write_item.call_args_list] == [
            _deletes(keys), _deletes(keys[1:]), _deletes(keys[2:])]
        assert sleep.call_count == 2

    def test_items_still_unprocessed_after_the_bound_fail_the_delete(self):
        backing = _backing()
        keys = [_key(A, 1)]
        backing.meta.client.batch_write_item.return_value = {'UnprocessedItems': _deletes(keys)}
        with patch('shared.batch_get.time.sleep'), pytest.raises(UnprocessedItemsError, match='1 deletes'):
            ws_table(A, backing).batch_delete(keys)
        assert backing.meta.client.batch_write_item.call_count == BATCH_WRITE_ATTEMPTS

    def test_unprocessed_items_outside_the_scope_are_never_sent_again(self):
        """What DynamoDB hands back is checked like what was sent."""
        backing = _backing()
        backing.meta.client.batch_write_item.return_value = {'UnprocessedItems': _deletes([_key(B, 1)])}
        with patch('shared.batch_get.time.sleep'), pytest.raises(OutOfScopeError):
            ws_table(A, backing).batch_delete([_key(A, 1)])
        assert backing.meta.client.batch_write_item.call_count == 1

    def test_an_unprocessed_request_that_is_not_a_delete_is_never_sent_again(self):
        backing = _backing()
        backing.meta.client.batch_write_item.return_value = {
            'UnprocessedItems': {'voc-feedback': [{'PutRequest': {'Item': _key(A, 1)}}]}}
        with patch('shared.batch_get.time.sleep'), pytest.raises(OutOfScopeError, match='deletes only'):
            ws_table(A, backing).batch_delete([_key(A, 1)])
        assert backing.meta.client.batch_write_item.call_count == 1

    def test_no_keys_sends_nothing(self):
        backing = _backing()
        assert ws_table(A, backing).batch_delete([]) == 0
        backing.meta.client.batch_write_item.assert_not_called()


@pytest.fixture
def bucket():
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={'Status': 'Enabled'})
        yield s3


def _every_version(s3) -> list[str]:
    listed = s3.list_object_versions(Bucket=BUCKET)
    return sorted(entry['Key'] for part in ('Versions', 'DeleteMarkers') for entry in listed.get(part) or [])


class TestTheVersionedObjectDelete:
    def test_lists_and_deletes_every_version_and_marker_of_the_workspace_only(self, bucket):
        for key in (f'ws/{WS}/raw/web/a.json', f'ws/{WS}/exports/x/data.zip', f'ws/{OTHER_WS}/raw/web/a.json',
                    'raw/web/a.json'):
            bucket.put_object(Bucket=BUCKET, Key=key, Body=b'one')
            bucket.put_object(Bucket=BUCKET, Key=key, Body=b'two')
        bucket.delete_object(Bucket=BUCKET, Key=f'ws/{WS}/raw/web/a.json')  # a delete marker
        objects = WorkspaceObjectVersions(A, bucket, BUCKET)

        page = objects.list_page(None)
        assert len(page.versions) == 5  # 2 + 2 versions, 1 marker
        assert {version.key for version in page.versions} == {f'ws/{WS}/raw/web/a.json', f'ws/{WS}/exports/x/data.zip'}
        assert page.following is None
        failures = objects.delete(page.versions)
        assert failures == []

        assert _every_version(bucket) == sorted([f'ws/{OTHER_WS}/raw/web/a.json'] * 2 + ['raw/web/a.json'] * 2)

    def test_pages_by_its_markers(self):
        s3 = MagicMock()
        s3.list_object_versions.side_effect = [
            {'Versions': [{'Key': f'ws/{WS}/raw/a', 'VersionId': 'v1'}], 'IsTruncated': True,
             'NextKeyMarker': f'ws/{WS}/raw/a', 'NextVersionIdMarker': 'v1'},
            {'DeleteMarkers': [{'Key': f'ws/{WS}/raw/b', 'VersionId': 'v2'}], 'IsTruncated': False},
        ]
        objects = WorkspaceObjectVersions(A, s3, BUCKET)

        first = objects.list_page(None)
        second = objects.list_page(first.following)

        assert first.following == (f'ws/{WS}/raw/a', 'v1')
        assert second.versions == [ObjectVersion(f'ws/{WS}/raw/b', 'v2')]
        assert [call.kwargs for call in s3.list_object_versions.call_args_list] == [
            {'Bucket': BUCKET, 'Prefix': f'ws/{WS}/', 'MaxKeys': VERSIONS_PAGE},
            {'Bucket': BUCKET, 'Prefix': f'ws/{WS}/', 'MaxKeys': VERSIONS_PAGE, 'KeyMarker': f'ws/{WS}/raw/a',
             'VersionIdMarker': 'v1'},
        ]

    def test_a_listed_key_outside_the_workspace_is_refused(self):
        s3 = MagicMock()
        s3.list_object_versions.return_value = {'Versions': [{'Key': f'ws/{OTHER_WS}/raw/a', 'VersionId': 'v1'}]}
        with pytest.raises(OutOfScopeError):
            WorkspaceObjectVersions(A, s3, BUCKET).list_page(None)

    def test_a_cursor_outside_the_workspace_is_refused(self):
        s3 = MagicMock()
        with pytest.raises(OutOfScopeError):
            WorkspaceObjectVersions(A, s3, BUCKET).list_page((f'ws/{OTHER_WS}/raw/a', 'v1'))
        s3.list_object_versions.assert_not_called()

    @pytest.mark.parametrize('key', [f'ws/{OTHER_WS}/raw/a', 'raw/a', f'ws/{WS}/', f'ws/{WS}', '',
                                     f'ws/{WS}x/raw/a'])
    def test_one_version_outside_the_workspace_refuses_the_whole_delete(self, key):
        s3 = MagicMock()
        with pytest.raises(OutOfScopeError):
            WorkspaceObjectVersions(A, s3, BUCKET).delete([ObjectVersion(f'ws/{WS}/raw/a', 'v1'),
                                                          ObjectVersion(key, 'v2')])
        s3.delete_objects.assert_not_called()

    def test_deletes_by_version_in_pages_of_1000_at_most(self):
        s3 = MagicMock()
        s3.delete_objects.return_value = {}
        objects = WorkspaceObjectVersions(A, s3, BUCKET)
        versions = [ObjectVersion(f'ws/{WS}/raw/{n}', 'v1') for n in range(VERSIONS_PAGE + 1)]

        with pytest.raises(ValueError, match='1 to 1000'):
            objects.delete(versions)
        with pytest.raises(ValueError, match='1 to 1000'):
            objects.delete([])
        with pytest.raises(ValueError, match='twice'):
            objects.delete([versions[0], versions[0]])
        objects.delete(versions[:VERSIONS_PAGE])

        (call,) = s3.delete_objects.call_args_list
        assert call.kwargs['Delete']['Quiet'] is True
        assert call.kwargs['Delete']['Objects'][0] == {'Key': f'ws/{WS}/raw/0', 'VersionId': 'v1'}
        assert len(call.kwargs['Delete']['Objects']) == VERSIONS_PAGE

    def test_what_s3_did_not_delete_is_answered(self):
        s3 = MagicMock()
        s3.delete_objects.return_value = {'Errors': [{'Key': f'ws/{WS}/raw/a', 'VersionId': 'v1', 'Code': 'SlowDown'}]}
        (failure,) = WorkspaceObjectVersions(A, s3, BUCKET).delete([ObjectVersion(f'ws/{WS}/raw/a', 'v1')])
        assert (failure.key, failure.version_id, failure.code) == (f'ws/{WS}/raw/a', 'v1', 'SlowDown')

    def test_needs_its_bucket(self):
        with pytest.raises(ValueError, match='bucket'):
            WorkspaceObjectVersions(A, MagicMock(), '')

    def test_lists_and_aborts_the_open_uploads_of_the_workspace_only(self, bucket):
        mine = bucket.create_multipart_upload(Bucket=BUCKET, Key=f'ws/{WS}/raw/s3_import/big.csv')['UploadId']
        bucket.create_multipart_upload(Bucket=BUCKET, Key=f'ws/{OTHER_WS}/raw/s3_import/big.csv')
        objects = WorkspaceObjectVersions(A, bucket, BUCKET)

        assert objects.open_uploads() == [(f'ws/{WS}/raw/s3_import/big.csv', mine)]
        objects.abort_upload(f'ws/{WS}/raw/s3_import/big.csv', mine)
        objects.abort_upload(f'ws/{WS}/raw/s3_import/big.csv', mine)  # gone already: done

        assert objects.open_uploads() == []
        others = bucket.list_multipart_uploads(Bucket=BUCKET).get('Uploads') or []
        assert [upload['Key'] for upload in others] == [f'ws/{OTHER_WS}/raw/s3_import/big.csv']

    def test_the_open_uploads_page_by_their_markers(self):
        s3 = MagicMock()
        s3.list_multipart_uploads.side_effect = [
            {'Uploads': [{'Key': f'ws/{WS}/a', 'UploadId': 'u1'}], 'IsTruncated': True,
             'NextKeyMarker': f'ws/{WS}/a', 'NextUploadIdMarker': 'u1'},
            {'Uploads': [{'Key': f'ws/{WS}/b', 'UploadId': 'u2'}], 'IsTruncated': False},
        ]
        assert WorkspaceObjectVersions(A, s3, BUCKET).open_uploads() == [(f'ws/{WS}/a', 'u1'), (f'ws/{WS}/b', 'u2')]
        assert s3.list_multipart_uploads.call_args_list[1].kwargs == {
            'Bucket': BUCKET, 'Prefix': f'ws/{WS}/', 'KeyMarker': f'ws/{WS}/a', 'UploadIdMarker': 'u1'}

    def test_an_upload_of_another_workspace_is_refused_before_any_abort(self):
        s3 = MagicMock()
        s3.list_multipart_uploads.return_value = {'Uploads': [{'Key': f'ws/{OTHER_WS}/a', 'UploadId': 'u1'}]}
        objects = WorkspaceObjectVersions(A, s3, BUCKET)
        with pytest.raises(OutOfScopeError):
            objects.open_uploads()
        with pytest.raises(OutOfScopeError):
            objects.abort_upload(f'ws/{OTHER_WS}/a', 'u1')
        s3.abort_multipart_upload.assert_not_called()

    def test_any_other_abort_failure_propagates(self):
        s3 = MagicMock()
        s3.abort_multipart_upload.side_effect = _failure('AccessDenied', 'AbortMultipartUpload')
        with pytest.raises(ClientError):
            WorkspaceObjectVersions(A, s3, BUCKET).abort_upload(f'ws/{WS}/a', 'u1')


@pytest.fixture
def control():
    with mock_aws():
        yield create_pk_sk_table('voc-workspaces')


def _rows(table) -> set[tuple[str, str]]:
    return {(item['pk'], item['sk']) for item in table.scan()['Items']}


class TestTheControlRowDeletes:
    def test_each_deletes_its_one_row_of_this_workspace(self, control):
        rows = [
            {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-1'}, {'pk': 'USER#sub-1', 'sk': f'WS#{WS}'},
            {'pk': 'FORM#form-1', 'sk': 'META', 'workspace_id': WS}, {'pk': 'PLUGIN#webscraper', 'sk': f'WS#{WS}'},
            {'pk': 'WORKSPACES', 'sk': f'acme outfitters#{WS}', 'workspace_id': WS},
            {'pk': f'WS#{WS}', 'sk': 'META', 'status': 'deleting'},
        ]
        kept = [
            {'pk': f'AUDIT#WS#{WS}', 'sk': '2026-11-14#a'},
            {'pk': f'WS#{OTHER_WS}', 'sk': 'MEMBER#sub-1'}, {'pk': 'USER#sub-1', 'sk': f'WS#{OTHER_WS}'},
            {'pk': 'PLUGIN#webscraper', 'sk': f'WS#{OTHER_WS}'}, {'pk': 'SLUG#acme', 'sk': 'META', 'workspace_id': WS},
        ]
        for row in rows + kept:
            control.put_item(Item=row)
        deletes = WorkspaceControlRows(A, control)

        deletes.delete_partition_row('MEMBER#sub-1')
        deletes.delete_user_row('sub-1')
        deletes.delete_form_lookup('form-1')
        deletes.delete_plugin_row('webscraper')
        deletes.delete_listing_row(f'acme outfitters#{WS}')
        deletes.delete_meta()

        assert _rows(control) == {(row['pk'], row['sk']) for row in kept}

    def test_a_row_already_gone_is_done(self, control):
        deletes = WorkspaceControlRows(A, control)
        deletes.delete_partition_row('MEMBER#sub-1')
        deletes.delete_form_lookup('form-1')
        deletes.delete_listing_row(f'acme outfitters#{WS}')
        deletes.delete_meta()
        assert _rows(control) == set()

    @pytest.mark.parametrize('status', ['active', 'paused', None])
    def test_meta_goes_only_while_it_reads_deleting(self, control, status):
        control.put_item(Item={'pk': f'WS#{WS}', 'sk': 'META', **({'status': status} if status else {})})
        with pytest.raises(OutOfScopeError, match='not being deleted'):
            WorkspaceControlRows(A, control).delete_meta()
        assert _rows(control) == {(f'WS#{WS}', 'META')}

    def test_a_form_of_another_workspace_is_refused_and_kept(self, control):
        control.put_item(Item={'pk': 'FORM#form-1', 'sk': 'META', 'workspace_id': OTHER_WS})
        with pytest.raises(OutOfScopeError, match='another workspace'):
            WorkspaceControlRows(A, control).delete_form_lookup('form-1')
        assert _rows(control) == {('FORM#form-1', 'META')}

    def test_a_listing_row_naming_another_workspace_is_refused_and_kept(self, control):
        control.put_item(Item={'pk': 'WORKSPACES', 'sk': f'acme#{WS}', 'workspace_id': OTHER_WS})
        with pytest.raises(OutOfScopeError):
            WorkspaceControlRows(A, control).delete_listing_row(f'acme#{WS}')
        assert _rows(control) == {('WORKSPACES', f'acme#{WS}')}

    @pytest.mark.parametrize('sort_key', [f'acme#{OTHER_WS}', f'#{WS}', WS, '', f'acme#{WS}#x', None])
    def test_a_listing_sort_key_not_ending_with_this_workspace_after_a_name_is_refused(self, sort_key):
        table = MagicMock()
        with pytest.raises(OutOfScopeError, match='listing row'):
            WorkspaceControlRows(A, table).delete_listing_row(sort_key)
        table.delete_item.assert_not_called()

    @pytest.mark.parametrize('sort_key', ['META', '', None])
    def test_a_partition_row_is_any_but_meta(self, sort_key):
        table = MagicMock()
        with pytest.raises(ValueError, match='other than META'):
            WorkspaceControlRows(A, table).delete_partition_row(sort_key)
        table.delete_item.assert_not_called()

    def test_a_partition_row_is_always_in_this_workspaces_partition(self):
        table = MagicMock()
        WorkspaceControlRows(A, table).delete_partition_row(f'INVITE#x#WS#{OTHER_WS}')
        table.delete_item.assert_called_once_with(Key={'pk': f'WS#{WS}', 'sk': f'INVITE#x#WS#{OTHER_WS}'})

    @pytest.mark.parametrize('method', ['delete_user_row', 'delete_form_lookup'])
    @pytest.mark.parametrize('part', ['', 'sub#WS', '#', None])
    def test_a_part_that_could_reach_another_key_shape_is_refused(self, method, part):
        table = MagicMock()
        with pytest.raises(ValueError, match='plain'):
            getattr(WorkspaceControlRows(A, table), method)(part)
        table.delete_item.assert_not_called()

    @pytest.mark.parametrize('plugin', ['', 'Web-Scraper', 'web#scraper', '../x'])
    def test_a_plugin_row_needs_a_plugin_id(self, plugin):
        table = MagicMock()
        with pytest.raises(ValueError, match='plugin'):
            WorkspaceControlRows(A, table).delete_plugin_row(plugin)
        table.delete_item.assert_not_called()

    def test_any_other_failure_propagates(self):
        table = MagicMock()
        table.delete_item.side_effect = _failure('ThrottlingException', 'DeleteItem')
        table.update_item.side_effect = _failure('ThrottlingException', 'UpdateItem')
        rows = WorkspaceControlRows(A, table)
        for call in (lambda: rows.delete_form_lookup('form-1'), rows.delete_meta,
                     lambda: rows.mark_slug_deleted('acme', '2026-11-14T00:00:00+00:00')):
            with pytest.raises(ClientError):
                call()


class TestTheSlugGuard:
    def test_is_kept_and_marked_deleted_once(self, control):
        control.put_item(Item={'pk': 'SLUG#acme', 'sk': 'META', 'workspace_id': WS, 'created_at': '2026-01-01'})
        rows = WorkspaceControlRows(A, control)

        rows.mark_slug_deleted('acme', '2026-11-14T10:00:00+00:00')
        rows.mark_slug_deleted('acme', '2026-11-15T10:00:00+00:00')  # a resumed job keeps the first time

        assert control.get_item(Key={'pk': 'SLUG#acme', 'sk': 'META'})['Item'] == {
            'pk': 'SLUG#acme', 'sk': 'META', 'workspace_id': WS, 'created_at': '2026-01-01',
            'deleted_at': '2026-11-14T10:00:00+00:00'}

    @pytest.mark.parametrize('stored', [{'workspace_id': OTHER_WS}, None])
    def test_another_workspaces_slug_or_none_is_refused(self, control, stored):
        if stored is not None:
            control.put_item(Item={'pk': 'SLUG#acme', 'sk': 'META', **stored})
        with pytest.raises(OutOfScopeError, match='slug'):
            WorkspaceControlRows(A, control).mark_slug_deleted('acme', '2026-11-14T10:00:00+00:00')
        assert (control.get_item(Key={'pk': 'SLUG#acme', 'sk': 'META'}).get('Item') or {}).get('deleted_at') is None

    def test_needs_a_plain_slug(self):
        table = MagicMock()
        with pytest.raises(ValueError, match='plain slug'):
            WorkspaceControlRows(A, table).mark_slug_deleted('acme#x', '2026-11-14')
        table.update_item.assert_not_called()


class TestTheTombstones:
    def test_the_key_names_the_workspace_in_its_sort_key(self):
        assert workspace_tombstone_key(A, 'web', 'f1') == {'pk': 'AUDIT#tombstone#web', 'sk': f'{WS}#f1'}
        assert workspace_tombstone_key(B, 'web', 'f1') != workspace_tombstone_key(A, 'web', 'f1')

    @pytest.mark.parametrize(('kind', 'item_id'), [('', 'f1'), ('web', '')])
    def test_a_key_needs_a_kind_and_an_id(self, kind, item_id):
        with pytest.raises(ValueError, match='tombstone key'):
            workspace_tombstone_key(A, kind, item_id)

    @pytest.mark.parametrize('item', [
        {'pk': 'AUDIT#tombstone#web', 'sk': f'{OTHER_WS}#f1'},  # another workspace's tombstone
        {'pk': 'AUDIT#workspace-deletes', 'sk': f'{WS}#f1'},  # not a tombstone partition
        {'pk': f'WS#{WS}#SOURCE#web', 'sk': f'{WS}#f1'},
    ])
    def test_the_views_tombstone_put_refuses_anything_but_its_own_tombstones(self, control, item):
        with pytest.raises(OutOfScopeError, match='not a tombstone of the workspace'):
            ws_table(A, control).put_new_tombstone(item)

    def test_a_new_tombstone_is_written_once_and_an_existing_one_kept(self, control):
        tombstones = WorkspaceTombstones(ws_table(A, control))

        first = tombstones.put_new('web', 'f1', {'mode': 'workspace_delete', 'deleted_at': '2026-11-14'})
        assert first is None
        # An erasure's tombstone of the same item, written first, is never overwritten: the put answers it.
        control.put_item(Item={**workspace_tombstone_key(A, 'web', 'f2'), 'mode': 'erase', 'run_id': 'r1'})
        over_an_erasures = tombstones.put_new('web', 'f2', {'mode': 'workspace_delete'})
        again = tombstones.put_new('web', 'f1', {'mode': 'workspace_delete', 'deleted_at': 'later'})
        assert ((over_an_erasures or {}).get('run_id'), (again or {}).get('deleted_at')) == ('r1', '2026-11-14')

        assert control.get_item(Key=workspace_tombstone_key(A, 'web', 'f1'))['Item'] == {
            'pk': 'AUDIT#tombstone#web', 'sk': f'{WS}#f1', 'mode': 'workspace_delete', 'deleted_at': '2026-11-14',
            'workspace_id': WS}
        assert control.get_item(Key=workspace_tombstone_key(A, 'web', 'f2'))['Item']['mode'] == 'erase'

    @pytest.mark.parametrize('field', ['pk', 'sk', 'workspace_id'])
    def test_the_caller_never_names_the_key_or_the_workspace(self, field):
        table = MagicMock()
        with pytest.raises(OutOfScopeError, match='builds its own'):
            WorkspaceTombstones(ws_table(A, table)).put_new('web', 'f1', {field: 'x'})
        table.put_item.assert_not_called()

    def test_any_other_failure_propagates(self):
        table = MagicMock()
        table.put_item.side_effect = _failure('ThrottlingException', 'PutItem')
        with pytest.raises(ClientError):
            WorkspaceTombstones(ws_table(A, table)).put_new('web', 'f1', {})


def test_the_work_partition_is_the_workspaces_own():
    assert delete_work_pk(A) == f'WS#{WS}#DELETE#PARTITIONS'
    assert A.owns(delete_work_pk(A))
    assert not B.owns(delete_work_pk(A))
