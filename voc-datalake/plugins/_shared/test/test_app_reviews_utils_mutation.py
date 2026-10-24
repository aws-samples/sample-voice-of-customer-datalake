"""Mutation hardening for `_shared/app_reviews_utils.py` (the iOS/Android review pipeline).

The earlier suite (the since-deleted `test_app_reviews_utils.py`, whose
count-only cases this file supersedes) pinned the manual-only and
execution-id regressions by COUNTING yielded reviews, and the enabled-filter
suite patched `process_app_reviews` out entirely. A mutation run therefore left
90 of 131 mutants alive, all of them behaviour the earlier tests could not see:

* the watermark contract — the exact keys (`<app>_last_run`,
  `<app>_last_published_at`), the value written (the newest review's own
  `isoformat()`, the first of two equal instants), that a review AT the
  watermark is old, that an undated review is never filtered, and that a run
  with nothing new leaves the published watermark alone;
* the frequency boundary — due at exactly `last_run + frequency`, not one
  second earlier;
* every log line and the `<platform>_<app>_Reviews` / `_Errors` metrics with
  their exact counts, which an operator greps and alarms on;
* how stored configs become app configs: an empty, non-list or unparsable
  `configs` value falls back to the legacy flat keys, one bad entry is skipped
  with its reason, and the legacy path needs BOTH `app_name` and the id;
* `merge_reviews_by_composite_id`, `newest_first` and `review_created_at`,
  which had no test at all, and the `AppReviewsIngestor` base class (settings
  defaults, abstract surface, tracer wrapper, `run_for_event`'s `app_id` filter).

The run also showed four constructs nothing could observe, deleted rather than
tested: `is_due_for_run`'s `.replace("Z", "+00:00")` (Python 3.12's
`fromisoformat` reads `Z`, and the one string it changes — a date-only `…Z` —
is "due" either way), the `newest_date != watermark_dt` comparison (every dated
review yielded is already newer than the watermark), `len(configs_list) > 0`
(an empty list falls through to the legacy keys anyway) and the `"500"`/`"60"`
string defaults handed to `parse_int` (its integer default already covers an
absent key).
"""
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from _shared.app_reviews_utils import (
    AppReviewsIngestor,
    is_due_for_run,
    load_app_configs,
    load_watermark_dt,
    merge_reviews_by_composite_id,
    newest_first,
    parse_int,
    process_app_reviews,
    review_created_at,
    yield_new_reviews,
)
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.scoped_secret import scoped_secret
from shared.test.instrumentation_fixtures import TRACER_SOURCE

MODULE = "_shared.app_reviews_utils"
NOW = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
WATERMARK = datetime(2026, 4, 1, tzinfo=UTC)
APP_CONFIG = SimpleNamespace(name="MyApp")


class _FrozenDatetime(datetime):
    """`datetime` with `now()` pinned to NOW (the module's only clock read)."""

    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


@pytest.fixture(autouse=True)
def frozen_clock() -> Iterator[None]:
    with patch(f"{MODULE}.datetime", _FrozenDatetime):
        yield


@pytest.fixture
def obs() -> Iterator[SimpleNamespace]:
    """The module's logger and metrics, replaced by mocks a test asserts on."""
    with patch(f"{MODULE}.logger") as logger, patch(f"{MODULE}.metrics") as metrics:
        yield SimpleNamespace(logger=logger, metrics=metrics)


def _format(review: dict, app_config) -> dict:
    return {"id": review["id"], "app": app_config.name}


class TestParseInt:
    @pytest.mark.parametrize(
        ("value", "default", "allow_zero", "expected"),
        [
            ("42", 10, False, 42),
            ("1", 10, False, 1),
            ("0", 10, False, 10),
            ("-1", 10, False, 10),
            ("abc", 7, False, 7),
            ("", 7, False, 7),
            (None, 7, False, 7),
            ("0", 60, True, 0),
            ("30", 60, True, 30),
            ("-1", 60, True, 60),
        ],
    )
    def test_parses_or_falls_back(self, value, default, allow_zero, expected):
        assert parse_int(value, default, allow_zero=allow_zero) == expected

    def test_zero_is_refused_by_default(self):
        """`allow_zero` defaults to False (the parametrize above always passes it)."""
        assert parse_int("0", 10) == 10


