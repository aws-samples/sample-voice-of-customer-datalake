"""The arrange block shared by the `api/feedback_edit_handler.py` route suites.

`test_feedback_edit_handler.py` drives the route end to end and the mutation
suite pins the literals it cannot see; both seed the SAME stored review under
moto, as the same admin, and call the handler through the same REST event, so
that definition lives here once.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from category_access_fixtures import CATEGORIES_CONFIG
from moto import mock_aws
from moto_helpers import invoke, rest_event, seeded_category_edit_tables

import feedback_edit_handler

ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
ITEM = {
    'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1',
    'category': 'delivery', 'subcategory': 'late',
    'gsi2pk': 'CATEGORY#delivery', 'gsi2sk': '-0.5#2026-01-01T00:00:00Z',
}


def seeded_tables() -> Iterator[tuple[Any, Any]]:
    """A `tables` fixture body (``yield from``): the feedback and aggregates tables under moto,
    holding `ITEM` and the category config."""
    with mock_aws():
        yield seeded_category_edit_tables(ITEM, CATEGORIES_CONFIG)


def put_category(tables: tuple[Any, Any], lambda_context: Any, body: object, *,
                 claims: dict = ADMIN_CLAIMS, feedback_id: str = 'f1') -> tuple[int, Any]:
    """One ``PUT /feedback/{feedback_id}/category`` against ``tables``; the status and decoded body."""
    feedback, aggregates = tables
    event = rest_event('PUT', f'/feedback/{feedback_id}/category', claims=claims, body=body,
                       path_params={'id': feedback_id})
    return invoke(feedback_edit_handler, event, lambda_context, feedback=feedback, aggregates=aggregates)
