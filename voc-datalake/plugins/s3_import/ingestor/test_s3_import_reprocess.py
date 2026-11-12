"""The ingestor's reprocess input (issue #144): `POST /s3-import/reprocess` sends the S3
trigger's event shape plus `execution_id` and `reprocess: True`.

Pinned here: the run's `WS#{ws}#SOURCE_RUN#s3_import` row moves to completed / error, an
archived `processed/<folder>/<file>` keeps the source label `S3 - <folder>` its
original upload had (the processor's duplicate check keys on it), and an upload
event naming its workspace behaves exactly as before. An event naming no workspace (a bare S3
trigger, the API's reprocess) runs deployment-wide as before workspaces; one naming a malformed
workspace is refused and touches nothing.
"""

import hashlib
import importlib
import io
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from _shared import raw_original
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.workspace_fixtures import EVENTS_WITH_A_MALFORMED_WORKSPACE, REFUSED, SCOPE, WS, ws_event
from s3_import.ingestor import handler
from s3_import.ingestor.handler import _get_source_from_key, lambda_handler
from shared import s3_import_runs
from shared.ingest_tables import DeploymentTable
from shared.test.source_profile_fixtures import seeded_source_profiles
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceTable

RUN_ID = "run_s3_import_20260310120000_0a1b2c3d"
CSV = b"text,rating\nGreat flight,5\nLost my bag,1\n"


def _original_key(key: str) -> str:
    """Where a deployment-wide run keeps the original of staged *key* today (``_shared/raw_original.py``)."""
    today = datetime.now(UTC).strftime("%Y/%m/%d")
    digest = hashlib.sha256(CSV).hexdigest()[:16]
    return f"raw/s3_import/{today}/{raw_original.file_stem(key)}/{digest}.csv"


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-ingestor-s3_import-test", memory_limit_in_mb=512,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-ingestor-s3_import-test",
        aws_request_id="req-s3-import-reprocess-0001", get_remaining_time_in_millis=lambda: 30_000,
    )


IMPORT_BUCKET = "import-bucket"


def _event(key: str, *, execution_id: str | None = RUN_ID, reprocess: bool = True,
           bucket: str = IMPORT_BUCKET) -> dict:
    """The S3-shaped event of a run in ``WS``."""
    event: dict = {"workspace_id": WS, "Records": [{
        "eventSource": "aws:s3", "eventName": "ObjectCreated:Put",
        "s3": {"bucket": {"name": bucket}, "object": {"key": key}},
    }]}
    if execution_id is not None:
        event["execution_id"] = execution_id
    if reprocess:
        event["reprocess"] = True
    return event


def _passthrough(item: dict, raw_content: str | None = None) -> dict:
    """A stand-in for `BaseIngestor.normalize_item` (no raw archive): the item as parsed."""
    del raw_content
    return dict(item)


@pytest.fixture
def run():
    """Run `lambda_handler` against an offline ingestor.

    Yields `(invoke, built)`: `built` records the scope and constructor kwargs, the
    `ingestor` and the boto3 aggregates `table` under its WorkspaceTable; set
    `built["queue_error"]` before invoking to make the queue send raise.
    """
    built: dict = {}
    with offline_ingestor_construction(), patch.object(handler, "s3_client") as s3, \
            patch.object(handler, "IMPORT_BUCKET", IMPORT_BUCKET):
        built["s3"] = s3
        s3.head_object.return_value = {"ContentLength": len(CSV)}
        s3.get_object.side_effect = lambda **_: {"Body": io.BytesIO(CSV)}
        real_class = handler.S3ImportIngestor

        def build(scope, **kwargs):
            built["scope"] = scope
            built["execution_id"] = kwargs.get("execution_id")
            ing = real_class(scope, **kwargs)
            # CDK sets SOURCE_PLATFORM to the plugin id; the test env's default is another source.
            ing.source_platform = "s3_import"
            built["table"] = MagicMock()
            # The table as BaseIngestor opens it (shared/ingest_tables.py): through the run's workspace, or the
            # table itself for a deployment-wide run.
            ing.aggregates_table = (DeploymentTable(built["table"]) if scope is None
                                    else WorkspaceTable(scope, built["table"]))
            if not built.get("real_queue"):
                ing.normalize_item = _passthrough
                ing.send_to_queue = MagicMock(side_effect=built.get("queue_error") or len)
            built["ingestor"] = ing
            return ing

        with patch.object(handler, "S3ImportIngestor", side_effect=build):
            yield (lambda event: lambda_handler(event, _context())), built


