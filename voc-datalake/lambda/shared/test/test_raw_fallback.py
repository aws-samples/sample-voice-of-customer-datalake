"""shared/raw_fallback.py: the processor archives a message's inline raw_data once, policy first."""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest

from shared.raw_fallback import archive_inline_raw
from shared.raw_versions import content_digest
from shared.test.raw_lake_fixtures import RAW_BUCKET, raw_keys, raw_lake
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

BUCKET = RAW_BUCKET
NOW = datetime(2026, 3, 5, 12, tzinfo=UTC)
RAW = {'id': 'r1', 'text': 'as received', 'rating': 4}


def _record(**overrides: Any) -> dict[str, Any]:
    return {'id': 'r1', 'source_platform': 'webscraper', 'text': 'as received', 'raw_data': dict(RAW), **overrides}


@pytest.fixture
def s3() -> Iterator[Any]:
    with raw_lake() as client, seeded_source_profiles():
        yield client


def _keys(client: Any) -> list[str]:
    return raw_keys(client)


def test_writes_raw_data_in_the_items_folder_with_the_processor_connector(s3: Any) -> None:
    uri = archive_inline_raw(_record(), NOW)

    key = f'raw/webscraper/2026/03/05/r1/{content_digest(RAW)}.json'
    assert uri == f's3://{BUCKET}/{key}'
    obj = s3.get_object(Bucket=BUCKET, Key=key)
    assert json.loads(obj['Body'].read()) == RAW
    assert obj['Metadata'] == {'connector': 'processor', 'connector-version': '9.1.0'}


def test_a_retry_writes_nothing_new(s3: Any) -> None:
    first = archive_inline_raw(_record(), NOW)
    assert archive_inline_raw(_record(), NOW) == first
    assert len(_keys(s3)) == 1


@pytest.mark.parametrize('record', [
    _record(s3_raw_uri='s3://raw-bucket/raw/webscraper/x.json'),
    _record(raw_data=None),
    _record(source_platform=None),
])
def test_nothing_to_do(s3: Any, record: dict[str, Any]) -> None:
    assert archive_inline_raw(record, NOW) is None
    assert _keys(s3) == []


def test_a_redact_source_keeps_no_copy(s3: Any) -> None:
    with seeded_source_profiles([{'id': 'webscraper', 'label': 'Web', 'pii': 'redact'}]):
        assert archive_inline_raw(_record(), NOW) is None
    assert _keys(s3) == []


def test_an_unreadable_policy_writes_nothing(s3: Any) -> None:
    with unreadable_source_profiles():
        assert archive_inline_raw(_record(), NOW) is None
    assert _keys(s3) == []


def test_no_bucket_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
    with patch('shared.raw_copy.get_s3_client') as client:
        assert archive_inline_raw(_record(), NOW) is None
    client.assert_not_called()


@pytest.mark.usefixtures('s3')
def test_a_message_without_an_id_uses_the_item_stem() -> None:
    uri = archive_inline_raw(_record(id=''), NOW)
    assert uri is not None
    assert '/2026/03/05/item/' in uri
