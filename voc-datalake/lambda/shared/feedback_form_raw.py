"""The raw copy of one feedback-form submission, as the widget sent it (``POST /feedback-forms/{id}/submit``).

Written before the source policy and the normalisation touch the body, so the lake keeps what
the customer typed: ``raw/feedback_form/{YYYY}/{MM}/{DD}/{feedback id}/{sha16}.json`` with
connector ``feedback_form`` at the app release (``shared/raw_copy.py``). Only when the
``feedback_form`` source profile permits a raw copy: a redact / summary-only profile keeps none
(privacy wins). The queued message references it (``s3_raw_uri``), so the retention worker
deletes it with the item. A failed write is logged; the submission is still queued.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.raw_copy import app_json_copy
from shared.source_policy import raw_archive_allowed

__all__ = ['FEEDBACK_FORM_SOURCE', 'archive_submission']

#: The feedback forms' source id, also the connector id of their raw copies.
FEEDBACK_FORM_SOURCE: Final = 'feedback_form'


def archive_submission(form_id: str, feedback_id: str, body: Mapping[str, Any], profile: Mapping[str, Any],
                       now: datetime) -> str | None:
    """The ``s3://`` URI of the submission's raw copy; None when the policy forbids one or the write failed."""
    if not raw_archive_allowed(profile):
        return None
    return app_json_copy(FEEDBACK_FORM_SOURCE, now.date(), archive_key_stem(feedback_id),
                         {'form_id': form_id, 'submission': dict(body)}, FEEDBACK_FORM_SOURCE)
