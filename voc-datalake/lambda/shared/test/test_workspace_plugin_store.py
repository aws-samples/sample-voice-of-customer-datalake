"""shared/workspace_plugin_store.py, shared/workspace_credentials.py and shared/plugin_configs.py: what an operator
route reads and writes on either path (docs/multi-workspace.md, Credentials; decision 19). Deployment-wide the
shared secret; in a workspace each plugin's credentials SSM parameter and its config list's voc-aggregates row
(moto-backed)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.aws import SECRET_STRING_MAX_BYTES
from shared.exceptions import ConfigurationError, ConflictError, ValidationError
from shared.plugin_configs import ConfigRow, save_configs
from shared.test.moto_tables import create_pk_sk_table
from shared.workspace import WorkspaceContext
from shared.workspace_credentials import MalformedCredentials, read_credentials, save_credentials
from shared.workspace_plugin_store import (
    CredentialsStore,
    SharedSecretStore,
    StoreClients,
    WorkspaceStore,
    credentials_store,
)
from shared.ws_repo import WorkspaceScope, ws_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
PREFIX = '/voc/ws'
KEY = 'arn:aws:kms:us-east-1:123456789012:key/test'
ADMIN_SUB = 'sub-admin-one'
OTHER_SUB = 'sub-admin-two'


def _context(ws: str = WS) -> WorkspaceContext:
    return WorkspaceContext(ws=ws, role='admin', name='Team', slug='team', platform_admin=False)


class TestTheSharedSecretStore:
    def test_deployment_wide_the_shared_one(self):
        client, put = MagicMock(), MagicMock()
        client.get_secret_value.return_value = {'SecretString': '{"a_b": "c"}'}

        store = credentials_store(None, StoreClients('arn:shared', client, MagicMock(), put), actor=lambda: ADMIN_SUB)
        read = store.read()
        store.write({'a_b': 'd'})

        assert read == {'a_b': 'c'}

        client.get_secret_value.assert_called_once_with(SecretId='arn:shared')
        put.assert_called_once_with(client, 'arn:shared', {'a_b': 'd'})
        with pytest.raises(ConfigurationError):
            credentials_store(None, StoreClients('', client, MagicMock(), put), actor=lambda: ADMIN_SUB)

    def test_a_fault_raises_as_boto3_raised_it(self):
        client = MagicMock()
        client.get_secret_value.side_effect = ClientError({'Error': {'Code': 'ResourceNotFoundException'}}, 'Get')

        with pytest.raises(ClientError):  # the shared secret missing is the deployment's fault, raised as it was
            SharedSecretStore(StoreClients('arn:shared', client, None, MagicMock())).read()

    def test_a_secret_that_is_not_a_json_object_is_malformed(self):
        client = MagicMock()
        client.get_secret_value.return_value = {'SecretString': '["a"]'}

        with pytest.raises(ValueError, match='not a JSON object'):
            SharedSecretStore(StoreClients('arn:shared', client, None, MagicMock())).read()


@dataclass
class World:
    ssm: Any
    table: Any

    def open(self, *plugins: str, ws: str = WS, sub: str = ADMIN_SUB) -> WorkspaceStore:
        store = credentials_store(_context(ws), StoreClients('', MagicMock(), self.ssm, MagicMock()), plugins,
                                  actor=lambda: sub)
        assert isinstance(store, WorkspaceStore)
        return store

    def opened(self, *plugins: str, ws: str = WS) -> WorkspaceStore:
        """A store that has read what is saved (``write`` refuses before ``read``)."""
        store = self.open(*plugins, ws=ws)
        store.read()
        return store

    def config_row(self, plugin: str, ws: str = WS) -> dict:
        return self.table.get_item(Key={'pk': f'WS#{ws}#PLUGIN_CONFIG', 'sk': plugin})['Item']

    def history(self, ws: str = WS) -> list[dict]:
        return [row for row in self.table.scan()['Items'] if row['pk'] == f'WS#{ws}#PLUGIN_CONFIG#HISTORY']

    def value(self, name: str) -> str:
        return self.ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']

    def names(self) -> set[str]:
        return {p['Name'] for p in self.ssm.describe_parameters()['Parameters']}

    def config_rows(self) -> list[dict]:
        return self.table.scan()['Items']


@pytest.fixture
def world(monkeypatch) -> Iterator[World]:
    monkeypatch.setenv('WORKSPACE_PARAMETER_PREFIX', PREFIX)
    monkeypatch.setenv('WORKSPACE_PARAMETER_KEY_ARN', KEY)
    monkeypatch.setenv('AGGREGATES_TABLE', 'aggregates')
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        table = create_pk_sk_table('aggregates', resource)
        with patch('shared.workspace_plugin_store.get_dynamodb_resource', return_value=resource):
            yield World(boto3.client('ssm', region_name='us-east-1'), table)


class TestTheWorkspaceStoreIsOpenedFromTheResolvedMembership:
    def test_in_a_workspace_its_own(self, world):
        store = world.open('webscraper')

        assert (store.ws, store.plugins) == (WS, ('webscraper',))
        with pytest.raises(TypeError):
            credentials_store(SimpleNamespace(ws=OTHER),  # type: ignore[arg-type]
                              StoreClients('arn:shared', MagicMock(), MagicMock(), MagicMock()), actor=lambda: ADMIN_SUB)

    @pytest.mark.parametrize('unset', ['WORKSPACE_PARAMETER_PREFIX', 'AGGREGATES_TABLE'])
    def test_a_workspace_without_its_configuration_is_not_served_the_shared_secret(self, monkeypatch, unset):
        monkeypatch.setenv('WORKSPACE_PARAMETER_PREFIX', PREFIX)
        monkeypatch.setenv('AGGREGATES_TABLE', 'aggregates')
        monkeypatch.delenv(unset)

        with pytest.raises(ConfigurationError), patch('shared.workspace_plugin_store.get_dynamodb_resource'):
            credentials_store(_context(), StoreClients('arn:shared', MagicMock(), MagicMock(), MagicMock()),
                              actor=lambda: ADMIN_SUB)

    def test_a_write_without_the_key_is_refused_before_any_call(self, world, monkeypatch):
        monkeypatch.delenv('WORKSPACE_PARAMETER_KEY_ARN')

        with pytest.raises(ConfigurationError):
            world.opened('webscraper').write({'webscraper_api_key': 'k'})
        assert world.names() == set()

    @pytest.mark.parametrize('first', [None, 'read_lists'], ids=['nothing', 'only-the-lists'])
    def test_a_write_before_read_is_refused_and_writes_nothing(self, world, first):
        """``write`` keeps what did not change by comparing with what ``read`` returned, so without that read it
        would rewrite every parameter and list blind: it refuses, before any call."""
        world.opened('webscraper').write({'webscraper_api_key': 'k1', 'webscraper_configs': '["kept"]'})
        store = world.open('webscraper')
        if first is not None:
            getattr(store, first)()

        with patch.object(world.ssm, 'put_parameter') as put, \
                patch.object(world.table.meta.client, 'put_item') as rows, \
                pytest.raises(RuntimeError, match=r'read\(\) on this store first'):
            store.write({'webscraper_api_key': 'k2', 'webscraper_configs': '[]'})

        assert (put.call_args_list, rows.call_args_list) == ([], [])
        stored = world.open('webscraper').read()
        assert stored == {'webscraper_api_key': 'k1', 'webscraper_configs': '["kept"]'}

    def test_a_store_of_every_plugin_is_read_only(self, world):
        store: CredentialsStore = world.open()
        with pytest.raises(TypeError, match='read only'):
            store.write({'webscraper_api_key': 'k'})


class TestTheWorkspaceStore:
    def test_nothing_saved_reads_as_nothing(self, world):
        """ParameterNotFound and no row are "no credentials set": an empty object, never the shared secret."""
        one, every = world.open('app_reviews_ios').read(), world.open().read()

        assert (one, every) == ({}, {})

    def test_credentials_go_to_one_secure_string_and_the_list_to_one_row(self, world):
        store = world.open('app_reviews_ios')
        secrets = store.read()
        secrets.update({'app_reviews_ios_app_name': 'Example App', 'app_reviews_ios_configs': '[{"id": "a1"}]'})
        store.write(secrets)

        name = f'{PREFIX}/{WS}/credentials/app_reviews_ios'
        described = world.ssm.describe_parameters()['Parameters']
        assert [(p['Name'], p['Type'], p['Tier'], p.get('KeyId')) for p in described] == [
            (name, 'SecureString', 'Standard', KEY)]
        assert json.loads(world.value(name)) == {'app_name': 'Example App'}
        [row] = world.config_rows()
        assert (row['pk'], row['sk'], row['configs']) == (f'WS#{WS}#PLUGIN_CONFIG', 'app_reviews_ios', '[{"id": "a1"}]')
        read_back = world.open('app_reviews_ios').read()
        assert read_back == secrets

    def test_a_save_merges_and_writes_only_what_changed(self, world):
        first = world.open('webscraper')
        first.write({**first.read(), 'webscraper_configs': '[]', 'webscraper_api_key': 'k1'})
        second = world.open('webscraper')
        secrets = second.read()
        secrets['webscraper_region'] = 'eu'
        client = world.table.meta.client
        with patch.object(world.ssm, 'put_parameter', wraps=world.ssm.put_parameter) as put, \
                patch.object(client, 'put_item', wraps=client.put_item) as rows, \
                patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as transactions:
            second.write(secrets)

        assert [call.kwargs['Name'] for call in put.call_args_list] == [f'{PREFIX}/{WS}/credentials/webscraper']
        assert {**put.call_args.kwargs, 'Value': None} == {
            'Name': f'{PREFIX}/{WS}/credentials/webscraper', 'Value': None, 'Type': 'SecureString', 'KeyId': KEY,
            'Overwrite': True, 'Tier': 'Standard'}
        assert (rows.call_args_list, transactions.call_args_list) == ([], [])  # the list did not change
        assert world.history() == []
        read_back = world.open('webscraper').read()
        assert read_back == {'webscraper_api_key': 'k1', 'webscraper_region': 'eu', 'webscraper_configs': '[]'}

    def test_a_store_reads_and_writes_only_its_own_plugins(self, world):
        """Per-plugin isolation: another plugin's keys in the edited object are never written, and a read of one
        plugin never sees another's (nor another workspace's)."""
        world.opened('github_issues').write({'github_issues_token': 'secret-token'})
        world.opened('webscraper', ws=OTHER).write({'webscraper_api_key': 'other-workspace',
                                                  'webscraper_configs': '["other"]'})

        store = world.open('webscraper')
        secrets = store.read()
        assert secrets == {}
        store.write({**secrets, 'webscraper_api_key': 'k', 'github_issues_token': 'hijacked',
                     'app_reviews_ios_configs': '["x"]'})

        assert world.names() == {f'{PREFIX}/{WS}/credentials/github_issues', f'{PREFIX}/{WS}/credentials/webscraper',
                                 f'{PREFIX}/{OTHER}/credentials/webscraper'}
        assert json.loads(world.value(f'{PREFIX}/{WS}/credentials/github_issues')) == {'token': 'secret-token'}
        assert [(row['pk'], row['sk']) for row in world.config_rows()] == [(f'WS#{OTHER}#PLUGIN_CONFIG', 'webscraper')]
        read_back = world.open('webscraper').read()
        assert read_back == {'webscraper_api_key': 'k'}

    def test_every_plugin_of_the_workspace_for_the_status(self, world):
        world.opened('webscraper').write({'webscraper_configs': '[]'})
        world.opened('github_issues').write({'github_issues_token': 't'})
        world.opened('github_issues', ws=OTHER).write({'github_issues_token': 'other'})

        every = world.open().read()
        assert every == {'github_issues_token': 't', 'webscraper_configs': '[]'}

    def test_the_lists_alone_are_read_without_ssm(self, world):
        """The member-open list routes' read (``read_lists``): the config rows only, no credentials parameter."""
        world.opened('webscraper').write({'webscraper_configs': '[]', 'webscraper_api_key': 'k'})
        with patch.object(world.ssm, 'get_parameter') as one, \
                patch.object(world.ssm, 'get_paginator') as by_path:
            lists = world.open('webscraper', 'github_issues').read_lists()

        assert lists == {'webscraper_configs': '[]'}
        assert (one.call_args_list, by_path.call_args_list) == ([], [])

    def test_a_stray_name_under_the_path_is_not_a_plugin(self, world):
        world.ssm.put_parameter(Name=f'{PREFIX}/{WS}/credentials/Not-A-Plugin', Value='{"k": "v"}',
                                Type='SecureString')

        every = world.open().read()
        assert every == {}

    def test_one_malformed_parameter_does_not_hide_the_others_status(self, world):
        world.opened('github_issues').write({'github_issues_token': 't'})
        world.ssm.put_parameter(Name=f'{PREFIX}/{WS}/credentials/webscraper', Value='["a"]', Type='SecureString')
        with patch('shared.workspace_credentials.logger') as logger, \
                patch('shared.workspace_credentials.metrics') as metrics:
            every = world.open().read()

        assert every == {'github_issues_token': 't'}
        logger.warning.assert_called_once_with(
            "A workspace's credentials parameter is not a JSON object: left out",
            extra={'plugin_id': 'webscraper', 'error_type': 'MalformedCredentials'})
        # The webhooks' metric for the same fault.
        metrics.add_metric.assert_called_once_with(name='WorkspaceCredentialsMalformed', unit='Count', value=1)

    def test_a_list_too_large_leaves_the_credentials_unwritten_too(self, world):
        with pytest.raises(ValidationError, match=f'over the {SECRET_STRING_MAX_BYTES}-byte limit'):
            world.opened('webscraper').write({'webscraper_api_key': 'k',
                                            'webscraper_configs': json.dumps(['x' * SECRET_STRING_MAX_BYTES])})

        assert (world.names(), world.config_rows()) == (set(), [])

    def test_a_configs_list_is_stored_as_its_json_text(self, world):
        with pytest.raises(TypeError, match='JSON text'):
            world.opened('webscraper').write({'webscraper_configs': [{'id': 's1'}]})
        assert world.config_rows() == []

    def test_credentials_over_4096_bytes_are_refused_and_nothing_is_written(self, world):
        world.opened('webscraper').write({'webscraper_api_key': 'k'})
        store = world.open('webscraper')
        secrets = store.read()

        with pytest.raises(ValidationError, match=r'over the 4096-byte limit'):
            store.write({**secrets, 'webscraper_api_key': 'k' * 4100, 'webscraper_configs': '[]'})

        read_back = world.open('webscraper').read()
        assert read_back == {'webscraper_api_key': 'k'}  # the list was not written either

    def test_the_cap_counts_bytes_not_characters(self, world):
        """Under 4096 characters but over 4096 bytes in UTF-8: refused."""
        value = 'é' * 2100  # 2100 characters, 4200 bytes
        assert len(json.dumps({'api_key': value}, ensure_ascii=False)) < 4096

        with pytest.raises(ValidationError, match=r'over the 4096-byte limit'):
            world.opened('webscraper').write({'webscraper_api_key': value})
        assert world.names() == set()

    def test_exactly_4096_bytes_is_kept(self, world):
        value = 'x' * (4096 - len(json.dumps({'api_key': ''})))

        world.opened('webscraper').write({'webscraper_api_key': value})

        assert len(world.value(f'{PREFIX}/{WS}/credentials/webscraper').encode()) == 4096

    def test_a_list_takes_the_shared_secrets_own_limit_not_4_kb(self, world):
        """A list is a row (decision 19): what the shared secret holds fits; past its 64 KiB, a 400."""
        fits = json.dumps(['x' * 40_000])
        world.opened('webscraper').write({'webscraper_configs': fits})
        read_back = world.open('webscraper').read()
        assert read_back == {'webscraper_configs': fits}

        with pytest.raises(ValidationError, match=f'over the {SECRET_STRING_MAX_BYTES}-byte limit'):
            world.opened('webscraper').write({'webscraper_configs': json.dumps(['x' * SECRET_STRING_MAX_BYTES])})

    def test_a_parameter_that_is_not_a_json_object_is_malformed(self, world):
        world.ssm.put_parameter(Name=f'{PREFIX}/{WS}/credentials/webscraper', Value='["a"]', Type='SecureString')

        with pytest.raises(MalformedCredentials, match='not a JSON object'):
            world.open('webscraper').read()


