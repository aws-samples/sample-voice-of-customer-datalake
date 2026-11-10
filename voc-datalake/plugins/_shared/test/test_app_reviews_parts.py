"""Time-budgeted app-review runs (`_shared/app_reviews_parts.py`, 5.47.00).

"Run all" over ten iOS apps (~100 s each) passed the 15-minute Lambda timeout and
left the run row `running`. These tests drive the REAL `BaseIngestor.run` and
`AppReviewsIngestor.run_for_event` through a whole chain of parts: each part's
async self-invoke is captured and fed to the next invocation, the way Lambda
would, against a fake run row that applies the `SET` updates.

Only the parts the chain does not depend on are stubbed: the review stores (a
fake collector that advances a fake clock), the SQS send and raw archive, the
audit log and the circuit breaker.
"""
import re
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared import app_reviews_parts as parts
from _shared.app_reviews_parts import (
    CONTINUATION_KEY,
    MIN_APP_RESERVE_SECONDS,
    Carried,
    InvalidContinuationError,
    RunBudget,
    configs_for_event,
    continuation_event,
    parse_continuation,
    run_row_updates,
    start_next_part,
)
from _shared.app_reviews_utils import MAX_RUN_WARNINGS, AppReviewsIngestor
from _shared.test.ingestor_fixtures import offline_ingestor_construction, with_mock_circuit_breaker
from _shared.test.scoped_secret import scoped_secret

LAMBDA_TIMEOUT_SECONDS = 900
APP_SECONDS = 100  # one app's collection on the fake clock (a real iOS app: 90-110 s)
TEN_APPS = tuple(f"App{n}" for n in range(10))


@dataclass
class _App:
    name: str
    store_id: str
    enabled: bool = True
    frequency_minutes: int | None = None
    sort_by: str = ""


class FakeRunRow:
    """A `SOURCE_RUN#` row: applies `update_item`'s `SET` expression to one dict per key."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}
        self.writes: list[dict] = []

    def update_item(self, *, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        row = self.rows.setdefault((Key["pk"], Key["sk"]), {})
        write = {}
        for name, value in re.findall(r"(#\w+) = (:\w+)", UpdateExpression):
            write[ExpressionAttributeNames[name]] = ExpressionAttributeValues[value]
        row.update(write)
        self.writes.append(write)


class FakeWatermarks:
    """The watermarks table: `get_item` / `put_item` on one dict."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get_item(self, *, Key) -> dict:
        value = self.values.get(Key["source"])
        return {"Item": {"value": value}} if value is not None else {}

    def put_item(self, *, Item) -> None:
        self.values[Item["source"]] = Item["value"]


class FakeLambdaRuntime:
    """The pieces of Lambda a chain needs: a per-invocation clock and the async queue."""

    def __init__(self) -> None:
        self.elapsed = 0.0
        self.queued: list[dict] = []
        self.collected: list[str] = []
        self.failing_apps: set[str] = set()

    def context(self) -> SimpleNamespace:
        self.elapsed = 0.0
        return SimpleNamespace(
            get_remaining_time_in_millis=lambda: int((LAMBDA_TIMEOUT_SECONDS - self.elapsed) * 1000)
        )

    def collect(self, app: _App) -> list[dict]:
        self.elapsed += APP_SECONDS
        self.collected.append(app.name)
        if app.name in self.failing_apps:
            raise ConnectionError("store unreachable")
        return [{"id": f"{app.name}-r1"}]


class _Ingestor(AppReviewsIngestor[_App]):
    PLATFORM_LABEL = "iOS"
    DATE_FIELD = "at"
    DEFAULT_SORT_BY = "most_recent"
    app_names: tuple[str, ...] = TEN_APPS
    # Set per invocation by `_invocation`.
    fake_runtime: FakeLambdaRuntime
    fake_run_row: FakeRunRow
    fake_watermarks: FakeWatermarks

    def __init__(self, execution_id: str | None = None):
        super().__init__(execution_id=execution_id)
        with_mock_circuit_breaker(self)
        self.aggregates_table = self.fake_run_row
        self.watermarks_table = self.fake_watermarks

    def _load_app_configs(self) -> list[_App]:
        return [_App(name, f"id-{name.lower()}") for name in self.app_names]

    def app_identifier(self, app: _App) -> str:
        return app.store_id

    def _collect_reviews_for_app(self, app: _App) -> list[dict]:
        return self.fake_runtime.collect(app)

    def _format_review(self, review: dict, app: _App) -> dict:
        return {"id": review["id"], "app": app.name}

    # The SQS / raw-archive side is not what this suite is about.
    def normalize_item(self, item: dict, raw_content: str | None = None) -> dict:  # noqa: ARG002 — overrides the base signature
        return item

    def send_to_queue(self, items: list[dict]) -> int:
        return len(items)


