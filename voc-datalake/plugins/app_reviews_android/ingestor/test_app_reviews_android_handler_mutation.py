"""Mutation hardening for the Android app-review ingestor (`handler.py`).

`test_play_client.py` never imports the handler, and
`plugins/test_app_reviews_enabled_filter.py` only pins the per-app `enabled`
flag with the review pipeline patched out. A mutation run therefore found
every literal in `_load_app_configs`, `_collect_reviews_for_app`,
`_format_review` and `lambda_handler` unobserved:

* the WIRE SHAPE of a formatted review: `channel` is `app_review_android`, the
  title is always empty, the author defaults to `Anonymous`, an empty developer
  reply is `None`, a reply date is ISO-formatted only when it is a datetime,
  the thumbs-up count defaults to 0, the URL is the Play Store details page and
  the per-app source platform is `<name>_Android`.
* how a stored config becomes an `AndroidAppConfig`: whitespace stripped,
  `enabled` defaulting to True, `max_reviews_per_run` defaulting to 500,
  optional `lang`/`country` (None counts as empty), legacy flat keys accepted.
* the collection contract with `play_client`: a config with a locale fetches
  exactly that locale (missing half filled with `en`/`us`); without one, ONE
  shuffled country is fetched in English; reviews with no `reviewId` are
  dropped; ids are `android_<package>_<reviewId>`; newest first, capped.
* that `lambda_handler` is wrapped by the logger, the tracer and a
  cold-start-capturing metrics flush.

The run also showed the `max_countries < len(countries)` guard to be always
true (1 against a 20-country list); it was folded into the slice.
"""
import importlib
import json
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import ANY, MagicMock, call, patch

import pytest
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag

from _shared.base_ingestor import logger, metrics, tracer
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.scoped_secret import scoped_secret
from shared.test.emf_fixtures import emf_metric_names

ANDROID_DIR = str(Path(__file__).resolve().parent)
ANDROID_HANDLER = "app_reviews_android.ingestor.handler"
# Both app-review plugins ship flat `models`/`countries`; drop the iOS copies.
_SIBLINGS = ("models", "countries", "play_client", "itunes_client")


def _fresh_handler() -> ModuleType:
    for name in (*_SIBLINGS, ANDROID_HANDLER):
        sys.modules.pop(name, None)
    if ANDROID_DIR in sys.path:
        sys.path.remove(ANDROID_DIR)
    sys.path.insert(0, ANDROID_DIR)
    return importlib.import_module(ANDROID_HANDLER)


@pytest.fixture(scope="module")
def android() -> ModuleType:
    return _fresh_handler()


def _build(android: ModuleType, secret: dict[str, str] | None = None, execution_id: str | None = None):
    with (
        offline_ingestor_construction(),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**(secret or {}))),
    ):
        return android.AndroidAppReviewsIngestor(execution_id=execution_id)


def _apps(*entries: dict[str, Any]) -> dict[str, str]:
    return {"configs": json.dumps(list(entries))}


PKG = "com.acme.app"
ACME = _apps({"app_name": "Acme", "package_name": PKG, "max_reviews_per_run": "3"})


class TestIngestorDefaults:
    def test_platform_constants(self, android):
        cls = android.AndroidAppReviewsIngestor
        assert (cls.PLATFORM_LABEL, cls.DATE_FIELD, cls.DEFAULT_SORT_BY) == ("Android", "at", "newest")

    def test_one_country_and_newest_sort_by_default(self, android):
        ingestor = _build(android, execution_id="ex-9")
        assert (ingestor.max_countries, ingestor.sort_by, ingestor.execution_id) == (1, "newest", "ex-9")

    def test_no_execution_id_by_default(self, android):
        with offline_ingestor_construction():
            assert android.AndroidAppReviewsIngestor().execution_id is None

    def test_the_package_name_is_the_app_identifier(self, android):
        app = android.AndroidAppConfig(name="n", package_name="com.p")
        assert _build(android).app_identifier(app) == "com.p"


