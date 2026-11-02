"""The raw copy of one feedback-form submission (``POST /feedback-forms/{id}/submit``).

Written before the source policy and the normalisation touch the body, so the lake keeps what
the customer typed: ``raw/feedback_form/{YYYY}/{MM}/{DD}/{feedback id}/{sha16}.json`` with
connector ``feedback_form`` at the app release (``shared/raw_copy.py``). Only when the
``feedback_form`` source profile permits a raw copy: a redact / summary-only profile keeps none
(privacy wins). The queued message references it (``s3_raw_uri``), so the retention worker
deletes it with the item. A failed write is logged; the submission is still queued.

The route is public, so the copy holds ONLY the fields the route validates and bounds
(``SUBMITTED_FIELDS``), never the rest of the body: an extra field of any size is not kept, the
participant link token is not kept (voc-participants stores only its hash), and the submitter's
email and name are kept only when the form collects them, the same rule the feedback item follows,
so an erasure by email that finds the item also finds what its copy holds.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from shared.archive_keys import archive_key_stem
from shared.raw_copy import app_json_copy
from shared.source_policy import raw_archive_allowed

__all__ = ['FEEDBACK_FORM_SOURCE', 'SUBMITTED_FIELDS', 'archive_submission', 'submitted_content']

#: The feedback forms' source id, also the connector id of their raw copies.
FEEDBACK_FORM_SOURCE: Final = 'feedback_form'
#: The body fields the submit route validates and bounds (``feedback_form_handler._validated_submission``
#: and ``_widget_dimensions``).
SUBMITTED_FIELDS: Final = ('text', 'rating', 'page_url', 'custom_fields', 'dimensions')
#: Personal fields, each kept only when the form collects it (the form's flag).
_COLLECTED_FIELDS: Final = (('email', 'collect_email'), ('name', 'collect_name'))


def submitted_content(form: Mapping[str, Any], body: Mapping[str, Any]) -> dict[str, Any]:
    """What the copy holds: the validated fields present in ``body``, plus email / name when ``form`` collects them."""
    content = {field: body[field] for field in SUBMITTED_FIELDS if field in body}
    for field, flag in _COLLECTED_FIELDS:
        if form.get(flag) and field in body:
            content[field] = body[field]
    return content


def archive_submission(form_id: str, form: Mapping[str, Any], feedback_id: str, body: Mapping[str, Any],
                       profile: Mapping[str, Any], now: datetime) -> str | None:
    """The ``s3://`` URI of the submission's raw copy; None when the policy forbids one or the write failed."""
    if not raw_archive_allowed(profile):
        return None
    return app_json_copy(FEEDBACK_FORM_SOURCE, now.date(), archive_key_stem(feedback_id),
                         {'form_id': form_id, 'submission': submitted_content(form, body)}, FEEDBACK_FORM_SOURCE)