def _save_list(world: World, configs: str, *, sub: str = ADMIN_SUB, ws: str = WS) -> None:
    store = world.open('webscraper', ws=ws, sub=sub)
    store.write({**store.read(), 'webscraper_configs': configs})


class TestTheConfigHistory:
    """A save that changes a list stamps the caller and keeps the list it replaced (D1/D2: kept, no ttl)."""

    def test_a_first_save_stamps_the_row_and_keeps_no_history(self, world):
        _save_list(world, '[{"id": "s1"}]')

        row = world.config_row('webscraper')
        assert (row['configs'], row['updated_by']) == ('[{"id": "s1"}]', ADMIN_SUB)
        assert isinstance(row['updated_at'], str)
        assert world.history() == []

    def test_a_changed_save_keeps_the_replaced_list_and_stamps_the_new_one(self, world):
        _save_list(world, '[{"id": "s1"}]')
        first = world.config_row('webscraper')

        _save_list(world, '[{"id": "s1"}, {"id": "s2"}]', sub=OTHER_SUB)

        current = world.config_row('webscraper')
        assert (current['configs'], current['updated_by']) == ('[{"id": "s1"}, {"id": "s2"}]', OTHER_SUB)
        assert current['updated_at'] > first['updated_at']
        [history] = world.history()
        prefix = f"webscraper#{current['updated_at']}#"
        assert history['sk'].startswith(prefix)
        assert len(history['sk']) > len(prefix)
        assert {name: value for name, value in history.items() if name not in ('pk', 'sk')} == {
            'configs': '[{"id": "s1"}]', 'updated_at': first['updated_at'],
            'updated_by': ADMIN_SUB, 'superseded_at': current['updated_at'], 'superseded_by_sub': OTHER_SUB}
        assert 'ttl' not in history  # kept forever: only INVITE# rows carry a ttl

    def test_every_change_adds_one_history_row(self, world):
        for configs in ('[1]', '[2]', '[3]'):
            _save_list(world, configs)

        assert sorted(row['configs'] for row in world.history()) == ['[1]', '[2]']

    def test_an_unchanged_save_writes_nothing(self, world):
        _save_list(world, '[{"id": "s1"}]')
        before = world.config_row('webscraper')
        client = world.table.meta.client

        with patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as transactions:
            _save_list(world, '[{"id": "s1"}]', sub=OTHER_SUB)

        assert transactions.call_args_list == []
        assert world.config_row('webscraper') == before
        assert world.history() == []

    @staticmethod
    def _read_then_raced(world: World, *theirs: str) -> tuple[WorkspaceStore, dict]:
        """My store and what it read, after which another admin saved each of ``theirs`` in turn."""
        mine = world.open('webscraper')
        read = mine.read()
        for configs in theirs:
            _save_list(world, configs, sub=OTHER_SUB)
        return mine, read

    def test_a_concurrent_save_is_a_conflict_and_loses_no_history(self, world):
        _save_list(world, '[0]')
        mine, read = self._read_then_raced(world, '[1]')

        with pytest.raises(ConflictError, match='changed by someone else') as raised:
            mine.write({**read, 'webscraper_configs': '[2]'})

        assert raised.value.status_code == 409
        row = world.config_row('webscraper')
        assert (row['configs'], row['updated_by']) == ('[1]', OTHER_SUB)
        assert [history['configs'] for history in world.history()] == ['[0]']

    def test_a_list_saved_away_and_back_is_still_a_conflict(self, world):
        """A to B and back to A since my read: the list is the same, its stamp is not, so my save is a 409."""
        _save_list(world, '[0]')
        mine, read = self._read_then_raced(world, '[1]', '[0]')

        with pytest.raises(ConflictError):
            mine.write({**read, 'webscraper_configs': '[2]'})

        assert (world.config_row('webscraper')['configs'], world.config_row('webscraper')['updated_by']) == (
            '[0]', OTHER_SUB)
        assert sorted(history['configs'] for history in world.history()) == ['[0]', '[1]']

    def test_two_first_saves_at_once_are_a_conflict(self, world):
        mine, read = self._read_then_raced(world, '[1]')

        with pytest.raises(ConflictError):
            mine.write({**read, 'webscraper_configs': '[2]'})

        assert world.config_row('webscraper')['configs'] == '[1]'
        assert world.history() == []

    def test_a_conflict_on_the_list_leaves_the_plugins_credentials_unwritten(self, world):
        """The list is saved before the credentials: its 409 writes nothing of the plugin."""
        _save_list(world, '[0]')
        mine, read = self._read_then_raced(world, '[1]')

        with pytest.raises(ConflictError):
            mine.write({**read, 'webscraper_configs': '[2]', 'webscraper_api_key': 'k'})

        assert world.names() == set()

    def test_a_row_without_a_stamp_is_replaced_only_while_it_has_none(self):
        table = MagicMock()

        save_configs(ws_table(WorkspaceScope(WS), table), 'webscraper', '[1]', replaced=ConfigRow('[0]', {}),
                     updated_by='s')

        [call] = table.meta.client.transact_write_items.call_args_list
        assert call.kwargs['TransactItems'][1]['Put']['ConditionExpression'] == (
            '#configs = :old AND attribute_not_exists(#updated_at)')

    def test_another_workspaces_history_is_never_touched(self, world):
        _save_list(world, '["other-0"]', ws=OTHER)
        _save_list(world, '["other-1"]', ws=OTHER)
        theirs = world.history(OTHER)
        client = world.table.meta.client

        with patch.object(client, 'transact_write_items', wraps=client.transact_write_items) as transactions:
            _save_list(world, '[0]')
            _save_list(world, '[1]')

        assert world.history(OTHER) == theirs
        assert [row['configs'] for row in world.history()] == ['[0]']
        written = [entry['Put']['Item']['pk'] for call in transactions.call_args_list
                   for entry in call.kwargs['TransactItems']]
        assert written
        assert all(pk.startswith(f'WS#{WS}#') for pk in written)

    def test_a_list_only_save_writes_no_credentials_parameter(self, world):
        """A save that changes only the list writes its config row, and no parameter at all (the credentials are
        unchanged: save_credentials writes only a change)."""
        store = world.open('webscraper')
        secrets = store.read()
        store.write({**secrets, 'webscraper_configs': '[{"id": "s1"}]'})
        assert world.names() == set()
        assert world.config_row('webscraper')['configs'] == '[{"id": "s1"}]'

    def test_a_list_is_saved_only_with_the_callers_sub(self, world):
        """``actor`` is required; one that answers no sub (an empty one) saves no list."""
        store = credentials_store(_context(), StoreClients('', MagicMock(), world.ssm, MagicMock()), ('webscraper',),
                                  actor=lambda: '')
        secrets = store.read()

        with pytest.raises(TypeError, match="caller's sub"):
            store.write({**secrets, 'webscraper_configs': '[1]', 'webscraper_api_key': 'k'})
        assert (world.names(), world.config_rows()) == (set(), [])
        store.write({**secrets, 'webscraper_api_key': 'k'})  # credentials alone need no sub
        assert world.names() == {f'{PREFIX}/{WS}/credentials/webscraper'}

    @pytest.mark.parametrize(('codes', 'expected'), [
        (['ThrottlingError'], ClientError),  # a fault, raised as boto3 raised it
        (['None', 'TransactionConflict'], ConflictError),  # another transaction on the row at that moment: the 409
        (['ConditionalCheckFailed'], ConflictError)])
    def test_a_cancelled_transaction_is_a_conflict_only_when_it_lost_a_race(self, codes, expected):
        table = MagicMock()
        table.meta.client.transact_write_items.side_effect = ClientError(
            {'Error': {'Code': 'TransactionCanceledException'},
             'CancellationReasons': [{'Code': code} for code in codes]}, 'TransactWriteItems')

        with pytest.raises(expected) as raised:
            save_configs(ws_table(WorkspaceScope(WS), table), 'webscraper', '[1]', replaced=ConfigRow('[0]', {}),
                         updated_by='s')
        assert getattr(raised.value, 'status_code', None) == (409 if expected is ConflictError else None)

    def test_the_new_row_is_conditioned_on_the_row_read(self):
        table = MagicMock()
        view = ws_table(WorkspaceScope(WS), table)
        replaced = ConfigRow('[0]', {'updated_at': '2026-11-13T10:00:00+00:00', 'updated_by': ADMIN_SUB})

        save_configs(view, 'webscraper', '[1]', replaced=replaced, updated_by=OTHER_SUB)
        save_configs(view, 'webscraper', '[0]', replaced=replaced, updated_by=OTHER_SUB)  # unchanged: nothing sent

        [call] = table.meta.client.transact_write_items.call_args_list
        history, current = (entry['Put'] for entry in call.kwargs['TransactItems'])
        assert history['ConditionExpression'] == 'attribute_not_exists(pk)'
        assert (history['Item']['pk'], history['Item']['updated_at'], history['Item']['updated_by']) == (
            f'WS#{WS}#PLUGIN_CONFIG#HISTORY', '2026-11-13T10:00:00+00:00', ADMIN_SUB)
        assert 'plugin' not in history['Item']  # its sort key starts with it
        assert (current['ConditionExpression'], current['ExpressionAttributeValues']) == (
            '#configs = :old AND #updated_at = :at', {':old': '[0]', ':at': '2026-11-13T10:00:00+00:00'})
        assert (current['Item']['pk'], current['Item']['updated_by']) == (f'WS#{WS}#PLUGIN_CONFIG', OTHER_SUB)


class TestTheCredentialsReads:
    def test_another_fault_raises_as_boto3_raised_it(self):
        client = MagicMock()
        client.get_parameter.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'GetParameter')

        with pytest.raises(ClientError):
            read_credentials(client, PREFIX, WS, 'webscraper')

    def test_a_bad_prefix_is_refused_before_any_call(self):
        client = MagicMock()

        with pytest.raises(ValueError, match='no parameter prefix') as raised:
            read_credentials(client, 'voc/ws', WS, 'webscraper')
        assert not isinstance(raised.value, MalformedCredentials)
        assert client.mock_calls == []

    def test_text_that_is_not_json_is_malformed(self):
        client = MagicMock()
        client.get_parameter.return_value = {'Parameter': {'Value': 'not json'}}

        with pytest.raises(MalformedCredentials):
            read_credentials(client, PREFIX, WS, 'webscraper')

    def test_unchanged_credentials_write_nothing(self):
        client = MagicMock()

        save_credentials(client, PREFIX, WS, 'webscraper', stored={'a': 'b'}, values={'a': 'b'}, key_id=KEY)

        assert client.mock_calls == []
