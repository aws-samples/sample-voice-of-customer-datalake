"""Mutation hardening for `plugins/synthetic_reviews/ingestor/handler.py`.

The module had no tests of its own (only an import smoke test in
`plugins/test_plugin_imports.py`), so every mutant mutmut can make in it
survived. The suite below pins, with literal values:

* the configuration read from the plugin's secret: every field stripped, the
  ``balanced`` / ``en`` defaults (also for a whitespace-only value), the review
  count clamped to exactly [1, 150] with 10 for an unparseable value, and the
  focus areas split on commas and newlines and capped at 12;
* the exact prompt and system prompt sent to Bedrock, every sentiment guidance
  sentence, and the ``converse`` arguments (4096 tokens, temperature 0.9, the
  ``synthetic_reviews`` step name);
* batching: 25 reviews are asked for as 10, 10, 5; an empty batch stops the
  run; a blank review is neither yielded nor counted; the exact log lines and
  the ``SyntheticReviewsGenerated`` metric;
* parsing of the model reply (array inside prose, no array, broken JSON,
  entries without text) and the item built from each review (the 50,000
  character cap, the ``general`` focus area, rating clamped to 1..5, the
  0-90 day / 0-23 hour / 0-59 minute timestamp spread);
* that ``normalize_item`` carries only the non-None synthetic fields, that
  ``lambda_handler`` passes the ``execution_id`` through and keeps its four
  instrumentation layers, and that the plugin root goes to ``sys.path[0]``.

The run also showed dead code, deleted rather than tested: the
``isinstance(data, list)`` guard in ``_parse_reviews`` (the regex only hands
``json.loads`` text that starts with ``[``, so a successful parse is always a
list), the ``TypeError`` in ``_parse_count`` (``int(str(raw))`` only raises
``ValueError``), the ``"text"`` default in ``_build_item`` (every review it gets
has passed the non-empty ``text`` filter) and the ``""`` defaults that the
``or ""`` after them already covered.
"""
import json
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from _shared.test.ingestor_fixtures import offline_ingestor_construction
from _shared.test.scoped_secret import scoped_secret
from shared.test.emf_fixtures import cold_start_metric_names
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, TRACER_SOURCE, handler_layers
from synthetic_reviews.ingestor import handler

MODULE_PATH = Path(handler.__file__).resolve()
PLUGIN_ROOT = str(MODULE_PATH.parents[1])

INSTRUCTIONS = (
    "Make each review specific and varied in length, tone, and detail. Ratings must align with "
    "sentiment (1-2 = negative, 3 = neutral/mixed, 4-5 = positive).\n\nReturn ONLY a JSON array. "
    'Each element must be an object with keys: "text" (2-5 sentences), "rating" (integer 1-5), '
    '"title" (short string), "author" (fictional first name + last initial), "focus_area" (one of '
    "the listed areas)."
)
BALANCED = "a realistic balanced mix (roughly 55% positive, 25% neutral, 20% negative)"


def build(**secrets: str) -> handler.SyntheticReviewsIngestor:
    """Construct the ingestor offline, its secret holding exactly *secrets*."""
    with offline_ingestor_construction(), patch(
        "_shared.base_ingestor.get_secret", return_value=scoped_secret(**secrets),
    ):
        return handler.SyntheticReviewsIngestor()


def configured(**overrides: str) -> handler.SyntheticReviewsIngestor:
    return build(**{"company_name": "Acme", "product_name": "Rocket", **overrides})


def _logged(log: MagicMock, level: str) -> list[str]:
    """The first positional argument of every ``log.<level>(...)`` call, in order."""
    method: MagicMock = getattr(log, level)
    return [message for (message, *_), _kwargs in method.call_args_list]


