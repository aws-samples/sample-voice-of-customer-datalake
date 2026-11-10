"""Mutation hardening for `shared/url_policy.py` (the SSRF guard, issue #244).

`test_url_policy.py` pins which destinations `validate_url` and
`is_blocked_ip` refuse, but a mutation run found what it cannot see:

* the CONNECT-TIME pin. `connect_to_validated_address` (the transport hook of
  both outbound fetchers) had no direct test: the vetted-literal connect, the
  fallback across vetted addresses, which error escapes when every address
  fails, and the peer check (`peer != expected or is_blocked_ip(peer)`, the
  IPv4-mapped peer unwrap, the socket close on refusal) all survived.
* that an IP literal is judged AS WRITTEN — no resolver is consulted.
* scope-id stripping on a PUBLIC answer, and that an unparseable answer is
  skipped rather than ending the scan.
* the wording of the refusals no earlier test named: the private-address
  message itself (tests compared against the imported constant), the
  missing-hostname and resolver-failure messages, the resolver-failure log
  line, and two of the four localhost names.
"""
import ipaddress
import socket
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from shared import url_policy
from shared.url_policy import BlockedDestinationError, connect_to_validated_address, public_addresses, validate_url

PUBLIC_V4 = '93.184.216.34'
OTHER_PUBLIC_V4 = '1.1.1.1'
PUBLIC_V6 = '2606:4700::1'
PRIVATE_MESSAGE = 'Access to internal/private IP addresses is not allowed'


