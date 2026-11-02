"""Mutation hardening for `_shared/raw_archive.py`.

The run also showed ``c in "-_"`` carried two equivalent mutants: ``"XX-_XX"``
only adds an alphanumeric, and keeping ``_`` is the same as replacing it with
``_``. The module now keeps alphanumerics and ``-`` only (identical output).

The only earlier coverage was indirect: `test_base_ingestor.py` checks that
`put_object` is called once and that the URI starts with ``s3://test-bucket/``,
and pins one content-hash id. A mutation run found everything else unseen:

* the S3 KEY layout — ``raw/{source}/{yyyy}/{mm}/{dd}/{id}/{sha16}.json`` with
  zero-padded month and day, partitioned by the item's own ``created_at``
  (the versioned, write-once layout of ``shared/raw_versions.py``);
* the ``created_at`` normalisation (``Z`` → ``+00:00``, space → ``T``, a
  missing offset gets ``+00:00``) — on Python 3.12 ``fromisoformat`` accepts
  most inputs on its own, so only a lowercase ``z`` suffix tells the
  normalised parse from the raw one;
* the fallback to *now* for an unparseable, empty or non-string date, and its
  debug line;
* the archived BODY (every key, ``default=str``) and ``ContentType``;
* the file id: which characters survive sanitising, the 64-char cap, falsy ids
  falling through to the hash, the 500-char text window and the hash literals
  for missing fields;
* that the text digest is taken with ``usedforsecurity=False`` and that loading
  the module puts the plugins root at the FRONT of ``sys.path``;
* the no-bucket and write-failure paths returning None with their exact log
  lines.
"""
import hashlib
import json
import re
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared import raw_archive
from _shared.raw_archive import archive_raw_item, raw_item_id
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh

MODULE_PATH = Path(raw_archive.__file__).resolve()
PLUGINS_ROOT = str(MODULE_PATH.parents[1])

_NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
_BUCKET = "raw-bucket"
_SOURCE = "webscraper"


class _FrozenDatetime(datetime):
    """``datetime`` whose ``now`` is fixed at ``_NOW`` and records the tz asked for."""

    now_tz: ClassVar[list[object]] = []

    @classmethod
    def now(cls, tz=None):
        cls.now_tz.append(tz)
        return _NOW


class _LaterDatetime(datetime):
    """``datetime`` whose ``now`` is a year after ``_NOW``."""

    @classmethod
    def now(cls, tz=None):
        return datetime(2027, 1, 2, tzinfo=tz)


def s3_body(s3: MagicMock) -> str:
    return s3.put_object.call_args.kwargs["Body"]


@pytest.fixture
def logger() -> Iterator[MagicMock]:
    with patch.object(raw_archive, "logger") as mock_logger:
        yield mock_logger


@pytest.fixture(autouse=True)
def frozen_now() -> Iterator[list[object]]:
    _FrozenDatetime.now_tz = []
    with patch.object(raw_archive, "datetime", _FrozenDatetime):
        yield _FrozenDatetime.now_tz


def _archive(item: dict, raw_content: str | None = None) -> tuple[str | None, MagicMock]:
    s3 = MagicMock()
    if raw_content is None:
        uri = archive_raw_item(s3, _BUCKET, _SOURCE, item)
    else:
        uri = archive_raw_item(s3, _BUCKET, _SOURCE, item, raw_content)
    return uri, s3


def _version_of(folder: str, key: str) -> None:
    """``key`` is one version file (16 hex chars) inside ``folder``."""
    assert re.fullmatch(re.escape(folder) + r"[0-9a-f]{16}\.json", key), key


def _written(s3: MagicMock) -> tuple[str, dict]:
    kwargs = s3.put_object.call_args.kwargs
    return kwargs["Key"], json.loads(kwargs["Body"])


class TestRawItemIdFromSourceId:
    @pytest.mark.parametrize(
        ("source_id", "expected"),
        [
            ("review-abc_123", "review-abc_123"),
            (12345, "12345"),
            ("x" * 64, "x" * 64),
        ],
    )
    def test_a_filename_safe_id_of_at_most_64_chars_is_its_own_stem(self, source_id, expected):
        assert raw_item_id({"id": source_id, "text": "ignored"}) == expected

    @pytest.mark.parametrize("source_id", ["a@b c.d/é", "y" * 65, "z" * 70])
    def test_any_other_id_gets_a_sha256_stem(self, source_id):
        expected = "h." + hashlib.sha256(source_id.encode()).hexdigest()
        assert raw_item_id({"id": source_id, "text": "ignored"}) == expected

    @pytest.mark.parametrize(("first", "second"), [("a/b", "a_b"), ("q" * 64 + "1", "q" * 64 + "2")])
    def test_ids_that_used_to_share_a_key_no_longer_do(self, first, second):
        """Sanitising (`/` -> `_`) and the 64-char cut once gave these pairs ONE archive key."""
        assert raw_item_id({"id": first}) != raw_item_id({"id": second})

    @pytest.mark.parametrize(("source_id", "expected"), [("review-abc_123", "review-abc_123")])
    def test_keeps_a_plain_id(self, source_id, expected):
        assert raw_item_id({"id": source_id, "text": "ignored"}) == expected

    @pytest.mark.parametrize("falsy_id", ["", 0, None])
    def test_a_falsy_id_falls_through_to_the_content_hash(self, falsy_id):
        assert raw_item_id({"id": falsy_id}) == "71546855d6279ef70d20909b292c42c2"


