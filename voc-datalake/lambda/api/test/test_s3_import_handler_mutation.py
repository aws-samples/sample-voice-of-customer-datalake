"""Mutation hardening for `api/s3_import_handler.py`.

`test_s3_import_handler.py` drives every `/s3-import/*` route once and checks the shape of
the answer (`'error' in body`, `len(files) == 2`, `put_object.assert_called_once()`). A mutation
run found what it could not see:

* the WORDING of every refusal — `'S3 import bucket not configured'`, `'Source name is
  required'`, `'Filename is required'`, `'Only CSV, JSON, and JSONL files are supported'`, the
  four `'Failed to …'` service errors — and the log line each S3 failure leaves behind;
* the exact S3 calls: `list_objects_v2(Bucket, Delimiter='/')`, the `list_objects_v2`
  paginator with `Prefix='<source>/'` (or `''`), `put_object(Key='<name>/', Body=b'')`, the
  presigned `put_object` URL with its `ContentType` and `ExpiresIn=7200`, the decoded
  `delete_object` key;
* the sanitising: a source/folder name keeps only `[a-zA-Z0-9_-]`, a filename also keeps `.`,
  each refused character becomes ONE `_`; names and filenames are stripped first;
* the file listing: every page is read, only `.csv` / `.json` / `.jsonl` keys are listed, a
  `processed/` key is listed (as `processed`) only on `include_processed=true` in any case, a
  root key's source is `root`, the filename is the LAST segment, a row with no `Size` /
  `LastModified` answers `0` / `''`, a row with no `Key` is skipped;
* the module state: the bucket comes from `S3_IMPORT_BUCKET` (default `''`), the Lambda root is
  put FIRST on `sys.path`, every route is the tracer's wrapper, the handler carries `api_handler`.
"""
from __future__ import annotations

import os
import sys
import urllib.parse
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from types import ModuleType
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route
from module_reload_fixtures import reload_cycle

import s3_import_handler as h
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped

BUCKET = 'test-bucket'
NOT_CONFIGURED = 'S3 import bucket not configured'
STAMP = datetime(2026, 3, 10, 12, 0, 0, tzinfo=UTC)


def _missing(operation: str = 'HeadObject') -> ClientError:
    """What `head_object` raises for a key that holds nothing."""
    return ClientError({'Error': {'Code': '404', 'Message': 'Not Found'}}, operation)


@pytest.fixture
def s3() -> Iterator[MagicMock]:
    """The module's S3 client, with the bucket configured and every key free (`head_object` 404s)."""
    with patch.object(h, 's3_client') as client, patch.object(h, 'S3_IMPORT_BUCKET', BUCKET):
        client.head_object.side_effect = _missing()
        yield client


@pytest.fixture
def no_bucket() -> Iterator[MagicMock]:
    """No bucket configured; the client is a mock that must never be called."""
    with patch.object(h, 's3_client') as client, patch.object(h, 'S3_IMPORT_BUCKET', ''):
        yield client


@pytest.fixture
def log() -> Iterator[MagicMock]:
    with patch.object(h, 'logger') as logger:
        yield logger


def _route(api_gateway_event, lambda_context, method: str, path: str, **kwargs) -> tuple[int, dict]:
    response, body = call_route(h.lambda_handler, api_gateway_event, lambda_context,
                                method=method, path=path, **kwargs)
    return response['statusCode'], body


def _pages(s3: MagicMock, *pages: dict) -> MagicMock:
    """The paginator yields exactly `pages` (an exhaustible list, never a `return_value` loop)."""
    paginator = MagicMock()
    paginator.paginate.side_effect = [list(pages)]
    s3.get_paginator.return_value = paginator
    return paginator


def _obj(key: str, size: int = 10) -> dict:
    return {'Key': key, 'Size': size, 'LastModified': STAMP}


def _files(api_gateway_event, lambda_context, query: dict | None = None) -> tuple[int, dict]:
    return _route(api_gateway_event, lambda_context, 'GET', '/s3-import/files', query_params=query)


def _upload(api_gateway_event, lambda_context, body: dict) -> tuple[int, dict]:
    return _route(api_gateway_event, lambda_context, 'POST', '/s3-import/upload-url', body=body)


# ============================================
# Module state
# ============================================

