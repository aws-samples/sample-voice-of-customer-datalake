"""shared/product_source_links.py: one public https page read as a product source (7.104.00). The resolver answers a
public address unless a test says otherwise; the GET is a fake, or the real shared/http_utils.py ``fetch_public_url``
over a fake session where a redirect is what is tested. No network."""
from __future__ import annotations

import codecs
from collections.abc import Iterator
from typing import Any, Self
from unittest.mock import MagicMock, patch

import pytest
import requests

from shared.http_utils import MAX_PAGE_BYTES, RetryableHTTPError
from shared.library_extract import Reading
from shared.product_source_links import (
    META_PRESCAN_BYTES,
    MIN_PAGE_CHARS,
    NEEDS_SIGN_IN,
    NOT_A_PAGE,
    RENDERED_BY_SCRIPTS,
    TOO_LARGE,
    TOO_MANY_REDIRECTS,
    TOO_SLOW,
    UNREACHABLE,
    LinkError,
    read_page,
)
from shared.test.library_fixtures import pdf
from shared.test.product_source_fixtures import PAGE, PAGE_TEXT, Pages, html_page, response
from shared.url_policy import PRIVATE_ADDRESS_ERROR

URL = 'https://www.example.com/product'
PUBLIC = '93.184.216.34'


def _answers(host: str, *_rest: Any) -> list:
    ip = {'intranet.example.com': '10.0.0.7'}.get(host, PUBLIC)
    return [(2, 1, 6, '', (ip, 0))]


@pytest.fixture(autouse=True)
def resolver() -> Iterator[None]:
    with patch('shared.url_policy.socket.getaddrinfo', side_effect=_answers):
        yield


def _describe(*_args: Any) -> Reading:
    return Reading('A scanned page, read by the model.')


def _read(pages: Pages, url: str = URL):
    return read_page(url, _describe, pages)


def _cafe_page(head: str, encoding: str) -> bytes:
    """The page with ``head`` first in its ``<head>`` and an accented word in its text, in ``encoding``."""
    return PAGE.replace('<head>', f'<head>{head}').replace('Acme Notes keeps', 'Acme Notes caf\u00e9 keeps').encode(
        encoding)


def _refused(pages: Pages, url: str = URL) -> str:
    with pytest.raises(LinkError) as refused:
        _read(pages, url)
    return str(refused.value)


