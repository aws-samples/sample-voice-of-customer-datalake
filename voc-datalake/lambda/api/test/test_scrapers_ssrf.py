"""SSRF guards of POST /scrapers/analyze-url: which addresses are refused, redirects,
and DNS rebinding.

`validate_url` checks the URL the caller sent; `_SAFE_OPENER` re-runs it on every
redirect hop, and every hop's socket connects only to an IP vetted at connect
time (then checks the socket's actual peer), so a name answering public to the
check and private to the connect is refused. No real network: the resolver and
`socket.create_connection` are patched.
"""
import hashlib
import ipaddress
import socket
import ssl
import urllib.error
import urllib.request
from email.message import Message
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

import scrapers_handler
from shared import url_policy
from shared.exceptions import ValidationError


@pytest.mark.parametrize('address', [
    '0.0.0.1',             # "this network" (0.0.0.0/8)
    '100.64.0.1',          # shared address space (carrier NAT)
    '198.18.0.1',          # benchmarking
    '224.0.0.1',           # multicast
    '240.0.0.1',           # reserved
    '127.0.0.1',
    '169.254.169.254',     # instance metadata
    '::ffff:127.0.0.1',    # IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '::',
])
def test_non_public_addresses_are_blocked(address):
    assert url_policy.is_blocked_ip(ipaddress.ip_address(address)) is True


@pytest.mark.parametrize('address', ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
def test_public_unicast_addresses_pass(address):
    assert url_policy.is_blocked_ip(ipaddress.ip_address(address)) is False


def test_a_hostname_resolving_to_a_mapped_loopback_is_refused():
    resolved = [(10, 1, 6, '', ('::ffff:127.0.0.1', 80, 0, 0))]
    with patch('shared.url_policy.socket.getaddrinfo', return_value=resolved):
        assert scrapers_handler.validate_url('https://rebind.example/') == (
            False, 'Access to internal/private IP addresses is not allowed',
        )


def _redirect(handler, location):
    request = urllib.request.Request('https://public.example/page')
    headers = Message()
    headers['Location'] = location
    return handler.redirect_request(request, BytesIO(b''), 302, 'Found', headers, location)


def test_a_redirect_to_an_internal_address_is_refused():
    handler = scrapers_handler._ValidatingRedirectHandler()
    with (
        patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 9001))]),
        pytest.raises(urllib.error.HTTPError, match='Redirect refused: Access to internal/private IP addresses'),
    ):
        _redirect(handler, 'http://runtime.internal:9001/2018-06-01/runtime/invocation/next')


def test_a_redirect_to_another_public_page_is_followed():
    handler = scrapers_handler._ValidatingRedirectHandler()
    with patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
        followed = _redirect(handler, 'https://public.example/moved')
    assert followed is not None
    assert followed.full_url == 'https://public.example/moved'


def _handlers(opener: urllib.request.OpenerDirector) -> list[urllib.request.BaseHandler]:
    """``OpenerDirector.handlers`` — set by its ``__init__`` but absent from typeshed."""
    return vars(opener)['handlers']


def test_the_fetch_goes_through_the_validating_opener():
    handlers = [type(h) for h in _handlers(scrapers_handler._SAFE_OPENER)]
    assert scrapers_handler._ValidatingRedirectHandler in handlers
    assert urllib.request.HTTPRedirectHandler not in handlers
    # Both schemes open their socket through the pinned connections, and the
    # stock handlers that would do a second, unchecked lookup are gone.
    assert scrapers_handler._PinnedHTTPHandler in handlers
    assert scrapers_handler._PinnedHTTPSHandler in handlers
    assert urllib.request.HTTPHandler not in handlers
    assert urllib.request.HTTPSHandler not in handlers


def test_proxy_environment_variables_cannot_route_around_the_pin(monkeypatch):
    monkeypatch.setenv('HTTPS_PROXY', 'http://10.0.0.5:3128')
    monkeypatch.setenv('HTTP_PROXY', 'http://10.0.0.5:3128')
    # The stock opener would pick the proxy up from the environment ...
    assert any(isinstance(h, urllib.request.ProxyHandler) for h in _handlers(urllib.request.build_opener()))
    # ... the safe one installs no proxy handler at all.
    opener = scrapers_handler._build_safe_opener()
    assert not any(isinstance(h, urllib.request.ProxyHandler) for h in _handlers(opener))


# --- The classic private-range list is covered by is_global ------------------

_CLASSIC_PRIVATE_RANGES = [
    '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
    '::1/128', 'fc00::/7', 'fe80::/10',
]


