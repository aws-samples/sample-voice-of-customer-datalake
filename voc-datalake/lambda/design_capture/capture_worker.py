"""Read a live website's design in the AgentCore managed browser (``voc-design-capture``).

One reference, one page, one browser session of at most ``SESSION_SECONDS``:

1. the reference row is read; anything but a pending/ready/error ``website`` row is skipped;
2. its URL is re-checked with the SSRF guard (``shared.url_policy.validate_url``, https only);
3. a tab navigates to it and waits (bounded) for the page to settle;
4. the FINAL URL after navigation and redirects is checked again the same way — a page that
   ended on a private, loopback or non-http(s) address is refused and nothing it showed is read;
5. ONE ``Runtime.evaluate`` (``page_styles.styles_expression``) collects the custom properties,
   computed styles, most-used values and logo candidates; block detection (the web_reviews
   plugin's ``block_detection``) turns a bot wall into a clear error;
6. ONE ``Page.captureScreenshot`` (JPEG);
7. ONE vision converse on the utility surface — screenshot + the page facts and text, each fenced
   as DATA — returns ``extracted_design`` + ``extracted_summary``, validated like the token editor;
8. the logo candidate (if any) is downloaded through the SSRF-guarded fetch as a PREVIEW
   (``shared.design_logo.store_preview``: ≤ 2 MB, PNG/JPEG/WebP by its bytes) to
   ``company-context/design/logo_preview_<ref id>.<ext>`` — the only S3 write this worker may do.

``fetched_at`` is stamped when the read finishes, ready or error.

The browser modules are the web_reviews plugin's (``agentcore_browser``, ``cdp_client``,
``block_detection``), bundled beside this file and reached through ``BrowserKit`` so this module
imports nothing outside ``shared`` (and its tests need no AWS and no websocket).
"""
from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, Protocol

from page_components import measured_components, with_measured_examples
from page_styles import PageStyles, css_text_of_vars, logo_candidate, parse_page_styles, styles_expression

from shared import company_context, design_logo, design_references
from shared.css_tokens import tokens_from_css
from shared.image_limits import MAX_IMAGE_BYTES
from shared.logging import logger
from shared.url_policy import validate_url

#: The managed browser session lives at most this long (seconds) — one page.
SESSION_SECONDS: Final = 120
SETTLE_MIN_SECONDS: Final = 2.0
SETTLE_MAX_SECONDS: Final = 20.0
SETTLE_POLL_SECONDS: Final = 1.0
COMMAND_TIMEOUT_SECONDS: Final = 30.0
SCREENSHOT_QUALITY: Final = 70
PROGRESS_JS: Final = "JSON.stringify([document.readyState, document.body ? document.body.innerText.length : 0])"
#: Page.navigate's errorText for a main document answered with an HTTP error (still read: a 403 wall says who).
HTTP_ERROR_RESPONSE: Final = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'
PROCESSABLE_STATUSES: Final = ('pending', 'ready', 'error')


class CaptureError(Exception):
    """A user-safe reason the page could not be read (stored as the reference's ``error``)."""


class Cdp(Protocol):
    def call(self, method: str, params: dict | None = None, *, session_id: str | None = None,
             timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict[str, Any]: ...


@dataclass
class BrowserKit:
    """The web_reviews browser modules this worker drives (injected; fakes in tests)."""
    open_session: Callable[[int], Any]          # agentcore_browser.browser_session (a context manager)
    blocked_by: Callable[[Any], str | None]     # block_detection.blocked_by
    page_signals: Callable[..., Any]            # block_detection.PageSignals
    browser_errors: tuple[type[Exception], ...]  # BrowserUnavailableError, CdpError


@dataclass
class CaptureDeps:
    table: Any
    kit: BrowserKit
    s3: Any = None
    bucket: str = ''
    logo_fetch: Callable[..., Any] | None = None   # None = the SSRF-guarded shared.http_utils.fetch_public_url
    summarise_image: Callable[[bytes, str, str], str] = design_references.summarise_image
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    now: Callable[[], str] = field(default=lambda: datetime.now(UTC).isoformat())


@dataclass
class CapturedPage:
    styles: PageStyles
    screenshot: bytes


# ── The page ────────────────────────────────────────────────────────────────

#: Schemes a URL may have: the configured page must be https; where it ends up may be http(s) (no file:, data:, chrome:).
_START_SCHEMES: Final = ('https://',)
_FINAL_SCHEMES: Final = ('https://', 'http://')


def _require_public(url: str, *, final: bool) -> None:
    """The SSRF guard: a public address with an allowed scheme, else CaptureError naming why."""
    where = 'The page ended on an address that is not allowed' if final else 'This address is not allowed'
    if not url.startswith(_FINAL_SCHEMES if final else _START_SCHEMES):
        raise CaptureError(f'{where} (only public https pages can be read)')
    is_valid, reason = validate_url(url)
    if not is_valid:
        raise CaptureError(f'{where} ({reason})')


class _Tab:
    """One tab over CDP: open, navigate, settle, evaluate, screenshot."""

    def __init__(self, cdp: Cdp, deps: CaptureDeps):
        self._cdp, self._deps = cdp, deps
        target = cdp.call('Target.createTarget', {'url': 'about:blank'})
        attached = cdp.call('Target.attachToTarget', {'targetId': target.get('targetId'), 'flatten': True})
        session = attached.get('sessionId')
        if not isinstance(session, str):
            raise CaptureError('The browser tab could not be opened')
        self._session: str = session
        self.call('Page.enable')

    def call(self, method: str, params: dict | None = None, timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict:
        return self._cdp.call(method, params, session_id=self._session, timeout=timeout)

    def evaluate(self, expression: str) -> object:
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True})
        value = result.get('result')
        return value.get('value') if isinstance(value, dict) else None

    def navigate(self, url: str) -> None:
        error_text = self.call('Page.navigate', {'url': url}).get('errorText')
        if error_text and error_text != HTTP_ERROR_RESPONSE:
            raise CaptureError(f'The page did not load ({str(error_text)[:60]})')
        self._settle()

    def _settle(self) -> None:
        """Until the document is complete and its text stopped growing, within SETTLE_MAX_SECONDS."""
        started = self._deps.clock()
        self._deps.sleep(SETTLE_MIN_SECONDS)
        previous = -1
        while self._deps.clock() - started < SETTLE_MAX_SECONDS:
            raw = self.evaluate(PROGRESS_JS)
            state, length = parse_progress(raw)
            if state == 'complete' and length == previous:
                return
            previous = length
            self._deps.sleep(SETTLE_POLL_SECONDS)

    def screenshot(self) -> bytes:
        data = self.call('Page.captureScreenshot', {'format': 'jpeg', 'quality': SCREENSHOT_QUALITY}).get('data')
        try:
            image = base64.b64decode(data if isinstance(data, str) else '', validate=True)
        except ValueError as exc:
            raise CaptureError('The page could not be photographed') from exc
        if not image:
            raise CaptureError('The page could not be photographed')
        if len(image) > MAX_IMAGE_BYTES:
            raise CaptureError('The page screenshot is larger than the AI can read')
        return image


