"""Download a reference's logo CANDIDATE (``POST /settings/design-system/references/{id}/logo``).

The candidate URL came from a web page or a repository, so it is untrusted: https only, and the
fetch goes through ``shared.http_utils.fetch_public_url`` — the SSRF guard (``shared.url_policy``)
on the URL and on EVERY redirect hop, sockets pinned to the vetted address at connect time (no DNS
rebinding), no https→http downgrade, no proxies. The body is read to at most 2 MB, and its type is
decided by its first bytes (PNG, JPEG or WebP), never by the server's Content-Type or the URL's
extension: an SVG (a document that can carry script) or HTML error page is refused.

``store_preview`` runs the same download when a reference is READ (GitHub on the settings worker,
a live website on ``voc-design-capture``) and keeps the image under
``company-context/design/logo_preview_<ref id>.<ext>``, so the reference preview can show the
candidate from the private bucket (``logo.preview_url``, signed like the company logo) without
the browser ever fetching a third-party address. Any failure leaves the preview absent.

An SVG logo is never downloaded here: ``voc-design-capture`` renders it to a PNG in the managed
browser (``lambda/design_capture/logo_render.py``) and ``store_rendered`` keeps that PNG under the same
preview key, with ``rendered: True``, plus the SANITISED SVG beside it (``logo_preview_<ref id>.svg``,
download-only: ``shared.design_assets``); "Use this logo" then copies the stored PNG
(``read_rendered_preview``) instead of downloading the candidate.

Archiving a reference (``DELETE /settings/design-system/references/{id}``) deletes its preview objects
(``delete_previews``; the settings role's only S3 delete, scoped to ``logo_preview_*`` and ``icons_*``).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Any

import requests
from botocore.exceptions import BotoCoreError, ClientError

from shared import design_assets
from shared.extracted_design import LOGO_PREVIEW_PREFIX
from shared.http_utils import UnsafeURLError, fetch_public_url
from shared.logging import logger

MAX_LOGO_BYTES = 2_000_000
LOGO_TIMEOUT_SECONDS = 10
LOGO_MAX_REDIRECTS = 3
HTTP_OK = 200
PNG_TYPE = 'image/png'
LOGO_EXTENSIONS = {PNG_TYPE: 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}
REF_ID_RE = re.compile(r'^ref_[0-9a-f]{12}\Z')
#: S3 DeleteObjects takes at most this many keys in one call.
MAX_DELETE_KEYS = 1_000


class LogoFetchError(ValueError):
    """A user-safe reason the candidate could not be used."""


def sniff_image_type(data: bytes) -> str | None:
    """``image/png`` / ``image/jpeg`` / ``image/webp`` from the magic bytes, else None."""
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return PNG_TYPE
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def fetch_logo(url: str, fetch: Callable[..., requests.Response] | None = None) -> tuple[bytes, str]:
    """``(bytes, content_type)`` of the logo at ``url``; LogoFetchError with the reason otherwise.

    ``fetch`` defaults to ``fetch_public_url`` (looked up at call time, so it can be patched).
    """
    fetch = fetch or fetch_public_url
    if not url.startswith('https://'):
        raise LogoFetchError('The logo address must be https')
    try:
        response = fetch(url, timeout=LOGO_TIMEOUT_SECONDS, max_redirects=LOGO_MAX_REDIRECTS,
                         max_bytes=MAX_LOGO_BYTES + 1)
    except UnsafeURLError as exc:
        raise LogoFetchError('The logo address is not allowed (it points to a private or unsafe location)') from exc
    except requests.exceptions.RequestException as exc:
        raise LogoFetchError('The logo could not be downloaded; try again later') from exc
    if response.status_code != HTTP_OK:
        raise LogoFetchError(f'The logo could not be downloaded (HTTP {response.status_code})')
    data = response.content
    if len(data) > MAX_LOGO_BYTES:
        raise LogoFetchError('The logo is larger than 2 MB')
    content_type = sniff_image_type(data)
    if content_type is None:
        raise LogoFetchError('The logo is not a PNG, JPEG or WebP image')
    return data, content_type


def preview_key(ref_id: str, content_type: str) -> str:
    return f'{LOGO_PREVIEW_PREFIX}{ref_id}.{LOGO_EXTENSIONS[content_type]}'


class LogoPreviewMissing(LookupError):
    """A rendered logo's stored preview is gone (or its key is not a rendered-preview key)."""


def is_rendered(logo: dict, ref_id: str) -> bool:
    """Whether ``logo`` is the browser-rendered PNG of an SVG for THIS reference (its own PNG preview key)."""
    return (logo.get('rendered') is True and bool(REF_ID_RE.fullmatch(ref_id))
            and logo.get('preview_key') == preview_key(ref_id, PNG_TYPE))


def svg_preview_key(ref_id: str) -> str:
    """Where the SANITISED SVG of a rendered logo is kept, beside its PNG (download-only, shared.design_assets)."""
    return f'{LOGO_PREVIEW_PREFIX}{ref_id}.svg'


