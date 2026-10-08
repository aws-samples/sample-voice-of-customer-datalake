"""Mutation hardening for `_shared/github_api.py`.

`github_issues/test/test_github_issues_ingestor.py` reaches this client only
through the ingestor, which swallows most of what the client decides: a
``StopRun`` ends the run whatever its wording, a ``GitHubError`` fails it
whatever the status, and a page is consumed for its body alone. A mutation run
therefore found 40 mutants those tests cannot see:

* the REQUEST ITSELF — the exact ``Accept`` / ``X-GitHub-Api-Version`` /
  ``User-Agent`` headers, the 15 second timeout, ``If-None-Match`` only when an
  ETag is given, and the ``requests.get`` call behind the seam;
* every REFUSAL'S wording and class — ``GitHub <status> for <path>``, the
  ``rate_limited: retry after <n>`` detail (``Retry-After`` preferred over
  ``X-RateLimit-Reset``), the ``quota floor reached`` and ``time_budget``
  reasons, the off-host refusal — and that a 403 without a rate-limit signal,
  or a 500 with ``remaining == 0``, is an error and not a stop;
* the BOUNDARIES: a quota of exactly 25 trips the floor and 26 does not, a
  deadline exactly 20 seconds away is still spent and 19.99 is not, a 400 is an
  error, a 304 is not;
* the shape of a page: dataclass defaults, ``not_modified`` on a 200 is
  ``False``, header names are matched case-insensitively, and ``requests_made``
  counts one per request;
* ``_next_link``'s parsing, which the ingestor only ever feeds a well-formed
  header: ``rel="last"`` listed first, unquoted or absent ``rel``, a URL not
  wrapped in angle brackets.
"""
from dataclasses import dataclass, field
from unittest.mock import MagicMock, patch

import pytest

from _shared import github_api
from _shared.github_api import (
    GITHUB_API,
    GitHubClient,
    GitHubError,
    GitHubNotFound,
    GitHubPage,
    StopRun,
    _int_header,
    _next_link,
)

TOKEN = "ghp_secret_token"
PATH = "/repos/acme/Kiro/issues"
URL = f"{GITHUB_API}{PATH}"
PAGE_2 = f"{URL}?state=all&page=2"
PAGE_3 = f"{URL}?state=all&page=3"
EXPECTED_HEADERS = {
    "Accept": "application/vnd.github+json",
    "Authorization": f"Bearer {TOKEN}",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "voc-datalake-github-issues",
}


@dataclass
class Response:
    status_code: int = 200
    body: object = None
    headers: dict = field(default_factory=dict)

    def json(self):
        return self.body


def ok(body=None, *, remaining="4000", **headers) -> Response:
    """A 200 whose extra headers are given as keyword arguments (``Link=...``, ``ETag=...``)."""
    return Response(200, body, {"X-RateLimit-Remaining": remaining, **headers})


@pytest.fixture
def http():
    """The patched network seam; ``http.side_effect`` is the list of responses to answer with."""
    seam = MagicMock(name="_http_get")
    with patch("_shared.github_api._http_get", seam):
        yield seam


def client(**kwargs) -> GitHubClient:
    return GitHubClient(TOKEN, **kwargs)


class TestTheRequestItselfIsPinned:
    def test_sends_exactly_these_headers_the_params_and_a_15_second_timeout(self, http):
        http.side_effect = [ok([])]
        client().get(URL, params={"state": "all", "per_page": 100})
        http.assert_called_once_with(URL, EXPECTED_HEADERS, {"state": "all", "per_page": 100}, 15)

    def test_an_etag_travels_as_if_none_match_and_only_then(self, http):
        http.side_effect = [ok([]), ok([])]
        c = client()
        c.get(URL, etag='W/"abc"')
        c.get(URL)
        first, second = http.call_args_list
        assert first.args[1] == {**EXPECTED_HEADERS, "If-None-Match": 'W/"abc"'}
        assert second.args[1] == EXPECTED_HEADERS
        assert "If-None-Match" not in second.args[1]

    def test_the_seam_is_one_requests_get_with_keyword_arguments(self):
        with patch.object(github_api.requests, "get") as get:
            result = github_api._http_get(URL, {"A": "b"}, {"q": 1}, 15)
        get.assert_called_once_with(URL, headers={"A": "b"}, params={"q": 1}, timeout=15)
        assert result is get.return_value

    def test_requests_made_counts_one_per_request(self, http):
        http.side_effect = [ok([]), ok([]), ok([])]
        c = client()
        assert c.requests_made == 0
        c.get(URL)
        assert c.requests_made == 1
        c.get(URL)
        c.get(URL)
        assert c.requests_made == 3