def _run_updates(built: dict, pk: str = f"WS#{WS}#SOURCE_RUN#s3_import") -> list[dict]:
    """Every update of the run row *pk* (``WS``'s by default) the boto3 table received, as `{field: value}`, in
    order; an update of any other row fails."""
    updates = []
    for c in built["table"].update_item.call_args_list:
        assert c.kwargs["Key"] == {"pk": pk, "sk": RUN_ID}
        names = c.kwargs["ExpressionAttributeNames"]
        values = c.kwargs["ExpressionAttributeValues"]
        updates.append({names[f"#{k}"]: values[f":{k}"] for k in (n[1:] for n in names)})
    return updates


class TestTheSourceLabel:
    @pytest.mark.parametrize(("key", "label"), [
        ("processed/reviews/may.csv", "S3 - reviews"),
        ("reviews/june.csv", "S3 - reviews"),
        ("processed/may.csv", "S3 - processed"),
        ("june.csv", "S3 - Import"),
    ])
    def test_a_reprocess_names_the_source_of_the_original_upload(self, key, label):
        assert _get_source_from_key(key, reprocess=True) == label

    def test_a_trigger_event_keeps_the_plain_folder_rule(self):
        assert _get_source_from_key("processed/reviews/may.csv") == "S3 - processed"
        assert _get_source_from_key("reviews/june.csv") == "S3 - reviews"


class TestAReprocessRun:
    def test_the_run_row_moves_from_running_to_completed_with_the_items_queued(self, run):
        invoke, built = run

        result = invoke(_event("reviews/june.csv"))

        assert result["items_processed"] == 2
        assert built["execution_id"] == RUN_ID
        assert built["scope"] == SCOPE
        updates = _run_updates(built)
        assert [u["status"] for u in updates] == ["running", "completed"]
        assert updates[-1]["items_found"] == 2
        assert "completed_at" in updates[-1]

    def test_the_run_row_is_the_workspaces_source_run_row(self, run):
        invoke, built = run

        invoke(_event("reviews/june.csv"))

        keys = [c.kwargs["Key"] for c in built["table"].update_item.call_args_list]
        assert keys == [{"pk": f"WS#{WS}#SOURCE_RUN#s3_import", "sk": RUN_ID}] * 2

    def test_an_archived_file_is_queued_under_its_original_source(self, run):
        invoke, built = run

        invoke(_event("processed/reviews/may.csv"))

        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - reviews"}

    def test_a_failure_records_the_error_type_only_and_is_not_raised_so_lambda_does_not_retry(self, run):
        invoke, built = run
        built["queue_error"] = RuntimeError("queue https://secret.example")

        with patch.object(handler, "metrics") as m:
            result = invoke(_event("reviews/june.csv"))

        assert result == {"status": "error", "error": "RuntimeError"}
        updates = _run_updates(built)
        assert [u["status"] for u in updates] == ["running", "error"]
        assert updates[-1]["errors"] == ["RuntimeError"]
        m.add_metric.assert_any_call(name="ReprocessFailed", unit="Count", value=1)

    def test_a_failed_upload_event_is_raised_again_for_lambdas_retry(self, run):
        invoke, built = run
        built["queue_error"] = RuntimeError("queue down")

        with pytest.raises(RuntimeError):
            invoke(_event("reviews/june.csv", execution_id=None, reprocess=False))

    def test_a_run_with_no_file_closes_its_row_as_completed_with_nothing(self, run):
        invoke, built = run

        result = invoke(ws_event(execution_id=RUN_ID))

        assert result["files_processed"] == 0
        assert [u["status"] for u in _run_updates(built)] == ["running", "completed"]


