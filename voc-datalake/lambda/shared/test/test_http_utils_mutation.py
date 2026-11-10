"""Mutation hardening for `shared/http_utils.py`.

`test_http.py` pins that a 429 / 5xx response and a transient network error are
retried three times and that other responses come straight back, but a mutation
run found five things it cannot see:

* the WAIT SCHEDULE. Every retry test let tenacity sleep for real and asserted
  only the attempt count, so the defaults (`min_wait=2`, `max_wait=30`,
  `multiplier=1`) and the `max_attempts` of a custom decorator could all drift.
  Here `time.sleep` is recorded and the exact sequence of seconds is pinned.
* the LOG LINE emitted before each sleep: level 20 (INFO), tenacity's wording,
  and the `stacklevel=2` the shim adds so the record is attributed to the
  caller, not to `_TenacityLogger.log`.
* what one policy-checked hop hands the session: GET, the caller's headers and
  timeout, library redirects off, a streamed body only when asked for.
* the WORDING of the error raised for a retried status —
  ``"502 Server Error: Bad Gateway"`` — which callers see in their logs once the
  attempts are exhausted.
* the BOUNDARIES of the retried status range: 499 and 428/430 come straight
  back, 500 and 429 are retried.
"""

from unittest.mock import MagicMock, call, patch

import pytest
import requests
from tenacity import Retrying, stop_after_attempt, wait_exponential

from shared.http_utils import (
    RetryableHTTPError,
    _fetch_policy_checked_hop,
    _TenacityLogger,
    create_retry_decorator,
)

URL = 'https://example.com'


def fetch_hop(session: MagicMock, url: str = URL, headers: dict | None = None, timeout: int = 30,
              **kwargs: bool) -> requests.Response:
    """One retried, policy-checked hop (`fetch_public_url` runs one per redirect)."""
    return _fetch_policy_checked_hop(session, url, headers, timeout, **kwargs)


def _schedule(fn: object) -> tuple[Retrying, stop_after_attempt, wait_exponential]:
    """The `Retrying` tenacity hangs on a decorated function, with its stop and wait narrowed."""
    retrying = vars(fn)['retry']
    assert isinstance(retrying, Retrying)
    stop, wait = retrying.stop, retrying.wait
    assert isinstance(stop, stop_after_attempt)
    assert isinstance(wait, wait_exponential)
    return retrying, stop, wait


@pytest.fixture(autouse=True)
def sleep():
    """Record tenacity's waits instead of serving them (tenacity.nap.sleep calls time.sleep)."""
    with patch('time.sleep') as recorded:
        yield recorded


@pytest.fixture
def session():
    """A stand-in session; the URL policy (DNS) is passed so only the retry logic runs."""
    with patch('shared.http_utils._require_policy'):
        yield MagicMock()


def _response(status_code: int, reason: str = 'Reason') -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.reason = reason
    return response


class TestTheDefaultWaitSchedule:
    def test_a_hop_sleeps_two_seconds_between_each_of_three_attempts(self, session, sleep):
        session.request.return_value = _response(503)
        with pytest.raises(RetryableHTTPError):
            fetch_hop(session)
        assert session.request.call_count == 3
        assert sleep.call_args_list == [call(2), call(2)]

    def test_default_decorator_is_three_attempts_two_to_thirty_seconds_multiplier_one(self):
        retrying, stop, wait = _schedule(_fetch_policy_checked_hop)
        assert stop.max_attempt_number == 3
        assert wait.multiplier == 1
        assert wait.min == 2
        assert wait.max == 30
        assert retrying.reraise is True

    def test_create_retry_decorator_defaults_match_the_module_default(self):
        @create_retry_decorator()
        def flaky():
            raise requests.exceptions.Timeout('slow')

        _, stop, wait = _schedule(flaky)
        assert stop.max_attempt_number == 3
        assert wait.multiplier == 1
        assert wait.min == 2
        assert wait.max == 30


class TestACustomScheduleDoublesAndIsClampedToMaxWait:
    def test_eight_attempts_from_one_second_cap_at_thirty(self, sleep):
        @create_retry_decorator(max_attempts=8, min_wait=1, max_wait=30)
        def flaky():
            raise requests.exceptions.ConnectionError('refused')

        with pytest.raises(requests.exceptions.ConnectionError):
            flaky()
        assert sleep.call_args_list == [
            call(1), call(2), call(4), call(8), call(16), call(30), call(30),
        ]

    def test_min_wait_lifts_the_first_waits(self, sleep):
        @create_retry_decorator(max_attempts=4, min_wait=5, max_wait=100)
        def flaky():
            raise requests.exceptions.Timeout('slow')

        with pytest.raises(requests.exceptions.Timeout):
            flaky()
        assert sleep.call_args_list == [call(5), call(5), call(5)]

    def test_only_the_configured_number_of_attempts_is_made(self, sleep):
        attempts = MagicMock(side_effect=requests.exceptions.Timeout('slow'))

        @create_retry_decorator(max_attempts=2, min_wait=0, max_wait=0)
        def flaky():
            attempts()

        with pytest.raises(requests.exceptions.Timeout):
            flaky()
        assert attempts.call_count == 2
        assert sleep.call_args_list == [call(0)]

    def test_a_non_retryable_exception_is_raised_once_without_sleeping(self, sleep):
        attempts = MagicMock(side_effect=ValueError('not transient'))

        @create_retry_decorator(min_wait=0, max_wait=0)
        def flaky():
            attempts()

        with pytest.raises(ValueError, match=r'^not transient$'):
            flaky()
        assert attempts.call_count == 1
        assert sleep.call_args_list == []


