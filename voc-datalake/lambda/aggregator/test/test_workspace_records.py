"""A workspace's feedback item is aggregated into that workspace's own counters (docs/multi-workspace.md).

The processor stores a message that names a workspace under ``WS#{ws}#SOURCE#…``. The aggregator applies every
stream record of such an item in that workspace: every ``METRIC#`` row becomes ``WS#{ws}#METRIC#…`` (``metric_type``
``WS#{ws}#<type>``), the watermark and the data_version are the workspace's ``WS#{ws}#METRIC#meta`` rows, a coalesced
run never mixes scopes, and nothing of it reaches the deployment's counters. A record whose key starts ``WS#`` but
names no workspace is skipped and counted (``AggregatorWorkspaceRecordsSkipped``), never counted deployment-wide.
"""
from __future__ import annotations

from unittest.mock import patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import process_partial_response
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from moto import mock_aws

from aggregator.test.test_removal_run import _item, _raw, _rows
from shared.data_version import BatchBump
from shared.test.moto_tables import create_pk_sk_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
DEDUPE = 'agg-workspaces-dedupe'


def _in_workspace(item: dict, ws: str = WS) -> dict:
    """``item`` as the processor stores it for a message of the workspace: every partition prefixed."""
    return {**item, 'pk': f"WS#{ws}#{item['pk']}", 'gsi1pk': f"WS#{ws}#DATE#{item['date']}"}


def _keys_only(raw: dict) -> dict:
    """A record whose images are gone (a stream with KEYS_ONLY): the key alone decides."""
    body = dict(raw['dynamodb'])
    pk = (body.get('NewImage') or body.get('OldImage') or {})['pk']
    body.pop('NewImage', None)
    body.pop('OldImage', None)
    return {**raw, 'dynamodb': {**body, 'Keys': {'pk': pk, 'sk': {'S': 'FEEDBACK#f'}}}}