@pytest.fixture
def runtime() -> FakeLambdaRuntime:
    return FakeLambdaRuntime()


@pytest.fixture
def run_row() -> FakeRunRow:
    return FakeRunRow()


@contextmanager
def _invocation(
    runtime: FakeLambdaRuntime, run_row: FakeRunRow, start_part: Callable | None = None,
    watermarks: FakeWatermarks | None = None,
):
    """One Lambda invocation's patches; yields the `start_next_part` mock."""
    with (
        offline_ingestor_construction(),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(frequency_minutes="60")),
        patch("_shared.base_ingestor.emit_audit_event"),
        patch.object(parts, "start_next_part", side_effect=start_part or runtime.queued.append) as start,
        patch.object(_Ingestor, "fake_runtime", runtime, create=True),
        patch.object(_Ingestor, "fake_run_row", run_row, create=True),
        patch.object(_Ingestor, "fake_watermarks", watermarks or FakeWatermarks(), create=True),
    ):
        yield start


def _run_chain(runtime: FakeLambdaRuntime, run_row: FakeRunRow, event: dict, *, max_parts: int = 20) -> list[dict]:
    """Invoke like Lambda: the first event, then every queued part, until none is left."""
    results = []
    pending = [event]
    while pending:
        assert len(results) < max_parts, "the chain did not end"
        with _invocation(runtime, run_row):
            results.append(_Ingestor.run_for_event(pending.pop(0), runtime.context()))
        pending.extend(runtime.queued)
        runtime.queued.clear()
    return results


def _row(run_row: FakeRunRow, execution_id: str = "run_1") -> dict:
    return run_row.rows[("SOURCE_RUN#test_source", execution_id)]


class TestTenAppsRunInParts:
    def test_every_app_is_collected_exactly_once_in_order(self, runtime, run_row):
        results = _run_chain(runtime, run_row, {"execution_id": "run_1"})
        assert runtime.collected == list(TEN_APPS)
        # 900 s, a 240 s reserve and 100 s an app: seven apps fit the first part.
        assert len(results) == 2
        assert all(result["status"] == "success" for result in results)

    def test_without_parts_the_run_would_not_fit_one_invocation(self):
        assert len(TEN_APPS) * APP_SECONDS > LAMBDA_TIMEOUT_SECONDS

    def test_the_row_is_completed_once_with_the_total_of_every_part(self, runtime, run_row):
        _run_chain(runtime, run_row, {"execution_id": "run_1"})
        row = _row(run_row)
        assert row["status"] == "completed"
        assert row["items_found"] == len(TEN_APPS)
        statuses = [write["status"] for write in run_row.writes if "status" in write]
        assert statuses == ["running", "running", "completed"]

    def test_the_hand_off_writes_the_running_total_not_completed(self, runtime, run_row):
        with _invocation(runtime, run_row):
            _Ingestor.run_for_event({"execution_id": "run_1"}, runtime.context())
        assert _row(run_row)["status"] == "running"
        assert _row(run_row)["items_found"] == 7
        (event,) = runtime.queued
        assert event["execution_id"] == "run_1"
        assert [app["name"] for app in event[CONTINUATION_KEY]["apps"]] == ["App7", "App8", "App9"]
        assert event[CONTINUATION_KEY]["items_found"] == 7
        assert event[CONTINUATION_KEY]["part"] == 2

    def test_a_later_part_keeps_the_first_parts_start_time(self, runtime, run_row):
        _run_chain(runtime, run_row, {"execution_id": "run_1"})
        assert [write for write in run_row.writes if "started_at" in write] == [run_row.writes[0]]

    def test_a_long_list_takes_as_many_parts_as_it_needs(self, runtime, run_row):
        with patch.object(_Ingestor, "app_names", tuple(f"App{n}" for n in range(25))):
            results = _run_chain(runtime, run_row, {"execution_id": "run_1"})
        assert len(runtime.collected) == 25
        assert len(set(runtime.collected)) == 25
        assert len(results) == 4  # 7 + 7 + 7 + 4
        assert _row(run_row)["items_found"] == 25


