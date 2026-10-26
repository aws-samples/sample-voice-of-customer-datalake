"""`routed_names`: a feedback form's stored routing becomes the category NAMES reviews store.

Regression (5.25.00): the form editor stored config ids (`cat_<uuid>` for a category added on the
Categories page), and the processor copies `preset_category` verbatim onto each submission, so those
submissions were filed under an id no category view or filter matches.
"""
import pytest

from shared.feedback_category import routed_names

CONFIG = [
    {'id': 'cat_0f8e2c1a-example', 'name': 'checkout_flow', 'subcategories': [
        {'id': 'sub_77aa-example', 'name': 'payment_error'}, {'name': 'slow_page'}]},
    {'name': 'delivery'},
    {'id': 'billing', 'name': 'invoices'},
]


@pytest.mark.parametrize(('stored', 'expected'), [
    (('cat_0f8e2c1a-example', 'sub_77aa-example'), ('checkout_flow', 'payment_error')),
    (('checkout_flow', 'payment_error'), ('checkout_flow', 'payment_error')),
    (('cat_0f8e2c1a-example', 'slow_page'), ('checkout_flow', 'slow_page')),
    (('delivery', ''), ('delivery', '')),
    (('', 'payment_error'), ('', 'payment_error')),
    (('removed_category', 'whatever'), ('removed_category', 'whatever')),
    (('checkout_flow', 'sub_unknown'), ('checkout_flow', 'sub_unknown')),
])
def test_ids_become_names_and_names_stay(stored, expected):
    assert routed_names(CONFIG, *stored) == expected


def test_a_name_wins_over_an_id_that_spells_the_same():
    """`billing` is one entry's id but no entry's name: the id maps; a real name would win."""
    assert routed_names(CONFIG, 'billing', '') == ('invoices', '')
    assert routed_names([*CONFIG, {'name': 'billing'}], 'billing', '') == ('billing', '')


@pytest.mark.parametrize('config', [[], [None, 'x', {'id': 'cat_1'}], [{'name': 'a', 'subcategories': 'bad'}]])
def test_a_drifted_config_keeps_the_stored_values(config):
    assert routed_names(config, 'cat_1', 'sub_1') == ('cat_1', 'sub_1')
