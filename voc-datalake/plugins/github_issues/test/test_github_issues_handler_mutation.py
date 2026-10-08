"""Mutation hardening for `github_issues/ingestor/handler.py`.

`test_github_issues_ingestor.py` proves the fetch, ETag, stop and filter flows,
but a mutation run left 31 mutants alive that it could not see:

* the item cap (1500) and the Lambda safety margin (60 s) could move by one;
* every warning and info line (unconfigured, rejected repo, missing repo,
  stopping early, the 304 and the per-run request summary) could be renamed —
  the one test that read a warning matched a substring;
* the ``GitHubRunStoppedEarly`` metric could be renamed or counted twice;
* a watermark that is not JSON or not an object would crash ``parse`` on
  ``None.get`` instead of starting fresh, and the boundary kept could grow to 201;
* a secret with no ``token`` key could default to a non-empty token and fetch;
* a non-dict issue in a page would crash the run, and an issue without
  ``updated_at`` would be matched against a non-empty placeholder;
* ``lambda_handler`` could drop the ``execution_id``, its ingestor, any of its
  four decorators or the cold-start metric, and ``sys.path`` could be inserted
  at index 1.

Each test below pins one of them with literal values. (The no-op URL quoting in
``_repo_url`` and the falsy-``stop_reason`` check were rewritten instead.)
"""
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from github_fixtures import ISSUES_PATH, REPO, FakeGitHub, FakeResponse, issue, ok
from github_ingestor_fixtures import ABSENT, WatermarkTable, ingestor_with, run_listing, sent_items

from _shared.github_api import StopRun
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from github_issues.ingestor import handler
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

MODULE_PATH = Path(handler.__file__).resolve()
PLUGIN_ROOT = str(MODULE_PATH.parents[1])


def _logged(log: MagicMock, level: str) -> list[str]:
    return [str(c.args[0]) for c in getattr(log, level).call_args_list]


class TestLimits:
    def test_the_item_cap_stops_the_run_at_the_1500th_item(self):
        with ingestor_with(FakeGitHub({}), WatermarkTable()) as observed:
            ingestor = observed.ingestor
            ingestor._items = 1498
            ingestor._count()
            assert ingestor._items == 1499
            with pytest.raises(StopRun) as stop:
                ingestor._count()
        assert stop.value.reason == "item_cap"
        assert ingestor._items == 1500

    def test_the_deadline_keeps_sixty_seconds_back(self):
        context = SimpleNamespace(get_remaining_time_in_millis=lambda: 300_000)
        with patch("time.monotonic", return_value=1000.0):
            assert handler._deadline_for(context) == 1240.0


class TestRepoState:
    @pytest.mark.parametrize("raw", ["not json", "[1, 2]"])
    def test_an_unreadable_watermark_starts_fresh(self, raw):
        assert handler._RepoState.parse(raw).serialize() == '{"since": null, "boundary": [], "etag": null}'

    def test_only_the_200_highest_boundary_numbers_are_kept(self):
        state = handler._RepoState("2026-01-01T00:00:00Z", list(range(1, 202)))
        assert json.loads(state.serialize())["boundary"] == list(range(2, 202))