class TestAPublicPage:
    def test_its_text_title_and_final_address_are_read_and_its_scripts_left_out(self):
        pages = Pages()
        pages.serve(URL, html_page(), final_url='https://example.com/product')
        page = _read(pages)
        assert page.extraction.text == PAGE_TEXT
        assert (page.title, page.final_url, page.content_type, page.size_bytes) == (
            'Acme Notes & more', 'https://example.com/product', 'text/html', len(html_page()))
        assert 'var x' not in page.extraction.text

    def test_it_is_one_bounded_get_with_the_policy_checked_fetch(self):
        pages = Pages()
        pages.serve(URL)
        _read(pages)
        assert pages.calls == [{'url': URL, 'headers': pages.calls[0]['headers'], 'timeout': 20,
                                'max_bytes': MAX_PAGE_BYTES + 1}]
        assert pages.calls[0]['headers']['Accept'].startswith('text/html')

    def test_a_pdf_link_is_read_as_a_pdf_with_its_pages(self):
        pages = Pages()
        pages.serve(URL, pdf('Acme Notes pricing: one plan per team, billed each month.',
                             'Every plan includes search and the weekly digest.'),
                    content_type='application/pdf')
        page = _read(pages)
        assert (page.content_type, page.extraction.pages, page.title) == ('application/pdf', 2, None)
        assert 'one plan per team' in page.extraction.text

    def test_a_short_text_file_is_kept_it_is_not_a_scripted_page(self):
        pages = Pages()
        pages.serve(URL, b'Acme Notes: release notes.', content_type='text/plain')
        assert _read(pages).extraction.text == 'Acme Notes: release notes.'

    def test_a_page_in_another_charset_is_read_in_utf_8(self):
        pages = Pages()
        body = PAGE.replace('Acme Notes keeps', 'Acme Notes caf\u00e9 keeps').encode('cp1252')
        pages.serve(URL, body, content_type='text/html; charset=windows-1252')
        assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text


    @pytest.mark.parametrize('charset', ['punycode', 'idna', 'unicode_escape', 'raw-unicode-escape', 'utf-7', 'UTF7',
                                         'undefined', 'base64', 'rot13', 'no-such-charset'])
    def test_a_page_naming_a_codec_that_is_no_character_set_is_read_as_utf_8(self, charset):
        # Review S3 (7.104.00 round 2): the body was decoded with whatever codec the page named; punycode's decode is
        # quadratic (5 MB took about 1,000 s, past the twin's 900 s), and `undefined` raised on every byte.
        pages = Pages()
        body = PAGE.replace('Acme Notes keeps', 'Acme Notes caf\u00e9 keeps').encode('utf-8')
        pages.serve(URL, body, content_type=f'text/html; charset={charset}')
        assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text

    # Review C1 (7.72.00 gate, round 3): a page whose Content-Type named no charset was read as UTF-8 even when the page
    # declared its own, so a windows-1252 page lost its accents.
    @pytest.mark.parametrize('meta', [
        '<meta charset="windows-1252">', "<META CHARSET='Windows-1252' />",
        '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">',
        '<meta content="text/html; charset=windows-1252" http-equiv="content-type">',
    ], ids=['charset', 'charset-upper-case', 'http-equiv', 'http-equiv-content-first'])
    def test_a_page_whose_content_type_names_no_charset_is_read_in_the_charset_its_meta_declares(self, meta):
        pages = Pages()
        pages.serve(URL, _cafe_page(meta, 'cp1252'), content_type='text/html')
        assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text

    def test_the_content_types_charset_wins_over_the_meta(self):
        pages = Pages()
        pages.serve(URL, _cafe_page('<meta charset="windows-1252">', 'utf-8'), content_type='text/html; charset=utf-8')
        assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text

    @pytest.mark.parametrize('meta', [
        '<meta charset="punycode">', '<meta charset="undefined">', '<meta charset="base64">',
        '<meta charset="no-such-charset">', '<meta charset="utf-16">', '<meta charset="UTF-16LE">',
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-32">', '<meta charset="ut\u0000f-8">',
        '<meta name="description" content="charset=windows-1252">', '<!-- <meta charset="windows-1252"> -->',
    ], ids=['punycode', 'undefined', 'base64', 'unknown', 'utf-16', 'utf-16le', 'utf-32', 'nul',
            'not-a-declaration', 'in-a-comment'])
    def test_a_meta_that_declares_no_plain_ascii_compatible_charset_leaves_the_page_in_utf_8(self, meta):
        # The same allowlist as the Content-Type's (_text_codec), and the HTML standard's prescan: bytes a <meta> was
        # read from as ASCII are not UTF-16 or UTF-32.
        pages = Pages()
        pages.serve(URL, _cafe_page(meta, 'utf-8'), content_type='text/html')
        assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text

    def test_a_meta_past_the_first_1024_bytes_or_after_a_utf_8_byte_order_mark_is_not_read(self):
        late = _cafe_page(f'<!-- {"x" * META_PRESCAN_BYTES} --><meta charset="windows-1252">', 'utf-8')
        marked = codecs.BOM_UTF8 + _cafe_page('<meta charset="windows-1252">', 'utf-8')
        for body in (late, marked):
            pages = Pages()
            pages.serve(URL, body, content_type='text/html')
            assert 'Acme Notes caf\u00e9 keeps' in _read(pages).extraction.text

    @pytest.mark.parametrize(('charset', 'codec'), [
        ('UTF-16', 'utf-16'), ('utf-32', 'utf-32'), ('us-ascii', 'ascii'), ('ISO-8859-15', 'iso8859-15'),
        ('windows-1251', 'cp1251'), ('Shift_JIS', 'shift_jis'), ('utf-8', None), ('UTF8', None), (None, None)])
    def test_a_plain_character_set_is_decoded_as_itself(self, charset, codec):
        from shared.product_source_links import _text_codec
        assert _text_codec(charset) == codec


class TestNotPublic:
    def test_http_is_refused_before_any_request(self):
        pages = Pages()
        assert _refused(pages, 'http://www.example.com/') == (
            'This address is not allowed (only public https pages can be read)')
        assert pages.calls == []

    def test_a_private_address_is_refused_before_any_request(self):
        pages = Pages()
        assert _refused(pages, 'https://intranet.example.com/') == (
            f'This address is not allowed ({PRIVATE_ADDRESS_ERROR})')
        assert pages.calls == []

    def test_a_page_that_ended_on_a_private_address_is_refused(self):
        pages = Pages()
        pages.serve(URL, final_url='https://intranet.example.com/home')
        assert _refused(pages) == f'The page ended on an address that is not allowed ({PRIVATE_ADDRESS_ERROR})'


class _Session:
    """A pinned session's stand-in: the answer for each URL asked, every request recorded."""

    def __init__(self, answers: dict[str, requests.Response]) -> None:
        self.answers, self.asked = answers, []

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def request(self, *, url: str, **_kwargs: Any) -> requests.Response:
        self.asked.append(url)
        return self.answers[url]


def _through_the_real_fetch(answers: dict[str, requests.Response]) -> tuple[str, _Session]:
    session = _Session(answers)
    with patch('shared.http_utils.pinned_session', return_value=session), \
            pytest.raises(LinkError) as refused:
        read_page(URL, _describe)
    return str(refused.value), session


