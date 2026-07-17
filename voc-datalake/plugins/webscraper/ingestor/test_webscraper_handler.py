"""
Tests for the Web Scraper Ingestor handler.

Focus: `_extract_rating` rating extraction, including the word-based star
classes fix (issue #148, e.g. ``<p class="star-rating Three">``). Also
characterizes the pre-existing digit-class, rating-attribute, and text
fallbacks so a regression in any of them is caught. Plus the manual-run
secret-cache clear (issue #141).
"""

import pytest
from unittest.mock import patch, MagicMock
from bs4 import BeautifulSoup


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _el(html: str):
    """Return the first tag parsed from an HTML snippet."""
    return BeautifulSoup(html, "html.parser").find()


@pytest.fixture
def ingestor():
    """Create a WebScraperIngestor with mocked AWS dependencies."""
    with (
        patch("_shared.base_ingestor.get_dynamodb_resource") as mock_dynamo,
        patch("_shared.base_ingestor.get_s3_client"),
        patch("_shared.base_ingestor.get_sqs_client"),
        patch("_shared.base_ingestor.get_secret", return_value={}),
    ):
        mock_dynamo.return_value.Table.return_value = MagicMock()
        from webscraper.ingestor.handler import WebScraperIngestor
        return WebScraperIngestor()


# ---------------------------------------------------------------------------
# Word-based star classes (issue #148)
# ---------------------------------------------------------------------------

class TestExtractRatingWordClasses:
    def test_star_rating_three_returns_3(self, ingestor):
        # The books.toscrape.com pattern.
        el = _el('<p class="star-rating Three"></p>')
        assert ingestor._extract_rating(el, {}) == 3

    @pytest.mark.parametrize("word,expected", [
        ("One", 1), ("Two", 2), ("Three", 3), ("Four", 4), ("Five", 5),
    ])
    def test_all_word_ratings(self, ingestor, word, expected):
        el = _el(f'<p class="star-rating {word}"></p>')
        assert ingestor._extract_rating(el, {}) == expected

    def test_word_class_is_case_insensitive(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="FIVE"></p>'), {}) == 5
        assert ingestor._extract_rating(_el('<p class="four"></p>'), {}) == 4

    def test_word_only_matches_whole_class_token(self, ingestor):
        # 'foo-three' must NOT match 'three' (no substring matching), so it
        # falls through to the text fallback and returns None here.
        el = _el('<p class="foo-three"></p>')
        assert ingestor._extract_rating(el, {}) is None

    def test_out_of_range_digit_falls_through_to_word(self, ingestor):
        # First token has a digit outside 1-5 (ignored); the loop must
        # continue and resolve the word token.
        el = _el('<p class="rating-9 Three"></p>')
        assert ingestor._extract_rating(el, {}) == 3


# ---------------------------------------------------------------------------
# Pre-existing behavior (characterization / regression guards)
# ---------------------------------------------------------------------------

class TestExtractRatingExisting:
    def test_digit_in_class_still_works(self, ingestor):
        assert ingestor._extract_rating(_el('<span class="rating-4"></span>'), {}) == 4

    def test_rating_attribute_takes_precedence(self, ingestor):
        # data-rating is checked before class names.
        el = _el('<div data-rating="5" class="Two"></div>')
        assert ingestor._extract_rating(el, {}) == 5

    def test_custom_rating_attribute(self, ingestor):
        el = _el('<div data-stars="4"></div>')
        assert ingestor._extract_rating(el, {"rating_attribute": "data-stars"}) == 4

    def test_text_fallback_x_out_of_5(self, ingestor):
        assert ingestor._extract_rating(_el('<span>4/5</span>'), {}) == 4

    def test_text_fallback_stars(self, ingestor):
        assert ingestor._extract_rating(_el('<span>3 stars</span>'), {}) == 3

    def test_none_element_returns_none(self, ingestor):
        assert ingestor._extract_rating(None, {}) is None

    def test_no_rating_signal_returns_none(self, ingestor):
        assert ingestor._extract_rating(_el('<p class="star-rating"></p>'), {}) is None


# ---------------------------------------------------------------------------
# Manual-run secret-cache clear (issue #141)
# ---------------------------------------------------------------------------

@pytest.fixture
def lambda_context():
    ctx = MagicMock()
    ctx.function_name = "test-webscraper"
    ctx.memory_limit_in_mb = 512
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789:function:test"
    ctx.aws_request_id = "test-request-id"
    return ctx


class TestLambdaHandlerSecretCache:
    """Save-then-Run-now must not serve a pre-save secret snapshot (#141).

    The cache-clear itself is centralized in BaseIngestor.__init__ (#215) and
    covered by plugins/_shared/test/test_base_ingestor.py — the handler's
    remaining contract is passing execution_id INTO the constructor, which is
    what triggers the guard. These tests fail if that pass-through is removed
    (which would silently reintroduce #141).
    """

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_manual_run_passes_execution_id_to_constructor(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler(
            {"execution_id": "exec-1", "scraper_id": "s1"}, lambda_context
        )

        MockIngestor.assert_called_once_with(
            execution_id="exec-1", target_scraper_id="s1"
        )

    @patch("webscraper.ingestor.handler.WebScraperIngestor")
    def test_scheduled_run_passes_no_execution_id(
        self, MockIngestor, lambda_context
    ):
        from webscraper.ingestor.handler import lambda_handler
        MockIngestor.return_value.run.return_value = {"status": "success"}

        lambda_handler({}, lambda_context)

        MockIngestor.assert_called_once_with(
            execution_id=None, target_scraper_id=None
        )

    @patch("_shared.base_ingestor.get_dynamodb_resource")
    @patch("_shared.base_ingestor.get_s3_client")
    @patch("_shared.base_ingestor.get_sqs_client")
    @patch("_shared.base_ingestor.get_secret")
    @patch("_shared.base_ingestor.clear_secret_cache")
    def test_manual_construction_clears_cache_before_config_read(
        self, mock_clear, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """End-to-end through the REAL WebScraperIngestor: constructing with
        an execution_id clears the cache before the secret/config is read."""
        call_order = []
        mock_clear.side_effect = lambda: call_order.append("clear")

        def record_get_secret(_arn):
            call_order.append("get_secret")
            return {"configs": "[]"}

        mock_get_secret.side_effect = record_get_secret
        mock_dynamo.return_value.Table.return_value = MagicMock()

        from webscraper.ingestor.handler import WebScraperIngestor
        ingestor = WebScraperIngestor(execution_id="exec-1", target_scraper_id="s1")

        assert call_order == ["clear", "get_secret"]
        assert ingestor.execution_id == "exec-1"
