"""Tests for shared.category_gate: the one read behind every category decision."""
from unittest.mock import MagicMock

import pytest
from moto import mock_aws

from shared import category_access as ca
from shared import category_gate
from shared.api import clear_categories_cache
from shared.exceptions import AuthorizationError
from shared.project_access import ACTING_SUBJECT_CLAIM, Caller
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def table():
    clear_categories_cache()
    with mock_aws():
        yield create_pk_sk_table('aggregates')
    clear_categories_cache()


def _event(claims):
    return {'requestContext': {'authorizer': {'claims': claims}}}


def _grant(table, sub, categories):
    table.put_item(Item={**ca.access_key(sub), 'categories': categories})


def test_admin_is_decided_without_a_read():
    table = MagicMock()
    scope = category_gate.scope_for_event(_event({'sub': 'a', 'cognito:groups': 'admins'}), table)
    assert scope == ca.UNRESTRICTED
    table.get_item.assert_not_called()


def test_no_row_reads_unrestricted(table):
    assert category_gate.scope_for_caller(Caller(subject='u1'), table) == ca.UNRESTRICTED


def test_restricted_row_includes_owned_categories(table):
    _grant(table, 'u1', ['app'])
    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [
        {'name': 'delivery', 'owners': [{'sub': 'u1'}]}, {'name': 'app'}]})
    scope = category_gate.scope_for_caller(Caller(subject='u1'), table)
    assert scope.categories == frozenset({'app', 'delivery'})


def test_delegated_credential_resolves_through_its_minter(table):
    _grant(table, 'minter', ['app'])
    claims = {'sub': 'mcp:tok1', 'cognito:groups': '', ACTING_SUBJECT_CLAIM: 'minter'}
    scope = category_gate.scope_for_event(_event(claims), table)
    assert scope == ca.CategoryScope(all=False, categories=frozenset({'app'}))


def test_delegated_credential_without_minter_sees_nothing(table):
    scope = category_gate.scope_for_event(_event({'sub': 'mcp:tok1'}), table)
    assert scope == ca.NOTHING


def test_missing_subject_is_refused():
    with pytest.raises(AuthorizationError):
        category_gate.scope_for_event(_event({}), MagicMock())


def test_read_categories_config_is_fresh_and_drops_malformed(table):
    assert category_gate.read_categories_config(table) == []
    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                         'categories': [{'name': 'a'}, {'description': 'no name'}, 'junk']})
    assert category_gate.read_categories_config(table) == [{'name': 'a'}]
