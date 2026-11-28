"""One public https page, read as a product source (7.104.00, docs/project-workspace.md → Product tab), on the
projects API's assist twin (shared/product_source_worker.py).

1. The guard (shared/url_policy.py ``require_public``, the one a design reference's capture takes): https only, a
   public address.
2. ONE GET (shared/http_utils.py ``fetch_public_url``): every redirect hop judged by the policy before it is asked
   for, every socket pinned to an address the policy vetted, never from https down to http, at most
   ``MAX_REDIRECT_HOPS`` hops and ``MAX_PAGE_BYTES`` (5 MB) read. One link is one page: nothing it links to is read.
3. The address it ended on is judged again (``require_public(final=True)``).
4. A page behind a sign-in fails as one: a 401 or 403, an address that ended on a sign-in path, or a page of another
   host than the one named that holds a password field (a login form the link was sent to).
5. HTML, PDF or plain text only, read by shared/library_extract.py (an HTML page's text without its scripts and
   styles), a text page in its declared charset when that is a plain character set, else as UTF-8 (``_text_codec``:
   never a codec such as ``punycode``, whose decode of 5 MB would outlast the twin). The declared charset is the
   Content-Type's, else (7.109.01) an HTML page's own ``<meta charset>`` or ``http-equiv`` Content-Type in its first
   ``META_PRESCAN_BYTES`` (``_meta_charset``, the HTML standard's prescan: none after a UTF-8 byte order mark, and
   UTF-16 or UTF-32 named there read as UTF-8, since bytes a ``<meta>`` was read from as ASCII are neither). A page
   with under ``MIN_PAGE_CHARS`` characters of text fails as rendered by scripts: a browser read of such pages is for
   later (the owner's decision of 2026-11-26).
6. Its ``<title>``, kept for display only (a prompt never gets it, and gets the link's own address as its name).

Every refusal is a ``LinkError`` whose message is the person's (the source's ``error``).
"""
from __future__ import annotations

import codecs
import html
import re
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final
from urllib.parse import urlparse

import requests

from shared.http_statuses import NOT_FOUND_STATUSES
from shared.http_utils import MAX_PAGE_BYTES, RetryableHTTPError, UnsafeURLError, fetch_public_url
from shared.library_extract import Describe, Extraction, ExtractionError, extract, format_of
from shared.url_policy import NotPublicURLError, require_public

__all__ = ['LinkError', 'read_page']

#: Fewer characters of text than this on an HTML page: it is drawn by scripts the read does not run.
MIN_PAGE_CHARS: Final = 400
FETCH_TIMEOUT_SECONDS: Final = 20
TITLE_CHARS: Final = 300
_HEADERS: Final = {
    'User-Agent': 'Mozilla/5.0 (compatible; VoC-DataLake-ProductSources/1.0)',
    'Accept': 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1',
}
#: The content types a link may answer, as library_extract reads them (XHTML as HTML).
_PAGE_TYPES: Final = {'text/html': 'text/html', 'application/xhtml+xml': 'text/html', 'text/plain': 'text/plain',
                      'text/markdown': 'text/markdown', 'application/pdf': 'application/pdf'}
#: A path segment (its extension dropped, any case) that only a sign-in page has.
_SIGN_IN_SEGMENTS: Final = frozenset({'login', 'log-in', 'logon', 'signin', 'sign-in', 'sign_in', 'servicelogin',
                                      'sso'})
_PASSWORD_FIELD: Final = re.compile(rb'<input\b[^>]*\btype\s*=\s*["\']?password', re.IGNORECASE)
_TITLE: Final = re.compile(r'<title\b[^>]*>(.*?)</title\s*>', re.IGNORECASE | re.DOTALL)
#: A charset's name as a page may declare it (a Content-Type's ``charset=``, a ``<meta>``'s): never a space or a NUL.
_CHARSET_NAME: Final = re.compile(r'[\w.:-]+')
_CHARSET: Final = re.compile(rf'charset\s*=\s*["\']?({_CHARSET_NAME.pattern})', re.IGNORECASE)
#: Text codecs Python knows that are no page's character set (7.104.00 round 2), so a page naming one is read as
#: UTF-8: ``punycode`` decodes in quadratic time (5 MB would take about 1,000 s, past the twin's 900 s), ``idna``,
#: ``unicode-escape``, ``raw-unicode-escape`` and ``utf-7`` transform text rather than spell it, and ``undefined``
#: refuses every byte. By ``codecs.lookup``'s name, with ``-`` for ``_``.
_NOT_A_CHARSET: Final = frozenset({'punycode', 'idna', 'unicode-escape', 'raw-unicode-escape', 'utf-7', 'undefined'})
#: How far into an HTML page its own ``<meta>`` charset is looked for, when the Content-Type names none: the HTML
#: standard's prescan reads the first 1,024 bytes.
META_PRESCAN_BYTES: Final = 1024

