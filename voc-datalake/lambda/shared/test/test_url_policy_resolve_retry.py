"""A transient resolver failure is retried before a URL is refused (5.48.00 live: a Lambda cold start's
``[Errno 16] Device or resource busy`` from ``getaddrinfo`` refused a public design-reference URL as
"URL validation failed"). A name that does not exist is never retried, and the policy still judges every
answer of the lookup that succeeds.
"""
import socket
from unittest.mock import patch

import pytest

from shared import url_policy
from shared.url_policy import PRIVATE_ADDRESS_ERROR, validate_url

PUBLIC_ANSWER = [(2, 1, 6, '', ('93.184.216.34', 0))]
PRIVATE_ANSWER = [(2, 1, 6, '', ('10.0.0.1', 0))]
BUSY = OSError(16, 'Device or resource busy')
TRY_AGAIN = socket.gaierror(socket.EAI_AGAIN, 'Temporary failure in name resolution')


@pytest.fixture(autouse=True)
def no_waits():
    with patch.object(url_policy.time, 'sleep') as sleep:
        yield sleep


@pytest.mark.parametrize('failure', [BUSY, TRY_AGAIN], ids=['busy', 'eai_again'])
def test_a_transient_failure_then_an_answer_is_a_valid_url(failure, no_waits):
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=[failure, PUBLIC_ANSWER]) as resolve:
        assert validate_url('https://brand.example/') == (True, '')
    assert resolve.call_count == 2
    assert [c.args[0] for c in no_waits.call_args_list] == list(url_policy.RESOLVE_RETRY_WAITS_SECONDS[:1])


def test_the_retried_answer_is_still_judged():
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=[BUSY, PRIVATE_ANSWER]):
        assert validate_url('https://brand.example/') == (False, PRIVATE_ADDRESS_ERROR)


def test_three_transient_failures_refuse_the_url(no_waits):
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=[BUSY, BUSY, BUSY]) as resolve:
        assert validate_url('https://brand.example/') == (False, 'URL validation failed')
    assert resolve.call_count == 3
    assert [c.args[0] for c in no_waits.call_args_list] == list(url_policy.RESOLVE_RETRY_WAITS_SECONDS)


def test_a_name_that_does_not_exist_is_not_retried(no_waits):
    missing = socket.gaierror(socket.EAI_NONAME, 'Name or service not known')
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=missing) as resolve:
        assert validate_url('https://nx.example/') == (False, 'Could not resolve hostname')
    assert resolve.call_count == 1
    no_waits.assert_not_called()


def test_the_connect_time_pin_retries_too():
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=[TRY_AGAIN, PUBLIC_ANSWER]):
        assert [str(ip) for ip in url_policy.public_addresses('brand.example', 443)] == ['93.184.216.34']
