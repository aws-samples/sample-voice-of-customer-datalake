"""Resolution, re-inference and manual edits of a review's dimensions (shared/feedback_dimensions.py)."""
import pytest

from shared.feedback_dimensions import (
    LOCKED_SOURCES,
    apply_dimension_edit,
    category_product,
    inferable_dimensions,
    merged_tags,
    reinfer_dimensions,
    resolve_item_dimensions,
)

CONFIG = [
    {'key': 'product', 'label': 'Product', 'infer': True, 'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'module', 'label': 'Module', 'infer': True, 'parent': 'product', 'values': [
        {'name': 'checkout', 'parent_value': 'App'},
        {'name': 'search', 'parent_value': 'Web'},
        {'name': 'login'},
    ]},
    {'key': 'user_type', 'label': 'User type', 'infer': False, 'values': [{'name': 'customer'}, {'name': 'partner'}]},
]


class TestResolveItemDimensions:
    def test_first_layer_wins_per_key_and_records_its_source(self):
        dims, sources = resolve_item_dimensions(
            CONFIG, message={'product': 'web'}, profile_defaults={'product': 'App', 'user_type': 'partner'},
            product='App', ai={'module': 'search'})
        assert dims == {'product': 'Web', 'user_type': 'partner', 'module': 'search'}
        assert sources == {'product': 'source', 'user_type': 'profile', 'module': 'ai'}

    def test_an_unknown_value_falls_through_to_the_next_layer(self):
        dims, sources = resolve_item_dimensions(CONFIG, message={'product': 'Tablet'}, product='App')
        assert dims == {'product': 'App'}
        assert sources == {'product': 'category'}

    def test_the_model_never_sets_a_dimension_that_does_not_infer(self):
        dims, _ = resolve_item_dimensions(CONFIG, ai={'user_type': 'customer', 'product': 'App'})
        assert dims == {'product': 'App'}

    def test_a_child_must_fit_the_parent_resolved_from_any_layer(self):
        dims, _ = resolve_item_dimensions(CONFIG, message={'module': 'checkout'}, ai={'product': 'Web'})
        assert dims == {'product': 'Web'}
        dims, _ = resolve_item_dimensions(CONFIG, message={'module': 'checkout'}, ai={'product': 'App'})
        assert dims == {'product': 'App', 'module': 'checkout'}

    def test_a_child_value_without_a_parent_value_fits_anywhere(self):
        dims, _ = resolve_item_dimensions(CONFIG, message={'module': 'login'})
        assert dims == {'module': 'login'}

    @pytest.mark.parametrize('bad', [None, 'x', ['product'], {'product': 3}])
    def test_malformed_layers_contribute_nothing(self, bad):
        assert resolve_item_dimensions(CONFIG, message=bad, ai=bad) == ({}, {})

    def test_metadata_keyed_by_a_dimension_is_a_source_value(self):
        dims, sources = resolve_item_dimensions(
            CONFIG, metadata={'product': 'web', 'plan': 'gold', 'custom_fields': {'user_type': 'partner'}},
            profile_defaults={'product': 'App', 'user_type': 'customer'})
        assert dims == {'product': 'Web', 'user_type': 'partner'}
        assert sources == {'product': 'source', 'user_type': 'source'}

    def test_explicit_dimensions_beat_metadata_and_a_disallowed_metadata_value_falls_through(self):
        dims, sources = resolve_item_dimensions(
            CONFIG, message={'product': 'App'}, metadata={'product': 'Web', 'user_type': 'vip'},
            profile_defaults={'user_type': 'customer'})
        assert dims == {'product': 'App', 'user_type': 'customer'}
        assert sources == {'product': 'source', 'user_type': 'profile'}

    @pytest.mark.parametrize('bad', ['x', ['product'], {'custom_fields': 'product'}])
    def test_malformed_metadata_contributes_nothing(self, bad):
        assert resolve_item_dimensions(CONFIG, metadata=bad) == ({}, {})

    def test_no_config_means_no_dimensions(self):
        assert resolve_item_dimensions([], message={'product': 'App'}) == ({}, {})


class TestCategoryProduct:
    def test_reads_the_configured_product(self):
        config = [{'name': 'billing', 'product': 'App'}, {'name': 'other', 'product': '  '}]
        assert category_product(config, 'billing') == 'App'
        assert category_product(config, 'other') is None
        assert category_product(config, 'missing') is None


class TestReinfer:
    def test_locked_keys_survive_and_the_rest_is_recomputed(self):
        item = {'dimensions': {'product': 'App', 'module': 'login', 'user_type': 'partner'},
                'dimension_sources': {'product': 'manual', 'module': 'ai', 'user_type': 'profile'}}
        dims, sources = reinfer_dimensions(CONFIG, item, product='Web', ai={'module': 'checkout'})
        assert dims == {'product': 'App', 'user_type': 'partner', 'module': 'checkout'}
        assert sources == {'product': 'manual', 'user_type': 'profile', 'module': 'reprocess'}

    def test_an_unlocked_value_the_model_no_longer_gives_is_dropped(self):
        item = {'dimensions': {'module': 'login'}, 'dimension_sources': {'module': 'reprocess'}}
        assert reinfer_dimensions(CONFIG, item, product=None, ai={}) == ({}, {})

    def test_locked_sources_are_exactly_the_producer_and_people(self):
        assert frozenset({'source', 'profile', 'manual'}) == LOCKED_SOURCES


EDIT_ITEM = {'dimensions': {'product': 'App', 'module': 'checkout'},
             'dimension_sources': {'product': 'ai', 'module': 'ai'}}


class TestManualEdit:

    def test_an_edit_is_manual_and_null_removes(self):
        dims, sources = apply_dimension_edit(CONFIG, EDIT_ITEM, {'user_type': 'Partner', 'module': None})
        assert dims == {'product': 'App', 'user_type': 'partner'}
        assert sources == {'product': 'ai', 'user_type': 'manual'}

    def test_a_child_nobody_edited_is_dropped_when_its_parent_moves(self):
        dims, sources = apply_dimension_edit(CONFIG, EDIT_ITEM, {'product': 'Web'})
        assert dims == {'product': 'Web'}
        assert sources == {'product': 'manual'}

    @pytest.mark.parametrize(('edits', 'message'), [
        ({'colour': 'red'}, 'not a configured dimension'),
        ({'product': 'Tablet'}, 'is not a value of dimension'),
        ({'product': 3}, 'must be a string or null'),
        ({'module': 'search'}, 'does not belong under its parent'),
    ])
    def test_invalid_edits_are_refused(self, edits, message):
        with pytest.raises(ValueError, match=message):
            apply_dimension_edit(CONFIG, EDIT_ITEM, edits)


class TestMergedTags:
    def test_union_keeps_the_first_spelling_and_drops_invalid(self):
        assert merged_tags(['VIP', 'a#b', ' churn '], ['vip', 'Beta', 7], None) == ['VIP', 'churn', 'Beta']

    def test_capped_at_twenty(self):
        tags = merged_tags([f't{i}' for i in range(15)], [f'u{i}' for i in range(15)])
        assert len(tags) == 20
        assert tags[-1] == 'u4'


def test_inferable_dimensions_skip_infer_false_and_empty():
    config = [*CONFIG, {'key': 'region', 'infer': True, 'values': []}]
    assert [d['key'] for d in inferable_dimensions(config)] == ['product', 'module']
