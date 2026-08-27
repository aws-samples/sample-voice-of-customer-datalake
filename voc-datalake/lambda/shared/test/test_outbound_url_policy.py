"""
Tests for the shared outbound-URL policy in shared/http_utils.py (issue #244).

The webscraper runs on a schedule inside the account with an execution role, so
a saved internal URL is a repeated internal request. Before this policy existed,
the only check was a string-and-denylist `validate_url` in
`lambda/api/scrapers_handler.py`, called on the analyze/preview route alone.

REVERT MAP — which mutation each test catches
---------------------------------------------
- Drop `not ip.is_multicast` (or reduce the predicate set to bare `is_global`)
  -> `refuses_multicast_and_unspecified_targets`.
- Stop unwrapping IPv4 inside IPv6 (`_embedded_ipv4`)
  -> `refuses_ipv4_tunnelled_inside_ipv6`.
- Clear a host as soon as ONE answer is global (any() instead of all())
  -> `refuses_a_host_whose_answers_mix_public_and_private`.
- Treat a resolver failure as "allow" -> `refuses_a_host_that_will_not_resolve`.
- Re-enable `allow_redirects` on the fetch, or check only the first URL
  -> `refuses_a_redirect_from_a_public_page_into_an_internal_one`.
- Remove the hop bound -> `refuses_a_redirect_chain_longer_than_the_bound`.
- Accept a scheme outside http/https -> `refuses_schemes_the_scraper_cannot_use`.

Every "refuses" concern has a positive control (`TestPermittedDestinations`,
`allows_a_public_redirect_chain_and_returns_the_final_page`) so an
always-blocking implementation cannot make this file vacuously green.

No test here touches the network: `socket.getaddrinfo` and `requests.request`
are patched at their import boundary in `shared.http_utils`.
"""

import ipaddress
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _addrinfo(*addresses: str) -> list:
    """A getaddrinfo() return value carrying exactly `addresses`.

    Builds the 5-tuple shape the resolver really returns (family, type, proto,
    canonname, sockaddr) so the code under test indexes it the same way it will
    in Lambda; only sockaddr[0] is read.
    """
    out = []
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if ip.version == 6:
            out.append((10, 1, 6, '', (address, 0, 0, 0)))
        else:
            out.append((2, 1, 6, '', (address, 0)))
    return out


def _response(status: int, *, location: str | None = None, text: str = '') -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.reason = 'reason'
    response.headers = {'Location': location} if location else {}
    response.text = text
    return response


# ---------------------------------------------------------------------------
# The policy itself
# ---------------------------------------------------------------------------

