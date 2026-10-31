"""The review queue's `conflicts_with` never reveals a memory the reader cannot see (BE-3).

For a category-restricted reader it is an allowlist of the linked memories they can see, so an id
that resolves to nothing (a vanished memory) goes as well as a hidden one; a reader who sees every
category has nothing hidden from them and keeps the whole list.
"""
from unittest.mock import MagicMock

import pytest

import memory_handler as h
from shared.category_access import CategoryScope

ITEM = {'pk': 'MEM#company', 'memory_id': 'm0', 'statement': 's', 'conflicts_with': ['m-visible', 'm-hidden', 'm-gone']}
VISIBLE = {'pk': 'MEM#company', 'memory_id': 'm-visible', 'statement': 'v'}
HIDDEN = {'pk': 'MEM#company', 'memory_id': 'm-hidden', 'statement': 'h'}


@pytest.fixture
def linked(monkeypatch):
    """`linked_items` resolves the visible and hidden memories; `m-gone` has vanished."""
    monkeypatch.setattr(h.store, 'linked_items', lambda _table, _item: [VISIBLE, HIDDEN])
    monkeypatch.setattr(h.store, 'visible_to', lambda _scope, row, _hidden: row['memory_id'] != 'm-hidden')
    monkeypatch.setattr(h.store, 'public_view', dict)
    monkeypatch.setattr(h.policy, 'suggest_resolution', lambda _item, _linked: None)


@pytest.mark.usefixtures('linked')
def test_a_restricted_reader_keeps_only_the_ids_they_can_see():
    entry = h._review_entry(MagicMock(), ITEM, (CategoryScope(all=False), None))
    assert entry['memory']['conflicts_with'] == ['m-visible']
    assert [other['memory_id'] for other in entry['linked']] == ['m-visible']


@pytest.mark.usefixtures('linked')
def test_an_unrestricted_reader_keeps_the_whole_list():
    entry = h._review_entry(MagicMock(), ITEM, (CategoryScope(all=True), None))
    assert entry['memory']['conflicts_with'] == ['m-visible', 'm-hidden', 'm-gone']
