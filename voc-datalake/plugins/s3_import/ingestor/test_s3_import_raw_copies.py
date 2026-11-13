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
from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, SCOPE, WS
from s3_import.ingestor import handler
from shared.test.source_profile_fixtures import seeded_source_profiles, unreadable_source_profiles

RAW = "raw-lake"
CSV = b"id,text,rating\nr1,Great app,5\nr2,Slow checkout,2\n"


@pytest.fixture
def lake(monkeypatch):
    """A stand-in S3 client (plugin tests refuse every real or moto AWS call) under no deployment profiles; each
    workspace keeps the s3_import source's PII (its own allow profile: without one, its default redacts, 7.08.00)."""
    monkeypatch.setenv("SOURCE_PLATFORM", "s3_import")
    monkeypatch.setenv("PLUGIN_VERSION", "1.4.0")
    allow = [{"id": "s3_import", "label": "S3", "pii": "allow"}]
    with seeded_source_profiles(workspaces={WS: allow, OTHER_WS: allow}):
        yield MagicMock()


def _put(s3) -> dict:
    return s3.put_object.call_args.kwargs


def _original_key(ws: str, key: str, body: bytes = CSV) -> str:
    """Where the original of staged *key* lands in workspace *ws*'s raw lake today."""
    today = datetime.now(UTC).strftime("%Y/%m/%d")
    digest = hashlib.sha256(body).hexdigest()[:16]
    return f"ws/{ws}/raw/s3_import/{today}/{raw_original.file_stem(key)}/{digest}.csv"


class TestArchiveOriginal:
    def test_the_file_is_kept_as_uploaded_with_its_connector_and_key(self, lake):
        uri = raw_original.archive_original(lake, RAW, "surveys/q1 reviews.csv", CSV, scope=SCOPE)

        put = _put(lake)
        today = datetime.now(UTC).strftime("%Y/%m/%d")
        digest = hashlib.sha256(CSV).hexdigest()[:16]
        stem = raw_original.file_stem("surveys/q1 reviews.csv")
        assert put["Key"] == f"ws/{WS}/raw/s3_import/{today}/{stem}/{digest}.csv"
        assert uri == f"s3://{RAW}/{put['Key']}"
        assert put["Body"] == CSV
        assert put["ContentType"] == "text/csv"
        assert put["IfNoneMatch"] == "*"
        assert put["Metadata"] == {"connector": "s3_import", "connector-version": "1.4.0",
                                   "original-key": "surveys/q1%20reviews.csv"}

    def test_the_same_file_in_another_workspace_lands_in_that_workspace(self, lake):
        mine = raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE)
        theirs = raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=OTHER_SCOPE)

        assert [c.kwargs["Key"] for c in lake.put_object.call_args_list] == [
            _original_key(WS, "surveys/data.csv"), _original_key(OTHER_WS, "surveys/data.csv")]
        assert (mine, theirs) == (f"s3://{RAW}/{_original_key(WS, 'surveys/data.csv')}",
                                  f"s3://{RAW}/{_original_key(OTHER_WS, 'surveys/data.csv')}")

    def test_a_reprocess_of_the_same_file_maps_to_the_same_key(self, lake):
        first = raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE)
        again = raw_original.archive_original(lake, RAW, "processed/surveys/data.csv", CSV, scope=SCOPE)
        assert first == again

    def test_the_stem_drops_processed_and_the_extension(self):
        assert raw_original.file_stem("processed/surveys/data.csv") == raw_original.file_stem("surveys/data.csv")
        assert raw_original.file_stem("surveys/data.csv") == "surveys__data"

    @pytest.mark.parametrize("profile", [
        {"id": "s3_import", "label": "S3", "pii": "redact"},
        {"id": "s3_import", "label": "S3", "pii": "allow", "retention_days": 30},
    ])
    def test_a_source_that_does_not_keep_whole_files_keeps_no_original(self, lake, profile):
        # 7.08.00: the run's workspace's own profile decides the PII policy, the deployment's its retention window.
        workspace_profile = {k: v for k, v in profile.items() if k != "retention_days"}
        with seeded_source_profiles([profile], workspaces={WS: [workspace_profile]}):
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE) is None
        lake.put_object.assert_not_called()

    def test_the_deployments_redact_policy_does_not_bind_a_workspaces_run(self, lake):
        """A workspace's run keeps its whole-file original under its own allow profile, whatever the deployment's
        profile of s3_import says about PII; only the deployment's retention window carries over."""
        with seeded_source_profiles([{"id": "s3_import", "label": "S3", "pii": "redact"}],
                                    workspaces={WS: [{"id": "s3_import", "label": "S3", "pii": "allow"}]}):
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE) is not None

    def test_a_workspace_without_a_profile_keeps_no_original(self, lake):
        """Privacy by default: with no s3_import profile of its own, a workspace's source redacts, so no copy."""
        with seeded_source_profiles([{"id": "s3_import", "label": "S3", "pii": "allow"}], workspaces={WS: []}):
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE) is None

    def test_an_unreadable_policy_keeps_no_original(self, lake):
        with unreadable_source_profiles():
            assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE) is None
        lake.put_object.assert_not_called()

    def test_an_unsupported_file_or_no_bucket_keeps_nothing(self, lake):
        assert raw_original.archive_original(lake, RAW, "surveys/notes.txt", b"x", scope=SCOPE) is None
        assert raw_original.archive_original(lake, "", "surveys/data.csv", CSV, scope=SCOPE) is None
        lake.put_object.assert_not_called()

    def test_a_failed_write_is_logged_not_raised(self, lake):
        lake.put_object.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
        assert raw_original.archive_original(lake, RAW, "surveys/data.csv", CSV, scope=SCOPE) is None


