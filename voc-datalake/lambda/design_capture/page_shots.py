"""The three screenshots of a capture's ONE vision call: above the fold, the header region, the footer region.

All three come from the page tab, after the page was read (styles, inline logo), in this order:

1. ``REGIONS_JS`` (one evaluate) measures the viewport, the page height, the first visible ``header`` /
   ``[role=banner]`` (else ``nav``) and the last visible ``footer`` / ``[role=contentinfo]``, in document
   coordinates;
2. **fold** — the viewport as it is (scrolled to the top); a failure here fails the capture as before;
3. **header** — the header's box inside the first screen, at most ``MAX_HEADER_PX`` tall (no header element:
   the top ``FALLBACK_HEADER_PX``);
4. **footer** — the page is scrolled to the footer (or to its last ``FALLBACK_FOOTER_PX`` without one),
   ``FOOTER_SETTLE_SECONDS`` for lazy content, measured again and photographed, at most ``MAX_FOOTER_PX``
   tall. Skipped when the footer already sits inside the first screen (the fold shows it).

Header and footer failures only drop that image. Each image is sized so the model reads it WITHOUT
resizing it (``fit_scale``: longest side ≤ ``MAX_LONG_SIDE_PX``, at most ``MAX_IMAGE_PIXELS``, never
more than 2x; the browser renders the clip at that scale, so small text stays sharp), which also caps
its cost at about 1,530 input tokens (pixels / 750). Format: PNG (exact for flat UI colours and text)
when it is at most ``PNG_MAX_BYTES``, else the same clip again as a JPEG at ``JPEG_QUALITY``.
"""
from __future__ import annotations

import base64
import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

from page_outcome import CaptureError

from shared.design_vision import PageShot
from shared.image_limits import MAX_IMAGE_BYTES
from shared.logging import logger

#: Claude's no-resize bounds (Anthropic vision docs): the longest side and about 1.15 megapixels.
MAX_LONG_SIDE_PX: Final = 1568
MAX_IMAGE_PIXELS: Final = 1_150_000
MAX_SCALE: Final = 2.0
#: Three PNGs at this size stay far below Bedrock's per-image 3.75 MB and keep the request small.
PNG_MAX_BYTES: Final = 1_500_000
JPEG_QUALITY: Final = 90
MAX_HEADER_PX: Final = 240
FALLBACK_HEADER_PX: Final = 160
MAX_FOOTER_PX: Final = 600
FALLBACK_FOOTER_PX: Final = 480
MIN_REGION_PX: Final = 16
FOOTER_SETTLE_SECONDS: Final = 0.8

REGIONS_JS: Final = r"""
(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
  const box = (r) => ({ top: r.top + scrollY, height: r.height });
  const pick = (selector, fromEnd) => {
    const all = Array.from(document.querySelectorAll(selector));
    for (const el of fromEnd ? all.reverse() : all) { const r = seen(el); if (r) return box(r); }
    return null;
  };
  return JSON.stringify({ header: pick('header, [role=banner]', false) || pick('nav', false),
    footer: pick('footer, [role=contentinfo]', true), page: document.documentElement.scrollHeight,
    vw: innerWidth, vh: innerHeight, sy: scrollY });
})()
"""


class ShotTab(Protocol):
    def call(self, method: str, params: dict | None = None, timeout: float = ...) -> dict: ...
    def evaluate(self, expression: str) -> object: ...


@dataclass(frozen=True)
class Box:
    top: float
    height: float


@dataclass(frozen=True)
class Regions:
    viewport_width: float
    viewport_height: float
    page_height: float
    scroll_y: float
    header: Box | None
    footer: Box | None


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _box(raw: object) -> Box | None:
    if not isinstance(raw, dict):
        return None
    top, height = _number(raw.get('top')), _number(raw.get('height'))
    return Box(top, height) if top is not None and height is not None and height > 0 and top >= 0 else None