class TestRawItemIdFromContent:
    @pytest.mark.parametrize(
        ("item", "expected"),
        [
            ({}, "71546855d6279ef70d20909b292c42c2"),
            ({"text": "hello"}, "68b2d051c96014d77d449bf0dfe4c05d"),
            ({"created_at": "2024-03-05", "url": "https://e.x/1"}, "08abe06e10768abb11ed9eaa810895fd"),
            ({"text": "a" * 500 + "X"}, "e0da0a2986b588e764f20d2ecb653a55"),
        ],
    )
    def test_hash_literals(self, item, expected):
        assert raw_item_id(item) == expected

    def test_only_the_first_500_characters_of_text_count(self):
        assert raw_item_id({"text": "a" * 500 + "X"}) == raw_item_id({"text": "a" * 500 + "Y"})
        assert raw_item_id({"text": "a" * 499 + "X"}) != raw_item_id({"text": "a" * 499 + "Y"})


    def test_the_text_digest_is_not_a_security_hash(self):
        with patch.object(raw_archive.hashlib, "sha256", wraps=hashlib.sha256) as sha256:
            raw_item_id({"text": "hello"})

        assert sha256.call_args_list[0].args == (b"hello",)
        assert sha256.call_args_list[0].kwargs == {"usedforsecurity": False}


class TestModuleLoad:
    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self):
        before = list(sys.path)
        try:
            assert_loading_puts_root_first(
                lambda: load_fresh("_shared._raw_archive_under_test", MODULE_PATH), before, PLUGINS_ROOT,
            )
        finally:
            sys.path[:] = before


class TestPartitionDate:
    @pytest.mark.parametrize(
        "created_at",
        [
            "2024-03-05T10:00:00Z",
            "2024-03-05T10:00:00z",
            "2024-03-05 10:00:00z",
            "2024-03-05T10:00:00+02:00",
            "2024-03-05T10:00:00-05:00",
            "2024-03-05 10:00:00",
            "2024-03-05",
        ],
    )
    def test_the_items_own_date_partitions_the_key(self, created_at, logger):
        uri, s3 = _archive({"id": "r1", "created_at": created_at})

        key, body = _written(s3)
        _version_of("raw/webscraper/2024/03/05/r1/", key)
        assert body["partition_date"] == "2024-03-05"
        assert uri == f"s3://raw-bucket/{key}"
        logger.debug.assert_not_called()

    def test_an_unparseable_date_falls_back_to_now_and_says_so(self, logger):
        _uri, s3 = _archive({"id": "r1", "created_at": "March 5"})

        key, body = _written(s3)
        _version_of("raw/webscraper/2026/01/02/r1/", key)
        assert body["partition_date"] == "2026-01-02"
        logger.debug.assert_called_once_with(
            "Could not parse created_at 'March 5': Invalid isoformat string: 'MarchT5+00:00'"
        )

    @pytest.mark.parametrize("item", [{"id": "r1"}, {"id": "r1", "created_at": ""}, {"id": "r1", "created_at": 20240305}])
    def test_a_missing_empty_or_non_string_date_uses_now(self, item, logger):
        _uri, s3 = _archive(item)

        _version_of("raw/webscraper/2026/01/02/r1/", _written(s3)[0])
        logger.debug.assert_not_called()


class TestArchivedObject:
    def test_writes_every_field_and_returns_the_uri(self, logger, frozen_now, monkeypatch):
        monkeypatch.setenv("SOURCE_PLATFORM", "webscraper")
        monkeypatch.setenv("PLUGIN_VERSION", "1.2.3")
        stamp = datetime(2024, 3, 5, 10, 0, tzinfo=UTC)
        item = {"id": "r1", "created_at": "2024-03-05T10:00:00Z", "seen": stamp}
        digest = hashlib.sha256(json.dumps(
            {"raw_content": "<html>raw</html>", "raw_item": item}, sort_keys=True, default=str,
        ).encode()).hexdigest()[:16]
        key = f"raw/webscraper/2024/03/05/r1/{digest}.json"

        uri, s3 = _archive(item, "<html>raw</html>")

        assert uri == f"s3://raw-bucket/{key}"
        s3.put_object.assert_called_once()
        kwargs = s3.put_object.call_args.kwargs
        assert kwargs["Bucket"] == "raw-bucket"
        assert kwargs["Key"] == key
        assert kwargs["ContentType"] == "application/json"
        assert kwargs["IfNoneMatch"] == "*"
        assert kwargs["Metadata"] == {"connector": "webscraper", "connector-version": "1.2.3"}
        assert json.loads(kwargs["Body"]) == {
            "item_id": "r1",
            "source_platform": "webscraper",
            "connector": {"id": "webscraper", "version": "1.2.3"},
            "content_sha16": digest,
            "ingested_at": "2026-01-02T03:04:05+00:00",
            "partition_date": "2024-03-05",
            "raw_content": "<html>raw</html>",
            "raw_item": {"id": "r1", "created_at": "2024-03-05T10:00:00Z", "seen": "2024-03-05 10:00:00+00:00"},
        }
        assert frozen_now == [UTC]
        logger.info.assert_called_once_with(f"Stored raw data at s3://raw-bucket/{key}")

    def test_raw_content_defaults_to_null(self):
        _uri, s3 = _archive({"id": "r1"})

        assert _written(s3)[1]["raw_content"] is None