class TestConfiguration:
    def test_nothing_configured_reads_as_empty_with_the_defaults(self):
        ing = build()
        assert (ing.company_name, ing.product_name, ing.product_description, ing.target_customer) == ("", "", "", "")
        assert ing.focus_areas == []
        assert ing.num_reviews == 10
        assert ing.sentiment_mix == "balanced"
        assert ing.language == "en"

    def test_every_value_is_stripped(self):
        ing = build(
            company_name=" Acme ", product_name=" Rocket ", product_description=" Fast ",
            target_customer=" Devs ", sentiment_mix=" mixed ", language=" de ", num_reviews=" 42 ",
        )
        assert (ing.company_name, ing.product_name, ing.product_description, ing.target_customer) == (
            "Acme", "Rocket", "Fast", "Devs",
        )
        assert (ing.sentiment_mix, ing.language, ing.num_reviews) == ("mixed", "de", 42)

    def test_a_whitespace_only_sentiment_and_language_fall_back_to_the_defaults(self):
        ing = build(sentiment_mix="   ", language="  ")
        assert (ing.sentiment_mix, ing.language) == ("balanced", "en")

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("0", 1), ("-5", 1), ("1", 1), ("2", 2), ("149", 149), ("150", 150), ("151", 150), ("abc", 10), ("4.5", 10)],
    )
    def test_the_review_count_is_clamped_to_1_through_150(self, raw, expected):
        assert build(num_reviews=raw).num_reviews == expected

    def test_a_missing_count_is_the_default_10(self):
        assert handler.SyntheticReviewsIngestor._parse_count(None) == 10

    def test_focus_areas_split_on_commas_and_newlines_dropping_blanks(self):
        assert build(focus_areas=" speed, price\n support ,,\n \n").focus_areas == ["speed", "price", "support"]

    def test_at_most_twelve_focus_areas_are_kept(self):
        areas = [f"a{i}" for i in range(13)]
        assert build(focus_areas=",".join(areas)).focus_areas == areas[:12]


class TestThePrompt:
    def test_the_full_prompt_carries_every_configured_field(self):
        ing = configured(
            product_description="A rocket", target_customer="Engineers",
            focus_areas="speed,price", sentiment_mix="mostly_negative", language="fr",
        )
        assert ing._build_prompt(7) == (
            "Generate 7 realistic, distinct customer reviews written in language code 'fr'.\n\n"
            "Company: Acme\nProduct: Rocket\nProduct description: A rocket\nTarget customer: Engineers\n\n"
            "Spread the reviews across these areas/topics: speed, price.\n"
            "Sentiment distribution: mostly negative (about 70% negative) reflecting customers facing problems.\n\n"
            + INSTRUCTIONS
        )

    def test_an_unconfigured_prompt_uses_the_general_area_and_balanced_mix(self):
        assert configured(sentiment_mix="unknown")._build_prompt(3) == (
            "Generate 3 realistic, distinct customer reviews written in language code 'en'.\n\n"
            "Company: Acme\nProduct: Rocket\n\n"
            "Spread the reviews across these areas/topics: general product experience.\n"
            f"Sentiment distribution: {BALANCED}.\n\n" + INSTRUCTIONS
        )

    @pytest.mark.parametrize(
        ("mix", "guidance"),
        [
            ("balanced", BALANCED),
            ("mostly_positive", "mostly positive (about 80% positive) with a few critical reviews"),
            ("mostly_negative", "mostly negative (about 70% negative) reflecting customers facing problems"),
            ("mixed", "highly polarized — a mix of very positive and very negative reviews"),
        ],
    )
    def test_each_sentiment_mix_has_its_own_guidance(self, mix, guidance):
        assert f"Sentiment distribution: {guidance}.\n\n" in configured(sentiment_mix=mix)._build_prompt(1)

    def test_the_system_prompt_is_exactly_this(self):
        assert handler.SYSTEM_PROMPT == (
            "You are a data generation assistant that produces realistic, diverse synthetic customer "
            "reviews for software/product testing and analytics. Never use real people's names or real "
            "personal data; invent plausible but fictional reviewer first names with a last initial. Return "
            "ONLY a valid JSON array with no markdown fences or commentary."
        )


