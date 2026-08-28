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
- Drop the IPv6 site-local check (`fec0::/10` satisfies none of the other seven
  predicates) -> `refuses_internal_ip_literals_in_both_families['http://[fec0::1]/']`.
- Narrow the resolver handler back to `except OSError` -> the IDNA
  `UnicodeEncodeError` escapes -> `refuses_hostnames_the_idna_codec_rejects`.
- Stop dropping `Authorization`/`Cookie` on a cross-origin hop
  -> `drops_credential_headers_when_a_redirect_leaves_the_origin`.
- Stop downgrading the method to GET where requests would
  -> `downgrades_the_method_to_get_exactly_where_requests_would`.
- Ignore `total_timeout` -> `stops_following_a_chain_that_outruns_its_budget`.
- Bound the budget per HOP only, letting one hop's 3 retries outrun it
  -> `keeps_one_hops_retries_inside_the_budget`.
- Test `total_timeout` for truthiness, so 0 means "no budget"
  -> `refuses_a_budget_that_has_already_expired`.
- Compare origins on the raw parsed port, so `https://h/` and `https://h:443/`
  differ and credentials are dropped within one origin
  -> `keeps_credential_headers_when_only_the_port_spelling_changes`.
- Rebuild the caller's headers as a plain dict, losing case-insensitivity for the
  rest of the chain -> `preserves_a_case_insensitive_header_mapping_across_hops`.
- Resolve a host that `skip_resolution` cleared earlier in the same write, or skip
  the local checks along with it
  -> `test_scraper_urls.py::still_applies_the_local_checks_to_a_cleared_hosts_other_urls`.

Every "refuses" concern has a positive control (`TestPermittedDestinations`,
`allows_a_public_redirect_chain_and_returns_the_final_page`) so an
always-blocking implementation cannot make this file vacuously green.

