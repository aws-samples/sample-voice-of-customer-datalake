"""The hand-off of a GitHub reference's SVG logo to the managed browser (``voc-design-capture``).

A GitHub reference is read on the settings worker (``voc-settings-assist``), which has no browser.
When the repository's only logo is an SVG (``github_design.svg_logo_path``), the worker reads it
through the GitHub contents API (the same token-aware path as the design files, so a private
repository works), rebuilds it deny-by-default (``shared.design_svg.sanitize_svg``), records the
reference as ready WITHOUT a logo, and then async-invokes ``voc-design-capture`` with
``{action: DESIGN_LOGO_RENDER_ACTION, ref_id, svg, path, source_url, fetched_at}`` (``render_event``).

The capture worker (``lambda/design_capture/logo_job.py``) sanitises the markup again (it crossed a
boundary), draws it as an ``<img>`` from a ``data:`` URL in a fresh ``about:blank`` tab, stores ONLY
the PNG as the reference's preview and sets ``extracted_design.logo`` to the rendered logo — on
condition that the reference is still ``ready`` with the same ``fetched_at`` (a refresh or an archive
in between wins, and the stale render is dropped). When it cannot be drawn, the same conditional write
appends ``render_failed_note`` to the guidelines instead, so the admin learns to upload a PNG export.

The settings role already may invoke the capture worker (it starts website references); the capture
role already may UpdateItem the design-system partition and PutObject the preview keys. No new IAM.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from shared.company_context import MAX_GUIDELINES_CHARS
from shared.design_logo import REF_ID_RE
from shared.prompt_safety import neutralise_tags

DESIGN_LOGO_RENDER_ACTION: Final = 'design_logo_render'
MAX_PATH_CHARS: Final = 200
MAX_SOURCE_URL_CHARS: Final = 2_048


@dataclass(frozen=True)
class SvgLogo:
    """A repository's SVG logo, sanitised, and where it came from."""
    path: str
    source_url: str
    svg: str


@dataclass(frozen=True)
class RenderRequest:
    """A validated ``design_logo_render`` event."""
    ref_id: str
    logo: SvgLogo
    fetched_at: str


def render_event(ref_id: str, logo: SvgLogo, fetched_at: str) -> dict:
    """The async event the settings worker sends ``voc-design-capture``."""
    return {'action': DESIGN_LOGO_RENDER_ACTION, 'ref_id': ref_id, 'svg': logo.svg, 'path': logo.path,
            'source_url': logo.source_url, 'fetched_at': fetched_at}


def parse_render_event(event: object) -> RenderRequest | None:
    """The event's fields, checked (the capture worker trusts nothing it is sent); None when malformed."""
    if not isinstance(event, dict) or event.get('action') != DESIGN_LOGO_RENDER_ACTION:
        return None
    ref_id, svg, path = event.get('ref_id'), event.get('svg'), event.get('path')
    source_url, fetched_at = event.get('source_url'), event.get('fetched_at')
    if not (isinstance(ref_id, str) and REF_ID_RE.fullmatch(ref_id)):
        return None
    if not (isinstance(svg, str) and svg and isinstance(fetched_at, str) and fetched_at):
        return None
    if not (isinstance(path, str) and 0 < len(path) <= MAX_PATH_CHARS):
        return None
    if not (isinstance(source_url, str) and source_url.startswith('https://')
            and len(source_url) <= MAX_SOURCE_URL_CHARS):
        return None
    return RenderRequest(ref_id, SvgLogo(path, source_url, svg), fetched_at)


def with_note(guidelines: object, note: str) -> str:
    """``guidelines`` with ``note`` appended as its last section, within the stored guidelines limit
    (the guidelines are cut, never the note)."""
    body = str(guidelines or '').strip()
    room = MAX_GUIDELINES_CHARS - len(note) - 2
    return '\n\n'.join(p for p in (body[:max(room, 0)].strip(), note) if p)[:MAX_GUIDELINES_CHARS]


def render_failed_note(path: str) -> str:
    """The guidelines note when the repository's SVG logo could not be drawn to a PNG."""
    return (f'## Logo\n\nThe repository\'s logo is an SVG (`{neutralise_tags(path)[:MAX_PATH_CHARS]}`) that could '
            'not be drawn to a PNG (it may use features the safe renderer removes). Upload a PNG, JPEG or WebP '
            'export of it as the company logo.')