class TestIsDueForRun:
    def test_reads_the_last_run_key_of_the_app(self):
        get_wm = MagicMock(return_value=None)
        assert is_due_for_run(get_wm, "MyApp", 60) is True
        get_wm.assert_called_once_with("MyApp_last_run")

    @pytest.mark.parametrize(
        ("last_run", "expected"),
        [
            ("", True),
            ((NOW - timedelta(minutes=60)).isoformat(), True),
            ((NOW - timedelta(minutes=59, seconds=59)).isoformat(), False),
            ("2026-05-01T11:30:00Z", False),
            ("not-a-date", True),
        ],
    )
    def test_due_from_exactly_one_frequency_after_the_last_run(self, last_run, expected):
        assert is_due_for_run(MagicMock(return_value=last_run), "MyApp", 60) is expected


class TestLoadWatermarkDt:
    @pytest.mark.parametrize(
        ("stored", "expected"),
        [
            (None, None),
            ("", None),
            ("garbage", None),
            ("2026-01-01T00:00:00Z", datetime(2026, 1, 1, tzinfo=UTC)),
            # Only the Z → +00:00 rewrite makes a date-only `…Z` stamp parse.
            ("2026-01-01Z", datetime(2026, 1, 1, tzinfo=UTC).replace(tzinfo=None)),
        ],
    )
    def test_parses_the_stored_stamp(self, stored, expected):
        get_wm = MagicMock(return_value=stored)
        assert load_watermark_dt(get_wm, "MyApp_last_published_at") == expected
        get_wm.assert_called_once_with("MyApp_last_published_at")


class TestYieldNewReviews:
    def test_reviews_at_or_before_the_watermark_are_skipped_undated_kept(self):
        reviews = [
            {"id": "older", "at": WATERMARK - timedelta(days=1)},
            {"id": "equal", "at": WATERMARK},
            {"id": "undated"},
            {"id": "newer", "at": WATERMARK + timedelta(days=1)},
        ]
        assert list(yield_new_reviews(reviews, WATERMARK, "at", _format, APP_CONFIG)) == [
            ({"id": "undated", "app": "MyApp"}, None),
            ({"id": "newer", "app": "MyApp"}, WATERMARK + timedelta(days=1)),
        ]

    def test_without_a_watermark_every_review_is_yielded_with_its_date(self):
        reviews = [
            {"id": "old", "at": WATERMARK - timedelta(days=9)},
            {"id": "text-date", "at": "2026-01-01"},
        ]
        assert list(yield_new_reviews(reviews, None, "at", _format, APP_CONFIG)) == [
            ({"id": "old", "app": "MyApp"}, WATERMARK - timedelta(days=9)),
            ({"id": "text-date", "app": "MyApp"}, None),
        ]

    def test_an_undated_review_yields_none_as_its_date(self):
        [(_, review_dt)] = yield_new_reviews([{"id": "x"}], WATERMARK, "at", _format, APP_CONFIG)
        assert review_dt is None


def _pipeline(obs, reviews, *, execution_id=None, frequency=60, stored=None, collect=None) -> SimpleNamespace:
    """Run `process_app_reviews` for iOS MyApp over *reviews* with *stored* watermarks."""
    watermarks = dict(stored or {})
    get_wm = MagicMock(side_effect=watermarks.get)
    set_wm = MagicMock()
    collect = collect or MagicMock(return_value=reviews)
    # A scheduled run omits `execution_id`, so its `None` default is what every scheduled case exercises.
    manual = {"execution_id": execution_id} if execution_id is not None else {}
    items = list(process_app_reviews(
        app_config=APP_CONFIG,
        app_name="MyApp",
        platform_label="iOS",
        date_field="at",
        get_watermark_fn=get_wm,
        set_watermark_fn=set_wm,
        frequency_minutes=frequency,
        collect_fn=collect,
        format_fn=_format,
        **manual,
    ))
    return SimpleNamespace(items=items, get_wm=get_wm, set_wm=set_wm, collect=collect, **vars(obs))


STORED_WATERMARK = {"MyApp_last_published_at": WATERMARK.isoformat()}