def parse_regions(raw: object) -> Regions | None:
    """REGIONS_JS's answer, or None when it is not the expected object (untrusted page output)."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    vw, vh, page, sy = (_number(data.get(k)) for k in ('vw', 'vh', 'page', 'sy'))
    if not vw or not vh or vw < MIN_REGION_PX or vh < MIN_REGION_PX or page is None or sy is None:
        return None
    return Regions(vw, vh, max(page, vh), max(sy, 0.0), _box(data.get('header')), _box(data.get('footer')))


def fit_scale(width: float, height: float) -> float:
    """The clip scale at which the image needs no resizing by the model (see the module docstring)."""
    return min(MAX_SCALE, MAX_LONG_SIDE_PX / max(width, height), math.sqrt(MAX_IMAGE_PIXELS / (width * height)))


def _decoded(answer: dict) -> bytes:
    data = answer.get('data')
    try:
        return base64.b64decode(data if isinstance(data, str) else '', validate=True)
    except ValueError:
        return b''


def photograph(tab: ShotTab, region: str, y: float, width: float, height: float) -> PageShot | None:
    """The clip ``(0, y, width, height)`` (document px) as a PageShot, PNG or else JPEG; None when unusable."""
    scale = fit_scale(width, height)
    clip = {'x': 0, 'y': y, 'width': width, 'height': height, 'scale': scale}
    base = {'clip': clip, 'captureBeyondViewport': False}
    image, image_format = _decoded(tab.call('Page.captureScreenshot', {'format': 'png', **base})), 'png'
    if len(image) > PNG_MAX_BYTES:
        image = _decoded(tab.call('Page.captureScreenshot', {'format': 'jpeg', 'quality': JPEG_QUALITY, **base}))
        image_format = 'jpeg'
    if not image or len(image) > MAX_IMAGE_BYTES:
        return None
    return PageShot(region, image, image_format, round(width * scale), round(height * scale))


def _header_shot(tab: ShotTab, regions: Regions) -> PageShot | None:
    box = regions.header or Box(0.0, FALLBACK_HEADER_PX)
    height = min(box.height, MAX_HEADER_PX, regions.viewport_height - box.top)
    return photograph(tab, 'header', box.top, regions.viewport_width, height) if height >= MIN_REGION_PX else None


def _footer_target(regions: Regions) -> Box:
    if regions.footer is not None:
        return regions.footer
    height = min(FALLBACK_FOOTER_PX, regions.page_height)
    return Box(regions.page_height - height, height)


def _footer_shot(tab: ShotTab, regions: Regions, sleep: Callable[[float], None]) -> PageShot | None:
    target = _footer_target(regions)
    if target.top + target.height <= regions.viewport_height:
        return None   # already inside the fold image
    tab.evaluate(f'window.scrollTo(0, {int(target.top)})')
    sleep(FOOTER_SETTLE_SECONDS)
    moved = parse_regions(tab.evaluate(REGIONS_JS))
    if moved is None:
        return None
    box = moved.footer if regions.footer is not None else _footer_target(moved)
    if box is None:
        return None
    top = max(box.top, moved.scroll_y)
    height = min(box.height - (top - box.top), MAX_FOOTER_PX, moved.scroll_y + moved.viewport_height - top)
    return photograph(tab, 'footer', top, moved.viewport_width, height) if height >= MIN_REGION_PX else None


def _optional(take: Callable[[], PageShot | None], region: str) -> PageShot | None:
    try:
        return take()
    except Exception as exc:  # noqa: BLE001 - a header / footer image is a bonus: never fail the capture for it
        logger.info('Page region not photographed', extra={'region': region, 'reason': type(exc).__name__})
        return None


def take_shots(tab: ShotTab, sleep: Callable[[float], None],
               viewport: tuple[float, float]) -> tuple[PageShot, ...]:
    """The fold (required: CaptureError when it cannot be taken), then the header and footer images when usable.

    ``viewport`` is used for the fold when the page's own measurement is unreadable (then no other image).
    """
    regions = parse_regions(tab.evaluate(REGIONS_JS))
    width, height = (regions.viewport_width, regions.viewport_height) if regions else viewport
    fold = photograph(tab, 'fold', 0, width, height)
    if fold is None:
        raise CaptureError('The page could not be photographed')
    if regions is None:
        return (fold,)
    header = _optional(lambda: _header_shot(tab, regions), 'header')
    footer = _optional(lambda: _footer_shot(tab, regions, sleep), 'footer')
    return tuple(shot for shot in (fold, header, footer) if shot is not None)
