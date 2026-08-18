"""
Unit tests for the Android play_client continuation-token pagination.

Mocks google_play_scraper.reviews so these run offline (no network). Verifies
that fetch_reviews_for_country paginates until `count` or token exhaustion —
the bug that previously truncated large apps to a single ~200-review page.
"""
import sys
import types
import logging
from pathlib import Path
from unittest.mock import patch

# play_client imports `_shared.base_ingestor.logger`; stub it so the module
# imports without the full Lambda layer present.
_shared = types.ModuleType("_shared")
_base = types.ModuleType("_shared.base_ingestor")
_base.logger = logging.getLogger("test")
sys.modules.setdefault("_shared", _shared)
sys.modules.setdefault("_shared.base_ingestor", _base)

sys.path.insert(0, str(Path(__file__).parent))
import play_client  # noqa: E402


def _make_page(n, start=0):
    return [{"reviewId": f"r{start + i}", "content": f"review {start + i}"} for i in range(n)]


class TestPagination:
    def test_paginates_until_count(self):
        """Loops via continuation_token across multiple pages up to `count`."""
        calls = []

        def fake_reviews(pkg, **kwargs):
            calls.append(kwargs)
            page = len(calls) - 1
            # 3 pages of 200, then token=None (exhausted)
            if page < 3:
                return _make_page(200, start=page * 200), f"tok{page}"
            return [], None

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = play_client.fetch_reviews_for_country(
                "com.x", country="kr", count=5000, lang="ko"
            )
        assert len(result) == 600  # 3 pages × 200
        # First call has no token, subsequent calls carry the prior token.
        assert calls[0]["continuation_token"] is None
        assert calls[1]["continuation_token"] == "tok0"

    def test_respects_count_cap(self):
        """Stops at `count` even if more reviews are available."""
        def fake_reviews(pkg, **kwargs):
            return _make_page(200), "more"

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = play_client.fetch_reviews_for_country(
                "com.x", country="kr", count=300, lang="ko"
            )
        assert len(result) == 300

    def test_stops_when_token_none(self):
        """A single page with token=None ends the loop (no infinite spin)."""
        def fake_reviews(pkg, **kwargs):
            return _make_page(95), None

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = play_client.fetch_reviews_for_country(
                "com.x", country="us", count=5000, lang="en"
            )
        assert len(result) == 95

    def test_lang_passed_through(self):
        """lang is forwarded to the library (Google Play filters by language)."""
        seen = {}

        def fake_reviews(pkg, **kwargs):
            seen.update(kwargs)
            return [], None

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            play_client.fetch_reviews_for_country("com.x", country="kr", count=10, lang="ko")
        assert seen["lang"] == "ko"
        assert seen["country"] == "kr"

    def test_returns_partial_on_error(self):
        """An exception mid-pagination returns what was collected so far."""
        def fake_reviews(pkg, **kwargs):
            if kwargs.get("continuation_token") is None:
                return _make_page(200), "tok0"
            raise RuntimeError("network blip")

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = play_client.fetch_reviews_for_country(
                "com.x", country="kr", count=5000, lang="ko"
            )
        assert len(result) == 200  # first page kept, error swallowed
