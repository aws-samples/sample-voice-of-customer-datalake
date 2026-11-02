"""The raw copy of one feedback-form submission, as the widget sent it (``POST /feedback-forms/{id}/submit``).

Written before the source policy and the normalisation touch the body, so the lake keeps what
the customer typed: ``raw/feedback_form/{YYYY}/{MM}/{DD}/{feedback id}/{sha16}.json`` with
connector ``feedback_form`` at the app release (``shared/raw_copy.py``). Only when the
``feedback_form`` source profile permits a raw copy: a redact / summary-only profile keeps none
(privacy wins). The queued message references it (``s3_raw_uri``), so the retention worker
deletes it with the item. A failed write is logged; the submission is still queued.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.aws import get_s3_client
from shared.raw_copy import RawTarget, json_copy
from shared.raw_versions import app_connector
from shared.source_policy import raw_archive_allowed

__all__ = ['FEEDBACK_FORM_CONNECTOR', 'archive_submission']

FEEDBACK_FORM_CONNECTOR: Final = 'feedback_form'


def archive_submission(source: str, form_id: str, feedback_id: str, body: Mapping[str, Any],
                       profile: Mapping[str, Any], now: datetime) -> str | None:
    """The ``s3://`` URI of the submission's raw copy; None when the policy forbids one or the write failed."""
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    if not bucket or not raw_archive_allowed(profile):
        return None
    target = RawTarget(bucket, source, now.date(), archive_key_stem(feedback_id))
    return json_copy(get_s3_client(), target, {'form_id': form_id, 'submission': dict(body)},
                     app_connector(FEEDBACK_FORM_CONNECTOR))