class TestScheduledRunThrottling:
    def test_manual_only_frequency_skips_before_anything_is_read(self, obs):
        run = _pipeline(obs, [{"id": "r"}], frequency=0)
        assert run.items == []
        run.logger.info.assert_called_once_with("Skipping iOS MyApp - manual-only frequency")
        run.get_wm.assert_not_called()
        run.collect.assert_not_called()
        run.set_wm.assert_not_called()
        run.metrics.add_metric.assert_not_called()

    def test_not_due_names_the_frequency(self, obs):
        stored = {"MyApp_last_run": (NOW - timedelta(minutes=10)).isoformat()}
        run = _pipeline(obs, [{"id": "r"}], stored=stored)
        assert run.items == []
        run.logger.info.assert_called_once_with("Skipping iOS MyApp - not due yet (frequency: 60m)")
        run.collect.assert_not_called()

    def test_a_one_minute_frequency_with_no_last_run_is_due(self, obs):
        run = _pipeline(obs, [{"id": "r"}], frequency=1)
        assert run.items == [{"id": "r", "app": "MyApp"}]




class TestScheduledRunWatermarks:
    def test_new_reviews_advance_the_watermark_and_are_counted(self, obs):
        reviews = [
            {"id": "older", "at": WATERMARK - timedelta(days=1)},
            {"id": "newest", "at": WATERMARK + timedelta(days=20)},
            {"id": "newer", "at": WATERMARK + timedelta(days=10)},
            {"id": "undated"},
        ]
        run = _pipeline(obs, reviews, stored=STORED_WATERMARK)
        assert [i["id"] for i in run.items] == ["newest", "newer", "undated"]
        run.collect.assert_called_once_with(APP_CONFIG)
        assert run.set_wm.call_args_list == [
            call("MyApp_last_published_at", "2026-04-21T00:00:00+00:00"),
            call("MyApp_last_run", NOW.isoformat()),
        ]
        run.metrics.add_metric.assert_called_once_with(name="iOS_MyApp_Reviews", unit="Count", value=3)
        assert run.logger.info.call_args_list == [
            call("Collecting iOS reviews for MyApp"),
            call("iOS MyApp: yielded 3 new reviews (from 4 candidates)"),
        ]

    def test_nothing_new_only_stamps_the_last_run(self, obs):
        reviews = [{"id": "older", "at": WATERMARK - timedelta(days=1)}]
        run = _pipeline(obs, reviews, stored=STORED_WATERMARK)
        assert run.items == []
        run.set_wm.assert_called_once_with("MyApp_last_run", NOW.isoformat())
        run.metrics.add_metric.assert_called_once_with(name="iOS_MyApp_Reviews", unit="Count", value=0)
        run.logger.info.assert_called_with("iOS MyApp: yielded 0 new reviews (from 1 candidates)")


class TestManualRun:
    def test_ignores_frequency_and_watermark_to_backfill(self, obs):
        stored = {**STORED_WATERMARK, "MyApp_last_run": NOW.isoformat()}
        reviews = [
            {"id": "a", "at": WATERMARK - timedelta(days=30)},
            {"id": "b", "at": WATERMARK - timedelta(days=5)},
        ]
        run = _pipeline(obs, reviews, execution_id="exec-1", frequency=0, stored=stored)
        assert [i["id"] for i in run.items] == ["a", "b"]
        run.get_wm.assert_not_called()
        assert run.set_wm.call_args_list == [
            call("MyApp_last_published_at", "2026-03-27T00:00:00+00:00"),
            call("MyApp_last_run", NOW.isoformat()),
        ]
        assert run.logger.info.call_args_list == [
            call("Collecting iOS reviews for MyApp"),
            call("Manual run: skipping watermark filter for backfill"),
            call("iOS MyApp: yielded 2 new reviews (from 2 candidates)"),
        ]

    def test_of_two_equal_instants_the_first_is_the_watermark(self, obs):
        plus_two = timezone(timedelta(hours=2))
        reviews = [
            {"id": "utc", "at": WATERMARK},
            {"id": "cest", "at": WATERMARK.astimezone(plus_two)},
        ]
        run = _pipeline(obs, reviews, execution_id="exec-1")
        assert run.set_wm.call_args_list[0] == call("MyApp_last_published_at", WATERMARK.isoformat())

    def test_a_failed_collection_counts_an_error_and_stamps_nothing(self, obs):
        failing = MagicMock(side_effect=ConnectionError("down"))
        run = _pipeline(obs, [], execution_id="exec-1", collect=failing)
        assert run.items == []
        run.logger.exception.assert_called_once_with("Failed to collect reviews for MyApp: down")
        run.metrics.add_metric.assert_called_once_with(name="iOS_MyApp_Errors", unit="Count", value=1)
        run.set_wm.assert_not_called()



