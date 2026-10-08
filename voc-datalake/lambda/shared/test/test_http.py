"""
Tests for shared/http_utils.py - HTTP utilities with retry logic.

The retry schedule, the retried status range, the error wording and the request
defaults are pinned in test_http_utils_mutation.py; this file keeps the two pins
that file does not repeat, plus the policy-checked `fetch_public_url` (#244).
"""

from unittest.mock import MagicMock, patch

import pytest
import requests


class TestRetryableHTTPError:
    """Tests for RetryableHTTPError exception class."""

    def test_is_subclass_of_http_error(self):
        """RetryableHTTPError inherits from HTTPError."""
        from shared.http_utils import RetryableHTTPError

        assert issubclass(RetryableHTTPError, requests.exceptions.HTTPError)


class TestFetchWithRetry:
    """Tests for fetch_with_retry function."""

    @patch("shared.http_utils.requests.request")
    def test_passes_headers_and_params(self, mock_request):
        """Passes headers, params, and timeout to requests."""
        from shared.http_utils import fetch_with_retry

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_request.return_value = mock_response

        fetch_with_retry(
            "https://example.com",
            headers={"Authorization": "Bearer token"},
            params={"q": "test"},
            timeout=15,
        )

        mock_request.assert_called_once_with(
            method="GET",
            url="https://example.com",
            headers={"Authorization": "Bearer token"},
            params={"q": "test"},
            timeout=15,
        )


class TestFetchPublicUrl:
    """fetch_public_url: the URL policy on every hop, redirects followed manually (#244)."""

    PUBLIC = '93.184.216.34'

    @staticmethod
    def _response(status, location=None):
        response = MagicMock()
        response.status_code = status
        response.headers = {'Location': location} if location else {}
        return response

    def _public_dns(self):
        return patch('shared.url_policy.socket.getaddrinfo',
                     return_value=[(2, 1, 6, '', (self.PUBLIC, 0))])

    @patch("shared.http_utils.requests.Session.request")
    def test_public_url_happy_path_disables_library_redirects(self, mock_request):
        from shared.http_utils import fetch_public_url

        ok = self._response(200)
        mock_request.return_value = ok
        with self._public_dns():
            assert fetch_public_url('https://example.com/reviews', timeout=15) is ok
        assert mock_request.call_args.kwargs['allow_redirects'] is False
        assert mock_request.call_args.kwargs['url'] == 'https://example.com/reviews'

    @patch("shared.http_utils.requests.Session.request")
    def test_a_refused_url_is_never_requested(self, mock_request):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        with pytest.raises(UnsafeURLError, match=r'169\.254\.169\.254'):
            fetch_public_url('http://169.254.169.254/latest/meta-data/')
        mock_request.assert_not_called()

    @patch("shared.http_utils.requests.Session.request")
    def test_a_hostname_resolving_to_10_x_is_never_requested(self, mock_request):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        with (
            patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.8', 0))]),
            pytest.raises(UnsafeURLError, match='internal/private'),
        ):
            fetch_public_url('https://looks-public.example/')
        mock_request.assert_not_called()

    @patch("shared.http_utils.requests.Session.request")
    def test_a_redirect_to_the_metadata_ip_is_refused_before_it_is_requested(self, mock_request):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        mock_request.return_value = self._response(302, 'http://169.254.169.254/latest/meta-data/iam/')
        with self._public_dns(), pytest.raises(UnsafeURLError) as raised:
            fetch_public_url('https://example.com/reviews')
        assert raised.value.url == 'http://169.254.169.254/latest/meta-data/iam/'
        assert mock_request.call_count == 1   # only the public first hop went out

    @patch("shared.http_utils.requests.Session.request")
    def test_a_relative_redirect_is_followed_and_revalidated(self, mock_request):
        from shared.http_utils import fetch_public_url

        ok = self._response(200)
        mock_request.side_effect = [self._response(301, '/reviews/'), ok]
        with self._public_dns() as dns:
            assert fetch_public_url('http://example.com/reviews') is ok
        assert [c.kwargs['url'] for c in mock_request.call_args_list] == [
            'http://example.com/reviews', 'http://example.com/reviews/',
        ]
        assert dns.call_count == 2   # each hop resolved and judged

    @patch("shared.http_utils.requests.Session.request")
    def test_a_redirect_loop_stops_after_the_hop_bound(self, mock_request):
        from shared.http_utils import MAX_REDIRECT_HOPS, fetch_public_url

        mock_request.return_value = self._response(302, 'https://example.com/loop')
        with self._public_dns(), pytest.raises(requests.exceptions.TooManyRedirects):
            fetch_public_url('https://example.com/loop')
        assert mock_request.call_count == MAX_REDIRECT_HOPS + 1

    @patch("shared.http_utils.requests.Session.request")
    def test_too_many_distinct_hops_stop_at_a_custom_bound(self, mock_request):
        from shared.http_utils import fetch_public_url

        mock_request.side_effect = [self._response(307, f'https://example.com/{n}') for n in range(10)]
        with self._public_dns(), pytest.raises(requests.exceptions.TooManyRedirects):
            fetch_public_url('https://example.com/start', max_redirects=2)
        assert mock_request.call_count == 3

    @patch("shared.http_utils.requests.Session.request")
    def test_credentials_are_dropped_when_a_redirect_changes_host(self, mock_request):
        from shared.http_utils import fetch_public_url

        mock_request.side_effect = [self._response(302, 'https://other.example/x'), self._response(200)]
        with self._public_dns():
            fetch_public_url('https://example.com/', headers={'Authorization': 'secret', 'Accept': 'text/html'})
        assert mock_request.call_args_list[0].kwargs['headers']['Authorization'] == 'secret'
        assert mock_request.call_args_list[1].kwargs['headers'] == {'Accept': 'text/html'}

    @patch("shared.http_utils.requests.Session.request")
    def test_a_3xx_without_location_is_returned_as_is(self, mock_request):
        from shared.http_utils import fetch_public_url

        not_modified = self._response(304)
        mock_request.return_value = not_modified
        with self._public_dns():
            assert fetch_public_url('https://example.com/') is not_modified


