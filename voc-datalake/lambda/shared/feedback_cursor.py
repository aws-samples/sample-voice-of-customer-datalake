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

from collections.abc import Mapping
from typing import Final

from shared.b64_json import MAX_TOKEN_CHARS as MAX_CURSOR_CHARS
from shared.b64_json import decode_b64_json, encode_b64_json

__all__ = [
    'MAX_CURSOR_CHARS', 'decode_key_cursor', 'decode_offset_cursor', 'encode_key_cursor', 'encode_offset_cursor',
]

_INVALID: Final = 'next_token is not valid'


def _decode(token: str) -> object:
    return decode_b64_json(token, _INVALID)


def encode_key_cursor(key: Mapping[str, str]) -> str:
    """The cursor of one index row's key."""
    return encode_b64_json(dict(key))


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
    return encode_b64_json({'o': offset})


def decode_offset_cursor(token: str, max_offset: int) -> int:
    """An offset cursor back to its offset (0..``max_offset``)."""
    value = _decode(token)
    if not isinstance(value, dict) or set(value) != {'o'}:
        raise ValueError(_INVALID)
    offset = value['o']
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= max_offset:
        raise ValueError(_INVALID)
    return offset
