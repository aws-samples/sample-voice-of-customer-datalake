"""Read review pages in one browser tab: navigate to page 1, fetch the next pages from inside it.

Page 1 is a real navigation, so whatever JavaScript challenge the site runs is
passed once and its cookies land in the tab. Once it has settled it is scrolled
to the bottom a window at a time (``SCROLL_STEPS``, ``SCROLL_PAUSE_SECONDS`` apart,
stopping when the bottom stops moving), so reviews loaded on scroll are in the
snapshot. Pages 2..N are then fetched with
``fetch()`` FROM the page (same origin, cookies included) and parsed with
``DOMParser`` there — seven pages in about fifteen seconds where seven
navigations take minutes. A page that cannot be fetched that way (another
origin, a fetch error) is navigated to instead.

Everything a page yields comes back from ONE ``Runtime.evaluate`` of
``SNAPSHOT_JS``: its HTTP status, title, visible text, the start of its HTML (for
block detection), its JSON-LD blocks and the URL of its next page — found
generically: ``<link rel=next>``, ``<a rel=next>``, or a link whose text or
aria-label is "next" in one of a few languages.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from block_detection import HTML_SAMPLE_CHARS, PageSignals
from cdp_client import CdpConnection, CdpError

#: Visible text kept per page (what the LLM extraction reads at most, in chunks).
MAX_TEXT_CHARS: Final = 160000
#: JSON-LD blocks kept per page, and characters per block.
MAX_JSONLD_BLOCKS: Final = 50
MAX_JSONLD_CHARS: Final = 400000
#: Characters of JSON-LD kept per page in total, so one snapshot reply stays small on a 512 MB Lambda.
MAX_JSONLD_TOTAL_CHARS: Final = 1_000_000
#: Waiting for a navigated page to settle (seconds).
LOAD_MIN_SECONDS: Final = 3.0
LOAD_MAX_SECONDS: Final = 25.0
LOAD_POLL_SECONDS: Final = 1.5
#: Scrolling a navigated page to its bottom before it is read, so lazy-loaded reviews appear:
#: at most this many scrolls of one window height, this long apart.
SCROLL_STEPS: Final = 6
SCROLL_PAUSE_SECONDS: Final = 0.6
#: A settled page shows at least this much text (a challenge page shows almost none).
SETTLED_TEXT_CHARS: Final = 500
EVALUATE_TIMEOUT_SECONDS: Final = 60.0
PAGE_PARAMETERS: Final = ('page', 'p', 'pg')
#: Page.navigate's errorText for a main document answered with an HTTP error status (a 403 bot wall).
HTTP_ERROR_RESPONSE: Final = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'

NEXT_WORDS: Final = (
    'next', 'next page', 'siguiente', 'página siguiente', 'próxima', 'suivant', 'page suivante',
    'weiter', 'nächste', 'nächste seite', 'successiva', 'avanti', 'volgende', '\u203a', '\u00bb',  # the single and double right-pointing angle quotes
)

SNAPSHOT_JS: Final = r"""
async (mode, target, nextWords, limits) => {
  try {
    let doc = document;
    let status = 0;
    let url = location.href;
    if (mode === 'fetch') {
      const res = await fetch(target, { credentials: 'include', redirect: 'follow' });
      status = res.status;
      url = res.url || target;
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    } else {
      const nav = typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('navigation')[0] : null;
      status = nav && nav.responseStatus ? nav.responseStatus : 0;
    }
    const abs = (href) => { try { return new URL(href, url).href; } catch (e) { return null; } };
    const ld = [];
    let ldChars = 0;
    for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
      if (ld.length >= limits.jsonldBlocks) break;
      const block = (s.textContent || '').slice(0, limits.jsonldChars);
      if (block.trim() === '' || ldChars + block.length > limits.jsonldTotalChars) continue;
      ld.push(block);
      ldChars += block.length;
    }
    const html = doc.documentElement ? doc.documentElement.outerHTML.slice(0, limits.htmlChars) : '';
    const rel = doc.querySelector('link[rel~="next"][href], a[rel~="next"][href]');
    let next = rel ? abs(rel.getAttribute('href')) : null;
    if (!next) {
      const isNext = (el) => [el.getAttribute('aria-label') || '', el.textContent || '']
        .some((label) => nextWords.includes(label.trim().toLowerCase()));
      const link = Array.from(doc.querySelectorAll('a[href]')).find(isNext);
      next = link ? abs(link.getAttribute('href')) : null;
    }
    let text = '';
    if (mode === 'fetch') {
      doc.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove());
      text = (doc.body ? doc.body.textContent || '' : '').replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n');
    } else {
      text = doc.body ? doc.body.innerText || '' : '';
    }
    return JSON.stringify({ status, url, title: doc.title || '', text: text.slice(0, limits.textChars), html, ld, next });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.name ? e.name : e).slice(0, 80) });
  }
}
"""

PROGRESS_JS: Final = (
    "JSON.stringify([document.readyState, document.body ? document.body.innerText.length : 0])"
)
#: Scroll one window height down; answers ``[at the bottom, document height]``.
SCROLL_JS: Final = (
    "(() => { window.scrollBy(0, window.innerHeight); const h = document.documentElement"
    " ? document.documentElement.scrollHeight : 0;"
    " return JSON.stringify([window.scrollY + window.innerHeight >= h, h]); })()"
)


class PageLoadError(RuntimeError):
    """The browser could not load or read a page; the message is client-safe."""


@dataclass(frozen=True)
class PageSnapshot:
    """One page as the browser saw it."""

    url: str
    status: int
    title: str
    text: str
    html: str
    jsonld: tuple[str, ...]
    next_url: str | None

    def signals(self) -> PageSignals:
        return PageSignals(status=self.status, title=self.title, text=self.text, html=self.html)


def _capped_jsonld(blocks: object) -> tuple[str, ...]:
    """The page's JSON-LD blocks, re-capped here: each to MAX_JSONLD_CHARS, all to MAX_JSONLD_TOTAL_CHARS.

    SNAPSHOT_JS caps them already; this does not trust the page's answer to have done so.
    A block that would pass the total is skipped (a cut block is not JSON anyway).
    """
    if not isinstance(blocks, list):
        return ()
    kept: list[str] = []
    total = 0
    for block in blocks[:MAX_JSONLD_BLOCKS]:
        text = str(block)[:MAX_JSONLD_CHARS]
        if total + len(text) > MAX_JSONLD_TOTAL_CHARS:
            continue
        kept.append(text)
        total += len(text)
    return tuple(kept)


def _snapshot_from(raw: object, fallback_url: str) -> PageSnapshot:
    if not isinstance(raw, str):
        raise PageLoadError('the page could not be read')
    try:
        data = json.loads(raw)
    except ValueError:
        raise PageLoadError('the page could not be read') from None
    if not isinstance(data, dict) or 'error' in data:
        raise PageLoadError('the page could not be read')
    jsonld = data.get('ld')
    status = data.get('status')
    next_url = data.get('next')
    return PageSnapshot(
        url=str(data.get('url') or fallback_url),
        status=status if isinstance(status, int) else 0,
        title=str(data.get('title') or ''),
        text=str(data.get('text') or '')[:MAX_TEXT_CHARS],
        html=str(data.get('html') or '')[:HTML_SAMPLE_CHARS],
        jsonld=_capped_jsonld(jsonld),
        next_url=next_url if isinstance(next_url, str) and next_url else None,
    )


def page_parameter_successor(url: str) -> str | None:
    """*url* with its page-number parameter (``page``, ``p``, ``pg``) one higher, when it has one."""
    parts = urlparse(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    for index, (key, value) in enumerate(query):
        if key.lower() in PAGE_PARAMETERS and value.isdigit():
            query[index] = (key, str(int(value) + 1))
            return urlunparse(parts._replace(query=urlencode(query)))
    return None


def same_origin(first: str, second: str) -> bool:
    a, b = urlparse(first), urlparse(second)
    return (a.scheme, a.hostname, a.port) == (b.scheme, b.hostname, b.port)


class BrowserTab:
    """One tab of the managed browser, driven over CDP."""

    _session_id: str | None

    def __init__(
        self,
        cdp: CdpConnection,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._cdp = cdp
        self._sleep = sleep
        self._clock = clock
        self._session_id = None

    def open(self) -> None:
        target = self._cdp.call('Target.createTarget', {'url': 'about:blank'})
        attached = self._cdp.call('Target.attachToTarget', {'targetId': target.get('targetId'), 'flatten': True})
        self._session_id = attached.get('sessionId')
        if not isinstance(self._session_id, str):
            raise PageLoadError('the browser tab could not be opened')
        self._page_call('Page.enable')

    def _page_call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 30.0) -> dict[str, Any]:
        if self._session_id is None:
            self.open()
        return self._cdp.call(method, params, session_id=self._session_id, timeout=timeout)

    def _evaluate(self, expression: str) -> object:
        try:
            result = self._page_call('Runtime.evaluate', {
                'expression': expression, 'awaitPromise': True, 'returnByValue': True,
            }, timeout=EVALUATE_TIMEOUT_SECONDS)
        except CdpError as error:
            raise PageLoadError('the page did not answer') from error
        value = result.get('result')
        return value.get('value') if isinstance(value, dict) else None

    def _snapshot(self, mode: str, target: str | None, fallback_url: str) -> PageSnapshot:
        limits = {'jsonldChars': MAX_JSONLD_CHARS, 'jsonldBlocks': MAX_JSONLD_BLOCKS,
                  'jsonldTotalChars': MAX_JSONLD_TOTAL_CHARS,
                  'htmlChars': HTML_SAMPLE_CHARS, 'textChars': MAX_TEXT_CHARS}
        arguments = ', '.join(json.dumps(value) for value in (mode, target, list(NEXT_WORDS), limits))
        return _snapshot_from(self._evaluate(f'({SNAPSHOT_JS})({arguments})'), fallback_url)

    def _progress(self) -> tuple[str, int]:
        """``(document.readyState, length of the visible text)``; ``('', 0)`` when unreadable."""
        raw = self._evaluate(PROGRESS_JS)
        try:
            state, length = json.loads(raw) if isinstance(raw, str) else ('', 0)
        except ValueError:
            return '', 0
        return (state, length) if isinstance(state, str) and isinstance(length, int) else ('', 0)

    def _wait_until_settled(self) -> None:
        """Until the page is loaded and its text stops changing (a challenge reloads it), within bounds."""
        started = self._clock()
        self._sleep(LOAD_MIN_SECONDS)
        previous = -1  # pragma: no mutate  any start below SETTLED_TEXT_CHARS (or None) can never equal a settled length
        while self._clock() - started < LOAD_MAX_SECONDS:
            state, length = self._progress()
            if state == 'complete' and length >= SETTLED_TEXT_CHARS and length == previous:
                return
            previous = length
            self._sleep(LOAD_POLL_SECONDS)

    def _scroll(self) -> tuple[bool, int] | None:
        """One scroll step: ``(at the bottom, document height)``, ``None`` when unreadable."""
        raw = self._evaluate(SCROLL_JS)
        try:
            bottom, height = json.loads(raw) if isinstance(raw, str) else (None, None)
        except ValueError:
            return None
        return (bottom, height) if isinstance(bottom, bool) and isinstance(height, int) else None

    def _scroll_to_bottom(self) -> None:
        """Scroll down a window at a time until the bottom stops moving (lazy-loaded reviews appear), within bounds."""
        previous = -1  # pragma: no mutate  any start below a real height (0 or more) is never equal to one
        for _ in range(SCROLL_STEPS):
            step = self._scroll()
            if step is None:
                return
            self._sleep(SCROLL_PAUSE_SECONDS)
            bottom, height = step
            if bottom and height == previous:
                return
            previous = height

    def load(self, url: str) -> PageSnapshot:
        """Navigate to *url* and read it once it has settled.

        An HTTP error answer (Chrome's ``net::ERR_HTTP_RESPONSE_CODE_FAILURE``) is still READ: its
        status and markers are what block detection reports ("blocked by HTTP 403", a bot wall's
        vendor). Any other navigation error (no such host, a reset connection) raises.
        """
        try:
            navigated = self._page_call('Page.navigate', {'url': url})
        except CdpError as error:
            raise PageLoadError('the page did not load') from error
        error_text = navigated.get('errorText')
        if error_text and error_text != HTTP_ERROR_RESPONSE:
            raise PageLoadError(f'the page did not load ({str(error_text)[:60]})')
        if error_text:
            self._sleep(LOAD_MIN_SECONDS)
        else:
            self._wait_until_settled()
            self._scroll_to_bottom()
        return self._snapshot('navigate', None, url)

    def fetch(self, url: str) -> PageSnapshot:
        """Read *url* by an in-page fetch when it shares the tab's origin; else (or on failure) navigate."""
        current = self._snapshot_url()
        if current is not None and same_origin(current, url):
            try:
                return self._snapshot('fetch', url, url)
            except PageLoadError:
                pass  # fall back to a navigation
        return self.load(url)

    def _snapshot_url(self) -> str | None:
        value = self._evaluate('location.href')
        return value if isinstance(value, str) else None