class TestConfigLoading:
    def test_a_full_entry_is_stripped_and_parsed(self, android):
        secret = _apps({
            "app_name": " Acme ", "package_name": " com.acme ", "enabled": False,
            "max_reviews_per_run": "40", "lang": " ko ", "country": " kr ",
        })
        assert _build(android, secret).app_configs == [android.AndroidAppConfig(
            name="Acme", package_name="com.acme", enabled=False,
            max_reviews_per_run=40, lang="ko", country="kr",
        )]

    def test_a_bare_entry_gets_every_default(self, android):
        assert _build(android, _apps({"lang": None, "country": None})).app_configs == [
            android.AndroidAppConfig(
                name="", package_name="", enabled=True, max_reviews_per_run=500, lang="", country=""
            )
        ]

    @pytest.mark.parametrize("raw", ["nope", "0", ""])
    def test_an_unparsable_cap_is_500(self, android, raw):
        secret = _apps({"package_name": "p", "max_reviews_per_run": raw})
        assert _build(android, secret).app_configs[0].max_reviews_per_run == 500

    def test_legacy_flat_keys_build_one_enabled_config(self, android):
        secret = {"app_name": "Old", "package_name": "com.old", "max_reviews_per_run": "9"}
        assert _build(android, secret).app_configs == [android.AndroidAppConfig(
            name="Old", package_name="com.old", enabled=True, max_reviews_per_run=9, lang="", country=""
        )]

    def test_legacy_keys_need_package_name_by_name(self, android):
        assert _build(android, {"app_name": "Old", "app_id": "com.old"}).app_configs == []

    def test_a_broken_array_is_reported_as_the_android_array(self, android):
        with patch("_shared.app_reviews_utils.logger") as utils_logger:
            assert _build(android, {"configs": "[oops"}).app_configs == []
        (message,), _ = utils_logger.warning.call_args
        assert message.startswith("Failed to parse Android configs array: ")


def _day(n: int) -> datetime:
    return datetime(2024, 3, n, tzinfo=UTC)


def _rev(review_id: str | None, day: int | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"content": f"c-{review_id}", "at": _day(day) if day else None, **extra}
    if review_id is not None:
        out["reviewId"] = review_id
    return out


Collect = Callable[..., tuple[list[dict], MagicMock, MagicMock]]


@pytest.fixture
def collect(android) -> Collect:
    """collect(pages, **app overrides) -> (result, fetch mock, shuffle mock)."""
    ingestor = _build(android, ACME)

    def run(pages: list[list[dict]], **overrides: Any):
        app = android.AndroidAppConfig(**{**vars(ingestor.app_configs[0]), **overrides})
        with (
            patch.object(android, "fetch_reviews_for_country", side_effect=pages) as fetch,
            patch.object(android.random, "shuffle", side_effect=lambda xs: xs.reverse()) as shuffle,
        ):
            return ingestor._collect_reviews_for_app(app), fetch, shuffle

    return run


class TestLocaleSelection:
    def test_without_a_locale_one_shuffled_country_is_fetched_in_english(self, collect, android):
        _, fetch, shuffle = collect([[]])
        assert shuffle.call_args_list == [call(list(reversed(android.ANDROID_COUNTRIES)))]
        assert fetch.call_args_list == [
            call(package_name=PKG, country=android.ANDROID_COUNTRIES[-1], count=3, sort_by="newest", lang="en")
        ]

    @pytest.mark.parametrize(("lang", "country", "expected"), [
        ("ko", "kr", ("ko", "kr")),
        ("ko", "", ("ko", "us")),
        ("", "kr", ("en", "kr")),
    ])
    def test_a_configured_locale_is_fetched_alone(self, collect, lang, country, expected):
        _, fetch, shuffle = collect([[]], lang=lang, country=country)
        assert shuffle.call_count == 0
        assert fetch.call_args_list == [
            call(package_name=PKG, country=expected[1], count=3, sort_by="newest", lang=expected[0])
        ]


class TestReviewMerging:
    def test_ids_are_composite_and_tagged_with_the_country(self, collect):
        result, _, _ = collect([[_rev("r1", 1), _rev(None, 2), _rev("", 3)]], lang="ko", country="kr")
        assert result == [{
            "content": "c-r1", "at": _day(1), "reviewId": "r1",
            "composite_id": f"android_{PKG}_r1", "country": "kr",
        }]

    def test_newest_first_and_capped(self, collect):
        result, _, _ = collect([[_rev("a", 1), _rev("b", 4), _rev("c", None), _rev("d", 2)]], country="kr")
        assert [r["reviewId"] for r in result] == ["b", "d", "a"]

    def test_an_undated_review_sorts_last(self, collect):
        result, _, _ = collect([[_rev("u"), _rev("d", 1)]], country="kr")
        assert [r["reviewId"] for r in result] == ["d", "u"]


class TestWatermarkReadsTheAtField:
    def test_only_reviews_after_the_watermark_are_yielded_and_it_advances(self, android):
        ingestor = _build(android, ACME)
        ingestor.watermarks_table = MagicMock()
        ingestor.watermarks_table.get_item.return_value = {"Item": {"value": _day(2).isoformat()}}
        with (
            patch.object(android, "fetch_reviews_for_country", side_effect=[[_rev("old", 1), _rev("new", 5)]]),
            patch.object(android.random, "shuffle"),
        ):
            ids = [item["id"] for item in ingestor.fetch_new_items()]
        assert ids == [f"android_{PKG}_new"]
        stored = {
            c.kwargs["Item"]["source"]: c.kwargs["Item"]["value"]
            for c in ingestor.watermarks_table.put_item.call_args_list
        }
        assert stored["test_source#Acme_last_published_at"] == _day(5).isoformat()


