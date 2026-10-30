"""The ingestor's reprocess input (issue #144): `POST /s3-import/reprocess` sends the S3
trigger's event shape plus `execution_id` and `reprocess: True`.

Pinned here: the run's `SOURCE_RUN#s3_import` row moves to completed / error, an
archived `processed/<folder>/<file>` keeps the source label `S3 - <folder>` its
original upload had (the processor's duplicate check keys on it), and a plain
trigger event behaves exactly as before.
"""

import importlib
import io
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.ingestor_fixtures import offline_ingestor_construction
from s3_import.ingestor import handler
from s3_import.ingestor.handler import _get_source_from_key, lambda_handler
from shared import s3_import_runs

RUN_ID = "run_s3_import_20260310120000_0a1b2c3d"
CSV = b"text,rating\nGreat flight,5\nLost my bag,1\n"


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-ingestor-s3_import-test", memory_limit_in_mb=512,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-ingestor-s3_import-test",
        aws_request_id="req-s3-import-reprocess-0001", get_remaining_time_in_millis=lambda: 30_000,
    )


IMPORT_BUCKET = "import-bucket"


def _event(key: str, *, execution_id: str | None = RUN_ID, reprocess: bool = True,
           bucket: str = IMPORT_BUCKET) -> dict:
    event: dict = {"Records": [{
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

    Yields `(invoke, built)`: `built` records the constructor kwargs and the
    `ingestor`; set `built["queue_error"]` before invoking to make the queue send raise.
    """
    built: dict = {}
    with offline_ingestor_construction(), patch.object(handler, "s3_client") as s3, \
            patch.object(handler, "IMPORT_BUCKET", IMPORT_BUCKET):
        built["s3"] = s3
        s3.head_object.return_value = {"ContentLength": len(CSV)}
        s3.get_object.side_effect = lambda **_: {"Body": io.BytesIO(CSV)}
        real_class = handler.S3ImportIngestor

        def build(**kwargs):
            built["execution_id"] = kwargs.get("execution_id")
            ing = real_class(**kwargs)
            # CDK sets SOURCE_PLATFORM to the plugin id; the test env's default is another source.
            ing.source_platform = "s3_import"
            ing.aggregates_table = MagicMock()
            ing.normalize_item = _passthrough
            ing.send_to_queue = MagicMock(side_effect=built.get("queue_error") or len)
            built["ingestor"] = ing
            return ing

        with patch.object(handler, "S3ImportIngestor", side_effect=build):
            yield (lambda event: lambda_handler(event, _context())), built


def _run_updates(ingestor) -> list[dict]:
    """Every `SOURCE_RUN#` update as `{field: value}`, in order."""
    updates = []
    for c in ingestor.aggregates_table.update_item.call_args_list:
        assert c.kwargs["Key"] == {"pk": "SOURCE_RUN#s3_import", "sk": RUN_ID}
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
        updates = _run_updates(built["ingestor"])
        assert [u["status"] for u in updates] == ["running", "completed"]
        assert updates[-1]["items_found"] == 2
        assert "completed_at" in updates[-1]

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
        updates = _run_updates(built["ingestor"])
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

        result = invoke({"execution_id": RUN_ID})

        assert result["files_processed"] == 0
        assert [u["status"] for u in _run_updates(built["ingestor"])] == ["running", "completed"]


class TestATriggerEventIsUnchanged:
    def test_no_run_row_is_written_and_the_folder_names_the_source(self, run):
        invoke, built = run

        invoke(_event("processed/reviews/may.csv", execution_id=None, reprocess=False))

        assert built.get("execution_id") is None
        built["ingestor"].aggregates_table.update_item.assert_not_called()
        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - processed"}

    def test_an_empty_event_is_still_skipped(self, run):
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
        updates = _run_updates(built["ingestor"])
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


class TestTheApiEventEndToEnd:
    """The event `POST /s3-import/reprocess` sends (shared/s3_import_runs.py) is the one this handler reads."""

    def test_the_api_event_for_the_import_bucket_imports_the_file_and_closes_the_run(self, run):
        invoke, built = run

        result = invoke(s3_import_runs.reprocess_event(IMPORT_BUCKET, "processed/reviews/june 1.csv", RUN_ID))

        assert result["results"] == [{"file": "processed/reviews/june 1.csv", "items_processed": 2}]
        built["s3"].get_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key="processed/reviews/june 1.csv")
        [batch] = [c.args[0] for c in built["ingestor"].send_to_queue.call_args_list]
        assert {item["source_platform_override"] for item in batch} == {"S3 - reviews"}
        assert [u["status"] for u in _run_updates(built["ingestor"])] == ["running", "completed"]

    def test_the_api_event_naming_another_bucket_reads_nothing(self, run):
        invoke, built = run

        invoke(s3_import_runs.reprocess_event("someone-elses-bucket", "reviews/june.csv", RUN_ID))

        built["s3"].head_object.assert_not_called()
        built["s3"].get_object.assert_not_called()