def parse_progress(raw: object) -> tuple[str, int]:
    """``(document.readyState, visible text length)`` from PROGRESS_JS; ``('', 0)`` when unreadable."""
    try:
        state, length = json.loads(raw) if isinstance(raw, str) else ('', 0)
    except (ValueError, TypeError):
        return '', 0
    return (state, length) if isinstance(state, str) and isinstance(length, int) else ('', 0)


def capture_page(cdp: Cdp, url: str, deps: CaptureDeps) -> CapturedPage:
    """Navigate, re-check the final URL, read the styles (ONE evaluate) and take ONE screenshot."""
    tab = _Tab(cdp, deps)
    tab.navigate(url)
    final_url = tab.evaluate('location.href')
    if not isinstance(final_url, str):
        raise CaptureError('The page could not be read')
    _require_public(final_url, final=True)
    styles = parse_page_styles(tab.evaluate(styles_expression()), final_url)
    if styles is None:
        raise CaptureError('The page could not be read')
    _require_public(styles.url, final=True)
    signals = deps.kit.page_signals(status=styles.status, title=styles.title, text=styles.text, html=styles.html)
    blocker = deps.kit.blocked_by(signals)
    if blocker:
        raise CaptureError(f'The site blocked the secure browser ({blocker}); upload a screenshot or the HTML instead')
    return CapturedPage(styles, tab.screenshot())


# ── The design ──────────────────────────────────────────────────────────────

def design_from_page(page: CapturedPage, deps: CaptureDeps) -> tuple[str, dict | None]:
    """``(summary, extracted_design)`` from the vision model, backed by the page's own custom properties and
    its measured components (the fallback when the model lists none; their snippets fill a model component's
    missing ``example_html``)."""
    styles = page.styles
    tokens = tokens_from_css(css_text_of_vars(styles.root_vars))
    facts = design_references.facts_block('Computed styles and statistics measured in the page', styles.facts())
    text = f'Page title: {styles.title}\nVisible text (start):\n{styles.text}'
    answer = deps.summarise_image(page.screenshot, 'jpeg', f'{facts}\n\n{text}')
    measured = measured_components(styles.components, styles.rules)
    deterministic = {**tokens, 'components': measured, 'logo': logo_candidate(styles.logos)}
    summary, design = design_references.design_outcome(answer, 'computed_styles', deterministic)
    return summary, with_measured_examples(design, measured)


def _target(deps: CaptureDeps, ref_id: object) -> dict | None:
    item = company_context.get_reference(deps.table, ref_id)
    if not item or item.get('kind') != 'website' or item.get('status') not in PROCESSABLE_STATUSES:
        return None
    return item


def _read(item: dict, deps: CaptureDeps) -> tuple[str, dict | None]:
    url = str(item.get('url') or '')
    _require_public(url, final=False)
    try:
        with deps.kit.open_session(SESSION_SECONDS) as cdp:
            page = capture_page(cdp, url, deps)
    except deps.kit.browser_errors as exc:
        logger.warning(f'Design capture browser failure: {type(exc).__name__}')
        raise CaptureError('The secure browser could not read the page; try again later') from exc
    return design_from_page(page, deps)


def run_capture(event: dict, deps: CaptureDeps) -> dict:
    """Capture one website reference and record the outcome; never raises for a page problem."""
    item = _target(deps, event.get('ref_id'))
    if item is None:
        logger.info('Design capture skipped (missing, archived or not a website)')
        return {'status': 'skipped'}
    ref_id = str(item['id'])
    try:
        summary, design = _read(item, deps)
        design = design_logo.store_preview(design, ref_id, deps.s3, deps.bucket, deps.logo_fetch)
        outcome = design_references.ready_outcome(summary, design, deps.now())
    except (CaptureError, design_references.ReferenceFetchError) as exc:
        outcome = design_references.error_outcome(str(exc), deps.now())
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the reference, never retried blind
        logger.warning(f'Design capture failed: {type(exc).__name__}')
        outcome = design_references.error_outcome('The page could not be processed; try Fetch again later', deps.now())
    design_references.record_outcome(deps.table, ref_id, outcome, str(outcome['fetched_at']))
    logger.info('Design capture finished', extra={'status': outcome['status']})
    return {'status': outcome['status']}
