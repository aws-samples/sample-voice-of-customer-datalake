"""shared.category_access: the source rule (category AND source, KVD contract)."""
import pytest

from shared import category_access as ca
from shared.category_access import CategoryScope
from shared.project_access import Caller

ALICE = Caller(subject='sub-alice')
ADMIN = Caller(subject='sub-admin', is_admin=True)
RESTRICTED = frozenset({'support_tickets'})
SALES = {'source_platform': 'sales_csv', 'category': 'billing'}
TICKET = {'source_platform': 'support_tickets', 'category': 'billing'}


def _row(**fields):
    return {**ca.access_key('sub-alice'), **fields}


@pytest.mark.parametrize(('row', 'sees_tickets'), [
    (None, False),                                  # no row: restricted sources hidden
    (_row(categories=['*']), False),                # no sources field: same
    (_row(sources=['*']), True),                    # wildcard: every source incl. restricted
    (_row(sources=['support_tickets']), True),      # explicit grant
    (_row(sources=['sales_csv']), False),           # list: exactly those
    (_row(sources='junk'), False),                  # malformed: fails closed
])
def test_the_source_rule(row, sees_tickets):
    scope = ca.resolve_scope(ALICE, row, [], RESTRICTED)
    assert ca.admits_item(scope, TICKET) is sees_tickets


def test_a_list_grant_hides_every_unlisted_source_even_unrestricted_ones():
    scope = ca.resolve_scope(ALICE, _row(sources=['support_tickets']), [], RESTRICTED)
    assert (ca.admits_item(scope, SALES), ca.admits_item(scope, TICKET)) == (False, True)


def test_admins_see_every_source():
    assert ca.resolve_scope(ADMIN, _row(sources=[]), [], RESTRICTED) is ca.UNRESTRICTED


def test_all_is_false_whenever_the_source_rule_hides_anything():
    scope = ca.resolve_scope(ALICE, None, [], RESTRICTED)
    assert (scope.all, scope.categories_all, scope.sources_all) == (False, True, False)
    assert ca.resolve_scope(ALICE, None, [], frozenset()) == ca.UNRESTRICTED


def test_the_category_rule_is_unaffected_by_a_source_restriction():
    scope = ca.resolve_scope(ALICE, None, [], RESTRICTED)
    assert ca.admits(scope, 'billing') is True
    assert ca.intersect_requested(scope, ['billing']) == ['billing']
    assert ca.intersect_requested(scope, None) is None
    assert ca.visible_categories(scope, ['a', 'b']) == ['a', 'b']


def test_both_rules_must_admit():
    scope = ca.resolve_scope(ALICE, _row(categories=['delivery'], sources=['*']), [], RESTRICTED)
    assert ca.admits_item(scope, TICKET) is False
    assert ca.filter_items(scope, [TICKET, {**TICKET, 'category': 'delivery'}]) == [{**TICKET, 'category': 'delivery'}]


def test_to_dict_reports_the_source_rule():
    assert ca.resolve_scope(ALICE, _row(sources=['b', 'a']), [], RESTRICTED).to_dict() == {
        'all': True, 'categories': [], 'sources_all': False, 'sources': ['a', 'b'],
        'source_rule': 'allow', 'sources_denied': []}
    assert ca.resolve_scope(ALICE, None, [], RESTRICTED).to_dict() == {
        'all': True, 'categories': [], 'sources_all': False, 'sources': [],
        'source_rule': 'deny', 'sources_denied': sorted(RESTRICTED)}
    assert ca.resolve_scope(ALICE, _row(sources=['*']), [], RESTRICTED).to_dict()['source_rule'] == 'all'


@pytest.mark.parametrize(('caller', 'row', 'expected'), [
    (ADMIN, None, False), (Caller(subject=''), None, False), (ALICE, None, True),
    (ALICE, _row(categories=['a']), True), (ALICE, _row(sources=['*']), False), (ALICE, _row(sources=[]), False),
])
def test_needs_restricted_sources(caller, row, expected):
    assert ca.needs_restricted_sources(caller, row) is expected


@pytest.mark.parametrize('scope', [
    CategoryScope(all=True, source_deny=RESTRICTED),
    CategoryScope(all=False, categories=frozenset({'a'}), source_allow=frozenset({'x'})),
    CategoryScope(all=False, categories=frozenset({'a'}), source_allow=frozenset()),
])
def test_job_config_round_trips_the_source_rule(scope):
    config = ca.scope_to_config(scope)
    assert config['all'] is False
    assert ca.scope_from_config(config) == scope


@pytest.mark.parametrize('config', [
    {'all': False, 'categories': [], 'source_deny': 'x', 'categories_all': True},
    {'all': False, 'categories': [], 'source_deny': [], 'source_allow': 'x', 'categories_all': True},
    {'all': False, 'categories': [], 'source_deny': []},
])
def test_a_malformed_source_config_fails_closed(config):
    assert ca.scope_from_config(config) == ca.NOTHING


class TestValidateAccessSources:
    def test_wildcard_known_and_empty(self):
        assert ca.validate_access_sources(['*'], []) == ['*']
        assert ca.validate_access_sources(['a'], ['a', 'b']) == ['a']
        assert ca.validate_access_sources([], ['a']) == []

    @pytest.mark.parametrize(('value', 'message'), [
        ('a', "sources must be a list of source ids or ['*']"),
        ([3], 'sources must contain only non-empty strings'),
        (['*', 'a'], "'*' cannot be combined with other sources"),
        (['a', 'a'], 'sources must not repeat'),
        (['zz'], '1 sources are not configured'),
        ([f's{i}' for i in range(51)], 'At most 50 sources can be granted'),
    ])
    def test_refusals(self, value, message):
        with pytest.raises(ValueError, match='sources') as exc_info:
            ca.validate_access_sources(value, ['a'])
        assert str(exc_info.value) == message
