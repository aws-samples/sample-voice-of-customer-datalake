"""The "Other" bucket: every review no configured category claims (shared/other_category.py)."""
from __future__ import annotations

from shared.other_category import (
    OTHER,
    category_bucket,
    fold_counts,
    matches_category,
    other_condition,
    tally_buckets,
)

CONFIGURED = ['delivery', 'billing']


def test_a_configured_category_is_its_own_row():
    assert category_bucket('delivery', CONFIGURED) == 'delivery'


def test_missing_empty_fallback_and_removed_categories_are_other():
    assert {category_bucket(name, CONFIGURED) for name in (None, '', 'other', 'pricing', 7)} == {OTHER}


def test_tally_counts_items_by_row():
    items = [{'category': 'delivery'}, {}, {'category': 'pricing'}, {'category': 'other'}]
    assert tally_buckets(items, CONFIGURED) == {'delivery': 1, 'other': 3}


def test_fold_merges_unconfigured_names_and_drops_zeros():
    assert fold_counts({'delivery': 2, 'billing': 0, 'other': 1, 'pricing': 4}, CONFIGURED) == {
        'delivery': 2, 'other': 5}


def test_other_matches_every_unconfigured_item_but_a_name_matches_only_itself():
    removed = {'category': 'pricing'}
    assert matches_category(removed, OTHER, CONFIGURED)
    assert matches_category(removed, 'pricing', CONFIGURED)
    assert not matches_category({'category': 'delivery'}, OTHER, CONFIGURED)


def test_no_condition_when_nothing_is_configured_or_the_list_is_too_long():
    assert other_condition([]) is None
    assert other_condition([f'c{n}' for n in range(100)]) is None
    assert other_condition(CONFIGURED) is not None
