"""Mutation-run pins for shared/feedback_dimensions.py.

The earlier suite only ever passed a config listing the parent before its child,
so dropping the parent-first sort changed nothing it could see; and it matched the
manual-edit refusals by substring, so the client-facing messages could gain text
unnoticed. These tests pin the order-independence and the exact messages.
"""
import pytest

from shared.feedback_dimensions import apply_dimension_edit, resolve_item_dimensions

PRODUCT = {'key': 'product', 'infer': True, 'values': [{'name': 'App'}, {'name': 'Web'}]}
MODULE = {'key': 'module', 'infer': True, 'parent': 'product', 'values': [{'name': 'checkout', 'parent_value': 'App'}]}
CHILD_FIRST = [MODULE, PRODUCT]
ITEM = {'dimensions': {'product': 'App', 'module': 'checkout'},
        'dimension_sources': {'product': 'ai', 'module': 'ai'}}


class TestParentResolvesBeforeItsChild:
    def test_a_child_listed_first_still_sees_its_parent(self):
        dims, sources = resolve_item_dimensions(CHILD_FIRST, message={'module': 'checkout', 'product': 'App'})
        assert dims == {'product': 'App', 'module': 'checkout'}
        assert sources == {'product': 'source', 'module': 'source'}

    def test_the_model_fills_an_inferable_child_from_the_last_layer(self):
        dims, sources = resolve_item_dimensions(CHILD_FIRST, profile_defaults={'product': 'App'},
                                                ai={'module': 'checkout'})
        assert dims == {'product': 'App', 'module': 'checkout'}
        assert sources == {'product': 'profile', 'module': 'ai'}


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('edits', 'message'), [
        ({'colour': 'red'}, '"colour" is not a configured dimension'),
        ({7: 'red'}, '"7" is not a configured dimension'),
        ({'product': 'Tablet'}, '"Tablet" is not a value of dimension "product"'),
        ({'product': 3}, 'The value of dimension "product" must be a string or null'),
        ({'product': 'Web', 'module': 'checkout'},
         'The value of dimension "module" does not belong under its parent value'),
    ])
    def test_exact_message(self, edits, message):
        with pytest.raises(ValueError, match='dimension') as refused:
            apply_dimension_edit(CHILD_FIRST, ITEM, edits)
        assert str(refused.value) == message