class TestAFailingApp:
    def test_its_failure_reaches_the_final_row_and_the_rest_still_run(self, runtime, run_row):
        runtime.failing_apps = {"App2", "App8"}
        _run_chain(runtime, run_row, {"execution_id": "run_1"})
        row = _row(run_row)
        assert runtime.collected == list(TEN_APPS)
        assert row["status"] == "completed"
        assert row["items_found"] == 8
        # Part 1's warning travelled with the continuation; part 2 added its own.
        assert row["errors"] == ["App2: collection failed (ConnectionError)", "App8: collection failed (ConnectionError)"]

    def test_a_part_that_raises_keeps_the_earlier_parts_totals_and_warnings(self, runtime, run_row):
        event = continuation_event(
            execution_id="run_1", apps=[("id-app8", "App8")], items_found=7,
            warnings=["App2: collection failed (ConnectionError)"], part=2,
        )
        with (
            _invocation(runtime, run_row),
            patch.object(_Ingestor, "send_to_queue", side_effect=RuntimeError("queue down")),
            pytest.raises(RuntimeError, match="queue down"),
        ):
            _Ingestor.run_for_event(event, runtime.context())
        row = _row(run_row)
        assert row["status"] == "error"
        assert row["items_found"] == 7
        assert row["errors"] == ["App2: collection failed (ConnectionError)", "RuntimeError"]


class TestAFailedHandOff:
    @pytest.mark.parametrize("error", [
        RuntimeError("async invoke answered 500"),
        ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "Invoke"),
    ])
    def test_the_run_ends_as_error_naming_the_apps_left(self, runtime, run_row, error):
        with _invocation(runtime, run_row, start_part=MagicMock(side_effect=error)):
            _Ingestor.run_for_event({"execution_id": "run_1"}, runtime.context())
        row = _row(run_row)
        assert row["status"] == "error"
        assert row["items_found"] == 7
        assert row["errors"] == [f"3 apps not run: the next part could not start ({type(error).__name__})"]
        assert "completed_at" in row

    def test_the_warning_list_stays_bounded_with_the_failure_last(self, runtime, run_row):
        runtime.failing_apps = set(TEN_APPS)
        carried = [f"w{n}" for n in range(MAX_RUN_WARNINGS)]
        event = continuation_event(
            execution_id="run_1", apps=[(f"id-{n.lower()}", n) for n in TEN_APPS],
            items_found=0, warnings=carried, part=2,
        )
        with _invocation(runtime, run_row, start_part=MagicMock(side_effect=RuntimeError)):
            _Ingestor.run_for_event(event, runtime.context())
        errors = _row(run_row)["errors"]
        assert len(errors) == MAX_RUN_WARNINGS
        assert errors[-1].startswith("3 apps not run")


class TestRunsThatNeedNoParts:
    def test_a_single_app_run_never_hands_off_even_out_of_time(self, runtime, run_row):
        with _invocation(runtime, run_row) as start:
            context = SimpleNamespace(get_remaining_time_in_millis=lambda: 1)
            _Ingestor.run_for_event({"execution_id": "run_1", "app_id": "id-app3"}, context)
        assert runtime.collected == ["App3"]
        assert start.call_count == 0
        assert _row(run_row)["status"] == "completed"

    def test_without_a_lambda_context_every_app_runs_in_one_go(self, runtime, run_row):
        with _invocation(runtime, run_row) as start:
            _Ingestor.run_for_event({"execution_id": "run_1"})
        assert runtime.collected == list(TEN_APPS)
        assert start.call_count == 0