class TestRefusedDestinations:
    """Destinations `assert_outbound_url_allowed` must not clear."""

    @pytest.mark.parametrize('url', [
        'ftp://example.com/x',
        'file:///etc/passwd',
        'gopher://example.com/',
        'data:text/html,hi',
        '//example.com/no-scheme',
    ])
    def test_refuses_schemes_the_scraper_cannot_use(self, url):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='http'):
            assert_outbound_url_allowed(url)

    @pytest.mark.parametrize('url', ['', None, 'not a url at all'])
    def test_refuses_empty_and_unparseable_input(self, url):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked):
            assert_outbound_url_allowed(url)

    def test_refuses_a_url_with_no_hostname(self):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='hostname'):
            assert_outbound_url_allowed('http:///just-a-path')

    def test_refuses_credentials_embedded_in_the_url(self):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='credentials'):
            assert_outbound_url_allowed('https://user:pw@example.com/')

    @pytest.mark.parametrize('hostname', [
        'localhost', 'LOCALHOST', 'localhost.', 'localhost.localdomain',
        'ip6-localhost', 'ip6-loopback',
    ])
    def test_refuses_localhost_by_name_without_asking_the_resolver(self, hostname):
        """A resolver that answers oddly must not get a vote on localhost."""
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with (
            patch('shared.http_utils.socket.getaddrinfo') as mock_resolve,
            pytest.raises(OutboundUrlBlocked, match='localhost'),
        ):
            assert_outbound_url_allowed(f'http://{hostname}/admin')
        mock_resolve.assert_not_called()

    @pytest.mark.parametrize('url', [
        'http://127.0.0.1/admin',            # loopback, IPv4 literal
        'http://10.0.0.5/',                  # private class A
        'http://172.16.9.9/',                # private class B
        'http://192.168.1.1/',               # private class C
        'http://169.254.169.254/latest/meta-data/',  # instance metadata
        'http://[::1]/admin',                # loopback, IPv6 literal
        'http://[fc00::1]/',                 # IPv6 unique-local
        'http://[fe80::1]/',                 # IPv6 link-local
        'http://0.0.0.0/',                   # unspecified
        'http://[::]/',                      # unspecified, IPv6
        'http://240.0.0.1/',                 # reserved
        'http://100.64.0.1/',                # carrier-grade NAT, not global
    ])
    def test_refuses_internal_ip_literals_in_both_families(self, url):
        """A literal address is decided locally — never handed to the resolver."""
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with (
            patch('shared.http_utils.socket.getaddrinfo') as mock_resolve,
            pytest.raises(OutboundUrlBlocked, match='internal/private'),
        ):
            assert_outbound_url_allowed(url)
        mock_resolve.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_shorthand_ipv4_the_resolver_expands_to_loopback(self, mock_resolve):
        """
        `127.1` is not parseable as a literal, so it falls through to the
        resolver — which is exactly where it gets caught. The resolver mock
        reproduces what libc really answers for this form.
        """
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('127.0.0.1')

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            assert_outbound_url_allowed('http://127.1/admin')

    @pytest.mark.parametrize('url', ['http://224.0.0.1/', 'http://[ff02::1]/'])
    def test_refuses_multicast_and_unspecified_targets(self, url):
        """`is_global` alone is True for IPv4 multicast, so it cannot be the whole test."""
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            assert_outbound_url_allowed(url)

    @pytest.mark.parametrize('url', [
        'http://[::ffff:127.0.0.1]/',   # v4-mapped loopback
        'http://[::ffff:10.0.0.1]/',    # v4-mapped private
        'http://[2002:0a00:0001::]/',   # 6to4 wrapping 10.0.0.1
    ])
    def test_refuses_ipv4_tunnelled_inside_ipv6(self, url):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            assert_outbound_url_allowed(url)

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_public_looking_host_that_resolves_internally(self, mock_resolve):
        """The gap the string denylist could never close (issue #244)."""
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('169.254.169.254')

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            assert_outbound_url_allowed('https://totally-legit-reviews.example/')

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_host_whose_answers_mix_public_and_private(self, mock_resolve):
        """The client picks the address from the answer set, so one bad answer is fatal."""
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('93.184.216.34', '10.1.2.3')

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            assert_outbound_url_allowed('https://mixed.example/')

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_host_that_will_not_resolve(self, mock_resolve):
        """Not knowing where a request lands fails closed, not open."""
        import socket

        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        mock_resolve.side_effect = socket.gaierror('nodename nor servname provided')

        with pytest.raises(OutboundUrlBlocked, match='resolve'):
            assert_outbound_url_allowed('https://nope.example/')

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_refuses_a_host_the_resolver_answers_with_nothing(self, mock_resolve):
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        mock_resolve.return_value = []

        with pytest.raises(OutboundUrlBlocked, match='resolve'):
            assert_outbound_url_allowed('https://empty.example/')


