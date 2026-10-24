"""Mutation hardening for `shared/ingest_archive.py`.

`test_ingest_archive.py` pins the archive modes and the resulting
``s3_raw_uri`` values, but a mutation run found what it cannot see:

* the S3 WRITE itself: the exact ``put_object`` call (bucket, key, the JSON
  body without the stale ``s3_raw_uri``, ``ContentType``). The earlier tests
  only counted calls, so an empty or wrong body still passed.
* the ``item`` stem for a message whose id is missing or empty (an empty id
  must not be hashed into ``h.<sha256('')>``).
* the concurrency cap handed to ``ordered_map`` (16 writers).
* the WORDING of both upload refusals (``str(exc)`` is the 400 body the import
  UI shows) and of the two log lines an operator searches for.
"""
from datetime import UTC, datetime
from decimal import Decimal
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
    def test_the_put_object_call_is_exact(self) -> None:
        s3 = MagicMock()
        messages = [{'id': 'r1', 'text': 'hi', 'rating': Decimal('4.5'), 's3_raw_uri': 'stale'}]
        archive_per_item(s3, 'bkt', 'src', messages, NOW)
        s3.put_object.assert_called_once_with(
            Bucket='bkt', Key='raw/src/2026/03/07/r1.json',
            Body='{"id": "r1", "text": "hi", "rating": 4.5}', ContentType='application/json')
        assert messages[0]['s3_raw_uri'] == 's3://bkt/raw/src/2026/03/07/r1.json'

    @pytest.mark.parametrize('message', [{'text': 'no id'}, {'id': None, 'text': 'x'}, {'id': '', 'text': 'x'}])
    def test_a_message_without_an_id_is_archived_as_item(self, message: dict) -> None:
        s3 = MagicMock()
        archive_per_item(s3, 'bkt', 'src', [message], NOW)
        assert s3.put_object.call_args.kwargs['Key'] == 'raw/src/2026/03/07/item.json'
        assert message['s3_raw_uri'] == 's3://bkt/raw/src/2026/03/07/item.json'

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
