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

__all__ = ['APP_FEEDBACK_TAG', 'asks_for_app_feedback', 'is_app_feedback']

#: The tag (lower case; tags match ignoring case, as the ``tag`` filter does).
APP_FEEDBACK_TAG: Final = 'voc_app'


def is_app_feedback(item: Mapping[str, Any]) -> bool:
    """True for an item tagged ``voc_app`` (any case): the VoC app's own micro-feedback."""
    tags = item.get('tags')
    if not isinstance(tags, list):
        return False
    return any(isinstance(tag, str) and tag.strip().casefold() == APP_FEEDBACK_TAG for tag in tags)


def asks_for_app_feedback(tag_filter: object) -> bool:
    """True when a request's ``tag`` filter names the micro-feedback's tag: the one way a metric counts it."""
    return isinstance(tag_filter, str) and tag_filter.strip().casefold() == APP_FEEDBACK_TAG