No test here touches the network: `socket.getaddrinfo` and `requests.request`
are patched at their import boundary in `shared.http_utils`.
"""

import ipaddress
from unittest.mock import MagicMock, patch

import pytest
import requests
from requests.structures import CaseInsensitiveDict

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
    """A response double whose `.headers` behaves like the real thing.

    `CaseInsensitiveDict`, not a plain dict: a real server may send `location:`
    lowercase, and a plain-dict double would pass against code that reads
    `headers.get('Location')` from a case-SENSITIVE mapping — so the test would
    be greener than production.
    """
    response = MagicMock()
    response.status_code = status
    response.reason = 'reason'
    response.headers = CaseInsensitiveDict({'Location': location} if location else {})
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
        # IPv6 site-local. Deprecated by RFC 3879, and the ONE internal family
        # that satisfies every other predicate: is_global True, is_private False,
        # is_reserved False, is_link_local False. Only `is_site_local` catches it.
        'http://[fec0::1]/',
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

    @pytest.mark.parametrize('hostname', [
        'a' * 64 + '.example.com',   # label longer than 63 bytes
        'a..b.com',                  # empty label
    ])
    def test_refuses_hostnames_the_idna_codec_rejects(self, hostname):
        """
        `getaddrinfo` raises UnicodeEncodeError — a ValueError, NOT an OSError —
        from the IDNA codec, BEFORE it resolves anything. So the resolver is
        deliberately NOT mocked here: the codec is what raises. Catching only
        OSError let this escape the policy unwrapped, which turned the write route
        into an unhandled invocation error instead of the 400 it is built to
        return.
        """
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked, match='resolve'):
            assert_outbound_url_allowed(f'http://{hostname}/x')


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


class TestSkipResolution:
    """
    `skip_resolution=True` drops ONLY the lookup, for a host the caller resolved
    earlier in the same unit of work (`validate_scraper_destinations` memoizing
    one write's hostnames). It is not an allow-list: the local checks are what
    still catch a refused scheme or embedded credentials on that host's other
    URLs, and nothing may pass it before a request actually goes out.
    """

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_does_not_call_the_resolver(self, mock_resolve):
        from shared.http_utils import assert_outbound_url_allowed

        assert_outbound_url_allowed(
            'https://example.com/second-page', skip_resolution=True
        )

        mock_resolve.assert_not_called()

    @pytest.mark.parametrize('url', [
        'gopher://example.com/x',                    # scheme
        'https://user:pw@example.com/x',             # embedded credentials
        'http://localhost/x',                        # blocked name
        'https:///x',                                # no hostname
        'http://127.0.0.1/x',                        # a literal needs no resolver
        'http://[::1]/x',
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    def test_still_applies_every_local_check(self, mock_resolve, url):
        """
        Each of these is decided WITHOUT the resolver, so skipping the lookup must
        not skip them. An IP literal is included because it is parsed locally —
        `skip_resolution` must not turn `http://127.0.0.1/` into a permitted
        target.
        """
        from shared.http_utils import OutboundUrlBlocked, assert_outbound_url_allowed

        with pytest.raises(OutboundUrlBlocked):
            assert_outbound_url_allowed(url, skip_resolution=True)

        mock_resolve.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    def test_defaults_to_resolving(self, mock_resolve):
        """
        Positive control on the default: the resolution IS the policy, so it must
        happen unless a caller explicitly opts out.
        """
        from shared.http_utils import assert_outbound_url_allowed

        mock_resolve.return_value = _addrinfo('93.184.216.34')

        assert_outbound_url_allowed('https://example.com/x')

        mock_resolve.assert_called_once()


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

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_follows_a_lowercase_location_header(self, mock_request, mock_resolve):
        """HTTP header names are case-insensitive and real servers vary."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        first = _response(302)
        first.headers = CaseInsensitiveDict({'location': 'https://example.com/final'})
        mock_request.side_effect = [first, _response(200, text='final')]

        response = fetch_checked_with_retry('https://example.com/')

        assert response.text == 'final'
        assert mock_request.call_args_list[1].kwargs['url'] == 'https://example.com/final'


class TestCheckedFetchMatchesRequestsRedirectSemantics:
    """
    Owning the redirect walk means owning the rest of what `requests` would do.

    Neither behaviour below is exercised by the two current call sites (both GET,
    both unauthenticated). They are asserted because this is now the recommended
    fetch for ANY config-supplied URL, so the next caller inherits whatever this
    loop does — and a hand-rolled walk that silently drops `rebuild_auth` and
    `rebuild_method` is a trap, not a simplification.
    """

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_drops_credential_headers_when_a_redirect_leaves_the_origin(
        self, mock_request, mock_resolve
    ):
        """
        `requests.SessionRedirectMixin.rebuild_auth` drops Authorization across
        hosts. The policy guarantees the next hop is PUBLIC, which is what makes
        this matter: without it a credential meant for one site is handed to
        whatever third party that site's Location names.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(302, location='https://other.example/page'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry(
            'https://example.com/',
            headers={
                'Authorization': 'Bearer secret',
                'Cookie': 'session=secret',
                'User-Agent': 'voc-scraper',
            },
        )

        second = mock_request.call_args_list[1].kwargs['headers']
        assert 'Authorization' not in second
        assert 'Cookie' not in second
        # Positive control: the harmless header survives, so "drop everything"
        # cannot pass this test.
        assert second['User-Agent'] == 'voc-scraper'

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_keeps_credential_headers_on_a_same_origin_redirect(
        self, mock_request, mock_resolve
    ):
        """Positive control: a /page/1 redirect within the same site is not a leak."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(302, location='/reviews/page/2'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry(
            'https://example.com/reviews',
            headers={'Authorization': 'Bearer secret'},
        )

        assert (
            mock_request.call_args_list[1].kwargs['headers']['Authorization']
            == 'Bearer secret'
        )

    @pytest.mark.parametrize(('start', 'location'), [
        ('https://example.com/', 'https://example.com:443/final'),
        ('https://example.com:443/', 'https://example.com/final'),
        ('http://example.com/', 'http://example.com:80/final'),
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_keeps_credential_headers_when_only_the_port_spelling_changes(
        self, mock_request, mock_resolve, start, location
    ):
        """
        An implicit port and its explicit default are the SAME origin.
        `parsed.port` is None in the first spelling and 443 in the second, so
        comparing them raw made a redirect between two spellings of one origin
        drop the caller's Authorization — an unexplained 401 to debug, where
        `rebuild_auth` (hostname only) would have kept it.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(302, location=location),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry(start, headers={'Authorization': 'Bearer secret'})

        assert (
            mock_request.call_args_list[1].kwargs['headers']['Authorization']
            == 'Bearer secret'
        )

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_preserves_a_case_insensitive_header_mapping_across_hops(
        self, mock_request, mock_resolve
    ):
        """
        Rebuilding the caller's `CaseInsensitiveDict` as a plain dict kept the
        DROP correct but silently made their own lowercase lookups miss for the
        rest of the chain, and let a later `Content-Type` sit beside an existing
        `content-type`. `requests` passes this type around internally.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(302, location='https://other.example/page'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry(
            'https://example.com/',
            headers=CaseInsensitiveDict({
                'Authorization': 'Bearer secret',
                'User-Agent': 'voc-scraper',
            }),
        )

        second = mock_request.call_args_list[1].kwargs['headers']
        assert 'Authorization' not in second
        # The type survived, so the caller's own case-insensitive lookups still
        # resolve on the hop after a strip.
        assert isinstance(second, CaseInsensitiveDict)
        assert second['user-agent'] == 'voc-scraper'

    @pytest.mark.parametrize('budget', [0, -1])
    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_refuses_a_budget_that_has_already_expired(
        self, mock_request, mock_resolve, budget
    ):
        """
        `total_timeout=0` means "already expired", not "no budget". Under a
        truthiness test it meant the latter, so the caller most likely to pass it
        — one computing `deadline - time.monotonic()` after its own budget ran
        out — got an UNBOUNDED chain. A negative value already behaved, which is
        what made 0 an inconsistency rather than a policy.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [_response(200, text='ok')]

        with pytest.raises(requests.exceptions.Timeout):
            fetch_checked_with_retry('https://example.com/', total_timeout=budget)

        # Nothing went out: an expired budget is decided before the request.
        mock_request.assert_not_called()

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_fetches_without_a_budget_when_none_is_given(
        self, mock_request, mock_resolve
    ):
        """
        Positive control for the two cases above: `total_timeout=None` is the
        default and the ingestor's path, so "expired" must not be the reading of
        an ABSENT budget.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [_response(200, text='ok')]

        assert fetch_checked_with_retry('https://example.com/').status_code == 200

    @patch('tenacity.nap.time.sleep')
    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_keeps_one_hops_retries_inside_the_budget(
        self, mock_request, mock_resolve, mock_sleep
    ):
        """
        The budget bounds retried ATTEMPTS, not just hops.

        `fetch_with_retry` is retry-decorated, and the budget used to be re-read
        only between hops — so with the preview route's real constants (hop 10 s,
        total 20 s) a stalling host cost 3 attempts x 10 s plus backoff ~= 34 s on
        the FIRST hop. That is past API Gateway's 29 s limit, so the invocation was
        cut off and the caller got the 504 this budget exists to prevent, instead
        of the Timeout below.

        A stalling host is simulated on a FAKE clock — the double consumes its
        whole timeout, and the retry backoff advances the same clock — so the test
        measures the real budget arithmetic without spending 20 s to do it.
        """
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        now = [1000.0]
        timeouts = []

        def stall(**kwargs):
            timeouts.append(kwargs['timeout'])
            now[0] += kwargs['timeout']   # the host holds the connection open
            raise requests.exceptions.Timeout('stalled')

        mock_request.side_effect = stall
        mock_sleep.side_effect = lambda seconds: now.__setitem__(0, now[0] + seconds)

        with patch('shared.http_utils.time.monotonic', lambda: now[0]), \
                pytest.raises(requests.exceptions.Timeout):
            fetch_checked_with_retry(
                'https://slow.example.com/', timeout=10, total_timeout=20
            )

        # Every attempt is bounded by what is LEFT of the budget, so the time
        # actually spent stalling cannot exceed it. `[10, 10, 10]` was the bug.
        assert sum(timeouts) <= 20
        assert timeouts[0] == 10
        assert timeouts[-1] < 10, 'a later attempt must shrink to fit the budget'

    @pytest.mark.parametrize(('method', 'status', 'expected'), [
        ('POST', 303, 'GET'),   # 303 always means "go read this instead"
        ('POST', 302, 'GET'),   # what every browser and requests do
        ('POST', 301, 'GET'),
        ('POST', 307, 'POST'),  # 307/308 exist precisely to preserve the method
        ('POST', 308, 'POST'),
        ('GET', 302, 'GET'),
        ('HEAD', 303, 'HEAD'),  # rebuild_method exempts HEAD
    ])
    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_downgrades_the_method_to_get_exactly_where_requests_would(
        self, mock_request, mock_resolve, method, status, expected
    ):
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(status, location='https://example.com/next'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry('https://example.com/', method=method, json={'a': 1})

        assert mock_request.call_args_list[1].kwargs['method'] == expected

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_drops_the_body_with_the_method_it_belonged_to(
        self, mock_request, mock_resolve
    ):
        """A GET carrying the original POST body describes something not being sent."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(303, location='https://example.com/result'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry(
            'https://example.com/submit',
            method='POST',
            headers={'Content-Type': 'application/json'},
            json={'a': 1},
        )

        second = mock_request.call_args_list[1].kwargs
        assert 'json' not in second
        assert 'Content-Type' not in second['headers']
        # Positive control: the FIRST hop did carry the body.
        assert mock_request.call_args_list[0].kwargs['json'] == {'a': 1}

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_keeps_the_body_on_a_307_that_preserves_the_method(
        self, mock_request, mock_resolve
    ):
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.side_effect = [
            _response(307, location='https://example.com/result'),
            _response(200, text='ok'),
        ]

        fetch_checked_with_retry('https://example.com/submit', method='POST', json={'a': 1})

        assert mock_request.call_args_list[1].kwargs['json'] == {'a': 1}


class TestCheckedFetchTimeBudget:
    """
    `total_timeout` bounds the CHAIN, which a per-request timeout cannot.

    Without it, six hops at `timeout=30` plus tenacity retries overruns API
    Gateway's 29 s integration limit, and the preview route answers 504 with no
    message instead of the 4xx/5xx it means to return.
    """

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_shortens_a_hop_timeout_to_what_is_left_of_the_budget(
        self, mock_request, mock_resolve
    ):
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.return_value = _response(200, text='ok')

        fetch_checked_with_retry('https://example.com/', timeout=30, total_timeout=5)

        assert mock_request.call_args.kwargs['timeout'] <= 5

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_stops_following_a_chain_that_outruns_its_budget(
        self, mock_request, mock_resolve
    ):
        """
        A Timeout, not an OutboundUrlBlocked: the destination was permitted, the
        clock ran out. Callers that already treat a RequestException as "this page
        did not load" keep behaving that way.
        """
        import requests

        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')

        # A clock the REQUESTS move, not the readings: every hop costs 99s, so the
        # first goes out inside the budget and the second cannot. Driven from the
        # request rather than from an iterator of readings because
        # `time.monotonic` is the module global and tenacity reads it too — a
        # finite list of readings raises StopIteration inside the retry machinery
        # instead of testing anything.
        now = [0.0]

        def slow_hop(*_args, **_kwargs):
            now[0] += 99.0
            return _response(302, location='https://example.com/next')

        mock_request.side_effect = slow_hop

        with (
            patch('shared.http_utils.time.monotonic', lambda: now[0]),
            pytest.raises(requests.exceptions.Timeout),
        ):
            fetch_checked_with_retry('https://example.com/', total_timeout=10)

        # The budget stopped it well before the hop bound did.
        assert mock_request.call_count == 1

    @patch('shared.http_utils.socket.getaddrinfo')
    @patch('shared.http_utils.requests.request')
    def test_leaves_the_hop_timeout_alone_when_no_budget_is_given(
        self, mock_request, mock_resolve
    ):
        """Positive control: the ingestor passes no budget and must be unaffected."""
        from shared.http_utils import fetch_checked_with_retry

        mock_resolve.return_value = _addrinfo('93.184.216.34')
        mock_request.return_value = _response(200, text='ok')

        fetch_checked_with_retry('https://example.com/', timeout=15)

        assert mock_request.call_args.kwargs['timeout'] == 15


class TestExceptionHierarchy:

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
