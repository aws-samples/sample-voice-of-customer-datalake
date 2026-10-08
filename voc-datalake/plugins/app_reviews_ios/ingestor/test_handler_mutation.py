"""Mutation hardening for the iOS app-review ingestor (`handler.py`).

Before this file the handler's only test coverage was
`plugins/test_app_reviews_enabled_filter.py`, which constructs the ingestor and
pins the per-app `enabled` flag with the whole review pipeline patched out
(`test_itunes_client.py` never imports the handler at all). A mutation run
therefore found every literal in `_load_app_configs`, `_collect_reviews_for_app`,
`_format_review` and `lambda_handler` unobserved:

* the WIRE SHAPE of a formatted review — `channel` is `app_review_ios`, the
  text is `title + "\\n\\n" + body` (body alone without a title), the author
  defaults to `Anonymous`, an empty developer response is `None`, the URL is
  `https://apps.apple.com/app/id<app_id>` and the per-app source platform is
  `<name>_iOS`. The processor and the dashboard read these keys verbatim.
* how a stored config becomes an `IOSAppConfig`: whitespace stripped, a numeric
  `app_id` stringified, `enabled` defaulting to True, `max_reviews_per_run`
  defaulting to 500 when absent AND when unparsable, and the legacy flat keys
  (`app_name` + `app_id`) still accepted.
* the collection contract with `itunes_client`: every curated storefront is
  fetched exactly once, shuffled, with the configured limit and sort order and
  the shared session; duplicates across storefronts keep the first copy; the
  result is newest-first and capped.
* that `lambda_handler` is actually wrapped — Lambda context keys reach the
  logger, the `iOS_<app>_Reviews` and `ColdStart` metrics are flushed as EMF,
  and the handler is registered with the tracer.

The run also showed `max_countries` to be dead (always None, so its slice
branch could never run); it was deleted rather than tested.
"""
import importlib
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag

from _shared.base_ingestor import logger, metrics, tracer
from _shared.test.ingestor_fixtures import (
    offline_ingestor_construction,
    with_mock_circuit_breaker,
)
from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import echo_batch_success
from shared.test.emf_fixtures import emf_metric_names

IOS_DIR = Path(__file__).resolve().parent
HANDLER_MODULE = "app_reviews_ios.ingestor.handler"
# Both app-review plugins ship same-named flat modules; the Android ones must
# not be the cached copies when this handler is imported.
_FLAT_MODULES = ("models", "countries", "play_client", "itunes_client")


def _import_handler():
    """Import the iOS handler fresh, with its flat sibling imports resolving here."""
    for name in _FLAT_MODULES:
        sys.modules.pop(name, None)
    ios_dir = str(IOS_DIR)
    if ios_dir in sys.path:
        sys.path.remove(ios_dir)
    sys.path.insert(0, ios_dir)
    sys.modules.pop(HANDLER_MODULE, None)
    return importlib.import_module(HANDLER_MODULE)


@pytest.fixture(scope="module")
def handler():
    return _import_handler()


@contextmanager
def _ingestor(handler, secret: dict | None = None, *, execution_id=None) -> Iterator:
    """Construct an `IOSAppReviewsIngestor` offline from *secret* (bare keys)."""
    session = MagicMock(name="session")
    with (
        offline_ingestor_construction(),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**(secret or {}))),
        patch.object(handler, "create_session", return_value=session) as create_session,
    ):
        ingestor = handler.IOSAppReviewsIngestor(execution_id=execution_id)
    ingestor.created_session = session
    ingestor.create_session_calls = create_session.call_args_list
    yield ingestor


def _configs(*entries: dict) -> dict:
    return {"configs": json.dumps(list(entries))}


ONE_APP = _configs({"app_name": "MyApp", "app_id": "123", "max_reviews_per_run": "7"})


class TestConstruction:
    def test_a_bare_construction_has_no_execution_id(self, handler):
        with offline_ingestor_construction(), patch.object(handler, "create_session"):
            assert handler.IOSAppReviewsIngestor().execution_id is None

    def test_the_execution_id_reaches_the_base_ingestor(self, handler):
        with _ingestor(handler, execution_id="exec-1") as ingestor:
            assert ingestor.execution_id == "exec-1"

    def test_one_shared_session_is_created_with_the_client_defaults(self, handler):
        with _ingestor(handler) as ingestor:
            assert ingestor.create_session_calls == [call()]
            assert ingestor.session is ingestor.created_session

    def test_sort_order_defaults_to_most_recent(self, handler):
        with _ingestor(handler) as ingestor:
            assert ingestor.sort_by == "most_recent"

    def test_a_configured_sort_order_wins(self, handler):
        with _ingestor(handler, {"sort_by": "most_helpful"}) as ingestor:
            assert ingestor.sort_by == "most_helpful"


