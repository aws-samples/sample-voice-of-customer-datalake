"""The hand-off of a GitHub reference's logo to the managed browser (``voc-design-capture``).

A GitHub reference is read on the settings worker (``voc-settings-assist``), which has no browser. Two logos
are handed over, with ``{action: DESIGN_LOGO_RENDER_ACTION, …}`` (``render_event``):

- an SVG (``github_design.svg_logo_path``, when the repository has no raster logo): the worker reads it through
  the GitHub contents API (the same token-aware path as the design files, so a private repository works),
  rebuilds it deny-by-default (``shared.design_svg.sanitize_svg``) and sends the sanitised markup
  (``{kind: 'svg', svg, path, source_url, ref_id, fetched_at}``; an event without ``kind`` is an SVG one);
- a RASTER logo over the company-logo cap (``COMPANY_LOGO_MAX_BYTES``, 1 MB; ``github_raster_preview``): the
  worker's own preview download (anonymous, the SSRF guard, ≤ 2 MB) shows it is too large to be the company
  logo, so it sends only the raw GitHub URL (``{kind: 'raster', path, source_url, ref_id, fetched_at}``), never
  the bytes. A download ≤ 2 MB is still stored as a plain preview meanwhile, so the admin sees it. A private
  repository's raw URL fails anonymously here, as before: no preview and no hand-off.

Either way the reference is recorded as ready first. The capture worker (``lambda/design_capture/logo_job.py``)
checks the event again (``parse_render_event``: a raster URL must be https, ≤ 2,048 chars and pass the URL
policy), draws the logo as an ``<img>`` from a ``data:`` URL in a fresh ``about:blank`` tab (an SVG sanitised
again; a raster downloaded ONCE through the SSRF guard, ≤ 5 MB, typed by its bytes, so the browser fetches
nothing), stores ONLY the PNG as the reference's preview and sets ``extracted_design.logo`` to the rendered
logo, on condition that the reference is still ``ready`` with the same ``fetched_at`` (a refresh or an archive
in between wins, and the stale render is dropped). When it cannot be drawn, the same conditional write appends
``render_failed_note`` to the guidelines instead, so the admin learns to upload a PNG.

The settings role already may invoke the capture worker (it starts website references); the capture
role already may UpdateItem the design-system partition and PutObject the preview keys. No new IAM.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import unquote, urlparse

from shared import design_logo
from shared.company_context import MAX_GUIDELINES_CHARS
from shared.design_logo import REF_ID_RE
from shared.logging import logger
from shared.prompt_safety import neutralise_tags
from shared.url_policy import validate_url

DESIGN_LOGO_RENDER_ACTION: Final = 'design_logo_render'
MAX_PATH_CHARS: Final = 200
MAX_SOURCE_URL_CHARS: Final = 2_048
SVG_KIND: Final = 'svg'
RASTER_KIND: Final = 'raster'


@dataclass(frozen=True)
class SvgLogo:
    """A repository's SVG logo, sanitised, and where it came from."""
    path: str
    source_url: str
    svg: str


@dataclass(frozen=True)
class RasterLogo:
    """A repository's raster logo too large to be the company logo: its file name and raw URL (never its bytes)."""
    path: str
    source_url: str


@dataclass(frozen=True)
class RenderRequest:
    """A validated ``design_logo_render`` event."""
    ref_id: str
    logo: SvgLogo | RasterLogo
    fetched_at: str


def render_event(ref_id: str, logo: SvgLogo | RasterLogo, fetched_at: str) -> dict:
    """The async event the settings worker sends ``voc-design-capture``."""
    event = {'action': DESIGN_LOGO_RENDER_ACTION, 'ref_id': ref_id, 'path': logo.path,
             'source_url': logo.source_url, 'fetched_at': fetched_at}
    if isinstance(logo, SvgLogo):
        return {**event, 'kind': SVG_KIND, 'svg': logo.svg}
    return {**event, 'kind': RASTER_KIND}


def _logo_of(event: dict, path: str, source_url: str) -> SvgLogo | RasterLogo | None:
    kind = event.get('kind', SVG_KIND)
    if kind == RASTER_KIND:
        return RasterLogo(path, source_url) if validate_url(source_url)[0] else None
    svg = event.get('svg')
    return SvgLogo(path, source_url, svg) if kind == SVG_KIND and isinstance(svg, str) and svg else None


