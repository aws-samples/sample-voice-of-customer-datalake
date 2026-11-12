"""shared/workspace_plugins.py: the workspaces a plugin's scheduled tick fans out over (docs/multi-workspace.md)."""
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table
from shared.workspace_plugins import PLUGIN_PARTITION_PREFIX, plugin_partition, workspaces_with_plugin

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
THIRD_WS = 'ws_3MZ7N2K4P6Q8R0S1T2V3W4X5Y6'


@pytest.fixture
def table():
    with mock_aws():
        yield create_pk_sk_table('voc-workspaces')


def _enable(table, plugin_id: str, *workspaces: str) -> None:
    for ws in workspaces:
        table.put_item(Item={'pk': f'PLUGIN#{plugin_id}', 'sk': f'WS#{ws}', 'enabled_at': '2026-11-01T00:00:00Z'})


class TestWorkspacesWithPlugin:
    def test_nothing_writes_the_rows_yet_so_a_tick_fans_out_to_nobody(self, table):
        assert workspaces_with_plugin(table, 'webscraper') == []

    def test_the_workspaces_that_enabled_the_plugin_in_key_order(self, table):
        _enable(table, 'webscraper', OTHER_WS, WS, THIRD_WS)

        assert workspaces_with_plugin(table, 'webscraper') == [WS, THIRD_WS, OTHER_WS]

    def test_only_this_plugins_partition_is_read(self, table):
        _enable(table, 'webscraper', WS)
        _enable(table, 'web_reviews', OTHER_WS)
        _enable(table, 'webscraper_v2', THIRD_WS)
        # The control plane's other rows of a workspace are never a plugin's.
        table.put_item(Item={'pk': f'WS#{OTHER_WS}', 'sk': 'META', 'name': 'Acme Outfitters'})

        assert workspaces_with_plugin(table, 'webscraper') == [WS]
        assert workspaces_with_plugin(table, 'web_reviews') == [OTHER_WS]

    @pytest.mark.parametrize('sort_key', [
        'WS#ws_nope', 'WS#', f'WS#{WS}#extra', f'WS#{WS.lower()}', 'META', f'MEMBER#{WS}', f'ws#{WS}',
    ])
    def test_a_row_that_names_no_well_formed_workspace_is_skipped(self, table, sort_key):
        table.put_item(Item={'pk': 'PLUGIN#webscraper', 'sk': sort_key})
        _enable(table, 'webscraper', OTHER_WS)

        assert workspaces_with_plugin(table, 'webscraper') == [OTHER_WS]

    def test_every_page_is_read(self):
        """A paged Query: an id on a later page is still run."""
        page_one = {'Items': [{'sk': f'WS#{WS}'}], 'LastEvaluatedKey': {'pk': 'PLUGIN#webscraper', 'sk': f'WS#{WS}'}}
        page_two = {'Items': [{'sk': f'WS#{OTHER_WS}'}]}
        paged = MagicMock()
        paged.query.side_effect = [page_one, page_two]

        assert workspaces_with_plugin(paged, 'webscraper') == [WS, OTHER_WS]
        assert paged.query.call_args_list[1].kwargs['ExclusiveStartKey'] == page_one['LastEvaluatedKey']

    def test_the_query_names_the_partition_and_reads_back_only_the_sort_key(self):
        reader = MagicMock()
        reader.query.return_value = {'Items': []}

        workspaces_with_plugin(reader, 'webscraper')

        reader.query.assert_called_once_with(
            KeyConditionExpression='#pk = :pk AND begins_with(#sk, :ws)',
            ExpressionAttributeNames={'#pk': 'pk', '#sk': 'sk'},
            ExpressionAttributeValues={':pk': 'PLUGIN#webscraper', ':ws': 'WS#'},
            ProjectionExpression='#sk',
            ConsistentRead=True,
        )

    def test_a_failed_read_raises_to_its_caller(self):
        """The caller decides: the tick's fan-out (base_ingestor.py ``fan_out_once``) logs and meters it, runs no
        workspace on that tick, and the next tick reads the list again."""
        reader = MagicMock()
        reader.query.side_effect = ClientError({'Error': {'Code': 'InternalServerError'}}, 'Query')

        with pytest.raises(ClientError):
            workspaces_with_plugin(reader, 'webscraper')

    @pytest.mark.parametrize('plugin_id', ['', 'Webscraper', 'web#scraper', '_web', 'web/../x', 'a' * 65])
    def test_a_malformed_plugin_id_reads_nothing(self, plugin_id):
        reader = MagicMock()

        with pytest.raises(ValueError, match='not a plugin id'):
            workspaces_with_plugin(reader, plugin_id)
        reader.query.assert_not_called()


def test_the_partition_is_the_plugins():
    assert plugin_partition('app_reviews_ios') == 'PLUGIN#app_reviews_ios'
    assert PLUGIN_PARTITION_PREFIX == 'PLUGIN#'
