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



WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def test_a_workspace_s_restricted_sources_are_its_own(table):
    """The deployment restricts one source, the workspace another: each scope reads only its own row."""
    from shared.ws_repo import WorkspaceScope

    table.put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [{'id': 'deployment_app', 'restricted': True}]})
    table.put_item(Item={'pk': f'WS#{WS}#SETTINGS#sources', 'sk': 'config',
                         'sources': [{'id': 'team_app', 'restricted': True}]})
    assert category_gate.read_restricted_sources(table) == frozenset({'deployment_app'})
    assert category_gate.read_restricted_sources(table, WorkspaceScope(WS)) == frozenset({'team_app'})


def test_a_workspace_s_categories_config_is_its_own(table):
    """The strong read the write paths validate against: each scope reads only its own categories row."""
    from shared.ws_repo import WorkspaceScope

    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'billing'}]})
    table.put_item(Item={'pk': f'WS#{WS}#SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'returns'}]})
    assert [c['name'] for c in category_gate.read_categories_config(table)] == ['billing']
    assert [c['name'] for c in category_gate.read_categories_config(table, WorkspaceScope(WS))] == ['returns']


def test_a_member_s_category_scope_is_resolved_against_the_workspace_s_categories(table):
    """An owner of a category in the workspace sees it there; the deployment's categories do not count inside it."""
    from shared.ws_repo import WorkspaceScope

    owner = {'sub': 'owner-sub', 'username': 'olga', 'email': 'olga@example.com'}
    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'billing', 'owners': [owner]}]})
    table.put_item(Item={'pk': f'WS#{WS}#SETTINGS#categories', 'sk': 'config',
                         'categories': [{'name': 'returns', 'owners': [owner]}]})
    _grant(table, 'owner-sub', [])   # restricted: only what owning a category grants
    caller = Caller(subject='owner-sub', username='olga', email='olga@example.com')
    in_workspace = category_gate.scope_for_caller(caller, table, WorkspaceScope(WS))
    deployment = category_gate.scope_for_caller(caller, table)
    assert (ca.admits(in_workspace, 'returns'), ca.admits(in_workspace, 'billing')) == (True, False)
    assert (ca.admits(deployment, 'billing'), ca.admits(deployment, 'returns')) == (True, False)
