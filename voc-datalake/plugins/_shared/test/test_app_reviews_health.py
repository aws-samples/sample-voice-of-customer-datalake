"""Storefront run health (`_shared/app_reviews_health.py`): causes, tallies, the review-drop check."""
from unittest.mock import MagicMock, patch

import pytest
import urllib3

from _shared.app_reviews_health import (
    MAX_COUNTRIES_LISTED,
    MAX_RUN_ERROR_CHARS,
    StorefrontFetch,
    StorefrontTally,
    check_review_drop,
    failure_cause,
)

MODULE = "_shared.app_reviews_health"


class MaxRetryError(urllib3.exceptions.HTTPError):
    """urllib3's MaxRetryError shape (a message naming the URL, the underlying ``reason``)."""

    def __init__(self, message: str, reason: BaseException | None):
        super().__init__(message)
        self.reason = reason


class TestFailureCause:
    @pytest.mark.parametrize(("error", "cause"), [
        (RuntimeError("iTunes API request failed with status 429"), "HTTP 429"),
        (MaxRetryError("retries exceeded", ConnectionResetError("reset")), "MaxRetryError(ConnectionResetError)"),
        (ValueError("Expecting value: line 1"), "ValueError"),
    ])
    def test_a_short_url_free_cause(self, error, cause):
        assert failure_cause(error) == cause

    def test_a_url_in_the_error_never_reaches_the_cause(self):
        error = MaxRetryError("Max retries exceeded with url: https://itunes.apple.com/us/rss/x", None)
        assert "http" not in failure_cause(error)


class TestTally:
    def _tally(self) -> StorefrontTally:
        return StorefrontTally("iOS", "Example Air", "123")

    def test_counts_each_outcome(self):
        tally = self._tally()
        tally.record("us", StorefrontFetch([{"id": 1}, {"id": 2}]))
        tally.record("gb", StorefrontFetch([]))
        tally.record("kr", StorefrontFetch([], "HTTP 403"))
        assert (tally.with_reviews, tally.empty, tally.failed, tally.reviews) == (1, 1, 1, 2)

    def test_a_clean_run_logs_one_info_line_and_no_run_row_text(self):
        tally = self._tally()
        tally.record("us", StorefrontFetch([{"id": 1}]))
        with patch(f"{MODULE}.logger") as logger:
            assert tally.report() is None
        logger.warning.assert_not_called()
        (message,), kwargs = logger.info.call_args
        assert message == "iOS Example Air (123): 1 storefronts with reviews, 0 empty, 0 failed, 1 reviews"
        assert kwargs["extra"]["storefront_summary"] == {
            "app": "Example Air", "app_identifier": "123", "storefronts_with_reviews": 1,
            "storefronts_empty": 0, "storefronts_failed": 0, "reviews": 1,
        }

    def test_many_failed_countries_are_listed_up_to_the_cap(self):
        tally = self._tally()
        countries = [f"c{n:02d}" for n in range(MAX_COUNTRIES_LISTED + 3)]
        for country in countries:
            tally.record(country, StorefrontFetch([], "HTTP 403"))
        with patch(f"{MODULE}.logger") as logger:
            text = tally.report()
        (warning,), _ = logger.warning.call_args
        assert warning.endswith(f"HTTP 403 x{len(countries)} ({', '.join(countries[:MAX_COUNTRIES_LISTED])}, +3 more)")
        assert text == f"Example Air: {len(countries)} storefronts failed (HTTP 403 x{len(countries)})"
        assert len(text or "") <= MAX_RUN_ERROR_CHARS


class TestReviewDrop:
    @staticmethod
    def _check(previous: str | None, candidates: int):
        set_wm = MagicMock()
        with patch(f"{MODULE}.logger") as logger:
            text = check_review_drop(lambda _key: previous, set_wm, platform_label="Android",
                                     app_name="Example Air", candidates=candidates)
        return text, set_wm, logger

    def test_a_drop_to_zero_warns(self):
        text, set_wm, logger = self._check("40", 0)
        assert text == "Example Air: no reviews from any storefront (previous run: 40)"
        logger.warning.assert_called_once()
        set_wm.assert_called_once_with("Example Air_last_count", "0")

    @pytest.mark.parametrize(("previous", "candidates"), [("40", 3), (None, 0), ("0", 0), ("x", 0)])
    def test_anything_else_is_quiet_and_still_stores_the_count(self, previous, candidates):
        text, set_wm, logger = self._check(previous, candidates)
        assert text is None
        logger.warning.assert_not_called()
        set_wm.assert_called_once_with("Example Air_last_count", str(candidates))
