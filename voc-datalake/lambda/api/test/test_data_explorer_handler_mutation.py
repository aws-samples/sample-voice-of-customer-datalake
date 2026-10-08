"""Mutation hardening for `api/data_explorer_handler.py`.

`test_data_explorer_handler.py` pins the shape of each route (a 200 here, a 403
there, `IfNoneMatch='*'` on a raw put) and `test_data_explorer_category_edit.py`
pins the category move against moto. A mutation run found what neither can see:

* the WORDING of every refusal and of every success message — the 400/404/409/500
  bodies are what the admin reads in the Data Explorer, and the earlier tests
  checked `'error' in body` or a substring that an `XX…XX` mutant still contains;
* the exact S3 and SQS calls: `Delimiter='/'`, `MaxKeys=500` / `100`, the
  presigned URL's `ExpiresIn=3600`, the 1 MiB preview cut (`== 1048576` reads
  whole, `== 1048577` reads `bytes=0-1048575` and appends the marker), the
  `ContentType='application/json'`, the `s3_raw_uri` stamped on the queued copy;
* the listing: folder entries (`size 0`, empty `lastModified`, `isFolder True`),
  the prefix's own marker object skipped, folders before files, case-insensitive;
* the DynamoDB write: every editable field by name, floats as `Decimal`, the
  `updated_at` clause, the strong read, the GSI query, the existence condition;
* the category edit's own branches: an unchanged category is "No changes", a
  subcategory-only edit keeps the category, `category` / `subcategory` wording in
  the 400s, the aggregates-table 500;
* the cold-start state: the bucket catalogue and the `''` defaults the module
  takes when the environment names nothing.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError, EndpointConnectionError
from category_access_fixtures import CATEGORIES_CONFIG
from handler_events_fixtures import call_route, table_behind
from module_reload_fixtures import reload_cycle
from moto import mock_aws
from moto_helpers import CATEGORY_EDIT_ADMIN_CLAIMS as ADMIN_CLAIMS
from moto_helpers import CATEGORY_EDIT_ITEM as ITEM
from moto_helpers import invoke, rest_event, seeded_category_edit_tables

import data_explorer_handler as h
from shared.test.instrumentation_fixtures import assert_handler_wrapped, assert_tracer_wrapped
from shared.test.source_profile_fixtures import no_source_profiles

_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)

BUCKET = 'test-raw-data-bucket'
QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue'
MIB = 1024 * 1024


def _get(api_gateway_event, lambda_context, path, **query):
    return call_route(h.lambda_handler, api_gateway_event, lambda_context,
                      method='GET', path=path, query_params=query or None)


def _put(api_gateway_event, lambda_context, path, body):
    return call_route(h.lambda_handler, api_gateway_event, lambda_context,
                      method='PUT', path=path, body=body)


def _client_error(code: str, operation: str = 'PutObject') -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'm'}}, operation)


# ============================================
# Module state
# ============================================

class TestTheColdStartModuleState:
    def test_the_bucket_catalogue_is_the_raw_bucket_from_the_environment(self):
        assert h.AVAILABLE_BUCKETS == {
            'raw-data': {
                'name': BUCKET,
                'label': 'VoC Raw Data',
                'description': 'Raw feedback data from all sources',
            },
        }
        assert (h.RAW_DATA_BUCKET, h.FEEDBACK_TABLE, h.PROCESSING_QUEUE_URL) == (
            BUCKET, 'test-feedback', QUEUE_URL)
        assert h.RAW_PREFIX == 'raw/'
        assert frozenset({'PreconditionFailed', 'ConditionalRequestConflict'}) == h._OBJECT_EXISTS_ERROR_CODES
        assert h._IMAGE_EXTENSIONS == ('jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico')
        assert h._MAX_PREVIEW_BYTES == 1048576
        assert h._TRUNCATION_MARKER == '\n\n... [truncated - file too large]'
        assert h.UPDATABLE_FEEDBACK_FIELDS == (
            'original_text', 'normalized_text',
            'sentiment_label', 'sentiment_score', 'urgency', 'impact_area',
            'problem_summary', 'problem_root_cause_hypothesis', 'persona_name',
            'persona_type', 'journey_stage', 'rating',
        )
        assert h.CATEGORY_FIELDS == ('category', 'subcategory')

    @pytest.fixture
    def reload_with_env(self, monkeypatch):
        yield from reload_cycle(monkeypatch, h)

    def test_nothing_in_the_environment_means_empty_names_and_no_browsable_bucket(self, reload_with_env):
        module = reload_with_env(RAW_DATA_BUCKET=None, FEEDBACK_TABLE=None, PROCESSING_QUEUE_URL=None)
        assert (module.RAW_DATA_BUCKET, module.FEEDBACK_TABLE, module.PROCESSING_QUEUE_URL) == ('', '', '')
        assert module.AVAILABLE_BUCKETS['raw-data']['name'] == ''

    def test_the_names_are_read_from_their_own_variables(self, reload_with_env):
        module = reload_with_env(RAW_DATA_BUCKET='b-1', FEEDBACK_TABLE='t-1', PROCESSING_QUEUE_URL='q-1')
        assert (module.RAW_DATA_BUCKET, module.FEEDBACK_TABLE, module.PROCESSING_QUEUE_URL) == ('b-1', 't-1', 'q-1')
        assert module.AVAILABLE_BUCKETS['raw-data']['name'] == 'b-1'

    def test_the_lambda_root_is_put_ahead_of_whatever_was_first_on_sys_path(self, reload_with_env):
        lambda_root = os.path.dirname(os.path.dirname(os.path.abspath(h.__file__)))
        sentinel = os.path.join(os.sep, 'somewhere-else-with-its-own-shared')
        sys.path[:] = [sentinel] + [entry for entry in sys.path if entry != lambda_root]
        reload_with_env(RAW_DATA_BUCKET=BUCKET)
        assert sys.path[:2] == [lambda_root, sentinel]
        assert os.path.isdir(os.path.join(lambda_root, 'shared'))


# ============================================
# Request helpers
# ============================================

class TestKeyedBucketRequestNamesItsRefusal:
    def test_a_known_configured_bucket_and_a_key_resolve(self):
        assert h._keyed_bucket_request({'bucket': 'raw-data', 'key': 'raw/a.json'}) == (BUCKET, 'raw/a.json')

    def test_the_bucket_defaults_to_raw_data(self):
        assert h._keyed_bucket_request({'key': 'raw/a.json'}) == (BUCKET, 'raw/a.json')

    @pytest.mark.parametrize('request_', [{'bucket': 'nope', 'key': 'a'}, {'bucket': '', 'key': 'a'}])
    def test_an_unknown_bucket_is_a_deployment_problem(self, request_):
        with pytest.raises(h.ConfigurationError) as info:
            h._keyed_bucket_request(request_)
        assert str(info.value) == 'Bucket not configured'
        assert info.value.status_code == 500

    def test_an_unconfigured_bucket_is_a_deployment_problem(self):
        with patch.dict(h.AVAILABLE_BUCKETS, {'raw-data': {'name': ''}}), \
                pytest.raises(h.ConfigurationError, match=r'^Bucket not configured$'):
            h._keyed_bucket_request({'key': 'a'})

    @pytest.mark.parametrize('request_', [{}, {'key': ''}, {'bucket': 'raw-data'}])
    def test_a_missing_key_is_the_callers_problem(self, request_):
        with pytest.raises(h.ValidationError) as info:
            h._keyed_bucket_request(request_)
        assert str(info.value) == 'File key is required'
        assert info.value.status_code == 400

    def test_the_bucket_is_checked_before_the_key(self):
        with pytest.raises(h.ConfigurationError):
            h._keyed_bucket_request({'bucket': 'nope'})


class TestPrototypeGuard:
    def test_a_prototype_key_is_refused_with_the_exact_wording(self):
        with pytest.raises(h.ValidationError) as info:
            h._reject_prototype_mutation('prototypes/p1/x.html')
        assert str(info.value) == 'Generated prototypes are read-only in Data Explorer'

    @pytest.mark.parametrize('key', ['raw/prototypes/x', 'prototype/x', 'Prototypes/x', ''])
    def test_only_the_prototypes_prefix_itself_is_read_only(self, key):
        assert h._reject_prototype_mutation(key) is None

    @pytest.mark.parametrize(('key', 'is_raw'), [
        ('raw/a.json', True), ('raw/', True), ('raw', False), ('Raw/a', False), ('imports/raw/a', False),
    ])
    def test_a_raw_key_starts_with_the_raw_prefix(self, key, is_raw):
        assert h._is_raw_key(key) is is_raw


# ============================================
# GET /data-explorer/s3
# ============================================

class TestListingAnS3Prefix:
    @pytest.fixture
    def s3(self):
        with patch.object(h, 's3_client') as mock:
            yield mock

    def test_the_bucket_defaults_to_raw_data_and_the_listing_call_is_exact(
            self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {}
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3')
        assert response['statusCode'] == 200
        assert body == {'objects': [], 'bucket': BUCKET, 'bucketId': 'raw-data',
                        'bucketLabel': 'VoC Raw Data', 'prefix': ''}
        s3.list_objects_v2.assert_called_once_with(Bucket=BUCKET, Prefix='', Delimiter='/', MaxKeys=500)

    @pytest.mark.parametrize('prefix', ['raw/webscraper', '/raw/webscraper/', 'raw/webscraper///'])
    def test_the_prefix_is_normalised_to_one_trailing_slash(
            self, s3, prefix, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', bucket='raw-data', prefix=prefix)
        assert s3.list_objects_v2.call_args.kwargs['Prefix'] == 'raw/webscraper/'
        assert body['prefix'] == 'raw/webscraper'

    def test_an_unknown_bucket_answers_without_touching_s3(self, s3, api_gateway_event, lambda_context):
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', bucket='nope', prefix='raw')
        assert response['statusCode'] == 200
        assert body == {'objects': [], 'bucket': None, 'bucketId': 'nope', 'prefix': '',
                        'error': 'Bucket not configured'}
        s3.list_objects_v2.assert_not_called()

    def test_a_folder_entry_is_its_last_path_segment_with_no_size_or_date(
            self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'CommonPrefixes': [{'Prefix': 'raw/webscraper/2026/'}]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw/webscraper')
        assert body['objects'] == [{'key': '2026', 'size': 0, 'lastModified': '', 'isFolder': True}]

    def test_only_the_slash_is_stripped_from_a_prefix_or_folder_name(self, s3, api_gateway_event, lambda_context):
        """A segment that starts or ends with 'X' keeps it (the strip set is exactly '/')."""
        s3.list_objects_v2.return_value = {'CommonPrefixes': [{'Prefix': 'XBOX/XBOX/'}]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='XBOX')
        assert s3.list_objects_v2.call_args.kwargs['Prefix'] == 'XBOX/'
        assert body['prefix'] == 'XBOX'
        assert body['objects'][0]['key'] == 'XBOX'

    def test_a_common_prefix_without_a_prefix_field_reads_as_an_unnamed_folder(
            self, s3, api_gateway_event, lambda_context):
        # S3 always sends `Prefix`; the default only keeps a malformed page from being a 500.
        s3.list_objects_v2.return_value = {'CommonPrefixes': [{}]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3')
        assert body['objects'] == [{'key': '', 'size': 0, 'lastModified': '', 'isFolder': True}]

    def test_a_content_entry_without_a_key_is_skipped(self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'Contents': [{}, {'Size': 3}]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw')
        assert body['objects'] == []

    def test_a_file_entry_carries_its_full_key_size_and_iso_date(self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'Contents': [
            {'Key': 'raw/webscraper/a.json', 'Size': 512, 'LastModified': datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)},
        ]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw/webscraper')
        assert body['objects'] == [{
            'key': 'a.json', 'fullKey': 'raw/webscraper/a.json', 'size': 512,
            'lastModified': '2026-01-02T03:04:05+00:00', 'isFolder': False,
        }]

    def test_a_file_without_size_or_date_reads_as_zero_bytes_and_no_date(
            self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'Contents': [{'Key': 'raw/a.json'}]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw')
        assert body['objects'] == [
            {'key': 'a.json', 'fullKey': 'raw/a.json', 'size': 0, 'lastModified': '', 'isFolder': False}]

    def test_the_prefix_marker_object_and_folder_markers_are_skipped_but_later_files_kept(
            self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {'Contents': [
            {'Key': 'raw/webscraper/', 'Size': 0},          # the prefix itself
            {'Key': 'raw/webscraper/sub/', 'Size': 0},      # a folder marker (no filename)
            {'Key': 'raw/webscraper/b.json', 'Size': 1},
        ]}
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw/webscraper')
        assert [o['key'] for o in body['objects']] == ['b.json']

    def test_folders_come_first_then_files_each_sorted_case_insensitively(
            self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.return_value = {
            'CommonPrefixes': [{'Prefix': 'raw/zeta/'}, {'Prefix': 'raw/Alpha/'}, {'Prefix': 'raw/beta/'}],
            'Contents': [{'Key': 'raw/b.json'}, {'Key': 'raw/A.json'}, {'Key': 'raw/c.json'}],
        }
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3', prefix='raw')
        assert [(o['key'], o['isFolder']) for o in body['objects']] == [
            ('Alpha', True), ('beta', True), ('zeta', True),
            ('A.json', False), ('b.json', False), ('c.json', False),
        ]

    def test_an_s3_failure_is_a_500_with_a_fixed_message(self, s3, api_gateway_event, lambda_context):
        s3.list_objects_v2.side_effect = _client_error('AccessDenied', 'ListObjectsV2')
        with patch.object(h.logger, 'exception') as log:
            response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3')
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to list S3 objects'}
        log.assert_any_call('Failed to list S3 objects')


# ============================================
# GET /data-explorer/s3/preview
# ============================================

class TestBinaryDetection:
    @pytest.mark.parametrize(('key', 'ext'), [
        ('raw/a.PNG', 'png'), ('raw/a.jpg.json', 'json'), ('raw/noext', ''), ('raw/png', ''), ('', ''), ('a.', ''),
    ])
    def test_the_extension_is_the_lower_cased_text_after_the_last_dot_or_empty(self, key, ext):
        assert h._extension(key) == ext

    @pytest.mark.parametrize('ext', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf'])
    def test_each_binary_extension_is_recognised_whatever_the_content_type_says(self, ext):
        assert h._is_binary_object(f'raw/file.{ext}', 'application/octet-stream') is True

    @pytest.mark.parametrize('ext', ['PNG', 'Pdf', 'JPG'])
    def test_the_extension_is_matched_case_insensitively(self, ext):
        assert h._is_binary_object(f'raw/file.{ext}', 'text/plain') is True

    @pytest.mark.parametrize('content_type', ['image/png', 'image/x-anything', 'application/pdf'])
    def test_an_image_or_pdf_content_type_is_binary_without_an_extension(self, content_type):
        assert h._is_binary_object('raw/noext', content_type) is True

    @pytest.mark.parametrize(('key', 'content_type'), [
        ('raw/a.json', 'application/json'),
        ('raw/noext', 'application/octet-stream'),
        ('raw/a.txt', 'text/plain'),
        ('raw/png', 'text/plain'),               # no dot: 'png' is the whole name, not an extension
        ('raw/a.jpg.json', 'text/plain'),        # only the last segment is the extension
        ('raw/a.bin', 'application/pdfx'),       # pdf is an exact match, not a prefix
        ('raw/a.bin', 'imagex/png'),             # image/ is a prefix match
    ])
    def test_everything_else_is_text(self, key, content_type):
        assert h._is_binary_object(key, content_type) is False


class TestPreviewingAnObject:
    @pytest.fixture
    def s3(self):
        with patch.object(h, 's3_client') as mock:
            mock.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})
            yield mock

    @staticmethod
    def _text(s3, payload: bytes, size: int | None = None, content_type: str | None = 'application/json'):
        head: dict[str, object] = {'ContentLength': len(payload) if size is None else size}
        if content_type is not None:
            head['ContentType'] = content_type
        s3.head_object.return_value = head
        body = MagicMock()
        body.read.return_value = payload
        s3.get_object.return_value = {'Body': body}

    def test_a_json_object_is_returned_parsed_with_its_metadata(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'{"a": 1}')
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.json')
        assert response['statusCode'] == 200
        assert body == {'content': {'a': 1}, 'size': 8, 'contentType': 'application/json', 'key': 'raw/a.json'}
        s3.head_object.assert_called_once_with(Bucket=BUCKET, Key='raw/a.json')
        s3.get_object.assert_called_once_with(Bucket=BUCKET, Key='raw/a.json')
        s3.generate_presigned_url.assert_not_called()

    def test_text_that_is_not_json_is_returned_verbatim(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'hello\nworld', content_type='text/plain')
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        assert body['content'] == 'hello\nworld'
        assert body['contentType'] == 'text/plain'

    def test_a_missing_content_type_is_reported_as_octet_stream(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'x', content_type=None)
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        assert body['contentType'] == 'application/octet-stream'
        assert body['content'] == 'x'

    def test_undecodable_bytes_become_replacement_characters_not_a_500(
            self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'ok\xff', content_type='text/plain')
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        assert response['statusCode'] == 200
        assert body['content'] == 'ok\ufffd'

    def test_exactly_one_mib_is_read_whole(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'{"a": 1}', size=MIB, content_type='text/plain')
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        s3.get_object.assert_called_once_with(Bucket=BUCKET, Key='raw/a.txt')
        assert body['content'] == {'a': 1}
        assert body['size'] == MIB

    def test_one_byte_over_a_mib_reads_the_first_mib_and_marks_the_cut(
            self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'first part', size=MIB + 1, content_type='text/plain')
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        s3.get_object.assert_called_once_with(Bucket=BUCKET, Key='raw/a.txt', Range='bytes=0-1048575')
        assert body['content'] == 'first part\n\n... [truncated - file too large]'
        assert body['size'] == MIB + 1

    def test_a_truncated_read_still_decodes_leniently(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'ok\xff', size=MIB + 1, content_type='text/plain')
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.txt')
        assert body['content'] == 'ok\ufffd\n\n... [truncated - file too large]'

    def test_a_truncated_object_whose_read_part_is_json_is_parsed(self, s3, api_gateway_event, lambda_context):
        self._text(s3, b'{"a": 1}', size=MIB + 1)
        _, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.json')
        assert body['content'] == {'a': 1}

    def test_a_binary_object_is_a_one_hour_presigned_url_and_is_never_read(
            self, s3, api_gateway_event, lambda_context):
        s3.head_object.return_value = {'ContentLength': 50_000, 'ContentType': 'image/png'}
        s3.generate_presigned_url.return_value = 'https://signed.example/x.png'
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/x.png')
        assert response['statusCode'] == 200
        assert body == {'content': 'https://signed.example/x.png', 'size': 50_000,
                        'contentType': 'image/png', 'key': 'raw/x.png', 'isPresignedUrl': True}
        s3.generate_presigned_url.assert_called_once_with(
            'get_object', Params={'Bucket': BUCKET, 'Key': 'raw/x.png'}, ExpiresIn=3600)
        s3.get_object.assert_not_called()

    def test_a_missing_key_is_a_400_before_any_s3_call(self, s3, api_gateway_event, lambda_context):
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', bucket='raw-data')
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'File key is required'}
        assert s3.mock_calls == []

    def test_an_unknown_bucket_is_a_500_before_any_s3_call(self, s3, api_gateway_event, lambda_context):
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', bucket='x', key='k')
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Bucket not configured'}
        assert s3.mock_calls == []

    def test_a_missing_object_is_a_404_with_the_exact_wording(self, s3, api_gateway_event, lambda_context):
        s3.head_object.side_effect = s3.exceptions.NoSuchKey()
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/none.json')
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'File not found'}

    def test_any_other_failure_is_a_500_with_a_fixed_message(self, s3, api_gateway_event, lambda_context):
        s3.head_object.side_effect = _client_error('AccessDenied', 'HeadObject')
        with patch.object(h.logger, 'exception') as log:
            response, body = _get(api_gateway_event, lambda_context, '/data-explorer/s3/preview', key='raw/a.json')
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to preview file'}
        log.assert_any_call('Failed to preview S3 file')


class TestDecodedPreviewContent:
    @pytest.mark.parametrize(('content', 'expected'), [
        ('{"a": [1, 2]}', {'a': [1, 2]}),
        ('[1]', [1]),
        ('"s"', 's'),
        ('not json', 'not json'),
        ('', ''),
        ('{"a": 1}' + h._TRUNCATION_MARKER, {'a': 1}),
        ('{"a": 1, "b": ' + h._TRUNCATION_MARKER, '{"a": 1, "b": ' + h._TRUNCATION_MARKER),
        ('text' + h._TRUNCATION_MARKER, 'text' + h._TRUNCATION_MARKER),
    ])
    def test_json_is_parsed_up_to_the_cut_and_anything_else_is_returned_as_is(self, content, expected):
        assert h._decoded_preview_content(content) == expected


# ============================================
# PUT /data-explorer/s3
# ============================================

class TestSavingAnObject:
    @pytest.fixture
    def s3(self):
        with patch.object(h, 's3_client') as mock:
            mock.put_object.return_value = {}
            yield mock

    @pytest.fixture
    def sqs(self):
        with patch.object(h, 'sqs_client') as mock:
            mock.send_message.return_value = {}
            yield mock

    def test_a_dict_is_written_as_two_space_indented_json(self, s3, sqs, api_gateway_event, lambda_context):
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {
            'key': 'imports/a.json', 'content': {'b': 1, 'a': [1, 2]},
        })
        assert response['statusCode'] == 200
        assert body == {'success': True, 'message': 'File saved', 'key': 'imports/a.json', 'synced': False}
        s3.put_object.assert_called_once_with(
            Bucket=BUCKET, Key='imports/a.json', Body=b'{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}',
            ContentType='application/json')
        sqs.send_message.assert_not_called()

    @pytest.mark.usefixtures('sqs')
    def test_a_string_is_written_as_utf8_bytes(self, s3, api_gateway_event, lambda_context):
        _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'key': 'imports/a.txt', 'content': 'héllo'})
        assert s3.put_object.call_args.kwargs['Body'] == 'héllo'.encode()

    @pytest.mark.usefixtures('sqs')
    def test_no_content_writes_an_empty_object(self, s3, api_gateway_event, lambda_context):
        response, _ = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'key': 'imports/a.txt'})
        assert response['statusCode'] == 200
        assert s3.put_object.call_args.kwargs['Body'] == b''

    @pytest.mark.parametrize('content', [5, [1], True, None])
    def test_anything_but_a_string_or_object_is_refused_before_s3(
            self, s3, content, api_gateway_event, lambda_context):
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                              {'key': 'imports/a.json', 'content': content})
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'content must be a string or a JSON object'}
        s3.put_object.assert_not_called()

    def test_a_raw_key_adds_the_conditional_create_and_nothing_else(self, s3, api_gateway_event, lambda_context):
        _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'key': 'raw/a.json', 'content': 'x'})
        s3.put_object.assert_called_once_with(
            Bucket=BUCKET, Key='raw/a.json', Body=b'x', ContentType='application/json', IfNoneMatch='*')

    def test_the_prototype_refusal_and_the_missing_key_refusal_are_worded_exactly(
            self, s3, api_gateway_event, lambda_context):
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                              {'key': 'prototypes/p/x.html', 'content': 'x'})
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'Generated prototypes are read-only in Data Explorer'}
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'content': 'x'})
        assert response['statusCode'] == 400
        assert body == {'success': False, 'error': 'File key is required'}
        s3.put_object.assert_not_called()

    def test_an_existing_raw_object_is_a_409_with_the_exact_wording(self, s3, api_gateway_event, lambda_context):
        s3.put_object.side_effect = _client_error('PreconditionFailed')
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'key': 'raw/a', 'content': 'x'})
        assert response['statusCode'] == 409
        assert body == {'success': False,
                        'error': 'Raw data is immutable: an object already exists at this key under raw/'}

    @pytest.mark.parametrize('code', ['PreconditionFailed', 'ConditionalRequestConflict'])
    def test_outside_raw_the_same_codes_are_an_ordinary_500(self, s3, code, api_gateway_event, lambda_context):
        s3.put_object.side_effect = _client_error(code)
        with patch.object(h.logger, 'exception') as log:
            response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                                  {'key': 'imports/a', 'content': 'x'})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to save file'}
        log.assert_any_call('Failed to save S3 file')

    @pytest.mark.parametrize('error', [
        pytest.param(ClientError({'Error': {}}, 'PutObject'), id='client-error-without-a-code'),
        pytest.param(EndpointConnectionError(endpoint_url='https://s3'), id='non-client-failure'),
    ])
    def test_any_other_failure_under_raw_is_a_500_that_hides_its_cause(
        self, s3, error, api_gateway_event, lambda_context,
    ):
        s3.put_object.side_effect = error
        response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {'key': 'raw/a', 'content': 'x'})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to save file'}

    @pytest.mark.usefixtures('s3')
    def test_sync_queues_the_parsed_object_stamped_with_its_s3_uri(self, sqs, api_gateway_event, lambda_context):
        with patch.object(h.logger, 'info') as info:
            response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3', {
                'key': 'raw/webscraper/a.json', 'content': {'feedback_id': 'f1', 'text': 't'}, 'sync_to_dynamo': True,
            })
        assert response['statusCode'] == 200
        assert body == {'success': True, 'message': 'File saved', 'key': 'raw/webscraper/a.json', 'synced': True}
        sqs.send_message.assert_called_once_with(
            QueueUrl=QUEUE_URL,
            MessageBody=json.dumps({'feedback_id': 'f1', 'text': 't', 'pii_policy_applied': 'allow',
                                    's3_raw_uri': f's3://{BUCKET}/raw/webscraper/a.json'}),
        )
        info.assert_any_call('Sent new raw object to the processing queue')

    @pytest.mark.usefixtures('s3')
    def test_sync_defaults_to_the_raw_data_bucket_when_none_is_named(self, sqs, api_gateway_event, lambda_context):
        _, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                       {'key': 'raw/a.json', 'content': '{"a": 1}', 'sync_to_dynamo': True})
        assert body['synced'] is True
        sqs.send_message.assert_called_once()

    @pytest.mark.usefixtures('s3')
    def test_without_the_flag_nothing_is_queued(self, sqs, api_gateway_event, lambda_context):
        _, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                       {'key': 'raw/a.json', 'content': '{"a": 1}', 'sync_to_dynamo': False})
        assert body['synced'] is False
        sqs.send_message.assert_not_called()

    @pytest.mark.usefixtures('s3')
    def test_without_a_queue_url_nothing_is_queued(self, sqs, api_gateway_event, lambda_context):
        with patch.object(h, 'PROCESSING_QUEUE_URL', ''):
            _, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                           {'key': 'raw/a.json', 'content': '{"a": 1}', 'sync_to_dynamo': True})
        assert body['synced'] is False
        sqs.send_message.assert_not_called()

    def test_another_bucket_is_never_synced(self, s3, sqs, api_gateway_event, lambda_context):
        with patch.dict(h.AVAILABLE_BUCKETS, {'other': {'name': 'other-bucket', 'label': 'Other'}}):
            _, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                           {'bucket': 'other', 'key': 'raw/a.json', 'content': '{"a": 1}', 'sync_to_dynamo': True})
        assert body == {'success': True, 'message': 'File saved', 'key': 'raw/a.json', 'synced': False}
        assert s3.put_object.call_args.kwargs['Bucket'] == 'other-bucket'
        sqs.send_message.assert_not_called()

    @pytest.mark.parametrize('content', ['not json', '[1, 2]', '"s"'])
    def test_a_body_that_is_not_a_json_object_saves_but_does_not_sync(
            self, s3, sqs, content, api_gateway_event, lambda_context):
        with patch.object(h.logger, 'warning') as warning:
            response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                                  {'key': 'raw/a.json', 'content': content, 'sync_to_dynamo': True})
        assert response['statusCode'] == 200
        assert body['synced'] is False
        s3.put_object.assert_called_once()
        sqs.send_message.assert_not_called()
        warning.assert_called_once()
        assert warning.call_args.args[0].startswith('Failed to sync to DynamoDB: ')

    @pytest.mark.usefixtures('s3')
    def test_a_queue_failure_saves_but_reports_not_synced(self, sqs, api_gateway_event, lambda_context):
        sqs.send_message.side_effect = _client_error('QueueDoesNotExist', 'SendMessage')
        with patch.object(h.logger, 'warning') as warning:
            response, body = _put(api_gateway_event, lambda_context, '/data-explorer/s3',
                                  {'key': 'raw/a.json', 'content': '{"a": 1}', 'sync_to_dynamo': True})
        assert response['statusCode'] == 200
        assert body['synced'] is False
        warning.assert_called_once_with(f'Failed to sync to DynamoDB: {sqs.send_message.side_effect!s}')


# ============================================
# PUT /data-explorer/feedback — mocked table
# ============================================

ISO = '2026-02-03T04:05:06+00:00'


class TestTheFeedbackWrite:
    @pytest.fixture
    def table(self):
        with patch.object(h, 'dynamodb') as resource:
            table = table_behind(resource)
            table.get_item.return_value = {'Item': {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'category': 'delivery'}}
            table.update_item.return_value = {}
            yield resource, table

    @pytest.fixture
    def frozen_now(self):
        with patch.object(h, 'datetime') as dt:
            dt.now.return_value.isoformat.return_value = ISO
            yield dt

    def _save(self, api_gateway_event, lambda_context, data, feedback_id='f1', **extra):
        return _put(api_gateway_event, lambda_context, '/data-explorer/feedback',
                    {'feedback_id': feedback_id, 'data': data, **extra})

    def test_a_plain_edit_is_one_conditional_update_with_updated_at(
            self, table, frozen_now, api_gateway_event, lambda_context):
        resource, mock_table = table
        response, body = self._save(api_gateway_event, lambda_context,
                                    {'source_platform': 'web', 'original_text': 'edited'})
        assert response['statusCode'] == 200
        assert body == {'success': True, 'message': 'Feedback updated'}
        resource.Table.assert_called_once_with('test-feedback')
        mock_table.get_item.assert_called_once_with(
            Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}, ConsistentRead=True)
        mock_table.query.assert_not_called()
        mock_table.update_item.assert_called_once_with(
            Key={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'},
            UpdateExpression='SET #original_text = :original_text, #updated_at = :updated_at',
            ConditionExpression=Attr('pk').exists(),
            ExpressionAttributeNames={'#original_text': 'original_text', '#updated_at': 'updated_at'},
            ExpressionAttributeValues={':original_text': 'edited', ':updated_at': ISO},
        )
        frozen_now.now.assert_called_once_with(UTC)

    def test_updated_at_is_an_aware_utc_iso_timestamp(self, table, api_gateway_event, lambda_context):
        self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 5})
        stamp = table[1].update_item.call_args.kwargs['ExpressionAttributeValues'][':updated_at']
        parsed = datetime.fromisoformat(stamp)
        assert parsed.tzinfo is not None
        offset = parsed.utcoffset()
        assert offset is not None
        assert offset.total_seconds() == 0
        assert abs((datetime.now(UTC) - parsed).total_seconds()) < 60

    @pytest.mark.parametrize('field', h.UPDATABLE_FEEDBACK_FIELDS)
    def test_each_editable_field_is_written_under_its_own_name(self, table, field, api_gateway_event, lambda_context):
        response, _ = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', field: 'v'})
        assert response['statusCode'] == 200
        kwargs = table[1].update_item.call_args.kwargs
        assert kwargs['UpdateExpression'] == f'SET #{field} = :{field}, #updated_at = :updated_at'
        assert kwargs['ExpressionAttributeNames'][f'#{field}'] == field
        assert kwargs['ExpressionAttributeValues'][f':{field}'] == 'v'

    def test_fields_are_written_in_catalogue_order_and_floats_become_decimals(
            self, table, api_gateway_event, lambda_context):
        self._save(api_gateway_event, lambda_context, {
            'source_platform': 'web', 'rating': 4, 'sentiment_score': 0.85, 'urgency': 'high', 'ignored': 'x',
        })
        kwargs = table[1].update_item.call_args.kwargs
        assert kwargs['UpdateExpression'] == (
            'SET #sentiment_score = :sentiment_score, #urgency = :urgency, #rating = :rating, '
            '#updated_at = :updated_at')
        values = kwargs['ExpressionAttributeValues']
        assert values[':sentiment_score'] == Decimal('0.85')
        assert isinstance(values[':sentiment_score'], Decimal)
        assert values[':rating'] == 4
        assert isinstance(values[':rating'], int)
        assert values[':urgency'] == 'high'
        assert ':ignored' not in values

    def test_without_a_source_platform_the_key_comes_from_the_by_id_index(
            self, table, api_gateway_event, lambda_context):
        mock_table = table[1]
        mock_table.query.return_value = {'Items': [{'pk': 'SOURCE#x', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1'}]}
        mock_table.get_item.return_value = {'Item': {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#f1'}}
        response, _ = self._save(api_gateway_event, lambda_context, {'original_text': 'x'})
        assert response['statusCode'] == 200
        mock_table.query.assert_called_once_with(
            IndexName='gsi4-by-feedback-id',
            KeyConditionExpression='feedback_id = :fid',
            ExpressionAttributeValues={':fid': 'f1'},
            Limit=1,
        )
        mock_table.get_item.assert_called_once_with(Key={'pk': 'SOURCE#x', 'sk': 'FEEDBACK#f1'}, ConsistentRead=True)
        assert mock_table.update_item.call_args.kwargs['Key'] == {'pk': 'SOURCE#x', 'sk': 'FEEDBACK#f1'}

    @pytest.mark.parametrize('answer', [{}, {'Items': []}, {'Items': None}])
    def test_an_id_the_index_does_not_know_is_a_404(self, table, answer, api_gateway_event, lambda_context):
        table[1].query.return_value = answer
        response, body = self._save(api_gateway_event, lambda_context, {'original_text': 'x'})
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'Feedback not found'}
        table[1].update_item.assert_not_called()

    @pytest.mark.parametrize('answer', [{}, {'Item': None}, {'Item': {}}])
    def test_a_key_with_no_item_behind_it_is_a_404(self, table, answer, api_gateway_event, lambda_context):
        table[1].get_item.return_value = answer
        response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 1})
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'Feedback not found'}
        table[1].update_item.assert_not_called()

    def test_a_vanished_item_at_write_time_is_a_404_not_a_409(self, table, api_gateway_event, lambda_context):
        table[1].update_item.side_effect = _client_error('ConditionalCheckFailedException', 'UpdateItem')
        response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 1})
        assert response['statusCode'] == 404
        assert body == {'success': False, 'error': 'Feedback not found'}

    def test_a_failed_read_is_a_500_that_hides_the_aws_detail(self, table, api_gateway_event, lambda_context):
        table[1].get_item.side_effect = RuntimeError('boom')
        with patch.object(h.logger, 'exception') as log:
            response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 1})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Failed to update feedback'}
        log.assert_any_call('Failed to read feedback')
        table[1].update_item.assert_not_called()

    def test_an_api_error_from_the_read_keeps_its_own_status(self, table, api_gateway_event, lambda_context):
        table[1].get_item.side_effect = h.ConflictError('taken')
        response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 1})
        assert response['statusCode'] == 409
        assert body == {'success': False, 'error': 'taken'}

    @pytest.mark.parametrize(('body', 'message'), [
        ({'data': {'original_text': 'x'}}, 'Feedback ID is required'),
        ({'feedback_id': '', 'data': {'original_text': 'x'}}, 'Feedback ID is required'),
        ({'feedback_id': 'f1', 'data': 'text'}, 'data must be an object'),
        ({'feedback_id': 'f1', 'data': ['original_text']}, 'data must be an object'),
        ({'feedback_id': 'f1', 'data': {}}, 'No fields to update'),
        ({'feedback_id': 'f1'}, 'No fields to update'),
        ({'feedback_id': 'f1', 'data': {'source_platform': 'web', 'text': 'x', 'pk': 'p'}}, 'No fields to update'),
    ])
    def test_every_refusal_names_its_cause_before_any_table_call(
            self, table, body, message, api_gateway_event, lambda_context):
        response, answer = _put(api_gateway_event, lambda_context, '/data-explorer/feedback', body)
        assert response['statusCode'] == 400
        assert answer == {'success': False, 'error': message}
        assert table[0].mock_calls == []

    def test_a_category_key_alone_counts_as_a_field_to_update(self, table, api_gateway_event, lambda_context):
        """`category` is not in UPDATABLE_FEEDBACK_FIELDS; the gate must still let it through."""
        table[1].get_item.return_value = {'Item': {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'category': 'delivery'}}
        response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'category': 'delivery'})
        assert response['statusCode'] == 200
        assert body == {'success': True, 'message': 'No changes'}
        table[1].update_item.assert_not_called()

    def test_an_unconfigured_feedback_table_is_a_500(self, table, api_gateway_event, lambda_context):
        with patch.object(h, 'FEEDBACK_TABLE', ''):
            response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'rating': 1})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Feedback table not configured'}
        assert table[0].mock_calls == []

    def test_an_unconfigured_aggregates_table_is_a_500_on_a_category_change(
            self, table, api_gateway_event, lambda_context):
        with patch.object(h, 'get_aggregates_table', return_value=None):
            response, body = self._save(api_gateway_event, lambda_context, {'source_platform': 'web', 'category': 'billing'})
        assert response['statusCode'] == 500
        assert body == {'success': False, 'error': 'Aggregates table not configured'}
        table[1].update_item.assert_not_called()


# ============================================
# PUT /data-explorer/feedback — category edit against moto
# ============================================

CONFIG_WITH_SUBS = {
    **CATEGORIES_CONFIG,
    'categories': [
        {'name': 'delivery', 'subcategories': [{'name': 'late'}, {'name': 'damaged'}]},
        {'name': 'billing', 'subcategories': [{'name': 'refund'}]},
        {'name': 'app'},
    ],
}


class TestTheCategoryEditBranches:
    @pytest.fixture
    def tables(self):
        with mock_aws():
            feedback, aggregates = seeded_category_edit_tables(ITEM, CONFIG_WITH_SUBS)
            with patch.object(h, 'dynamodb', boto3.resource('dynamodb', region_name='us-east-1')), \
                    patch.object(h, 'FEEDBACK_TABLE', 'feedback'):
                yield feedback, aggregates

    @staticmethod
    def _save(tables, lambda_context, data, feedback_id='f1'):
        event = rest_event('PUT', '/data-explorer/feedback', claims=ADMIN_CLAIMS,
                           body={'feedback_id': feedback_id, 'data': data})
        return invoke(h, event, lambda_context, aggregates=tables[1])

    @staticmethod
    def _stored(tables):
        return tables[0].get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})['Item']

    def test_the_same_category_without_a_subcategory_key_is_no_change_at_all(self, tables, lambda_context):
        status, body = self._save(tables, lambda_context, {'category': 'delivery'})
        assert (status, body) == (200, {'success': True, 'message': 'No changes'})
        assert self._stored(tables) == ITEM

    def test_the_same_category_and_subcategory_is_no_change_at_all(self, tables, lambda_context):
        status, body = self._save(tables, lambda_context, {'category': 'delivery', 'subcategory': 'late'})
        assert (status, body) == (200, {'success': True, 'message': 'No changes'})
        assert self._stored(tables) == ITEM

    def test_a_subcategory_only_edit_keeps_the_category_and_is_a_manual_change(self, tables, lambda_context):
        status, body = self._save(tables, lambda_context, {'subcategory': 'damaged'})
        assert (status, body) == (200, {'success': True, 'message': 'Feedback updated'})
        stored = self._stored(tables)
        assert stored['category'] == 'delivery'
        assert stored['subcategory'] == 'damaged'
        assert stored['gsi2pk'] == 'CATEGORY#delivery'
        assert stored['category_source'] == 'manual'
        assert stored['category_override']['previous_subcategory'] == 'late'

    def test_a_new_category_without_a_subcategory_key_drops_the_old_subcategory(self, tables, lambda_context):
        status, body = self._save(tables, lambda_context, {'category': 'app'})
        assert (status, body) == (200, {'success': True, 'message': 'Feedback updated'})
        stored = self._stored(tables)
        assert stored['category'] == 'app'
        assert 'subcategory' not in stored
        assert stored['gsi2pk'] == 'CATEGORY#app'

    def test_a_new_category_with_one_of_its_subcategories_moves_both(self, tables, lambda_context):
        status, _ = self._save(tables, lambda_context, {'category': 'billing', 'subcategory': ' refund '})
        assert status == 200
        stored = self._stored(tables)
        assert (stored['category'], stored['subcategory']) == ('billing', 'refund')

    def test_a_category_change_and_a_plain_edit_land_in_one_write(self, tables, lambda_context):
        status, _ = self._save(tables, lambda_context, {'category': 'app', 'original_text': 'edited', 'rating': 2.5})
        assert status == 200
        stored = self._stored(tables)
        assert (stored['category'], stored['original_text'], stored['rating']) == ('app', 'edited', Decimal('2.5'))
        assert 'updated_at' in stored

    @pytest.mark.parametrize(('data', 'message'), [
        ({'category': ''}, 'category is required'),
        ({'category': None}, 'category is required'),
        ({'category': 'c' * 65}, 'category must be a string of 1-64 characters'),
        ({'category': 7}, 'category must be a string of 1-64 characters'),
        ({'category': 'billing', 'subcategory': 's' * 65}, 'subcategory must be a string of 1-64 characters'),
        ({'category': 'nope'}, 'category is not a configured category'),
        ({'category': 'billing', 'subcategory': 'late'}, 'subcategory does not belong to this category'),
        ({'subcategory': 'refund'}, 'subcategory does not belong to this category'),
    ])
    def test_every_category_refusal_names_the_field_and_leaves_the_item_alone(
            self, tables, lambda_context, data, message):
        status, body = self._save(tables, lambda_context, data)
        assert (status, body) == (400, {'success': False, 'error': message})
        assert self._stored(tables) == ITEM

    def test_a_concurrent_change_is_the_shared_409_wording(self, tables, lambda_context):
        real_read = h._stored_item

        def read_then_recategorise(table, key):
            item = real_read(table, key)
            tables[0].update_item(Key=key, UpdateExpression='SET category = :c',
                                  ExpressionAttributeValues={':c': 'app'})
            return item

        with patch.object(h, '_stored_item', side_effect=read_then_recategorise):
            status, body = self._save(tables, lambda_context, {'category': 'billing'})
        assert (status, body) == (409, {'success': False,
                                        'error': 'This review was changed by someone else. Reload and retry.'})

    def test_a_vanished_item_on_a_plain_edit_is_the_404_wording(self, tables, lambda_context):
        real_read = h._stored_item

        def read_then_delete(table, key):
            item = real_read(table, key)
            tables[0].delete_item(Key=key)
            return item

        with patch.object(h, '_stored_item', side_effect=read_then_delete):
            status, body = self._save(tables, lambda_context, {'original_text': 'x'})
        assert (status, body) == (404, {'success': False, 'error': 'Feedback not found'})


class TestRequestedCategory:
    ITEM_WITH: ClassVar[dict[str, object]] = {'category': 'delivery', 'subcategory': 'late'}

    @pytest.mark.parametrize('data', [{}, {'original_text': 'x'}, {'source_platform': 'web'}])
    def test_no_category_key_means_no_request(self, data):
        assert h._requested_category(self.ITEM_WITH, data) is None

    @pytest.mark.parametrize('data', [
        {'category': 'delivery'},
        {'category': ' delivery ', 'subcategory': 'late'},
        {'category': 'delivery', 'subcategory': ' late '},
    ])
    def test_the_current_pair_is_not_a_request(self, data):
        assert h._requested_category(self.ITEM_WITH, data) is None

    @pytest.mark.parametrize(('item', 'data', 'expected'), [
        (ITEM_WITH, {'category': 'billing'}, ('billing', None)),
        (ITEM_WITH, {'category': 'billing', 'subcategory': 'refund'}, ('billing', 'refund')),
        (ITEM_WITH, {'category': 'delivery', 'subcategory': ''}, ('delivery', None)),
        (ITEM_WITH, {'category': 'delivery', 'subcategory': None}, ('delivery', None)),
        (ITEM_WITH, {'subcategory': 'damaged'}, ('delivery', 'damaged')),
        ({'category': 'delivery'}, {'subcategory': 'late'}, ('delivery', 'late')),
        ({'category': 'delivery'}, {'category': 'delivery'}, None),
    ])
    def test_a_request_is_the_trimmed_pair_that_differs_from_the_item(self, item, data, expected):
        assert h._requested_category(item, data) == expected

    def test_an_item_without_a_category_must_be_given_one(self):
        with pytest.raises(h.ValidationError, match=r'^category is required$'):
            h._requested_category({}, {'subcategory': 'x'})


class TestUpdateKwargs:
    def test_a_category_change_appends_its_clauses_and_takes_its_condition(self):
        change = h.CategoryChange(
            sets=['#cat_c = :cat_c'], removes=['#cat_s'], names={'#cat_c': 'category', '#cat_s': 'subcategory'},
            values={':cat_c': 'app'}, condition=Attr('pk').exists() & Attr('category').eq('delivery'),
        )
        with patch.object(h, 'datetime') as dt:
            dt.now.return_value.isoformat.return_value = ISO
            kwargs = h._update_kwargs({'pk': 'p', 'sk': 's'}, {'rating': 3}, change)
        assert kwargs == {
            'Key': {'pk': 'p', 'sk': 's'},
            'UpdateExpression': 'SET #rating = :rating, #cat_c = :cat_c, #updated_at = :updated_at REMOVE #cat_s',
            'ConditionExpression': Attr('pk').exists() & Attr('category').eq('delivery'),
            'ExpressionAttributeNames': {'#rating': 'rating', '#cat_c': 'category', '#cat_s': 'subcategory',
                                         '#updated_at': 'updated_at'},
            'ExpressionAttributeValues': {':rating': 3, ':cat_c': 'app', ':updated_at': ISO},
        }

    def test_without_a_change_the_only_condition_is_existence(self):
        with patch.object(h, 'datetime') as dt:
            dt.now.return_value.isoformat.return_value = ISO
            kwargs = h._update_kwargs({'pk': 'p', 'sk': 's'}, {}, None)
        assert kwargs['UpdateExpression'] == 'SET #updated_at = :updated_at'
        assert kwargs['ConditionExpression'] == Attr('pk').exists()
        assert kwargs['ExpressionAttributeNames'] == {'#updated_at': 'updated_at'}
        assert kwargs['ExpressionAttributeValues'] == {':updated_at': ISO}


# ============================================
# GET /data-explorer/buckets and /stats
# ============================================

class TestTheBucketCatalogueRoutes:
    def test_buckets_lists_the_configured_bucket_with_its_label_and_description(
            self, api_gateway_event, lambda_context):
        response, body = _get(api_gateway_event, lambda_context, '/data-explorer/buckets')
        assert response['statusCode'] == 200
        assert body == {'buckets': [{
            'id': 'raw-data', 'name': BUCKET, 'label': 'VoC Raw Data',
            'description': 'Raw feedback data from all sources',
        }]}

    def test_buckets_falls_back_to_the_name_and_an_empty_description_and_skips_unnamed(
            self, api_gateway_event, lambda_context):
        catalogue = {'bare': {'name': 'bare-bucket'}, 'unnamed': {'name': '', 'label': 'x'}, 'absent': {}}
        with patch.dict(h.AVAILABLE_BUCKETS, catalogue, clear=True):
            _, body = _get(api_gateway_event, lambda_context, '/data-explorer/buckets')
        assert body == {'buckets': [{'id': 'bare', 'name': 'bare-bucket', 'label': 'bare-bucket', 'description': ''}]}

    def test_stats_reports_the_top_level_folders_of_each_bucket(self, api_gateway_event, lambda_context):
        with patch.object(h, 's3_client') as s3:
            s3.list_objects_v2.return_value = {'CommonPrefixes': [
                {'Prefix': 'raw/'}, {'Prefix': 'avatars/'}, {'Prefix': '/'}, {'Prefix': ''}, {},
            ]}
            response, body = _get(api_gateway_event, lambda_context, '/data-explorer/stats')
        assert response['statusCode'] == 200
        assert body == {
            's3': {
                'buckets': [{'id': 'raw-data', 'name': BUCKET, 'label': 'VoC Raw Data',
                             'folders': ['raw', 'avatars'], 'folder_count': 2}],
                'configured': True,
            },
            'dynamodb': {'table': 'test-feedback', 'configured': True},
        }
        s3.list_objects_v2.assert_called_once_with(Bucket=BUCKET, Delimiter='/', MaxKeys=100)

    def test_stats_records_a_listing_failure_per_bucket_instead_of_failing(self, api_gateway_event, lambda_context):
        error = _client_error('AccessDenied', 'ListObjectsV2')
        with patch.object(h, 's3_client') as s3, patch.object(h.logger, 'exception') as log:
            s3.list_objects_v2.side_effect = error
            response, body = _get(api_gateway_event, lambda_context, '/data-explorer/stats')
        assert response['statusCode'] == 200
        assert body['s3']['buckets'] == [
            {'id': 'raw-data', 'name': BUCKET, 'label': 'VoC Raw Data', 'error': 'Failed to read bucket contents'},
        ]
        log.assert_called_once_with(f'Failed to get stats for bucket {BUCKET}')

    def test_stats_without_a_bucket_or_table_says_so_and_never_calls_s3(self, api_gateway_event, lambda_context):
        catalogue = {'raw-data': {'name': '', 'label': 'VoC Raw Data'}, 'absent': {}, 'bare': {'name': 'bare-bucket'}}
        with patch.object(h, 's3_client') as s3, patch.object(h, 'RAW_DATA_BUCKET', ''), \
                patch.object(h, 'FEEDBACK_TABLE', ''), patch.dict(h.AVAILABLE_BUCKETS, catalogue, clear=True):
            s3.list_objects_v2.return_value = {'CommonPrefixes': [{'Prefix': 'XBOX/'}]}
            _, body = _get(api_gateway_event, lambda_context, '/data-explorer/stats')
        assert body == {
            's3': {'buckets': [{'id': 'bare', 'name': 'bare-bucket', 'label': 'bare-bucket',
                                'folders': ['XBOX'], 'folder_count': 1}],
                   'configured': False},
            'dynamodb': {'table': '', 'configured': False},
        }
        s3.list_objects_v2.assert_called_once_with(Bucket='bare-bucket', Delimiter='/', MaxKeys=100)


class TestEveryEntryPointIsInstrumented:
    """Each route is the tracer's wrapper around the named function; the handler
    carries `api_handler` (logger context, tracer, metrics). Each decorator leaves
    `__wrapped__` behind, so a dropped decorator is a missing attribute."""

    ROUTES = ('list_s3_objects', 'preview_s3_file', 'save_s3_file', 'save_feedback', 'list_buckets', 'get_data_stats')

    @pytest.mark.parametrize('route', ROUTES)
    def test_every_route_is_the_tracer_wrapper_around_the_named_function(self, route):
        assert_tracer_wrapped(h, route)

    def test_the_handler_is_wrapped_and_injects_the_invocation_context_into_the_logger(self, api_gateway_event):
        assert_handler_wrapped(h)
        # A plain object, not a MagicMock: Powertools reads `context.lambda_context`
        # whenever that attribute exists, and a MagicMock has every attribute.
        context = SimpleNamespace(
            function_name='voc-data-explorer-under-test',
            memory_limit_in_mb=256,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-data-explorer-under-test',
            aws_request_id='req-data-explorer-mutation-0001',
            get_remaining_time_in_millis=lambda: 30_000,
        )
        response = h.lambda_handler(api_gateway_event(method='GET', path='/data-explorer/buckets'), context)
        assert response['statusCode'] == 200
        keys = h.logger.get_current_keys()
        assert keys['function_name'] == 'voc-data-explorer-under-test'
        assert keys['function_request_id'] == 'req-data-explorer-mutation-0001'

    def test_the_module_holds_one_client_per_service_it_talks_to(self):
        assert h.s3_client.meta.service_model.service_name == 's3'
        assert h.sqs_client.meta.service_model.service_name == 'sqs'
        assert h.dynamodb.meta.service_name == 'dynamodb'
