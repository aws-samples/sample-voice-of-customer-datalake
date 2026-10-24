"""Opaque ``next_token`` cursors for the feedback read routes.

Two kinds, both base64url JSON without padding, both refused (``ValueError``, the
route's 400) when tampered with:

- a **key cursor** carries the index key of the last row a page consumed, and is
  read back only into the partition it was issued for (``/feedback/urgent``);
- an **offset cursor** carries how many matches the caller has already received
  (``/feedback/search``, whose candidate window is re-read on every request).

Opaque on purpose: the caller hands the token back unchanged, so its contents can
change without an API change.
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Mapping
from typing import Final

__all__ = ['decode_key_cursor', 'decode_offset_cursor', 'encode_key_cursor', 'encode_offset_cursor']

MAX_CURSOR_CHARS: Final = 1024
_INVALID: Final = 'next_token is not valid'


def _encode(payload: Mapping[str, object]) -> str:
    raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _decode(token: str) -> object:
    if not token or len(token) > MAX_CURSOR_CHARS:
        raise ValueError(_INVALID)
    try:
        raw = base64.urlsafe_b64decode(token + '=' * (-len(token) % 4))
        return json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError(_INVALID) from exc


def encode_key_cursor(key: Mapping[str, str]) -> str:
    """The cursor of one index row's key."""
    return _encode(dict(key))


def decode_key_cursor(token: str, fields: frozenset[str], partition: tuple[str, str]) -> dict[str, str]:
    """A key cursor back to an ExclusiveStartKey with exactly ``fields``, inside ``partition``.

    ``partition`` is ``(attribute, value)``: a cursor naming any other partition is
    refused rather than read, so a token can only resume the read it came from.
    """
    value = _decode(token)
    if not isinstance(value, dict) or frozenset(value) != fields:
        raise ValueError(_INVALID)
    if not all(isinstance(v, str) and v for v in value.values()):
        raise ValueError(_INVALID)
    attribute, expected = partition
    if value[attribute] != expected:
        raise ValueError(_INVALID)
    return {str(k): str(v) for k, v in value.items()}


def encode_offset_cursor(offset: int) -> str:
    """The cursor of the next match a caller has not yet received."""
    return _encode({'o': offset})


def decode_offset_cursor(token: str, max_offset: int) -> int:
    """An offset cursor back to its offset (0..``max_offset``)."""
    value = _decode(token)
    if not isinstance(value, dict) or set(value) != {'o'}:
        raise ValueError(_INVALID)
    offset = value['o']
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= max_offset:
        raise ValueError(_INVALID)
    return offset
