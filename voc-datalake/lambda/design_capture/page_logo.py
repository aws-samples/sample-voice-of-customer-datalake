"""A captured page's logo, read inside the browser session once the pick (``logo_pick``) named it.

``read_page_logo`` runs in the session, after the page was read and photographed:

- a picked CANDIDATE (``page_logo_candidates``) is photographed alone in the page tab (``logo_isolate``): the PNG is
  exactly what the page draws, whatever the element is. Beside it, an SVG copy is kept when there is one: an inline
  ``<svg>`` serialised in the page (``page_inline_logo``), or an ``<img>`` / CSS background whose file is an ``.svg``,
  downloaded once through the SSRF-guarded fetch (≤ 1 MB, an SVG by its bytes); either is rebuilt deny-by-default
  (``shared.design_svg``) before it is kept, download-only;
- when the element cannot be photographed alone (it left the page, or the page navigated away from a public
  address) and it is an ``<img>``, its own file is used instead: an SVG drawn as an ``<img>`` in a fresh tab
  (``logo_render``), a raster downloaded (``raster_logo``, drawn smaller when over 1 MB). A CSS background is never
  downloaded: it may be a sprite of many images;
- a picked ``<head>`` icon (no logo on screen) is read like a raster ``<img>``.

``stored_logo`` then stores the PNG as the preview and the SVG as a download-only object
(``design_logo.store_rendered`` → ``shared.design_assets.put_svg``). The model reads the PNG only.
A failure anywhere means no SVG copy, or no logo, never no capture.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final
from urllib.parse import urlparse

from logo_isolate import PageTab, isolate_logo, origin_of
from logo_pick import LogoPick
from logo_render import Cdp, render_svg_logo
from page_inline_logo import inline_svg_expression, parse_inline_logo
from page_logo_candidates import (
    TOP_PX,
    LogoCandidate,
    LogoCandidates,
    candidates_expression,
    clear_marks_expression,
    mark_expression,
    parse_candidates,
)
from page_shots import photograph
from raster_logo import read_raster_logo
from rendered_logo import RenderedLogo

from shared import design_assets, design_icons, design_logo, design_svg
from shared.design_vision import PageShot
from shared.llm_json import json_object_or_none
from shared.logging import logger

#: The marked photo covers the candidates' band (``TOP_PX``) plus room for the boxes that start near its end.
MARKED_HEADER_PX: Final = TOP_PX + 80
MARKED_MIN_PX: Final = 16
#: How far a re-listed candidate may have moved and still be the picked one.
RESTASH_SLACK_PX: Final = 4


@dataclass(frozen=True)
class PageLogo:
    """What the session read of the logo: a PNG the browser drew (``rendered``), or a raster file downloaded
    (``downloaded``, stored after the vision call), or the URL of one it read and refused (never fetched again);
    and how it was picked (``logo_pick``: ``picked_by``, and the ``pick_model`` that answered)."""
    rendered: RenderedLogo | None = None
    downloaded: design_logo.DownloadedLogo | None = None
    refused_url: str | None = None
    picked_by: str = ''
    pick_model: str | None = None


def _pixels(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < MARKED_MIN_PX:
        return None
    return float(value)


def marked_header(tab: PageTab, found: LogoCandidates) -> PageShot | None:
    """The top of the page photographed with every candidate outlined and numbered (``MARK_JS``) for the pick, the
    marks removed again; None without candidates or when the photo fails (the pick then reads the list only)."""
    if not found.candidates:
        return None
    try:
        tab.evaluate("window.scrollTo({ top: 0, left: 0, behavior: 'instant' })")
        tab.evaluate(mark_expression())
        width, height = _pixels(tab.evaluate('innerWidth')), _pixels(tab.evaluate('innerHeight'))
        if width is None or height is None:
            return None
        return photograph(tab, 'header', 0, width, min(height, float(MARKED_HEADER_PX)))
    except Exception as exc:  # noqa: BLE001 - a CDP error: the pick reads the list only
        logger.info('Logo candidates not photographed', extra={'reason': type(exc).__name__})
        return None
    finally:
        try:
            tab.evaluate(clear_marks_expression())
        except Exception:  # noqa: BLE001 - the marks only matter for the photos; the design shots follow
            logger.info('Logo marks not cleared')


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


def _is_svg_file(url: str | None) -> bool:
    return isinstance(url, str) and url.startswith('https://') and urlparse(url).path.lower().endswith('.svg')


def _svg_copy(tab: PageTab, candidate: LogoCandidate, fetch: design_icons.Fetch | None) -> str | None:
    """The picked element's SVG copy, sanitised, or None (never raises: the copy is optional)."""
    try:
        if candidate.kind == 'inline-svg':
            inline = parse_inline_logo(tab.evaluate(inline_svg_expression(candidate.n)))
            return _sanitised(inline.markup, (inline.width, inline.height)) if inline is not None else None
        if candidate.kind == 'img' and _is_svg_file(candidate.url):
            return downloaded_svg(str(candidate.url), fetch)
    except Exception as exc:  # noqa: BLE001 - a CDP error or a timeout: no SVG copy, the PNG is still read
        logger.info('SVG logo copy not read', extra={'reason': type(exc).__name__})
    return None


