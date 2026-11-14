"""Draw a GitHub reference's logo to a PNG (``{action: 'design_logo_render', …}``, see shared.design_logo_render).

The settings worker read the repository and recorded the reference as ready WITHOUT a usable logo: its SVG logo
(read through the GitHub API and sanitised), or a raster logo over the 1 MB company-logo cap (only its raw URL is
sent). This job, on ``voc-design-capture`` (the only function with a browser):

1. checks the event (``parse_render_event``) and that the reference is still ``ready`` with the SAME
   ``fetched_at`` and an ``extracted_design`` map — a refresh or an archive since then means the render is
   stale and nothing is done;
2. an SVG: sanitises the markup AGAIN (``shared.design_svg``: the event crossed a boundary); a raster: downloads
   it ONCE through the SSRF-guarded fetch (``design_logo.fetch_logo``: every hop re-checked, ≤
   ``RASTER_SHRINK_MAX_BYTES``, 5 MB) and types it by its bytes (PNG, JPEG or WebP, else nothing is drawn). A
   private repository's raw URL fails here as it does anonymously everywhere: the note, no logo;
3. opens one managed-browser session (``LOGO_SESSION_SECONDS``) and draws it as an ``<img>`` from a ``data:``
   URL in a fresh ``about:blank`` tab (``logo_render.render_svg_logo``, the same path as a website's logo: one
   PNG screenshot, checked by its bytes, at most 1 MB). The browser fetches nothing;
4. stores the PNG as the reference's preview (and an SVG's sanitised markup beside it, download-only)
   (``design_logo.store_rendered``), and sets ``extracted_design.logo`` to ``{source_url: <the raw GitHub URL>,
   content_type: image/png, rendered: true, preview_key, svg_preview_key?}``; when it could not be drawn or
   stored, appends ``render_failed_note`` to the guidelines instead (for a raster: "upload a PNG under 1 MB").
   Both writes are conditional on step 1's state (``ready`` and the same ``fetched_at``).

Never raises for a render problem: the reference is already usable without a logo.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import ClientError
from capture_worker import BrowserKit
from logo_render import Cdp, render_svg_logo
from raster_logo import shrink_raster

from shared import company_context, design_icons, design_logo, design_svg
from shared.design_logo_render import (
    RasterLogo,
    RenderRequest,
    SvgLogo,
    parse_render_event,
    render_failed_note,
    with_note,
)
from shared.logging import logger

#: One logo in a blank tab: far less than a page capture's 120 s.
LOGO_SESSION_SECONDS: Final = 60


def _current(table: Any, request: RenderRequest) -> dict | None:
    """The reference's ``extracted_design`` when the render still applies (ready, same read), else None."""
    item = company_context.get_reference(table, request.ref_id)
    design = item.get('extracted_design') if item else None
    if not item or item.get('status') != 'ready' or item.get('fetched_at') != request.fetched_at:
        return None
    return design if isinstance(design, dict) else None


def _draw_svg(kit: BrowserKit, svg: str) -> tuple[bytes, str] | None:
    """``(png, sanitised svg)`` the browser drew from the (re-sanitised) SVG, or None (logged with a short reason)."""
    try:
        clean = design_svg.sanitize_svg(svg)
    except design_svg.SvgRefused as exc:
        logger.info('GitHub SVG logo not rendered', extra={'reason': str(exc)})
        return None
    png = _in_session(kit, 'GitHub SVG logo', lambda cdp: render_svg_logo(cdp, design_svg.svg_data_url(clean)))
    return (png, clean) if png else None


def _in_session(kit: BrowserKit, what: str, draw: Callable[[Cdp], bytes | None]) -> bytes | None:
    """``draw`` in one managed-browser session, or None when the browser itself fails (logged as ``what``)."""
    try:
        with kit.open_session(LOGO_SESSION_SECONDS) as cdp:
            return draw(cdp)
    except kit.browser_errors as exc:
        logger.info(f'{what} not rendered', extra={'reason': f'browser_{type(exc).__name__}'})
        return None


def _draw_raster(kit: BrowserKit, url: str, fetch: design_icons.Fetch | None) -> tuple[bytes, None] | None:
    """``(png, None)`` the browser drew from the raster's own bytes (one guarded download), or None (logged)."""
    try:
        data, content_type = design_logo.fetch_logo(url, fetch, max_bytes=design_logo.RASTER_SHRINK_MAX_BYTES)
    except design_logo.LogoTooLargeError:
        logger.info('GitHub raster logo not rendered', extra={'reason': 'over_shrink_cap'})
        return None
    except design_logo.LogoFetchError as exc:
        logger.info('GitHub raster logo not rendered', extra={'reason': str(exc)[:120]})
        return None
    png = _in_session(kit, 'GitHub raster logo',
                      lambda cdp: shrink_raster(cdp, data, content_type, what='GitHub raster logo'))
    return (png, None) if png else None


def _draw(kit: BrowserKit, logo: SvgLogo | RasterLogo, fetch: design_icons.Fetch | None) -> tuple[bytes, str | None] | None:
    return _draw_svg(kit, logo.svg) if isinstance(logo, SvgLogo) else _draw_raster(kit, logo.source_url, fetch)


def _write(table: Any, request: RenderRequest, attribute: str, value: object) -> bool:
    """``SET extracted_design.<attribute> = value`` while the reference is ready with the same read."""
    try:
        table.update_item(
            Key={'pk': company_context.DESIGN_SYSTEM_PK, 'sk': f'{company_context.REFERENCE_SK_PREFIX}{request.ref_id}'},
            UpdateExpression='SET #d.#a = :v',
            ConditionExpression='#st = :ready AND #f = :f',
            ExpressionAttributeNames={'#d': 'extracted_design', '#a': attribute, '#st': 'status', '#f': 'fetched_at'},
            ExpressionAttributeValues={':v': value, ':ready': 'ready', ':f': request.fetched_at},
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise
        logger.info('Design reference changed before its logo was rendered; result dropped')
        return False
    return True


def run_logo_render(event: dict, table: Any, kit: BrowserKit, s3: Any, bucket: str,
                    fetch: design_icons.Fetch | None = None) -> dict:
    """Render one GitHub reference's logo and record it (or the note) on the reference.

    ``fetch`` is the raster download (None = ``shared.http_utils.fetch_public_url``, the SSRF-guarded fetch).
    """
    request = parse_render_event(event)
    design = _current(table, request) if request else None
    if request is None or design is None:
        logger.info('Logo render skipped (malformed, archived, refreshed or not ready)')
        return {'status': 'skipped'}
    drawn = _draw(kit, request.logo, fetch)
    stored = (design_logo.store_rendered(request.logo.source_url, drawn[0], request.ref_id, s3, bucket, drawn[1])
              if drawn else None)
    if stored is not None:
        written = _write(table, request, 'logo', stored)
        status = 'rendered'
    else:
        note = render_failed_note(request.logo)
        written = _write(table, request, 'guidelines_md', with_note(design.get('guidelines_md'), note))
        status = 'not_rendered'
    logger.info('Logo render finished', extra={'status': status, 'ref_id': request.ref_id, 'written': written})
    return {'status': status if written else 'skipped'}