class TestVersions:
    def test_identical_content_maps_to_the_same_key(self):
        _uri, first = _archive({"id": "r1", "text": "same"}, "payload")
        _uri, second = _archive({"id": "r1", "text": "same"}, "payload")

        assert _written(first)[0] == _written(second)[0]

    @pytest.mark.parametrize(("item", "raw_content"), [
        ({"id": "r1", "text": "edited"}, "payload"),
        ({"id": "r1", "text": "same"}, "other payload"),
    ])
    def test_changed_content_is_a_new_version_in_the_same_folder(self, item, raw_content):
        _uri, first = _archive({"id": "r1", "text": "same"}, "payload")
        _uri, second = _archive(item, raw_content)

        first_key, second_key = _written(first)[0], _written(second)[0]
        assert first_key != second_key
        assert first_key.rsplit("/", 1)[0] == second_key.rsplit("/", 1)[0] == "raw/webscraper/2026/01/02/r1"

    def test_the_ingest_time_is_not_part_of_the_digest(self):
        _uri, first = _archive({"id": "r1", "created_at": "2024-03-05"})
        with patch.object(raw_archive, "datetime", _LaterDatetime):
            _uri, second = _archive({"id": "r1", "created_at": "2024-03-05"})

        assert json.loads(s3_body(first))["ingested_at"] != json.loads(s3_body(second))["ingested_at"]
        assert _written(first)[0] == _written(second)[0]

    def test_already_archived_content_returns_the_existing_uri(self, logger):
        s3 = MagicMock()
        response: Any = {"Error": {"Code": "PreconditionFailed"}, "ResponseMetadata": {"HTTPStatusCode": 412}}
        s3.put_object.side_effect = ClientError(response, "PutObject")

        uri = archive_raw_item(s3, _BUCKET, _SOURCE, {"id": "r1"})

        key = s3.put_object.call_args.kwargs["Key"]
        assert uri == f"s3://{_BUCKET}/{key}"
        logger.info.assert_called_once_with(f"Already archived raw data at s3://{_BUCKET}/{key}")
        logger.exception.assert_not_called()


class TestConnector:
    def test_a_webhook_names_itself_after_its_plugin(self, monkeypatch):
        monkeypatch.setenv("SOURCE_PLATFORM", "github_issues")
        monkeypatch.setenv("PLUGIN_VERSION", "1.0.0")
        s3 = MagicMock()

        archive_raw_item(s3, _BUCKET, "github_issues", {"id": "r1"}, transport=raw_archive.WEBHOOK)

        assert s3.put_object.call_args.kwargs["Metadata"] == {
            "connector": "webhook_github_issues", "connector-version": "1.0.0"}

    def test_the_plugin_id_is_the_lambdas_not_the_items_source(self, monkeypatch):
        monkeypatch.setenv("SOURCE_PLATFORM", "web_reviews")
        monkeypatch.delenv("PLUGIN_VERSION", raising=False)

        assert raw_archive.plugin_connector().metadata() == {"connector": "web_reviews", "connector-version": "unknown"}

    def test_no_plugin_env_is_unknown(self, monkeypatch):
        monkeypatch.delenv("SOURCE_PLATFORM", raising=False)
        monkeypatch.setenv("PLUGIN_VERSION", "")

        assert raw_archive.plugin_connector().envelope() == {"id": "unknown", "version": "unknown"}


class TestNeverRaises:
    def test_no_bucket_skips_the_write(self, logger):
        s3 = MagicMock()

        assert archive_raw_item(s3, "", _SOURCE, {"id": "r1"}) is None

        s3.put_object.assert_not_called()
        logger.warning.assert_called_once_with("RAW_DATA_BUCKET not configured, skipping S3 storage")

    def test_a_failed_write_returns_none_and_logs_it(self, logger):
        s3 = MagicMock()
        s3.put_object.side_effect = RuntimeError("denied")

        assert archive_raw_item(s3, _BUCKET, _SOURCE, {"id": "r1"}) is None

        logger.exception.assert_called_once_with("Failed to store raw data to S3: denied")
        logger.info.assert_not_called()
