"""The workspace bucket on moto: writes are create-only, reads are bounded and a missing key reads as None."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.workspace import store as store_module
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-engineering-workspace'


@pytest.fixture
def workspace() -> Iterator[WorkspaceStore]:
    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        yield WorkspaceStore(s3, BUCKET)


def test_an_object_is_written_once(workspace: WorkspaceStore) -> None:
    assert workspace.put_once('ws/default/reports/r/goal/r/v0001.json', '{"a": 1}', 'application/json')
    assert not workspace.put_once('ws/default/reports/r/goal/r/v0001.json', '{"a": 2}', 'application/json')
    assert workspace.read_text('ws/default/reports/r/goal/r/v0001.json') == '{"a": 1}'
    assert workspace.read_text('ws/default/nothing') is None


def test_a_read_is_bounded(workspace: WorkspaceStore, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store_module, 'MAX_READ_BYTES', 4)
    workspace.put_once('k', 'abcdefgh', 'text/plain')
    assert workspace.read_text('k') == 'abcd'


def test_an_empty_object_reads_as_empty_text(workspace: WorkspaceStore) -> None:
    workspace.put_once('empty.jsonl', '', 'application/x-ndjson')
    assert workspace.read_text('empty.jsonl') == ''
    s3: Any = MagicMock()
    s3.get_object.side_effect = ClientError({'Error': {'Code': 'InvalidRange', 'Message': 'no byte 0'}}, 'GetObject')
    assert WorkspaceStore(s3, BUCKET).read_text('empty.jsonl') == ''


def test_other_s3_errors_are_raised() -> None:
    s3: Any = MagicMock()
    denied = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'GetObject')
    s3.get_object.side_effect = denied
    s3.put_object.side_effect = denied
    workspace = WorkspaceStore(s3, BUCKET)
    with pytest.raises(ClientError):
        workspace.read_text('k')
    with pytest.raises(ClientError):
        workspace.put_once('k', 'x', 'text/plain')


def test_a_reader_without_listbucket_reads_a_denied_object_as_missing() -> None:
    """Without s3:ListBucket, S3 answers a missing key 403: only an opted-in reader takes that as missing."""
    s3: Any = MagicMock()
    s3.get_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'GetObject')
    s3.put_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'PutObject')
    workspace = WorkspaceStore(s3, BUCKET, denied_is_missing=True)
    assert workspace.read_text('k') is None
    with pytest.raises(ClientError):   # a write is never excused
        workspace.put_once('k', 'x', 'text/plain')
    s3.get_object.side_effect = ClientError({'Error': {'Code': 'SlowDown', 'Message': 'slow'}}, 'GetObject')
    with pytest.raises(ClientError):
        workspace.read_text('k')