class TestLoadAppConfigs:
    def test_an_array_entry_is_stripped_stringified_and_parsed(self, handler):
        secret = _configs({
            "app_name": "  My App ",
            "app_id": 123,
            "enabled": False,
            "max_reviews_per_run": "50",
        })
        with _ingestor(handler, secret) as ingestor:
            assert ingestor.app_configs == [
                handler.IOSAppConfig(
                    name="My App", app_id="123", enabled=False, max_reviews_per_run=50
                )
            ]

    def test_an_entry_with_only_an_app_id_gets_every_default(self, handler):
        with _ingestor(handler, _configs({"app_id": "42"})) as ingestor:
            assert ingestor.app_configs == [
                handler.IOSAppConfig(name="", app_id="42", enabled=True, max_reviews_per_run=500)
            ]

    def test_an_entry_without_an_app_id_has_an_empty_one(self, handler):
        with _ingestor(handler, _configs({"app_name": "NoId"})) as ingestor:
            assert ingestor.app_configs[0].app_id == ""

    @pytest.mark.parametrize("raw", ["abc", "0", "-5", ""])
    def test_an_unparsable_review_cap_falls_back_to_500(self, handler, raw):
        with _ingestor(handler, _configs({"app_id": "1", "max_reviews_per_run": raw})) as ingestor:
            assert ingestor.app_configs[0].max_reviews_per_run == 500

    def test_the_legacy_flat_keys_still_build_one_enabled_config(self, handler):
        secret = {"app_name": "Legacy", "app_id": "777", "max_reviews_per_run": "25"}
        with _ingestor(handler, secret) as ingestor:
            assert ingestor.app_configs == [
                handler.IOSAppConfig(
                    name="Legacy", app_id="777", enabled=True, max_reviews_per_run=25
                )
            ]

    def test_legacy_keys_need_the_app_id_key_by_name(self, handler):
        with _ingestor(handler, {"app_name": "Legacy", "package_name": "777"}) as ingestor:
            assert ingestor.app_configs == []

    def test_an_unparsable_configs_array_is_reported_as_the_ios_array(self, handler):
        with (
            patch("_shared.app_reviews_utils.logger") as utils_logger,
            _ingestor(handler, {"configs": "{not json"}) as ingestor,
        ):
            pass
        assert ingestor.app_configs == []
        (message,), _ = utils_logger.warning.call_args
        assert message.startswith("Failed to parse iOS configs array: ")


def _review(review_id: str, date: datetime | None, **extra) -> dict:
    return {"id": review_id, "title": f"t{review_id}", "review": f"r{review_id}", "date": date, **extra}


def _dated(day: int) -> datetime:
    return datetime(2024, 5, day, tzinfo=UTC)


class TestCollectReviewsForApp:
    @pytest.fixture
    def collect(self, handler):
        """(ingestor, fetch mock, collect(by_country)) with a deterministic storefront order."""
        with _ingestor(handler, ONE_APP) as ingestor:
            pass
        app = ingestor.app_configs[0]
        with (
            patch.object(handler, "fetch_reviews_for_country") as fetch,
            patch.object(handler.random, "shuffle") as shuffle,
        ):
            def run(by_country: dict[str, list[dict]]):
                fetch.side_effect = lambda **kw: list(by_country.get(kw["country"], []))
                return ingestor._collect_reviews_for_app(app)

            yield ingestor, fetch, shuffle, run

    def test_every_curated_storefront_is_fetched_once_in_the_shuffled_order(self, collect, handler):
        _, fetch, shuffle, run = collect
        run({})
        assert [c.kwargs["country"] for c in fetch.call_args_list] == list(handler.IOS_COUNTRIES)
        assert len(handler.IOS_COUNTRIES) == 40
        assert shuffle.call_args_list == [call(list(handler.IOS_COUNTRIES))]

    def test_each_fetch_carries_the_app_limit_sort_order_and_shared_session(self, collect):
        ingestor, fetch, _, run = collect
        run({})
        assert fetch.call_args_list[0] == call(
            app_id="123",
            country="us",
            session=ingestor.created_session,
            limit=7,
            sort_by="most_recent",
        )

    def test_a_review_seen_in_two_storefronts_keeps_the_first_copy(self, collect):
        _, _, _, run = collect
        result = run({
            "us": [_review("r1", _dated(1), version="us-copy")],
            "gb": [_review("r1", _dated(1), version="gb-copy")],
        })
        assert result == [{
            "id": "r1",
            "title": "tr1",
            "review": "rr1",
            "date": _dated(1),
            "version": "us-copy",
            "composite_id": "ios_123_r1",
            "country": "us",
        }]

    def test_the_result_is_newest_first_and_capped_at_the_app_limit(self, collect):
        ingestor, _, _, run = collect
        ingestor.app_configs[0].max_reviews_per_run = 2
        result = run({
            "us": [_review("old", _dated(1)), _review("mid", _dated(2))],
            "gb": [_review("new", _dated(3))],
        })
        assert [r["composite_id"] for r in result] == ["ios_123_new", "ios_123_mid"]

    def test_an_undated_review_sorts_last(self, collect):
        _, _, _, run = collect
        result = run({"us": [_review("undated", None), _review("dated", _dated(1))]})
        assert [r["id"] for r in result] == ["dated", "undated"]


