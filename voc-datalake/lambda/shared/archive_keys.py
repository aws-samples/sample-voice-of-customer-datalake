"""The file-name stem of a per-item raw archive (``raw/{source}/{y}/{m}/{d}/{stem}.json``).

One derivation for every writer (``plugins/_shared/raw_archive``,
``shared/ingest_archive``) and for the retention worker's matcher
(``shared/retention.item_raw_key``), so the worker recognises exactly the
object a writer produced for an item.

An id that is already filename-safe (letters, digits, ``-``, ``_``) and at most
64 characters is its own stem. Any other id — one sanitising would change, or
a longer one — gets ``h.<sha256 hex>``. Sanitising and truncating alone made
distinct ids share one key (``a/b`` and ``a_b``; two ids equal in their first
64 characters), so one item's archive overwrote another's and an erasure of one
removed the other's copy. A hashed stem contains a ``.``, which no unchanged id
can, so it never equals a plain one.

The retention worker matches ONLY this stem: an archive written before it under
a sanitised or truncated name (a plugin item whose id was not filename-safe or was
longer than 64 characters) is not recognised, and so not deleted — matching the
old name would let one item claim another's archive, the collision this closes.
"""

from __future__ import annotations

import hashlib
import re
from typing import Final

__all__ = ['archive_key_stem']

MAX_PLAIN_STEM_CHARS: Final = 64
_PLAIN_STEM_RE: Final = re.compile(rf'^[A-Za-z0-9_-]{{1,{MAX_PLAIN_STEM_CHARS}}}$')
_HASHED_PREFIX: Final = 'h.'


def archive_key_stem(raw_id: object) -> str:
    """The stem for ``raw_id``: itself when filename-safe and short, else ``h.<sha256>``."""
    text = str(raw_id)
    if _PLAIN_STEM_RE.match(text):
        return text
    return _HASHED_PREFIX + hashlib.sha256(text.encode('utf-8')).hexdigest()
