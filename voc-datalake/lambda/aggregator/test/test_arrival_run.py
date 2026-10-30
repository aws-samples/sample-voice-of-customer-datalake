"""A run of consecutive INSERTs is applied in joint transactions, exactly once, with the same aggregates.

`_RunCoalescingProcessor` joins a run of arrivals into transactions of up to 100 items
(one dedupe claim per record plus one summed increment per distinct counter) instead
of one transaction per record. That is what removes the hot-row contention a bulk
import produced (968 "still cancelled for a transient reason after 3 attempts"
warnings on 2026-10-23): every arrival of a day writes `METRIC#daily_total` and the
day's other counters, and concurrent shards' transactions on one item cancel each
other. These tests run each batch twice against moto, from identical tables: once
through the stock Powertools `BatchProcessor` calling `record_handler` per record
(the old path), once through the coalescing processor, and compare every aggregate
row (`updated_at` aside), the batch response and the transactions sent.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, process_partial_response
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError
from moto import mock_aws

from aggregator.test.test_removal_run import _item as _varied_item
from aggregator.test.test_removal_run import _raw, _rows
from shared.test.document_versions_fixtures import client_error
from shared.test.moto_tables import create_pk_sk_table

DAY = '2026-10-23'


def _item(n: int, **overrides: Any) -> dict:
    """A processed feedback item of the import day, varied across the counter dimensions."""
    return _varied_item(n, **{'date': DAY, **overrides})


def _inserts(items: list[dict], start: int = 0) -> list[dict]:
    return [_raw('INSERT', start + n, new=item) for n, item in enumerate(items)]


@dataclass
class _Path:
    """One side of the comparison: its aggregates table and its dedupe table."""
    aggregates: Any
    dedupe_name: str
    sent: list[list[dict]] = field(default_factory=list)


def _dedupe_table(resource, name: str) -> None:
    resource.create_table(
        TableName=name,
        KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
        AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}],
        BillingMode='PAY_PER_REQUEST',
    )


@pytest.fixture
def twin_paths() -> Iterator[tuple[_Path, _Path]]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        one = _Path(create_pk_sk_table('agg-one-at-a-time', resource), 'dedupe-one-at-a-time')
        joint = _Path(create_pk_sk_table('agg-joint', resource), 'dedupe-joint')
        _dedupe_table(resource, one.dedupe_name)
        _dedupe_table(resource, joint.dedupe_name)
        yield one, joint


@contextmanager
def _on(path: _Path):
    """Point the handler at `path`'s tables and record every transaction it sends."""
    from aggregator import handler

    client = path.aggregates.meta.client
    send = client.transact_write_items

    def recording(**request):
        path.sent.append(request['TransactItems'])
        return send(**request)

    with patch.object(handler, 'aggregates_table', path.aggregates), \
            patch.object(handler, 'AGGREGATES_TABLE', path.aggregates.name), \
            patch.object(handler, 'IDEMPOTENCY_TABLE', path.dedupe_name), \
            patch.object(handler.time, 'sleep'), \
            patch.object(client, 'transact_write_items', recording):
        yield client


def _apply(path: _Path, records: list[dict], processor) -> dict:
    from aggregator import handler

    with _on(path):
        return dict(process_partial_response(
            event={'Records': records}, record_handler=handler.record_handler, processor=processor,
        ))


def _stock() -> BatchProcessor:
    return BatchProcessor(event_type=EventType.DynamoDBStreams)


def _joint():
    from aggregator import handler

    return handler.processor


def _aggregate_row_writes(path: _Path) -> int:
    """Item writes on the aggregates table (the claims land in the dedupe table)."""
    return sum(1 for items in path.sent for entry in items
               if entry.get('Update', {}).get('TableName') == path.aggregates.name)


def _hot_row_transactions(path: _Path) -> int:
    """Transactions that touched the day's `METRIC#daily_total`: the contended row."""
    return sum(1 for items in path.sent
               if any(entry.get('Update', {}).get('Key', {}).get('pk') == 'METRIC#daily_total' for entry in items))


def _cancellation(*codes: str) -> ClientError:
    return client_error('TransactionCanceledException', *codes)


BULK = [_item(n) for n in range(100)]


def test_a_bulk_import_batch_writes_the_same_aggregates_in_two_transactions_instead_of_one_hundred(twin_paths):
    one, joint = twin_paths
    records = _inserts(BULK)

    expected = _apply(one, records, _stock())
    actual = _apply(joint, records, _joint())

    assert actual == expected == {'batchItemFailures': []}
    assert _rows(joint.aggregates) == _rows(one.aggregates)
    # Measured on this batch (100 arrivals of one day, the import shape of 2026-10-23):
    # (transactions, aggregate-row writes, transactions touching METRIC#daily_total).
    before = (len(one.sent), _aggregate_row_writes(one), _hot_row_transactions(one))
    after = (len(joint.sent), _aggregate_row_writes(joint), _hot_row_transactions(joint))
    assert before == (100, 839, 100)
    assert after == (2, 64, 2)
    assert all(len(items) <= 100 for items in joint.sent)


def test_every_record_is_claimed_once_so_a_redelivered_batch_moves_nothing(twin_paths):
    _, joint = twin_paths
    records = _inserts(BULK[:20])
    _apply(joint, records, _joint())
    once = _rows(joint.aggregates)

    response = _apply(joint, records, _joint())

    assert response == {'batchItemFailures': []}
    assert _rows(joint.aggregates) == once