class TestWatermarkUsesTheReviewDate:
    """`DATE_FIELD` is what the shared pipeline reads to compare a review with the
    `<app>_last_published_at` watermark and to advance it; a wrong field name
    would re-ingest every review on every scheduled run and never move the mark."""

    def test_a_scheduled_run_yields_only_reviews_newer_than_the_watermark(self, handler):
        with _ingestor(handler, ONE_APP) as ingestor:
            pass
        ingestor.watermarks_table = MagicMock()
        ingestor.watermarks_table.get_item.return_value = {
            "Item": {"value": "2024-05-02T00:00:00+00:00"}
        }
        with (
            patch.object(handler, "fetch_reviews_for_country") as fetch,
            patch.object(handler.random, "shuffle"),
        ):
            fetch.side_effect = lambda **kw: (
                [_review("older", _dated(1)), _review("newer", _dated(3))]
                if kw["country"] == "us" else []
            )
            yielded = list(ingestor.fetch_new_items())

        assert [item["id"] for item in yielded] == ["ios_123_newer"]
        written = {
            c.kwargs["Item"]["source"]: c.kwargs["Item"]["value"]
            for c in ingestor.watermarks_table.put_item.call_args_list
        }
        assert written["test_source#MyApp_last_published_at"] == "2024-05-03T00:00:00+00:00"


class TestFormatReview:
    @pytest.fixture
    def fmt(self, handler):
        with _ingestor(handler, ONE_APP) as ingestor:
            pass
        ingestor.brand_name = "Acme"
        app = ingestor.app_configs[0]
        return ingestor, lambda review: ingestor._format_review(review, app)

    def test_a_full_review_formats_to_the_pipeline_schema(self, fmt):
        _, format_review = fmt
        assert format_review({
            "composite_id": "ios_123_r1",
            "title": "Great",
            "review": "Loved it",
            "rating": 5,
            "date": _dated(1),
            "user_name": "jane",
            "country": "gb",
            "developer_response": "Thanks!",
        }) == {
            "id": "ios_123_r1",
            "channel": "app_review_ios",
            "text": "Great\n\nLoved it",
            "title": "Great",
            "rating": 5,
            "created_at": "2024-05-01T00:00:00+00:00",
            "url": "https://apps.apple.com/app/id123",
            "author": "jane",
            "brand_handles_matched": ["Acme"],
            "source_platform_override": "MyApp_iOS",
            "app_name": "MyApp",
            "app_identifier": "123",
            "country": "gb",
            "developer_response": "Thanks!",
        }

    def test_a_bare_review_gets_every_default(self, fmt):
        ingestor, format_review = fmt
        ingestor.brand_name = ""
        formatted = format_review({"composite_id": "ios_123_r2"})
        created_at = formatted.pop("created_at")
        assert formatted == {
            "id": "ios_123_r2",
            "channel": "app_review_ios",
            "text": "",
            "title": "",
            "rating": None,
            "url": "https://apps.apple.com/app/id123",
            "author": "Anonymous",
            "brand_handles_matched": [],
            "source_platform_override": "MyApp_iOS",
            "app_name": "MyApp",
            "app_identifier": "123",
            "country": "",
            "developer_response": None,
        }
        assert abs(datetime.fromisoformat(created_at) - datetime.now(UTC)).total_seconds() < 60

    @pytest.mark.parametrize(("review", "text"), [
        ({"title": "Great", "review": "Loved it"}, "Great\n\nLoved it"),
        ({"title": "", "review": "Loved it"}, "Loved it"),
        ({"review": "Loved it"}, "Loved it"),
        ({"title": "Great"}, "Great\n\n"),
    ])
    def test_the_text_is_title_blank_line_body_or_body_alone(self, fmt, review, text):
        _, format_review = fmt
        assert format_review({"composite_id": "x", **review})["text"] == text

    @pytest.mark.parametrize(("raw", "stored"), [
        ("Thanks!", "Thanks!"),
        ("", None),
        (None, None),
    ])
    def test_an_empty_developer_response_is_stored_as_none(self, fmt, raw, stored):
        _, format_review = fmt
        formatted = format_review({"composite_id": "x", "developer_response": raw})
        assert formatted["developer_response"] == stored

    def test_a_string_date_is_passed_through(self, fmt):
        _, format_review = fmt
        assert format_review({"composite_id": "x", "date": "2024-05-01"})["created_at"] == "2024-05-01"