# --- Connect-time pinning through the real requests/urllib3 stack -------------

_PUBLIC_IP = '93.184.216.34'
_OK_BODY = b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\n\r\n<html></html>'


class _ScriptedResolver:
    """Each lookup of a host takes its next scripted answer (the last one repeats)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = 0

    def __call__(self, _host, port, *_args, **_kwargs):
        self.calls += 1
        ip = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return [((10 if ':' in ip else 2), 1, 6, '', (ip, port or 0))]


def _fake_socket(peer, response=b''):
    import socket
    from io import BytesIO

    sock = MagicMock(spec=socket.socket)
    sock.sent = b''

    def sendall(data):
        sock.sent += data

    sock.getpeername.return_value = (peer, 80)
    sock.sendall.side_effect = sendall
    sock.makefile.side_effect = lambda *_a, **_k: BytesIO(response)
    return sock


class TestFetchPublicUrlPinsAtConnect:
    """DNS rebinding: public to `validate_url`, private to the connect."""

    def test_a_rebind_to_the_runtime_api_never_connects(self):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        resolver = _ScriptedResolver(_PUBLIC_IP, '127.0.0.1')
        with (
            patch('shared.url_policy.socket.getaddrinfo', resolver),
            patch('shared.url_policy.socket.create_connection') as connect,
            pytest.raises(UnsafeURLError, match='internal/private'),
        ):
            fetch_public_url('http://rebind.example:9001/2018-06-01/runtime/invocation/next')
        connect.assert_not_called()
        assert resolver.calls == 2   # once for the check, once (refused) at connect

    def test_a_rebind_on_the_retry_attempt_is_refused_too(self):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        # attempt 1: check public, connect public but refused (retryable);
        # attempt 2: check public, connect rebinds to the metadata endpoint.
        resolver = _ScriptedResolver(_PUBLIC_IP, _PUBLIC_IP, _PUBLIC_IP, '169.254.169.254')
        with (
            patch('shared.url_policy.socket.getaddrinfo', resolver),
            patch('shared.url_policy.socket.create_connection', side_effect=ConnectionRefusedError()) as connect,
            patch('tenacity.nap.time.sleep'),   # the retry's backoff wait
            pytest.raises(UnsafeURLError, match='internal/private'),
        ):
            fetch_public_url('https://rebind.example/')
        assert [c.args[0] for c in connect.call_args_list] == [(_PUBLIC_IP, 443)]

    def test_a_public_fetch_connects_to_the_vetted_ip_with_the_original_host(self):
        from shared.http_utils import fetch_public_url

        fake = _fake_socket(_PUBLIC_IP, _OK_BODY)
        with patch('shared.url_policy.socket.getaddrinfo', _ScriptedResolver(_PUBLIC_IP)), \
             patch('shared.url_policy.socket.create_connection', return_value=fake) as connect:
            response = fetch_public_url('http://public.example/reviews')
        assert response.text == '<html></html>'
        assert connect.call_args.args[0] == (_PUBLIC_IP, 80)   # an IP literal: no second lookup
        assert b'Host: public.example\r\n' in fake.sent

    def test_https_keeps_the_original_name_for_sni(self):
        from shared.http_utils import _PinnedHTTPSConnection

        fake = _fake_socket(_PUBLIC_IP)
        connection = _PinnedHTTPSConnection('public.example', 443)
        with patch('shared.url_policy.socket.getaddrinfo', _ScriptedResolver(_PUBLIC_IP)), \
             patch('shared.url_policy.socket.create_connection', return_value=fake) as connect, \
             patch('urllib3.connection.ssl_wrap_socket', return_value=fake) as wrap, \
             patch('urllib3.connection._match_hostname'):
            connection.connect()
        assert connect.call_args.args[0] == (_PUBLIC_IP, 443)
        assert wrap.call_args.kwargs['server_hostname'] == 'public.example'

    def test_proxy_environment_variables_are_ignored(self, monkeypatch):
        from shared.http_utils import fetch_public_url, pinned_session

        monkeypatch.setenv('HTTP_PROXY', 'http://10.0.0.5:3128')
        monkeypatch.setenv('HTTPS_PROXY', 'http://10.0.0.5:3128')
        monkeypatch.setenv('ALL_PROXY', 'http://10.0.0.5:3128')
        assert pinned_session().trust_env is False
        fake = _fake_socket(_PUBLIC_IP, _OK_BODY)
        with patch('shared.url_policy.socket.getaddrinfo', _ScriptedResolver(_PUBLIC_IP)), \
             patch('shared.url_policy.socket.create_connection', return_value=fake) as connect:
            fetch_public_url('http://public.example/')
        assert [c.args[0] for c in connect.call_args_list] == [(_PUBLIC_IP, 80)]
        assert fake.sent.startswith(b'GET / HTTP/1.1')   # origin-form, not a proxy request

    def test_an_explicit_proxy_is_refused(self):
        from shared.http_utils import UnsafeURLError, pinned_session

        with patch('shared.url_policy.socket.getaddrinfo', _ScriptedResolver(_PUBLIC_IP)), \
             patch('shared.url_policy.socket.create_connection') as connect, \
             pytest.raises(UnsafeURLError, match='Proxies'):
            pinned_session().get('http://public.example/', proxies={'http': 'http://10.0.0.5:3128'})
        connect.assert_not_called()


class TestRedirectOriginRules:
    PUBLIC = TestFetchPublicUrl.PUBLIC
    _response = staticmethod(TestFetchPublicUrl._response)
    _public_dns = TestFetchPublicUrl._public_dns

    @pytest.mark.parametrize('location', [
        'https://example.com:8443/x',   # same host, other port
        'http://example.com:443/x',     # same host and port, other scheme
    ])
    def test_credentials_are_dropped_when_the_origin_changes(self, location):
        from shared.http_utils import _headers_for_hop

        headers = {'Authorization': 'secret', 'Cookie': 'c', 'Accept': 'text/html'}
        assert _headers_for_hop(headers, 'https://example.com/', location) == {'Accept': 'text/html'}

    def test_credentials_survive_a_same_origin_hop_with_an_explicit_default_port(self):
        from shared.http_utils import _headers_for_hop

        headers = {'Authorization': 'secret'}
        assert _headers_for_hop(headers, 'https://example.com/', 'https://EXAMPLE.com:443/x') is headers

    @patch("shared.http_utils.requests.Session.request")
    def test_an_https_to_http_downgrade_is_refused(self, mock_request):
        from shared.http_utils import UnsafeURLError, fetch_public_url

        mock_request.return_value = self._response(302, 'http://example.com/plain')
        with self._public_dns(), pytest.raises(UnsafeURLError, match='https to http'):
            fetch_public_url('https://example.com/', headers={'Cookie': 'c'})
        assert mock_request.call_count == 1

    @patch("shared.http_utils.requests.Session.request")
    def test_an_http_to_https_upgrade_is_followed(self, mock_request):
        from shared.http_utils import fetch_public_url

        ok = self._response(200)
        mock_request.side_effect = [self._response(301, 'https://example.com/'), ok]
        with self._public_dns():
            assert fetch_public_url('http://example.com/') is ok
