"""The picked logo element photographed ALONE: a transparent PNG of exactly what the page draws.

Whatever the logo is — an ``<img>``, an inline ``<svg>``, a CSS background (a sprite too), text, inside a shadow
root, under a cookie banner — the page tab draws it, so the page tab photographs it (``isolate_logo``):

1. ``ISOLATE_JS`` (one evaluate, the page scrolled to the top) finds the stashed candidate
   (``page_logo_candidates.STASH``), reads the colour behind it (the nearest ancestor with a background, for a
   light logo made for a dark header), then hides EVERYTHING else: ``visibility: hidden`` on the root (inherited,
   across shadow roots) and on every element outside the logo that still paints (a consent backdrop sets its own
   ``visible``), backgrounds transparent, and every filter / opacity / blend an ancestor applies (a modal's dimming)
   neutralised. Each change is undone by ``UNDO_JS`` afterwards;
2. ``Emulation.setDefaultBackgroundColorOverride`` makes the canvas transparent, and the element's box is shot at
   ``scale`` (its longest side towards ``TARGET_SIDE_PX``, 1x to 4x: a vector or a large source draws sharp);
3. the shot is trimmed to its painted pixels in a fresh ``about:blank`` tab (``logo_render.trim_png``), which also
   measures how light the logo is: a LIGHT logo (mean luminance over ``LIGHT_LUMINANCE``) on a dark backdrop is
   drawn on that backdrop with a margin, so it stays visible on a white prototype.

The result is checked by its bytes (``png_check``) and kept within the 1 MB company-logo cap (shot again smaller).
Any failure means no isolated logo (the caller falls back), never no capture; log lines carry short reasons only.
"""
from __future__ import annotations

import base64
import json
import math
import re
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

from logo_render import TRANSPARENT, Cdp, colour_of, trim_png
from page_logo_candidates import STASH
from page_shots import ShotTab as PageTab
from png_check import MAX_SIDE_PX

from shared.design_logo import COMPANY_LOGO_MAX_BYTES
from shared.logging import logger

#: The longest side the shot aims for (the trimmed logo is usually a little smaller).
TARGET_SIDE_PX: Final = 640
MAX_SCALE: Final = 4.0
MIN_SCALE: Final = 1.0
#: Room for the backdrop margin a light logo gets (``logo_render.BACKDROP_MARGIN``) within ``MAX_SIDE_PX``.
MAX_SHOT_SIDE_PX: Final = MAX_SIDE_PX - 80
#: Each retry over the 1 MB cap shoots at this fraction of the previous scale.
SMALLER: Final = 0.6
MAX_SHOTS: Final = 3
MAX_DEVICE_PIXEL_RATIO: Final = 4.0

ISOLATE_JS: Final = r"""
((stash, n) => {
  try {
    const el = (window[stash] || [])[n - 1];
    if (!el || !el.isConnected) return JSON.stringify({ error: 'gone' });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    const parentOf = (node) => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    let backdrop = null;
    for (let node = el; node && !backdrop; node = parentOf(node)) {
      const c = getComputedStyle(node).backgroundColor;
      const m = c && c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) backdrop = { r: +m[1], g: +m[2], b: +m[3] };
    }
    const saved = [];
    const set = (node, prop, value) => {
      saved.push([node, prop, node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)]);
      node.style.setProperty(prop, value, 'important');
    };
    const inside = (node) => { for (let m = node; m; m = parentOf(m)) if (m === el) return true; return false; };
    set(document.documentElement, 'visibility', 'hidden');
    set(document.documentElement, 'background', 'transparent');
    if (document.body) set(document.body, 'background', 'transparent');
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (!inside(node) && getComputedStyle(node).visibility === 'visible') set(node, 'visibility', 'hidden');
      }
    }
    set(el, 'visibility', 'visible');
    set(el, 'background-color', 'transparent');
    for (let node = el; node; node = parentOf(node)) {
      const s = getComputedStyle(node);
      if (s.filter !== 'none') set(node, 'filter', 'none');
      if (s.opacity !== '1') set(node, 'opacity', '1');
      if (s.mixBlendMode !== 'normal') set(node, 'mix-blend-mode', 'normal');
    }
    window[stash + 'Undo'] = () => {
      for (const [node, prop, value, priority] of saved.reverse()) {
        if (value) node.style.setProperty(prop, value, priority); else node.style.removeProperty(prop);
      }
    };
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height,
                            vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1, origin: location.origin, backdrop });
  } catch (e) {
    return JSON.stringify({ error: 'script' });
  }
})
"""

UNDO_JS: Final = r"""
((stash) => { const undo = window[stash + 'Undo']; if (undo) undo(); window[stash + 'Undo'] = null; return true; })
"""


class IsolateRefused(Exception):
    """A short reason code the element could not be photographed alone (logged, never shown)."""


@dataclass(frozen=True)
class IsolatedLogo:
    png: bytes
    #: ``#rrggbb`` the logo was drawn on (a light logo for a dark header), else None.
    backdrop: str | None = None


@dataclass(frozen=True)
class _Box:
    x: float
    y: float
    width: float
    height: float
    backdrop: dict[str, int] | None
    #: The page's devicePixelRatio: a screenshot is ``scale`` x this many pixels per CSS pixel.
    device_pixel_ratio: float = 1.0


