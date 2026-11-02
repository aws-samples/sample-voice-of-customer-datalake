"""The processor's last chance to keep a raw copy: a message that arrived with ``raw_data`` inline.

A producer sends the item inline (``raw_data``) instead of an ``s3_raw_uri`` only when its own
archive write failed (``plugins/_shared/base_ingestor.py``, ``base_webhook.py``). The processor
then writes ``raw_data`` once, write-once and versioned (``shared/raw_copy.py``)::

    raw/{source}/{YYYY}/{MM}/{DD}/{stem}/{sha16}.json      (the processing day)

with connector ``processor`` at the app release (``APP_VERSION``), and stores the URI on the new
item, so the retention worker deletes it with the item. A retried message maps to the same key
(the digest is over ``raw_data`` only) and writes nothing new.

Privacy first: only when the source's profile permits a raw copy, read strictly. An unreadable
profile writes nothing (logged) rather than archiving under the allow default; the source policy
already drops ``raw_data`` from a redact / summary-only message upstream (``shared/source_policy.py``).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.logging import logger
from shared.raw_copy import app_json_copy, source_permits_raw_copy

__all__ = ['PROCESSOR_CONNECTOR', 'archive_inline_raw']

PROCESSOR_CONNECTOR: Final = 'processor'
_NO_ID_STEM: Final = 'item'


def archive_inline_raw(raw_record: Mapping[str, Any], now: datetime) -> str | None:
    """The ``s3://`` URI of ``raw_record['raw_data']``'s copy; None when there is nothing to write,
    the record already names its archive, the policy forbids a copy or the write failed."""
    raw = raw_record.get('raw_data')
    source = raw_record.get('source_platform')
    if not isinstance(raw, dict) or raw_record.get('s3_raw_uri') or not isinstance(source, str):
        return None
    if not source_permits_raw_copy(source):
        return None
    item_id = raw_record.get('id')
    stem = archive_key_stem(item_id) if isinstance(item_id, str) and item_id else _NO_ID_STEM
    uri = app_json_copy(source, now.date(), stem, raw, PROCESSOR_CONNECTOR)
    if uri:
        logger.info('Archived inline raw data in the processor', extra={'source': source})
    return uri
