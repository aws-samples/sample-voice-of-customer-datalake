"""workspaces_handler.py: the plugins of the workspace X-Workspace-Id names, under /me/workspaces/current/plugins
(moto-backed; docs/multi-workspace.md, "Per-workspace configuration"; the rules: shared/workspace_plugin_settings.py)."""
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from moto_helpers import invoke, pk_sk_table, rest_event

import workspaces_handler
from shared.test.cognito_doubles import live_cognito
from shared.workspace import MembershipCache

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
PLUGINS = '/me/workspaces/current/plugins'
CEILING = '["webscraper", "app_reviews_ios"]'
ADA = {'sub': 'sub-ada', 'cognito:username': 'ada', 'cognito:groups': 'users'}
VIC = {'sub': 'sub-vic', 'cognito:username': 'vic', 'cognito:groups': 'users'}
PAT = {'sub': 'sub-pat', 'cognito:username': 'pat', 'cognito:groups': '[admins, platform-admins]'}


@dataclass
class World:
    table: Any
    cognito: MagicMock


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    monkeypatch.setenv('ENABLED_SOURCES', CEILING)
    monkeypatch.setattr(workspaces_handler, 'memberships', MembershipCache())
    monkeypatch.setattr(workspaces_handler, 'USER_POOL_ID', 'us-east-1_pool')
    cognito = live_cognito()
    monkeypatch.setattr(workspaces_handler, 'get_cognito_idp_client', lambda: cognito)
    with mock_aws():
        table = pk_sk_table('workspaces')
        rows = [{'pk': f'WS#{WS}', 'sk': 'META', 'name': 'Acme Outfitters', 'slug': 'acme', 'status': 'active'},
                {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada', 'role': 'admin'},
                {'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-vic', 'role': 'viewer'}]
        for row in rows:
            table.put_item(Item=row)
        yield World(table, cognito)


def _call(world, lambda_context, method, path, claims=ADA, body=None):
    event = rest_event(method, path, claims=claims, body=body)
    event['headers']['X-Workspace-Id'] = WS
    return invoke(workspaces_handler, event, lambda_context, workspaces=world.table)


def _row(world, plugin):
    return world.table.get_item(Key={'pk': f'PLUGIN#{plugin}', 'sk': f'WS#{WS}'}).get('Item')


def _audit(world):
    rows = world.table.query(KeyConditionExpression='pk = :pk',
                             ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    return sorted((row['kind'], row.get('plugin')) for row in rows)


@pytest.mark.parametrize('claims', [ADA, VIC], ids=['admin', 'viewer'])
def test_every_member_lists_the_plugins_the_deployment_offers_in_its_order(world, lambda_context, claims):
    assert _call(world, lambda_context, 'GET', PLUGINS, claims=claims) == (200, {'plugins': [
        {'id': 'webscraper', 'enabled': False}, {'id': 'app_reviews_ios', 'enabled': False}]})


def test_another_workspace_s_enabled_plugin_is_not_this_one_s(world, lambda_context):
    world.table.put_item(Item={'pk': 'PLUGIN#webscraper', 'sk': 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9',
                               'enabled_by': 'sub-other', 'enabled_at': '2026-11-12T00:00:00Z'})
    _, listed = _call(world, lambda_context, 'GET', PLUGINS)
    assert [(p['id'], p['enabled']) for p in listed['plugins']] == [('webscraper', False), ('app_reviews_ios', False)]


def test_an_admin_enables_a_plugin_audited_first_and_the_ingestor_s_partition_holds_it(world, lambda_context):
    status, body = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True})
    assert status == 200
    assert body['plugin']['id'] == 'webscraper'
    assert body['plugin']['enabled'] is True
    assert _row(world, 'webscraper')['enabled_by'] == 'sub-ada'
    assert _audit(world) == [('plugin_enabled', 'webscraper')]
    _, listed = _call(world, lambda_context, 'GET', PLUGINS)
    assert [(p['id'], p['enabled']) for p in listed['plugins']] == [('webscraper', True), ('app_reviews_ios', False)]


def test_an_admin_disables_it_again(world, lambda_context):
    _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True})
    assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': False}) == (
        200, {'plugin': {'id': 'webscraper', 'enabled': False}})
    assert _row(world, 'webscraper') is None
    assert _audit(world) == [('plugin_disabled', 'webscraper'), ('plugin_enabled', 'webscraper')]


def test_asking_for_what_holds_changes_and_records_nothing(world, lambda_context):
    assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': False}) == (
        200, {'plugin': {'id': 'webscraper', 'enabled': False}})
    assert (_row(world, 'webscraper'), _audit(world)) == (None, [])


def test_enabling_an_enabled_plugin_changes_nothing_and_answers_it_as_get_does(world, lambda_context):
    _, first = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True})
    assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True}) == (200, first)
    assert _audit(world) == [('plugin_enabled', 'webscraper')]


def test_a_viewer_is_refused_and_nothing_changes(world, lambda_context):
    status, _ = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', claims=VIC, body={'enabled': True})
    assert status == 403
    assert (_row(world, 'webscraper'), _audit(world)) == (None, [])


