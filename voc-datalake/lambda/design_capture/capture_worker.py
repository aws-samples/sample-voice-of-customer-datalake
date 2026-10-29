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
5b. when the page names no header logo IMAGE, one more evaluate (``page_inline_logo``) serialises its
   inline ``<svg>`` logo, if it has one (untrusted markup, sanitised before use);
6. THREE screenshots for the ONE vision call (``page_shots``): the page above the fold, the header region
   and the footer region, each sized so the model reads it without resizing (PNG, or JPEG when large);
6b. when the page's best logo is an SVG (a header / og-image SVG ranking above the raster candidate,
   ``page_styles.svg_logo_to_render``), the browser draws it as an ``<img>`` in a SEPARATE fresh
   ``about:blank`` tab and keeps a PNG screenshot of it (``logo_render``; checked by its bytes in
   ``png_check``), and its bytes are downloaded once and sanitised (``shared.design_svg``) as the SVG
   copy; otherwise an inline SVG logo (5b) is rebuilt deny-by-default and drawn the same way from a
   ``data:`` URL (``page_logo``); any failure falls back to the raster candidate;
6c. the page's icons (favicons, touch icons, manifest icons, ``og:image`` when it is the logo) are
   downloaded through the SSRF-guarded fetch, within ``ICONS_BUDGET_SECONDS`` (``page_icons``,
   ``shared.design_icons``; an SVG icon is sanitised and drawn to a PNG in the same session);
7. ONE vision converse on the utility surface — the three images + the page facts and text, each fenced
   as DATA (``shared.design_vision``) — returns ``extracted_design`` + ``extracted_summary``, validated
   like the token editor;
8. a rendered logo's PNG is stored as the PREVIEW and its sanitised SVG beside it, download-only
   (``page_logo.stored_logo``), recorded as ``logo: {source_url: <svg url>, content_type: 'image/png',
   rendered: True, preview_key, svg_preview_key?}``; otherwise the raster candidate (if any) is downloaded
   through the SSRF-guarded fetch as a PREVIEW (``shared.design_logo.store_preview``: ≤ 2 MB,
   PNG/JPEG/WebP by its bytes). Either way the key is ``company-context/design/logo_preview_<ref id>.<ext>``;
   the icons go to ``company-context/design/icons_<ref id>/`` and are recorded as ``extracted_design.icons``.
   Those two prefixes are the only S3 writes this worker may do.

``fetched_at`` is stamped when the read finishes, ready or error.

The browser modules are the web_reviews plugin's (``agentcore_browser``, ``cdp_client``,
``block_detection``), bundled beside this file and reached through ``BrowserKit`` so this module
imports nothing outside ``shared`` (and its tests need no AWS and no websocket).
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Final
from urllib.parse import urlparse

from logo_render import COMMAND_TIMEOUT_SECONDS, Cdp, render_svg_logo
from page_components import measured_components
from page_icons import icon_refs
from page_inline_logo import InlineSvg, inline_logo_expression, parse_inline_logo, wants_inline_logo
from page_logo import RenderedLogo, render_page_logo, stored_logo
from page_outcome import CaptureError, page_problem
from page_shots import take_shots
from page_spacing import without_layout_artefacts
from page_styles import (
    PageStyles,
    css_text_of_vars,
    logo_candidate,
    parse_page_styles,
    styles_expression,
)

from shared import company_context, design_icons, design_logo, design_references, design_vision
from shared.cdp_page import HTTP_ERROR_RESPONSE, PROGRESS_JS
from shared.component_overlay import overlay_components
from shared.css_tokens import custom_properties, tokens_from_css
from shared.logging import logger
from shared.tailwind_components import Theme
from shared.timestamps import now_iso
from shared.url_policy import validate_url

#: The managed browser session lives at most this long (seconds) — one page.
SESSION_SECONDS: Final = 120
SETTLE_MIN_SECONDS: Final = 2.0
SETTLE_MAX_SECONDS: Final = 20.0
SETTLE_POLL_SECONDS: Final = 1.0
#: The icon downloads (and SVG icon renders) stop starting after this long, inside the session.
ICONS_BUDGET_SECONDS: Final = 20.0
#: The managed browser's viewport (web_reviews ``agentcore_browser.VIEWPORT``), for an unreadable measurement.
VIEWPORT: Final = (1366.0, 900.0)
PROCESSABLE_STATUSES: Final = ('pending', 'ready', 'error')


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
    # Function defaults through default_factory: a plain function default is a class attribute, which
    # static analysis (CodeQL py/call/wrong-arguments) reads as a method bound to the instance.
    summarise_images: Callable[[Sequence[design_vision.PageShot], str], str] = field(
        default_factory=lambda: design_vision.summarise_page_images)
    sleep: Callable[[float], None] = field(default_factory=lambda: time.sleep)
    clock: Callable[[], float] = field(default_factory=lambda: time.monotonic)
    now: Callable[[], str] = field(default_factory=lambda: now_iso)


