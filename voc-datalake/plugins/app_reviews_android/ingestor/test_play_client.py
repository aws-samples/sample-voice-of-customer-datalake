"""
Unit tests for the Android play_client continuation-token pagination.

Mocks google_play_scraper.reviews so these run offline (no network). Verifies
that fetch_reviews_for_country paginates until `count` or token exhaustion —
the bug that previously truncated large apps to a single ~200-review page.
"""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from _shared.test.offline_plugin_imports import import_plugin_client_offline

play_client = import_plugin_client_offline(__file__, "play_client")
Sort = play_client.Sort

_MANIFEST = Path(__file__).resolve().parents[1] / "manifest.json"


def _make_page(n, start=0):
    return [{"reviewId": f"r{start + i}", "content": f"review {start + i}"} for i in range(n)]


def _fetch(count, sort_by="newest"):
    return play_client.fetch_reviews_for_country(
        "com.x", country="kr", count=count, sort_by=sort_by, lang="ko"
    )


def _recording(fake):
    """Wrap a page function so every call's kwargs are recorded."""
    calls = []

    def fake_reviews(_pkg, **kwargs):
        calls.append(kwargs)
        return fake(len(calls) - 1, kwargs)

    return calls, fake_reviews


class TestPagination:
    def test_paginates_full_pages_until_the_token_runs_out(self):
        """Loops via continuation_token, asking 200 per page, until token=None."""
        calls, fake_reviews = _recording(
            lambda page, _kw: (_make_page(200, start=page * 200), f"tok{page}")
            if page < 3
            else ([], None)
        )

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=5000)
        assert len(result) == 600  # 3 pages x 200
        assert result[0]["reviewId"] == "r0"
        assert result[-1]["reviewId"] == "r599"
        assert len(calls) == 4
        assert [c["count"] for c in calls] == [200, 200, 200, 200]
        # First call has no token, subsequent calls carry the prior token.
        assert [c["continuation_token"] for c in calls] == [None, "tok0", "tok1", "tok2"]

    def test_asks_only_for_the_remainder_and_stops_at_count(self):
        """The last page request is sized to what is still missing, not 200."""
        calls, fake_reviews = _recording(lambda _page, _kw: (_make_page(200), "more"))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=300)
        assert len(result) == 300
        assert [c["count"] for c in calls] == [200, 100]

    def test_stops_without_an_extra_call_when_count_is_met_exactly(self):
        """count hit on a page boundary: no third request with count=0."""
        calls, fake_reviews = _recording(lambda _page, _kw: (_make_page(200), "more"))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=400)
        assert len(result) == 400
        assert len(calls) == 2

    def test_fetches_a_final_page_of_one_when_one_review_is_missing(self):
        calls, fake_reviews = _recording(lambda _page, _kw: (_make_page(200), "more"))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=201)
        assert len(result) == 201
        assert [c["count"] for c in calls] == [200, 1]

    def test_stops_when_token_none(self):
        """A single page with token=None ends the loop (no infinite spin)."""
        calls, fake_reviews = _recording(lambda _page, _kw: (_make_page(95), None))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=5000)
        assert len(result) == 95
        assert len(calls) == 1

    def test_stops_on_an_empty_page_even_with_a_token(self):
        calls, fake_reviews = _recording(lambda _page, _kw: ([], "tok"))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=5000)
        assert result == []
        assert len(calls) == 1

    def test_gives_up_after_200_rounds_when_the_token_never_runs_out(self):
        """Backstop: a token that never ends cannot spin forever."""
        calls, fake_reviews = _recording(
            lambda page, _kw: (_make_page(1, start=page), "again")
        )

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=5000)
        assert len(calls) == 200
        assert len(result) == 200

    def test_lang_and_country_passed_through(self):
        """lang/country are forwarded to the library (Google Play filters by language)."""
        calls, fake_reviews = _recording(lambda _page, _kw: ([], None))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            _fetch(count=10)
        assert calls[0]["lang"] == "ko"
        assert calls[0]["country"] == "kr"

    def test_returns_partial_on_error(self):
        """An exception mid-pagination returns what was collected so far."""
        def fake_reviews(_pkg, **kwargs):
            if kwargs.get("continuation_token") is None:
                return _make_page(200), "tok0"
            raise RuntimeError("network blip")

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            result = _fetch(count=5000)
        assert len(result) == 200  # first page kept, error swallowed


class TestSortOrder:
    @pytest.mark.parametrize(
        ("sort_by", "expected"),
        [
            ("newest", Sort.NEWEST),
            ("rating", Sort.MOST_RELEVANT),
            ("bogus", Sort.NEWEST),  # unknown values fall back to newest
        ],
    )
    def test_maps_sort_by_to_the_library_sort(self, sort_by, expected):
        calls, fake_reviews = _recording(lambda _page, _kw: ([], None))

        with patch.object(play_client, "reviews", side_effect=fake_reviews):
            _fetch(count=10, sort_by=sort_by)
        assert calls[0]["sort"] is expected

    def test_sort_map_keys_match_the_manifest_options(self):
        """Every sort_by option the manifest offers has an explicit mapping."""
        manifest = json.loads(_MANIFEST.read_text())
        field = next(f for f in manifest["config"] if f["key"] == "sort_by")
        assert {o["value"] for o in field["options"]} == {"newest", "rating"}
        assert set(play_client.SORT_MAP) == {"newest", "rating"}