def _resolver_answers(*ips: str) -> list[tuple]:
    return [
        (socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', (ip, 443))
        for ip in ips
    ]


@pytest.fixture
def resolver() -> Iterator[MagicMock]:
    with patch('shared.url_policy.socket.getaddrinfo') as getaddrinfo:
        yield getaddrinfo


@pytest.fixture
def create_connection() -> Iterator[MagicMock]:
    with patch('shared.url_policy.socket.create_connection') as connect:
        yield connect


def _socket_connected_to(peer: str) -> MagicMock:
    sock = MagicMock(spec=socket.socket)
    sock.getpeername.return_value = (peer, 443)
    return sock


class TestEveryRefusalNamesItsCause:
    def test_a_private_address_is_refused_with_the_literal_message(self):
        assert validate_url('http://10.0.0.1/') == (False, 'Access to internal/private IP addresses is not allowed')

    def test_the_connect_time_error_carries_the_same_message(self):
        assert str(BlockedDestinationError()) == PRIVATE_MESSAGE

    @pytest.mark.parametrize('url', ['http:///reviews', 'http://:80/'])
    def test_a_url_without_a_hostname_is_refused(self, url: str):
        assert validate_url(url) == (False, 'URL must have a valid hostname')

    @pytest.mark.parametrize('name', ['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])
    @pytest.mark.parametrize('suffix', ['', '.'])
    def test_every_localhost_name_is_refused_before_any_lookup(self, resolver: MagicMock, name: str, suffix: str):
        assert validate_url(f'http://{name}{suffix}/') == (False, 'Access to localhost is not allowed')
        resolver.assert_not_called()

    @pytest.mark.parametrize('failure', [OSError('resolver broke'), UnicodeError('label too long')])
    def test_a_resolver_failure_is_refused_and_logged(self, resolver: MagicMock, failure: Exception):
        resolver.side_effect = failure
        with patch.object(url_policy, 'logger') as logger:
            assert validate_url('https://broken.example/') == (False, 'URL validation failed')
        logger.warning.assert_called_once_with(f'URL validation error: {failure}')


class TestIpLiteralsAreJudgedAsWritten:
    @pytest.mark.parametrize('url', [f'http://{PUBLIC_V4}/', f'http://[{PUBLIC_V6}]/'])
    def test_a_public_literal_passes_without_asking_the_resolver(self, resolver: MagicMock, url: str):
        resolver.return_value = _resolver_answers('10.0.0.1')
        assert validate_url(url) == (True, '')
        resolver.assert_not_called()


class TestResolverAnswers:
    def test_a_scope_id_is_stripped_from_a_public_answer(self, resolver: MagicMock):
        resolver.return_value = _resolver_answers(f'{PUBLIC_V6}%eth0')
        addresses = public_addresses('v6.example', 443)
        assert addresses == [ipaddress.IPv6Address(PUBLIC_V6)]
        assert [str(ip) for ip in addresses] == [PUBLIC_V6]

    def test_an_unparseable_answer_is_skipped_and_the_rest_still_judged(self, resolver: MagicMock):
        resolver.return_value = _resolver_answers('not-an-ip', PUBLIC_V4)
        assert public_addresses('mixed.example', 443) == [ipaddress.IPv4Address(PUBLIC_V4)]

    def test_the_lookup_asks_for_stream_sockets_of_any_family(self, resolver: MagicMock):
        resolver.return_value = _resolver_answers(PUBLIC_V4)
        public_addresses('example.com', 8443)
        resolver.assert_called_once_with('example.com', 8443, socket.AF_UNSPEC, socket.SOCK_STREAM)


class TestConnectPinsTheVettedAddress:
    def test_it_connects_to_the_vetted_literal_and_returns_that_socket(
        self, resolver: MagicMock, create_connection: MagicMock,
    ):
        resolver.return_value = _resolver_answers(PUBLIC_V4)
        sock = _socket_connected_to(PUBLIC_V4)
        create_connection.return_value = sock
        assert connect_to_validated_address(('example.com', 443), 7.5, ('192.0.2.10', 0)) is sock
        create_connection.assert_called_once_with((PUBLIC_V4, 443), 7.5, ('192.0.2.10', 0))
        sock.close.assert_not_called()

    @pytest.mark.parametrize(('host', 'looked_up'), [
        (f'[{PUBLIC_V6}]', PUBLIC_V6),     # brackets of an IPv6 literal are removed
        ('X.EXAMPLEX', 'X.EXAMPLEX'),      # and nothing else is
    ])
    def test_only_ipv6_brackets_are_stripped_from_the_host(
        self, resolver: MagicMock, create_connection: MagicMock, host: str, looked_up: str,
    ):
        resolver.return_value = _resolver_answers(PUBLIC_V6)
        create_connection.return_value = _socket_connected_to(PUBLIC_V6)
        connect_to_validated_address((host, 443), None)
        resolver.assert_called_once_with(looked_up, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)

    def test_a_refused_address_falls_back_to_the_next_vetted_one(
        self, resolver: MagicMock, create_connection: MagicMock,
    ):
        resolver.return_value = _resolver_answers(OTHER_PUBLIC_V4, PUBLIC_V4)
        sock = _socket_connected_to(PUBLIC_V4)
        create_connection.side_effect = [ConnectionRefusedError('first down'), sock]
        assert connect_to_validated_address(('example.com', 443), None) is sock
        assert [c.args[0] for c in create_connection.call_args_list] == [(OTHER_PUBLIC_V4, 443), (PUBLIC_V4, 443)]

    @pytest.mark.parametrize('answers', [[PUBLIC_V4], [OTHER_PUBLIC_V4, PUBLIC_V4]])
    def test_when_every_address_fails_the_last_error_escapes(
        self, resolver: MagicMock, create_connection: MagicMock, answers: list[str],
    ):
        resolver.return_value = _resolver_answers(*answers)
        errors = [TimeoutError(f'down {i}') for i in range(len(answers))]
        create_connection.side_effect = errors
        with pytest.raises(TimeoutError, match=f'^down {len(answers) - 1}$') as raised:
            connect_to_validated_address(('example.com', 443), None)
        assert raised.value is errors[-1]

    def test_a_wrong_peer_is_refused_without_falling_back(self, resolver: MagicMock, create_connection: MagicMock):
        resolver.return_value = _resolver_answers(PUBLIC_V4, OTHER_PUBLIC_V4)
        sock = _socket_connected_to(OTHER_PUBLIC_V4)
        create_connection.return_value = sock
        with pytest.raises(BlockedDestinationError):
            connect_to_validated_address(('example.com', 443), None)
        sock.close.assert_called_once_with()
        create_connection.assert_called_once()


class TestThePeerCheck:
    @pytest.mark.parametrize(('peer', 'expected'), [
        (PUBLIC_V4, PUBLIC_V4),
        (f'::ffff:{PUBLIC_V4}', PUBLIC_V4),   # an IPv4-mapped peer is its IPv4 address
        (PUBLIC_V6, PUBLIC_V6),
        (f'{PUBLIC_V6}%eth0', PUBLIC_V6),
    ])
    def test_the_expected_public_peer_is_accepted(self, peer: str, expected: str):
        sock = _socket_connected_to(peer)
        url_policy._require_validated_peer(sock, ipaddress.ip_address(expected))
        sock.close.assert_not_called()

    @pytest.mark.parametrize(('peer', 'expected'), [
        (OTHER_PUBLIC_V4, PUBLIC_V4),          # a public peer, but not the vetted one
        (f'::ffff:{OTHER_PUBLIC_V4}', PUBLIC_V4),
        ('10.0.0.1', '10.0.0.1'),              # the expected peer, but not public
        ('not-an-ip', PUBLIC_V4),
    ])
    def test_any_other_peer_closes_the_socket_and_is_refused(self, peer: str, expected: str):
        sock = _socket_connected_to(peer)
        with pytest.raises(BlockedDestinationError):
            url_policy._require_validated_peer(sock, ipaddress.ip_address(expected))
        sock.close.assert_called_once_with()

    def test_an_unreadable_peer_closes_the_socket_and_is_refused(self):
        sock = MagicMock(spec=socket.socket)
        sock.getpeername.side_effect = OSError('not connected')
        with pytest.raises(BlockedDestinationError) as raised:
            url_policy._require_validated_peer(sock, ipaddress.IPv4Address(PUBLIC_V4))
        assert raised.value.__cause__ is None
        assert raised.value.__suppress_context__ is True
        sock.close.assert_called_once_with()
