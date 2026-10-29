"""A captured page's SVG logo: drawn to a PNG in the browser, and kept as a SANITISED SVG beside it.

``render_page_logo`` runs inside the browser session, after the page was read:

- a header / og-image ``.svg`` that beats the raster candidate (``page_styles.svg_logo_to_render``) is drawn
  from its URL as an ``<img>`` (``logo_render``: the faithful picture). Its bytes are also downloaded once
  through the SSRF-guarded fetch (≤ 1 MB, an SVG by its bytes) and rebuilt deny-by-default
  (``shared.design_svg``) — that sanitised markup is the copy kept beside the PNG;
- otherwise the page's inline ``<svg>`` logo (``page_inline_logo``) is sanitised and drawn from a ``data:``
  URL; the sanitised markup is the copy.

``stored_logo`` then stores the PNG as the preview and the SVG as a download-only object
(``design_logo.store_rendered`` → ``shared.design_assets.put_svg``). The model reads the PNG only.
A failure anywhere means no SVG copy, or no rendered logo (the raster candidate is used), never no capture.
"""
from __future__ import annotations

from dataclasses import dataclass

from logo_render import Cdp, render_svg_logo
from page_inline_logo import InlineSvg
from page_styles import PageStyles, svg_logo_to_render

from shared import design_assets, design_icons, design_logo, design_svg
from shared.logging import logger


@dataclass(frozen=True)
class RenderedLogo:
    """An SVG logo the browser drew: where it came from, the PNG, and the sanitised markup (when there is one)."""
    source_url: str
    png: bytes
    svg: str | None = None


def _sanitised(markup: object, box: tuple[object, object] | None = None) -> str | None:
    try:
        return design_svg.sanitize_svg(markup, box)
    except design_svg.SvgRefused as exc:
        logger.info('SVG logo not kept as SVG', extra={'reason': str(exc)})
        return None


def downloaded_svg(url: str, fetch: design_icons.Fetch | None) -> str | None:
    """The sanitised markup of the SVG at ``url`` (one SSRF-guarded download), or None."""
    data = design_icons.fetch_bytes(url, fetch, design_svg.MAX_SVG_INPUT_BYTES)
    if data is None or design_icons.sniff_icon_type(data) != design_assets.SVG_TYPE:
        return None
    return _sanitised(data)


def render_page_logo(cdp: Cdp, styles: PageStyles, inline: InlineSvg | None,
                     fetch: design_icons.Fetch | None) -> RenderedLogo | None:
    """The page's SVG logo drawn to a PNG (see the module docstring), or None."""
    url = svg_logo_to_render(styles.logos)
    png = render_svg_logo(cdp, url) if url else None
    if url and png:
        return RenderedLogo(url, png, downloaded_svg(url, fetch))
    svg = _sanitised(inline.markup, (inline.width, inline.height)) if inline is not None else None
    png = render_svg_logo(cdp, design_svg.svg_data_url(svg)) if svg else None
    return RenderedLogo(styles.url, png, svg) if png else None


def stored_logo(design: dict | None, rendered: RenderedLogo | None, ref_id: str, s3: object, bucket: str) -> dict | None:
    """``design`` with the rendered SVG logo stored as its preview (+ the SVG copy) and recorded as its logo
    (``rendered: True``), over the raster candidate and anything the model proposed.

    Without a rendered logo (or when storing it failed) a ``rendered`` flag is never kept: only this
    worker sets one, so ``store_preview`` downloads the raster candidate as before.
    """
    if not isinstance(design, dict):
        return design
    stored = None
    if rendered is not None:
        stored = design_logo.store_rendered(rendered.source_url, rendered.png, ref_id, s3, bucket, rendered.svg)
    if stored is not None:
        return {**design, 'logo': stored}
    logo = design.get('logo')
    if isinstance(logo, dict) and 'rendered' in logo:
        return {**design, 'logo': {k: v for k, v in logo.items() if k != 'rendered'}}
    return design
