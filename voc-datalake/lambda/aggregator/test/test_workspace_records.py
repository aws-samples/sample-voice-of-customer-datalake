"""A workspace's feedback item is never counted into the deployment-wide METRIC# rows (docs/multi-workspace.md).

The processor stores a message that names a workspace under ``WS#{ws}#SOURCE#…``. Until the aggregator's own
slice writes the workspace's counters (``WS#{ws}#METRIC#…``), every stream record of such an item is skipped and
counted (``AggregatorWorkspaceRecordsSkipped``), on the one-record path and in a coalesced run alike.
"""
from __future__ import annotations

from unittest.mock import patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import process_partial_response
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from moto import mock_aws

from aggregator.test.test_removal_run import _item, _raw, _rows
from shared.test.moto_tables import create_pk_sk_table

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'


def _in_workspace(item: dict) -> dict:
    """``item`` as the processor stores it for a message of the workspace: every partition prefixed."""
    return {**item, 'pk': f"WS#{WS}#{item['pk']}", 'gsi1pk': f"WS#{WS}#DATE#{item['date']}"}


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
        yield create_pk_sk_table('agg-workspaces', boto3.resource('dynamodb', region_name='us-east-1'))


def _apply(table, records: list[dict], *, coalesce: bool = True, dedupe: str = '') -> tuple[dict, list[str]]:
    from aggregator import handler

    with patch.object(handler, 'aggregates_table', table), \
            patch.object(handler, 'IDEMPOTENCY_TABLE', dedupe), \
            patch.object(handler, 'metrics') as metrics, \
            patch.object(handler.data_changed, 'mark') as mark:
        if coalesce:
            response = process_partial_response(
                event={'Records': records}, record_handler=handler.record_handler, processor=handler.processor)
        else:
            response = {'results': [handler.record_handler(DynamoDBRecord(raw)) for raw in records]}
        names = [call.kwargs['name'] for call in metrics.add_metric.call_args_list]
        names += ['data_changed'] * mark.call_count
    return dict(response), names


class TestAWorkspaceRecord:
    def test_insert_modify_and_remove_move_no_deployment_counter(self, aggregates):
        first, edited = _in_workspace(_item(1)), _in_workspace(_item(1, category='pricing'))
        records = [_raw('INSERT', 1, new=first), _raw('INSERT', 2, new=_in_workspace(_item(2))),
                   _raw('MODIFY', 3, old=first, new=edited), _raw('REMOVE', 4, old=edited)]

        response, names = _apply(aggregates, records)

        assert _rows(aggregates) == []
        assert response == {'batchItemFailures': []}
        assert names == ['AggregatorWorkspaceRecordsSkipped'] * 4  # and no data_version bump

    def test_the_one_record_path_skips_it_too(self, aggregates):
        response, names = _apply(aggregates, [_raw('INSERT', 1, new=_in_workspace(_item(1)))], coalesce=False)

        assert response == {'results': [{'status': 'skipped', 'reason': 'workspace item'}]}
        assert _rows(aggregates) == []
        assert names == ['AggregatorWorkspaceRecordsSkipped']

    def test_a_run_of_removals_leaves_seeded_deployment_counters_alone(self, aggregates):
        """Two consecutive workspace REMOVEs (a coalesced run's shape) never reverse the deployment's counters,
        though their images would bucket into exactly those rows."""
        removed = [_in_workspace(_item(1)), _in_workspace(_item(2))]
        for item in removed:
            for pk in ('METRIC#daily_total', f"METRIC#daily_source#{item['source_platform']}"):
                aggregates.put_item(Item={'pk': pk, 'sk': item['date'], 'count': 5})
        seeded = _rows(aggregates)

        response, names = _apply(aggregates, [_raw('REMOVE', 1, old=removed[0]), _raw('REMOVE', 2, old=removed[1])])

        assert _rows(aggregates) == seeded
        assert response == {'batchItemFailures': []}
        assert names == ['AggregatorWorkspaceRecordsSkipped'] * 2

    def test_a_run_of_arrivals_with_the_dedupe_table_claims_and_counts_nothing(self, aggregates):
        """With IDEMPOTENCY_TABLE set two consecutive INSERTs would join one claimed transaction; a workspace's are
        skipped before any claim (the dedupe table does not even exist here: a claim would fail the batch)."""
        records = [_raw('INSERT', 1, new=_in_workspace(_item(1))), _raw('INSERT', 2, new=_in_workspace(_item(2)))]

        response, names = _apply(aggregates, records, dedupe='no-such-dedupe-table')

        assert _rows(aggregates) == []
        assert response == {'batchItemFailures': []}
        assert names == ['AggregatorWorkspaceRecordsSkipped'] * 2

    def test_the_key_alone_marks_it(self, aggregates):
        _response, names = _apply(aggregates, [_keys_only(_raw('REMOVE', 1, old=_in_workspace(_item(1))))])

        assert names == ['AggregatorWorkspaceRecordsSkipped']
        assert _rows(aggregates) == []


def test_a_mixed_batch_counts_exactly_its_deployment_records():
    """Workspace records between deployment-wide ones change nothing the deployment-wide records write."""
    deployment = [_raw('INSERT', 1, new=_item(1)), _raw('INSERT', 3, new=_item(3))]
    mixed = [deployment[0], _raw('INSERT', 2, new=_in_workspace(_item(2))), deployment[1],
             _raw('INSERT', 4, new=_in_workspace(_item(4)))]
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        alone, beside = create_pk_sk_table('agg-alone', resource), create_pk_sk_table('agg-beside', resource)
        _apply(alone, deployment)
        response, names = _apply(beside, mixed)
        expected, written = _rows(alone), _rows(beside)

    assert written == expected
    assert expected  # the deployment-wide records did count
    assert response == {'batchItemFailures': []}
    assert names.count('AggregatorWorkspaceRecordsSkipped') == 2


@pytest.mark.parametrize(('raw', 'expected'), [
    ({'dynamodb': {'Keys': {'pk': {'S': f'WS#{WS}#SOURCE#web'}}}}, True),
    ({'dynamodb': {'NewImage': {'pk': {'S': 'WS#garbage#SOURCE#web'}}}}, True),
    ({'dynamodb': {'OldImage': {'pk': {'S': 'SOURCE#web'}}}}, False),
    ({'dynamodb': {'Keys': {'pk': {'N': '1'}}}}, False),
    ({'dynamodb': {}}, False),
    ({}, False),
    (None, False),
])
def test_what_counts_as_a_workspace_record(raw, expected):
    from aggregator import handler

    assert handler._is_workspace_record(raw) is expected
