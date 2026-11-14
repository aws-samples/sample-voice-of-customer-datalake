"""Render a page's SVG logo to a PNG in the managed browser, so only a PNG is ever stored.

An SVG is a document that can carry script, so its bytes are never downloaded, stored or served.
The browser draws it instead, as an ``<img>`` (an image context never runs SVG script and never
loads the SVG's own external references), and only the screenshot of that image is kept.

It runs in the SAME browser session, after the page's own work (styles, screenshot) is done, in a
SEPARATE fresh tab: ``about:blank``, so none of the page's scripts, styles or state can touch the
render, and the page tab is left exactly as it was read. The CDP sequence::

    Target.createTarget {url: 'about:blank'}
    Target.attachToTarget {targetId, flatten: true}                      → sessionId
    Emulation.setDeviceMetricsOverride {width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false}
    Emulation.setDefaultBackgroundColorOverride {color: {r: 0, g: 0, b: 0, a: 0}}
    Runtime.evaluate {expression: 'document', returnByValue: false}      → the document's objectId
    Runtime.callFunctionOn {functionDeclaration: RENDER_JS, objectId,
                            arguments: [{value: <svg url>}, {value: limits}], awaitPromise, returnByValue}
                                                                          → {x, y, width, height} | {error}
    Page.captureScreenshot {format: 'png', clip: {x, y, width, height, scale: 1}, captureBeyondViewport: false}
    Target.closeTarget {targetId}                                        (always, best effort)

The URL is never part of any code or markup string: it is a CDP call ARGUMENT, and RENDER_JS sets it
as a property (``img.src = url``) on an element built with ``createElement``. The image is sized to
its natural size clamped to 64 to 1024 px on its longest side (aspect ratio kept); ``img.decode()`` is
raced against an 8 s timer. The PNG is then checked by its bytes (``png_check.png_problem``: a PNG,
≤ 2 MB, at least 8 px a side, not fully transparent). ANY failure means no rendered logo — the caller falls back to
the raster candidate — and one INFO line names a short reason (never the URL or page text).
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any, Final, Protocol

from png_check import MAX_SIDE_PX, MIN_SIDE_PX, TOO_LARGE_REASON, png_problem

from shared.design_logo import COMPANY_LOGO_MAX_BYTES
from shared.logging import logger

COMMAND_TIMEOUT_SECONDS: Final = 30.0
RENDER_MIN_PX: Final = 64
DECODE_TIMEOUT_MS: Final = 8_000
#: The callFunctionOn waits for the decode; its CDP timeout leaves room beyond the in-page timer.
RENDER_CALL_TIMEOUT_SECONDS: Final = DECODE_TIMEOUT_MS / 1000 + 4
TRANSPARENT: Final = {'r': 0, 'g': 0, 'b': 0, 'a': 0}
RENDER_LIMITS: Final = {'max': MAX_SIDE_PX, 'min': RENDER_MIN_PX, 'timeout_ms': DECODE_TIMEOUT_MS}
#: The longest sides tried, largest first, until the PNG fits the company-logo cap.
RENDER_SIDES_PX: Final = (MAX_SIDE_PX, 768, 512)

RENDER_JS: Final = r"""
function (url, L) {
  const doc = this;
  const body = doc.body || doc.documentElement.appendChild(doc.createElement('body'));
  doc.documentElement.style.background = 'transparent';
  body.style.margin = '0';
  body.style.background = 'transparent';
  const img = doc.createElement('img');
  img.alt = '';
  img.style.position = 'absolute';
  img.style.left = '0';
  img.style.top = '0';
  img.style.display = 'block';
  body.appendChild(img);
  img.src = url;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('decode_timeout'), L.timeout_ms); });
  const decoded = img.decode().then(() => 'ok', () => 'decode_failed');
  return Promise.race([decoded, late]).then((state) => {
    clearTimeout(timer);
    if (state !== 'ok') return { error: state };
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!(w > 0 && h > 0)) return { error: 'no_size' };
    const longest = Math.min(L.max, Math.max(L.min, Math.max(w, h)));
    const scale = longest / Math.max(w, h);
    img.style.width = Math.max(1, Math.round(w * scale)) + 'px';
    img.style.height = Math.max(1, Math.round(h * scale)) + 'px';
    const r = img.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}