class TestEveryLogLineIsExact:
    def test_a_secret_without_a_token_fetches_nothing_and_says_so(self):
        github = FakeGitHub({})
        with patch(f"{handler.__name__}.logger") as log, \
                ingestor_with(github, WatermarkTable(), token=ABSENT) as ingestor:
            result = ingestor.run()

        assert github.calls == []
        assert result == {"status": "success", "items_processed": 0}
        log.warning.assert_called_once_with("github_issues: token or repos not configured; nothing to fetch")

    def test_a_rejected_and_a_missing_repo_are_each_named(self):
        github = FakeGitHub({"/repos/acme/gone/issues": [FakeResponse(404, {"message": "Not Found"})]})
        with patch(f"{handler.__name__}.logger") as log, \
                ingestor_with(github, WatermarkTable(), repos="gitlab.com/acme/Kiro\nacme/gone") as ingestor:
            ingestor.run()

        assert _logged(log, "warning") == [
            "github_issues: 'gitlab.com/acme/Kiro' names no GitHub repository (expected owner/name); ignored",
            "github_issues: acme/gone not found or not visible to the token; skipped",
        ]
        assert _logged(log, "info") == ["github_issues: 1 GitHub requests, 0 items"]

    def test_a_stop_is_logged_and_counted_once(self):
        with patch(f"{handler.__name__}.logger") as log, patch.object(handler.metrics, "add_metric") as add_metric, \
                ingestor_with(FakeGitHub({}), WatermarkTable(), deadline=0.0) as ingestor:
            ingestor.run()

        assert _logged(log, "info") == [
            "github_issues: stopping early (time_budget); resuming next run",
            "github_issues: 0 GitHub requests, 0 items",
        ]
        add_metric.assert_called_once_with(name="GitHubRunStoppedEarly", unit="Count", value=1)

    def test_an_unchanged_repo_is_logged_as_a_304(self):
        github = FakeGitHub({ISSUES_PATH: [FakeResponse(304, None, {"X-RateLimit-Remaining": "4000"})]})
        with patch(f"{handler.__name__}.logger") as log, ingestor_with(github, WatermarkTable()) as ingestor:
            ingestor.run()

        assert _logged(log, "info") == [
            f"github_issues: {REPO} unchanged (304)",
            "github_issues: 1 GitHub requests, 0 items",
        ]


class TestMalformedIssues:
    def test_entries_that_are_not_numbered_issues_are_skipped(self):
        ingestor, _, _, result = run_listing(ok(["junk", {"title": "no number"}, issue(1)]))

        assert result["status"] == "success"
        assert [i["id"] for i in sent_items(ingestor)] == ["acme/Kiro#1"]

    def test_an_issue_without_updated_at_matches_an_empty_boundary_instant(self):
        ingestor, _, _, _ = run_listing(ok([{**issue(7), "updated_at": None}]), {"since": "", "boundary": [7]})

        assert sent_items(ingestor) == []


def _context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-github-issues-ingestor", memory_limit_in_mb=256,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-github-issues-ingestor",
        aws_request_id="req-1", get_remaining_time_in_millis=lambda: 300_000,
    )


@pytest.fixture
def ingestor_class() -> Iterator[MagicMock]:
    with patch.object(handler, "GitHubIssuesIngestor") as cls:
        cls.return_value.run.return_value = {"status": "success", "items_processed": 3}
        yield cls


class TestLambdaHandler:
    @pytest.mark.parametrize(("event", "execution_id"), [({"execution_id": "exec-7"}, "exec-7"), ([], None)])
    def test_builds_the_ingestor_from_the_event_and_context_and_returns_its_run(
        self, ingestor_class: MagicMock, event, execution_id,
    ):
        with patch("time.monotonic", return_value=1000.0):
            assert handler.lambda_handler(event, _context()) == {"status": "success", "items_processed": 3}
        assert ingestor_class.call_args_list == [call(execution_id=execution_id, deadline=1240.0)]

    def test_carries_all_four_instrumentation_layers(self):
        assert handler_layers(handler.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS

    @pytest.mark.usefixtures("ingestor_class")
    def test_flushes_the_cold_start_metric(self, capsys):
        names = cold_start_metric_names(handler.metrics, lambda: handler.lambda_handler({}, _context()), capsys)
        assert names == {"ColdStart"}


@pytest.fixture
def restored_sys_path() -> Iterator[list[str]]:
    before = list(sys.path)
    yield before
    sys.path[:] = before


def test_the_plugin_root_is_put_at_the_front_of_sys_path(restored_sys_path):
    assert_loading_puts_root_first(
        lambda: load_fresh("github_issues.ingestor._handler_under_test", MODULE_PATH), restored_sys_path, PLUGIN_ROOT,
    )
