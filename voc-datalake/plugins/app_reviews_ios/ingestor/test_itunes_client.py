"""
Unit tests for the iOS itunes_client page-by-page RSS fetch.

Mocks the session so these run offline. Verifies that an intermittent empty
page in the middle of a populated feed is SKIPPED (not treated as the end) —
the bug that truncated Korean reviews to ~150 instead of ~450.
"""
import json
from pathlib import Path
from unittest.mock import MagicMock

import urllib3
from app_store_web_scraper._errors import AppStoreError

from _shared.test.offline_plugin_imports import import_plugin_client_offline

itunes_client = import_plugin_client_offline(__file__, "itunes_client")


def _entry(i):
    return {
        "id": {"label": str(i)},
        "updated": {"label": "2024-01-01T00:00:00-07:00"},
        "author": {"name": {"label": "user"}},
        "im:rating": {"label": "5"},
        "title": {"label": f"title {i}"},
        "content": {"label": f"review {i}"},
        "im:version": {"label": "1.0"},
    }


def _page(entries):
    feed = {"link": [{"attributes": {"rel": "self"}}]}
    if entries is not None:
        feed["entry"] = entries
    return {"feed": feed}


class TestPagination:
    def test_skips_intermittent_empty_page(self):
        """An empty page mid-feed is skipped; later pages still collected."""
        session = MagicMock()
        # page1=50, page2=empty(blip), page3=50, page4..=empty end
        session._get.side_effect = [
            _page([_entry(i) for i in range(50)]),    # p1
            _page(None),                               # p2 empty (intermittent)
            _page([_entry(i) for i in range(50, 100)]),# p3
            _page(None), _page(None), _page(None),     # p4,5,6 → 3 consecutive empty → stop
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert len(result) == 100  # NOT truncated at the empty page2

    def test_stops_after_consecutive_empties(self):
        """Stops once MAX_CONSECUTIVE_EMPTY pages in a row are empty."""
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(0)]),
            _page(None), _page(None), _page(None),  # 3 in a row → stop
            _page([_entry(99)]),  # would-be more, but we already stopped
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert len(result) == 1
        # Should not have requested the 5th page.
        assert session._get.call_count == 4

    def test_respects_limit(self):
        session = MagicMock()
        session._get.side_effect = [_page([_entry(i) for i in range(50)]) for _ in range(10)]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=120)
        assert len(result) == 120

    def test_transient_http_error_skips_page(self):
        """A page that raises AppStoreError is skipped, not fatal."""
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(i) for i in range(50)]),
            AppStoreError("503"),                       # transient
            _page([_entry(i) for i in range(50, 80)]),
            _page(None), _page(None), _page(None),
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert len(result) == 80  # both good pages collected despite the error

    def test_malformed_entry_skipped(self):
        """A malformed entry is dropped without killing the whole page."""
        session = MagicMock()
        good = _entry(1)
        bad = {"id": {"label": "2"}}  # missing required fields
        session._get.side_effect = [
            _page([good, bad]),
            _page(None), _page(None), _page(None),
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert len(result) == 1


class TestFailures:
    def test_connection_failure_returns_what_was_collected(self):
        """A urllib3 error (retries exhausted) ends the country, keeping earlier pages."""
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(i) for i in range(50)]),
            urllib3.exceptions.MaxRetryError(
                urllib3.HTTPSConnectionPool("itunes.apple.com"), "/x", None
            ),
            _page([_entry(99)]),
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert len(result) == 50
        assert session._get.call_count == 2

    def test_undecodable_page_returns_what_was_collected(self):
        session = MagicMock()
        session._get.side_effect = [_page([_entry(0)]), ValueError("bad json"), _page([_entry(1)])]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert [review["id"] for review in result] == ["0"]

    def test_non_list_entry_is_a_non_empty_page_without_reviews(self):
        """A present-but-odd `entry` resets the empty counter and yields nothing."""
        session = MagicMock()
        session._get.side_effect = [
            _page(None), _page(None),
            {"feed": {"entry": {"id": {"label": "x"}}}},
            _page(None), _page(None), _page([_entry(7)]),
            _page(None), _page(None), _page(None),
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert [review["id"] for review in result] == ["7"]
        assert session._get.call_count == 9


class TestSortBy:
    """`sort_by` reaches the RSS URL (it used to be accepted and ignored)."""

    @staticmethod
    def _requested_paths(sort_by):
        session = MagicMock()
        session._get.side_effect = [_page([_entry(0)]), _page(None), _page(None), _page(None)]
        itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500, sort_by=sort_by)
        return [call.args[0] for call in session._get.call_args_list]

    def test_legacy_most_critical_falls_back_to_most_recent(self):
        """Apple answers `sortby=mostcritical` with HTTP 500 (live feed, verified),
        so a config saved with the removed option must not request it."""
        paths = self._requested_paths("most_critical")
        assert paths
        assert all("/sortby=mostrecent/" in path for path in paths)
        assert not any("mostcritical" in path for path in paths)

    def test_the_mapping_covers_every_manifest_option(self):
        manifest = json.loads((Path(__file__).resolve().parents[1] / "manifest.json").read_text())
        field = next(f for f in manifest["config"] if f["key"] == "sort_by")
        options = {option["value"] for option in field["options"]}
        assert options == set(itunes_client._RSS_SORT_BY)