class TestGenerateBatch:
    def test_calls_bedrock_with_exactly_these_arguments(self):
        ing = configured()
        with patch.object(handler, "converse", return_value='[{"text": "Great"}]') as converse:
            assert ing._generate_batch(3) == [{"text": "Great"}]
        converse.assert_called_once_with(
            prompt=ing._build_prompt(3), system_prompt=handler.SYSTEM_PROMPT,
            max_tokens=4096, temperature=0.9, step_name="synthetic_reviews",
        )

    def test_a_bedrock_failure_is_logged_and_yields_nothing(self):
        ing = configured()
        with patch.object(handler, "converse", side_effect=RuntimeError("boom")), \
                patch.object(handler, "logger") as log:
            assert ing._generate_batch(3) == []
        assert _logged(log, "exception") == ["Bedrock generation failed: boom"]

    def test_is_traced(self):
        func = vars(handler.SyntheticReviewsIngestor)["_generate_batch"]
        assert func.__code__.co_filename.endswith(TRACER_SOURCE)
        assert vars(func)["__wrapped__"].__qualname__ == "SyntheticReviewsIngestor._generate_batch"


class TestParseReviews:
    def test_keeps_only_objects_with_text_from_an_array_inside_prose(self):
        reply = 'Sure!\n[{"text": "a"},\n {"text": ""}, {"title": "x"}, 5, "s", {"text": "b", "rating": 4}]\nDone.'
        assert handler.SyntheticReviewsIngestor._parse_reviews(reply) == [{"text": "a"}, {"text": "b", "rating": 4}]

    def test_a_reply_without_an_array_is_logged_and_yields_nothing(self):
        with patch.object(handler, "logger") as log:
            assert handler.SyntheticReviewsIngestor._parse_reviews("no reviews") == []
        assert _logged(log, "warning") == ["No JSON array found in synthetic reviews response"]

    def test_a_broken_array_is_logged_and_yields_nothing(self):
        with patch.object(handler, "logger") as log:
            assert handler.SyntheticReviewsIngestor._parse_reviews("[not json]") == []
        assert _logged(log, "warning") == [
            "Failed to parse synthetic reviews JSON: Expecting value: line 1 column 2 (char 1)",
        ]


@pytest.fixture
def fixed_identity() -> Iterator[None]:
    with patch.object(handler.uuid, "uuid4", return_value=SimpleNamespace(hex="cafe01")), \
            patch.object(handler.SyntheticReviewsIngestor, "_random_created_at", return_value="2026-01-02T03:04:05+00:00"):
        yield


@pytest.mark.usefixtures("fixed_identity")
class TestBuildItem:
    def test_a_full_review_becomes_exactly_this_item(self):
        review = {"text": " Love it ", "rating": "4", "title": " Wow ", "author": " Ann B. ", "focus_area": " speed "}
        assert configured(language="fr")._build_item(review) == {
            "id": "synthetic-cafe01",
            "text": "Love it",
            "rating": 4.0,
            "created_at": "2026-01-02T03:04:05+00:00",
            "channel": "review",
            "author": "Ann B.",
            "title": "Wow",
            "language": "fr",
            "metadata": {
                "is_synthetic": True,
                "generator": "synthetic_reviews",
                "generator_model": "claude-sonnet-4-5",
                "focus_area": "speed",
            },
        }

    @pytest.mark.parametrize(
        "review",
        [
            {"text": "Ok"},
            {"text": "Ok", "rating": None, "title": None, "author": None, "focus_area": None},
            {"text": "Ok", "rating": "  ", "title": "  ", "author": "  ", "focus_area": "  "},
        ],
        ids=["absent", "none", "blank"],
    )
    def test_missing_optional_fields_become_general_and_none(self, review):
        item = configured()._build_item(review)
        assert item is not None
        assert (item["metadata"]["focus_area"], item["author"], item["title"], item["rating"]) == (
            "general", None, None, None,
        )

    def test_whitespace_only_text_builds_no_item(self):
        assert configured()._build_item({"text": " \n "}) is None

    def test_text_is_cut_at_50000_characters(self):
        item = configured()._build_item({"text": "a" * 50_001})
        assert item is not None
        assert item["text"] == "a" * 50_000


