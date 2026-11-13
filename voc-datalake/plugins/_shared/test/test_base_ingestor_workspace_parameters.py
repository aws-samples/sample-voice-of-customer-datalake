"""A run in a workspace reads its plugin's own credentials parameter and config row (docs/multi-workspace.md,
decision 19; ``_shared/base_ingestor.py`` ``read_workspace_values`` over shared/workspace_credentials.py and
shared/plugin_configs.py).

The other plugin tests feed a workspace run's credentials through the patched ``get_secret`` (plugins/conftest.py
``workspace_parameters_through_get_secret``); these drive the REAL read over an SSM double and a table double
(``moto`` cannot run here: plugins/conftest.py ``no_real_aws_calls``): the one name it reads is its own plugin's in
its own workspace, its list is its own row, ``ParameterNotFound`` is "nothing saved", a failed read is not counted, a
bad prefix is a configuration error, and every run reads afresh.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared import base_ingestor
from _shared.test.ingestor_fixtures import ingestor_yielding
from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, WS
from shared.exceptions import ConfigurationError, SecretUnreadableError, WorkspaceCredentialsNotSet

#: The real read, taken before plugins/conftest.py stands its double in for it.
_REAL_READ = base_ingestor.read_workspace_values
PLUGIN = base_ingestor.SOURCE_PLATFORM
PREFIX = '/voc/ws'


def _name(ws: str, prefix: str = PREFIX) -> str:
    return f'{prefix}/{ws}/credentials/{PLUGIN}'


def _ssm(store: dict[str, str]) -> MagicMock:
    """An SSM double answering ``get_parameter`` from ``store`` (``ParameterNotFound`` for any other name)."""
    client = MagicMock()

    def get_parameter(Name: str, WithDecryption: bool) -> dict:
        assert WithDecryption is True
        if Name not in store:
            raise ClientError({'Error': {'Code': 'ParameterNotFound', 'Message': Name}}, 'GetParameter')
        return {'Parameter': {'Name': Name, 'Value': store[Name]}}

    client.get_parameter.side_effect = get_parameter
    return client


def _rows(table: MagicMock, rows: dict[tuple[str, str], str]) -> None:
    """The aggregates double answers ``get_item`` from ``rows`` by (pk, sk)."""
    def get_item(Key: dict, **_kwargs: object) -> dict:
        value = rows.get((Key['pk'], Key['sk']))
        return {} if value is None else {'Item': {**Key, 'configs': value}}

    table.get_item.side_effect = get_item


@pytest.fixture
def ssm(ingestor_aws) -> Iterator[MagicMock]:
    client = _ssm({})
    _rows(ingestor_aws.table, {})
    with patch.object(base_ingestor, 'read_workspace_values', _REAL_READ), \
            patch.object(base_ingestor, 'get_ssm_run_client', return_value=client), \
            patch.object(base_ingestor, 'WORKSPACE_PARAMETER_PREFIX', PREFIX), \
            patch.object(base_ingestor, 'AGGREGATES_TABLE', 'aggregates'), \
            patch.object(base_ingestor.CircuitBreaker, 'record_failure') as counted:
        client.counted = counted
        client.table = ingestor_aws.table
        yield client
    ingestor_aws.get_secret.assert_not_called()  # never the shared secret in a workspace


def _store(client: MagicMock, store: dict[str, str]) -> None:
    client.get_parameter.side_effect = _ssm(store).get_parameter.side_effect


def test_a_run_reads_its_own_plugins_one_parameter_and_row_in_its_own_workspace_only(ssm):
    _store(ssm, {
        _name(WS): json.dumps({'api_key': 'mine'}),
        f'{PREFIX}/{WS}/credentials/other_plugin': json.dumps({'api_key': 'not mine'}),
        _name(OTHER_WS): json.dumps({'api_key': 'another workspace'}),
    })
    _rows(ssm.table, {(f'WS#{WS}#PLUGIN_CONFIG', PLUGIN): '[{"id": "a1"}]',
                      (f'WS#{WS}#PLUGIN_CONFIG', 'other_plugin'): '["not mine"]'})

    assert ingestor_yielding().secrets == {'api_key': 'mine', 'configs': '[{"id": "a1"}]'}
    assert [call.kwargs['Name'] for call in ssm.get_parameter.call_args_list] == [_name(WS)]  # one GetParameter
    assert [call.kwargs['Key'] for call in ssm.table.get_item.call_args_list] == [
        {'pk': f'WS#{WS}#PLUGIN_CONFIG', 'sk': PLUGIN}]
    assert ssm.table.get_item.call_args.kwargs['ConsistentRead'] is True


def test_the_name_takes_the_deployment_prefix(ssm):
    _store(ssm, {_name(WS, '/stg-voc/ws'): json.dumps({'api_key': 'staging'})})

    with patch.object(base_ingestor, 'WORKSPACE_PARAMETER_PREFIX', '/stg-voc/ws'):
        assert ingestor_yielding().secrets == {'api_key': 'staging'}
    assert [call.kwargs['Name'] for call in ssm.get_parameter.call_args_list] == [_name(WS, '/stg-voc/ws')]


def test_another_workspaces_run_reads_that_workspaces_name(ssm):
    _store(ssm, {_name(OTHER_WS): json.dumps({'api_key': 'theirs'})})

    assert ingestor_yielding(scope=OTHER_SCOPE).secrets == {'api_key': 'theirs'}
    assert [call.kwargs['Name'] for call in ssm.get_parameter.call_args_list] == [_name(OTHER_WS)]


def test_a_list_alone_is_something_saved(ssm):
    _rows(ssm.table, {(f'WS#{WS}#PLUGIN_CONFIG', PLUGIN): '[]'})

    assert ingestor_yielding().secrets == {'configs': '[]'}


def test_nothing_saved_is_credentials_not_set_and_not_counted(ssm):
    with pytest.raises(WorkspaceCredentialsNotSet, match=f"No credentials of '{PLUGIN}'"):
        ingestor_yielding()

    ssm.counted.assert_not_called()


def test_a_failed_read_is_unreadable_not_counted_and_not_credentials_not_set(ssm):
    ssm.get_parameter.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetParameter')

    with pytest.raises(SecretUnreadableError) as raised:
        ingestor_yielding()

    assert not isinstance(raised.value, WorkspaceCredentialsNotSet)
    ssm.counted.assert_not_called()


def test_a_parameter_that_is_not_a_json_object_is_a_counted_misconfiguration(ssm):
    _store(ssm, {_name(WS): '["a"]'})

    with pytest.raises(ConfigurationError, match='not a JSON object') as raised:
        ingestor_yielding()

    assert not isinstance(raised.value, SecretUnreadableError)
    ssm.counted.assert_called_once()


def test_a_bad_prefix_is_a_configuration_error_not_a_malformed_parameter(ssm):
    with patch.object(base_ingestor, 'WORKSPACE_PARAMETER_PREFIX', 'voc/ws'), \
            pytest.raises(ConfigurationError, match='WORKSPACE_PARAMETER_PREFIX') as raised:
        ingestor_yielding()

    assert 'not a JSON object' not in str(raised.value)
    assert not isinstance(raised.value, SecretUnreadableError)
    ssm.get_parameter.assert_not_called()


def test_a_run_without_the_aggregates_table_is_a_configuration_error_not_a_dropped_list(ssm):
    with patch.object(base_ingestor, 'AGGREGATES_TABLE', ''), \
            pytest.raises(ConfigurationError, match='AGGREGATES_TABLE not configured'):
        ingestor_yielding()

    ssm.get_parameter.assert_not_called()


def test_every_run_reads_afresh_so_a_save_takes_effect_on_the_next_one(ssm):
    with pytest.raises(WorkspaceCredentialsNotSet):
        ingestor_yielding()
    _store(ssm, {_name(WS): json.dumps({'api_key': 'saved a moment ago'})})

    assert ingestor_yielding().secrets == {'api_key': 'saved a moment ago'}
    assert ssm.get_parameter.call_count == 2
