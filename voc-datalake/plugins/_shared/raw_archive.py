"""
The raw-data archive every source writes to: ``raw/{source}/{y}/{m}/{d}/{id}.json``.

One implementation for both transports. ``BaseIngestor.store_raw_to_s3`` used to
own this outright, so a webhook (which has no ingestor instance) could only
forward its payload inline in the SQS message — the one source shape whose raw
data never reached the lake. Both now call :func:`archive_raw_item`.
"""

import hashlib
import json
import os
import sys
from datetime import UTC, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.archive_keys import archive_key_stem
from shared.logging import logger

from .source_policy_gate import raw_archive_permitted

__all__ = ["archive_raw_item", "raw_item_id"]


def raw_item_id(item: dict) -> str:
    """A deterministic S3 file name for *item*, so a re-ingest overwrites, not duplicates.

    Mirrors the processor's deduplication: the source id when there is one (as a
    collision-free stem, ``shared.archive_keys``), else a hash of created_at + text + url.
    """
    source_id = item.get("id", "")
    if source_id:
        return archive_key_stem(source_id)

    text = item.get("text", "")
    created_at = item.get("created_at", "")
    url = item.get("url", "")
    text_hash = hashlib.sha256(text[:500].encode(), usedforsecurity=False).hexdigest()[:16] if text else ""
    content = f"{created_at}:{text_hash}:{url}"
    return hashlib.sha256(content.encode()).hexdigest()[:32]


def _partition_date(created_at: object, now: datetime) -> datetime:
    """The item's own date when it parses, else *now* — the archive is partitioned by it."""
    if not isinstance(created_at, str) or not created_at:
        return now
    date_str = created_at.replace('Z', '+00:00').replace(' ', 'T')
    if 'T' in date_str and '+' not in date_str and '-' not in date_str.split('T')[1]:
        date_str += '+00:00'
    try:
        return datetime.fromisoformat(date_str)
    except (ValueError, TypeError) as e:
        logger.debug(f"Could not parse created_at '{created_at}': {e}")
        return now


def archive_raw_item(
    s3, bucket: str, source_platform: str, item: dict, raw_content: str | None = None,
) -> str | None:
    """Write *item* (and the source's own payload, *raw_content*) to the raw archive.

    Returns the ``s3://`` URI, or None when no bucket is configured or the write
    failed — a failed WRITE never raises, because losing the archive copy must not
    lose the feedback: callers fall back to sending the item inline. An unreadable
    source policy DOES raise (``SourceProfilesUnavailable``): the run fails and is
    retried rather than archiving a redact / summary-only source's raw copy.
    """
    if not bucket:
        logger.warning("RAW_DATA_BUCKET not configured, skipping S3 storage")
        return None
    if not raw_archive_permitted(source_platform):
        # A redact / summary-only source keeps no raw copy (shared/source_policy.py);
        # the policy-applied message is the only copy that travels.
        return None

    try:
        now = datetime.now(UTC)
        item_id = raw_item_id(item)
        partition_date = _partition_date(item.get("created_at"), now)
        s3_key = (
            f"raw/{source_platform}/{partition_date.year}/{partition_date.month:02d}/"
            f"{partition_date.day:02d}/{item_id}.json"
        )
        raw_payload = {
            "item_id": item_id,
            "source_platform": source_platform,
            "ingested_at": now.isoformat(),
            "partition_date": partition_date.strftime('%Y-%m-%d'),
            "raw_content": raw_content,
            "raw_item": item,
        }
        s3.put_object(
            Bucket=bucket,
            Key=s3_key,
            Body=json.dumps(raw_payload, default=str),
            ContentType="application/json",
        )
        logger.info(f"Stored raw data to s3://{bucket}/{s3_key}")
    except Exception as e:
        logger.exception(f"Failed to store raw data to S3: {e}")
        return None
    else:
        return f"s3://{bucket}/{s3_key}"
