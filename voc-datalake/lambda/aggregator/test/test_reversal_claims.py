"""A redelivered REMOVE or MODIFY moves nothing (audit G1): the reversal claim (shared/stream_claims.py).

Against moto: an aggregates table and the idempotency table the claims live in. The one-record
path (`record_handler`) and the coalesced REMOVE run (`_RunCoalescingProcessor`) are both covered.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock, patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import process_partial_response
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError
from moto import mock_aws

from aggregator.test.test_removal_run import _item, _raw
from shared import stream_claims
from shared.test.moto_tables import create_pk_sk_table

DEDUPE = 'dedupe-reversal-claims'


@pytest.fixture
def world() -> Iterator[tuple]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = create_pk_sk_table('agg-reversal-claims', resource)
        resource.create_table(
            TableName=DEDUPE, KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST',
        )
        yield aggregates, resource.Table(DEDUPE)


@contextmanager
def _on(world):
    from aggregator import handler

    aggregates, dedupe = world
    with patch.object(handler, 'aggregates_table', aggregates), \
            patch.object(handler, 'IDEMPOTENCY_TABLE', DEDUPE), \
            patch.object(handler, '_idempotency_table', return_value=dedupe):
        yield handler


def _count(aggregates, pk: str, sk: str) -> int:
    item = aggregates.get_item(Key={'pk': pk, 'sk': sk}).get('Item') or {}
    return int(item.get('count', 0))


def _seed(world, item: dict, times: int) -> None:
    from aggregator import handler

    with patch.object(handler, 'aggregates_table', world[0]):
        for _ in range(times):
            handler.record_handler(DynamoDBRecord(_raw('INSERT', 0, new=item)))


ITEM = _item(1)
TOTAL = ('METRIC#daily_total', ITEM['date'])


def test_a_redelivered_remove_decrements_once(world):
    _seed(world, ITEM, 3)
    remove = DynamoDBRecord(_raw('REMOVE', 7, old=ITEM))
    with _on(world) as handler:
        assert handler.record_handler(remove) == {'status': 'success'}
        assert handler.record_handler(remove) == {'status': 'skipped', 'reason': 'already applied'}
    assert _count(world[0], *TOTAL) == 2


def test_a_redelivered_modify_moves_the_item_once(world):
    _seed(world, ITEM, 1)
    edited = dict(ITEM, category='support')
    modify = DynamoDBRecord(_raw('MODIFY', 8, new=edited, old=ITEM))
    with _on(world) as handler:
        handler.record_handler(modify)
        handler.record_handler(modify)
    assert _count(world[0], 'METRIC#daily_category#support', ITEM['date']) == 1
    assert _count(world[0], f"METRIC#daily_category#{ITEM['category']}", ITEM['date']) == 0


def test_two_different_removes_of_one_item_each_reverse(world):
    """The claim is per stream RECORD, never per item."""
    _seed(world, ITEM, 3)
    with _on(world) as handler:
        handler.record_handler(DynamoDBRecord(_raw('REMOVE', 1, old=ITEM)))
        handler.record_handler(DynamoDBRecord(_raw('REMOVE', 2, old=ITEM)))
    assert _count(world[0], *TOTAL) == 1


def test_a_reversal_whose_writes_fail_is_released_and_retried(world):
    _seed(world, ITEM, 2)
    remove = DynamoDBRecord(_raw('REMOVE', 9, old=ITEM))
    with _on(world) as handler:
        with patch.object(handler, 'process_deleted_feedback', side_effect=ClientError(
                {'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}}, 'UpdateItem')), \
                pytest.raises(ClientError):
            handler.record_handler(remove)
        assert handler.record_handler(remove) == {'status': 'success'}
    assert _count(world[0], *TOTAL) == 1


def test_a_redelivered_run_of_removes_moves_nothing(world):
    items = [_item(n, date='2026-03-01') for n in range(4)]
    for item in items:
        _seed(world, item, 2)
    records = [_raw('REMOVE', 20 + n, old=item) for n, item in enumerate(items)]
    with _on(world) as handler:
        first = process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                         processor=handler.processor)
        again = process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                         processor=handler.processor)
    assert first == again == {'batchItemFailures': []}
    assert _count(world[0], 'METRIC#daily_total', '2026-03-01') == 4


def test_a_failed_record_of_a_run_is_released(world):
    poison = dict(_item(2, date='2026-03-01'), sentiment_score='0.5')
    good = _item(3, date='2026-03-01')
    _seed(world, good, 1)
    records = [_raw('REMOVE', 30, old=good), _raw('REMOVE', 31, old=poison)]
    with _on(world) as handler:
        response = process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                            processor=handler.processor)
    assert response['batchItemFailures'] == [{'itemIdentifier': '1031'}]
    claims = {row['id']: row['claim_state'] for row in world[1].scan()['Items']}
    assert claims == {'aggregator#reversal#evt-30': 'claimed', 'aggregator#reversal#evt-31': 'released'}


def test_without_the_dedupe_table_a_reversal_is_unclaimed(world):
    from aggregator import handler

    _seed(world, ITEM, 3)
    remove = DynamoDBRecord(_raw('REMOVE', 7, old=ITEM))
    with patch.object(handler, 'aggregates_table', world[0]):
        handler.record_handler(remove)
        handler.record_handler(remove)
    assert _count(world[0], *TOTAL) == 1
    assert world[1].scan()['Items'] == []


class TestClaims:
    def test_a_claim_is_taken_once_and_can_be_taken_again_after_a_release(self, world):
        table = world[1]
        assert stream_claims.claim(table, 'k', 100) is True
        assert stream_claims.claim(table, 'k', 100) is False
        stream_claims.release(table, 'k', 100)
        assert stream_claims.claim(table, 'k', 100) is True
        [row] = table.scan()['Items']
        assert row['expiration'] == Decimal(100 + stream_claims.CLAIM_TTL_SECONDS)

    def test_a_claim_that_cannot_be_written_fails_open(self):
        table = MagicMock()
        table.put_item.side_effect = ClientError({'Error': {'Code': 'ResourceNotFoundException'}}, 'PutItem')
        assert stream_claims.claim(table, 'k', 1) is True
        stream_claims.release(table, 'k', 1)  # never raises

    @pytest.mark.parametrize(('event_id', 'expected'), [
        ('abc', 'aggregator#reversal#abc'), ('', None), (None, None), (5, None),
    ])
    def test_the_key(self, event_id, expected):
        assert stream_claims.reversal_key(event_id) == expected




def test_a_run_that_raises_releases_every_claim_so_the_retry_reverses(world):
    """An error outside the per-record failures retries the whole batch: no claim may survive it."""
    items = [_item(n, date='2026-03-01') for n in range(4, 6)]
    for item in items:
        _seed(world, item, 2)
    records = [_raw('REMOVE', 40 + n, old=item) for n, item in enumerate(items)]
    with _on(world) as handler:
        with patch.object(handler, 'reverse_removals', side_effect=RuntimeError('throttled')), \
             pytest.raises(RuntimeError, match='throttled'):
            process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                     processor=handler.processor)
        claims = {row['id']: row['claim_state'] for row in world[1].scan()['Items']}
        assert set(claims.values()) == {'released'}
        process_partial_response(event={'Records': records}, record_handler=handler.record_handler,
                                 processor=handler.processor)
    assert _count(world[0], 'METRIC#daily_total', '2026-03-01') == 2  # each reversed once, by the retry
