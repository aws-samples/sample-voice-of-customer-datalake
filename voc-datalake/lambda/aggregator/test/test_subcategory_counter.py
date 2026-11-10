"""The per-subcategory daily counter the agent heartbeat's threshold trigger reads."""
import pytest

from aggregator.handler import SUBCATEGORY_PREFIX, counter_dimensions, counter_keys, subcategory_bucket

ROW = ('METRIC#daily_subcategory#shipping#late', 'count')


def test_an_item_with_a_subcategory_counts_under_it():
    assert ROW in counter_dimensions({'category': 'shipping', 'subcategory': 'late'})


@pytest.mark.parametrize('subcategory', [None, '', 'two words', 'a#b', 'x' * 65, 7])
def test_no_row_without_a_key_safe_subcategory(subcategory):
    item = {'category': 'shipping', 'subcategory': subcategory}
    assert subcategory_bucket(item) is None
    assert not [pk for pk, _ in counter_dimensions(item) if pk.startswith(SUBCATEGORY_PREFIX)]


def test_an_uncategorised_item_counts_under_other():
    assert ('METRIC#daily_subcategory#other#late', 'count') in counter_dimensions({'subcategory': 'late'})


def test_both_directions_name_the_same_row():
    """A rebucket is the symmetric difference of two images' keys, so moving the
    subcategory decrements the old row and increments the new one, and nothing else."""
    old = {'category': 'shipping', 'subcategory': 'late'}
    new = {'category': 'shipping', 'subcategory': 'damaged'}
    old_keys, new_keys = counter_keys(old, '2026-10-04'), counter_keys(new, '2026-10-04')
    assert old_keys - new_keys == {('METRIC#daily_subcategory#shipping#late', '2026-10-04', 'count')}
    assert new_keys - old_keys == {('METRIC#daily_subcategory#shipping#damaged', '2026-10-04', 'count')}


def test_the_new_row_never_shares_a_pk_with_another_dimension():
    """A transaction may name one item once (see test_the_transaction_names_each_item_once)."""
    pks = [pk for pk, _ in counter_dimensions({'category': 'shipping', 'subcategory': 'late', 'urgency': 'high'})]
    assert len(pks) == len(set(pks))
