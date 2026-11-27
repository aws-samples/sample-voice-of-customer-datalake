"""An upload into a workspace's folder of the import bucket is ingested in that workspace.

The bucket's object-created notification names no workspace; the handler reads it from each record's key: a record
of ``ws/{ws}/<more>`` with a well-formed ``{ws}`` runs in ``ws`` (``run_in_workspace``, so its not-active refusal and
metrics are the shared ones), every other record stays in one deployment-wide run, exactly as before. An event that
names ``workspace_id``, ``execution_id`` or ``reprocess`` is never routed by its keys.
"""

import hashlib
import urllib.parse
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from _shared import base_ingestor, raw_original
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.s3_import_fixtures import queued_messages, serve_staged_file, with_raw_lake
from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, REFUSED, SCOPE, WS
from s3_import.ingestor import handler
from s3_import.ingestor.handler import lambda_handler
from shared.ingest_tables import DeploymentTable
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceTable

IMPORT_BUCKET = "import-bucket"
CSV = b"text,rating\nGreat flight,5\nLost my bag,1\n"
NOT_ACTIVE = {"status": "refused", "reason": "workspace_not_active"}


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-ingestor-s3_import-test", memory_limit_in_mb=512,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-ingestor-s3_import-test",
        aws_request_id="req-s3-import-routing-0001", get_remaining_time_in_millis=lambda: 30_000,
    )


def _record(key: str, bucket: str = IMPORT_BUCKET) -> dict:
    return {"eventSource": "aws:s3", "eventName": "ObjectCreated:Put",
            "s3": {"bucket": {"name": bucket}, "object": {"key": key}}}


def _upload(*keys: str, **fields: object) -> dict:
    """The bucket's own notification for *keys* (no workspace, no execution id, no reprocess), plus *fields*."""
    return {"Records": [_record(key) for key in keys], **fields}


def _original_key(prefix: str, staged: str) -> str:
    today = datetime.now(UTC).strftime("%Y/%m/%d")
    digest = hashlib.sha256(CSV).hexdigest()[:16]
    return f"{prefix}raw/s3_import/{today}/{raw_original.file_stem(staged)}/{digest}.csv"


@pytest.fixture
def run():
    """Run ``lambda_handler`` against offline ingestors. Yields ``(invoke, runs, s3)``: ``runs`` is every ingestor
    built, in order, each ``{"scope", "execution_id", "ingestor", "table", "files"}``; ``files`` the keys it was asked
    to process. ``queue_errors[ws or None]`` makes that run's queue send raise."""
    runs: list[dict] = []
    queue_errors: dict = {}
    with offline_ingestor_construction(), patch.object(handler, "s3_client") as s3, \
            patch.object(handler, "IMPORT_BUCKET", IMPORT_BUCKET):
        serve_staged_file(s3, CSV)
        real_class = handler.S3ImportIngestor

        def build(scope, **kwargs):
            ing = real_class(scope, **kwargs)
            ing.source_platform = "s3_import"
            table = MagicMock()
            ing.aggregates_table = DeploymentTable(table) if scope is None else WorkspaceTable(scope, table)
            ws = None if scope is None else scope.ws
            if not queue_errors.get("real_queue"):
                ing.normalize_item = lambda item, *_args, **_kwargs: dict(item)
                ing.send_to_queue = MagicMock(side_effect=queue_errors.get(ws) or len)
            entry = {"scope": scope, "execution_id": kwargs.get("execution_id"), "ingestor": ing, "table": table,
                     "files": []}
            real_process = ing.process_file

            def process_file(bucket, key, **kw):
                entry["files"].append(key)
                return real_process(bucket, key, **kw)

            ing.process_file = process_file
            runs.append(entry)
            return ing

        with patch.object(handler, "S3ImportIngestor", side_effect=build):
            yield (lambda event: lambda_handler(event, _context())), runs, s3, queue_errors


def _history(entry: dict) -> list[dict]:
    return [c.kwargs["Item"] for c in entry["table"].put_item.call_args_list]