class TestScheduledRuns:
    def test_parts_carry_no_execution_id_and_keep_the_due_check(self, runtime, run_row):
        watermarks = FakeWatermarks()
        with _invocation(runtime, run_row, watermarks=watermarks):
            _Ingestor.run_for_event({}, runtime.context())
            (event,) = runtime.queued
            assert "execution_id" not in event
            # An app the next part carries but that ran meanwhile is skipped as not due.
            watermarks.values["test_source#App7_last_run"] = "2999-01-01T00:00:00+00:00"
            runtime.queued.clear()
            _Ingestor.run_for_event(event, runtime.context())
        assert runtime.collected == [*TEN_APPS[:7], "App8", "App9"]
        assert run_row.writes == []  # a scheduled run has no run row


class TestRefusedParts:
    def test_an_invalid_continuation_runs_nothing_and_ends_the_row(self, runtime, run_row):
        with _invocation(runtime, run_row):
            result = _Ingestor.run_for_event(
                {"execution_id": "run_1", CONTINUATION_KEY: {"apps": "everything"}}, runtime.context()
            )
        assert result["status"] == "skipped"
        assert runtime.collected == []
        assert _row(run_row)["status"] == "error"
        assert _row(run_row)["errors"] == ["RunPartRefused"]

    def test_a_part_skipped_by_an_open_breaker_ends_the_row(self, runtime, run_row):
        event = continuation_event(execution_id="run_1", apps=[("id-app8", "App8")], items_found=7,
                                   warnings=[], part=2)
        with _invocation(runtime, run_row), patch.object(_Ingestor, "run", return_value={
            "status": "skipped", "reason": "circuit_breaker_open",
        }):
            result = _Ingestor.run_for_event(event, runtime.context())
        assert result == {"status": "skipped", "reason": "circuit_breaker_open"}
        assert _row(run_row)["status"] == "error"

    def test_a_first_part_skipped_by_the_breaker_is_unchanged(self, runtime, run_row):
        with _invocation(runtime, run_row), patch.object(_Ingestor, "run", return_value={"status": "skipped"}):
            assert _Ingestor.run_for_event({"execution_id": "run_1"}, runtime.context()) == {"status": "skipped"}
        assert run_row.writes == []


class TestContinuationEvent:
    def test_it_round_trips(self):
        event = continuation_event(execution_id="run_1", apps=[("id-a", "A"), ("id-b", "B")],
                                   items_found=12, warnings=["A: x"], part=3)
        assert parse_continuation(event) == Carried(
            items_found=12, warnings=("A: x",), part=3, apps=(("id-a", "A"), ("id-b", "B"))
        )

    def test_an_event_without_one_starts_a_run(self):
        assert parse_continuation({"execution_id": "run_1"}) == Carried()
        assert parse_continuation(None) == Carried()
        assert not Carried().is_continuation

    def test_long_warnings_are_cut(self):
        (text,) = continuation_event(execution_id=None, apps=[("a", "A")], items_found=0,
                                     warnings=["x" * 1000], part=2)[CONTINUATION_KEY]["warnings"]
        assert len(text) == parts.MAX_WARNING_CHARS

    @pytest.mark.parametrize("state", [
        {"apps": [], "items_found": 0, "part": 2},
        {"apps": [{"app_id": "a", "name": "A"}], "items_found": -1, "part": 2},
        {"apps": [{"app_id": "a", "name": "A"}], "items_found": 0, "part": 1},
        {"apps": [{"app_id": "a", "name": "A"}], "items_found": "3", "part": 2},
        {"apps": [{"app_id": "a", "name": "A"}], "items_found": 0, "part": 2, "extra": True},
        {"apps": [{"app_id": "", "name": "A"}], "items_found": 0, "part": 2},
        "not an object",
    ])
    def test_a_malformed_one_is_refused(self, state):
        with pytest.raises(InvalidContinuationError):
            parse_continuation({CONTINUATION_KEY: state})


