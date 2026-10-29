"""Local copies of a design reference's assets: storing a sanitised SVG, and the signed URLs GET returns.

Everything a reference shows (its logo preview, the sanitised SVG beside it, its icons) is a copy in the
private raw bucket under ``company-context/design/``; the stored design names a remote address only as
provenance (``source_url``). The keys never leave the API: ``with_asset_urls`` swaps each for a
short-lived signed GET.

A sanitised SVG (``shared.design_svg`` output) is still a document type, so it is stored and served so
it can never run as one: the object carries ``Content-Type: image/svg+xml`` AND
``Content-Disposition: attachment``, and its signed URL asks S3 for the same two response headers, so
opening the link downloads the file instead of rendering it. It lives on the bucket's origin, never the
app's, and the SPA offers it only as a download link.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger

SVG_TYPE: Final = 'image/svg+xml'
DESIGN_PREFIX: Final = 'company-context/design/'
#: The object and response headers of every stored SVG (see the module docstring).
SVG_DISPOSITION: Final = 'attachment; filename="logo.svg"'

#: ``sign(key, as_svg_attachment)`` → a signed GET URL.
Signer = Callable[[str, bool], str]


def put_svg(s3: Any, bucket: str, key: str, svg: str) -> bool:
    """Store sanitised SVG markup at ``key`` as a download-only object → whether it was stored. Never raises."""
    if not bucket or not key.startswith(DESIGN_PREFIX) or not key.endswith('.svg') or not svg:
        return False
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=svg.encode('utf-8'), ContentType=SVG_TYPE,
                      ContentDisposition=SVG_DISPOSITION)
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Sanitised SVG not stored: {type(exc).__name__}')
        return False
    return True


def signed_params(bucket: str, key: str, as_svg_attachment: bool) -> dict[str, str]:
    """The ``get_object`` parameters of a signed URL; an SVG one pins the attachment response headers."""
    params = {'Bucket': bucket, 'Key': key}
    if as_svg_attachment:
        params.update(ResponseContentType=SVG_TYPE, ResponseContentDisposition=SVG_DISPOSITION)
    return params


def _local_key(key: object, prefix: str, suffix: str = '') -> str | None:
    if isinstance(key, str) and key.startswith(prefix) and key.endswith(suffix) and '..' not in key:
        return key
    return None


def _logo_view(logo: dict, sign: Signer | None, preview_prefix: str) -> dict:
    shown = {k: v for k, v in logo.items() if k not in ('preview_key', 'svg_preview_key')}
    if sign is None:
        return shown
    preview = _local_key(logo.get('preview_key'), preview_prefix)
    if preview:
        shown['preview_url'] = sign(preview, False)
    svg = _local_key(logo.get('svg_preview_key'), preview_prefix, '.svg')
    if svg:
        shown['svg_preview_url'] = sign(svg, True)
    return shown


def _icon_view(icon: object, sign: Signer, icons_prefix: str) -> dict | None:
    """One icon with signed URLs; None when it has no raster key under the icons prefix."""
    if not isinstance(icon, dict):
        return None
    key = _local_key(icon.get('key'), icons_prefix)
    if key is None or key.endswith('.svg'):
        return None
    shown = {k: v for k, v in icon.items() if k not in ('key', 'svg_key')}
    shown['url'] = sign(key, False)
    svg = _local_key(icon.get('svg_key'), icons_prefix, '.svg')
    if svg:
        shown['svg_url'] = sign(svg, True)
    return shown


def with_asset_urls(reference: dict, sign: Signer | None, *, preview_prefix: str, icons_prefix: str) -> dict:
    """``reference`` with every stored key of its ``extracted_design`` swapped for a signed URL.

    ``logo.preview_key`` → ``logo.preview_url``, ``logo.svg_preview_key`` → ``logo.svg_preview_url``
    (attachment), ``icons[].key`` → ``icons[].url`` and ``icons[].svg_key`` → ``icons[].svg_url``. A key
    outside its prefix is dropped, never signed; without a signer (no bucket) the keys are dropped and
    there are no URLs (and no icons).
    """
    design = reference.get('extracted_design')
    if not isinstance(design, dict):
        return reference
    shown = dict(design)
    logo = design.get('logo')
    if isinstance(logo, dict):
        shown['logo'] = _logo_view(logo, sign, preview_prefix)
    if 'icons' in design:
        shown['icons'] = _icons_view(design.get('icons'), sign, icons_prefix)
    return {**reference, 'extracted_design': shown}


def _icons_view(icons: object, sign: Signer | None, icons_prefix: str) -> list[dict]:
    if sign is None or not isinstance(icons, list):
        return []
    views = (_icon_view(icon, sign, icons_prefix) for icon in icons)
    return [view for view in views if view is not None]