class TestAnUploadInAWorkspaceFolderRunsInThatWorkspace:
    @pytest.fixture
    def raw_lake(self, monkeypatch):
        with with_raw_lake(monkeypatch, workspaces={WS: [{"id": "s3_import", "pii": "allow"}]}):
            yield

    @pytest.mark.usefixtures("raw_lake")
    def test_its_messages_raw_copy_and_history_are_the_workspaces(self, run):
        invoke, runs, s3, options = run
        options["real_queue"] = True

        key = f"ws/{WS}/src/f.csv"
        with queued_messages() as queued:
            result = invoke(_upload(key))

        assert result == {"status": "success", "files_processed": 1, "items_processed": 2,
                          "results": [{"file": key, "items_processed": 2}]}
        [entry] = runs
        assert (entry["scope"], entry["execution_id"], entry["files"]) == (SCOPE, None, [key])
        s3.get_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key=key)
        assert [m["text"] for m in queued] == ["Great flight", "Lost my bag"]
        assert {m[WORKSPACE_FIELD] for m in queued} == {WS}
        (put,) = s3.put_object.call_args_list
        assert (put.kwargs["Bucket"], put.kwargs["Key"]) == ("raw-lake", _original_key(f"ws/{WS}/", "src/f.csv"))
        detail, summary = _history(entry)
        assert summary["pk"] == f"WS#{WS}#IMPORT_RUN"
        assert detail["pk"].startswith(f"WS#{WS}#IMPORT_RUN#")
        assert (summary["source"], summary["imported"]) == ("S3 - src", 2)
        assert summary["raw_s3_key"] == f"s3://{IMPORT_BUCKET}/{key}"

    def test_an_encoded_key_is_routed_by_its_decoded_form(self, run):
        invoke, runs, s3, _ = run
        key = f"ws/{WS}/src/june 1.csv"

        result = invoke(_upload(urllib.parse.quote_plus(key)))

        assert result["results"] == [{"file": key, "items_processed": 2}]
        [entry] = runs
        assert entry["scope"] == SCOPE
        s3.get_object.assert_called_once_with(Bucket=IMPORT_BUCKET, Key=key)

    def test_a_workspace_that_is_not_active_is_refused_and_nothing_is_written(self, run, monkeypatch):
        invoke, runs, s3, _ = run
        monkeypatch.setattr(base_ingestor, "workspace_active", lambda scope: scope.ws != WS)

        with patch.object(base_ingestor, "metrics") as m:
            result = invoke(_upload(f"ws/{WS}/src/f.csv"))

        assert result == NOT_ACTIVE
        assert runs == []
        assert s3.mock_calls == []
        m.add_metric.assert_any_call(name="IngestorWorkspaceNotActive", unit="Count", value=1)

    @pytest.mark.parametrize("key", [
        "ws/acme-outfitters/src/f.csv", f"ws/{WS}x/src/f.csv", f"ws/{WS.lower()}/src/f.csv",
        f"ws/ {WS}/src/f.csv", "ws//src/f.csv", "ws/../src/f.csv",
    ])
    def test_a_malformed_workspace_id_still_gets_the_deployment_runs_unread_refusal(self, run, key):
        invoke, runs, s3, _ = run

        with patch.object(handler, "metrics") as m:
            result = invoke(_upload(key))

        assert result["results"] == [{"file": key, "items_processed": 0}]
        [entry] = runs
        assert entry["scope"] is None
        assert s3.mock_calls == []
        m.add_metric.assert_any_call(name="ImportFileInWorkspaceFolder", unit="Count", value=1)
        [_detail, summary] = _history(entry)
        assert (summary["pk"], summary["source"]) == ("IMPORT_RUN", "S3 - Import")