def _staged() -> MagicMock:
    """The import bucket's client serving CSV (the module's ``s3_client``, which also writes the raw original)."""
    staged = MagicMock()
    staged.head_object.return_value = {"ContentLength": len(CSV)}
    staged.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=CSV))}
    return staged


class TestProcessFile:
    def test_the_original_is_archived_and_each_item_gets_its_source_row(self, monkeypatch):
        monkeypatch.setenv("RAW_DATA_BUCKET", RAW)
        staged = _staged()
        seen: list[tuple[dict, str | None]] = []
        with offline_ingestor_construction():
            ingestor = handler.S3ImportIngestor(SCOPE)
        ingestor.normalize_item = lambda item, raw_content=None: seen.append((item, raw_content)) or item
        ingestor.send_to_queue = MagicMock(side_effect=len)
        with patch.object(handler, "s3_client", staged), \
                patch.object(handler, "archive_original") as archive, \
                patch.object(ingestor, "_record_file_run"):
            assert ingestor.process_file("import-bucket", "surveys/data.csv") == 2

        archive.assert_called_once_with(staged, RAW, "surveys/data.csv", CSV, scope=SCOPE)
        # Each item carries its CSV row to BaseIngestor.normalize_item, which archives it as raw_content.
        assert [item[RAW_SOURCE_KEY] for item, _raw in seen] == [
            {"id": "r1", "text": "Great app", "rating": "5"}, {"id": "r2", "text": "Slow checkout", "rating": "2"}]

    def test_a_run_keeps_its_original_in_its_own_workspace(self, lake, monkeypatch):
        """The same staged file run in WS and in OTHER_WS: each original under its own ``ws/{ws}/raw/`` (no collision)."""
        monkeypatch.setenv("RAW_DATA_BUCKET", RAW)
        staged = _staged()
        for scope in (SCOPE, OTHER_SCOPE):
            with offline_ingestor_construction():
                ingestor = handler.S3ImportIngestor(scope)
            ingestor.send_to_queue = MagicMock(side_effect=len)
            with patch.object(handler, "s3_client", staged), patch.object(ingestor, "_record_file_run"), \
                    patch.object(ingestor, "normalize_item", side_effect=lambda item: item):
                assert ingestor.process_file("import-bucket", "surveys/data.csv") == 2

        lake.put_object.assert_not_called()
        assert [(c.kwargs["Bucket"], c.kwargs["Key"]) for c in staged.put_object.call_args_list] == [
            (RAW, _original_key(WS, "surveys/data.csv")), (RAW, _original_key(OTHER_WS, "surveys/data.csv"))]