@pytest.fixture
def lambda_context():
    # A plain namespace, not a MagicMock: Powertools treats anything that has
    # `state` and `lambda_context` attributes as a Step Functions durable context.
    return SimpleNamespace(
        function_name="voc-ios-reviews-test",
        memory_limit_in_mb=512,
        invoked_function_arn="arn:aws:lambda:us-east-1:123456789:function:voc-ios-reviews-test",
        aws_request_id="req-ios-1",
    )


class TestLambdaHandler:
    """`lambda_handler` runs the real ingestor end to end; only AWS and the
    App Store client are stubbed."""

    @pytest.fixture
    def invoke(self, handler, lambda_context):
        metrics.clear_metrics()
        reset_cold_start_flag()
        logger.remove_keys(["function_name", "cold_start"])
        session = MagicMock(name="session")
        with (
            offline_ingestor_construction(),
            patch("_shared.base_ingestor.get_sqs_client") as get_sqs,
            patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**ONE_APP)),
            patch.object(handler, "create_session", return_value=session),
            patch.object(handler, "fetch_reviews_for_country") as fetch,
            patch.object(handler.random, "shuffle"),
            patch.object(handler.IOSAppReviewsIngestor, "run", autospec=True) as run,
        ):
            def real_run(ingestor):
                with_mock_circuit_breaker(ingestor)
                return handler.IOSAppReviewsIngestor.__mro__[1].run(ingestor)

            get_sqs.return_value.send_message_batch.side_effect = echo_batch_success
            run.side_effect = real_run
            fetch.side_effect = lambda **kw: (
                [_review("r1", _dated(1), rating=4)] if kw["country"] == "us" else []
            )
            yield lambda event: handler.lambda_handler(event, lambda_context), fetch
        metrics.clear_metrics()

    def test_a_scheduled_run_ingests_every_configured_app(self, invoke):
        run, fetch = invoke
        assert run({}) == {"status": "success", "items_processed": 1}
        assert fetch.call_count == 40

    def test_the_event_app_id_narrows_the_run_to_that_app(self, invoke):
        run, fetch = invoke
        with patch("_shared.app_reviews_utils.logger") as utils_logger:
            assert run({"app_id": "999"}) == {"status": "success", "items_processed": 0}
        assert fetch.call_count == 0
        assert utils_logger.warning.call_args == call("No iOS app configurations found")

    def test_the_lambda_context_reaches_the_logger(self, invoke, lambda_context):
        run, _ = invoke
        run({})
        assert logger.get_current_keys()["function_name"] == lambda_context.function_name

    def test_the_review_count_and_cold_start_are_flushed_as_emf(self, invoke, capsys):
        run, _ = invoke
        run({})
        names = emf_metric_names(capsys.readouterr().out)
        assert {"iOS_MyApp_Reviews", "ColdStart"} <= names

    def test_the_handler_is_registered_with_the_tracer(self):
        with patch.object(tracer, "capture_lambda_handler", side_effect=lambda f: f) as capture:
            module = _import_handler()
        (wrapped,), _ = capture.call_args
        assert capture.call_count == 1
        assert wrapped.__name__ == "lambda_handler"
        # The tracer sits between the logger (outermost) and the metrics flush.
        assert module.lambda_handler.__wrapped__ is wrapped
