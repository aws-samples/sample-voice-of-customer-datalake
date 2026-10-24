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
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

import requests
from botocore.exceptions import BotoCoreError, ClientError

from shared.extracted_design import LOGO_PREVIEW_PREFIX
from shared.http_utils import UnsafeURLError, fetch_public_url
from shared.logging import logger

MAX_LOGO_BYTES = 2_000_000
LOGO_TIMEOUT_SECONDS = 10
LOGO_MAX_REDIRECTS = 3
HTTP_OK = 200
LOGO_EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}
_REF_ID_RE = re.compile(r'^ref_[0-9a-f]{12}\Z')


class LogoFetchError(ValueError):
    """A user-safe reason the candidate could not be used."""


def sniff_image_type(data: bytes) -> str | None:
    """``image/png`` / ``image/jpeg`` / ``image/webp`` from the magic bytes, else None."""
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
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


def store_preview(design: dict | None, ref_id: str, s3: Any, bucket: str,
                  fetch: Callable[..., requests.Response] | None = None) -> dict | None:
    """``design`` with ``logo.preview_key`` set when its candidate downloaded and was stored, else unchanged.

    Never raises: a refused, missing, oversized or non-raster candidate (or an S3 failure) only
    means there is no preview. An earlier ``preview_key`` is dropped first, so a stale image is
    never shown for a new candidate.
    """
    logo = design.get('logo') if isinstance(design, dict) else None
    if not isinstance(design, dict) or not isinstance(logo, dict):
        return design
    logo = {k: v for k, v in logo.items() if k != 'preview_key'}
    without = {**design, 'logo': logo}
    url = logo.get('source_url')
    if not bucket or not isinstance(url, str) or not _REF_ID_RE.fullmatch(ref_id):
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
