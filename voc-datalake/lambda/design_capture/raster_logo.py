"""A captured page's RASTER logo candidate, read inside the browser session — and shrunk when it is too large.

``read_raster_logo`` runs in the session when no SVG logo was rendered (``page_logo``) and there is a bucket:

1. the page's raster candidate (``page_styles.logo_candidate``: PNG / JPEG / WebP, https, URL policy) is
   downloaded ONCE through the SSRF-guarded fetch (``shared.design_logo.fetch_logo``). The bytes are kept,
   and ``design_logo.store_preview`` stores them after the vision call instead of downloading again;
2. only when that download is refused for SIZE (``LogoTooLargeError``: over 2 MB) the URL is checked again
   with the URL policy (``shared.url_policy.validate_url``, https only, like the SVG render) and drawn as an
   ``<img>`` in a fresh ``about:blank`` tab (``logo_render.render_svg_logo``: clamped to 1024 px on its
   longest side, one PNG screenshot checked by its bytes). The URL is a CDP argument, never code. That PNG
   is recorded like a rendered SVG (``page_logo.stored_logo``: ``rendered: True``, ``source_url`` = the
   raster URL, ``content_type: image/png``), so "Use this logo" copies it.

Every other refusal (not an image, unsafe address, HTTP error) is left as it was: no preview. A failed
render means no preview too, never a failed capture; one INFO line names a short reason, never the URL.
"""
from __future__ import annotations

from dataclasses import dataclass

from logo_render import Cdp, render_svg_logo
from page_logo import RenderedLogo
from page_styles import PageStyles, logo_candidate

from shared import design_icons, design_logo
from shared.logging import logger
from shared.url_policy import validate_url


@dataclass(frozen=True)
class RasterLogo:
    """The raster candidate as read in the session: its bytes, or its PNG drawn smaller, or neither."""
    downloaded: design_logo.DownloadedLogo | None = None
    rendered: RenderedLogo | None = None


def _shrunk(cdp: Cdp, url: str) -> RenderedLogo | None:
    """The oversized raster at ``url`` drawn to a PNG of at most 1024 px a side, or None (logged)."""
    if not url.startswith('https://') or not validate_url(url)[0]:
        logger.info('Oversized logo not rendered', extra={'reason': 'url_not_allowed'})
        return None
    png = render_svg_logo(cdp, url, what='Oversized logo')
    return RenderedLogo(url, png) if png else None


def read_raster_logo(cdp: Cdp, styles: PageStyles, fetch: design_icons.Fetch | None) -> RasterLogo:
    """The page's raster logo candidate, downloaded, or shrunk in the browser when it is over 2 MB."""
    candidate = logo_candidate(styles.logos)
    if candidate is None:
        return RasterLogo()
    url = str(candidate['source_url'])
    try:
        data, content_type = design_logo.fetch_logo(url, fetch)
    except design_logo.LogoTooLargeError:
        return RasterLogo(rendered=_shrunk(cdp, url))
    except design_logo.LogoFetchError as exc:
        logger.info('Logo candidate not downloaded', extra={'reason': str(exc)[:120]})
        return RasterLogo()
    return RasterLogo(downloaded=design_logo.DownloadedLogo(url, data, content_type))