@dataclass
class CapturedPage:
    styles: PageStyles
    #: The fold, header and footer images of the ONE vision call (``page_shots``; the fold always first).
    shots: tuple[design_vision.PageShot, ...]
    #: An SVG logo drawn by the browser (``page_logo``); None when none was rendered.
    rendered_logo: RenderedLogo | None = None
    #: The page's inline ``<svg>`` logo, read only when the page names no header logo image (``page_inline_logo``).
    inline_svg: InlineSvg | None = None
    #: The page's icons, downloaded (and an SVG one drawn) for the local copies (``shared.design_icons``).
    icons: list[design_icons.FetchedIcon] = field(default_factory=list)


# ── The page ────────────────────────────────────────────────────────────────

#: Schemes a URL may have: the configured page must be https; where it ends up may be http(s) (no file:, data:, chrome:).
_START_SCHEMES: Final = ('https://',)
_FINAL_SCHEMES: Final = ('https://', 'http://')


def _require_public(url: str, *, final: bool) -> None:
    """The SSRF guard: a public address with an allowed scheme, else CaptureError naming why."""
    where = 'The page ended on an address that is not allowed' if final else 'This address is not allowed'
    code = 'final_url_not_allowed' if final else 'url_not_allowed'
    if not url.startswith(_FINAL_SCHEMES if final else _START_SCHEMES):
        raise CaptureError(f'{where} (only public https pages can be read)', reason=code)
    is_valid, reason = validate_url(url)
    if not is_valid:
        raise CaptureError(f'{where} ({reason})', reason=code)


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
            raise CaptureError(f'The page did not load ({str(error_text)[:60]})', reason='navigation_failed')
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


def parse_progress(raw: object) -> tuple[str, int]:
    """``(document.readyState, visible text length)`` from PROGRESS_JS; ``('', 0)`` when unreadable."""
    try:
        state, length = json.loads(raw) if isinstance(raw, str) else ('', 0)
    except (ValueError, TypeError):
        return '', 0
    return (state, length) if isinstance(state, str) and isinstance(length, int) else ('', 0)


def capture_page(cdp: Cdp, url: str, deps: CaptureDeps) -> CapturedPage:
    """Navigate, re-check the final URL, read the styles (ONE evaluate) and take the three screenshots."""
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
    problem = page_problem(styles.status, deps.kit.blocked_by(signals))
    if problem is not None:
        raise problem
    inline = None
    if wants_inline_logo(styles.logos, styles.url):
        inline = parse_inline_logo(tab.evaluate(inline_logo_expression()))
    return CapturedPage(styles, take_shots(tab, deps.sleep, VIEWPORT), inline_svg=inline)


def render_logo(cdp: Cdp, page: CapturedPage, deps: CaptureDeps) -> CapturedPage:
    """``page`` with its SVG logo rendered to a PNG (and its sanitised SVG copy), when it has one (``page_logo``).

    Runs after the page work, in its own fresh tab (``logo_render``); any failure keeps ``page`` as it was.
    """
    rendered = render_page_logo(cdp, page.styles, page.inline_svg, deps.logo_fetch)
    return replace(page, rendered_logo=rendered) if rendered else page


def copy_icons(cdp: Cdp, page: CapturedPage, deps: CaptureDeps) -> CapturedPage:
    """``page`` with its icons downloaded (``page_icons`` order), within ``ICONS_BUDGET_SECONDS``.

    Nothing is fetched without a bucket to keep them in. An SVG icon is drawn in this session (``logo_render``).
    """
    if not deps.bucket:
        return page
    started = deps.clock()
    copy = design_icons.IconCopy(draw_svg=lambda data_url: render_svg_logo(cdp, data_url),
                                 within_budget=lambda: deps.clock() - started < ICONS_BUDGET_SECONDS,
                                 fetch=deps.logo_fetch)
    refs = icon_refs(page.styles, lambda url: design_icons.manifest_refs(url, deps.logo_fetch))
    return replace(page, icons=design_icons.fetch_icons(refs, copy))


# ── The design ──────────────────────────────────────────────────────────────