class TestTheLogLineBeforeEachSleep:
    def test_logs_at_info_with_tenacitys_wording_and_stacklevel_two(self):
        def flaky_call():
            raise requests.exceptions.Timeout('slow')

        target = MagicMock()
        with patch('shared.http_utils.logger', target):
            flaky = create_retry_decorator(max_attempts=2, min_wait=0, max_wait=0)(flaky_call)

        with pytest.raises(requests.exceptions.Timeout):
            flaky()

        target.log.assert_called_once_with(
            20,
            f'Retrying {__name__}.{flaky_call.__qualname__} in 0 seconds '
            'as it raised Timeout: slow.',
            stacklevel=2,
        )

    def test_shim_forwards_level_message_args_and_kwargs_adding_stacklevel_two(self):
        target = MagicMock()
        _TenacityLogger(target).log(30, 'warn %s', 'x', exc_info=False)
        target.log.assert_called_once_with(30, 'warn %s', 'x', exc_info=False, stacklevel=2)

    def test_shim_keeps_a_caller_supplied_stacklevel(self):
        target = MagicMock()
        _TenacityLogger(target).log(20, 'msg', stacklevel=5)
        target.log.assert_called_once_with(20, 'msg', stacklevel=5)


class TestWhatAHopSends:
    def test_one_get_with_the_callers_headers_and_timeout_and_no_library_redirects(self, session):
        session.request.return_value = _response(200)
        fetch_hop(session, f'{URL}/items', {'Accept': 'text/html'}, 5)
        session.request.assert_called_once_with(
            method='GET', url=f'{URL}/items', headers={'Accept': 'text/html'}, timeout=5, allow_redirects=False,
        )

    def test_a_streamed_hop_asks_the_session_for_a_streamed_body(self, session):
        session.request.return_value = _response(201)
        result = fetch_hop(session, stream=True)
        assert result.status_code == 201
        assert session.request.call_args.kwargs['stream'] is True


class TestWhichStatusesAreRetried:
    @pytest.mark.parametrize('status_code', [200, 204, 301, 400, 403, 404, 428, 430, 499])
    def test_returns_the_response_after_one_request(self, session, sleep, status_code):
        session.request.return_value = _response(status_code)
        result = fetch_hop(session)
        assert result.status_code == status_code
        assert session.request.call_count == 1
        assert sleep.call_args_list == []

    @pytest.mark.parametrize(('status_code', 'reason', 'message'), [
        (429, 'Too Many Requests', '429 Server Error: Too Many Requests'),
        (500, 'Internal Server Error', '500 Server Error: Internal Server Error'),
        (502, 'Bad Gateway', '502 Server Error: Bad Gateway'),
        (599, 'Unknown', '599 Server Error: Unknown'),
    ])
    def test_raises_the_exact_message_with_the_response_after_three_attempts(
        self, session, status_code, reason, message,
    ):
        response = _response(status_code, reason)
        session.request.return_value = response
        with pytest.raises(RetryableHTTPError) as exc:
            fetch_hop(session)
        assert str(exc.value) == message
        assert exc.value.response is response
        assert isinstance(exc.value, requests.exceptions.HTTPError)
        assert session.request.call_count == 3

    @pytest.mark.parametrize('error', [
        requests.exceptions.Timeout('timed out'),
        requests.exceptions.ConnectionError('refused'),
    ])
    def test_transient_network_errors_are_retried_three_times(self, session, sleep, error):
        session.request.side_effect = error
        with pytest.raises(type(error)):
            fetch_hop(session)
        assert session.request.call_count == 3
        assert sleep.call_args_list == [call(2), call(2)]

    def test_a_success_after_one_failure_is_returned_after_two_requests(self, session, sleep):
        ok = _response(200)
        session.request.side_effect = [requests.exceptions.ConnectionError('blip'), ok]
        result = fetch_hop(session)
        assert result is ok
        assert session.request.call_count == 2
        assert sleep.call_args_list == [call(2)]