class TestTheColdStartModuleState:
    @pytest.fixture
    def reload_with_env(self, monkeypatch) -> Iterator[Callable[..., ModuleType]]:
        yield from reload_cycle(monkeypatch, h)

    def test_the_bucket_is_read_from_the_environment(self, reload_with_env):
        assert reload_with_env(S3_IMPORT_BUCKET='voc-imports-bucket').S3_IMPORT_BUCKET == 'voc-imports-bucket'

    def test_an_unset_bucket_is_the_empty_string(self, reload_with_env):
        assert reload_with_env(S3_IMPORT_BUCKET=None).S3_IMPORT_BUCKET == ''

    def test_the_client_is_the_shared_s3_client(self, reload_with_env):
        with patch('shared.aws.get_s3_client') as factory:
            module = reload_with_env(S3_IMPORT_BUCKET=None)
        assert module.s3_client is factory.return_value

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(h.__file__)))
        sentinel = os.path.join(os.sep, 'somewhere-else-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env(S3_IMPORT_BUCKET=None)
        assert sys.path[:2] == [lambda_root, sentinel]


class TestEveryEntryPointIsInstrumented:
    @pytest.mark.parametrize('route', ['list_sources', 'create_source', 'list_files', 'get_upload_url', 'delete_file'])
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(h, route)

    def test_the_handler_carries_its_decorator(self):
        assert_handler_wrapped(h)


# ============================================
# No bucket configured
# ============================================

class TestWithoutABucket:
    def test_the_listings_answer_empty_with_no_bucket(self, no_bucket, api_gateway_event, lambda_context):
        assert _route(api_gateway_event, lambda_context, 'GET', '/s3-import/sources') == (
            200, {'sources': [], 'bucket': None})
        assert _files(api_gateway_event, lambda_context) == (200, {'files': [], 'bucket': None})
        assert no_bucket.mock_calls == []

    @pytest.mark.parametrize(('method', 'path', 'kwargs'), [
        ('POST', '/s3-import/sources', {'body': {'name': 'web'}}),
        ('POST', '/s3-import/upload-url', {'body': {'filename': 'data.json'}}),
        ('DELETE', '/s3-import/file/data.json', {'path_params': {'key': 'data.json'}}),
    ])
    def test_every_write_is_refused_as_not_configured(self, no_bucket, api_gateway_event, lambda_context,
                                                      method, path, kwargs):
        assert _route(api_gateway_event, lambda_context, method, path, **kwargs) == (
            500, {'success': False, 'error': NOT_CONFIGURED})
        assert no_bucket.mock_calls == []


# ============================================
# GET /s3-import/sources
# ============================================

class TestListSources:
    def test_lists_every_top_level_folder_but_processed(self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'CommonPrefixes': [
            {'Prefix': 'webscraper/'}, {'Prefix': 'processed/'}, {'Prefix': 'INBOX/'}, {},
        ]}
        assert _route(api_gateway_event, lambda_context, 'GET', '/s3-import/sources') == (200, {
            'sources': [
                {'name': 'webscraper', 'display_name': 'S3 - webscraper'},
                {'name': 'INBOX', 'display_name': 'S3 - INBOX'},
                {'name': '', 'display_name': 'S3 - '},
            ],
            'bucket': BUCKET,
        })
        s3.list_objects_v2.assert_called_once_with(Bucket=BUCKET, Delimiter='/')

    def test_an_empty_bucket_has_no_sources(self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {}
        assert _route(api_gateway_event, lambda_context, 'GET', '/s3-import/sources') == (
            200, {'sources': [], 'bucket': BUCKET})

    def test_an_s3_failure_is_a_named_service_error_and_logged(self, s3, log, api_gateway_event, lambda_context):
        s3.list_objects_v2.side_effect = RuntimeError('S3 down')
        assert _route(api_gateway_event, lambda_context, 'GET', '/s3-import/sources') == (
            500, {'success': False, 'error': 'Failed to list sources'})
        assert call('Failed to list S3 sources: S3 down') in log.exception.call_args_list


# ============================================
# POST /s3-import/sources
# ============================================

class TestCreateSource:
    @pytest.mark.parametrize(('name', 'safe'), [
        ('  new-source  ', 'new-source'),
        ('Ab_9-z', 'Ab_9-z'),
        ('my source!.@', 'my_source___'),
    ])
    def test_creates_the_sanitised_folder_marker(self, s3, api_gateway_event, lambda_context, name, safe):
        assert _route(api_gateway_event, lambda_context, 'POST', '/s3-import/sources', body={'name': name}) == (
            200, {'success': True, 'source': {'name': safe, 'display_name': f'S3 - {safe}'}})
        s3.put_object.assert_called_once_with(Bucket=BUCKET, Key=f'{safe}/', Body=b'')

    @pytest.mark.parametrize('body', [{'name': '   '}, {'other': 'x'}])
    def test_a_missing_or_blank_name_is_refused(self, s3, api_gateway_event, lambda_context, body):
        assert _route(api_gateway_event, lambda_context, 'POST', '/s3-import/sources', body=body) == (
            400, {'success': False, 'error': 'Source name is required'})
        assert s3.put_object.call_count == 0

    def test_an_s3_failure_is_a_named_service_error_and_logged(self, s3, log, api_gateway_event, lambda_context):
        s3.put_object.side_effect = RuntimeError('denied')
        assert _route(api_gateway_event, lambda_context, 'POST', '/s3-import/sources', body={'name': 'web'}) == (
            500, {'success': False, 'error': 'Failed to create source folder'})
        assert call('Failed to create source folder: denied') in log.exception.call_args_list


# ============================================
# GET /s3-import/files
# ============================================

class TestListFiles:
    def test_every_page_is_read_and_only_importable_extensions_are_listed(self, s3, api_gateway_event, lambda_context):
        paginator = _pages(
            s3,
            {'Contents': [_obj('web/a.csv', 1), _obj('web/b.txt'), _obj('web/'), {'Size': 3}, _obj('web/e.csv')]},
            {},
            {'Contents': [_obj('web/c.json', 2), _obj('web/d.jsonl', 3)]},
        )
        status, body = _files(api_gateway_event, lambda_context, {'source': 'web'})
        assert status == 200
        # A skipped row skips only itself: `web/e.csv` after three skipped rows is still listed.
        assert [f['key'] for f in body['files']] == ['web/a.csv', 'web/e.csv', 'web/c.json', 'web/d.jsonl']
        assert body['bucket'] == BUCKET
        s3.get_paginator.assert_called_once_with('list_objects_v2')
        paginator.paginate.assert_called_once_with(Bucket=BUCKET, Prefix='web/')

    def test_without_a_source_the_whole_bucket_is_listed(self, s3, api_gateway_event, lambda_context):
        paginator = _pages(s3, {'Contents': []})
        assert _files(api_gateway_event, lambda_context) == (200, {'files': [], 'bucket': BUCKET})
        paginator.paginate.assert_called_once_with(Bucket=BUCKET, Prefix='')

    def test_each_row_is_described_field_by_field(self, s3, api_gateway_event, lambda_context):
        _pages(s3, {'Contents': [_obj('web/2026/deep.json', 42), _obj('top.csv', 7), {'Key': 'bare.jsonl'}]})
        assert _files(api_gateway_event, lambda_context)[1]['files'] == [
            {'key': 'web/2026/deep.json', 'filename': 'deep.json', 'source': 'web', 'size': 42,
             'last_modified': '2026-03-10T12:00:00+00:00', 'status': 'pending'},
            {'key': 'top.csv', 'filename': 'top.csv', 'source': 'root', 'size': 7,
             'last_modified': '2026-03-10T12:00:00+00:00', 'status': 'pending'},
            {'key': 'bare.jsonl', 'filename': 'bare.jsonl', 'source': 'root', 'size': 0,
             'last_modified': '', 'status': 'pending'},
        ]

    @pytest.mark.parametrize('query', [{}, {'include_processed': 'false'}, {'include_processed': 'yes'}])
    def test_processed_files_are_hidden_unless_asked_for(self, s3, api_gateway_event, lambda_context, query):
        _pages(s3, {'Contents': [_obj('processed/old.csv'), _obj('web/new.csv')]})
        assert [f['key'] for f in _files(api_gateway_event, lambda_context, query)[1]['files']] == ['web/new.csv']

    @pytest.mark.parametrize('flag', ['true', 'TRUE', 'True'])
    def test_include_processed_true_in_any_case_lists_them_as_processed(self, s3, api_gateway_event,
                                                                         lambda_context, flag):
        _pages(s3, {'Contents': [_obj('processed/old.csv', 5)]})
        assert _files(api_gateway_event, lambda_context, {'include_processed': flag})[1]['files'] == [
            {'key': 'processed/old.csv', 'filename': 'old.csv', 'source': 'processed', 'size': 5,
             'last_modified': '2026-03-10T12:00:00+00:00', 'status': 'processed'},
        ]

    def test_an_s3_failure_is_a_named_service_error_and_logged(self, s3, log, api_gateway_event, lambda_context):
        s3.get_paginator.side_effect = RuntimeError('throttled')
        assert _files(api_gateway_event, lambda_context) == (500, {'success': False, 'error': 'Failed to list files'})
        assert call('Failed to list S3 files: throttled') in log.exception.call_args_list


# ============================================
# POST /s3-import/upload-url
# ============================================

class TestUploadUrl:
    def test_presigns_a_two_hour_put_under_the_sanitised_key(self, s3, api_gateway_event, lambda_context):
        s3.generate_presigned_url.return_value = 'https://s3.example.com/presigned'
        body = {'filename': ' my file (1).csv ', 'source': ' web site! ', 'content_type': 'text/csv'}
        assert _upload(api_gateway_event, lambda_context, body) == (200, {
            'success': True, 'upload_url': 'https://s3.example.com/presigned',
            'key': 'web_site_/my_file__1_.csv', 'bucket': BUCKET, 'expires_in': 7200,
            'upload_headers': {'Content-Type': 'text/csv', 'If-None-Match': '*'},
        })
        s3.head_object.assert_called_once_with(Bucket=BUCKET, Key='web_site_/my_file__1_.csv')
        s3.generate_presigned_url.assert_called_once_with(
            'put_object',
            Params={'Bucket': BUCKET, 'Key': 'web_site_/my_file__1_.csv', 'ContentType': 'text/csv',
                    'IfNoneMatch': '*'},
            ExpiresIn=7200,
        )

    def test_the_source_and_content_type_have_defaults(self, s3, api_gateway_event, lambda_context):
        status, body = _upload(api_gateway_event, lambda_context, {'filename': 'Data_v1-2.jsonl'})
        assert (status, body['key']) == (200, 'default/Data_v1-2.jsonl')
        s3.generate_presigned_url.assert_called_once_with(
            'put_object',
            Params={'Bucket': BUCKET, 'Key': 'default/Data_v1-2.jsonl', 'ContentType': 'application/octet-stream',
                    'IfNoneMatch': '*'},
            ExpiresIn=7200,
        )

    def test_an_existing_file_is_never_overwritten(self, s3, api_gateway_event, lambda_context):
        """No re-upload flow exists (the ingestor re-ingests every object-created event): 409, no URL."""
        s3.head_object.side_effect = None
        assert _upload(api_gateway_event, lambda_context, {'filename': 'a.csv', 'source': 'web'}) == (409, {
            'success': False, 'error': 'A file named web/a.csv already exists. Delete it first to upload it again.',
        })
        assert s3.generate_presigned_url.call_count == 0

    def test_an_unreadable_existence_check_is_a_service_error_not_an_upload(self, s3, log, api_gateway_event,
                                                                           lambda_context):
        s3.head_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'x'}}, 'HeadObject')
        assert _upload(api_gateway_event, lambda_context, {'filename': 'a.csv'}) == (
            500, {'success': False, 'error': 'Failed to generate upload URL'})
        assert s3.generate_presigned_url.call_count == 0
        assert log.exception.call_count == 1

    def test_the_reserved_processed_folder_is_not_an_upload_target(self, s3, api_gateway_event, lambda_context):
        status, body = _upload(api_gateway_event, lambda_context, {'filename': 'a.csv', 'source': 'processed'})
        assert (status, body['error']) == (400, '"processed" is reserved; choose another source folder')
        assert s3.mock_calls == []

    @pytest.mark.usefixtures('s3')
    @pytest.mark.parametrize('filename', ['a.csv', 'a.json', 'a.jsonl'])
    def test_every_importable_extension_is_accepted(self, api_gateway_event, lambda_context, filename):
        assert _upload(api_gateway_event, lambda_context, {'filename': filename, 'source': 's'})[1]['key'] == (
            f's/{filename}')

    @pytest.mark.parametrize('body', [{'filename': '  '}, {'source': 'web'}])
    def test_a_missing_or_blank_filename_is_refused(self, s3, api_gateway_event, lambda_context, body):
        assert _upload(api_gateway_event, lambda_context, body) == (
            400, {'success': False, 'error': 'Filename is required'})
        assert s3.generate_presigned_url.call_count == 0

    @pytest.mark.parametrize('filename', ['data.txt', 'data.csv.exe', 'data.xlsx'])
    def test_any_other_extension_is_refused(self, s3, api_gateway_event, lambda_context, filename):
        assert _upload(api_gateway_event, lambda_context, {'filename': filename}) == (
            400, {'success': False, 'error': 'Only CSV, JSON, and JSONL files are supported'})
        assert s3.generate_presigned_url.call_count == 0

    def test_an_s3_failure_is_a_named_service_error_and_logged(self, s3, log, api_gateway_event, lambda_context):
        s3.generate_presigned_url.side_effect = RuntimeError('no creds')
        assert _upload(api_gateway_event, lambda_context, {'filename': 'a.csv'}) == (
            500, {'success': False, 'error': 'Failed to generate upload URL'})
        assert call('Failed to generate upload URL: no creds') in log.exception.call_args_list