class TestATriggerEventIsUnchanged:
    def test_no_run_row_is_written_and_the_folder_names_the_source(self, run):
        invoke, built = run

        invoke(_event("processed/reviews/may.csv", execution_id=None, reprocess=False))

        assert built.get("execution_id") is None
        built["table"].update_item.assert_not_called()
        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - processed"}

    def test_an_empty_event_is_still_skipped(self, run):
        invoke, built = run

        assert invoke(ws_event()) == {"status": "skipped", "reason": "no records"}
        assert "ingestor" not in built


class TestAnEventNamingAMalformedWorkspace:
    """`run_in_workspace` refuses an event whose `workspace_id` is not a workspace id: nothing is read, queued or
    written, and it is never run deployment-wide instead."""

    @pytest.mark.parametrize("named", [
        *(malformed[WORKSPACE_FIELD] for malformed in EVENTS_WITH_A_MALFORMED_WORKSPACE), "ws_short",
    ])
    @pytest.mark.parametrize("event", [
        _event("reviews/june.csv", execution_id=None, reprocess=False),
        _event("reviews/june.csv"),
        {},
    ], ids=["s3-trigger", "reprocess", "empty"])
    def test_it_is_refused_and_touches_nothing(self, run, event, named):
        invoke, built = run

        assert invoke({**event, WORKSPACE_FIELD: named}) == REFUSED
        assert "ingestor" not in built
        assert built["s3"].mock_calls == []


def _no_workspace(event: dict) -> dict:
    return {k: v for k, v in event.items() if k != WORKSPACE_FIELD}


def _history_rows(built: dict) -> list[dict]:
    """The import-history rows the boto3 table was given (``shared/import_runs.py``), detail first."""
    return [c.kwargs["Item"] for c in built["table"].put_item.call_args_list]


