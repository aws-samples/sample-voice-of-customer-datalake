"""Tests for shared.category_access (pure policy) and shared.category_config."""
import dataclasses
import re

import pytest

from shared import category_access as ca
from shared.category_access import CategoryScope
from shared.category_config import validate_categories
from shared.project_access import Caller

ALICE = Caller(subject='sub-alice')
ADMIN = Caller(subject='sub-admin', is_admin=True)
CONFIG = [
    {'name': 'delivery', 'owners': [{'sub': 'sub-alice', 'username': 'alice', 'email': ''}]},
    {'name': 'billing', 'owners': [{'sub': 'sub-bob'}]},
    {'name': 'app'},
]


def _row(categories):
    return {**ca.access_key('sub-alice'), 'categories': categories}


# The source half of `GET /feedback/access` when no source is hidden.
_ALL_SOURCES = {'sources_all': True, 'sources': [], 'source_rule': 'all', 'sources_denied': []}


def _assign(target: object, field: str, value: object) -> None:
    """Plain attribute assignment, spelled so a frozen dataclass can be probed."""
    setattr(target, field, value)


def _scope_from_present_config(value: object) -> CategoryScope:
    """`scope_from_config` for a config that carries a scope (never None)."""
    scope = ca.scope_from_config(value)
    assert scope is not None
    return scope


class TestAccessRow:
    def test_access_key_is_the_documented_aggregates_key(self):
        assert ca.access_key('sub-alice') == {'pk': 'CATEGORY_ACCESS', 'sk': 'USER#sub-alice'}

    def test_stored_categories_distinguishes_no_row_malformed_and_listed(self):
        assert ca.stored_categories(None) is None
        assert ca.stored_categories(_row('everything')) == []
        assert ca.stored_categories(_row(['app', '', 3, 'billing'])) == ['app', 'billing']

    def test_owner_subs_drop_malformed_owners(self):
        category = {'owners': [{'username': 'no-sub'}, 'alice', {'sub': ''}, {'sub': 's1'}, {'sub': 's2'}]}
        assert ca.category_owner_subs(category) == frozenset({'s1', 's2'})
        assert ca.category_owner_subs({'owners': 's1'}) == frozenset()

    def test_owned_categories_ignore_nameless_entries_and_empty_subject(self):
        config = [*CONFIG, {'owners': [{'sub': 'sub-alice'}]}, {'name': '', 'owners': [{'sub': 'sub-alice'}]}, 'x']
        assert ca.owned_categories('sub-alice', config) == frozenset({'delivery'})
        assert ca.owned_categories('', config) == frozenset()


class TestCategoryScope:
    def test_scope_is_frozen_so_the_shared_constants_cannot_drift(self):
        with pytest.raises(dataclasses.FrozenInstanceError):
            _assign(ca.UNRESTRICTED, 'all', False)

    def test_constants_are_everything_and_nothing(self):
        assert ca.UNRESTRICTED.to_dict() == _ALL_SOURCES | {'all': True, 'categories': []}
        assert ca.NOTHING.to_dict() == _ALL_SOURCES | {'all': False, 'categories': []}

    def test_to_dict_sorts_names_and_blanks_them_when_unrestricted(self):
        scope = CategoryScope(all=False, categories=frozenset({'delivery', 'app'}))
        assert scope.to_dict() == _ALL_SOURCES | {'all': False, 'categories': ['app', 'delivery']}
        assert CategoryScope(all=True, categories=frozenset({'app'})).to_dict() == _ALL_SOURCES | {'all': True, 'categories': []}


class TestResolveScope:
    def test_admin_sees_everything_whatever_the_row(self):
        assert ca.resolve_scope(ADMIN, _row([]), CONFIG).to_dict() == _ALL_SOURCES | {'all': True, 'categories': []}

    def test_no_row_means_every_category(self):
        assert ca.resolve_scope(ALICE, None, CONFIG).to_dict() == _ALL_SOURCES | {'all': True, 'categories': []}

    def test_wildcard_row_means_every_category(self):
        assert ca.resolve_scope(ALICE, _row(['*', 'app']), CONFIG).to_dict() == _ALL_SOURCES | {'all': True, 'categories': []}

    def test_listed_categories_plus_owned_ones(self):
        scope = ca.resolve_scope(ALICE, _row(['app']), CONFIG)
        assert scope.to_dict() == _ALL_SOURCES | {'all': False, 'categories': ['app', 'delivery']}

    def test_malformed_row_fails_closed_to_owned_only(self):
        scope = ca.resolve_scope(ALICE, _row('everything'), CONFIG)
        assert scope.to_dict() == _ALL_SOURCES | {'all': False, 'categories': ['delivery']}

    def test_delegated_admin_token_is_not_an_admin(self):
        delegated = Caller(subject='sub-alice', is_admin=True, delegated=True)
        assert ca.resolve_scope(delegated, _row(['app']), CONFIG).to_dict() == _ALL_SOURCES | {
            'all': False, 'categories': ['app', 'delivery']}

    def test_credential_without_minter_sees_nothing(self):
        scope = ca.resolve_scope(Caller(subject='', delegated=True), None, CONFIG)
        assert scope.to_dict() == _ALL_SOURCES | {'all': False, 'categories': []}


