"""The raw copy of one feedback-form submission (``POST /feedback-forms/{id}/submit``).

Written before the source policy and the normalisation touch the body, so the lake keeps what
the customer typed: ``raw/feedback_form/{YYYY}/{MM}/{DD}/{feedback id}/{sha16}.json`` (a workspace's form:
``ws/{ws}/raw/feedback_form/…``) with
connector ``feedback_form`` at the app release (``shared/raw_copy.py``). Opt-in: only once an
admin has saved a ``feedback_form`` source profile that permits a raw copy; a redact /
summary-only profile keeps none (privacy wins). The queued message references it (``s3_raw_uri``),
so the retention worker deletes it with the item. A failed write is logged; the submission is
still queued.

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
from shared.raw_copy import app_json_copy, source_permits_raw_copy
from shared.source_policy import raw_archive_allowed
from shared.ws_repo import WorkspaceScope

__all__ = ['FEEDBACK_FORM_SOURCE', 'archive_submission']

#: The feedback forms' source id, also the connector id of their raw copies.
FEEDBACK_FORM_SOURCE: Final = 'feedback_form'
#: The optional body fields the submit route bounds (``feedback_form_handler._validated_submission``) and the
#: copy keeps as sent; ``text`` and ``dimensions`` are kept as VALIDATED instead (``archive_submission``).
SUBMITTED_FIELDS: Final = ('rating', 'page_url', 'custom_fields')
#: Personal fields, each kept only when the form collects it (the form's flag).
_COLLECTED_FIELDS: Final = (('email', 'collect_email'), ('name', 'collect_name'))


def submitted_content(form: Mapping[str, Any], body: Mapping[str, Any], text: str,
                      dimensions: Mapping[str, str]) -> dict[str, Any]:
    """What the copy holds: the route's VALIDATED values (``text`` stripped and length-checked,
    ``dimensions`` after ``clean_dimensions``), the bounded optional fields present in ``body``, and
    email / name only when ``form`` collects them. Never a value the validators did not bound."""
    content: dict[str, Any] = {'text': text}
    content.update({field: body[field] for field in SUBMITTED_FIELDS if field in body})
    if dimensions:
        content['dimensions'] = dict(dimensions)
    for field, flag in _COLLECTED_FIELDS:
        if form.get(flag) and field in body:
            content[field] = body[field]
    return content


def archive_submission(form_id: str, form: Mapping[str, Any], feedback_id: str, body: Mapping[str, Any],
                       validated: tuple[str, Mapping[str, str]], profile: Mapping[str, Any],
                       now: datetime, *, scope: WorkspaceScope | None = None) -> str | None:
    """The ``s3://`` URI of the submission's raw copy; None when the policy forbids one or the write failed.

    OPT-IN like the board copies: written only once an admin has saved a ``feedback_form`` source
    profile that permits a copy (the route is public and anonymous traffic supplies the content, so a
    deployment never starts persisting it silently on upgrade). ``validated`` = ``(text, dimensions)``
    as the route validated them (``_validated_submission``, ``_widget_dimensions``): the copy keeps
    those, never the body's own ``text`` / ``dimensions``. A workspace's form (``scope``, from its lookup
    row) keeps it under ``ws/{ws}/raw/feedback_form/…``, and only once that workspace saved its own
    ``feedback_form`` profile (the route passes the workspace's ``profile``; the deployment's opts no workspace in).
    """
    if not raw_archive_allowed(profile) or not source_permits_raw_copy(
            FEEDBACK_FORM_SOURCE, require_profile=True, scope=scope):
        return None
    text, dimensions = validated
    return app_json_copy(FEEDBACK_FORM_SOURCE, now.date(), archive_key_stem(feedback_id),
                         {'form_id': form_id, 'submission': submitted_content(form, body, text, dimensions)},
                         FEEDBACK_FORM_SOURCE, scope)
