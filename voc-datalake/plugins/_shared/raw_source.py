"""The source payload a plugin received for one item, carried to its raw archive as ``raw_content``.

A plugin that maps a provider's record into an item puts the record it received (the App Store
RSS entry, the Google Play review, the scraped review element, the import file's row) on the item
under ``RAW_SOURCE_KEY``. ``BaseIngestor.normalize_item`` pops it before anything else reads the
item, so it never reaches the queue, and archives it next to the mapped item
(``_shared/raw_archive.py``: ``{"raw_content": ..., "raw_item": ...}``).

Bounded: a payload longer than ``MAX_RAW_SOURCE_CHARS`` (256 KB) is cut there and ends with
``TRUNCATION_MARKER``, so one oversized page or record cannot blow up the archive.
"""

import json

__all__ = ["RAW_SOURCE_KEY", "pop_raw_source"]

RAW_SOURCE_KEY = "_raw_source"
MAX_RAW_SOURCE_CHARS = 256 * 1024
TRUNCATION_MARKER = "\n[truncated: the source payload was over 256 KB]"


def pop_raw_source(item: dict) -> str | None:
    """Remove ``RAW_SOURCE_KEY`` from *item*; the payload as text (JSON unless already a string), bounded."""
    source = item.pop(RAW_SOURCE_KEY, None)
    if source is None:
        return None
    text = source if isinstance(source, str) else json.dumps(source, default=str, ensure_ascii=False)
    if len(text) > MAX_RAW_SOURCE_CHARS:
        return text[:MAX_RAW_SOURCE_CHARS] + TRUNCATION_MARKER
    return text
