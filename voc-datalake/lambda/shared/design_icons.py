"""Copy a website reference's icons into the private bucket, so nothing the design shows is hotlinked.

The capture worker (``lambda/design_capture``) hands over the page's icon references (favicons,
apple-touch icons, ``<link rel=icon>`` sizes, the web-manifest icons, ``og:image`` when it is the logo
candidate). Here, for each in order, until ``MAX_ICON_FILES`` objects are stored or the time budget ends:

- the URL must be https and is fetched through ``shared.http_utils.fetch_public_url`` (the outbound URL
  policy on the URL and every redirect hop, sockets pinned to the vetted address), at most
  ``MAX_ICON_BYTES``;
- its type is decided by its BYTES (``sniff_icon_type``: PNG, JPEG, WebP, GIF, ICO), never by the server's
  Content-Type or the extension; an HTML error page or anything else is skipped;
- an SVG icon is rebuilt deny-by-default (``shared.design_svg``) and drawn to a PNG by the managed browser
  (the caller's ``draw_svg``, the same render as the logo); both are kept, the SVG as a download-only
  object (``shared.design_assets``). When it cannot be sanitised or drawn it is skipped;
- identical files are kept once (SHA-256 of the fetched bytes), under
  ``company-context/design/icons_<ref id>/<digest>.<ext>`` — a refresh of unchanged icons overwrites the
  same keys.

The stored design records ``{kind, sizes, content_type, key, source_url, svg_key?}`` per icon
(``source_url`` is provenance only); ``GET /settings/design-system`` swaps the keys for signed URLs
(``shared.design_assets.with_asset_urls``). Archiving the reference deletes every object under its icon
folder (``stored_icon_keys`` lists it, ``design_logo.delete_previews`` deletes). Font files are never copied
(their licences rarely allow it): the design keeps font family names only.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urljoin

import requests
from botocore.exceptions import BotoCoreError, ClientError

from shared import design_assets, design_logo, design_svg
from shared.extracted_design import ICONS_PREFIX
from shared.http_utils import UnsafeURLError, fetch_public_url
from shared.logging import logger

MAX_ICON_FILES: Final = 12
MAX_ICON_BYTES: Final = 2_000_000
#: Icon URLs tried at most (declared links, manifest icons, og:image, /favicon.ico), before any download.
MAX_ICON_CANDIDATES: Final = 16
#: SVG icons drawn at most (each is one short browser render).
MAX_SVG_ICON_RENDERS: Final = 2
MAX_MANIFEST_BYTES: Final = 100_000
MAX_MANIFEST_ICONS: Final = 8
ICON_TIMEOUT_SECONDS: Final = 5
ICON_MAX_REDIRECTS: Final = 3
HTTP_OK: Final = 200
ICO_TYPE: Final = 'image/x-icon'
PNG_TYPE: Final = design_logo.PNG_TYPE
ICON_EXTENSIONS: Final = {PNG_TYPE: 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
                          ICO_TYPE: 'ico'}
ICON_KINDS: Final = ('icon', 'touch-icon', 'mask-icon', 'manifest', 'og-image', 'favicon')
_SIZES_RE: Final = re.compile(r'^(any|\d{1,4}x\d{1,4})( \d{1,4}x\d{1,4}){0,7}\Z')
_DIGEST_CHARS: Final = 16
_SVG_SNIFF_BYTES: Final = 2_048
_PNG_SIZE_OFFSET: Final = 16
_PNG_SIZE_END: Final = 24

Fetch = Callable[..., requests.Response]


@dataclass(frozen=True)
class IconRef:
    """One icon the page names: its absolute URL, what named it (``ICON_KINDS``) and the declared sizes."""
    url: str
    kind: str
    sizes: str = ''


@dataclass(frozen=True)
class FetchedIcon:
    """A downloaded icon: the raster bytes to store (an SVG's drawn PNG), their type, and the sanitised SVG."""
    ref: IconRef
    data: bytes
    content_type: str
    digest: str
    svg: str | None = None

    @property
    def files(self) -> int:
        return 2 if self.svg else 1


def _is_ico(data: bytes) -> bool:
    return len(data) >= 6 and data[:4] == b'\x00\x00\x01\x00' and struct.unpack('<H', data[4:6])[0] > 0


def _looks_like_svg(data: bytes) -> bool:
    head = data[:_SVG_SNIFF_BYTES].lstrip(b'\xef\xbb\xbf \t\r\n').lower()
    return head.startswith((b'<svg', b'<?xml', b'<!--')) and b'<svg' in head


def sniff_icon_type(data: bytes) -> str | None:
    """The icon's type from its first bytes (PNG, JPEG, WebP, GIF, ICO, or ``image/svg+xml``), else None."""
    raster = design_logo.sniff_image_type(data)
    if raster:
        return raster
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if _is_ico(data):
        return ICO_TYPE
    return design_assets.SVG_TYPE if _looks_like_svg(data) else None


def clean_sizes(value: object) -> str:
    """A ``sizes`` attribute value (``32x32``, ``16x16 32x32``, ``any``), '' when it is anything else."""
    text = ' '.join(str(value).lower().split()) if isinstance(value, str) else ''
    return text if _SIZES_RE.match(text) else ''


def _png_size(data: bytes) -> str:
    if design_logo.sniff_image_type(data) != PNG_TYPE or len(data) < _PNG_SIZE_END:
        return ''
    width, height = struct.unpack('>II', data[_PNG_SIZE_OFFSET:_PNG_SIZE_END])
    return clean_sizes(f'{width}x{height}')


def fetch_bytes(url: str, fetch: Fetch | None, max_bytes: int) -> bytes | None:
    """The body at ``url`` (https, through the SSRF-guarded fetch), or None (refused, failed, not 200, too large)."""
    if not url.startswith('https://'):
        return None
    try:
        response = (fetch or fetch_public_url)(url, timeout=ICON_TIMEOUT_SECONDS, max_redirects=ICON_MAX_REDIRECTS,
                                               max_bytes=max_bytes + 1)
    except UnsafeURLError:
        logger.info('Icon skipped', extra={'reason': 'url_not_allowed'})
        return None
    except requests.exceptions.RequestException as exc:
        logger.info('Icon skipped', extra={'reason': f'fetch_{type(exc).__name__}'})
        return None
    data = response.content if response.status_code == HTTP_OK else b''
    return data if 0 < len(data) <= max_bytes else None


def manifest_refs(url: str, fetch: Fetch | None) -> list[IconRef]:
    """The icons a web manifest lists (``icons[].src`` resolved against the manifest's URL), at most eight."""
    body = fetch_bytes(url, fetch, MAX_MANIFEST_BYTES) if url else None
    try:
        manifest = json.loads(body) if body else {}
    except ValueError:
        return []
    icons = manifest.get('icons') if isinstance(manifest, dict) else None
    refs = []
    for icon in icons if isinstance(icons, list) else []:
        src = icon.get('src') if isinstance(icon, dict) else None
        if isinstance(src, str) and src.strip():
            refs.append(IconRef(urljoin(url, src.strip()), 'manifest', clean_sizes(icon.get('sizes'))))
        if len(refs) == MAX_MANIFEST_ICONS:
            break
    return refs


@dataclass
class IconCopy:
    """The collaborators of ``fetch_icons``: the fetch, the browser render of an SVG and the time budget."""
    draw_svg: Callable[[str], bytes | None]
    within_budget: Callable[[], bool]
    fetch: Fetch | None = None
    svg_renders: int = 0


def _drawn(data: bytes, copy: IconCopy) -> tuple[bytes, str] | None:
    """``(png, sanitised svg)`` for an SVG icon, or None when it is refused, over the render cap or not drawn."""
    if copy.svg_renders >= MAX_SVG_ICON_RENDERS:
        return None
    try:
        svg = design_svg.sanitize_svg(data)
    except design_svg.SvgRefused as exc:
        logger.info('SVG icon skipped', extra={'reason': str(exc)})
        return None
    copy.svg_renders += 1
    png = copy.draw_svg(design_svg.svg_data_url(svg))
    return (png, svg) if png else None


def _fetched(ref: IconRef, copy: IconCopy) -> FetchedIcon | None:
    data = fetch_bytes(ref.url, copy.fetch, MAX_ICON_BYTES)
    content_type = sniff_icon_type(data) if data else None
    if data is None or content_type is None:
        return None
    digest = hashlib.sha256(data).hexdigest()[:_DIGEST_CHARS]
    if content_type != design_assets.SVG_TYPE:
        return FetchedIcon(ref, data, content_type, digest)
    drawn = _drawn(data, copy)
    return FetchedIcon(ref, drawn[0], PNG_TYPE, digest, svg=drawn[1]) if drawn else None


def _unique(refs: Sequence[IconRef]) -> list[IconRef]:
    seen: set[str] = set()
    out = []
    for ref in refs:
        if ref.url not in seen and ref.kind in ICON_KINDS:
            seen.add(ref.url)
            out.append(ref)
    return out[:MAX_ICON_CANDIDATES]


def fetch_icons(refs: Sequence[IconRef], copy: IconCopy) -> list[FetchedIcon]:
    """The icons to store, in ``refs`` order: deduplicated by content, at most ``MAX_ICON_FILES`` files."""
    icons: list[FetchedIcon] = []
    digests: set[str] = set()
    files = 0
    for ref in _unique(refs):
        if files >= MAX_ICON_FILES or not copy.within_budget():
            break
        icon = _fetched(ref, copy)
        if icon is None or icon.digest in digests or files + icon.files > MAX_ICON_FILES:
            continue
        digests.add(icon.digest)
        files += icon.files
        icons.append(icon)
    return icons


def icon_key(ref_id: str, digest: str, extension: str) -> str:
    return f'{ICONS_PREFIX}{ref_id}/{digest}.{extension}'


def _store_one(icon: FetchedIcon, ref_id: str, s3: Any, bucket: str) -> dict | None:
    key = icon_key(ref_id, icon.digest, ICON_EXTENSIONS[icon.content_type])
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=icon.data, ContentType=icon.content_type)
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Icon not stored: {type(exc).__name__}')
        return None
    entry = {'kind': icon.ref.kind, 'sizes': icon.ref.sizes or _png_size(icon.data),
             'content_type': icon.content_type, 'key': key, 'source_url': icon.ref.url}
    svg_key = icon_key(ref_id, icon.digest, 'svg')
    if icon.svg and design_assets.put_svg(s3, bucket, svg_key, icon.svg):
        entry['svg_key'] = svg_key
    return entry