def _samples(network, count=2000):
    """Both ends plus ``count`` deterministic, evenly-spread pseudo-random hosts.

    Positions are hashed from the CIDR and index (no ``random`` PRNG: the sample
    must be reproducible run to run, and it carries no security meaning).
    """
    yield network.network_address
    yield network[-1]
    for index in range(count):
        digest = hashlib.sha256(f'{network}#{index}'.encode()).digest()
        yield network[int.from_bytes(digest, 'big') % network.num_addresses]


@pytest.mark.parametrize('cidr', _CLASSIC_PRIVATE_RANGES)
def test_is_global_covers_the_classic_private_ranges(cidr):
    """Why `BLOCKED_IP_RANGES` was dropped: every range it listed is non-global.

    Each is an IANA special-purpose block with Globally Reachable = False, which
    `ipaddress.is_global` encodes; none contains one of the registry's
    globally-reachable exceptions (192.0.0.9/10, 2001:1::1/2, 2001:3::/32, …).
    Checked at both ends of each range plus a deterministic random sample, and
    in IPv4-mapped form for the IPv4 ranges.
    """
    network = ipaddress.ip_network(cidr)
    for address in _samples(network):
        assert not address.is_global, address
        assert url_policy.is_blocked_ip(address), address
        if address.version == 4:
            mapped = ipaddress.IPv6Address(f'::ffff:{address}')
            assert url_policy.is_blocked_ip(mapped), mapped


def test_the_duplicate_range_list_is_gone():
    assert not hasattr(url_policy, 'BLOCKED_IP_RANGES')
    assert not hasattr(scrapers_handler, 'BLOCKED_IP_RANGES')


def test_analyze_url_uses_the_one_shared_policy():
    """#244: one implementation — the handler holds no copy of its own."""
    assert scrapers_handler.validate_url is url_policy.validate_url
    assert scrapers_handler.BlockedDestinationError is url_policy.BlockedDestinationError
    assert not hasattr(scrapers_handler, '_is_blocked_ip')
    assert not hasattr(scrapers_handler, 'BLOCKED_HOSTNAMES')


def test_analyze_url_pins_through_the_one_shared_connect():
    """The connect-time pin is url_policy's, also used by the ingestor — no copy here."""
    assert scrapers_handler.connect_to_validated_address is url_policy.connect_to_validated_address
    assert not hasattr(scrapers_handler, '_connect_to_validated_address')
    assert not hasattr(scrapers_handler, '_require_validated_peer')
    connection = scrapers_handler._PinnedHTTPConnection('public.example', 80)
    assert connection._create_connection is url_policy.connect_to_validated_address


# --- DNS rebinding: the destination policy is enforced at connect ------------

PUBLIC = '93.184.216.34'


class _RebindingResolver:
    """A hostile DNS server scripted per host: each lookup takes the next answer,
    the last one repeating — e.g. `{'h': [PUBLIC, METADATA]}` answers public to
    the check and the metadata endpoint to the connect.
    """

    def __init__(self, script):
        self.script = {host: list(answers) for host, answers in script.items()}
        self.calls = []

    def __call__(self, host, port, *_args, **_kwargs):
        self.calls.append(host)
        answers = self.script[host]
        ip = answers.pop(0) if len(answers) > 1 else answers[0]
        family = 10 if ':' in ip else 2
        return [(family, 1, 6, '', (ip, port or 0))]


def _public_everywhere():
    return _RebindingResolver({'public.example': [PUBLIC]})


def _fake_socket(peer, response=b''):
    """Enough socket for http.client: a `socket.socket`-specced mock that records what
    it was sent (`.sent`), replies with `response` and reports `peer` as its peer."""
    sock = MagicMock(spec=socket.socket)
    sock.sent = b''

    def sendall(data):
        sock.sent += data

    sock.getpeername.return_value = (peer, 443)
    sock.sendall.side_effect = sendall
    sock.makefile.side_effect = lambda *_args, **_kwargs: BytesIO(response)
    return sock


_OK = b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\n\r\n<html></html>'


def test_a_resolver_that_rebinds_to_metadata_is_refused_at_connect():
    resolver = _RebindingResolver({'rebind.example': [PUBLIC, '169.254.169.254']})
    with patch('shared.url_policy.socket.getaddrinfo', resolver), \
         patch('shared.url_policy.socket.create_connection') as connect:
        assert scrapers_handler.validate_url('http://rebind.example/') == (True, '')
        with pytest.raises(ValidationError, match='Access to internal/private IP addresses is not allowed'):
            scrapers_handler._fetch_html('http://rebind.example/')
    assert resolver.calls == ['rebind.example', 'rebind.example']
    connect.assert_not_called()   # refused before any socket was opened