NEEDS_SIGN_IN: Final = ('This page needs a sign-in, and only public pages can be read. Save the page as PDF and '
                        'upload it instead.')
RENDERED_BY_SCRIPTS: Final = ('This page is drawn by scripts, so its text could not be read. Save the page as PDF and '
                              'upload it instead.')
TOO_LARGE: Final = f'This page is larger than {MAX_PAGE_BYTES // (1024 * 1024)} MB, the most a link can be.'
NOT_A_PAGE: Final = 'This link is not a web page, a PDF or a text file.'
UNREACHABLE: Final = 'The page could not be reached. Check the link and try again.'
TOO_SLOW: Final = 'The page took too long to answer. Try again later.'
TOO_MANY_REDIRECTS: Final = 'This link redirects too many times.'


class LinkError(ValueError):
    """Why a link could not be read, in the person's words (the source's ``error``)."""


@dataclass(frozen=True)
class PageReading:
    """What a link read: its text (shared/library_extract.py), where it ended, its title, its type and length."""

    extraction: Extraction
    final_url: str
    title: str | None
    content_type: str
    size_bytes: int


#: ``fetch_public_url``'s shape (a fake in tests).
Fetch = Callable[..., requests.Response]


def _guard(url: str, *, final: bool) -> None:
    try:
        require_public(url, final=final)
    except NotPublicURLError as exc:
        raise LinkError(str(exc)) from exc


def _http_error(status: int) -> str:
    if status in NOT_FOUND_STATUSES:
        return f'The page was not found (HTTP {status}). Check the link.'
    if status >= 500 or status == 429:
        return f'The site answered with an error (HTTP {status}). Try again later.'
    return f'The site refused the request (HTTP {status}). Check the link.'


def _get(url: str, fetch: Fetch) -> requests.Response:
    """The page, or a LinkError for every way the GET can fail (a refused hop among them)."""
    try:
        return fetch(url, headers=dict(_HEADERS), timeout=FETCH_TIMEOUT_SECONDS, max_bytes=MAX_PAGE_BYTES + 1)
    except UnsafeURLError as exc:
        raise LinkError(f'The page ended on an address that is not allowed ({exc.reason})') from exc
    except requests.exceptions.TooManyRedirects as exc:
        raise LinkError(TOO_MANY_REDIRECTS) from exc
    except RetryableHTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 503
        raise LinkError(_http_error(status)) from exc
    except requests.exceptions.Timeout as exc:
        raise LinkError(TOO_SLOW) from exc
    except requests.exceptions.RequestException as exc:
        raise LinkError(UNREACHABLE) from exc


def _content_type(header: object) -> tuple[str | None, str | None]:
    """The page's type as library_extract reads it (None for any other) and its declared charset."""
    text = header if isinstance(header, str) else ''
    main = text.split(';', 1)[0].strip().lower()
    found = _CHARSET.search(text)
    return _PAGE_TYPES.get(main), found.group(1) if found else None


def _text_codec(charset: str | None) -> str | None:
    """The Python codec of a page's declared charset when it is a plain character set, else None (read as UTF-8): a
    text encoding (``codecs.lookup``'s ``_is_text_encoding``: not a bytes-to-bytes codec such as base64 or zlib) that
    is not one of ``_NOT_A_CHARSET``. UTF-8 itself is None too: library_extract decodes UTF-8."""
    if not charset:
        return None
    try:
        info = codecs.lookup(charset)
    except LookupError:
        return None
    name = info.name.replace('_', '-')
    if not getattr(info, '_is_text_encoding', True) or name in _NOT_A_CHARSET or name == 'utf-8':
        return None
    return info.name