class TestPermittedDestinations:
    """Positive controls — ordinary public scraping must keep working."""

    @pytest.mark.parametrize('url', [
        'https://example.com/reviews',
        'http://example.com/reviews?page=2',
        'https://example.com:8443/reviews',
        'https://93.184.216.34/reviews',
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_allows_public_http_and_https_destinations(self, mock_resolve, url):
        from shared.http_utils import assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('93.184.216.34')

        assert_outbound_url_allowed(url)  # must not raise

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_allows_a_host_resolving_only_to_public_ipv6(self, mock_resolve):
        from shared.http_utils import assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('2606:2800:220:1:248:1893:25c8:1946')

        assert_outbound_url_allowed('https://example.com/reviews')

    def test_allows_a_public_ipv6_literal(self):
        from shared.http_utils import assert_outbound_url_allowed

        assert_outbound_url_allowed('https://[2606:2800:220:1:248:1893:25c8:1946]/x')


# ---------------------------------------------------------------------------
# Redirect handling
# ---------------------------------------------------------------------------

class TestCheckedFetchRedirects:
    """`fetch_checked_with_retry` owns redirect following so every hop is checked."""

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_never_lets_the_http_client_follow_a_redirect(self, mock_request, mock_resolve):
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.return_value = _response(200, text='ok')

        fetch_checked_with_retry('https://example.com/', allow_redirects=True)

        assert mock_request.call_args.kwargs['allow_redirects'] is False

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_refuses_a_redirect_from_a_public_page_into_an_internal_one(
        self, mock_request, mock_resolve
    ):
        """The bypass in issue #244: validate the string, then follow a 302 anywhere."""
        from shared.http_utils import OutboundUrlBlocked, fetch_checked_with_retry

        def resolve(hostname, *_args, **_kwargs):
            return _addrinfo(
                '93.184.216.34' if hostname == 'example.com' else '169.254.169.254'
            )

        mock_resolve.side_effect = resolve
        mock_request.return_value = _response(
            302, location='http://metadata.internal/latest/meta-data/'
        )

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            fetch_checked_with_retry('https://example.com/reviews')

        # The internal hop was never requested — refused before the second send.
        assert mock_request.call_count == 1

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_refuses_a_relative_redirect_resolving_to_an_internal_host(
        self, mock_request, mock_resolve
    ):
        """A scheme-relative Location must be joined against the CURRENT url first."""
        from shared.http_utils import OutboundUrlBlocked, fetch_checked_with_retry

        def resolve(hostname, *_args, **_kwargs):
            return _addrinfo(
                '93.184.216.34' if hostname == 'example.com' else '10.0.0.7'
            )

        mock_resolve.side_effect = resolve
        mock_request.return_value = _response(301, location='//internal.example/secrets')

        with pytest.raises(OutboundUrlBlocked, match='internal/private'):
            fetch_checked_with_retry('https://example.com/reviews')

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_allows_a_public_redirect_chain_and_returns_the_final_page(
        self, mock_request, mock_resolve
    ):
        """Positive control: ordinary http->https and /path redirects still resolve."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(301, location='https://example.com/reviews'),
            _response(302, location='/reviews/page/1'),
            _response(200, text='<html>reviews</html>'),
        ]

        response = fetch_checked_with_retry('http://example.com/reviews')

        assert response.status_code == 200
        assert response.text == '<html>reviews</html>'
        assert [c.kwargs['url'] for c in mock_request.call_args_list] == [
            'http://example.com/reviews',
            'https://example.com/reviews',
            'https://example.com/reviews/page/1',
        ]

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_refuses_a_redirect_chain_longer_than_the_bound(self, mock_request, mock_resolve):
        from shared.http_utils import (
            MAX_REDIRECT_HOPS,
            OutboundUrlBlocked,
            fetch_checked_with_retry,
        )

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.return_value = _response(302, location='https://example.com/loop')

        with pytest.raises(OutboundUrlBlocked, match='[Tt]oo many redirects'):
            fetch_checked_with_retry('https://example.com/start')

        assert mock_request.call_count == MAX_REDIRECT_HOPS + 1

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_sends_caller_params_only_on_the_first_hop(self, mock_request, mock_resolve):
        """A Location carries its own query; re-appending params would corrupt it."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(302, location='https://example.com/reviews?page=9'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry('https://example.com/', params={'page': 2})

        assert mock_request.call_args_list[0].kwargs['params'] == {'page': 2}
        assert mock_request.call_args_list[1].kwargs['params'] is None

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_keeps_the_existing_retry_contract_on_a_hop(self, mock_request, mock_resolve):
        """A 5xx still retries with backoff; a 403 still comes back as a response."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(503),
            _response(403, text='denied'),
        ]

        response = fetch_checked_with_retry('https://example.com/')

        assert response.status_code == 403
        assert mock_request.call_count == 2

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_refuses_the_initial_url_before_any_request_goes_out(
        self, mock_request, mock_resolve
    ):
        from shared.http_utils import OutboundUrlBlocked, fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('10.0.0.9')

        with pytest.raises(OutboundUrlBlocked):
            fetch_checked_with_retry('https://internal.example/')

        mock_request.assert_not_called()

    def test_blocked_is_not_a_requests_exception(self):
        """
        Callers that swallow `requests.RequestException` as "page didn't load"
        must NOT swallow a blocked destination — the webscraper ingestor's
        `_scrape_page` does exactly that, and a security refusal has to escape
        it to reach the run's error list.
        """
        import requests

        from shared.http_utils import OutboundUrlBlocked

        assert not issubclass(OutboundUrlBlocked, requests.exceptions.RequestException)
