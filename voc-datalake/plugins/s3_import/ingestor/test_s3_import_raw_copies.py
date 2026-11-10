"""S3 import raw copies: the staged file as uploaded (``_shared/raw_original.py``) and each row's source.

The original is kept only when the s3_import profile keeps whole files (allow, no retention), via
GetObject + a conditional put; every item's archive carries the CSV row / JSON object it came from.
"""
import hashlib
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared import raw_original
from _shared.raw_source import RAW_SOURCE_KEY
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from s3_import.ingestor import handler
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

RAW = "raw-lake"
CSV = b"id,text,rating\nr1,Great app,5\nr2,Slow checkout,2\n"


@pytest.fixture
def lake(monkeypatch):
    """A stand-in S3 client (plugin tests refuse every real or moto AWS call) under no profiles."""
    monkeypatch.setenv("SOURCE_PLATFORM", "s3_import")
    monkeypatch.setenv("PLUGIN_VERSION", "1.4.0")
    with seeded_source_profiles():
        yield MagicMock()


def _put(s3) -> dict:
    return s3.put_object.call_args.kwargs


class TestArchiveOriginal:
    def test_the_file_is_kept_as_uploaded_with_its_connector_and_key(self, lake):
        uri = raw_original.archive_original(lake, RAW, "surveys/q1 reviews.csv", CSV)

        put = _put(lake)
        today = datetime.now(UTC).strftime("%Y/%m/%d")
        digest = hashlib.sha256(CSV).hexdigest()[:16]
        stem = raw_original.file_stem("surveys/q1 reviews.csv")
        assert put["Key"] == f"raw/s3_import/{today}/{stem}/{digest}.csv"
        assert uri == f"s3://{RAW}/{put['Key']}"
        assert put["Body"] == CSV
        assert put["ContentType"] == "text/csv"
        assert put["IfNoneMatch"] == "*"
        assert put["Metadata"] == {"connector": "s3_import", "connector-version": "1.4.0",
                                   "original-key": "surveys/q1%20reviews.csv"}

    def test_a_reprocess_of_the_same_file_maps_to_the_same_key(self, lake):
        first = raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV)
        again = raw_original.archive_original(lake, RAW, "processed/surveys/data.csv", CSV)
        assert first == again

    def test_the_stem_drops_processed_and_the_extension(self):
        assert raw_original.file_stem("processed/surveys/data.csv") == raw_original.file_stem("surveys/data.csv")
        assert raw_original.file_stem("surveys/data.csv") == "surveys__data"

    @pytest.mark.parametrize("profile", [
        {"id": "s3_import", "label": "S3", "pii": "redact"},
        {"id": "s3_import", "label": "S3", "pii": "allow", "retention_days": 30},
    ])
    def test_a_source_that_does_not_keep_whole_files_keeps_no_original(self, lake, profile):
        with seeded_source_profiles([profile]):
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV) is None
        lake.put_object.assert_not_called()

    def test_an_unreadable_policy_keeps_no_original(self, lake):
        with unreadable_source_profiles():
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV) is None
        lake.put_object.assert_not_called()

    def test_an_unsupported_file_or_no_bucket_keeps_nothing(self, lake):
        assert raw_original.archive_original(lake, RAW, "surveys/notes.txt", b"x") is None
        assert raw_original.archive_original(lake, "", "surveys/data.csv", CSV) is None
        lake.put_object.assert_not_called()

    def test_a_failed_write_is_logged_not_raised(self, lake):
        lake.put_object.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
        assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV) is None


class TestProcessFile:
    def test_the_original_is_archived_and_each_item_gets_its_source_row(self, monkeypatch):
        monkeypatch.setenv("RAW_DATA_BUCKET", RAW)
        staged = MagicMock()
        staged.head_object.return_value = {"ContentLength": len(CSV)}
        staged.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=CSV))}
        seen: list[tuple[dict, str | None]] = []
        with offline_ingestor_construction():
            ingestor = handler.S3ImportIngestor()
        ingestor.normalize_item = lambda item, raw_content=None: seen.append((item, raw_content)) or item
        ingestor.send_to_queue = MagicMock(side_effect=len)
        with patch.object(handler, "s3_client", staged), \
                patch.object(handler, "archive_original") as archive, \
                patch.object(ingestor, "_record_file_run"):
            assert ingestor.process_file("import-bucket", "surveys/data.csv") == 2

        archive.assert_called_once_with(staged, RAW, "surveys/data.csv", CSV)
        # Each item carries its CSV row to BaseIngestor.normalize_item, which archives it as raw_content.
        assert [item[RAW_SOURCE_KEY] for item, _raw in seen] == [
            {"id": "r1", "text": "Great app", "rating": "5"}, {"id": "r2", "text": "Slow checkout", "rating": "2"}]