class TestConfigsForEvent:
    APPS: ClassVar[list[_App]] = [_App("A", "id-a"), _App("B", "id-b"), _App("C", "id-c")]

    def test_a_part_runs_its_carried_apps_in_order_and_drops_removed_ones(self):
        carried = Carried(part=2, apps=(("id-c", "C"), ("id-gone", "Gone"), ("id-a", "A")))
        assert [a.name for a in configs_for_event({}, carried, self.APPS, lambda a: a.store_id)] == ["C", "A"]

    def test_a_renamed_connector_is_not_rerun_under_its_new_name(self):
        carried = Carried(part=2, apps=(("id-a", "Old name"),))
        assert configs_for_event({}, carried, self.APPS, lambda a: a.store_id) == []

    def test_an_app_id_narrows_a_first_part(self):
        picked = configs_for_event({"app_id": "id-b"}, Carried(), self.APPS, lambda a: a.store_id)
        assert [a.name for a in picked] == ["B"]

    def test_otherwise_every_app_runs(self):
        assert configs_for_event(None, Carried(), self.APPS, lambda a: a.store_id) == self.APPS


class TestRunBudget:
    def test_no_context_means_no_budget(self):
        budget = RunBudget.for_context(SimpleNamespace())
        budget.apps_started = 5
        assert not budget.must_hand_off()

    def test_a_context_answering_a_non_number_reads_as_out_of_time(self):
        budget = RunBudget.for_context(SimpleNamespace(get_remaining_time_in_millis=lambda: "soon"))
        budget.apps_started = 1
        assert budget.must_hand_off()

    def test_the_first_app_always_runs(self):
        assert not RunBudget(lambda: 0).must_hand_off()

    def test_it_hands_off_below_the_reserve(self):
        remaining = {"ms": int(MIN_APP_RESERVE_SECONDS * 1000)}
        budget = RunBudget(lambda: remaining["ms"])
        budget.apps_started = 1
        assert not budget.must_hand_off()
        remaining["ms"] -= 1
        assert budget.must_hand_off()

    def test_the_reserve_grows_with_the_slowest_app(self):
        ticks = iter([0.0, 400.0, 400.0, 410.0])
        budget = RunBudget(lambda: 500_000, clock=lambda: next(ticks))
        for _ in range(2):
            with budget.timing_app():
                pass
        assert budget.slowest_app_seconds == 400.0
        assert budget.reserve_seconds() == 600.0
        assert budget.must_hand_off()

    def test_a_failing_app_is_still_timed(self):
        ticks = iter([0.0, 300.0])
        budget = RunBudget(clock=lambda: next(ticks))

        def fail_inside_the_timer():
            with budget.timing_app():
                raise ValueError("app failed")

        with pytest.raises(ValueError, match="app failed"):
            fail_inside_the_timer()
        assert (budget.apps_started, budget.slowest_app_seconds) == (1, 300.0)


class TestStartNextPart:
    FUNCTION_NAME = "voc-ingestor-app_reviews_ios"

    @pytest.fixture(autouse=True)
    def _in_lambda(self, monkeypatch) -> None:
        monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", self.FUNCTION_NAME)

    def test_it_invokes_its_own_function_asynchronously(self):
        with patch.object(parts, "invoke_lambda_async", return_value={"StatusCode": 202}) as invoke:
            start_next_part({"continuation": {}})
        invoke.assert_called_once_with(self.FUNCTION_NAME, {"continuation": {}})

    def test_a_refused_invoke_raises(self):
        with patch.object(parts, "invoke_lambda_async", return_value={"StatusCode": 500}), \
             pytest.raises(RuntimeError, match="500"):
            start_next_part({})

    def test_outside_lambda_it_raises(self, monkeypatch):
        monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME", raising=False)
        with patch.object(parts, "invoke_lambda_async") as invoke, pytest.raises(RuntimeError):
            start_next_part({})
        invoke.assert_not_called()


class TestRunRowUpdates:
    def test_a_first_part_is_unchanged_apart_from_completed_warnings(self):
        updates = {"status": "running", "items_found": 0, "started_at": "t0"}
        assert run_row_updates(updates, Carried(), [], 20) == updates

    def test_a_later_part_adds_the_carried_total_and_keeps_the_start_time(self):
        carried = Carried(items_found=7, part=2)
        assert run_row_updates({"status": "running", "items_found": 0, "started_at": "t1"}, carried, [], 20) == {
            "status": "running", "items_found": 7,
        }

    def test_an_explicit_errors_list_on_completion_is_kept(self):
        assert run_row_updates({"status": "completed", "errors": ["E"]}, Carried(), ["w"], 20)["errors"] == ["E"]