"""


class Cdp(Protocol):
    def call(self, method: str, params: dict | None = None, *, session_id: str | None = None,
             timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict[str, Any]: ...


class RenderRefused(Exception):
    """A short reason code the SVG logo could not be rendered (logged, never shown)."""


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RenderRefused('bad_box')
    return float(value)


def clip_of(answer: object) -> dict[str, float]:
    """The screenshot clip from RENDER_JS's answer; RenderRefused when it failed, is empty or overflows."""
    if not isinstance(answer, dict):
        raise RenderRefused('no_answer')
    error = answer.get('error')
    if error is not None:
        raise RenderRefused(str(error)[:40])
    x, y, width, height = (_number(answer.get(k)) for k in ('x', 'y', 'width', 'height'))
    if min(width, height) < MIN_SIDE_PX:
        raise RenderRefused('empty_box')
    if x < 0 or y < 0 or x + width > MAX_SIDE_PX or y + height > MAX_SIDE_PX:
        raise RenderRefused('box_outside_viewport')
    return {'x': x, 'y': y, 'width': width, 'height': height, 'scale': 1}


class _RenderTab:
    """The fresh about:blank tab the logo is drawn in."""

    def __init__(self, cdp: Cdp):
        self._cdp = cdp
        target_id = cdp.call('Target.createTarget', {'url': 'about:blank'}).get('targetId')
        if not isinstance(target_id, str):
            raise RenderRefused('no_tab')
        self.target_id: str = target_id
        session = cdp.call('Target.attachToTarget', {'targetId': target_id, 'flatten': True}).get('sessionId')
        if not isinstance(session, str):
            raise RenderRefused('no_tab')
        self._session: str = session

    def call(self, method: str, params: dict, timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict:
        return self._cdp.call(method, params, session_id=self._session, timeout=timeout)

    def render(self, url: str, max_side: int = MAX_SIDE_PX) -> bytes:
        self.call('Emulation.setDeviceMetricsOverride',
                  {'width': max_side, 'height': max_side, 'deviceScaleFactor': 1, 'mobile': False})
        self.call('Emulation.setDefaultBackgroundColorOverride', {'color': TRANSPARENT})
        return self._photograph(self._draw(url, max_side))

    def _document_id(self) -> str:
        document = self.call('Runtime.evaluate', {'expression': 'document', 'returnByValue': False}).get('result')
        object_id = document.get('objectId') if isinstance(document, dict) else None
        if not isinstance(object_id, str):
            raise RenderRefused('no_document')
        return object_id

    def _draw(self, url: str, max_side: int) -> dict[str, float]:
        """Build the ``<img>`` (the URL a call argument, set as a property), wait for its decode → the clip."""
        object_id = self._document_id()
        drawn = self.call('Runtime.callFunctionOn', {
            'functionDeclaration': RENDER_JS, 'objectId': object_id,
            'arguments': [{'value': url}, {'value': {**RENDER_LIMITS, 'max': max_side}}],
            'awaitPromise': True, 'returnByValue': True,
        }, timeout=RENDER_CALL_TIMEOUT_SECONDS).get('result')
        return clip_of(drawn.get('value') if isinstance(drawn, dict) else None)

    def _photograph(self, clip: dict[str, float]) -> bytes:
        shot = self.call('Page.captureScreenshot',
                         {'format': 'png', 'clip': clip, 'captureBeyondViewport': False}).get('data')
        try:
            png = base64.b64decode(shot if isinstance(shot, str) else '', validate=True)
        except ValueError as exc:
            raise RenderRefused('bad_screenshot') from exc
        problem = png_problem(png)
        if problem is not None:
            raise RenderRefused(problem)
        return png

    def close(self) -> None:
        try:
            self._cdp.call('Target.closeTarget', {'targetId': self.target_id})
        except Exception:  # noqa: BLE001 - closing is best effort; the session ends with the capture anyway
            logger.info('Logo render tab not closed')

    def trim(self, png: bytes, backdrop: dict[str, int] | None) -> dict:
        """TRIM_JS's answer for ``png`` (a ``data:`` URL argument, never part of the code)."""
        object_id = self._document_id()
        data_url = 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')
        answer = self.call('Runtime.callFunctionOn', {
            'functionDeclaration': TRIM_JS, 'objectId': object_id,
            'arguments': [{'value': data_url}, {'value': backdrop}, {'value': TRIM_LIMITS}],
            'awaitPromise': True, 'returnByValue': True,
        }, timeout=RENDER_CALL_TIMEOUT_SECONDS).get('result')
        value = answer.get('value') if isinstance(answer, dict) else None
        if not isinstance(value, dict) or value.get('error') is not None:
            raise RenderRefused(str(value.get('error'))[:40] if isinstance(value, dict) else 'no_answer')
        return value


#: A painted pixel is one more opaque than this (0-255).
TRIM_ALPHA: Final = 8
#: A logo whose painted pixels average a luminance above this is LIGHT (made for a dark header); it is drawn on its
#: backdrop when that is at least ``MIN_CONTRAST`` darker, else on ``NEUTRAL_DARK`` (a header that is a photo has no
#: colour of its own). Measured: 10 of 58 live logos were light.
LIGHT_LUMINANCE: Final = 0.8
MIN_CONTRAST: Final = 0.3
NEUTRAL_DARK: Final = {'r': 31, 'g': 31, 'b': 31}
#: The margin around a light logo drawn on its backdrop, as a share of its height.
BACKDROP_MARGIN: Final = 0.2
TRIM_LIMITS: Final = {'alpha': TRIM_ALPHA, 'light': LIGHT_LUMINANCE, 'contrast': MIN_CONTRAST, 'neutral': NEUTRAL_DARK,
                      'margin': BACKDROP_MARGIN, 'timeout_ms': DECODE_TIMEOUT_MS}

#: Crops a PNG to its painted pixels (+2 px) on a canvas and measures their mean luminance; a light logo is drawn on
#: ``backdrop`` ({r, g, b}) or the neutral dark with a margin. → {data: <base64 PNG>, backdrop: {r, g, b} | null} | {error}.
TRIM_JS: Final = r"""
function (src, backdrop, L) {
  const doc = this;
  const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const img = doc.createElement('img');
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('decode_timeout'), L.timeout_ms); });
  img.src = src;
  return Promise.race([img.decode().then(() => 'ok', () => 'decode_failed'), late]).then((state) => {
    clearTimeout(timer);
    if (state !== 'ok') return { error: state };
    const c = doc.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, painted = 0, light = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] <= L.alpha) continue;
      painted++; light += lum(d[i], d[i + 1], d[i + 2]);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!painted) return { error: 'nothing_painted' };
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2);
    x1 = Math.min(c.width - 1, x1 + 2); y1 = Math.min(c.height - 1, y1 + 2);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const mean = light / painted;
    const fill = mean <= L.light ? null
      : (backdrop && lum(backdrop.r, backdrop.g, backdrop.b) <= mean - L.contrast ? backdrop : L.neutral);
    const pad = fill ? Math.round(h * L.margin) : 0;
    const o = doc.createElement('canvas'); o.width = w + 2 * pad; o.height = h + 2 * pad;
    const og = o.getContext('2d');
    if (fill) { og.fillStyle = `rgb(${fill.r}, ${fill.g}, ${fill.b})`; og.fillRect(0, 0, o.width, o.height); }
    og.drawImage(c, x0, y0, w, h, pad, pad, w, h);
    return { data: o.toDataURL('image/png').split(',', 2)[1], backdrop: fill };
  });
}
"""


@dataclass(frozen=True)
class TrimmedPng:
    png: bytes
    #: ``#rrggbb`` a light logo was drawn on, else None.
    backdrop: str | None = None


def colour_of(raw: object) -> dict[str, int] | None:
    """``{r, g, b}`` (each an int 0-255) from untrusted page or canvas output, else None."""
    if not isinstance(raw, dict):
        return None
    colour = {}
    for channel in ('r', 'g', 'b'):
        value = raw.get(channel)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
            return None
        colour[channel] = value
    return colour


def hex_colour(colour: dict[str, int] | None) -> str | None:
    return '#{r:02x}{g:02x}{b:02x}'.format(**colour) if colour else None


def _trimmed(tab: _RenderTab, png: bytes, backdrop: dict[str, int] | None) -> TrimmedPng:
    answer = tab.trim(png, backdrop)
    trimmed = base64.b64decode(str(answer.get('data') or ''), validate=True)
    problem = png_problem(trimmed)
    if problem is not None:
        raise RenderRefused(problem)
    return TrimmedPng(trimmed, hex_colour(colour_of(answer.get('backdrop'))))


def trim_png(cdp: Cdp, png: bytes, backdrop: dict[str, int] | None) -> TrimmedPng | None:
    """``png`` cropped to its painted pixels in a fresh about:blank tab (see ``TRIM_JS``), checked by its bytes
    (``png_check``), or None (logged with a short reason). Never raises."""
    tab: _RenderTab | None = None
    try:
        tab = _RenderTab(cdp)
        return _trimmed(tab, png, backdrop)
    except RenderRefused as exc:
        logger.info('Logo not trimmed', extra={'reason': str(exc)})
    except Exception as exc:  # noqa: BLE001 - a CDP error, a timeout or a bad answer: no logo, never no capture
        logger.info('Logo not trimmed', extra={'reason': f'cdp_{type(exc).__name__}'})
    finally:
        if tab is not None:
            tab.close()
    return None


def render_svg_logo(cdp: Cdp, url: str, *, what: str = 'SVG logo') -> bytes | None:
    """The PNG of the image (an SVG logo, or a raster one too large to keep) at ``url`` as the browser draws
    it, or None (logged as ``what`` with a short reason).

    At most ``COMPANY_LOGO_MAX_BYTES`` (1 MB), so "Use this logo" can always make it the company logo: a PNG
    over it at 1024 px (or one the PNG check refused as too large, over 2 MB) is drawn again at 768, then
    512 px (a fresh tab each time, at most three draws) before it is given up.
    Never raises: the logo must never fail the capture.
    """
    reason = 'over_company_logo_cap'
    for max_side in RENDER_SIDES_PX:
        png = _render_once(cdp, url, what, max_side)
        if png is None:
            return None
        if isinstance(png, bytes):
            if len(png) <= COMPANY_LOGO_MAX_BYTES:
                return png
            reason = 'over_company_logo_cap'   # a usable PNG, over the 1 MB company-logo cap
        else:
            reason = 'png_check_too_large'     # the PNG check refused it (over 2 MB or 1024 px)
        logger.info(f'{what} too large; drawn smaller', extra={'max_side': max_side, 'reason': reason})
    logger.info(f'{what} not rendered', extra={'reason': reason})   # the last size's real reason
    return None


class _TooLarge:
    """``_render_once``'s answer for a PNG the check refused as too large: worth drawing again smaller."""


TOO_LARGE: Final = _TooLarge()


def _render_once(cdp: Cdp, url: str, what: str, max_side: int) -> bytes | _TooLarge | None:
    tab: _RenderTab | None = None
    try:
        tab = _RenderTab(cdp)
        png = tab.render(url, max_side)
    except RenderRefused as exc:
        if str(exc) == TOO_LARGE_REASON:
            return TOO_LARGE
        logger.info(f'{what} not rendered', extra={'reason': str(exc)})
        return None
    except Exception as exc:  # noqa: BLE001 - a CDP error, a timeout or a closed socket: no logo, never no capture
        logger.info(f'{what} not rendered', extra={'reason': f'cdp_{type(exc).__name__}'})
        return None
    finally:
        if tab is not None:
            tab.close()
    logger.info(f'{what} rendered', extra={'bytes': len(png)})
    return png
