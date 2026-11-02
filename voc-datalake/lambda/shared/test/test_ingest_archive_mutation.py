"""Mutation hardening for `shared/ingest_archive.py`.

`test_ingest_archive.py` pins the archive modes and the resulting
``s3_raw_uri`` values, but a mutation run found what it cannot see:

* the S3 WRITE itself: the exact ``put_object`` call (bucket, the versioned
  key, the JSON body without the stale ``s3_raw_uri``, ``ContentType``, the
  ``If-None-Match`` condition and the connector metadata). The earlier tests
  only counted calls, so an empty or wrong body still passed.
* the ``item`` stem for a message whose id is missing or empty (an empty id
  must not be hashed into ``h.<sha256('')>``).
* the concurrency cap handed to ``ordered_map`` (16 writers).
* the WORDING of both upload refusals (``str(exc)`` is the 400 body the import
  UI shows) and of the two log lines an operator searches for.
"""
import hashlib
import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared import concurrency
from shared.exceptions import ValidationError
from shared.ingest_archive import archive_per_item, upload_profile
from shared.source_profiles import SourceProfilesUnavailable

NOW = datetime(2026, 3, 7, tzinfo=UTC)


def _profiles_table(sources: list[dict]) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {'Item': {'sources': sources}}
    return table


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize('raw', ['Bad Id', 7])
    def test_a_malformed_source_id(self, raw: object) -> None:
        with pytest.raises(ValidationError) as exc:
            upload_profile(_profiles_table([]), raw)
        assert str(exc.value) == 'source_id must be a configured source id'

    def test_an_unconfigured_source_id(self) -> None:
        with pytest.raises(ValidationError) as exc:
            upload_profile(_profiles_table([{'id': 'sales_csv'}]), ' nope ')
        assert str(exc.value) == 'Unknown source_id "nope": configure it in Administration → Privacy & access → Source policies first'

    def test_an_unreadable_profile_row_is_logged(self) -> None:
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'X'}}, 'GetItem')
        with patch('shared.ingest_archive.logger') as logger, pytest.raises(SourceProfilesUnavailable):
            upload_profile(table, 'manual_import')
        logger.exception.assert_called_once_with('Source profiles could not be read for an upload')


class TestThePerItemWrite:
    def test_the_put_object_call_is_exact(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv('APP_VERSION', '9.1.0')
        s3 = MagicMock()
        messages = [{'id': 'r1', 'text': 'hi', 'rating': Decimal('4.5'), 's3_raw_uri': 'stale'}]
        archive_per_item(s3, 'bkt', 'src', messages, NOW, connector_id='csv_upload')
        body = '{"id": "r1", "text": "hi", "rating": 4.5}'
        digest = hashlib.sha256(b'{"id": "r1", "rating": 4.5, "text": "hi"}').hexdigest()[:16]
        key = f'raw/src/2026/03/07/r1/{digest}.json'
        s3.put_object.assert_called_once_with(
            Bucket='bkt', Key=key, Body=body, ContentType='application/json', IfNoneMatch='*',
            Metadata={'connector': 'csv_upload', 'connector-version': '9.1.0'})
        assert messages[0]['s3_raw_uri'] == f's3://bkt/{key}'

    def test_the_default_writer_is_manual_import(self) -> None:
        s3 = MagicMock()
        archive_per_item(s3, 'bkt', 'src', [{'id': 'r1'}], NOW)
        assert s3.put_object.call_args.kwargs['Metadata']['connector'] == 'manual_import'

    def test_already_archived_content_keeps_its_uri(self) -> None:
        s3 = MagicMock()
        response: Any = {'Error': {'Code': 'PreconditionFailed'}, 'ResponseMetadata': {'HTTPStatusCode': 412}}
        s3.put_object.side_effect = ClientError(response, 'PutObject')
        messages = [{'id': 'r1', 'text': 'hi'}]
        archive_per_item(s3, 'bkt', 'src', messages, NOW)
        assert messages[0]['s3_raw_uri'] == f"s3://bkt/{s3.put_object.call_args.kwargs['Key']}"

    @pytest.mark.parametrize('message', [{'text': 'no id'}, {'id': None, 'text': 'x'}, {'id': '', 'text': 'x'}])
    def test_a_message_without_an_id_is_archived_in_a_folder_named_after_its_content(self, message: dict) -> None:
        s3 = MagicMock()
        archive_per_item(s3, 'bkt', 'src', [message], NOW)
        key = s3.put_object.call_args.kwargs['Key']
        # Never a shared constant folder: noid-{digest}/{digest}.json, the same digest twice.
        match = re.fullmatch(r'raw/src/2026/03/07/noid-([0-9a-f]{16})/([0-9a-f]{16})\.json', key)
        assert match is not None
        assert match.group(1) == match.group(2)
        assert message['s3_raw_uri'] == f's3://bkt/{key}'

    def test_at_most_sixteen_writes_run_at_once(self) -> None:
        spy = MagicMock(wraps=concurrency.ordered_map)
        with patch('shared.ingest_archive.ordered_map', spy):
            archive_per_item(MagicMock(), 'bkt', 'src', [{'id': 'a'}, {'id': 'b'}], NOW)
        assert spy.call_args.kwargs == {'max_workers': 16}

    def test_a_failed_write_is_logged_with_its_cause(self) -> None:
        s3 = MagicMock()
        error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'PutObject')
        s3.put_object.side_effect = error
        with patch('shared.ingest_archive.logger') as logger:
            archive_per_item(s3, 'bkt', 'src', [{'id': 'a'}], NOW)
        logger.warning.assert_called_once_with(f'Failed to archive one item to S3: {error}')