def test_a_rebind_to_loopback_is_refused_for_https_too():
    resolver = _RebindingResolver({'rebind.example': [PUBLIC, '127.0.0.1']})
    with patch('shared.url_policy.socket.getaddrinfo', resolver), \
         patch('shared.url_policy.socket.create_connection') as connect:
        assert scrapers_handler.validate_url('https://rebind.example/') == (True, '')
        with pytest.raises(ValidationError, match='Access to internal/private IP addresses is not allowed'):
            scrapers_handler._fetch_html('https://rebind.example/')
    connect.assert_not_called()


def test_a_public_connect_goes_to_the_vetted_ip_with_the_original_host_header():
    fake = _fake_socket(PUBLIC, _OK)
    with patch('shared.url_policy.socket.getaddrinfo', _public_everywhere()), \
         patch('shared.url_policy.socket.create_connection', return_value=fake) as connect:
        body = scrapers_handler._fetch_html('http://public.example/reviews')
    assert body == '<html></html>'
    assert connect.call_args.args[0] == (PUBLIC, 80)   # an IP literal: no second lookup
    assert b'Host: public.example\r\n' in fake.sent


def test_https_wraps_the_pinned_socket_with_the_original_name_for_sni_and_cert_checks():
    fake = _fake_socket(PUBLIC)
    handler = scrapers_handler._PinnedHTTPSHandler()
    assert handler.ssl_context.verify_mode == ssl.CERT_REQUIRED
    assert handler.ssl_context.check_hostname is True
    connection = scrapers_handler._PinnedHTTPSConnection('public.example', 443, context=handler.ssl_context)
    with patch('shared.url_policy.socket.getaddrinfo', _public_everywhere()), \
         patch('shared.url_policy.socket.create_connection', return_value=fake) as connect, \
         patch.object(handler.ssl_context, 'wrap_socket', return_value=fake) as wrap:
        connection.connect()
    assert connect.call_args.args[0] == (PUBLIC, 443)
    wrap.assert_called_once_with(fake, server_hostname='public.example')


def test_a_socket_whose_actual_peer_is_private_is_closed_and_refused():
    fake = _fake_socket('10.0.0.7')
    with (
        patch('shared.url_policy.socket.getaddrinfo', _public_everywhere()),
        patch('shared.url_policy.socket.create_connection', return_value=fake),
        pytest.raises(scrapers_handler.BlockedDestinationError),
    ):
        url_policy.connect_to_validated_address(('public.example', 80), 30)
    fake.close.assert_called_once_with()


def test_one_private_answer_among_public_ones_refuses_the_name():
    answers = [(2, 1, 6, '', (PUBLIC, 80)), (2, 1, 6, '', ('192.168.1.1', 80))]
    with (
        patch('shared.url_policy.socket.getaddrinfo', return_value=answers),
        patch('shared.url_policy.socket.create_connection') as connect,
        pytest.raises(scrapers_handler.BlockedDestinationError),
    ):
        url_policy.connect_to_validated_address(('mixed.example', 80), 30)
    connect.assert_not_called()


def test_fallback_only_tries_vetted_addresses():
    second = '93.184.216.35'
    answers = [(2, 1, 6, '', (PUBLIC, 80)), (2, 1, 6, '', (second, 80))]
    fake = _fake_socket(second)
    with patch('shared.url_policy.socket.getaddrinfo', return_value=answers), \
         patch('shared.url_policy.socket.create_connection', side_effect=[OSError('refused'), fake]) as connect:
        assert url_policy.connect_to_validated_address(('multi.example', 80), 30) is fake
    assert [c.args[0] for c in connect.call_args_list] == [(PUBLIC, 80), (second, 80)]


def test_a_redirect_hop_is_pinned_too():
    """Redirect target passes validate_url, then rebinds before its own connect."""
    first = _fake_socket(PUBLIC, b'HTTP/1.1 302 Found\r\nLocation: http://hop.example/next\r\nContent-Length: 0\r\n\r\n')
    resolver = _RebindingResolver({
        'start.example': [PUBLIC],
        'hop.example': [PUBLIC, '169.254.169.254'],   # validate_url sees public, the hop's connect sees metadata
    })
    with (
        patch('shared.url_policy.socket.getaddrinfo', resolver),
        patch('shared.url_policy.socket.create_connection', return_value=first) as connect,
        pytest.raises(ValidationError, match='Access to internal/private IP addresses is not allowed'),
    ):
        scrapers_handler._fetch_html('http://start.example/')
    assert connect.call_count == 1   # the hop never got a socket
    assert resolver.calls == ['start.example', 'hop.example', 'hop.example']
