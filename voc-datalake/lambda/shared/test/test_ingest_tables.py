"""shared/ingest_tables.py: the tables of an ingestor run, deployment-wide or in a workspace."""
from unittest.mock import MagicMock

import pytest

from shared.ingest_tables import DeploymentTable, ingest_table
from shared.ws_repo import OutOfScopeError, WorkspaceScope, WorkspaceTable

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
SCOPE = WorkspaceScope(WS)


def test_a_run_in_a_workspace_gets_the_workspace_view():
    resource = MagicMock()

    table = ingest_table(SCOPE, resource, 'voc-watermarks', key='source')

    resource.Table.assert_called_once_with('voc-watermarks')
    assert isinstance(table, WorkspaceTable)
    assert (table.scope, table.key_attribute) == (SCOPE, 'source')
    with pytest.raises(OutOfScopeError):
        table.get_item({'source': 'web#last_id'})
    resource.Table.return_value.get_item.assert_not_called()


def test_a_deployment_wide_run_gets_the_table_itself_with_the_same_calls():
    resource = MagicMock()
    raw = resource.Table.return_value

    table = ingest_table(None, resource, 'voc-aggregates')

    resource.Table.assert_called_once_with('voc-aggregates')
    assert isinstance(table, DeploymentTable)
    assert table.scope is None
    table.get_item({'pk': 'SOURCE_RUN#web', 'sk': 'e1'})
    table.put_item({'pk': 'CIRCUIT#web', 'sk': 'TRIPPED'})
    table.update_item({'pk': 'SOURCE_RUN#web', 'sk': 'e1'}, UpdateExpression='SET #s = :s')
    table.delete_item({'pk': 'CIRCUIT#web', 'sk': 'TRIPPED'})
    raw.get_item.assert_called_once_with(Key={'pk': 'SOURCE_RUN#web', 'sk': 'e1'})
    raw.put_item.assert_called_once_with(Item={'pk': 'CIRCUIT#web', 'sk': 'TRIPPED'})
    raw.update_item.assert_called_once_with(Key={'pk': 'SOURCE_RUN#web', 'sk': 'e1'}, UpdateExpression='SET #s = :s')
    raw.delete_item.assert_called_once_with(Key={'pk': 'CIRCUIT#web', 'sk': 'TRIPPED'})


def test_a_deployment_wide_query_builds_the_condition_as_the_layer_does():
    raw = MagicMock()

    DeploymentTable(raw).query('pk', 'FAILURES#web', sort_condition='sk BETWEEN :start AND :end',
                               ExpressionAttributeValues={':start': 'a', ':end': 'b'})

    raw.query.assert_called_once_with(
        KeyConditionExpression='#p = :p AND sk BETWEEN :start AND :end', ExpressionAttributeNames={'#p': 'pk'},
        ExpressionAttributeValues={':start': 'a', ':end': 'b', ':p': 'FAILURES#web'})


def test_without_a_scope_the_boto3_table_itself_is_reachable_for_its_own_paging():
    resource = MagicMock()

    assert ingest_table(None, resource, 'voc-workspaces').table is resource.Table.return_value