@pytest.fixture
def aggregates():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        resource.create_table(
            TableName=DEDUPE, KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')
        yield create_pk_sk_table('agg-workspaces', resource)


def _apply(table, records: list[dict], *, coalesce: bool = True, dedupe: str = '',
           sent: list | None = None, bump: BatchBump | None = None) -> tuple[dict, list[str]]:
    from aggregator import handler

    client = table.meta.client
    send = client.transact_write_items

    def recording(**request):
        if sent is not None:
            sent.append(request['TransactItems'])
        return send(**request)

    with patch.object(handler, 'aggregates_table', table), \
            patch.object(handler, 'AGGREGATES_TABLE', table.name), \
            patch.object(handler, 'IDEMPOTENCY_TABLE', dedupe), \
            patch.object(handler.time, 'sleep'), \
            patch.object(client, 'transact_write_items', recording), \
            patch.object(handler, 'data_changed', bump or BatchBump(handler.bump_data_version)), \
            patch.object(handler, 'metrics') as metrics:
        if coalesce:
            response = process_partial_response(
                event={'Records': records}, record_handler=handler.record_handler, processor=handler.processor)
        else:
            response = {'results': [handler.record_handler(DynamoDBRecord(raw)) for raw in records]}
        names = [call.kwargs['name'] for call in metrics.add_metric.call_args_list]
    return dict(response), names


def _rows_of(table, prefix: str) -> list[dict]:
    return [row for row in _rows(table) if row['pk'].startswith(prefix)]


def _deployment_rows(table) -> list[dict]:
    return [row for row in _rows(table) if not row['pk'].startswith('WS#')]


def _unprefixed(rows: list[dict], ws: str) -> list[dict]:
    """``rows`` of the workspace ``ws`` spelled as the deployment's (``WS#{ws}#`` stripped from pk and metric_type)."""
    prefix = f'WS#{ws}#'
    return [{**row, 'pk': row['pk'].removeprefix(prefix),
             **({'metric_type': row['metric_type'].removeprefix(prefix)} if 'metric_type' in row else {})}
            for row in rows]


ITEMS = [_item(n) for n in range(1, 7)]


class TestAWorkspaceRecordCountsInItsWorkspace:
    def test_the_counters_are_the_deployments_rows_under_the_workspace(self, aggregates):
        """The same items, once deployment-wide and once in a workspace, write the same rows, the workspace's
        under ``WS#{ws}#`` (pk and metric_type alike)."""
        _apply(aggregates, [_raw('INSERT', n, new=item) for n, item in enumerate(ITEMS)])
        deployment = _deployment_rows(aggregates)
        _apply(aggregates, [_raw('INSERT', 100 + n, new=_in_workspace(item)) for n, item in enumerate(ITEMS)])

        assert deployment
        assert _deployment_rows(aggregates) == deployment  # the deployment's counters untouched
        assert _unprefixed(_rows_of(aggregates, f'WS#{WS}#'), WS) == deployment
        assert {row['metric_type'] for row in _rows_of(aggregates, f'WS#{WS}#') if 'metric_type' in row} >= {
            f'WS#{WS}#source', f'WS#{WS}#persona'}

    def test_two_workspaces_identical_items_count_separately(self, aggregates):
        records = [_raw('INSERT', 1, new=_in_workspace(ITEMS[0], WS)),
                   _raw('INSERT', 2, new=_in_workspace(ITEMS[0], OTHER)),
                   _raw('INSERT', 3, new=_in_workspace(ITEMS[1], WS))]

        response, _names = _apply(aggregates, records)

        assert response == {'batchItemFailures': []}
        assert _deployment_rows(aggregates) == []
        total = {row['pk']: row['count'] for row in _rows(aggregates) if row['pk'].endswith('#METRIC#daily_total')
                 and row['sk'] == ITEMS[0]['date']}
        same_day = 2 if ITEMS[1]['date'] == ITEMS[0]['date'] else 1
        assert total == {f'WS#{WS}#METRIC#daily_total': same_day, f'WS#{OTHER}#METRIC#daily_total': 1}

    def test_the_one_record_path_counts_it_too(self, aggregates):
        response, names = _apply(aggregates, [_raw('INSERT', 1, new=_in_workspace(ITEMS[0]))], coalesce=False)

        assert response == {'results': [{'status': 'success'}]}
        assert _deployment_rows(aggregates) == []
        assert any(row['pk'] == f'WS#{WS}#METRIC#daily_total' for row in _rows(aggregates))
        assert 'AggregatorWorkspaceRecordsSkipped' not in names

    def test_a_removal_reverses_only_its_workspace(self, aggregates):
        item = ITEMS[0]
        _apply(aggregates, [_raw('INSERT', 1, new=_in_workspace(item, WS)), _raw('INSERT', 2, new=_in_workspace(item, OTHER)),
                            _raw('INSERT', 3, new=item)])
        before_other = _rows_of(aggregates, f'WS#{OTHER}#')
        before_deployment = _deployment_rows(aggregates)

        _apply(aggregates, [_raw('REMOVE', 4, old=_in_workspace(item, WS)), _raw('REMOVE', 5, old=_in_workspace(item, WS))])

        assert _rows_of(aggregates, f'WS#{OTHER}#') == before_other
        assert _deployment_rows(aggregates) == before_deployment
        assert all(row.get('count', 0) == 0 for row in _rows_of(aggregates, f'WS#{WS}#'))

    def test_a_modify_rebuckets_inside_its_workspace(self, aggregates):
        first, edited = _in_workspace(ITEMS[0]), _in_workspace({**ITEMS[0], 'category': 'billing'})
        _apply(aggregates, [_raw('INSERT', 1, new=first)])

        _apply(aggregates, [_raw('MODIFY', 2, old=first, new=edited)])

        rows = {(row['pk'], row['sk']): row.get('count') for row in _rows(aggregates)}
        day = ITEMS[0]['date']
        assert rows[(f"WS#{WS}#METRIC#daily_category#{ITEMS[0]['category']}", day)] == 0
        assert rows[(f'WS#{WS}#METRIC#daily_category#billing', day)] == 1
        assert _deployment_rows(aggregates) == []


class TestRunsNeverMixScopes:
    def test_each_joint_transaction_names_one_scope(self, aggregates):
        """Consecutive INSERTs of the deployment and two workspaces: each coalesced transaction's aggregate rows
        are all one scope's, and the counts equal the one-at-a-time path's."""
        records = [_raw('INSERT', 1, new=ITEMS[0]), _raw('INSERT', 2, new=ITEMS[1]),
                   _raw('INSERT', 3, new=_in_workspace(ITEMS[2], WS)), _raw('INSERT', 4, new=_in_workspace(ITEMS[3], WS)),
                   _raw('INSERT', 5, new=_in_workspace(ITEMS[4], OTHER)), _raw('INSERT', 6, new=_in_workspace(ITEMS[5], OTHER))]
        sent: list = []

        response, _names = _apply(aggregates, records, dedupe=DEDUPE, sent=sent)

        assert response == {'batchItemFailures': []}
        scopes = []
        for items in sent:
            pks = {item['Update']['Key']['pk'] for item in items if 'Update' in item}
            prefixes = {pk[:pk.index('METRIC#')] for pk in pks}
            assert len(prefixes) == 1, prefixes
            scopes.append(prefixes.pop())
        assert scopes == ['', f'WS#{WS}#', f'WS#{OTHER}#']
        alone = create_pk_sk_table('agg-alone', boto3.resource('dynamodb', region_name='us-east-1'))
        _apply(alone, records, coalesce=False)
        assert _rows(alone) == _rows(aggregates)

    def test_a_run_of_removals_in_a_workspace_leaves_seeded_deployment_counters_alone(self, aggregates):
        removed = [_in_workspace(ITEMS[0]), _in_workspace(ITEMS[1])]
        for item in removed:
            for pk in ('METRIC#daily_total', f"METRIC#daily_source#{item['source_platform']}"):
                aggregates.put_item(Item={'pk': pk, 'sk': item['date'], 'count': 5})
        seeded = _rows(aggregates)

        response, _names = _apply(aggregates, [_raw('REMOVE', 1, old=removed[0]), _raw('REMOVE', 2, old=removed[1])])

        assert _rows(aggregates) == seeded  # the workspace had no rows: its decrements are refused, create nothing
        assert response == {'batchItemFailures': []}


#: A key that starts WS# but names no workspace.
UNSCOPED = {**ITEMS[0], 'pk': 'WS#garbage#SOURCE#web'}


class TestAMalformedWorkspaceKey:

    def test_it_is_skipped_and_counted_never_deployment_wide(self, aggregates):
        response, names = _apply(aggregates, [_raw('INSERT', 1, new=UNSCOPED), _raw('INSERT', 2, new=UNSCOPED)],
                                 dedupe=DEDUPE)

        assert _rows(aggregates) == []
        assert response == {'batchItemFailures': []}
        assert names == ['AggregatorWorkspaceRecordsSkipped'] * 2

    def test_the_one_record_path_skips_it(self, aggregates):
        response, names = _apply(aggregates, [_raw('REMOVE', 1, old=UNSCOPED)], coalesce=False)

        assert response == {'results': [{'status': 'skipped', 'reason': 'unscoped workspace key'}]}
        assert names == ['AggregatorWorkspaceRecordsSkipped']

    def test_the_key_alone_marks_it(self, aggregates):
        _response, names = _apply(aggregates, [_keys_only(_raw('REMOVE', 1, old=UNSCOPED))])

        assert names == ['AggregatorWorkspaceRecordsSkipped']
        assert _rows(aggregates) == []


def test_the_data_version_is_bumped_per_scope(aggregates):
    from aggregator import handler

    records = [_raw('INSERT', 1, new=ITEMS[0]), _raw('INSERT', 2, new=_in_workspace(ITEMS[1], WS)),
               _raw('INSERT', 3, new=_in_workspace(ITEMS[2], WS))]
    bump = BatchBump(handler.bump_data_version)
    _apply(aggregates, records, bump=bump)
    assert bump.flush(aggregates)

    versions = {row['pk']: row['v'] for row in _rows(aggregates) if row['sk'] == 'data_version'}
    assert versions == {'METRIC#meta': 1, f'WS#{WS}#METRIC#meta': 1}


@pytest.mark.real_watermark
def test_the_earliest_date_watermark_is_the_workspaces_own(aggregates, monkeypatch):
    from aggregator import handler

    monkeypatch.setattr(handler, '_known_workspace_earliest', {})
    old, new = {**ITEMS[0], 'date': '2025-01-02'}, {**ITEMS[1], 'date': '2025-03-04'}
    _apply(aggregates, [_raw('INSERT', 1, new=new), _raw('INSERT', 2, new=_in_workspace(old))], coalesce=False)

    watermarks = {row['pk']: row['date'] for row in _rows(aggregates) if row['sk'] == 'earliest_date'}
    assert watermarks == {'METRIC#meta': '2025-03-04', f'WS#{WS}#METRIC#meta': '2025-01-02'}


@pytest.mark.parametrize(('raw', 'expected'), [
    ({'dynamodb': {'Keys': {'pk': {'S': f'WS#{WS}#SOURCE#web'}}}}, (False, WS)),
    ({'dynamodb': {'NewImage': {'pk': {'S': 'WS#garbage#SOURCE#web'}}}}, (True, None)),
    ({'dynamodb': {'NewImage': {'pk': {'S': f'WS#{WS}'}}}}, (True, None)),
    ({'dynamodb': {'OldImage': {'pk': {'S': 'SOURCE#web'}}}}, (False, None)),
    ({'dynamodb': {'Keys': {'pk': {'N': '1'}}}}, (False, None)),
    ({'dynamodb': {}}, (False, None)),
    ({}, (False, None)),
    (None, (False, None)),
])
def test_the_scope_of_a_record(raw, expected):
    from aggregator import handler

    refused, scope = handler.record_scope(raw)
    assert (refused, scope.ws if scope else None) == expected


def test_an_update_outside_the_scope_is_refused_before_dynamodb():
    """The transaction check holds the layer's rule: a row of another workspace never rides in one."""
    from aggregator import handler
    from shared.ws_repo import OutOfScopeError, scope_from_key

    with handler.in_scope(scope_from_key(f'WS#{OTHER}#SOURCE#web')):
        theirs = handler._counter_transaction_item('METRIC#daily_source#web', '2026-01-01', 'count')
    with handler.in_scope(scope_from_key(f'WS#{WS}#SOURCE#web')):
        mine = handler._counter_transaction_item('METRIC#daily_source#web', '2026-01-01', 'count')
        handler._check_transaction([mine])
        with pytest.raises(OutOfScopeError):
            handler._check_transaction([mine, theirs])
    with handler.in_scope(None):
        handler._check_transaction([theirs])  # deployment-wide: no workspace check, as before