class TestAnEventOfSeveralPlaces:
    def test_a_deployment_file_and_a_workspace_file_each_run_in_their_place(self, run):
        invoke, runs, _s3, _ = run
        mine, deployment = f"ws/{WS}/src/f.csv", "reviews/a.csv"

        result = invoke(_upload(deployment, mine))

        assert [(e["scope"], e["files"]) for e in runs] == [(None, [deployment]), (SCOPE, [mine])]
        assert result == {"status": "success", "files_processed": 2, "items_processed": 4,
                          "results": [{"file": deployment, "items_processed": 2}, {"file": mine, "items_processed": 2}]}
        assert _history(runs[0])[1]["pk"] == "IMPORT_RUN"
        assert _history(runs[1])[1]["pk"] == f"WS#{WS}#IMPORT_RUN"

    def test_two_workspaces_each_run_their_own_records_in_order(self, run):
        invoke, runs, _s3, _ = run
        a1, b1, a2 = f"ws/{WS}/src/1.csv", f"ws/{OTHER_WS}/src/1.csv", f"ws/{WS}/src/2.csv"

        result = invoke(_upload(a1, b1, a2))

        assert [(e["scope"], e["files"]) for e in runs] == [(SCOPE, [a1, a2]), (OTHER_SCOPE, [b1])]
        assert result["files_processed"] == 3
        assert [r["file"] for r in result["results"]] == [a1, a2, b1]
        assert _history(runs[1])[1]["pk"] == f"WS#{OTHER_WS}#IMPORT_RUN"

    def test_a_refused_workspace_does_not_stop_the_others(self, run, monkeypatch):
        invoke, runs, _s3, _ = run
        monkeypatch.setattr(base_ingestor, "workspace_active", lambda scope: scope.ws != WS)
        refused, kept = f"ws/{WS}/src/f.csv", "reviews/a.csv"

        result = invoke(_upload(refused, kept))

        assert [(e["scope"], e["files"]) for e in runs] == [(None, [kept])]
        assert result == {"status": "partial", "files_processed": 1, "items_processed": 2,
                          "results": [{"file": kept, "items_processed": 2}],
                          "refused": [{"workspace_id": WS, "reason": "workspace_not_active", "files": [refused]}]}

    @pytest.mark.parametrize("failing", [WS, None], ids=["workspace-fails", "deployment-fails"])
    def test_a_failing_group_is_raised_after_every_other_group_ran(self, run, failing):
        """Lambda retries the whole event (the processor skips duplicates), so the error is raised again, but only
        after every other place's records were run in this attempt."""
        invoke, runs, _s3, options = run
        options[failing] = RuntimeError("queue down")

        with pytest.raises(RuntimeError, match="queue down"):
            invoke(_upload(f"ws/{WS}/src/f.csv", "reviews/a.csv", f"ws/{OTHER_WS}/src/g.csv"))

        assert [e["scope"] for e in runs] == [SCOPE, None, OTHER_SCOPE]
        assert all(e["ingestor"].send_to_queue.called for e in runs)


class TestAnEventThatNamesItsRunIsNeverRoutedByKey:
    KEY = f"ws/{WS}/src/f.csv"

    def test_a_named_workspace_is_kept_even_when_the_key_is_another_workspaces(self, run):
        invoke, runs, s3, _ = run

        result = invoke(_upload(self.KEY, workspace_id=OTHER_WS))

        [entry] = runs
        assert entry["scope"] == OTHER_SCOPE
        assert result["results"] == [{"file": self.KEY, "items_processed": 0}]
        assert s3.mock_calls == []

    @pytest.mark.parametrize("named", [None, "", "acme-outfitters", 7])
    def test_a_malformed_named_workspace_is_refused_not_routed(self, run, named):
        invoke, runs, s3, _ = run

        assert invoke(_upload(self.KEY, workspace_id=named)) == REFUSED
        assert runs == []
        assert s3.mock_calls == []

    @pytest.mark.parametrize("fields", [
        {"execution_id": "run_s3_import_20260310120000_0a1b2c3d"},
        {"execution_id": None},
        {"reprocess": True},
        {"reprocess": True, "execution_id": "run_s3_import_20260310120000_0a1b2c3d"},
    ], ids=["execution-id", "execution-id-none", "reprocess", "reprocess-with-run"])
    def test_an_execution_id_or_a_reprocess_runs_deployment_wide_as_today(self, run, fields):
        invoke, runs, s3, _ = run

        with patch.object(handler, "metrics"):
            invoke(_upload(self.KEY, **fields))

        [entry] = runs
        assert entry["scope"] is None
        assert entry["files"] == [self.KEY]
        assert s3.mock_calls == []


class TestADeploymentUploadIsExactlyAsBefore:
    def test_one_deployment_run_of_the_event_itself(self, run):
        invoke, runs, _s3, _ = run
        event = _upload("reviews/a.csv", "ws/x.csv", "b.json", "ws/acme/src/f.csv")

        with patch.object(handler, "run_in_workspace", wraps=handler.run_in_workspace) as entry_point:
            result = invoke(event)

        entry_point.assert_called_once()
        assert entry_point.call_args.args[0] is event
        [entry] = runs
        assert entry["scope"] is None
        assert entry["files"] == ["reviews/a.csv", "ws/x.csv", "b.json", "ws/acme/src/f.csv"]
        assert set(result) == {"status", "files_processed", "items_processed", "results"}

    def test_a_record_for_another_bucket_stays_in_the_deployment_run(self, run):
        invoke, runs, s3, _ = run
        event = {"Records": [_record(f"ws/{WS}/src/f.csv", bucket="someone-elses-bucket")]}

        result = invoke(event)

        [entry] = runs
        assert entry["scope"] is None
        assert result["files_processed"] == 0
        assert s3.mock_calls == []
