"""The tag of the VoC app's own micro-feedback (7.66.00, docs/micro-feedback.md), and the one rule that keeps it out of
the dashboards.

The in-app thumbs (the SPA's MicroFeedback control) answer a normal feedback form an administrator picked, made from
the "In-app micro-feedback" template, which tags its responses ``voc_app`` (the form's own tags, copied onto each item
by the submit route like any form's). Those responses are feedback about this tool, never about the customer's
product, so they must not move a customer metric (TENETS.md tenet 1): an item tagged ``voc_app`` counts in no
aggregate the stream writes (lambda/aggregator/handler.py ``counter_dimensions``, its score in no average) and passes
no read through the shared item filters (shared/item_filters.py: the metrics, the Feedback list and search, every
evidence read), whatever the request asks. It stays a feedback item: the form's own Results, Report and CSV, the Data
Explorer and a review opened by its id show it.

A tag the item gained or lost later (a person editing its tags) moves it in or out of the counters like any other
counted dimension: the stream's MODIFY is a symmetric difference of what the two images count.

A leaf module on purpose: the aggregator imports it, and it imports nothing.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

__all__ = ['APP_FEEDBACK_TAG', 'APP_FEEDBACK_TEMPLATE_ID', 'FEEDBACK_FORM_SOURCE', 'RESERVED_MESSAGE', 'has_tag',
           'is_app_feedback', 'names_app_feedback', 'refuses_tag_edit']

#: The tag (lower case; tags match ignoring case, as the ``tag`` filter does).
APP_FEEDBACK_TAG: Final = 'voc_app'


def has_tag(item: Mapping[str, Any], wanted: str) -> bool:
    """True when one of ``item``'s tags is ``wanted``, ignoring case and surrounding spaces: the ``tag`` filter's rule
    (shared/item_filters.py) and the micro-feedback's, one rule."""
    tags = item.get('tags')
    if not isinstance(tags, list):
        return False
    folded = wanted.strip().casefold()
    return any(isinstance(tag, str) and tag.strip().casefold() == folded for tag in tags)


def is_app_feedback(item: Mapping[str, Any]) -> bool:
    """True for an item tagged ``voc_app`` (any case): the VoC app's own micro-feedback."""
    return has_tag(item, APP_FEEDBACK_TAG)


#: The template whose forms alone may carry the tag (frontend/src/pages/FeedbackForms/templates/appTemplates.ts).
APP_FEEDBACK_TEMPLATE_ID: Final = 'app_micro_feedback'
#: The feedback forms' source id (the items' ``source_platform``; also the connector id of their raw copies,
#: shared/feedback_form_raw.py): the one producer whose messages may carry the tag (shared/ingest_schemas.py).
FEEDBACK_FORM_SOURCE: Final = 'feedback_form'
#: Why a write that would give or take the tag is refused.
RESERVED_MESSAGE: Final = (
    f'The tag {APP_FEEDBACK_TAG} is reserved for the in-app micro-feedback: only a form made from the In-app '
    'micro-feedback template carries it, and its responses keep it')


def names_app_feedback(tags: object) -> bool:
    """True when a tag list (as a write sends it) holds ``voc_app``, ignoring case and surrounding spaces."""
    return has_tag({'tags': tags}, APP_FEEDBACK_TAG)


def refuses_tag_edit(item: Mapping[str, Any], new_tags: object) -> bool:
    """Whether a manual tag edit of ``item`` to ``new_tags`` is refused: one that gives the tag, everywhere, and one
    that takes it from a form's response (a micro-feedback answer stays one). A review of any other source may lose it
    (review round 3, 7.66.00): a customer's review tagged ``voc_app`` before the tag was reserved is counted again."""
    giving = names_app_feedback(new_tags) and not is_app_feedback(item)
    taking = is_app_feedback(item) and not names_app_feedback(new_tags)
    return giving or (taking and item.get('source_platform') == FEEDBACK_FORM_SOURCE)
