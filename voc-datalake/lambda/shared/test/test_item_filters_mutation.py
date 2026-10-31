"""Mutation-run pins for ``shared/item_filters.py``.

The earlier suite drove ``admits`` per field and ``filter`` only with an empty or a
``tag`` filter, so the mutation run found four things it could not see: ``active``
for a filter that sets exactly one field (``channel or dims`` → ``and`` survived),
the frozen (immutable) dataclass that makes ``NO_ITEM_FILTERS`` a safe
shared default, that constant itself, and the field annotations that
``typing.get_type_hints`` resolves.
"""
import dataclasses
import typing
from collections.abc import Mapping

import pytest

from shared.item_filters import NO_ITEM_FILTERS, ItemFilters

EMAIL = {'source_channel': 'email', 'dimensions': {'product': 'App'}, 'tags': ['vip']}
CHAT = {'source_channel': 'chat', 'dimensions': {'product': 'Web'}, 'tags': []}


class TestOneFieldIsEnoughToBeActive:
    @pytest.mark.parametrize('filters', [
        ItemFilters(channel='email'),
        ItemFilters(dims={'product': 'App'}),
        ItemFilters(tag='vip'),
    ])
    def test_a_single_set_field_activates_and_filters(self, filters):
        assert filters.active is True
        assert filters.filter([EMAIL, CHAT, EMAIL]) == [EMAIL, EMAIL]


class TestTheSharedNoOpDefault:
    def test_no_item_filters_is_the_empty_inactive_filter(self):
        assert ItemFilters() == NO_ITEM_FILTERS
        assert NO_ITEM_FILTERS.active is False
        items = [EMAIL, CHAT]
        assert NO_ITEM_FILTERS.filter(items) is items

    @pytest.mark.parametrize('name', [f.name for f in dataclasses.fields(ItemFilters)])
    def test_it_cannot_be_mutated(self, name):
        before = getattr(NO_ITEM_FILTERS, name)
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(NO_ITEM_FILTERS, name, 'email')
        assert getattr(NO_ITEM_FILTERS, name) == before


def test_field_annotations_resolve():
    assert typing.get_type_hints(ItemFilters) == {
        'channel': str | None,
        'dims': Mapping[str, str],
        'tag': str | None,
        'rating_min': int | None,
        'rating_max': int | None,
        'urgent': bool,
        'sources': tuple[str, ...],
        'categories': tuple[str, ...],
        'subcategories': tuple[str, ...],
        'sentiments': tuple[str, ...],
        'usefulness': tuple[str, ...],
        'configured_categories': frozenset[str] | None,
    }