class TestNeedsCategoriesConfig:
    @pytest.mark.parametrize(('caller', 'row', 'expected'), [
        (ADMIN, _row(['app']), False),
        (ALICE, None, False),
        (ALICE, _row(['*']), False),
        (ALICE, _row(['app']), True),
        (Caller(subject=''), _row(['app']), False),
    ])
    def test_only_restricted_rows_need_owner_lookup(self, caller, row, expected):
        assert ca.needs_categories_config(caller, row) is expected


class TestAdmits:
    scope = CategoryScope(all=False, categories=frozenset({'delivery'}))
    other = CategoryScope(all=False, categories=frozenset({'other'}))

    def test_unrestricted_admits_any_category_including_none(self):
        assert ca.admits(ca.UNRESTRICTED, 'delivery') is True
        assert ca.admits(ca.UNRESTRICTED, None) is True
        assert ca.visible_categories(ca.UNRESTRICTED, ['app', 'delivery']) == ['app', 'delivery']

    @pytest.mark.parametrize('category', [None, '', 7])
    def test_a_missing_or_malformed_category_reads_as_other(self, category):
        assert ca.item_category({'category': category}) == 'other'
        assert ca.admits(self.scope, category) is False
        assert ca.admits(self.other, category) is True

    def test_item_without_category_reads_as_other(self):
        assert ca.item_category({'feedback_id': 'x'}) == 'other'
        assert ca.admits_item(self.scope, {'feedback_id': 'x'}) is False
        assert ca.admits_item(self.other, {'feedback_id': 'x'}) is True
        assert ca.admits_item(self.scope, {'category': 'delivery'}) is True

    def test_filter_and_visible_keep_order(self):
        items = [{'category': 'app'}, {'category': 'delivery', 'n': 1}, {'category': 'delivery', 'n': 2}]
        assert ca.filter_items(self.scope, items) == items[1:]
        assert ca.filter_items(self.scope, iter(items)) == items[1:]
        assert ca.visible_categories(self.scope, ['app', 'delivery']) == ['delivery']
        assert ca.filter_items(ca.UNRESTRICTED, iter(items)) == items


class TestValidateAccessCategories:
    def test_wildcard_alone(self):
        assert ca.validate_access_categories(['*'], []) == ['*']

    @pytest.mark.parametrize(('value', 'message'), [
        ('delivery', "categories must be a list of category names or ['*']"),
        (None, "categories must be a list of category names or ['*']"),
        ([''], 'categories must contain only non-empty strings'),
        ([3], 'categories must contain only non-empty strings'),
        (['delivery', None], 'categories must contain only non-empty strings'),
        (['*', 'delivery'], "'*' cannot be combined with other categories"),
        (['delivery', 'delivery'], 'categories must not repeat'),
        (['nope'], '1 categories are not configured'),
        (['nope', 'delivery', 'nah'], '2 categories are not configured'),
    ])
    def test_rejects_with_a_client_safe_message(self, value, message):
        with pytest.raises(ValueError, match=f'^{re.escape(message)}$') as exc_info:
            ca.validate_access_categories(value, ['delivery'])
        assert str(exc_info.value) == message

    def test_at_most_fifty_categories(self):
        known = [f'c{i}' for i in range(51)]
        assert ca.validate_access_categories(known[:50], known) == known[:50]
        with pytest.raises(ValueError, match='At most 50 categories can be granted') as exc_info:
            ca.validate_access_categories(known, known)
        assert str(exc_info.value) == 'At most 50 categories can be granted'

    def test_known_names_and_empty_list(self):
        assert ca.validate_access_categories(['delivery'], ['delivery']) == ['delivery']
        assert ca.validate_access_categories([], ['delivery']) == []