class TestRedirects:
    def test_a_redirect_to_the_metadata_address_is_refused_before_it_is_asked_for(self):
        message, session = _through_the_real_fetch({URL: response(
            URL, status=302, headers={'Location': 'https://169.254.169.254/latest/meta-data/'})})
        assert message == f'The page ended on an address that is not allowed ({PRIVATE_ADDRESS_ERROR})'
        assert session.asked == [URL]

    def test_a_redirect_down_to_http_is_refused(self):
        message, session = _through_the_real_fetch({URL: response(
            URL, status=301, headers={'Location': 'http://www.example.com/product'})})
        assert message == ('The page ended on an address that is not allowed (Redirect from https to http is not '
                           'allowed)')
        assert session.asked == [URL]

    def test_too_many_redirects_are_refused(self):
        pages = Pages()
        pages.answers[URL] = requests.exceptions.TooManyRedirects('loop')
        assert _refused(pages) == TOO_MANY_REDIRECTS


class TestBehindASignIn:
    @pytest.mark.parametrize('status', [401, 403])
    def test_a_refusal_needs_a_sign_in(self, status):
        pages = Pages()
        pages.serve(URL, b'Forbidden', status=status)
        assert _refused(pages) == NEEDS_SIGN_IN

    @pytest.mark.parametrize('final_url', ['https://www.example.com/login?next=/product',
                                           'https://accounts.example.com/signin/v2', 'https://example.com/u/Login.aspx',
                                           'https://example.com/sso/start'])
    def test_a_page_that_ended_on_a_sign_in_path_needs_a_sign_in(self, final_url):
        pages = Pages()
        pages.serve(URL, final_url=final_url)
        assert _refused(pages) == NEEDS_SIGN_IN

    def test_another_hosts_login_form_needs_a_sign_in(self):
        form = PAGE.replace('</body>', '<form><input type="password" name="p"></form></body>').encode()
        pages = Pages()
        pages.serve(URL, form, final_url='https://id.example.org/start')
        assert _refused(pages) == NEEDS_SIGN_IN

    def test_a_password_field_on_the_named_host_itself_is_still_read(self):
        form = PAGE.replace('</body>', '<form><input type="password" name="p"></form></body>').encode()
        pages = Pages()
        pages.serve(URL, form)
        assert _read(pages).extraction.text == PAGE_TEXT


class TestNotReadable:
    def test_a_page_drawn_by_scripts_is_refused_with_what_to_do(self):
        pages = Pages()
        pages.serve(URL, b'<html><body><div id="root"></div><script src="/app.js"></script></body></html>')
        assert _refused(pages) == RENDERED_BY_SCRIPTS

    def test_a_page_just_under_the_threshold_is_refused_and_one_at_it_read(self):
        short, enough = 'x' * (MIN_PAGE_CHARS - 1), 'x' * MIN_PAGE_CHARS
        pages = Pages()
        pages.serve(URL, f'<p>{short}</p>'.encode())
        assert _refused(pages) == RENDERED_BY_SCRIPTS
        pages.serve(URL, f'<p>{enough}</p>'.encode())
        assert _read(pages).extraction.text == enough

    def test_a_page_over_5_mb_is_refused(self):
        pages = Pages()
        pages.serve(URL, b'a' * (MAX_PAGE_BYTES + 1), content_type='text/plain')
        assert _refused(pages) == TOO_LARGE == 'This page is larger than 5 MB, the most a link can be.'

    @pytest.mark.parametrize('content_type', ['image/png', 'application/zip', '', 'application/vnd.ms-excel'])
    def test_anything_but_html_pdf_or_text_is_refused(self, content_type):
        pages = Pages()
        pages.serve(URL, b'\x89PNG', content_type=content_type)
        assert _refused(pages) == NOT_A_PAGE

    @pytest.mark.parametrize(('status', 'message'), [
        (404, 'The page was not found (HTTP 404). Check the link.'),
        (400, 'The site refused the request (HTTP 400). Check the link.'),
    ])
    def test_an_http_error_names_its_status(self, status, message):
        pages = Pages()
        pages.serve(URL, b'no', status=status)
        assert _refused(pages) == message

    def test_a_server_error_after_the_retries_says_try_later(self):
        pages = Pages()
        pages.answers[URL] = RetryableHTTPError('503', response=response(URL, status=503))
        assert _refused(pages) == 'The site answered with an error (HTTP 503). Try again later.'

    @pytest.mark.parametrize(('error', 'message'), [
        (requests.exceptions.ConnectTimeout('slow'), TOO_SLOW),
        (requests.exceptions.ConnectionError('down'), UNREACHABLE),
    ])
    def test_a_network_failure_is_said_plainly(self, error, message):
        pages = Pages()
        pages.answers[URL] = error
        assert _refused(pages) == message


def test_a_scanned_pdf_link_is_read_by_the_model():
    describe = MagicMock(return_value=Reading('Scanned pricing page.'))
    pages = Pages()
    pages.serve(URL, pdf(''), content_type='application/pdf')
    page = read_page(URL, describe, pages)
    assert (page.extraction.text, page.extraction.method) == ('Scanned pricing page.', 'model')
    assert describe.call_args.args[0] == 'pdf'