@pytest.mark.parametrize('plugin', ['synthetic_reviews', 'Not-A-Plugin', 'webscraper%23x'])
def test_a_plugin_the_deployment_does_not_offer_is_the_one_404(world, lambda_context, plugin):
    assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/{plugin}', body={'enabled': True}) == (
        404, {'success': False, 'error': 'Plugin not found'})
    assert _audit(world) == []


@pytest.mark.parametrize('body', [{'enabled': 'yes'}, {}, {'enabled': True, 'extra': 1}])
def test_a_bad_body_is_a_400(world, lambda_context, body):
    status, _ = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body=body)
    assert status == 400
    assert _audit(world) == []


def test_a_platform_admin_enables_one_audited_as_such(world, lambda_context):
    status, _ = _call(world, lambda_context, 'PUT', f'{PLUGINS}/app_reviews_ios', claims=PAT, body={'enabled': True})
    assert status == 200
    kinds = world.table.query(KeyConditionExpression='pk = :pk',
                              ExpressionAttributeValues={':pk': f'AUDIT#WS#{WS}'})['Items']
    assert sorted(row['kind'] for row in kinds) == ['platform_admin_entry', 'plugin_enabled']
    assert next(row for row in kinds if row['kind'] == 'plugin_enabled')['platform_admin'] is True


def test_an_admin_demoted_meanwhile_is_refused_at_commit(world, lambda_context):
    real = workspaces_handler.set_plugin_enabled

    def demote_first(table, context, *args):
        table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'MEMBER#sub-ada'}, UpdateExpression='SET #r = :v',
                          ExpressionAttributeNames={'#r': 'role'}, ExpressionAttributeValues={':v': 'editor'})
        return real(table, context, *args)

    with patch.object(workspaces_handler, 'set_plugin_enabled', demote_first):
        status, body = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True})
    assert (status, body['error']) == (403, 'You are no longer an admin of this workspace')
    assert _row(world, 'webscraper') is None


def test_a_workspace_set_to_deleting_meanwhile_is_the_one_404(world, lambda_context):
    real = workspaces_handler.set_plugin_enabled

    def delete_first(table, context, *args):
        table.update_item(Key={'pk': f'WS#{WS}', 'sk': 'META'}, UpdateExpression='SET #s = :v',
                          ExpressionAttributeNames={'#s': 'status'}, ExpressionAttributeValues={':v': 'deleting'})
        return real(table, context, *args)

    with patch.object(workspaces_handler, 'set_plugin_enabled', delete_first):
        assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True}) == (
            404, {'success': False, 'error': 'Workspace not found'})
    assert _row(world, 'webscraper') is None


def test_a_row_written_meanwhile_is_409_and_the_attempt_stays_audited(world, lambda_context):
    real = workspaces_handler.set_plugin_enabled

    def enable_first(table, context, *args):
        table.put_item(Item={'pk': 'PLUGIN#webscraper', 'sk': f'WS#{WS}', 'enabled_by': 'sub-other',
                             'enabled_at': '2026-11-12T00:00:00Z'})
        real_get = table.get_item
        with patch.object(table, 'get_item', lambda **kw: {} if kw['Key']['pk'] == 'PLUGIN#webscraper' else real_get(**kw)):
            return real(table, context, *args)

    with patch.object(workspaces_handler, 'set_plugin_enabled', enable_first):
        assert _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True}) == (
            409, {'success': False, 'error': "The workspace's plugins changed meanwhile: reload them and try again"})
    assert _row(world, 'webscraper')['enabled_by'] == 'sub-other'
    assert _audit(world) == [('plugin_enabled', 'webscraper')]


def test_a_transaction_conflict_is_409(world, lambda_context):
    conflict = ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
                            'CancellationReasons': [{'Code': 'None'}, {'Code': 'None'}, {'Code': 'TransactionConflict'}]},
                           'TransactWriteItems')
    with patch.object(world.table.meta.client, 'transact_write_items', side_effect=conflict):
        status, _ = _call(world, lambda_context, 'PUT', f'{PLUGINS}/webscraper', body={'enabled': True})
    assert status == 409
    assert _row(world, 'webscraper') is None


@pytest.mark.parametrize(('path', 'body', 'status'), [
    (f'{PLUGINS}/synthetic_reviews', {'enabled': True}, 404), (f'{PLUGINS}/webscraper', {'enabled': 'yes'}, 400)])
def test_a_bad_request_is_refused_before_a_platform_admin_s_entry_is_audited(world, lambda_context, path, body,
                                                                            status):
    assert _call(world, lambda_context, 'PUT', path, claims=PAT, body=body)[0] == status
    assert _audit(world) == []


def test_a_fault_answers_the_fixed_500(world, lambda_context):
    fault = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'arn:aws:dynamodb:table'}}, 'GetItem')
    with patch.object(workspaces_handler, 'workspace_plugins', side_effect=fault):
        assert _call(world, lambda_context, 'GET', PLUGINS) == (
            500, {'success': False, 'error': "Failed to list the workspace's plugins"})