class TestASuccessfulPage:
    def test_body_etag_and_next_link_come_from_the_response(self, http):
        http.side_effect = [ok([{"number": 1}], ETag='"e1"', Link=f'<{PAGE_2}>; rel="next", <{PAGE_3}>; rel="last"')]
        page = client().get(URL)
        assert page == GitHubPage(body=[{"number": 1}], etag='"e1"', next_url=PAGE_2, not_modified=False)
        assert page.not_modified is False

    def test_header_names_are_matched_case_insensitively(self, http):
        http.side_effect = [Response(200, [], {"etag": '"lower"', "LINK": f'<{PAGE_2}>; rel="next"', "x-ratelimit-remaining": "25"})]
        c = client()
        page = c.get(URL)
        assert page.etag == '"lower"'
        assert page.next_url == PAGE_2
        with pytest.raises(StopRun):
            c.get(URL)

    def test_without_etag_or_link_both_are_none(self, http):
        http.side_effect = [ok([])]
        page = client().get(URL)
        assert page.etag is None
        assert page.next_url is None

    def test_a_304_is_the_given_etag_and_nothing_else(self, http):
        http.side_effect = [Response(304, {"ignored": True}, {"ETag": '"other"', "Link": f'<{PAGE_2}>; rel="next"'})]
        page = client().get(URL, etag='"mine"')
        assert page == GitHubPage(body=None, etag='"mine"', next_url=None, not_modified=True)
        assert page.body is None
        assert page.next_url is None
        assert page.not_modified is True

    def test_a_200_carrying_retry_after_or_zero_remaining_is_still_a_page(self, http):
        http.side_effect = [ok([1], **{"Retry-After": "60"}), ok([2], remaining="0")]
        c = client()
        assert c.get(URL).body == [1]
        assert c.get(URL).body == [2]

    def test_the_dataclass_defaults(self):
        assert GitHubPage() == GitHubPage(None, None, None, False)
        page = GitHubPage()
        assert page.body is None
        assert page.etag is None
        assert page.next_url is None
        assert page.not_modified is False


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize("status", [400, 401, 403, 422, 500, 503])
    def test_a_failing_status_is_a_github_error_naming_status_and_path(self, http, status):
        http.side_effect = [Response(status, {"message": "secret-free"}, {"X-RateLimit-Remaining": "100"})]
        with pytest.raises(GitHubError) as exc:
            client().get(URL)
        assert str(exc.value) == f"GitHub {status} for {PATH}"
        assert type(exc.value) is GitHubError
        assert TOKEN not in str(exc.value)

    def test_a_404_is_a_not_found_which_is_also_a_github_error(self, http):
        http.side_effect = [Response(404, None, {})]
        with pytest.raises(GitHubNotFound) as exc:
            client().get(f"{URL}?page=2")
        assert str(exc.value) == f"GitHub 404 for {PATH}"
        assert isinstance(exc.value, GitHubError)

    def test_a_399_is_not_an_error(self, http):
        http.side_effect = [Response(399, ["odd"], {})]
        assert client().get(URL).body == ["odd"]

    @pytest.mark.parametrize("status", [403, 429])
    def test_retry_after_is_a_rate_limit_stop_quoting_the_header(self, http, status):
        http.side_effect = [Response(status, None, {"Retry-After": "60", "X-RateLimit-Remaining": "100"})]
        with pytest.raises(StopRun) as exc:
            client().get(URL)
        assert str(exc.value) == "rate_limited: retry after 60"
        assert exc.value.reason == "rate_limited"

    @pytest.mark.parametrize("status", [403, 429])
    def test_zero_remaining_is_a_rate_limit_stop_quoting_the_reset(self, http, status):
        http.side_effect = [Response(status, None, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000"})]
        with pytest.raises(StopRun) as exc:
            client().get(URL)
        assert str(exc.value) == "rate_limited: retry after 1700000000"

    def test_retry_after_is_preferred_over_the_reset_instant(self, http):
        http.side_effect = [Response(429, None, {"Retry-After": "7", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000"})]
        with pytest.raises(StopRun) as exc:
            client().get(URL)
        assert str(exc.value) == "rate_limited: retry after 7"

    def test_a_403_without_a_rate_limit_signal_is_a_real_failure(self, http):
        http.side_effect = [Response(403, None, {"X-RateLimit-Remaining": "100"})]
        with pytest.raises(GitHubError) as exc:
            client().get(URL)
        assert str(exc.value) == f"GitHub 403 for {PATH}"

    def test_a_500_with_zero_remaining_is_a_failure_not_a_stop(self, http):
        http.side_effect = [Response(500, None, {"X-RateLimit-Remaining": "0", "Retry-After": "60"})]
        with pytest.raises(GitHubError) as exc:
            client().get(URL)
        assert str(exc.value) == f"GitHub 500 for {PATH}"

    @pytest.mark.parametrize("url", [
        "https://evil.example/repos/acme/Kiro/issues",
        "https://api.github.com.evil.example/x",
        "https://github.com/acme/Kiro",
    ])
    def test_a_link_off_the_api_host_is_refused_before_any_request(self, http, url):
        c = client()
        with pytest.raises(GitHubError) as exc:
            c.get(url)
        assert str(exc.value) == "refusing to follow a link off https://api.github.com"
        http.assert_not_called()
        assert c.requests_made == 0


class TestStopRun:
    def test_the_detail_is_appended_after_a_colon(self):
        stop = StopRun("rate_limited", "retry after 60")
        assert str(stop) == "rate_limited: retry after 60"
        assert stop.reason == "rate_limited"
        assert stop.args == ("rate_limited: retry after 60",)

    def test_without_detail_the_message_is_the_reason_alone(self):
        stop = StopRun("time_budget")
        assert str(stop) == "time_budget"
        assert stop.reason == "time_budget"
        assert str(StopRun("item_cap", "")) == "item_cap"


class TestTheQuotaFloor:
    def test_exactly_25_remaining_stops_before_the_next_request(self, http):
        http.side_effect = [ok([], remaining="25"), ok([])]
        c = client()
        c.get(URL)
        with pytest.raises(StopRun) as exc:
            c.get(URL)
        assert str(exc.value) == "rate_limited: quota floor reached"
        assert exc.value.reason == "rate_limited"
        assert http.call_count == 1
        assert c.requests_made == 1

    def test_26_remaining_allows_the_next_request(self, http):
        http.side_effect = [ok([], remaining="26"), ok([])]
        c = client()
        c.get(URL)
        c.get(URL)
        assert http.call_count == 2

    @pytest.mark.parametrize("remaining", ["abc", "", None])
    def test_an_absent_or_unparsable_header_does_not_trip_the_floor(self, http, remaining):
        headers = {} if remaining is None else {"X-RateLimit-Remaining": remaining}
        http.side_effect = [Response(200, [], headers), ok([])]
        c = client()
        c.get(URL)
        c.get(URL)
        assert http.call_count == 2

    def test_the_floor_is_remembered_across_a_stop(self, http):
        http.side_effect = [Response(403, None, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1"})]
        c = client()
        with pytest.raises(StopRun, match="retry after 1"):
            c.get(URL)
        with pytest.raises(StopRun, match="quota floor reached"):
            c.get(URL)
        assert http.call_count == 1


class TestTheTimeBudget:
    def test_exactly_20_seconds_left_still_spends_a_request(self, http):
        http.side_effect = [ok([])]
        client(deadline=100.0, clock=lambda: 80.0).get(URL)
        assert http.call_count == 1

    def test_less_than_20_seconds_left_stops_before_the_request(self, http):
        c = client(deadline=100.0, clock=lambda: 80.01)
        with pytest.raises(StopRun) as exc:
            c.get(URL)
        assert str(exc.value) == "time_budget"
        assert exc.value.reason == "time_budget"
        http.assert_not_called()
        assert c.requests_made == 0

    def test_without_a_deadline_the_clock_is_never_consulted(self, http):
        http.side_effect = [ok([])]
        clock = MagicMock(name="clock")
        client(deadline=None, clock=clock).get(URL)
        clock.assert_not_called()
        assert http.call_count == 1


class TestNextLink:
    @pytest.mark.parametrize(("header", "expected"), [
        (None, None),
        ("", None),
        (f'<{PAGE_2}>; rel="next", <{PAGE_3}>; rel="last"', PAGE_2),
        (f'<{PAGE_3}>; rel="last", <{PAGE_2}>; rel="next"', PAGE_2),
        (f'<{PAGE_2}>;rel="next"', PAGE_2),
        (f'  <{PAGE_2}> ;   rel="next"  ', PAGE_2),
        (f'<{PAGE_3}>; rel="last"', None),
        (f'<{PAGE_2}>; rel="prev"', None),
        (f'<{PAGE_2}>; rel=next', None),
        (f'<{PAGE_2}>', None),
        (f'{PAGE_2}; rel="next"', None),
        (f'<{PAGE_2}; rel="next"', None),
        (f'{PAGE_2}>; rel="next"', None),
    ])
    def test_returns_only_a_bracketed_url_tagged_rel_next(self, header, expected):
        assert _next_link(header) == expected


class TestIntHeader:
    @pytest.mark.parametrize(("headers", "expected"), [
        ({"x-ratelimit-remaining": "5"}, 5),
        ({"x-ratelimit-remaining": "0"}, 0),
        ({"x-ratelimit-remaining": "abc"}, None),
        ({"x-ratelimit-remaining": ""}, None),
        ({}, None),
    ])
    def test_parses_an_integer_or_gives_none(self, headers, expected):
        assert _int_header(headers, "x-ratelimit-remaining") == expected


class TestPaginate:
    def test_follows_next_links_in_order_sending_etag_and_params_on_the_first_request_only(self, http):
        http.side_effect = [
            ok([1], Link=f'<{PAGE_2}>; rel="next"'),
            ok([2], Link=f'<{PAGE_3}>; rel="next"'),
            ok([3]),
        ]
        pages = list(client().paginate(URL, params={"state": "all"}, etag='"e"'))
        assert [p.body for p in pages] == [[1], [2], [3]]
        assert [p.next_url for p in pages] == [PAGE_2, PAGE_3, None]
        assert http.call_args_list[0].args[0] == URL
        assert http.call_args_list[0].args[1] == {**EXPECTED_HEADERS, "If-None-Match": '"e"'}
        assert http.call_args_list[0].args[2] == {"state": "all"}
        assert http.call_args_list[1].args[:3] == (PAGE_2, EXPECTED_HEADERS, None)
        assert http.call_args_list[2].args[:3] == (PAGE_3, EXPECTED_HEADERS, None)

    def test_a_304_on_the_first_request_yields_that_one_page_and_ends(self, http):
        http.side_effect = [Response(304, None, {})]
        pages = list(client().paginate(URL, etag='"e"'))
        assert pages == [GitHubPage(etag='"e"', not_modified=True)]
        assert http.call_count == 1

    def test_a_single_page_without_next_is_the_whole_listing(self, http):
        http.side_effect = [ok([1])]
        assert [p.body for p in client().paginate(URL)] == [[1]]
        assert http.call_count == 1

    def test_a_stop_mid_listing_surfaces_after_the_pages_already_yielded(self, http):
        http.side_effect = [ok([1], Link=f'<{PAGE_2}>; rel="next"', remaining="25"), ok([2])]
        pages = client().paginate(URL)
        assert next(pages).body == [1]
        with pytest.raises(StopRun, match="quota floor reached"):
            next(pages)
        assert http.call_count == 1
