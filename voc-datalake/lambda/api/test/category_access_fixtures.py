"""Builders for the category-access handler tests."""
from __future__ import annotations

from unittest.mock import MagicMock

from shared.category_access import access_key

RESTRICTED_SUB = 'sub-restricted'
RESTRICTED_CLAIMS = {'sub': RESTRICTED_SUB, 'cognito:groups': 'users', 'cognito:username': 'rita'}
CATEGORIES_CONFIG = {
    'pk': 'SETTINGS#categories', 'sk': 'config',
    'categories': [{'name': 'delivery'}, {'name': 'billing'}, {'name': 'app'}],
}


def aggregates_with(*items: dict) -> MagicMock:
    """A mock aggregates table whose `get_item` answers from `items` by (pk, sk)."""
    rows = {(item['pk'], item['sk']): item for item in items}
    table = MagicMock()

    def get_item(Key, **_kwargs):
        row = rows.get((Key['pk'], Key['sk']))
        return {'Item': row} if row else {}

    table.get_item.side_effect = get_item
    table.query.return_value = {'Items': []}
    return table


def restricted_to(*categories: str) -> MagicMock:
    """Aggregates for a caller restricted to `categories`, with the categories config."""
    return aggregates_with(
        {**access_key(RESTRICTED_SUB), 'categories': list(categories)}, CATEGORIES_CONFIG)
