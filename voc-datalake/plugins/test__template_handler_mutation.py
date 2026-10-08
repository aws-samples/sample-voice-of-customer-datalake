"""Mutation hardening for `_template/ingestor/handler.py`, the scaffold every new plugin is copied from.

Nothing exercised the template beyond `test_manual_run_guard.py`'s source scan, so a mutation
run could change any of it unseen:

* the `api_key` secret could be read under another name or default to a non-empty key, which
  would make an unconfigured plugin skip its "No API key" refusal and go on to fetch;
* the refusal could be inverted, so a configured plugin fetched nothing and an unconfigured
  one read the `last_id` watermark;
* every log line (the refusal warning, the watermark it fetches from, the placeholder notice)
  could be renamed;
* `__init__` could drop the `execution_id` before `BaseIngestor` clears the secret cache, and
  `lambda_handler` could read it from another key, accept it from a non-dict event, drop its
  ingestor's run result, any of its four instrumentation layers or the cold-start metric;
* `sys.path` could get the plugin folder (`plugins/_template`) at index 1 instead of the front.

It lives at `plugins/` rather than inside `_template/`: the template folder is what a new plugin
copies (README "Copy this folder"), and the ingestion stack bundles `plugins/<id>/ingestor/*` into
the Lambda, so a test in there would be copied into every new plugin and shipped in its bundle.
"""
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from _shared.test.scoped_secret import scoped_secret
from _template.ingestor import handler
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

TEMPLATE_PATH = Path(handler.__file__).resolve()
PLUGIN_DIR = str(TEMPLATE_PATH.parents[1])


@contextmanager
def built_offline(
    execution_id: str | None = None, **secrets: str,
) -> Iterator[tuple[handler.MySourceIngestor, MagicMock]]:
    """A `MySourceIngestor` built offline from a secret holding *secrets* (a filler key when none),
    and the mocked `clear_secret_cache` its construction may call."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource"),
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**secrets)),
        patch("_shared.base_ingestor.clear_secret_cache") as clear_cache,
    ):
        yield handler.MySourceIngestor(execution_id=execution_id), clear_cache


@contextmanager
def template_ingestor(**secrets: str) -> Iterator[handler.MySourceIngestor]:
    """`built_offline` for the tests that only need the ingestor."""
    with built_offline(**secrets) as (ingestor, _):
        yield ingestor


def _fetch(ingestor: handler.MySourceIngestor, watermark: str | None = "42") -> tuple[list[dict], MagicMock, MagicMock]:
    """Drain `fetch_new_items` with the watermark read and the module logger mocked."""
    get_watermark = MagicMock(return_value=watermark)
    with patch.object(ingestor, "get_watermark", get_watermark), patch.object(handler, "logger") as log:
        items = list(ingestor.fetch_new_items())
    return items, get_watermark, log


class TestTheApiKeySecret:
    def test_is_read_under_its_bare_name(self):
        with template_ingestor(api_key="k-123") as ingestor:
            assert ingestor.api_key == "k-123"

    def test_defaults_to_empty_when_the_secret_has_no_api_key(self):
        with template_ingestor() as ingestor:
            assert ingestor.api_key == ""


class TestFetchNewItems:
    def test_without_a_key_refuses_with_a_warning_and_never_reads_the_watermark(self):
        with template_ingestor() as ingestor:
            items, get_watermark, log = _fetch(ingestor)
        assert items == []
        assert log.warning.call_args_list == [call("No API key configured for My Source")]
        assert log.info.call_args_list == []
        get_watermark.assert_not_called()

    @pytest.mark.parametrize(("watermark", "logged"), [("42", "42"), (None, "None")])
    def test_with_a_key_reads_last_id_logs_it_and_yields_nothing(self, watermark: str | None, logged: str):
        with template_ingestor(api_key="k-123") as ingestor:
            items, get_watermark, log = _fetch(ingestor, watermark)
        assert items == []
        get_watermark.assert_called_once_with("last_id")
        assert log.info.call_args_list == [
            call(f"Fetching items since last_id: {logged}"),
            call("Template ingestor - no items to fetch"),
        ]
        assert log.warning.call_args_list == []


class TestExecutionId:
    def test_reaches_the_base_class_so_a_manual_run_clears_the_secret_cache(self):
        with built_offline(execution_id="exec-9") as (ingestor, clear_cache):
            assert ingestor.execution_id == "exec-9"
        clear_cache.assert_called_once_with()

    def test_a_scheduled_run_has_none(self):
        with built_offline() as (ingestor, clear_cache):
            assert ingestor.execution_id is None
        clear_cache.assert_not_called()


def _lambda_context() -> SimpleNamespace:
    return SimpleNamespace(
        function_name="voc-my-source-ingestor", memory_limit_in_mb=256, aws_request_id="req-template",
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-my-source-ingestor",
        get_remaining_time_in_millis=lambda: 120_000,
    )


@pytest.fixture
def ingestor_class() -> Iterator[MagicMock]:
    with patch.object(handler, "MySourceIngestor") as cls:
        cls.return_value.run.return_value = {"status": "success", "items_processed": 0}
        yield cls


class TestLambdaHandler:
    @pytest.mark.parametrize(
        ("event", "execution_id"),
        [({"execution_id": "exec-7"}, "exec-7"), ({}, None), (["execution_id"], None)],
    )
    def test_builds_the_ingestor_from_the_event_and_returns_its_run(
        self, ingestor_class: MagicMock, event: object, execution_id: str | None,
    ):
        assert handler.lambda_handler(event, _lambda_context()) == {"status": "success", "items_processed": 0}
        assert ingestor_class.call_args_list == [call(execution_id=execution_id)]
        ingestor_class.return_value.run.assert_called_once_with()

    def test_carries_all_four_instrumentation_layers(self):
        assert handler_layers(handler.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS

    @pytest.mark.usefixtures("ingestor_class")
    def test_flushes_the_cold_start_metric(self, capsys: pytest.CaptureFixture[str]):
        names = cold_start_metric_names(handler.metrics, lambda: handler.lambda_handler({}, _lambda_context()), capsys)
        assert names == {"ColdStart"}


def test_loading_puts_the_plugin_folder_at_the_front_of_sys_path():
    before = list(sys.path)
    try:
        assert_loading_puts_root_first(
            lambda: load_fresh("_template.ingestor._handler_under_test", TEMPLATE_PATH), before, PLUGIN_DIR,
        )
    finally:
        sys.path[:] = before
