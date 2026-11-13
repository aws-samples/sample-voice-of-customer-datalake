"""The company logo (Company → Design system) as an image a prototype can carry.

The logo an admin uploads is stored privately in the raw bucket
(``company-context/design/logo_<id>.<png|jpg|webp>``, keys on the ``SETTINGS#design_system`` /
``config`` row; ``api/settings_handler.py`` writes them). A prototype is one offline HTML file
whose CSP allows ``img-src data:`` only (``lib/utils/prototype-csp.ts``), so the logo reaches it
as a ``data:`` URL.

The model never sees the image bytes: the prompt names a placeholder (``LOGO_PLACEHOLDER``) and
``inline_logo`` swaps it for the ``data:`` URL in the HTML the model returns. Before a revision
sends the prior prototype back to the model, ``with_logo_placeholder`` turns the inlined image
back into the placeholder, so the prior-HTML budget is spent on markup, not base64.

Reads only, and never raises: a missing, oversized or unreadable logo means no logo — the
prototype is built as before, with a wordmark the model draws.
"""
from __future__ import annotations

import base64
import re
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.design_assets import DESIGN_PREFIX
from shared.design_logo import sniff_image_type
from shared.logging import logger

#: The row attribute holding the current logo's object key.
LOGO_KEY_ATTR = 'logo_s3_key'
#: A new upload's key until GET /settings/design-system sees its object and promotes it.
LOGO_PENDING_KEY_ATTR = 'logo_pending_s3_key'
#: Every logo object key starts with this (company_context.new_id('logo') → logo_…).
LOGO_KEY_PREFIX = DESIGN_PREFIX + 'logo_'
#: The largest logo inlined into a prototype. Uploads may be 5 MB; a prototype carrying that
#: much base64 would be slow to open, so a larger logo is left out (and logged).
MAX_INLINE_LOGO_BYTES = 1_000_000
#: What the prompt tells the model to write as the logo's ``src``.
LOGO_PLACEHOLDER = '__COMPANY_LOGO__'
#: The 1x1 transparent GIF a leftover placeholder becomes when there is no logo to inline.
BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
#: An inlined raster image long enough to be the logo (a model-drawn icon is far shorter).
_INLINED_IMAGE_RE = re.compile(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]{2000,}={0,2}')

LOGO_INSTRUCTION = (
    f'COMPANY LOGO: the company has its own logo. Wherever the prototype shows the company logo or '
    f'wordmark (header, splash, sign-in, footer), use exactly <img src="{LOGO_PLACEHOLDER}" '
    'alt="Company logo"> sized by height only (24-40px in a header, larger on a splash), never '
    'stretched. Do not draw, recreate or replace the logo, and do not use the placeholder for '
    'anything else. This replaces the inline-SVG wordmark rule for the company logo only.'
)


def _logo_key(value: object) -> str | None:
    return value if isinstance(value, str) and value.startswith(LOGO_KEY_PREFIX) else None


def logo_keys(row: dict | None) -> list[str]:
    """The keys to try, newest first: a pending upload (it may have landed), then the current logo."""
    row = row or {}
    keys = [_logo_key(row.get(LOGO_PENDING_KEY_ATTR)), _logo_key(row.get(LOGO_KEY_ATTR))]
    return list(dict.fromkeys(key for key in keys if key))


def _read_logo(s3: Any, bucket: str, key: str) -> bytes | None:
    """The object's bytes when it exists and fits ``MAX_INLINE_LOGO_BYTES``, else None."""
    try:
        response = s3.get_object(Bucket=bucket, Key=key, Range=f'bytes=0-{MAX_INLINE_LOGO_BYTES}')
        data = response['Body'].read(MAX_INLINE_LOGO_BYTES + 1)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') not in {'NoSuchKey', '404'}:
            logger.warning('Company logo not readable', extra={'error_type': type(error).__name__})
        return None
    except BotoCoreError as error:
        logger.warning('Company logo not readable', extra={'error_type': type(error).__name__})
        return None
    if len(data) > MAX_INLINE_LOGO_BYTES:
        logger.info('Company logo too large to inline in a prototype',
                    extra={'max_bytes': MAX_INLINE_LOGO_BYTES})
        return None
    return data


def company_logo_data_url(row: dict | None, s3: Any, bucket: str) -> str | None:
    """The company logo as a ``data:`` URL, or None when there is none to use.

    ``row`` is the design-system ``config`` row. The type comes from the bytes (PNG, JPEG or
    WebP), never from the key's extension. The first key whose object exists decides: a pending
    upload that landed wins, like it does on the next GET.
    """
    if not bucket:
        return None
    for key in logo_keys(row):
        data = _read_logo(s3, bucket, key)
        if data is None:
            continue
        content_type = sniff_image_type(data)
        if content_type is None:
            logger.warning('Company logo is not a PNG, JPEG or WebP image; left out of the prototype')
            return None
        return f'data:{content_type};base64,{base64.b64encode(data).decode("ascii")}'
    return None


def inline_logo(html: str, data_url: str | None) -> str:
    """``html`` with every placeholder replaced by the logo (a blank image when there is none)."""
    return html.replace(LOGO_PLACEHOLDER, data_url or BLANK_IMAGE)


def with_logo_placeholder(html: str) -> str:
    """``html`` with each inlined logo-sized image turned back into the placeholder."""
    return _INLINED_IMAGE_RE.sub(LOGO_PLACEHOLDER, html)
