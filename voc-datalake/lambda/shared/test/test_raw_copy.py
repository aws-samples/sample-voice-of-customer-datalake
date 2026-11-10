"""shared/raw_copy.py: one write-once raw copy, JSON or as received; a failed write never raises."""
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

from shared.raw_copy import RawTarget, bytes_copy, bytes_digest, json_copy
from shared.raw_versions import Connector, content_digest

BUCKET = 'raw-bucket'
CONNECTOR = Connector('feedback_form', '9.1.0')
TARGET = RawTarget(BUCKET, 'feedback_form', date(2026, 3, 5), 'fb1')
FOLDER = 'raw/feedback_form/2026/03/05/fb1/'


@pytest.fixture
def s3() -> Any:
    with mock_aws():
        client = boto3.client('s3', region_name='us-east-1')
        client.create_bucket(Bucket=BUCKET)
        yield client


def _keys(s3: Any) -> list[str]:
    return [o['Key'] for o in s3.list_objects_v2(Bucket=BUCKET).get('Contents', [])]


class TestJsonCopy:
    def test_writes_the_content_at_its_digest_with_the_connector(self, s3: Any) -> None:
        uri = json_copy(s3, TARGET, {'text': 'hi', 'rating': 5}, CONNECTOR)

        key = f'{FOLDER}{content_digest({"text": "hi", "rating": 5})}.json'
        assert uri == f's3://{BUCKET}/{key}'
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        assert json.loads(obj['Body'].read()) == {'text': 'hi', 'rating': 5}
        assert obj['ContentType'] == 'application/json'
        assert obj['Metadata'] == {'connector': 'feedback_form', 'connector-version': '9.1.0'}

    def test_identical_content_is_one_object_and_a_change_is_a_new_one(self, s3: Any) -> None:
        first = json_copy(s3, TARGET, {'text': 'a'}, CONNECTOR)
        again = json_copy(s3, TARGET, {'text': 'a'}, CONNECTOR)
        changed = json_copy(s3, TARGET, {'text': 'b'}, CONNECTOR)

        assert first == again
        assert changed != first
        assert len(_keys(s3)) == 2

    def test_extra_metadata_is_kept(self, s3: Any) -> None:
        uri = json_copy(s3, TARGET, {'x': 1}, CONNECTOR, metadata={'drop-reason': 'duplicate'})
        assert uri is not None
        key = uri.removeprefix(f's3://{BUCKET}/')
        assert s3.head_object(Bucket=BUCKET, Key=key)['Metadata']['drop-reason'] == 'duplicate'

    def test_no_bucket_writes_nothing(self) -> None:
        client = MagicMock()
        assert json_copy(client, RawTarget('', 'feedback_form', date(2026, 3, 5), 'fb1'), {'x': 1}, CONNECTOR) is None
        client.put_object.assert_not_called()

    def test_a_failed_write_is_none_not_an_exception(self) -> None:
        client = MagicMock()
        client.put_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'PutObject')
        assert json_copy(client, TARGET, {'x': 1}, CONNECTOR) is None


class TestBytesCopy:
    def test_writes_the_original_with_its_extension_and_content_type(self, s3: Any) -> None:
        body = b'From: a@example.com\r\n\r\nhello'
        uri = bytes_copy(s3, TARGET, body, CONNECTOR, extension='.eml', content_type='message/rfc822')

        key = f'{FOLDER}{hashlib.sha256(body).hexdigest()[:16]}.eml'
        assert uri == f's3://{BUCKET}/{key}'
        obj = s3.get_object(Bucket=BUCKET, Key=key)
        assert obj['Body'].read() == body
        assert obj['ContentType'] == 'message/rfc822'

    def test_the_digest_is_over_the_bytes(self) -> None:
        assert bytes_digest(b'abc') == hashlib.sha256(b'abc').hexdigest()[:16]

    def test_no_bucket_writes_nothing(self) -> None:
        client = MagicMock()
        target = RawTarget('', 's3_import', date(2026, 3, 5), 'f')
        assert bytes_copy(client, target, b'x', CONNECTOR, extension='.csv', content_type='text/csv') is None
        client.put_object.assert_not_called()