@pytest.fixture
def format_review(android) -> Callable[..., dict]:
    ingestor = _build(android, ACME)
    ingestor.brand_name = "AcmeBrand"
    app = ingestor.app_configs[0]

    def run(review: dict[str, Any], brand: str = "AcmeBrand") -> dict:
        ingestor.brand_name = brand
        return ingestor._format_review({"composite_id": "cid", **review}, app)

    return run


class TestFormattedReviewShape:
    def test_a_full_review(self, format_review):
        assert format_review({
            "content": "Nice", "score": 4, "at": _day(1), "userName": "kim", "country": "kr",
            "reviewCreatedVersion": "2.1", "replyContent": "Thanks", "repliedAt": _day(2),
            "thumbsUpCount": 7,
        }) == {
            "id": "cid",
            "channel": "app_review_android",
            "text": "Nice",
            "title": "",
            "rating": 4,
            "created_at": "2024-03-01T00:00:00+00:00",
            "url": f"https://play.google.com/store/apps/details?id={PKG}",
            "author": "kim",
            "brand_handles_matched": ["AcmeBrand"],
            "source_platform_override": "Acme_Android",
            "app_name": "Acme",
            "app_identifier": PKG,
            "country": "kr",
            "app_version": "2.1",
            "developer_response": "Thanks",
            "developer_response_date": "2024-03-02T00:00:00+00:00",
            "thumbs_up_count": 7,
        }

    def test_a_bare_review_gets_every_default(self, format_review):
        formatted = format_review({}, brand="")
        created_at = formatted.pop("created_at")
        assert {k: formatted[k] for k in (
            "text", "rating", "author", "brand_handles_matched", "country", "app_version",
            "developer_response", "developer_response_date", "thumbs_up_count",
        )} == {
            "text": "", "rating": None, "author": "Anonymous", "brand_handles_matched": [],
            "country": "", "app_version": None, "developer_response": None,
            "developer_response_date": None, "thumbs_up_count": 0,
        }
        assert abs(datetime.fromisoformat(created_at) - datetime.now(UTC)).total_seconds() < 60

    @pytest.mark.parametrize(("reply", "stored"), [("", None), (None, None), ("ok", "ok")])
    def test_an_empty_reply_is_none(self, format_review, reply, stored):
        assert format_review({"replyContent": reply})["developer_response"] == stored

    @pytest.mark.parametrize("replied_at", ["2024-03-02", None, ""])
    def test_a_reply_date_that_is_not_a_datetime_is_none(self, format_review, replied_at):
        assert format_review({"repliedAt": replied_at})["developer_response_date"] is None


@pytest.fixture
def lambda_ctx() -> SimpleNamespace:
    # Not a MagicMock: Powertools treats `state` + `lambda_context` as a durable context.
    return SimpleNamespace(
        function_name="voc-android-reviews-test",
        memory_limit_in_mb=256,
        invoked_function_arn="arn:aws:lambda:us-east-1:111111111111:function:voc-android-reviews-test",
        aws_request_id="req-android-1",
    )


class TestLambdaHandlerWrapping:
    @pytest.fixture
    def invoke(self, android, lambda_ctx) -> Iterator[tuple[Callable[[dict], Any], MagicMock]]:
        metrics.clear_metrics()
        reset_cold_start_flag()
        logger.remove_keys(["function_name", "cold_start"])
        with patch.object(
            android.AndroidAppReviewsIngestor, "run_for_event", return_value={"status": "success"}
        ) as run_for_event:
            yield (lambda event: android.lambda_handler(event, lambda_ctx)), run_for_event
        metrics.clear_metrics()

    def test_the_event_is_handed_to_run_for_event(self, invoke):
        run, run_for_event = invoke
        assert run({"app_id": PKG}) == {"status": "success"}
        assert run_for_event.call_args_list == [call({"app_id": PKG})]

    def test_the_lambda_context_reaches_the_logger(self, invoke, lambda_ctx):
        run, _ = invoke
        run({})
        assert logger.get_current_keys()["function_name"] == lambda_ctx.function_name

    def test_cold_start_is_flushed_as_emf(self, invoke, capsys):
        run, _ = invoke
        run({})
        assert "ColdStart" in emf_metric_names(capsys.readouterr().out)

    def test_one_invocation_cost_line_is_written_with_the_lambda_context(self, invoke, lambda_ctx):
        run, _ = invoke
        with patch("shared.invocation_cost.log_invocation_cost") as log_cost:
            run({})
        assert log_cost.call_args_list == [call(lambda_ctx, ANY, ANY)]

    def test_the_tracer_wraps_the_handler_inside_the_logger(self):
        with patch.object(tracer, "capture_lambda_handler", side_effect=lambda f: f) as capture:
            module = _fresh_handler()
        (wrapped,), _ = capture.call_args
        assert capture.call_count == 1
        assert wrapped.__name__ == "lambda_handler"
        assert module.lambda_handler.__wrapped__ is wrapped
