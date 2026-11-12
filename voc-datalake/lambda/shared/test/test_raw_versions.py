"""`shared/raw_versions.py`: the versioned raw key layout and the write-once put.

The conditional put runs against moto (which answers ``If-None-Match: *`` on an
existing key with 412 ``PreconditionFailed``, as S3 does); the 409 retry is stubbed
at the client boundary because moto never produces a concurrent-write conflict.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.raw_versions import (
    Connector,
    ItemArchive,
    app_connector,
    content_digest,
    folder_of,
    item_folder,
    parse_item_key,
    put_raw_version,
    version_key,
)
from shared.ws_repo import WorkspaceScope

BUCKET = 'raw-bucket'
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
SCOPE = WorkspaceScope(WS)
OTHER_SCOPE = WorkspaceScope(OTHER_WS)


def workspace_item_folder(scope: WorkspaceScope, source: str, day: date, stem: str) -> str:
    """``item_folder`` for a run in ``scope``."""
    return item_folder(source, day, stem, scope)
CONNECTOR = Connector('manual_import', '9.1.0')


def _client_error(code: str, status: int) -> ClientError:
    response: Any = {'Error': {'Code': code}, 'ResponseMetadata': {'HTTPStatusCode': status}}
    return ClientError(response, 'PutObject')


@pytest.fixture
def s3() -> Any:
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={'Status': 'Enabled'})
        yield client


class TestKeys:
    def test_item_folder_is_zero_padded_and_ends_in_a_slash(self) -> None:
        assert item_folder('web', date(2026, 3, 5), 'r1') == 'raw/web/2026/03/05/r1/'

    def test_version_key_sits_in_the_folder(self) -> None:
        assert version_key('raw/web/2026/03/05/r1/', '0123456789abcdef') == 'raw/web/2026/03/05/r1/0123456789abcdef.json'

    def test_version_key_takes_the_extension_of_an_original(self) -> None:
        assert version_key('raw/email_intake/2026/03/05/em_1/', '0123456789abcdef', '.eml') == (
            'raw/email_intake/2026/03/05/em_1/0123456789abcdef.eml')

    @pytest.mark.parametrize('extension', ['eml', '.EML', '.e/ml', '.', '.abcdefghijk'])
    def test_version_key_refuses_a_malformed_extension(self, extension: str) -> None:
        with pytest.raises(ValueError, match='Not a raw version extension'):
            version_key('raw/web/2026/03/05/r1/', '0123456789abcdef', extension)

    def test_the_digest_is_sha256_of_the_sorted_json(self) -> None:
        content = {'b': 1, 'a': [2, 3]}
        expected = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()[:16]
        assert content_digest(content) == expected
        assert content_digest({'a': [2, 3], 'b': 1}) == expected

    def test_the_digest_uses_the_given_default(self) -> None:
        assert content_digest({'d': date(2026, 1, 1)}) == content_digest({'d': '2026-01-01'})
        assert content_digest({'d': date(2026, 1, 1)}, default=lambda _v: 'x') == content_digest({'d': 'x'})

    def test_different_content_has_a_different_digest(self) -> None:
        assert content_digest({'text': 'a'}) != content_digest({'text': 'b'})


class TestParseItemKey:
    @pytest.mark.parametrize('key', [
        'raw/web/2026/03/05/r1.json',
        'raw/web/2026/03/05/r1/0123456789abcdef.json',
        'raw/web/2026/03/05/r1/0123456789abcdef.eml',
    ])
    def test_both_layouts_name_the_same_item(self, key: str) -> None:
        assert parse_item_key(key) == ItemArchive(
            stem='r1', legacy_key='raw/web/2026/03/05/r1.json', folder='raw/web/2026/03/05/r1/')
        assert folder_of(key) == 'raw/web/2026/03/05/r1/'

    @pytest.mark.parametrize('key', [
        'raw/web/2026/03/05/r1',
        'raw/web/2026/03/05/.json',
        'raw/web/2026/03/r1.json',
        'raw/web/2026/03/05/r1/notadigest.json',
        'raw/web/2026/03/05/r1/0123456789ABCDEF.json',
        'raw/web/2026/03/05/r1/0123456789abcdef.EML',
        'raw/web/2026/03/05/r1/0123456789abcdef',
        'raw/web/2026/03/05/r1/0123456789abcdef.json/x',
        'raw/web/2026/03/05/../0123456789abcdef.json',
        'raw/web//03/05/r1.json',
        'avatars/web/2026/03/05/r1.json',
    ])
    def test_anything_else_is_not_an_item_archive(self, key: str) -> None:
        assert parse_item_key(key) is None
        assert folder_of(key) is None

    @pytest.mark.parametrize('key', [
        f'ws/{WS}/raw/web/2026/03/05/r1/0123456789abcdef.json',
        f'ws/{WS}/raw/web/2026/03/05/r1/0123456789abcdef.csv',
    ])
    def test_a_workspaces_versioned_archive_names_its_item_in_that_workspace(self, key: str) -> None:
        assert parse_item_key(key) == ItemArchive(
            stem='r1', legacy_key=f'ws/{WS}/raw/web/2026/03/05/r1.json', folder=f'ws/{WS}/raw/web/2026/03/05/r1/')
        assert folder_of(key) == f'ws/{WS}/raw/web/2026/03/05/r1/'

    @pytest.mark.parametrize('key', [
        # No legacy layout under a workspace: nothing was ever archived there that way.
        f'ws/{WS}/raw/web/2026/03/05/r1.json',
        f'ws/{WS}/silver/web/2026/03/05/r1/0123456789abcdef.json',
        f'ws/{WS}/raw/web/2026/03/r1/0123456789abcdef.json',
        f'ws/{WS}/raw/web/2026/03/05/r1/0123456789abcdef.json/x',
        'ws/ws_nope/raw/web/2026/03/05/r1/0123456789abcdef.json',
        f'ws/{WS.lower()}/raw/web/2026/03/05/r1/0123456789abcdef.json',
        f'ws/{WS}/../raw/web/2026/03/05/r1/0123456789abcdef.json',
        f'wsx/{WS}/raw/web/2026/03/05/r1/0123456789abcdef.json',
        'ws//raw/web/2026/03/05/r1/0123456789abcdef.json',
        f'ws/{WS}',
        f'raw/ws/{WS}/raw/web/2026/03/05/r1/0123456789abcdef.json',
    ])
    def test_anything_else_under_a_workspace_is_not_an_item_archive(self, key: str) -> None:
        assert parse_item_key(key) is None


class TestWorkspaceKeys:
    def test_without_a_scope_the_folder_is_the_deployment_wide_one(self) -> None:
        assert item_folder('web', date(2026, 3, 5), 'r1', None) == 'raw/web/2026/03/05/r1/'

    def test_a_workspaces_item_folder_is_under_its_own_root(self) -> None:
        assert workspace_item_folder(SCOPE, 'web', date(2026, 3, 5), 'r1') == f'ws/{WS}/raw/web/2026/03/05/r1/'
        assert workspace_item_folder(OTHER_SCOPE, 'web', date(2026, 3, 5), 'r1') == (
            f'ws/{OTHER_WS}/raw/web/2026/03/05/r1/')

    def test_the_same_item_in_two_workspaces_never_shares_a_folder(self) -> None:
        day = date(2026, 3, 5)
        assert workspace_item_folder(SCOPE, 'web', day, 'r1') != workspace_item_folder(OTHER_SCOPE, 'web', day, 'r1')
        assert workspace_item_folder(SCOPE, 'web', day, 'r1').removeprefix(f'ws/{WS}/') == item_folder('web', day, 'r1')

    @pytest.mark.parametrize(('source', 'stem'), [('..', 'r1'), ('web', '..'), ('', 'r1'), ('web', ''), ('a//b', 'r1')])
    def test_a_source_or_stem_cannot_climb_out_of_the_workspace(self, source: str, stem: str) -> None:
        with pytest.raises(ValueError, match='non-empty segments'):
            workspace_item_folder(SCOPE, source, date(2026, 3, 5), stem)

    def test_a_workspaces_version_key_reads_back_as_its_item(self) -> None:
        key = version_key(workspace_item_folder(SCOPE, 'web', date(2026, 3, 5), 'r1'), '0123456789abcdef')
        archive = parse_item_key(key)
        assert archive is not None
        assert archive.folder == f'ws/{WS}/raw/web/2026/03/05/r1/'


class TestConnector:
    def test_metadata_and_envelope(self) -> None:
        assert CONNECTOR.metadata() == {'connector': 'manual_import', 'connector-version': '9.1.0'}
        assert CONNECTOR.envelope() == {'id': 'manual_import', 'version': '9.1.0'}

    def test_an_api_writer_carries_the_app_release(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('APP_VERSION', '7.2.0')
        assert app_connector('csv_upload') == Connector('csv_upload', '7.2.0')

    @pytest.mark.parametrize('value', [None, ''])
    def test_no_app_release_is_unknown(self, monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
        if value is None:
            monkeypatch.delenv('APP_VERSION', raising=False)
        else:
            monkeypatch.setenv('APP_VERSION', value)
        assert app_connector('csv_upload') == Connector('csv_upload', 'unknown')


class TestPutRawVersion:
    KEY = 'raw/web/2026/03/05/r1/0123456789abcdef.json'

    def test_a_new_key_is_written_with_the_connector_metadata(self, s3: Any) -> None:
        assert put_raw_version(s3, BUCKET, self.KEY, '{"a": 1}', CONNECTOR, metadata={'uploaded_by': 'u1'}) is True

        head = s3.head_object(Bucket=BUCKET, Key=self.KEY)
        assert head['Metadata'] == {'uploaded_by': 'u1', 'connector': 'manual_import', 'connector-version': '9.1.0'}
        assert head['ContentType'] == 'application/json'

    def test_the_connector_wins_over_caller_metadata(self, s3: Any) -> None:
        put_raw_version(s3, BUCKET, self.KEY, '{}', CONNECTOR, metadata={'connector': 'spoofed'})

        assert s3.head_object(Bucket=BUCKET, Key=self.KEY)['Metadata']['connector'] == 'manual_import'

    def test_an_existing_key_is_never_overwritten(self, s3: Any) -> None:
        put_raw_version(s3, BUCKET, self.KEY, 'first', CONNECTOR)

        assert put_raw_version(s3, BUCKET, self.KEY, 'second', CONNECTOR, content_type='text/plain') is False

        versions = s3.list_object_versions(Bucket=BUCKET, Prefix=self.KEY)['Versions']
        assert len(versions) == 1
        assert s3.get_object(Bucket=BUCKET, Key=self.KEY)['Body'].read() == b'first'

    def test_every_put_is_conditional(self) -> None:
        client = MagicMock()

        put_raw_version(client, BUCKET, self.KEY, b'x', CONNECTOR, content_type='text/csv')

        client.put_object.assert_called_once_with(
            Bucket=BUCKET, Key=self.KEY, Body=b'x', ContentType='text/csv', IfNoneMatch='*',
            Metadata={'connector': 'manual_import', 'connector-version': '9.1.0'})

    @pytest.mark.parametrize(('code', 'status'), [('PreconditionFailed', 412), ('', 412), ('PreconditionFailed', 0)])
    def test_a_412_is_already_archived(self, code: str, status: int) -> None:
        client = MagicMock()
        client.put_object.side_effect = _client_error(code, status)

        assert put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR) is False
        assert client.put_object.call_count == 1

    def test_a_409_is_retried_once(self) -> None:
        client = MagicMock()
        client.put_object.side_effect = [_client_error('ConditionalRequestConflict', 409), {}]

        assert put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR) is True
        assert client.put_object.call_count == 2

    def test_a_409_then_412_is_already_archived(self) -> None:
        client = MagicMock()
        client.put_object.side_effect = [_client_error('ConditionalRequestConflict', 409),
                                         _client_error('PreconditionFailed', 412)]

        assert put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR) is False

    def test_a_second_409_raises(self) -> None:
        client = MagicMock()
        client.put_object.side_effect = [_client_error('ConditionalRequestConflict', 409),
                                         _client_error('', 409)]

        with pytest.raises(ClientError):
            put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR)
        assert client.put_object.call_count == 2

    def test_any_other_error_raises_at_once(self) -> None:
        client = MagicMock()
        client.put_object.side_effect = _client_error('AccessDenied', 403)

        with pytest.raises(ClientError):
            put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR)
        assert client.put_object.call_count == 1

    @pytest.mark.parametrize(('code', 'status'), [('InvalidRequest', 412), ('OperationAborted', 409)])
    def test_an_unrelated_code_with_a_conditional_status_raises(self, code: str, status: int) -> None:
        # Only PreconditionFailed means "already archived"; only ConditionalRequestConflict is retried.
        client = MagicMock()
        client.put_object.side_effect = _client_error(code, status)

        with pytest.raises(ClientError):
            put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR)
        assert client.put_object.call_count == 1

    def test_a_non_int_status_is_ignored(self) -> None:
        client = MagicMock()
        response: Any = {'Error': {'Code': 'AccessDenied'}, 'ResponseMetadata': {'HTTPStatusCode': '412'}}
        client.put_object.side_effect = ClientError(response, 'PutObject')

        with pytest.raises(ClientError):
            put_raw_version(client, BUCKET, self.KEY, 'x', CONNECTOR)