def _entry(cfg: dict) -> tuple:
    if "bad" in cfg:
        raise ValueError(f"bad {cfg['bad']}")
    return ("entry", cfg["n"])


def _legacy(name: str, identifier: str, max_reviews: int) -> tuple:
    if name == "Broken":
        raise ValueError("nope")
    return ("legacy", name, identifier, max_reviews)


LEGACY = {"app_name": " My App ", "app_id": " 123 "}
LEGACY_RESULT = [("legacy", "My App", "123", 500)]


def _load(secrets: dict) -> list:
    return load_app_configs(
        secrets, platform_label="iOS", legacy_id_key="app_id", from_entry=_entry, from_legacy=_legacy,
    )


class TestLoadAppConfigs:
    @pytest.mark.parametrize("configs", ['[{"n": "A"}, {"n": "B"}]', [{"n": "A"}, {"n": "B"}]])
    def test_the_configs_array_wins_over_legacy_keys(self, obs, configs):
        assert _load({"configs": configs, **LEGACY}) == [("entry", "A"), ("entry", "B")]
        obs.logger.warning.assert_not_called()

    def test_an_invalid_entry_is_skipped_with_its_reason(self, obs):
        assert _load({"configs": '[{"bad": "x"}, {"n": "B"}]'}) == [("entry", "B")]
        obs.logger.warning.assert_called_once_with("Skipping invalid iOS app config: bad x")

    def test_all_entries_invalid_falls_back_to_legacy(self):
        assert _load({"configs": '[{"bad": "x"}]', **LEGACY}) == LEGACY_RESULT

    @pytest.mark.parametrize("configs", ["[]", '{"n": "A"}', "5"])
    def test_an_empty_or_non_list_array_falls_back_silently(self, obs, configs):
        assert _load({"configs": configs, **LEGACY}) == LEGACY_RESULT
        obs.logger.warning.assert_not_called()

    def test_unparsable_configs_warn_and_fall_back(self, obs):
        assert _load({"configs": "not json", **LEGACY}) == LEGACY_RESULT
        obs.logger.warning.assert_called_once_with(
            "Failed to parse iOS configs array: Expecting value: line 1 column 1 (char 0)"
        )

    def test_legacy_keys_carry_the_review_cap(self):
        assert _load({**LEGACY, "max_reviews_per_run": "7"}) == [("legacy", "My App", "123", 7)]

    @pytest.mark.parametrize("secrets", [{}, {"app_name": "A"}, {"app_id": "1"}, {"app_name": " ", "app_id": "1"}])
    def test_legacy_needs_both_name_and_id(self, obs, secrets):
        assert _load(secrets) == []
        obs.logger.warning.assert_not_called()

    def test_an_invalid_legacy_config_warns(self, obs):
        assert _load({"app_name": "Broken", "app_id": "1"}) == []
        obs.logger.warning.assert_called_once_with("Invalid iOS app config: nope")


class TestMergeReviewsByCompositeId:
    def test_first_copy_wins_falsy_ids_skipped_and_country_tagged(self):
        merged = {"x": {"id": "x", "seen": "earlier"}}
        reviews = [{"id": "x", "seen": "later"}, {"id": None}, {"id": "y", "t": 1}, {"id": "y", "t": 2}]
        merge_reviews_by_composite_id(merged, reviews, country="gb", composite_id_for=lambda r: r["id"])
        assert merged == {
            "x": {"id": "x", "seen": "earlier"},
            "y": {"id": "y", "t": 1, "composite_id": "y", "country": "gb"},
        }


class TestNewestFirst:
    REVIEWS = (
        {"id": "mid", "at": WATERMARK},
        {"id": "undated"},
        {"id": "newest", "at": WATERMARK + timedelta(days=1)},
        {"id": "oldest", "at": WATERMARK - timedelta(days=1)},
    )

    @pytest.mark.parametrize(
        ("cap", "expected"), [(10, ["newest", "mid", "oldest", "undated"]), (2, ["newest", "mid"])]
    )
    def test_sorted_descending_undated_last_and_capped(self, cap, expected):
        assert [r["id"] for r in newest_first(self.REVIEWS, date_field="at", cap=cap)] == expected


