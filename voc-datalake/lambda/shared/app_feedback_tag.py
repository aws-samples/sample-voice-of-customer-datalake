"""The tag of the VoC app's own micro-feedback (7.66.00, docs/micro-feedback.md), and the one rule that keeps it out of
the dashboards.

The in-app thumbs (the SPA's MicroFeedback control) answer a normal feedback form an administrator picked, made from
the "In-app micro-feedback" template, which tags its responses ``voc_app`` (the form's own tags, copied onto each item
by the submit route like any form's). Those responses are feedback about this tool, never about the customer's
product, so they must not move a customer metric (TENETS.md tenet 1): an item tagged ``voc_app`` counts in no
aggregate the stream writes (lambda/aggregator/handler.py ``counter_dimensions``, its score in no average) and in no
metric route's item path (lambda/api/metrics_handler.py), unless a request filters on the tag itself. It stays a
feedback item: the Feedback list, search and the form's Results show it.

A tag the item gained or lost later (a person editing its tags) moves it in or out of the counters like any other
counted dimension: the stream's MODIFY is a symmetric difference of what the two images count.

A leaf module on purpose: the aggregator imports it, and it imports nothing.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

__all__ = ['APP_FEEDBACK_TAG', 'APP_FEEDBACK_TEMPLATE_ID', 'RESERVED_MESSAGE', 'asks_for_app_feedback', 'has_tag',
           'is_app_feedback', 'names_app_feedback']

#: The tag (lower case; tags match ignoring case, as the ``tag`` filter does).
APP_FEEDBACK_TAG: Final = 'voc_app'


def has_tag(item: Mapping[str, Any], wanted: str) -> bool:
    """True when one of ``item``'s tags is ``wanted``, ignoring case and surrounding spaces: the ``tag`` filter's rule
    (shared/item_filters.py) and the micro-feedback's, one rule, so an item the dashboards leave out is the one a
    ``tag=voc_app`` request finds."""
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
#: Why a write that would give or take the tag is refused.
RESERVED_MESSAGE: Final = (
    f'The tag {APP_FEEDBACK_TAG} is reserved for the in-app micro-feedback: only a form made from the In-app '
    'micro-feedback template carries it, and its responses keep it')


def names_app_feedback(tags: object) -> bool:
    """True when a tag list (as a write sends it) holds ``voc_app``, ignoring case and surrounding spaces."""
    return has_tag({'tags': tags}, APP_FEEDBACK_TAG)


def asks_for_app_feedback(tag_filter: object) -> bool:
    """True when a request's ``tag`` filter names the micro-feedback's tag: the one way a metric counts it."""
    return isinstance(tag_filter, str) and tag_filter.strip().casefold() == APP_FEEDBACK_TAG
