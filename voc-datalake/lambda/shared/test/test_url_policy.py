"""Tests for shared/url_policy.py — the one outbound URL policy (issue #244).

No real network: the resolver is patched, except for numeric hosts, which
`getaddrinfo` turns into addresses locally without a DNS query.
"""
import ipaddress
import socket
from unittest.mock import patch

import pytest

from shared import url_policy
from shared.url_policy import PRIVATE_ADDRESS_ERROR, validate_url

PUBLIC = '93.184.216.34'


def _answers(*ips):
    return [((10 if ':' in ip else 2), 1, 6, '', (ip, 0)) for ip in ips]


def _resolving_to(*ips):
    return patch('shared.url_policy.socket.getaddrinfo', return_value=_answers(*ips))


@pytest.mark.parametrize('url', [
    'http://10.0.0.1/', 'http://172.16.5.4/', 'http://192.168.1.1/',
    'http://127.0.0.1:8080/', 'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials', 'http://0.0.0.0/', 'http://224.0.0.1/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:169.254.169.254]/',
])
def test_literal_non_public_addresses_are_refused(url):
    assert validate_url(url) == (False, PRIVATE_ADDRESS_ERROR)


@pytest.mark.parametrize('url', [
    'http://2130706433/',     # 127.0.0.1 as one decimal number
    'http://0x7f000001/',     # ... as hex
    'http://127.1/',          # ... short form
])
def test_numeric_trick_hosts_are_judged_by_what_they_resolve_to(url):
    # Leading-zero octets ('0177.0.0.1') are deliberately absent: libc
    # implementations disagree on octal, and either reading is judged
    # correctly because the fetch uses the same resolver as the check.
    assert validate_url(url) == (False, PRIVATE_ADDRESS_ERROR)


@pytest.mark.parametrize('url', ['http://localhost/', 'http://LOCALHOST./admin', 'http://ip6-localhost/'])
def test_localhost_names_are_refused(url):
    assert validate_url(url) == (False, 'Access to localhost is not allowed')


def test_a_hostname_resolving_to_10_x_is_refused():
    with _resolving_to('10.1.2.3'):
        assert validate_url('https://innocent.example/reviews') == (False, PRIVATE_ADDRESS_ERROR)


def test_one_private_answer_among_public_ones_refuses_the_name():
    with _resolving_to(PUBLIC, '192.168.0.10'):
        assert validate_url('https://mixed.example/') == (False, PRIVATE_ADDRESS_ERROR)


@pytest.mark.parametrize('ip', ['fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', 'fe80::1%eth0'])
def test_a_hostname_resolving_to_ipv6_ula_link_local_or_mapped_private_is_refused(ip):
    with _resolving_to(ip):
        assert validate_url('https://v6.example/') == (False, PRIVATE_ADDRESS_ERROR)


def test_unparseable_answers_fail_closed():
    with patch('shared.url_policy.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('not-an-ip', 0))]):
        assert validate_url('https://weird.example/') == (False, PRIVATE_ADDRESS_ERROR)


def test_an_unresolvable_host_is_refused():
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=socket.gaierror('nope')):
        assert validate_url('https://nx.example/') == (False, 'Could not resolve hostname')


@pytest.mark.parametrize('url', ['ftp://example.com/', 'file:///etc/passwd', 'gopher://x/', 'javascript:alert(1)'])
def test_non_http_schemes_are_refused(url):
    assert validate_url(url) == (False, 'Only http and https URLs are allowed')


@pytest.mark.parametrize('url', ['http://user:pw@example.com/', 'http://public.example@10.0.0.1/', 'https://@example.com/'])
def test_userinfo_is_refused(url):
    with _resolving_to(PUBLIC):
        assert validate_url(url) == (False, 'URLs with embedded credentials are not allowed')


@pytest.mark.parametrize('url', ['', None, 42, ['http://example.com']])
def test_missing_or_non_string_url_is_refused(url):
    assert validate_url(url) == (False, 'URL is required')


@pytest.mark.parametrize('url', ['http://[::1/', 'http://example.com:notaport/'])
def test_malformed_urls_are_refused(url):
    assert validate_url(url) == (False, 'Invalid URL format')


def test_a_public_url_passes():
    with _resolving_to(PUBLIC, '2606:2800:220:1:248:1893:25c8:1946'):
        assert validate_url('https://example.com/reviews?page=2') == (True, '')


def test_public_addresses_returns_each_vetted_address_once():
    with _resolving_to(PUBLIC, PUBLIC):
        assert [str(ip) for ip in url_policy.public_addresses('example.com', 443)] == [PUBLIC]


# --- IPv6 spellings of IPv4, reserved and site-local space -------------------

@pytest.mark.parametrize('address', [
    '64:ff9b::a9fe:a9fe',        # NAT64 well-known prefix -> 169.254.169.254
    '64:ff9b::7f00:1',           # NAT64 -> 127.0.0.1
    '64:ff9b:1::5db8:d822',      # NAT64 local-use prefix: refused outright
    '::7f00:1',                  # IPv4-compatible -> 127.0.0.1
    '::a9fe:a9fe',               # IPv4-compatible -> 169.254.169.254
    '2002:7f00:1::',             # 6to4 embedding 127.0.0.1
    '2002:a9fe:a9fe::1',         # 6to4 embedding 169.254.169.254
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',  # Teredo
    'fec0::1',                   # deprecated site-local (is_global says True)
    '240.0.0.1',                 # reserved IPv4
])
def test_embedded_reserved_and_site_local_addresses_are_blocked(address):
    assert url_policy.is_blocked_ip(ipaddress.ip_address(address)) is True


@pytest.mark.parametrize('address', ['64:ff9b::5db8:d822', '::ffff:93.184.216.34'])
def test_ipv6_spellings_of_a_public_ipv4_pass(address):
    assert url_policy.is_blocked_ip(ipaddress.ip_address(address)) is False


@pytest.mark.parametrize('url', ['http://[64:ff9b::a9fe:a9fe]/', 'http://[::7f00:1]/', 'http://[2002:7f00:1::]/'])
def test_embedded_ipv4_literals_are_refused_by_validate_url(url):
    assert validate_url(url) == (False, PRIVATE_ADDRESS_ERROR)
