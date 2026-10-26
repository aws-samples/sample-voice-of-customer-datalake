"""Mutation hardening for the iOS `itunes_client` RSS page walker.

`test_itunes_client.py` pins the paging policy (an intermittent blank page is
skipped, three blanks in a row end the country, a connection failure keeps what
was collected) but only ever counts reviews or greps the path for `sortby=`. A
mutation run found everything else unobserved:

* the WIRE SHAPE of a parsed review — the exact keys `id`, `date`, `user_name`,
  `rating`, `title`, `review`, `developer_response` that the handler's
  `_format_review` reads verbatim (a renamed key silently empties the text or
  the author of every iOS review);
* the exact RSS path Apple is asked for, starting at `page=1` and stopping at
  `page=10` — the feed has no page 11, and page 0 is not a page;
* that a page which raises `AppStoreError` COUNTS as an empty page (three
  failing pages in a row end the country) rather than resetting the counter;
* the default `limit` of 50 and that a zero limit requests nothing;
* the session's rate-limit and retry configuration (`delay=0.5`,
  `delay_jitter=0.2`, `retries=3`, backoff factor 2, backoff cap 10 s), which is
  what keeps Apple from throttling the ingestor;
* the two warning lines an operator searches the logs for.
"""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
import urllib3
from app_store_web_scraper._errors import AppStoreError

from _shared.test.offline_plugin_imports import import_plugin_client_offline

itunes_client = import_plugin_client_offline(__file__, "itunes_client")


def _entry(i: int) -> dict:
    return {
        "id": {"label": str(i)},
        "updated": {"label": "2024-01-01T00:00:00-07:00"},
        "author": {"name": {"label": f"user {i}"}},
        "im:rating": {"label": "4"},
        "title": {"label": f"title {i}"},
        "content": {"label": f"review {i}"},
    }


def _page(entries: list | None) -> dict:
    feed: dict = {"link": [{"attributes": {"rel": "self"}}]}
    if entries is not None:
        feed["entry"] = entries
    return {"feed": feed}


def _requested_paths(session: MagicMock) -> list[str]:
    return [call.args[0] for call in session._get.call_args_list]


class TestParsedReviewShape:
    def test_a_parsed_review_has_exactly_the_keys_the_handler_formats(self):
        assert itunes_client._parse_entry(_entry(7)) == {
            "id": "7",
            "date": datetime(2024, 1, 1, 7, 0, tzinfo=UTC),
            "user_name": "user 7",
            "rating": 4,
            "title": "title 7",
            "review": "review 7",
            "developer_response": None,
        }

    def test_a_numeric_id_is_stringified(self):
        entry = _entry(1)
        entry["id"] = {"label": 42}
        parsed = itunes_client._parse_entry(entry)
        assert parsed is not None
        assert parsed["id"] == "42"

    @pytest.mark.parametrize(
        "field", ["id", "updated", "author", "im:rating", "title", "content"]
    )
    def test_a_missing_field_makes_the_entry_unparseable(self, field: str):
        entry = _entry(1)
        del entry[field]
        assert itunes_client._parse_entry(entry) is None

    def test_a_non_numeric_rating_makes_the_entry_unparseable(self):
        entry = _entry(1)
        entry["im:rating"] = {"label": "five"}
        assert itunes_client._parse_entry(entry) is None


class TestRequestedPages:
    def test_the_exact_rss_path(self):
        assert (
            itunes_client._rss_path("kr", "284882215", 3, "mostrecent")
            == "/kr/rss/customerreviews/page=3/id=284882215/sortby=mostrecent/json"
        )

    def test_paging_starts_at_page_1_and_stops_at_page_10(self):
        """Apple exposes ten pages; an eleventh is never requested even when
        every page is full and the limit is not reached."""
        session = MagicMock()
        session._get.side_effect = [_page([_entry(i)]) for i in range(20)]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=1000)
        assert itunes_client._MAX_PAGES == 10
        assert _requested_paths(session) == [
            f"/kr/rss/customerreviews/page={page}/id=1/sortby=mostrecent/json"
            for page in range(1, 11)
        ]
        assert [review["id"] for review in result] == [str(i) for i in range(10)]

    def test_a_zero_limit_requests_nothing(self):
        session = MagicMock()
        assert itunes_client.fetch_reviews_for_country("1", "kr", session, limit=0) == []
        session._get.assert_not_called()

    def test_the_default_limit_is_50(self):
        session = MagicMock()
        session._get.side_effect = [_page([_entry(i) for i in range(60)])]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session)
        assert len(result) == 50
        assert session._get.call_count == 1

    def test_three_consecutive_failing_pages_end_the_country(self):
        """A page that raises AppStoreError counts as an empty page: it must
        not reset the consecutive-empty counter and keep the walk going."""
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(0)]),
            AppStoreError("500"),
            AppStoreError("500"),
            AppStoreError("500"),
            _page([_entry(99)]),
        ]
        result = itunes_client.fetch_reviews_for_country("1", "kr", session, limit=500)
        assert [review["id"] for review in result] == ["0"]
        assert session._get.call_count == 4
        assert itunes_client._MAX_CONSECUTIVE_EMPTY == 3


class TestSessionConfiguration:
    def test_the_default_session_rate_limits_and_retries(self):
        with patch.object(itunes_client, "AppStoreSession") as session_cls:
            session_cls.return_value = MagicMock(name="session")
            assert itunes_client.create_session() is session_cls.return_value
        session_cls.assert_called_once_with(
            delay=0.5,
            delay_jitter=0.2,
            retries=3,
            retries_backoff_factor=2,
            retries_backoff_max=10,
        )

    def test_the_overrides_reach_the_session(self):
        with patch.object(itunes_client, "AppStoreSession") as session_cls:
            itunes_client.create_session(delay=1.0, jitter=0.0, retries=1)
        session_cls.assert_called_once_with(
            delay=1.0,
            delay_jitter=0.0,
            retries=1,
            retries_backoff_factor=2,
            retries_backoff_max=10,
        )


class TestWarningLines:
    def test_a_failed_page_is_logged_with_page_app_country_and_cause(self):
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(0)]),
            AppStoreError("HTTP 503"),
            _page(None), _page(None), _page(None),
        ]
        with patch.object(itunes_client, "logger") as logger:
            itunes_client.fetch_reviews_for_country("284882215", "kr", session, limit=500)
        logger.warning.assert_called_once_with(
            "iOS RSS page 2 failed for app 284882215 in kr: HTTP 503"
        )

    def test_a_connection_failure_is_logged_with_app_country_and_cause(self):
        session = MagicMock()
        session._get.side_effect = [
            _page([_entry(0)]),
            urllib3.exceptions.ProtocolError("connection reset"),
        ]
        with patch.object(itunes_client, "logger") as logger:
            result = itunes_client.fetch_reviews_for_country("284882215", "us", session, limit=500)
        assert [review["id"] for review in result] == ["0"]
        logger.warning.assert_called_once_with(
            "Failed to fetch iOS reviews for app 284882215 in us: connection reset"
        )
