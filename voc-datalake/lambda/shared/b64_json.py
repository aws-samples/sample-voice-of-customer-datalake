"""Opaque base64url-JSON tokens (no padding), the encoding of the read routes' cursors.

``shared.feedback_cursor`` (``/feedback/*`` ``next_token``) and ``shared.radar_reviews``
(the Radar review list ``cursor``) both hand out such a token and read it back; each keeps
its own payload check and its own 400 wording, passed in as ``invalid``.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Mapping

#: The longest token either route reads back; anything longer is refused before decoding.
MAX_TOKEN_CHARS = 1024


def encode_b64_json(payload: Mapping[str, object]) -> str:
    """``payload`` as compact, key-sorted JSON in base64url without padding."""
    raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def decode_b64_json(token: str, invalid: str) -> object:
    """The JSON value of ``token``; ``ValueError(invalid)`` when empty, too long or not base64url JSON."""
    if not token or len(token) > MAX_TOKEN_CHARS:
        raise ValueError(invalid)
    try:
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        return json.loads(raw.decode('utf-8'))
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError(invalid) from exc