def parse_render_event(event: object) -> RenderRequest | None:
    """The event's fields, checked (the capture worker trusts nothing it is sent); None when malformed."""
    if not isinstance(event, dict) or event.get('action') != DESIGN_LOGO_RENDER_ACTION:
        return None
    ref_id, path = event.get('ref_id'), event.get('path')
    source_url, fetched_at = event.get('source_url'), event.get('fetched_at')
    if not (isinstance(ref_id, str) and REF_ID_RE.fullmatch(ref_id)):
        return None
    if not (isinstance(fetched_at, str) and fetched_at):
        return None
    if not (isinstance(path, str) and 0 < len(path) <= MAX_PATH_CHARS):
        return None
    if not (isinstance(source_url, str) and source_url.startswith('https://')
            and len(source_url) <= MAX_SOURCE_URL_CHARS):
        return None
    logo = _logo_of(event, path, source_url)
    return RenderRequest(ref_id, logo, fetched_at) if logo else None


def with_note(guidelines: object, note: str) -> str:
    """``guidelines`` with ``note`` appended as its last section, within the stored guidelines limit
    (the guidelines are cut, never the note)."""
    body = str(guidelines or '').strip()
    room = MAX_GUIDELINES_CHARS - len(note) - 2
    return '\n\n'.join(p for p in (body[:max(room, 0)].strip(), note) if p)[:MAX_GUIDELINES_CHARS]


def render_failed_note(logo: SvgLogo | RasterLogo) -> str:
    """The guidelines note when the repository's logo could not be drawn to a PNG (or the hand-off of a raster
    one could not start)."""
    path = neutralise_tags(logo.path)[:MAX_PATH_CHARS]
    if isinstance(logo, RasterLogo):
        cap = f'{design_logo.COMPANY_LOGO_MAX_BYTES // 1_000_000} MB'
        return (f'## Logo\n\nThe repository\'s logo (`{path}`) is larger than {cap}, the most the company logo can '
                f'be, and could not be drawn smaller. Upload a PNG under {cap} as the company logo (the web app '
                'makes a larger image smaller before it uploads).')
    return (f'## Logo\n\nThe repository\'s logo is an SVG (`{path}`) that could '
            'not be drawn to a PNG (it may use features the safe renderer removes). Upload a PNG, JPEG or WebP '
            'export of it as the company logo.')


def _raster(url: str) -> RasterLogo:
    """The hand-off of the raster at ``url``, named by its file name (the note's path)."""
    name = unquote(urlparse(url).path.rsplit('/', 1)[-1])
    return RasterLogo(name[:MAX_PATH_CHARS] or 'logo', url)


def github_raster_preview(design: dict | None, ref_id: str, s3: Any, bucket: str,
                          fetch: Callable[..., Any] | None = None) -> tuple[dict | None, RasterLogo | None]:
    """A GitHub reference's design with its raster logo's preview stored (``design_logo.store_preview``), plus the
    logo to hand to the browser when its download is over the company-logo cap, else None.

    For a settings worker with a browser to hand off to. The candidate is downloaded ONCE (≤ 2 MB): ≤ 1 MB it is
    the preview, as before; 1-2 MB it is the preview AND handed off; over 2 MB (``LogoTooLargeError``) there is no
    preview and it is handed off (the capture worker reads up to 5 MB). Any other refusal (a private repository's
    404, not an image, an unsafe address) is no preview and no hand-off. Never raises.
    """
    logo = design.get('logo') if isinstance(design, dict) else None
    url = logo.get('source_url') if isinstance(logo, dict) else None
    if (not bucket or not isinstance(url, str) or not url.startswith('https://')
            or design_logo.is_rendered(logo or {}, ref_id)):
        return design_logo.store_preview(design, ref_id, s3, bucket, fetch), None
    try:
        data, content_type = design_logo.fetch_logo(url, fetch)
    except design_logo.LogoTooLargeError:
        return design_logo.store_preview(design, ref_id, s3, bucket, fetch, refused_url=url), _raster(url)
    except design_logo.LogoFetchError as exc:
        logger.info('Logo candidate preview skipped', extra={'reason': str(exc)[:120]})
        return design_logo.store_preview(design, ref_id, s3, bucket, fetch, refused_url=url), None
    stored = design_logo.store_preview(design, ref_id, s3, bucket, fetch,
                                       design_logo.DownloadedLogo(url, data, content_type))
    over_cap = len(data) > design_logo.COMPANY_LOGO_MAX_BYTES
    return stored, _raster(url) if over_cap else None
