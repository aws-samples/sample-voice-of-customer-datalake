"""shared/url_policy.py ``require_public``: the public-only guard a design reference's capture and a product source's
link share (7.104.00). No real network: the resolver is patched, except for IP literals, judged as written."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from shared.url_policy import PRIVATE_ADDRESS_ERROR, NotPublicURLError, require_public

PUBLIC = '93.184.216.34'


def _resolving_to(*ips: str):
    answers = [((10 if ':' in ip else 2), 1, 6, '', (ip, 0)) for ip in ips]
    return patch('shared.url_policy.socket.getaddrinfo', return_value=answers)


def _refusal(url: str, *, final: bool) -> NotPublicURLError:
    with pytest.raises(NotPublicURLError) as caught:
        require_public(url, final=final)
    return caught.value


def test_a_public_https_page_passes_both_checks():
    with _resolving_to(PUBLIC):
        # The guard answers nothing for a page it lets through (it raises for one it refuses).
        assert require_public('https://www.example.com/product', final=False) is None
        assert require_public('https://www.example.com/product', final=True) is None


@pytest.mark.parametrize('url', ['http://www.example.com/', 'ftp://example.com/x', 'javascript:alert(1)', ''])
def test_where_a_page_starts_must_be_https(url):
    refusal = _refusal(url, final=False)
    assert (str(refusal), refusal.reason) == (
        'This address is not allowed (only public https pages can be read)', 'url_not_allowed')


def test_where_a_page_ended_may_be_http_but_still_public():
    with _resolving_to(PUBLIC):
        assert require_public('http://www.example.com/landing', final=True) is None


@pytest.mark.parametrize('url', ['file:///etc/passwd', 'chrome://settings', 'data:text/html,x'])
def test_where_a_page_ended_is_never_another_scheme(url):
    refusal = _refusal(url, final=True)
    assert (str(refusal), refusal.reason) == (
        'The page ended on an address that is not allowed (only public https pages can be read)',
        'final_url_not_allowed')


@pytest.mark.parametrize('url', ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/', 'https://[::1]/',
                                 'https://[::ffff:127.0.0.1]/'])
def test_a_private_or_metadata_address_is_refused_naming_why(url):
    refusal = _refusal(url, final=False)
    assert str(refusal) == f'This address is not allowed ({PRIVATE_ADDRESS_ERROR})'


def test_a_name_that_resolves_to_a_private_address_is_refused():
    with _resolving_to('192.168.1.5'):
        refusal = _refusal('https://intranet.example.com/', final=True)
    assert str(refusal) == f'The page ended on an address that is not allowed ({PRIVATE_ADDRESS_ERROR})'


def test_localhost_and_embedded_credentials_are_refused():
    assert str(_refusal('https://localhost/', final=False)) == (
        'This address is not allowed (Access to localhost is not allowed)')
    assert str(_refusal('https://user:pw@www.example.com/', final=False)) == (
        'This address is not allowed (URLs with embedded credentials are not allowed)')


def test_the_refusal_is_a_value_error_a_caller_can_catch_as_one():
    assert issubclass(NotPublicURLError, ValueError)