def isolate_expression(number: int) -> str:
    return f'({ISOLATE_JS})({json.dumps(STASH)}, {int(number)})'


def undo_expression() -> str:
    return f'({UNDO_JS})({json.dumps(STASH)})'


def _number(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise IsolateRefused('bad_box')
    return float(value)


def origin_of(url: str) -> str:
    """``scheme://host[:port]`` of ``url`` as ``location.origin`` spells it, '' when unreadable."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ''
    return f'{parts.scheme}://{parts.netloc.rsplit("@", 1)[-1]}'.lower() if parts.scheme and parts.netloc else ''


def parse_box(raw: object, page_url: str) -> _Box:
    """ISOLATE_JS's answer; IsolateRefused when it failed, the box is empty or outside the first screen, or the tab
    no longer shows ``page_url``'s origin (the page navigated itself after it was checked: nothing is shot)."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise IsolateRefused('no_answer')
    if data.get('error') is not None:
        raise IsolateRefused(re.sub(r'[^a-z_]', '', str(data['error']))[:20] or 'error')
    origin = data.get('origin')
    if not isinstance(origin, str) or not origin or origin.lower() != origin_of(page_url):
        raise IsolateRefused('page_moved')
    x, y, width, height, vw, vh = (_number(data.get(k)) for k in ('x', 'y', 'width', 'height', 'vw', 'vh'))
    if width < 4 or height < 4:
        raise IsolateRefused('empty_box')
    if x < 0 or y < 0 or x + width > vw + 1 or y + height > vh + 1:
        raise IsolateRefused('box_outside_viewport')
    dpr = data.get('dpr')
    ratio = min(MAX_DEVICE_PIXEL_RATIO, max(1.0, _number(dpr))) if dpr is not None else 1.0
    return _Box(x, y, width, height, colour_of(data.get('backdrop')), ratio)


def shot_scale(width: float, height: float) -> float:
    """The scale the box is shot at, for a box of ``width`` x ``height`` DEVICE pixels: its longest side towards
    TARGET_SIDE_PX, 1x to 4x, never past the shot cap."""
    longest = max(width, height)
    return max(MIN_SCALE, min(MAX_SCALE, TARGET_SIDE_PX / longest, MAX_SHOT_SIDE_PX / longest))


def _shoot(tab: PageTab, box: _Box, scale: float) -> bytes:
    clip = {'x': box.x, 'y': box.y, 'width': box.width, 'height': box.height, 'scale': scale}
    data = tab.call('Page.captureScreenshot', {'format': 'png', 'clip': clip, 'captureBeyondViewport': False}).get('data')
    try:
        return base64.b64decode(data if isinstance(data, str) else '', validate=True)
    except ValueError as exc:
        raise IsolateRefused('bad_screenshot') from exc


def _within_cap(tab: PageTab, cdp: Cdp, box: _Box) -> IsolatedLogo | None:
    """Shoot, trim and check; over the 1 MB cap, shoot again smaller (the page stays isolated meanwhile)."""
    scale = shot_scale(box.width * box.device_pixel_ratio, box.height * box.device_pixel_ratio)
    for _ in range(MAX_SHOTS):
        trimmed = trim_png(cdp, _shoot(tab, box, scale), box.backdrop)
        if trimmed is None:
            return None
        if len(trimmed.png) <= COMPANY_LOGO_MAX_BYTES:
            logger.info('Logo isolated', extra={'bytes': len(trimmed.png), 'backdrop': trimmed.backdrop})
            return IsolatedLogo(trimmed.png, trimmed.backdrop)
        scale = max(MIN_SCALE * SMALLER, scale * SMALLER)
    logger.info('Logo not isolated', extra={'reason': 'over_company_logo_cap'})
    return None


def _restore(tab: PageTab) -> None:
    """Undo the isolation and reset the default background, each on its own (one failing never skips the other)."""
    try:
        tab.evaluate(undo_expression())
    except Exception as exc:  # noqa: BLE001 - logged; the page is read last, so nothing reads it afterwards
        logger.info('Logo isolation not undone', extra={'reason': type(exc).__name__})
    try:
        tab.call('Emulation.setDefaultBackgroundColorOverride', {})
    except Exception as exc:  # noqa: BLE001 - as above
        logger.info('Default background not reset', extra={'reason': type(exc).__name__})


def isolate_logo(tab: PageTab, cdp: Cdp, number: int, page_url: str) -> IsolatedLogo | None:
    """Candidate ``number`` photographed alone (see the module docstring), or None (logged); only while the tab still
    shows ``page_url``'s origin. The page is left as it was (``UNDO_JS``, the default background restored) whatever
    happens."""
    try:
        try:
            box = parse_box(tab.evaluate(isolate_expression(number)), page_url)
            tab.call('Emulation.setDefaultBackgroundColorOverride', {'color': TRANSPARENT})
            return _within_cap(tab, cdp, box)
        finally:
            _restore(tab)
    except IsolateRefused as exc:
        logger.info('Logo not isolated', extra={'reason': str(exc)})
    except Exception as exc:  # noqa: BLE001 - a CDP error or a timeout: no isolated logo, never no capture
        logger.info('Logo not isolated', extra={'reason': f'cdp_{type(exc).__name__}'})
    return None
