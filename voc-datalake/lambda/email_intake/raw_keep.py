"""The raw copy of one email as received, in the raw lake (docs/email-intake.md -> Raw copies).

``raw/email_intake/{YYYY}/{MM}/{DD}/{item id}/{sha16}.eml`` (``message/rfc822``, the day it was
read), write-once, connector ``email_intake`` at the app release (``shared/raw_copy.py``). The
folder is the source id, so a whole-source erasure of ``email_intake`` sweeps it, and an accepted
email's item references its copy (``s3_raw_uri``), so retention and erasure delete it with the item.

ONLY when the ``email_intake`` source profile permits a raw copy. Its default is ``pii: redact``
(``shared/email_intake_settings.py``), so by default nothing is written here. Filtered mail of a
raw-permitted source (a duplicate, a reply without news, a repeat in its thread, over the sender
cap) is kept the same way with the S3 metadata ``drop-reason``. A failed write is logged; the
email is decided all the same.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.email_intake_settings import EMAIL_INTAKE_SOURCE
from shared.raw_copy import RawTarget, bytes_copy, source_permits_raw_copy
from shared.raw_versions import app_connector

__all__ = ['FILTERED_REASONS', 'keep_raw']

#: The outcomes whose email is kept with a ``drop-reason`` (spam, virus, automatic mail and the
#: unreadable are never kept).
FILTERED_REASONS: Final = frozenset({
    'duplicate_message', 'forward_duplicate', 'seen_in_thread', 'no_new_info', 'sender_cap'})
DROP_REASON_META: Final = 'drop-reason'


def keep_raw(s3: Any, bucket: str, raw: bytes, item_id: str, drop_reason: str = '') -> str | None:
    """The ``s3://`` URI of the email's raw copy; None when there is no bucket, the policy forbids a
    copy or the write failed."""
    if not bucket or not source_permits_raw_copy(EMAIL_INTAKE_SOURCE):
        return None
    target = RawTarget(bucket, EMAIL_INTAKE_SOURCE, datetime.now(UTC).date(), archive_key_stem(item_id))
    return bytes_copy(s3, target, raw, app_connector(EMAIL_INTAKE_SOURCE), extension='.eml',
                      content_type='message/rfc822',
                      metadata={DROP_REASON_META: drop_reason} if drop_reason else None)