def store_rendered(source_url: str, png: bytes, ref_id: str, s3: Any, bucket: str,
                   svg: str | None = None) -> dict | None:
    """Store a browser-rendered SVG logo (PNG bytes) as the reference's preview → the logo to record
    ``{source_url, content_type: 'image/png', rendered: True, preview_key, svg_preview_key?}``, or None.

    The bytes are checked again here: a PNG by its magic bytes, at most 2 MB. ``svg`` is the sanitised
    markup (``shared.design_svg`` output) the PNG was drawn from, when there is one: it is stored too, as a
    download-only object (``design_assets.put_svg``); when that fails the PNG is still recorded. Never raises.
    """
    if (not bucket or not REF_ID_RE.fullmatch(ref_id) or not source_url.startswith('https://')
            or sniff_image_type(png) != PNG_TYPE or len(png) > MAX_LOGO_BYTES):
        return None
    key = preview_key(ref_id, PNG_TYPE)
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=png, ContentType=PNG_TYPE)
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Rendered logo preview not stored: {type(exc).__name__}')
        return None
    logo = {'source_url': source_url, 'content_type': PNG_TYPE, 'rendered': True, 'preview_key': key}
    if svg and design_assets.put_svg(s3, bucket, svg_preview_key(ref_id), svg):
        logo['svg_preview_key'] = svg_preview_key(ref_id)
    return logo


def read_rendered_preview(s3: Any, bucket: str, key: object) -> bytes:
    """The stored PNG of a rendered logo ("Use this logo" copies it; the SVG is never downloaded).

    LogoPreviewMissing when the key is not a PNG preview key or the object is gone; LogoFetchError when
    the object is larger than 2 MB or not a PNG by its bytes.
    """
    if not isinstance(key, str) or not key.startswith(LOGO_PREVIEW_PREFIX) or not key.endswith('.png') or '..' in key:
        raise LogoPreviewMissing(key)
    try:
        body = s3.get_object(Bucket=bucket, Key=key)['Body'].read(MAX_LOGO_BYTES + 1)
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') in ('NoSuchKey', '404', 'NotFound'):
            raise LogoPreviewMissing(key) from exc
        raise
    if len(body) > MAX_LOGO_BYTES:
        raise LogoFetchError('The logo is larger than 2 MB')
    if sniff_image_type(body) != PNG_TYPE:
        raise LogoFetchError('The stored logo is not a PNG image; refresh the reference')
    return body


def preview_keys(ref_id: str) -> list[str]:
    """Every key a reference's logo preview can have (one per stored type, and the sanitised SVG), [] for a
    malformed id."""
    if not REF_ID_RE.fullmatch(ref_id):
        return []
    return [*(preview_key(ref_id, content_type) for content_type in LOGO_EXTENSIONS), svg_preview_key(ref_id)]


class LogoPreviewDeleteError(RuntimeError):
    """S3 did not delete every preview object of a reference (the key count is logged, never the keys)."""


def delete_previews(s3: Any, bucket: str, ref_id: str, extra_keys: Sequence[str] = ()) -> int:
    """Delete the reference's logo preview objects (``logo_preview_<ref id>.png|jpg|webp|svg``) and
    ``extra_keys`` (its copied icons, ``shared.design_icons.stored_icon_keys``) → keys asked for.

    ONE ``DeleteObjects`` call (at most 1,000 keys): a key that does not exist is not an error
    (S3 answers it as deleted), so the call is idempotent and safe to repeat. LogoPreviewDeleteError when
    S3 reports a key it could not delete or the call itself fails; nothing for an empty bucket name or a
    malformed id.
    """
    own = preview_keys(ref_id)
    keys = [*own, *extra_keys][:MAX_DELETE_KEYS] if own else []
    if not bucket or not keys:
        return 0
    try:
        answer = s3.delete_objects(Bucket=bucket, Delete={'Objects': [{'Key': k} for k in keys], 'Quiet': True})
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Logo preview not deleted: {type(exc).__name__}')
        raise LogoPreviewDeleteError(type(exc).__name__) from exc
    errors = answer.get('Errors') if isinstance(answer, dict) else None
    if errors:
        logger.warning('Logo preview not deleted', extra={'failed_keys': len(errors)})
        raise LogoPreviewDeleteError('partial')
    return len(keys)


def store_preview(design: dict | None, ref_id: str, s3: Any, bucket: str,
                  fetch: Callable[..., requests.Response] | None = None) -> dict | None:
    """``design`` with ``logo.preview_key`` set when its candidate downloaded and was stored, else unchanged.

    Never raises: a refused, missing, oversized or non-raster candidate (or an S3 failure) only
    means there is no preview. An earlier ``preview_key`` is dropped first, so a stale image is
    never shown for a new candidate. A RENDERED logo (``is_rendered``: the capture worker already stored
    its PNG under this reference's key) is returned untouched — its SVG is never downloaded; a
    ``rendered`` flag anywhere else (e.g. proposed by a model) is dropped like a stale key.
    """
    logo = design.get('logo') if isinstance(design, dict) else None
    if not isinstance(design, dict) or not isinstance(logo, dict):
        return design
    if is_rendered(logo, ref_id):
        return design
    logo = {k: v for k, v in logo.items() if k not in ('preview_key', 'svg_preview_key', 'rendered')}
    without = {**design, 'logo': logo}
    url = logo.get('source_url')
    if not bucket or not isinstance(url, str) or not REF_ID_RE.fullmatch(ref_id):
        return without
    try:
        data, content_type = fetch_logo(url, fetch)
        key = preview_key(ref_id, content_type)
        s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
    except LogoFetchError as exc:
        logger.info('Logo candidate preview skipped', extra={'reason': str(exc)[:120]})
        return without
    except (BotoCoreError, ClientError) as exc:
        logger.warning(f'Logo candidate preview not stored: {type(exc).__name__}')
        return without
    return {**design, 'logo': {**logo, 'preview_key': key}}