class TestCoerceRating:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("4", 4.0), (0, 1.0), (1, 1.0), (2, 2.0), (4, 4.0), (5, 5.0), (6, 5.0), (3.6, 4.0), (2.5, 2.0),
         (None, None), ("x", None), ([1], None)],
    )
    def test_ratings_are_rounded_into_1_through_5(self, raw, expected):
        result = handler.SyntheticReviewsIngestor._coerce_rating(raw)
        assert result == expected
        assert type(result) is type(expected)


class TestRandomCreatedAt:
    def test_spreads_over_0_to_90_days_23_hours_59_minutes_before_now(self):
        clock = MagicMock()
        clock.now.return_value = datetime(2026, 4, 1, 12, 0, tzinfo=UTC)
        with patch.object(handler, "datetime", clock), \
                patch.object(handler.random, "randint", side_effect=[90, 23, 59]) as randint:
            assert handler.SyntheticReviewsIngestor._random_created_at() == "2025-12-31T12:01:00+00:00"
        assert randint.call_args_list == [call(0, 90), call(0, 23), call(0, 59)]
        clock.now.assert_called_once_with(UTC)


def _reviews(count: int) -> list[dict]:
    return [{"text": f"review {i}"} for i in range(count)]


@pytest.fixture
def observed() -> Iterator[SimpleNamespace]:
    with patch.object(handler, "logger") as log, patch.object(handler, "metrics") as metrics:
        yield SimpleNamespace(log=log, metrics=metrics)


class TestFetchNewItems:
    @pytest.mark.parametrize("secrets", [{"company_name": "Acme"}, {"product_name": "Rocket"}, {}])
    def test_without_company_and_product_nothing_is_generated(self, observed, secrets):
        ing = build(**secrets)
        ing._generate_batch = MagicMock()
        assert list(ing.fetch_new_items()) == []
        assert _logged(observed.log, "warning") == [
            "Synthetic generator not configured: company_name and product_name are required",
        ]
        ing._generate_batch.assert_not_called()
        observed.metrics.add_metric.assert_not_called()

    def test_25_reviews_are_asked_for_as_10_10_5(self, observed):
        ing = configured(num_reviews="25")
        batch: MagicMock = MagicMock(side_effect=[_reviews(10), _reviews(10), _reviews(5)])
        ing._generate_batch = batch
        items = list(ing.fetch_new_items())
        assert len(items) == 25
        assert batch.call_args_list == [call(10), call(10), call(5)]
        assert _logged(observed.log, "info") == [
            "Generating 25 synthetic reviews for 'Acme' / 'Rocket' (lang=en)",
            "Synthetic generation produced 25 reviews",
        ]
        observed.metrics.add_metric.assert_called_once_with(name="SyntheticReviewsGenerated", unit="Count", value=25)

    @pytest.mark.usefixtures("observed")
    def test_a_single_review_is_one_batch_of_one(self):
        ing = configured(num_reviews="1")
        batch: MagicMock = MagicMock(side_effect=[_reviews(1)])
        ing._generate_batch = batch
        assert [item["text"] for item in ing.fetch_new_items()] == ["review 0"]
        assert batch.call_args_list == [call(1)]

    def test_an_empty_batch_stops_the_run(self, observed):
        ing = configured(num_reviews="30")
        batch: MagicMock = MagicMock(side_effect=[_reviews(10), []])
        ing._generate_batch = batch
        assert len(list(ing.fetch_new_items())) == 10
        assert batch.call_args_list == [call(10), call(10)]
        assert _logged(observed.log, "warning") == ["Batch returned no parseable reviews; stopping early"]
        observed.metrics.add_metric.assert_called_once_with(name="SyntheticReviewsGenerated", unit="Count", value=10)

    def test_a_blank_review_is_neither_yielded_nor_counted(self, observed):
        ing = configured(num_reviews="10")
        ing._generate_batch = MagicMock(side_effect=[[{"text": " "}, *_reviews(8), {"text": "\t"}]])
        assert [item["text"] for item in ing.fetch_new_items()] == [f"review {i}" for i in range(8)]
        assert _logged(observed.log, "info")[-1] == "Synthetic generation produced 8 reviews"
        observed.metrics.add_metric.assert_called_once_with(name="SyntheticReviewsGenerated", unit="Count", value=8)