def design_from_page(page: CapturedPage, deps: CaptureDeps) -> tuple[str, dict | None]:
    """``(summary, extracted_design)`` from the vision model, backed by the page's own custom properties and
    its measured components: their computed styles and CSS-rule hovers win over the model's version of the
    same component (``shared.component_overlay``), and their snippets fill a missing ``example_html``."""
    styles = page.styles
    root_css = css_text_of_vars(styles.root_vars)
    tokens = tokens_from_css(root_css)
    facts = design_references.facts_block('Computed styles and statistics measured in the page', styles.facts())
    text = f'Page title: {styles.title}\nVisible text (start):\n{styles.text}'
    answer = deps.summarise_images(page.shots, f'{facts}\n\n{text}')
    measured = measured_components(styles.components, styles.rules, Theme(custom_properties(root_css)).resolve_vars)
    deterministic = {**tokens, 'components': measured, 'logo': logo_candidate(styles.logos)}
    summary, design = design_references.design_outcome(answer, 'computed_styles', deterministic)
    return summary, overlay_components(without_layout_artefacts(design, styles), measured)


def _target(deps: CaptureDeps, ref_id: object) -> dict | None:
    item = company_context.get_reference(deps.table, ref_id)
    if not item or item.get('kind') != 'website' or item.get('status') not in PROCESSABLE_STATUSES:
        return None
    return item


@dataclass
class _Trace:
    """What the capture log names: the managed browser session, and why a read failed (never a URL)."""
    browser_session_id: str = ''
    reason: str = ''
    http_status: int = 0

    def failed(self, reason: str, http_status: int = 0) -> None:
        self.reason, self.http_status = reason, http_status

    def log_fields(self) -> dict[str, object]:
        fields: dict[str, object] = {'browser_session_id': self.browser_session_id or None}
        if self.reason:
            fields['reason'] = self.reason
        if self.http_status:
            fields['http_status'] = self.http_status
        return fields


def page_host(url: str) -> str:
    """The host of *url* only (``urlparse().hostname`` never carries userinfo), '' when unreadable."""
    try:
        return urlparse(url).hostname or ''
    except ValueError:
        return ''


def _read(item: dict, deps: CaptureDeps, trace: _Trace) -> tuple[str, dict | None]:
    url = str(item.get('url') or '')
    _require_public(url, final=False)
    try:
        with deps.kit.open_session(SESSION_SECONDS) as cdp:
            session_id = getattr(cdp, 'browser_session_id', '')
            trace.browser_session_id = session_id if isinstance(session_id, str) else ''
            page = copy_icons(cdp, render_logo(cdp, capture_page(cdp, url, deps), deps), deps)
    except deps.kit.browser_errors as exc:
        logger.warning(f'Design capture browser failure: {type(exc).__name__}')
        raise CaptureError('The secure browser could not read the page; try again later',
                           reason=f'browser_{type(exc).__name__}') from exc
    summary, design = design_from_page(page, deps)
    ref_id = str(item['id'])
    return summary, with_icons(stored_logo(design, page.rendered_logo, ref_id, deps.s3, deps.bucket), page, ref_id, deps)


def with_icons(design: dict | None, page: CapturedPage, ref_id: str, deps: CaptureDeps) -> dict | None:
    """``design`` with the page's icons stored and recorded as ``icons`` (local entries; none = no key)."""
    if not isinstance(design, dict):
        return design
    entries = design_icons.store_icons(page.icons, ref_id, deps.s3, deps.bucket)
    return {**design, 'icons': entries} if entries else design


def run_capture(event: dict, deps: CaptureDeps) -> dict:
    """Capture one website reference and record the outcome; never raises for a page problem."""
    item = _target(deps, event.get('ref_id'))
    if item is None:
        logger.info('Design capture skipped (missing, archived or not a website)')
        return {'status': 'skipped'}
    ref_id = str(item['id'])
    trace = _Trace()
    try:
        summary, design = _read(item, deps, trace)
        design = design_logo.store_preview(design, ref_id, deps.s3, deps.bucket, deps.logo_fetch)
        outcome = design_references.ready_outcome(summary, design, deps.now())
    except CaptureError as exc:
        trace.failed(exc.reason, exc.http_status)
        outcome = design_references.error_outcome(str(exc), deps.now())
    except design_references.ReferenceFetchError as exc:
        trace.failed('model_answer')
        outcome = design_references.error_outcome(str(exc), deps.now())
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the reference, never retried blind
        logger.warning(f'Design capture failed: {type(exc).__name__}')
        trace.failed(f'unexpected_{type(exc).__name__}')
        outcome = design_references.error_outcome('The page could not be processed; try Fetch again later', deps.now())
    design_references.record_outcome(deps.table, ref_id, outcome, str(outcome['fetched_at']))
    logger.info('Design capture finished', extra={'status': outcome['status'], 'ref_id': ref_id,
                                                  'host': page_host(str(item.get('url') or '')), **trace.log_fields()})
    return {'status': outcome['status']}