def _file_logo(cdp: Cdp, url: str, fetch: design_icons.Fetch | None, svg: str | None) -> PageLogo:
    """The logo read from its own file, always through the SSRF-guarded fetch (every redirect re-checked): an SVG
    downloaded and sanitised, then drawn by the browser from a ``data:`` URL (the browser never fetches the address
    itself), else a raster downloaded (``raster_logo``)."""
    if _is_svg_file(url):
        markup = svg or downloaded_svg(url, fetch)
        png = render_svg_logo(cdp, design_svg.svg_data_url(markup)) if markup else None
        return PageLogo(rendered=RenderedLogo(url, png, markup)) if png else PageLogo()
    raster = read_raster_logo(cdp, url, fetch)
    return PageLogo(rendered=raster.rendered, downloaded=raster.downloaded, refused_url=raster.refused_url)


def _restashed(tab: PageTab, found: LogoCandidates, candidate: LogoCandidate) -> LogoCandidate | None:
    """``candidate`` as the page shows it NOW: the candidates are listed again (a page that re-rendered its
    header replaced the stashed elements) and the one of the same kind at the same place (±4 px) is taken.

    Listing again REPLACES the stash, so the old number then names whatever element holds it now: when nothing
    matches, the answer is unreadable or the tab shows another origin, the answer is None (no photo; the element's
    own file is the fallback). Only a CDP error before the page ran the script leaves the stash, and ``candidate``,
    as they were."""
    try:
        raw = tab.evaluate(candidates_expression())
    except Exception as exc:  # noqa: BLE001 - a CDP error: the first stash is used as it is
        logger.info('Logo candidates not listed again', extra={'reason': type(exc).__name__})
        return candidate
    listed_at = json_object_or_none(raw) or {}
    if origin_of(str(listed_at.get('url') or '')) != origin_of(found.page_url):
        return None
    again = parse_candidates(raw, found.page_url)
    same = [c for c in again.candidates if c.kind == candidate.kind
            and all(abs(a - b) <= RESTASH_SLACK_PX for a, b in ((c.x, candidate.x), (c.y, candidate.y),
                                                                  (c.width, candidate.width), (c.height, candidate.height)))]
    # Two elements in one place (a light and a dark logo): the same number, then the same file, wins.
    current = min(same, key=lambda c: (c.n != candidate.n, c.url != candidate.url), default=None)
    if current is None:
        logger.info('Picked logo not found again', extra={'kind': candidate.kind})
    return current


def _isolated(tab: PageTab, cdp: Cdp, found: LogoCandidates, current: LogoCandidate, svg: str | None) -> PageLogo | None:
    """``current`` (the picked element as the page lists it now) photographed alone; for an inline ``<svg>`` that
    paints nothing alone (it borrows paint from elsewhere in the page), its sanitised copy drawn as an image instead."""
    isolated = isolate_logo(tab, cdp, current.n, found.page_url)
    source = current.url if current.url and current.url.startswith('https://') else found.page_url
    if isolated is not None:
        return PageLogo(rendered=RenderedLogo(source, isolated.png, svg, isolated.backdrop))
    png = render_svg_logo(cdp, design_svg.svg_data_url(svg)) if svg and current.kind == 'inline-svg' else None
    return PageLogo(rendered=RenderedLogo(source, png, svg)) if png else None


def read_page_logo(tab: PageTab, cdp: Cdp, found: LogoCandidates, pick: LogoPick, fetch: design_icons.Fetch | None,
                   *, can_isolate: bool) -> PageLogo:
    """The picked logo as the session reads it (see the module docstring). ``can_isolate`` is False when the page
    tab no longer shows a public https page (it navigated): then only the element's own file is read."""
    candidate = found.by_number(pick.number)
    if candidate is not None:
        current = _restashed(tab, found, candidate) if can_isolate else None
        # The copy and the photo come from the SAME element: the one found again (never a stale stash number).
        svg = _svg_copy(tab, current, fetch) if current is not None else None
        isolated = _isolated(tab, cdp, found, current, svg) if current is not None else None
        if isolated is not None:
            return isolated
        if candidate.kind == 'img' and candidate.url and candidate.url.startswith('https://'):
            return _file_logo(cdp, candidate.url, fetch, svg)
        logger.info('Picked logo not read', extra={'kind': candidate.kind})
        return PageLogo()
    icon = found.head_icon(pick.fallback) if pick.fallback else None
    return _file_logo(cdp, icon.url, fetch, None) if icon is not None else PageLogo()


def stored_logo(design: dict | None, rendered: RenderedLogo | None, ref_id: str, s3: object, bucket: str) -> dict | None:
    """``design`` with the rendered logo stored as its preview (+ the SVG copy) and recorded as its logo
    (``rendered: True``, and the ``backdrop`` a light logo was drawn on), over anything the model proposed.

    Without a rendered logo (or when storing it failed) a ``rendered`` flag is never kept: only this
    worker sets one, so ``store_preview`` downloads the raster logo as before.
    """
    if not isinstance(design, dict):
        return design
    stored = None
    if rendered is not None:
        stored = design_logo.store_rendered(rendered.source_url, rendered.png, ref_id, s3, bucket, rendered.svg)
    if stored is not None and rendered is not None:
        return {**design, 'logo': {**stored, 'backdrop': rendered.backdrop} if rendered.backdrop else stored}
    logo = design.get('logo')
    if isinstance(logo, dict) and 'rendered' in logo:
        return {**design, 'logo': {k: v for k, v in logo.items() if k != 'rendered'}}
    return design