class TestAnEventNamingNoWorkspaceRunsDeploymentWide:
    """An event that names no workspace (a plain S3 upload's trigger, the API's reprocess) runs deployment-wide, as
    before workspaces: the deployment-wide `SOURCE_RUN#s3_import` row and `IMPORT_RUN` history, the raw original
    under `raw/`, messages without `workspace_id`."""

    @pytest.fixture
    def raw_lake(self, monkeypatch):
        monkeypatch.setenv("RAW_DATA_BUCKET", "raw-lake")
        monkeypatch.setenv("PLUGIN_VERSION", "1.4.0")
        with seeded_source_profiles():
            yield

    def test_the_apis_reprocess_event_closes_the_deployment_wide_run_row(self, run):
        invoke, built = run

        result = invoke(s3_import_runs.reprocess_event(IMPORT_BUCKET, "processed/reviews/june 1.csv", RUN_ID))

        assert result["results"] == [{"file": "processed/reviews/june 1.csv", "items_processed": 2}]
        assert (built["scope"], built["execution_id"]) == (None, RUN_ID)
        assert s3_import_runs.SOURCE_RUN_PK == "SOURCE_RUN#s3_import"
        keys = [c.kwargs["Key"] for c in built["table"].update_item.call_args_list]
        assert keys == [{"pk": "SOURCE_RUN#s3_import", "sk": RUN_ID}] * 2
        updates = _run_updates(built, pk="SOURCE_RUN#s3_import")
        assert [u["status"] for u in updates] == ["running", "completed"]
        assert updates[-1]["items_found"] == 2
        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - reviews"}

    def test_the_reprocess_records_its_history_in_the_deployment_wide_partitions(self, run):
        invoke, built = run

        invoke(s3_import_runs.reprocess_event(IMPORT_BUCKET, "reviews/june.csv", RUN_ID))

        detail, summary = _history_rows(built)
        run_id = summary["run_id"]
        assert (detail["pk"], detail["sk"]) == (f"IMPORT_RUN#{run_id}", "RUN")
        assert (summary["pk"], summary["sk"]) == ("IMPORT_RUN", f"{summary['started_at']}#{run_id}")
        assert (summary["method"], summary["imported"], summary["status"]) == ("s3", 2, "completed")
        assert summary["raw_s3_key"] == f"s3://{IMPORT_BUCKET}/reviews/june.csv"

    @pytest.mark.usefixtures("raw_lake")
    def test_the_reprocess_keeps_its_original_under_the_deployment_wide_raw_prefix(self, run):
        invoke, built = run

        invoke(s3_import_runs.reprocess_event(IMPORT_BUCKET, "processed/reviews/june.csv", RUN_ID))

        (put,) = built["s3"].put_object.call_args_list
        assert put.kwargs["Bucket"] == "raw-lake"
        assert put.kwargs["Key"] == _original_key("processed/reviews/june.csv")

    def test_a_failed_reprocess_closes_the_deployment_wide_row_as_error(self, run):
        invoke, built = run
        built["queue_error"] = RuntimeError("queue down")

        with patch.object(handler, "metrics"):
            result = invoke(s3_import_runs.reprocess_event(IMPORT_BUCKET, "reviews/june.csv", RUN_ID))

        assert result == {"status": "error", "error": "RuntimeError"}
        updates = _run_updates(built, pk="SOURCE_RUN#s3_import")
        assert [u["status"] for u in updates] == ["running", "error"]
        assert updates[-1]["errors"] == ["RuntimeError"]

    @pytest.mark.usefixtures("raw_lake")
    def test_a_plain_upload_trigger_reads_the_file_archives_it_under_raw_and_queues_no_workspace(self, run):
        invoke, built = run
        built["real_queue"] = True
        queued: list[dict] = []

        def send(_sqs, _url, messages, **_kwargs) -> int:
            queued.extend(messages)
            return len(messages)

        with patch("_shared.base_ingestor.send_messages_to_queue", side_effect=send):
            result = invoke(_no_workspace(_event("reviews/june.csv", execution_id=None, reprocess=False)))

        assert (result["status"], result["items_processed"]) == ("success", 2)
        assert built["scope"] is None
        built["s3"].get_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key="reviews/june.csv")
        (put,) = built["s3"].put_object.call_args_list
        assert put.kwargs["Key"] == _original_key("reviews/june.csv")
        assert [message["text"] for message in queued] == ["Great flight", "Lost my bag"]
        assert all(WORKSPACE_FIELD not in message for message in queued)
        # No run row (no execution id); its history row is the deployment-wide one.
        built["table"].update_item.assert_not_called()
        assert [row["pk"] for row in _history_rows(built)][1] == "IMPORT_RUN"

    def test_an_empty_event_is_skipped_deployment_wide(self, run):
        invoke, built = run

        assert invoke({}) == {"status": "skipped", "reason": "no records"}
        assert "ingestor" not in built


class TestOnlyTheImportBucketIsRead:
    """The API invokes the ingestor directly, so the bucket named in an event is not trusted."""

    def test_a_record_for_another_bucket_is_skipped_without_a_read(self, run):
        invoke, built = run

        with patch.object(handler, "logger") as log:
            result = invoke(_event("reviews/june.csv", bucket="someone-elses-bucket"))

        assert result == {"status": "error", "error": "NoImportFileRead"}
        built["s3"].head_object.assert_not_called()
        built["s3"].get_object.assert_not_called()
        built["ingestor"].send_to_queue.assert_not_called()
        log.warning.assert_called_once_with(
            "Skipping a record for a bucket other than the import bucket",
            extra={"bucket": "someone-elses-bucket"})
        updates = _run_updates(built)
        assert [u["status"] for u in updates] == ["running", "error"]
        assert updates[-1]["errors"] == ["NoImportFileRead"]

    def test_an_upload_event_for_another_bucket_is_skipped_as_before(self, run):
        invoke, built = run

        result = invoke(_event("reviews/june.csv", bucket="someone-elses-bucket", execution_id=None, reprocess=False))

        assert result["status"] == "success"
        assert result["files_processed"] == 0
        built["s3"].head_object.assert_not_called()

    def test_without_a_configured_bucket_no_record_is_read(self, run):
        invoke, built = run

        with patch.object(handler, "IMPORT_BUCKET", ""):
            result = invoke(_event("reviews/june.csv"))

        assert result == {"status": "error", "error": "NoImportFileRead"}
        built["s3"].head_object.assert_not_called()

    def test_the_import_bucket_is_read(self, run):
        invoke, built = run

        invoke(_event("reviews/june.csv"))

        built["s3"].head_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key="reviews/june.csv")

    def test_the_bucket_comes_from_the_environment_the_stack_sets(self, monkeypatch):
        monkeypatch.setenv("S3_IMPORT_BUCKET", "voc-import-from-env")
        try:
            importlib.reload(handler)
            assert handler.IMPORT_BUCKET == "voc-import-from-env"
        finally:
            monkeypatch.delenv("S3_IMPORT_BUCKET")
            importlib.reload(handler)
        assert handler.IMPORT_BUCKET == ""


