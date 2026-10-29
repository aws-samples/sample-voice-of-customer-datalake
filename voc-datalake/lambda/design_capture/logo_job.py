"""Draw a GitHub reference's SVG logo to a PNG (``{action: 'design_logo_render', …}``, see shared.design_logo_render).

The settings worker read the repository's SVG through the GitHub API, sanitised it and recorded the
reference as ready WITHOUT a logo; this job, on ``voc-design-capture`` (the only function with a browser):

1. checks the event (``parse_render_event``) and that the reference is still ``ready`` with the SAME
   ``fetched_at`` and an ``extracted_design`` map — a refresh or an archive since then means the render is
   stale and nothing is done;
2. sanitises the markup AGAIN (``shared.design_svg``: the event crossed a boundary);
3. opens one managed-browser session (``LOGO_SESSION_SECONDS``) and draws the SVG as an ``<img>`` from a
   ``data:`` URL in a fresh ``about:blank`` tab (``logo_render.render_svg_logo``, the same path as a website's
   SVG logo: one PNG screenshot, checked by its bytes);
4. stores the PNG as the reference's preview and the sanitised SVG beside it, download-only
   (``design_logo.store_rendered``), and sets ``extracted_design.logo`` to ``{source_url: <the raw GitHub URL>,
   content_type: image/png, rendered: true, preview_key, svg_preview_key?}``; when it could not be drawn or
   stored, appends ``render_failed_note`` to the guidelines
   instead. Both writes are conditional on step 1's state (``ready`` and the same ``fetched_at``).

Never raises for a render problem: the reference is already usable without a logo.
"""
from __future__ import annotations

from typing import Any, Final

from botocore.exceptions import ClientError
from capture_worker import BrowserKit
from logo_render import render_svg_logo

from shared import company_context, design_logo, design_svg
from shared.design_logo_render import RenderRequest, parse_render_event, render_failed_note, with_note
from shared.logging import logger

#: One SVG in a blank tab: far less than a page capture's 120 s.
LOGO_SESSION_SECONDS: Final = 60


def _current(table: Any, request: RenderRequest) -> dict | None:
    """The reference's ``extracted_design`` when the render still applies (ready, same read), else None."""
    item = company_context.get_reference(table, request.ref_id)
    design = item.get('extracted_design') if item else None
    if not item or item.get('status') != 'ready' or item.get('fetched_at') != request.fetched_at:
        return None
    return design if isinstance(design, dict) else None


def _draw(kit: BrowserKit, svg: str) -> tuple[bytes, str] | None:
    """``(png, sanitised svg)`` the browser drew from the (re-sanitised) SVG, or None (logged with a short reason)."""
    try:
        clean = design_svg.sanitize_svg(svg)
    except design_svg.SvgRefused as exc:
        logger.info('GitHub SVG logo not rendered', extra={'reason': str(exc)})
        return None
    try:
        with kit.open_session(LOGO_SESSION_SECONDS) as cdp:
            png = render_svg_logo(cdp, design_svg.svg_data_url(clean))
    except kit.browser_errors as exc:
        logger.info('GitHub SVG logo not rendered', extra={'reason': f'browser_{type(exc).__name__}'})
        return None
    return (png, clean) if png else None


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
        logger.info('Design reference changed before its SVG logo was rendered; result dropped')
        return False
    return True


def run_logo_render(event: dict, table: Any, kit: BrowserKit, s3: Any, bucket: str) -> dict:
    """Render one GitHub reference's SVG logo and record it (or the note) on the reference."""
    request = parse_render_event(event)
    design = _current(table, request) if request else None
    if request is None or design is None:
        logger.info('SVG logo render skipped (malformed, archived, refreshed or not ready)')
        return {'status': 'skipped'}
    drawn = _draw(kit, request.logo.svg)
    stored = (design_logo.store_rendered(request.logo.source_url, drawn[0], request.ref_id, s3, bucket, drawn[1])
              if drawn else None)
    if stored is not None:
        written = _write(table, request, 'logo', stored)
        status = 'rendered'
    else:
        note = render_failed_note(request.logo.path)
        written = _write(table, request, 'guidelines_md', with_note(design.get('guidelines_md'), note))
        status = 'not_rendered'
    logger.info('SVG logo render finished', extra={'status': status, 'ref_id': request.ref_id, 'written': written})
    return {'status': status if written else 'skipped'}