def test_a_partly_applied_batch_applies_only_the_records_not_yet_claimed(twin_paths):
    """A bisected or partially failed batch comes back with some records already applied."""
    one, joint = twin_paths
    records = _inserts(BULK[:30])
    _apply(one, records, _stock())
    _apply(joint, records[:12], _stock())

    response = _apply(joint, records, _joint())

    assert response == {'batchItemFailures': []}
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_runs_are_broken_by_other_events_and_still_match_one_at_a_time(twin_paths):
    one, joint = twin_paths
    edited = dict(BULK[3], category='pricing', sentiment_score=Decimal('0.4'))
    records = [
        *_inserts(BULK[:5]),
        _raw('MODIFY', 50, new=edited, old=BULK[3]),
        *_inserts(BULK[5:9], start=60),
        _raw('REMOVE', 70, old=BULK[0]),
        _raw('INSERT', 80, new=_item(80, date=None)),
    ]

    expected = _apply(one, records, _stock())
    actual = _apply(joint, records, _joint())

    assert actual == expected
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_contention_is_retried_with_backoff_and_the_group_lands(twin_paths):
    from aggregator import handler

    one, joint = twin_paths
    records = _inserts(BULK[:10])
    _apply(one, records, _stock())
    calls = {'n': 0}
    original = handler._send_arrival_group

    def conflicted_once(group):
        calls['n'] += 1
        if calls['n'] == 1:
            return _cancellation(*(['None'] * len(group)), 'TransactionConflict')
        return original(group)

    with patch.object(handler, '_send_arrival_group', conflicted_once), \
            patch.object(handler, '_contention_pause') as pause:
        response = _apply(joint, records, _joint())

    assert response == {'batchItemFailures': []}
    assert calls['n'] == 2
    pause.assert_called_once_with(0)
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_contention_past_the_bound_applies_the_records_one_at_a_time(twin_paths):
    from aggregator import handler

    one, joint = twin_paths
    records = _inserts(BULK[:6])
    _apply(one, records, _stock())

    def always_conflicted(group):
        return _cancellation(*(['None'] * len(group)), 'TransactionConflict')

    with patch.object(handler, '_send_arrival_group', side_effect=always_conflicted) as sent:
        response = _apply(joint, records, _joint())

    assert response == {'batchItemFailures': []}
    assert sent.call_count == handler.TRANSACT_WRITE_ATTEMPTS
    assert len(joint.sent) == len(records)  # one transaction per record afterwards
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_a_record_that_cannot_be_summed_fails_alone_as_it_did_before(twin_paths):
    """A score stored as text: the one-record path fails it; the joint run must fail only it."""
    one, joint = twin_paths
    poison = _item(2, sentiment_score='0.5')
    records = _inserts([BULK[0], BULK[1], poison, BULK[3], BULK[4]])

    expected = _apply(one, records, _stock())
    actual = _apply(joint, records, _joint())

    assert actual == expected
    assert actual['batchItemFailures'] == [{'itemIdentifier': records[2]['dynamodb']['SequenceNumber']}]
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_a_group_rejected_for_a_permanent_reason_is_retried_record_by_record(twin_paths):
    from aggregator import handler

    one, joint = twin_paths
    records = _inserts(BULK[:4])
    _apply(one, records, _stock())

    def invalid(group):
        return _cancellation(*(['None'] * len(group)), 'ValidationError')

    with patch.object(handler, '_send_arrival_group', side_effect=invalid) as sent:
        response = _apply(joint, records, _joint())

    assert response == {'batchItemFailures': []}
    assert sent.call_count == 1
    assert _rows(joint.aggregates) == _rows(one.aggregates)


def test_groups_never_exceed_the_transaction_item_limit():
    from aggregator import handler

    # Every record carries 30 tags of its own, so the distinct rows grow fast.
    plans = []
    for n in range(40):
        plan = handler._PlannedArrival(raw={}, record=DynamoDBRecord({}))
        plan.item, plan.date, plan.dedupe_key = {}, DAY, f'k{n}'
        plan.keys = frozenset({('METRIC#daily_total', DAY, 'count')}
                              | {(f'METRIC#daily_tag#t{n}_{t}', DAY, 'count') for t in range(30)})
        plan.score = Decimal('0.5')
        plans.append(plan)

    groups = handler._arrival_groups(plans)

    assert [plan for group in groups for plan in group] == plans
    for group in groups:
        rows = set().union(*(handler._arrival_rows(plan) for plan in group))
        assert len(group) + len(rows) <= handler.TRANSACT_WRITE_MAX_ITEMS


def test_without_a_dedupe_table_each_insert_goes_through_the_one_record_path():
    from aggregator import handler

    records = _inserts(BULK[:3])
    with patch.object(handler, 'IDEMPOTENCY_TABLE', ''), \
            patch.object(handler.processor, '_arrival_run') as joint_run, \
            patch.object(handler, 'process_new_feedback', return_value=True) as alone:
        process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                 processor=handler.processor)

    joint_run.assert_not_called()
    assert alone.call_count == 3


def test_an_average_increment_never_adds_fewer_than_one_item():
    from aggregator import handler

    with pytest.raises(ValueError, match='at least one'):
        handler._average_transaction_item('METRIC#avg_sentiment', DAY, Decimal('1'), count=0)
