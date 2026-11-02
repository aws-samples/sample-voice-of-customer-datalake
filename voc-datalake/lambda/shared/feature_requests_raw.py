"""Raw copies of what people file on the feedback boards (docs/feature-requests.md -> Raw copies).

Each request is archived on create and on every edit of its content, each +1 on create and on
every edit, write-once and versioned (``shared/raw_copy.py``), connector ``feature_requests`` at
the app release::

    raw/feature_requests/{YYYY}/{MM}/{DD}/{request id}/{sha16}.json    the request
    raw/feature_requests/{YYYY}/{MM}/{DD}/{support id}/{sha16}.json    one +1

The day is the request's / the +1's own ``created_at``, so every version of one lands in one
folder; a +1 has its own folder (its id is stable per person and request), so a request folder
holds only versions of the request. The archived content is what the person submitted and what
the row stores about them, no more: a request's title, description, field values, board and
reporter (email, name); a +1's field values, name and email. Not the status, totals or the
row's bookkeeping, so an admin's triage writes no new version.

Boards are not a feedback source: nothing here is queued into voc-feedback (a product decision
not made yet). The copy is OPT-IN: written only when an admin has saved a ``feature_requests``
source profile that permits one (the copies hold reporters' and supporters' emails, which an
erasure by email does not reach yet). Under a redact / summary-only profile none is written
(privacy wins), and an unreadable profile writes none. A failed write is logged; the request or
+1 is stored all the same.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.raw_copy import app_json_copy, source_permits_raw_copy

__all__ = ['FEATURE_REQUESTS_SOURCE', 'archive_request', 'archive_support']

FEATURE_REQUESTS_SOURCE: Final = 'feature_requests'
REQUEST_CONTENT: Final = ('request_id', 'board_id', 'title', 'description', 'fields', 'reporter_email',
                          'reporter_name', 'created_at')
# A +1's field values are top-level attributes; everything but the row's bookkeeping is content.
_SUPPORT_BOOKKEEPING: Final = frozenset({'pk', 'sk', 'updated_at'})


def _day(created_at: object) -> date:
    if isinstance(created_at, str):
        try:
            return datetime.fromisoformat(created_at.replace('Z', '+00:00')).date()
        except ValueError:
            pass
    return datetime.now(UTC).date()


def _archive(item_id: object, content: Mapping[str, Any]) -> str | None:
    if not isinstance(item_id, str) or not item_id or not source_permits_raw_copy(
            FEATURE_REQUESTS_SOURCE, require_profile=True):
        return None
    return app_json_copy(FEATURE_REQUESTS_SOURCE, _day(content.get('created_at')), archive_key_stem(item_id),
                         dict(content), FEATURE_REQUESTS_SOURCE)


def archive_request(request: Mapping[str, Any]) -> str | None:
    """Keep the request's submitted content (``REQUEST_CONTENT``) as a new version; its URI, or None."""
    return _archive(request.get('request_id'), {key: request[key] for key in REQUEST_CONTENT if key in request})


def archive_support(support: Mapping[str, Any]) -> str | None:
    """Keep one +1 (its values, name, email) as a new version; its URI, or None."""
    return _archive(support.get('support_id'),
                    {key: value for key, value in support.items() if key not in _SUPPORT_BOOKKEEPING})