def store_icons(icons: Sequence[FetchedIcon], ref_id: str, s3: Any, bucket: str) -> list[dict]:
    """Store the fetched icons → their entries for ``extracted_design.icons`` ([] without a bucket). Never raises."""
    if not bucket or not design_logo.REF_ID_RE.fullmatch(ref_id):
        return []
    entries = (_store_one(icon, ref_id, s3, bucket) for icon in icons)
    return [entry for entry in entries if entry is not None]


def stored_icon_keys(s3: Any, bucket: str, ref_id: str) -> list[str]:
    """Every object under the reference's icon folder (orphans of earlier reads too), for the archive's delete.

    ONE ``ListObjectsV2`` page (≤ 1,000 keys; a read stores ≤ 12). ``design_logo.LogoPreviewDeleteError``
    when S3 refuses, so the archive answers 503 and can be repeated.
    """
    if not bucket or not design_logo.REF_ID_RE.fullmatch(ref_id):
        return []
    try:
        answer = s3.list_objects_v2(Bucket=bucket, Prefix=f'{ICONS_PREFIX}{ref_id}/', MaxKeys=design_logo.MAX_DELETE_KEYS)
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Icons not listed: {type(exc).__name__}')
        raise design_logo.LogoPreviewDeleteError(type(exc).__name__) from exc
    contents = answer.get('Contents') if isinstance(answer, dict) else None
    return [str(o['Key']) for o in contents or [] if isinstance(o, dict) and isinstance(o.get('Key'), str)]
