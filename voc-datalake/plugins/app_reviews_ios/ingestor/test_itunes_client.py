"""
Unit tests for the iOS itunes_client page-by-page RSS fetch.

Mocks the session so these run offline. Verifies that an intermittent empty
page in the middle of a populated feed is SKIPPED (not treated as the end) —
the bug that truncated Korean reviews to ~150 instead of ~450.
"""
import sys
import types
import logging
from pathlib import Path
from unittest.mock import MagicMock

# Stub _shared.base_ingestor.logger so the module imports offline.
_shared = types.ModuleType("_shared")
_base = types.ModuleType("_shared.base_ingestor")
_base.logger = logging.getLogger("test")
sys.modules.setdefault("_shared", _shared)
sys.modules.setdefault("_shared.base_ingestor", _base)

sys.path.insert(0, str(Path(__file__).parent))
import itunes_client  # noqa: E402
from app_store_web_scraper._errors import AppStoreError  # noqa: E402


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
