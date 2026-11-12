"""The shared pieces of the aggregator's and the read APIs' two paths (docs/multi-workspace.md).

shared/scoped_query.py (one Query, deployment-wide as before or through ``ws_table``), shared/workspace_request.py
(the request's workspace), shared/metric_keys.py ``metric_partition`` / ``metric_type_partition``, the scoped
data_version and watermark (shared/data_version.py, shared/earliest_date.py), ``BatchBump`` per scope, and the
layer's ``check_update`` / ``check_keys`` (shared/ws_repo.py).
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.data_version import BatchBump, bump_data_version, data_version_key, read_versions
from shared.earliest_date import earliest_date_key, lower_watermark_request
from shared.exceptions import NotFoundError, ServiceError, ValidationError
from shared.metric_keys import DAILY_TOTAL_PK, metric_partition, metric_type_partition
from shared.scoped_query import SortRange, query_partition
from shared.workspace import MembershipCache
from shared.workspace_request import RequestWorkspace
from shared.ws_repo import OutOfScopeError, scope_from_key

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
SCOPE = scope_from_key(f'WS#{WS}#SOURCE#web')


class TestQueryPartition:
    def test_deployment_wide_it_sends_the_request_it_always_sent(self):
        table = MagicMock()
        query_partition(None, table, 'pk', 'METRIC#daily_total', sort=SortRange('sk', 'between', 'a', 'b'),
                        ScanIndexForward=False)

        table.query.assert_called_once_with(
            KeyConditionExpression=Key('pk').eq('METRIC#daily_total') & Key('sk').between('a', 'b'),
            ScanIndexForward=False)

    def test_in_a_workspace_the_layer_builds_the_key_condition(self):
        table = MagicMock()
        query_partition(SCOPE, table, 'gsi3pk', f'WS#{WS}#URGENCY#high', sort=SortRange('gsi3sk', 'gte', '2026'),
                        IndexName='gsi3-by-urgency', ExpressionAttributeNames={'#pf0': 'pk'})

        request = table.query.call_args.kwargs
        assert request['KeyConditionExpression'] == '#p = :p AND #sk >= :sk0'
        assert request['ExpressionAttributeNames'] == {'#pf0': 'pk', '#sk': 'gsi3sk', '#p': 'gsi3pk'}
        assert request['ExpressionAttributeValues'] == {':sk0': '2026', ':p': f'WS#{WS}#URGENCY#high'}
        assert request['IndexName'] == 'gsi3-by-urgency'

    def test_a_partition_or_a_cursor_outside_the_workspace_is_refused_before_dynamodb(self):
        table = MagicMock()
        with pytest.raises(OutOfScopeError):
            query_partition(SCOPE, table, 'gsi1pk', 'DATE#2026-01-01')
        with pytest.raises(OutOfScopeError):
            query_partition(SCOPE, table, 'gsi1pk', f'WS#{OTHER}#DATE#2026-01-01')
        for cursor in ({'pk': 'SOURCE#web', 'sk': 'x', 'gsi1pk': f'WS#{WS}#DATE#d'},
                       {'pk': f'WS#{OTHER}#SOURCE#web', 'sk': 'x', 'gsi1pk': f'WS#{WS}#DATE#d'},
                       {'pk': f'WS#{WS}#SOURCE#web', 'sk': 'x', 'gsi1pk': 'DATE#d'}):
            with pytest.raises(OutOfScopeError):
                query_partition(SCOPE, table, 'gsi1pk', f'WS#{WS}#DATE#d', ExclusiveStartKey=cursor)
        table.query.assert_not_called()


class TestCounterNames:
    def test_a_counter_and_its_type_under_a_workspace(self):
        assert metric_partition(None, DAILY_TOTAL_PK) == 'METRIC#daily_total'
        assert metric_partition(SCOPE, DAILY_TOTAL_PK) == f'WS#{WS}#METRIC#daily_total'
        assert metric_partition(SCOPE, 'METRIC#daily_source#') == f'WS#{WS}#METRIC#daily_source#'
        assert metric_type_partition(None, 'source') == 'source'
        assert metric_type_partition(SCOPE, 'dim_sentiment#plan') == f'WS#{WS}#dim_sentiment#plan'

    def test_only_a_counter_is_moved_under_a_workspace(self):
        with pytest.raises(ValueError, match='counter'):
            metric_partition(SCOPE, 'SETTINGS#categories')
        with pytest.raises(ValueError, match='counter'):
            metric_partition(SCOPE, 'METRIC#')

    def test_the_meta_rows(self):
        assert data_version_key() == {'pk': 'METRIC#meta', 'sk': 'data_version'}
        assert data_version_key(SCOPE) == {'pk': f'WS#{WS}#METRIC#meta', 'sk': 'data_version'}
        assert earliest_date_key(SCOPE) == {'pk': f'WS#{WS}#METRIC#meta', 'sk': 'earliest_date'}
        assert lower_watermark_request('2026-01-01', 'now', SCOPE)['Key'] == earliest_date_key(SCOPE)


class TestVersions:
    def test_a_workspace_bump_moves_its_own_counter(self):
        table = MagicMock()
        assert bump_data_version(table, SCOPE)
        assert table.update_item.call_args.kwargs['Key'] == data_version_key(SCOPE)

    def test_a_batch_bumps_each_scope_once(self):
        bump = MagicMock(return_value=True)
        batch = BatchBump(bump)
        batch.mark()
        batch.mark(SCOPE)
        batch.mark(SCOPE)
        batch.mark()

        assert batch.flush('table') is True
        assert [call.args for call in bump.call_args_list] == [('table',), ('table', SCOPE)]
        assert batch.flush('table') is False  # nothing marked since

    def test_the_read_takes_the_workspaces_data_version_and_watermark_and_the_deployments_config(self):
        table = MagicMock()
        table.name = 'aggregates'
        meta = f'WS#{WS}#METRIC#meta'
        table.meta.client.batch_get_item.return_value = {'Responses': {'aggregates': [
            {'pk': 'METRIC#meta', 'sk': 'data_version', 'v': 9},  # the deployment's: not this read's
            {'pk': meta, 'sk': 'data_version', 'v': 3},
            {'pk': 'METRIC#meta', 'sk': 'config_version', 'v': 5},
            {'pk': meta, 'sk': 'earliest_date', 'date': '2026-02-01'},
        ]}}

        read = read_versions(table, scope=SCOPE)

        assert read.versions is not None
        assert (read.versions.data, read.versions.config, read.earliest_date) == (3, 5, '2026-02-01')
        keys = table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['aggregates']['Keys']
        assert keys == [data_version_key(SCOPE), {'pk': 'METRIC#meta', 'sk': 'config_version'},
                        earliest_date_key(SCOPE)]


def _event(headers: dict) -> dict:
    return {'headers': headers, 'requestContext': {'authorizer': {'claims': {'sub': 'sub-1'}}}}


class TestRequestWorkspace:
    def _resolver(self, table: MagicMock) -> RequestWorkspace:
        return RequestWorkspace(table=lambda: table, confirm_platform_admin=lambda _e: False,
                                memberships=MembershipCache())

    def test_no_header_is_deployment_wide_and_reads_nothing(self):
        table = MagicMock()
        assert self._resolver(table).scope(_event({})) is None
        table.get_item.assert_not_called()

    def test_a_member_acts_in_the_workspace(self):
        table = MagicMock()
        table.get_item.side_effect = lambda Key, **_: {'Item': (
            {'role': 'viewer'} if Key['sk'].startswith('MEMBER#') else {'status': 'active', 'name': 'n', 'slug': 's'})}

        scope = self._resolver(table).scope(_event({'x-workspace-id': WS}))

        assert scope is not None
        assert scope.ws == WS

    def test_an_empty_header_is_refused_and_a_non_member_gets_the_404(self):
        table = MagicMock()
        table.get_item.return_value = {}
        with pytest.raises(ValidationError):
            self._resolver(table).scope(_event({'X-Workspace-Id': ''}))
        with pytest.raises(NotFoundError):
            self._resolver(table).scope(_event({'X-Workspace-Id': WS}))

    def test_a_fault_is_a_fixed_500(self):
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'GetItem')
        with pytest.raises(ServiceError, match='Failed to open the workspace'):
            self._resolver(table).scope(_event({'X-Workspace-Id': WS}))


class TestTheLayersChecks:
    def test_check_update_holds_update_items_rules_without_the_call(self):
        from shared.ws_repo import ws_table

        table = MagicMock()
        view = ws_table(SCOPE, table)
        view.check_update({'pk': f'WS#{WS}#METRIC#x', 'sk': 'd'}, UpdateExpression='SET metric_type = :m',
                          ExpressionAttributeValues={':m': f'WS#{WS}#source'})
        with pytest.raises(OutOfScopeError):
            view.check_update({'pk': f'WS#{WS}#METRIC#x', 'sk': 'd'}, UpdateExpression='SET metric_type = :m',
                              ExpressionAttributeValues={':m': 'source'})
        table.update_item.assert_not_called()

    def test_check_keys(self):
        from shared.ws_repo import ws_table

        view = ws_table(SCOPE, MagicMock())
        assert view.check_keys([{'pk': f'WS#{WS}#SOURCE#a', 'sk': 'x'}]) == [{'pk': f'WS#{WS}#SOURCE#a', 'sk': 'x'}]
        with pytest.raises(OutOfScopeError):
            view.check_keys([{'pk': f'WS#{WS}#SOURCE#a', 'sk': 'x'}, {'pk': 'SOURCE#a', 'sk': 'y'}])
