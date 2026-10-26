"""What a raw archive file is about, for the Data Explorer's S3 listing.

A raw file is named after the source's own item id (``raw/{source}/{y}/{m}/{d}/{id}.json``),
which tells a person nothing. When a listing shows raw review files, the explorer
reads the first few small ones and returns the review's title and date, so a row
reads "Battery drains overnight · Jan 4, 2026" instead of ``a81f…c2.json``.

Bounded on purpose: at most ``MAX_SUMMARIES`` files per listing, each under
``MAX_SUMMARY_BYTES``, read concurrently; any file that cannot be read or parsed
simply gets no summary (the listing never fails because of one).
"""
import json
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.concurrency import ordered_map

MAX_SUMMARIES = 50
MAX_SUMMARY_BYTES = 64 * 1024
MAX_TITLE_CHARS = 120
_WORKERS = 8

# Where the two archive shapes keep a review: the plugins' envelope nests it
# under `raw_item`; the upload/import archive is the message itself.
_TITLE_FIELDS = ('title', 'review_title', 'subject', 'summary')
_TEXT_FIELDS = ('text', 'original_text', 'body', 'content', 'review')
_DATE_FIELDS = ('created_at', 'source_created_at', 'review_date', 'date', 'published_at')


def _first_text(record: dict, fields: tuple[str, ...]) -> str:
    for field in fields:
        value = record.get(field)
        if isinstance(value, str) and value.strip():
            return ' '.join(value.split())
    return ''


def _clipped(text: str) -> str:
    return text if len(text) <= MAX_TITLE_CHARS else text[: MAX_TITLE_CHARS - 1].rstrip() + '…'


def summarize_record(payload: Any) -> dict[str, str] | None:
    """``{title, date}`` (each optional) for one parsed raw file, or None when it names neither."""
    if not isinstance(payload, dict):
        return None
    nested = payload.get('raw_item')
    record = nested if isinstance(nested, dict) else payload
    title = _first_text(record, _TITLE_FIELDS) or _first_text(record, _TEXT_FIELDS)
    date = _first_text(record, _DATE_FIELDS)
    summary = {key: value for key, value in (('title', _clipped(title)), ('date', date)) if value}
    return summary or None


def _is_summarizable(obj: dict) -> bool:
    key = obj.get('fullKey', '')
    return (not obj.get('isFolder') and isinstance(key, str) and key.startswith('raw/')
            and key.endswith('.json') and 0 < int(obj.get('size', 0)) <= MAX_SUMMARY_BYTES)


def add_summaries(s3_client: Any, bucket: str, objects: list[dict]) -> None:
    """Attach ``summary`` to the first ``MAX_SUMMARIES`` small raw JSON files in ``objects`` (in place)."""
    targets = [obj for obj in objects if _is_summarizable(obj)][:MAX_SUMMARIES]

    def read(obj: dict) -> dict[str, str] | None:
        try:
            body = s3_client.get_object(Bucket=bucket, Key=obj['fullKey'])['Body'].read()
            return summarize_record(json.loads(body))
        except (BotoCoreError, ClientError, ValueError, KeyError, TypeError):  # one unreadable file never fails the listing
            return None

    for obj, summary in zip(targets, ordered_map(read, targets, max_workers=_WORKERS), strict=True):
        if summary is not None:
            obj['summary'] = summary
