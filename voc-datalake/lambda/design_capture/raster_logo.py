"""A captured page's RASTER logo candidate, read inside the browser session, and drawn smaller when it is too
large to be the company logo.

``read_raster_logo`` runs in the session when no SVG logo was rendered (``page_logo``) and there is a bucket:

1. the page's raster candidate (``page_styles.logo_candidate``: https, URL policy) is downloaded ONCE through
   the SSRF-guarded fetch (``shared.design_logo.fetch_logo``: every hop re-checked, sockets pinned, at most
   ``RASTER_SHRINK_MAX_BYTES``, 5 MB), and its type is decided by its bytes (PNG, JPEG or WebP; anything else
   is refused before the browser sees it);
2. at most ``COMPANY_LOGO_MAX_BYTES`` (1 MB): the bytes are kept, and ``design_logo.store_preview`` stores them
   after the vision call instead of downloading again;
3. over 1 MB: those SAME bytes are handed to the browser as a ``data:<type>;base64,…`` URL (``shrink_raster``)
   and drawn as an ``<img>`` in a fresh ``about:blank`` tab (``logo_render.render_svg_logo``: at most 1024 px on
   its longest side, then 768 and 512, one PNG screenshot checked by its bytes, at most 1 MB). The browser
   fetches nothing. That PNG is recorded like a rendered SVG (``page_logo.stored_logo``: ``rendered: True``,
   ``source_url`` = the raster URL, ``content_type: image/png``), so "Use this logo" copies it. When it cannot
   be drawn, the download is still kept as a plain preview if it is at most 2 MB (the admin sees it), else none;
4. over 5 MB: no preview, and one INFO line.

A refused candidate (too large, not an image, unsafe address, HTTP error) is never downloaded again by
``store_preview`` (``RasterLogo.refused_url``). A failed render never fails the capture; every log line names a
short reason, never the URL.
"""
from __future__ import annotations

from dataclasses import dataclass

from logo_render import Cdp, render_svg_logo
from page_logo import RenderedLogo
from page_styles import PageStyles, logo_candidate

from shared import design_icons, design_logo
from shared.logging import logger


@dataclass(frozen=True)
class RasterLogo:
    """The raster candidate as read in the session: its bytes, or its PNG drawn smaller, or neither (and then
    the URL that was read and refused, so it is not downloaded again)."""
    downloaded: design_logo.DownloadedLogo | None = None
    rendered: RenderedLogo | None = None
    refused_url: str | None = None


def shrink_raster(cdp: Cdp, data: bytes, content_type: str, *, what: str) -> bytes | None:
    """The raster ``data`` (already downloaded and typed by its bytes) drawn to a PNG of at most 1 MB, or None
    (logged as ``what``). The browser gets a ``data:`` URL, so it never fetches the candidate itself."""
    return render_svg_logo(cdp, design_logo.image_data_url(data, content_type), what=what)


def read_raster_logo(cdp: Cdp, styles: PageStyles, fetch: design_icons.Fetch | None) -> RasterLogo:
    """The page's raster logo candidate, downloaded, or drawn smaller when it is over 1 MB (see the module docstring)."""
    candidate = logo_candidate(styles.logos)
    if candidate is None:
        return RasterLogo()
    url = str(candidate['source_url'])
    try:
        data, content_type = design_logo.fetch_logo(url, fetch, max_bytes=design_logo.RASTER_SHRINK_MAX_BYTES)
    except design_logo.LogoTooLargeError:
        logger.info('Logo candidate not downloaded', extra={'reason': 'over_shrink_cap'})
        return RasterLogo(refused_url=url)
    except design_logo.LogoFetchError as exc:
        logger.info('Logo candidate not downloaded', extra={'reason': str(exc)[:120]})
        return RasterLogo(refused_url=url)
    downloaded = design_logo.DownloadedLogo(url, data, content_type)
    if len(data) <= design_logo.COMPANY_LOGO_MAX_BYTES:
        return RasterLogo(downloaded=downloaded)
    png = shrink_raster(cdp, data, content_type, what='Oversized logo')
    if png:
        return RasterLogo(rendered=RenderedLogo(url, png))
    if len(data) <= design_logo.MAX_LOGO_BYTES:
        return RasterLogo(downloaded=downloaded)
    return RasterLogo(refused_url=url)