class TestNormalizeItem:
    def test_every_synthetic_field_is_carried(self):
        ing = configured()
        ing.store_raw_to_s3 = MagicMock(return_value="s3://bucket/raw/x.json")
        metadata = {"is_synthetic": True}
        item = {"id": "i1", "text": "t", "author": "Ann", "title": "T", "language": "fr", "metadata": metadata}
        normalized = ing.normalize_item(item)
        assert {k: normalized[k] for k in ("id", "author", "title", "language", "metadata", "s3_raw_uri")} == {
            "id": "i1", "author": "Ann", "title": "T", "language": "fr", "metadata": metadata,
            "s3_raw_uri": "s3://bucket/raw/x.json",
        }

    def test_a_none_field_is_left_out(self):
        ing = configured()
        ing.store_raw_to_s3 = MagicMock(return_value="s3://bucket/raw/x.json")
        normalized = ing.normalize_item({"id": "i1", "text": "t", "author": None, "title": "T"})
        assert "author" not in normalized
        assert "language" not in normalized
        assert normalized["title"] == "T"


# A plain object, not a MagicMock: Powertools reads `context.lambda_context` whenever it exists.
LAMBDA_CONTEXT = SimpleNamespace(
    function_name="voc-synthetic-reviews-ingestor",
    memory_limit_in_mb=1024,
    invoked_function_arn="arn:aws:lambda:us-east-1:123456789012:function:voc-synthetic-reviews-ingestor",
    aws_request_id="req-synthetic-0001",
    get_remaining_time_in_millis=lambda: 900_000,
)
RUN_RESULT = {"status": "success", "items_processed": 4}


def _invoke(event: object) -> object:
    return handler.lambda_handler(event, LAMBDA_CONTEXT)


@pytest.fixture
def stub_ingestor() -> Iterator[MagicMock]:
    """Replace the ingestor class; its instances' ``run`` returns ``RUN_RESULT``."""
    stub = MagicMock()
    stub.return_value.run.return_value = RUN_RESULT
    with patch.object(handler, "SyntheticReviewsIngestor", stub):
        yield stub


class TestLambdaHandler:
    @pytest.mark.parametrize(
        ("event", "execution_id"), [({"execution_id": "exec-7"}, "exec-7"), ({}, None), ([], None)],
    )
    def test_passes_the_execution_id_and_returns_the_run(self, stub_ingestor: MagicMock, event, execution_id):
        assert _invoke(event) == RUN_RESULT
        stub_ingestor.assert_called_once_with(execution_id=execution_id)

    def test_keeps_every_instrumentation_layer(self):
        assert handler_layers(handler.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS

    @pytest.mark.usefixtures("stub_ingestor")
    def test_a_cold_start_flushes_only_the_cold_start_metric(self, capsys):
        assert cold_start_metric_names(handler.metrics, lambda: _invoke({}), capsys) == {"ColdStart"}


def test_loading_the_module_puts_the_plugin_root_first_on_sys_path():
    snapshot = list(sys.path)
    try:
        assert_loading_puts_root_first(
            lambda: load_fresh("synthetic_reviews.ingestor._handler_under_test", MODULE_PATH), snapshot, PLUGIN_ROOT,
        )
    finally:
        sys.path[:] = snapshot


def test_the_reply_parser_round_trips_what_the_prompt_asks_for():
    reply = json.dumps([{"text": "Nice", "rating": 5, "title": "Yes", "author": "Bo C.", "focus_area": "speed"}])
    assert handler.SyntheticReviewsIngestor._parse_reviews(reply) == json.loads(reply)