class _MetaCharset(HTMLParser):
    """The charset the first ``<meta>`` that names one declares: its ``charset``, or the ``content``'s ``charset=`` of
    an ``http-equiv`` Content-Type (a comment's or another attribute's text is no declaration)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.charset: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != 'meta' or self.charset is not None:
            return
        found = {name: (value or '').strip() for name, value in attrs}
        if 'charset' in found:
            declared = _CHARSET_NAME.fullmatch(found['charset'])
            self.charset = declared.group(0) if declared else None
        elif found.get('http-equiv', '').lower() == 'content-type':
            declared = _CHARSET.search(found.get('content', ''))
            self.charset = declared.group(1) if declared else None


def _meta_charset(data: bytes) -> str | None:
    """An HTML page's own declared charset, for a Content-Type that names none (the module docstring, step 5): the
    first ``<meta>`` declaration in its first ``META_PRESCAN_BYTES``, read as the ASCII it must be written in; None
    after a UTF-8 byte order mark (it wins, as in a browser) and for UTF-16 or UTF-32, which those bytes are not."""
    if data.startswith(codecs.BOM_UTF8):
        return None
    parser = _MetaCharset()
    parser.feed(data[:META_PRESCAN_BYTES].decode('latin-1'))
    codec = _text_codec(parser.charset)
    return None if codec is None or codec.startswith(('utf-16', 'utf-32')) else parser.charset


def _as_utf8(data: bytes, charset: str | None) -> bytes:
    """A text page's bytes in UTF-8 (library_extract decodes UTF-8, replacing what it cannot read): re-encoded from
    its declared charset when that is a plain character set (``_text_codec``), else left to be read as UTF-8."""
    codec = _text_codec(charset)
    return data if codec is None else data.decode(codec, errors='replace').encode('utf-8')


def _on_sign_in_path(url: str) -> bool:
    segments = urlparse(url).path.lower().split('/')
    return any(segment.split('.', 1)[0] in _SIGN_IN_SEGMENTS for segment in segments)


def _another_hosts_login_form(url: str, final_url: str, data: bytes) -> bool:
    return urlparse(final_url).hostname != urlparse(url).hostname and _PASSWORD_FIELD.search(data) is not None


def _title(data: bytes) -> str | None:
    """The page's ``<title>``, one line, at most ``TITLE_CHARS``: for display only."""
    found = _TITLE.search(data[:65_536].decode('utf-8', errors='replace'))
    title = ' '.join(html.unescape(found.group(1)).split())[:TITLE_CHARS] if found else ''
    return title or None


def _extracted(content_type: str, data: bytes, describe: Describe) -> Extraction:
    fmt = format_of(content_type)
    if fmt is None:  # every _PAGE_TYPES value is a library format; kept as a refusal, never an assert
        raise LinkError(NOT_A_PAGE)
    is_html = content_type == 'text/html'
    try:
        extraction = extract(fmt, data, describe)
    except ExtractionError as exc:
        raise LinkError(RENDERED_BY_SCRIPTS if is_html else str(exc)) from exc
    if is_html and len(extraction.text) < MIN_PAGE_CHARS:
        raise LinkError(RENDERED_BY_SCRIPTS)
    return extraction


def read_page(url: str, describe: Describe, fetch: Fetch | None = None) -> PageReading:
    """Read the one page ``url`` names (the module docstring's steps). ``describe``: the model's reading of a PDF
    with no text layer (shared/library_worker.py ``describe``); ``fetch``: ``fetch_public_url`` unless a test gives
    its own. Raises ``LinkError``."""
    _guard(url, final=False)
    response = _get(url, fetch or fetch_public_url)
    final_url = str(response.url or url)
    _guard(final_url, final=True)
    status = int(response.status_code)
    # 401 Unauthorized and 403 Forbidden: a page for signed-in people only.
    if status in (401, 403) or _on_sign_in_path(final_url):
        raise LinkError(NEEDS_SIGN_IN)
    if status >= 400:
        raise LinkError(_http_error(status))
    content_type, charset = _content_type(response.headers.get('Content-Type'))
    if content_type is None:
        raise LinkError(NOT_A_PAGE)
    body = bytes(response.content or b'')
    if len(body) > MAX_PAGE_BYTES:
        raise LinkError(TOO_LARGE)
    if charset is None and content_type == 'text/html':
        charset = _meta_charset(body)
    data = body if content_type == 'application/pdf' else _as_utf8(body, charset)
    title = None
    if content_type == 'text/html':
        if _another_hosts_login_form(url, final_url, data):
            raise LinkError(NEEDS_SIGN_IN)
        title = _title(data)
    return PageReading(_extracted(content_type, data, describe), final_url, title, content_type, len(body))