class TestJobScopeConfig:
    def test_key_is_the_stored_job_config_field(self):
        assert ca.SCOPE_CONFIG_KEY == 'category_scope'

    def test_config_form_is_json_safe_and_sorted(self):
        scope = CategoryScope(all=False, categories=frozenset({'b', 'a'}))
        assert ca.scope_to_config(scope) == {'all': False, 'categories': ['a', 'b']}
        assert ca.scope_to_config(ca.UNRESTRICTED) == {'all': True, 'categories': []}

    def test_config_is_read_back_into_the_same_scope(self):
        scope = CategoryScope(all=False, categories=frozenset({'b', 'a'}))
        assert ca.scope_from_config({'all': False, 'categories': ['a', 'b']}) == scope
        assert _scope_from_present_config({'all': True, 'categories': []}).to_dict() == _ALL_SOURCES | {
            'all': True, 'categories': []}

    def test_restricted_config_drops_malformed_names(self):
        scope = _scope_from_present_config({'all': False, 'categories': ['a', '', 3]})
        assert scope.to_dict() == _ALL_SOURCES | {'all': False, 'categories': ['a']}

    def test_absent_is_legacy_unrestricted(self):
        assert ca.scope_from_config(None) is None

    @pytest.mark.parametrize('value', [
        'all',
        {'all': 'yes'},
        {'all': 1, 'categories': []},
        {'all': None, 'categories': ['a']},
        {'all': False, 'categories': 'delivery'},
        {'categories': ['a']},
    ])
    def test_malformed_config_fails_closed_to_nothing(self, value):
        assert _scope_from_present_config(value).to_dict() == _ALL_SOURCES | {'all': False, 'categories': []}

    def test_intersect_requested(self):
        scope = CategoryScope(all=False, categories=frozenset({'a', 'b'}))
        assert ca.intersect_requested(None, ['x']) == ['x']
        assert ca.intersect_requested(ca.UNRESTRICTED, None) is None
        assert ca.intersect_requested(ca.UNRESTRICTED, ['x']) == ['x']
        assert ca.intersect_requested(scope, None) == ['a', 'b']
        assert ca.intersect_requested(scope, []) == ['a', 'b']
        assert ca.intersect_requested(scope, ['b', 'x']) == ['b']
        assert ca.intersect_requested(scope, ['x']) == []
        assert ca.intersect_requested(ca.NOTHING, None) == []


class TestValidateCategories:
    def test_normalises_product_owners_and_drops_unknown_keys(self):
        result = validate_categories([{
            'id': 'delivery', 'name': 'delivery', 'description': ' Delivery ', 'color': 'red',
            'product': ' Shop ', 'owners': [{'sub': 's1', 'username': 'u', 'email': 'e@x', 'x': 1}],
            'subcategories': [{'name': 'late', 'description': 'Late'}],
        }])
        assert result == [{
            'name': 'delivery', 'id': 'delivery', 'description': 'Delivery', 'product': 'Shop',
            'owners': [{'sub': 's1', 'username': 'u', 'email': 'e@x'}],
            'subcategories': [{'name': 'late', 'description': 'Late'}],
        }]

    def test_optional_fields_may_be_absent_and_non_ascii_names_allowed(self):
        assert validate_categories([{'name': '配送'}]) == [
            {'name': '配送', 'description': '', 'subcategories': []}]

    @pytest.mark.parametrize(('categories', 'message'), [
        ('x', 'categories must be a list'),
        ([{'name': 'a b'}], 'Category name must be 1-'),
        ([{'name': 'a#b'}], 'Category name must be 1-'),
        ([{'name': '*'}], 'Category name must be 1-'),
        ([{'name': 'x' * 65}], 'Category name must be'),
        ([{'name': 'a'}, {'name': 'a'}], 'Category names must be unique'),
        ([{'name': 'a', 'description': 'd' * 501}], 'Category description must be at most'),
        ([{'name': 'a', 'product': 'p' * 121}], 'Category product must be at most'),
        ([{'name': 'a', 'owners': [{'sub': f's{i}'} for i in range(21)]}], 'at most 20 owners'),
        ([{'name': 'a', 'owners': [{'sub': 's'}, {'sub': 's'}]}], 'owners must not repeat'),
        ([{'name': 'a', 'owners': [{'username': 'no-sub'}]}], 'Each owner needs a sub'),
        ([{'name': 'a', 'subcategories': [{'name': 's'}, {'name': 's'}]}], 'Subcategory names must be unique'),
        ([{'name': f'c{i}'} for i in range(51)], 'At most 50 categories are allowed'),
        (['not-an-object'], 'Each category must be an object'),
    ])
    def test_rejects_invalid(self, categories, message):
        with pytest.raises(ValueError, match=message):
            validate_categories(categories)

    def test_fifty_is_allowed(self):
        assert len(validate_categories([{'name': f'c{i}'} for i in range(50)])) == 50

    def test_an_editor_derived_id_for_a_maximal_name_saves(self):
        """The Settings editor derives `cat_<slug>[_N]` for an id-less row."""
        name = 'n' * 64
        derived = f'cat_{name}_2'
        assert validate_categories([{'id': derived, 'name': name}])[0]['id'] == derived