class TestReviewCreatedAt:
    @pytest.mark.parametrize(
        ("date", "expected"),
        [(WATERMARK, "2026-04-01T00:00:00+00:00"), ("2026-01-01", "2026-01-01"), (None, NOW.isoformat())],
    )
    def test_iso_text_for_every_date_shape(self, date, expected):
        assert review_created_at(date) == expected


@dataclass
class _App:
    name: str
    enabled: bool
    store_id: str


class _Ingestor(AppReviewsIngestor[_App]):
    PLATFORM_LABEL = "iOS"
    DATE_FIELD = "at"
    DEFAULT_SORT_BY = "newest"

    def _load_app_configs(self) -> list[_App]:
        return [_App(name, enabled, f"id-{name.lower()}") for name, enabled in APPS]

    def app_identifier(self, app: _App) -> str:
        return app.store_id

    def _collect_reviews_for_app(self, app: _App) -> list[dict]:
        return [{"id": f"{app.name}-1"}]

    def _format_review(self, review: dict, app: _App) -> dict:
        return _format(review, app)


APPS = (("A", True), ("B", False), ("C", True))


@contextmanager
def _constructed(**secret: str) -> Iterator[None]:
    with (
        offline_ingestor_construction(),
        patch("_shared.base_ingestor.get_secret", return_value=scoped_secret(**secret)),
    ):
        yield


def _ingestor(execution_id: str | None = None, **secret: str) -> _Ingestor:
    with _constructed(**secret):
        return _Ingestor(execution_id=execution_id)


class TestIngestorSettings:
    def test_defaults(self):
        ingestor = _ingestor()
        assert (ingestor.sort_by, ingestor.frequency_minutes) == ("newest", 60)
        assert [a.name for a in ingestor.app_configs] == ["A", "B", "C"]

    @pytest.mark.parametrize(("frequency", "expected"), [("0", 0), ("15", 15), ("junk", 60)])
    def test_frequency_minutes_allows_manual_only_zero(self, frequency, expected):
        assert _ingestor(frequency_minutes=frequency).frequency_minutes == expected

    def test_a_configured_sort_order_wins(self):
        assert _ingestor(sort_by="rating").sort_by == "rating"

    def test_the_platform_hooks_are_abstract(self):
        assert AppReviewsIngestor.__abstractmethods__ == frozenset(
            {"_load_app_configs", "app_identifier", "_collect_reviews_for_app", "_format_review"}
        )

    def test_fetch_new_items_is_traced(self):
        fetch = vars(AppReviewsIngestor)["fetch_new_items"]
        assert fetch.__code__.co_filename.endswith(TRACER_SOURCE)
        assert fetch.__wrapped__.__qualname__ == "AppReviewsIngestor.fetch_new_items"


class TestFetchNewItems:
    def test_disabled_apps_are_skipped_and_named(self, obs):
        items = list(_ingestor(execution_id="exec-1").fetch_new_items())
        assert items == [{"id": "A-1", "app": "A"}, {"id": "C-1", "app": "C"}]
        obs.logger.info.assert_any_call("Skipping disabled iOS app: B (id-b)")

    def test_the_ingestor_frequency_reaches_the_pipeline(self, obs):
        assert list(_ingestor(frequency_minutes="0").fetch_new_items()) == []
        obs.logger.info.assert_any_call("Skipping iOS A - manual-only frequency")

    def test_no_apps_warns(self, obs):
        ingestor = _ingestor()
        ingestor.app_configs = []
        assert list(ingestor.fetch_new_items()) == []
        obs.logger.warning.assert_called_once_with("No iOS app configurations found")


def _fake_run(self: _Ingestor) -> dict:
    return {"execution_id": self.execution_id, "apps": [a.name for a in self.app_configs]}


class TestRunForEvent:
    @pytest.mark.parametrize(
        ("event", "expected"),
        [
            ({"execution_id": "exec-9", "app_id": "id-c"}, {"execution_id": "exec-9", "apps": ["C"]}),
            ({"app_id": ""}, {"execution_id": None, "apps": ["A", "B", "C"]}),
            (None, {"execution_id": None, "apps": ["A", "B", "C"]}),
        ],
    )
    def test_builds_the_ingestor_and_filters_to_one_app(self, event, expected):
        with _constructed(), patch.object(_Ingestor, "run", _fake_run):
            assert _Ingestor.run_for_event(event) == expected
