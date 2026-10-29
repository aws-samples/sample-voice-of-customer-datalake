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
from typing import Any, Final, Protocol

from png_check import MAX_SIDE_PX, MIN_SIDE_PX, png_problem

from shared.logging import logger

COMMAND_TIMEOUT_SECONDS: Final = 30.0
RENDER_MIN_PX: Final = 64
DECODE_TIMEOUT_MS: Final = 8_000
#: The callFunctionOn waits for the decode; its CDP timeout leaves room beyond the in-page timer.
RENDER_CALL_TIMEOUT_SECONDS: Final = DECODE_TIMEOUT_MS / 1000 + 4
TRANSPARENT: Final = {'r': 0, 'g': 0, 'b': 0, 'a': 0}
RENDER_LIMITS: Final = {'max': MAX_SIDE_PX, 'min': RENDER_MIN_PX, 'timeout_ms': DECODE_TIMEOUT_MS}

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

    def render(self, url: str) -> bytes:
        self.call('Emulation.setDeviceMetricsOverride',
                  {'width': MAX_SIDE_PX, 'height': MAX_SIDE_PX, 'deviceScaleFactor': 1, 'mobile': False})
        self.call('Emulation.setDefaultBackgroundColorOverride', {'color': TRANSPARENT})
        return self._photograph(self._draw(url))

    def _draw(self, url: str) -> dict[str, float]:
        """Build the ``<img>`` (the URL a call argument, set as a property), wait for its decode → the clip."""
        document = self.call('Runtime.evaluate', {'expression': 'document', 'returnByValue': False}).get('result')
        object_id = document.get('objectId') if isinstance(document, dict) else None
        if not isinstance(object_id, str):
            raise RenderRefused('no_document')
        drawn = self.call('Runtime.callFunctionOn', {
            'functionDeclaration': RENDER_JS, 'objectId': object_id,
            'arguments': [{'value': url}, {'value': RENDER_LIMITS}],
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


def render_svg_logo(cdp: Cdp, url: str) -> bytes | None:
    """The PNG of the SVG logo at ``url`` as the browser draws it, or None (logged with a short reason).

    Never raises: the logo must never fail the capture.
    """
    tab: _RenderTab | None = None
    try:
        tab = _RenderTab(cdp)
        png = tab.render(url)
    except RenderRefused as exc:
        logger.info('SVG logo not rendered', extra={'reason': str(exc)})
        return None
    except Exception as exc:  # noqa: BLE001 - a CDP error, a timeout or a closed socket: no logo, never no capture
        logger.info('SVG logo not rendered', extra={'reason': f'cdp_{type(exc).__name__}'})
        return None
    finally:
        if tab is not None:
            tab.close()
    logger.info('SVG logo rendered', extra={'bytes': len(png)})
    return png