# ============================================
# DELETE /s3-import/file/<key>
# ============================================

class TestDeleteFile:
    def test_deletes_the_url_decoded_key(self, s3, api_gateway_event, lambda_context):
        status, body = _route(api_gateway_event, lambda_context, 'DELETE', '/s3-import/file/web%2Fmy%20data.json',
                              path_params={'key': 'web%2Fmy%20data.json'})
        assert (status, body) == (200, {'success': True, 'deleted_key': 'web/my data.json'})
        s3.delete_object.assert_called_once_with(Bucket=BUCKET, Key='web/my data.json')

    def test_an_s3_failure_is_a_named_service_error_and_logged(self, s3, log, api_gateway_event, lambda_context):
        s3.delete_object.side_effect = RuntimeError('locked')
        assert _route(api_gateway_event, lambda_context, 'DELETE', '/s3-import/file/web%2Fa.csv',
                      path_params={'key': 'web%2Fa.csv'}) == (500, {'success': False, 'error': 'Failed to delete file'})
        assert call('Failed to delete file: locked') in log.exception.call_args_list

    @pytest.mark.parametrize('key', [
        'web/a.csv', 'web/a.json', 'web/a.jsonl', 'my-src_2/Data v1.csv',
    ])
    def test_a_staged_file_under_a_source_folder_is_deletable(self, s3, api_gateway_event, lambda_context, key):
        encoded = urllib.parse.quote(key, safe='')
        status, body = _route(api_gateway_event, lambda_context, 'DELETE', f'/s3-import/file/{encoded}',
                              path_params={'key': encoded})
        assert (status, body) == (200, {'success': True, 'deleted_key': key})
        s3.delete_object.assert_called_once_with(Bucket=BUCKET, Key=key)

    @pytest.mark.parametrize('key', [
        'a.csv',                    # root level: not under a source folder
        '/web/a.csv',               # leading slash
        'web/../other/a.csv',       # traversal
        'web/..csv',                # any `..`
        '../a.csv',
        'processed/a.csv',          # the reserved prefix is never deleted here
        'processed/web/a.csv',
        'web/sub/a.csv',            # deeper than <source>/<file>
        'web/',                     # a folder marker
        'web/a.txt',                # not an importable file
        'web/a.CSV.exe',
        'we b/a.csv',               # not a source-folder name
        'web/a\\b.csv',             # backslash
        'web/a\x00.csv',            # control character
        'web/a\t.csv',
    ])
    def test_a_key_outside_the_import_layout_is_refused_before_any_s3_call(self, s3, api_gateway_event,
                                                                         lambda_context, key):
        encoded = urllib.parse.quote(key, safe='')
        status, body = _route(api_gateway_event, lambda_context, 'DELETE', f'/s3-import/file/{encoded}',
                              path_params={'key': encoded})
        assert (status, body) == (400, {'success': False, 'error': h.INVALID_KEY})
        assert s3.delete_object.call_count == 0