def _api_event(bucket: str, key: str) -> dict:
    """The event `POST /s3-import/reprocess` sends, in ``WS``.

    `reprocess_event` names no workspace yet (the API's slice adds it); without one the run is deployment-wide
    (`TestAnEventNamingNoWorkspaceRunsDeploymentWide`).
    """
    return {**s3_import_runs.reprocess_event(bucket, key, RUN_ID), "workspace_id": WS}


class TestTheApiEventEndToEnd:
    """The event `POST /s3-import/reprocess` sends (shared/s3_import_runs.py) is the one this handler reads."""

    def test_the_api_event_for_the_import_bucket_imports_the_file_and_closes_the_run(self, run):
        invoke, built = run

        result = invoke(_api_event(IMPORT_BUCKET, "processed/reviews/june 1.csv"))

        assert result["results"] == [{"file": "processed/reviews/june 1.csv", "items_processed": 2}]
        built["s3"].get_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key="processed/reviews/june 1.csv")
        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - reviews"}
        assert [u["status"] for u in _run_updates(built)] == ["running", "completed"]

    def test_the_api_event_naming_another_bucket_reads_nothing(self, run):
        invoke, built = run

        invoke(_api_event("someone-elses-bucket", "reviews/june.csv"))

        built["s3"].head_object.assert_not_called()
        built["s3"].get_object.assert_not_called()


class TestTheEndNotice:
    """A run the API started tells its starter when it ends (shared/job_notices.py, docs/realtime.md)."""

    @pytest.fixture
    def published(self):
        with patch.object(handler.job_notices.realtime, "publish", return_value=True) as publish:
            yield publish

    def test_a_completed_run_tells_its_starter(self, run, published):
        invoke, _ = run
        invoke({**_event("reviews/june.csv"), "started_by": "admin-sub"})
        published.assert_called_once_with("jobs", "admin-sub", {
            "type": "job", "job_id": RUN_ID, "status": "completed", "job_type": "s3_import_reprocess"})

    def test_a_failed_run_tells_its_starter(self, run, published):
        invoke, built = run
        built["queue_error"] = RuntimeError("boom")
        with patch.object(handler, "metrics"):
            assert invoke({**_event("reviews/june.csv"), "started_by": "admin-sub"})["status"] == "error"
        assert published.call_args.args[2]["status"] == "error"

    def test_a_lost_notice_changes_nothing(self, run, published):
        published.return_value = False
        invoke, _ = run
        assert invoke({**_event("reviews/june.csv"), "started_by": "admin-sub"})["items_processed"] == 2

    def test_an_upload_trigger_has_no_starter_and_sends_nothing(self, run, published):
        invoke, _ = run
        invoke(_event("reviews/june.csv", execution_id=None, reprocess=False))
        published.assert_not_called()

    def test_the_api_passes_the_starter_in_the_event(self):
        assert s3_import_runs.reprocess_event("b", "k.csv", RUN_ID, "admin-sub")["started_by"] == "admin-sub"
        assert "started_by" not in s3_import_runs.reprocess_event("b", "k.csv", RUN_ID)
