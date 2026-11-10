"""A run of consecutive REMOVEs is reversed together, and leaves the aggregates EXACTLY as one at a time did.

`_RunCoalescingProcessor` sends one request per distinct counter (and per day for the
average) instead of one per record, which is where this function's CPU went on a bulk
delete. These tests run every batch twice against moto — once through the stock
Powertools `BatchProcessor` calling `record_handler` per record (the old path), once
through the coalescing processor — from identical tables, and compare every aggregate
row (`updated_at` aside, a clock), the batch response and the refusal/decline counts.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, process_partial_response
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from moto import mock_aws

from shared.test.moto_tables import create_pk_sk_table

TTL_IDENTITY = {'type': 'Service', 'principalId': 'dynamodb.amazonaws.com'}
DAYS = ('2026-03-01', '2026-03-02', '2026-03-03')
_serializer = TypeSerializer()


def _item(n: int, **overrides: Any) -> dict:
    """A processed feedback item, varied across every counter dimension."""
    item = {
        'pk': f'SOURCE#src{n % 3}', 'sk': f'FEEDBACK#f{n:03d}', 'feedback_id': f'f{n:03d}',
        'date': DAYS[n % len(DAYS)], 'source_platform': f'src{n % 3}',
        'category': ('delivery', 'pricing', 'support')[n % 3],
        'sentiment_label': ('positive', 'negative', 'neutral', 'mixed')[n % 4],
        'sentiment_score': Decimal(('0.85', '-0.6', '0', '0.125', '-0.95')[n % 5]),
        'urgency': 'high' if n % 4 == 0 else 'low',
        'persona_type': ('existing_customer', 'prospect', 'churn_risk', 'advocate')[n % 4],
        'source_channel': ('app', 'web')[n % 2],
        'text': f'Example Air review number {n}',
    }
    if n % 3 == 0:
        item['subcategory'] = 'late_arrival'
    item.update(overrides)
    return {key: value for key, value in item.items() if value is not None}


def _image(item: dict) -> dict:
    return {key: _serializer.serialize(value) for key, value in item.items()}


def _raw(name: str, seq: int, *, new: dict | None = None, old: dict | None = None,
         identity: dict | None = None) -> dict:
    body: dict = {'SequenceNumber': f'{1000 + seq}', 'StreamViewType': 'NEW_AND_OLD_IMAGES'}
    if new is not None:
        body['NewImage'] = _image(new)
    if old is not None:
        body['OldImage'] = _image(old)
    raw = {'eventID': f'evt-{seq}', 'eventName': name, 'eventSource': 'aws:dynamodb', 'dynamodb': body}
    if identity is not None:
        raw['userIdentity'] = identity
    return raw


def _removes(items: list[dict], start: int = 0) -> list[dict]:
    return [_raw('REMOVE', start + n, old=item) for n, item in enumerate(items)]


ITEMS = [_item(n) for n in range(12)]


def _scenario_above_the_floor() -> tuple[list[dict], list[dict]]:
    """The bulk delete: every row holds more than the run takes off it."""
    return ITEMS + ITEMS, _removes(ITEMS)


def _scenario_at_the_floor() -> tuple[list[dict], list[dict]]:
    """Rows below the run's demand: some `-1`s land and the rest are refused, record by record."""
    return ITEMS[:6], _removes(ITEMS[:6] + ITEMS[:6] + ITEMS[6:8])


def _scenario_absent_rows_and_pre_deploy_personas() -> tuple[list[dict], list[dict]]:
    """No archetype rows at all: every decrement finds NO row, so the persona compatibility runs."""
    pre_deploy = [_item(n, persona_name='Frequent Flyer') for n in range(4)]
    colliding = [_item(n, persona_name='prospect') for n in range(4, 6)]
    return [], _removes(pre_deploy + colliding)


def _scenario_runs_broken_by_other_events() -> tuple[list[dict], list[dict]]:
    """Inserts, edits and skipped REMOVEs between the runs, which must end them."""
    edited = dict(ITEMS[5], category='pricing', sentiment_score=Decimal('0.4'))
    dateless = _item(9, date=None)
    records = [
        *_removes(ITEMS[:3]),
        _raw('INSERT', 10, new=ITEMS[0]),
        *_removes(ITEMS[0:2], start=11),
        _raw('MODIFY', 13, new=edited, old=ITEMS[5]),
        _raw('REMOVE', 14, old=ITEMS[6]),
        _raw('REMOVE', 15, old=ITEMS[7], identity=TTL_IDENTITY),
        _raw('REMOVE', 16, old=dateless),
        _raw('REMOVE', 17),
        *_removes(ITEMS[8:12], start=18),
    ]
    return ITEMS, records


def _scenario_a_record_that_cannot_be_reversed() -> tuple[list[dict], list[dict]]:
    """A score stored as text fails its own record after its counters moved; the others are unaffected.

    ITEMS[4] shares the poison item's day, so the day's average is a GROUP the poison
    record must leave before the scores are summed.
    """
    poison = dict(ITEMS[1], sentiment_score='0.5')
    return ITEMS, _removes([ITEMS[0], poison, ITEMS[2], ITEMS[3], ITEMS[4]])


SCENARIOS = {
    'every row above the floor': _scenario_above_the_floor,
    'rows below the floor': _scenario_at_the_floor,
    'absent rows and pre-deploy personas': _scenario_absent_rows_and_pre_deploy_personas,
    'runs broken by other events': _scenario_runs_broken_by_other_events,
    'a record that cannot be reversed': _scenario_a_record_that_cannot_be_reversed,
}


def _seed(table, inserts: list[dict]) -> None:
    from aggregator import handler

    with patch.object(handler, 'aggregates_table', table):
        for item in inserts:
            handler.record_handler(DynamoDBRecord(_raw('INSERT', 0, new=item)))
    # The legacy persona rows a pre-deploy insert created (`_reverse_a_pre_deploy_persona_row`).
    for day in DAYS:
        for name in ('Frequent Flyer', 'prospect'):
            table.put_item(Item={'pk': f'METRIC#persona#{name}', 'sk': day, 'count': Decimal(5)})


def _rows(table) -> list[dict]:
    rows = table.scan()['Items']
    return sorted(({k: v for k, v in row.items() if k != 'updated_at'} for row in rows),
                  key=lambda row: (row['pk'], row['sk']))


def _throttled_on(table, pk: str):
    """`table.update_item`, refusing every write to `pk` the way an exhausted throttle does."""
    send = table.update_item

    def update_item(**request):
        if request['Key']['pk'] == pk:
            raise ClientError(
                {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
                'UpdateItem',
            )
        return send(**request)
    return update_item


def _apply(table, records: list[dict], processor) -> tuple[dict, list[str]]:
    """Run one batch through `processor`, returning its response and every refusal/decline logged."""
    from aggregator import handler

    noted: list[str] = []
    refuse, decline = handler._log_refusal, handler._log_decline

    def log_refusal(what: str, pk: str, sk: str) -> None:
        noted.append(f'refused {what} {pk} {sk}')
        refuse(what, pk, sk)

    def log_decline(what: str, pk: str, sk: str, because: str) -> None:
        noted.append(f'declined {what} {pk} {sk}')
        decline(what, pk, sk, because)

    with patch.object(handler, 'aggregates_table', table), \
            patch.object(handler, '_log_refusal', log_refusal), \
            patch.object(handler, '_log_decline', log_decline):
        response = process_partial_response(
            event={'Records': records}, record_handler=handler.record_handler, processor=processor,
        )
    return dict(response), sorted(noted)


@pytest.fixture
def twin_tables():
    """Two identical moto aggregates tables: one per path."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        yield create_pk_sk_table('agg-one-at-a-time', resource), create_pk_sk_table('agg-coalesced', resource)


@pytest.mark.parametrize('scenario', list(SCENARIOS))
def test_a_coalesced_run_leaves_every_aggregate_row_as_one_at_a_time_did(twin_tables, scenario):
    from aggregator import handler

    inserts, records = SCENARIOS[scenario]()
    one_at_a_time, coalesced = twin_tables
    _seed(one_at_a_time, inserts)
    _seed(coalesced, inserts)
    assert _rows(one_at_a_time) == _rows(coalesced)

    expected = _apply(one_at_a_time, records, BatchProcessor(event_type=EventType.DynamoDBStreams))
    actual = _apply(coalesced, records, handler.processor)

    assert _rows(coalesced) == _rows(one_at_a_time)
    assert actual == expected


def test_a_record_whose_write_fails_stops_there_as_it_did_alone(twin_tables):
    """A throttle on one counter fails exactly the records that write it, at that counter.

    One at a time, such a record never reaches its later (sorted) counters, its
    persona compatibility or its average; the coalesced run must leave those alone too.
    """
    from aggregator import handler

    inserts, records = _scenario_above_the_floor()
    one_at_a_time, coalesced = twin_tables
    _seed(one_at_a_time, inserts)
    _seed(coalesced, inserts)
    throttled = 'METRIC#daily_category#pricing'
    with patch.object(one_at_a_time, 'update_item', _throttled_on(one_at_a_time, throttled)):
        expected = _apply(one_at_a_time, records, BatchProcessor(event_type=EventType.DynamoDBStreams))
    with patch.object(coalesced, 'update_item', _throttled_on(coalesced, throttled)):
        actual = _apply(coalesced, records, handler.processor)

    assert len(expected[0]['batchItemFailures']) == sum(1 for item in ITEMS if item['category'] == 'pricing')
    assert _rows(coalesced) == _rows(one_at_a_time)
    assert actual == expected


def test_the_poison_record_is_the_only_failure_reported(twin_tables):
    """Pins what the equivalence above compares: one failed record, not the whole run."""
    from aggregator import handler

    inserts, records = _scenario_a_record_that_cannot_be_reversed()
    _, coalesced = twin_tables
    _seed(coalesced, inserts)
    response, _ = _apply(coalesced, records, handler.processor)
    assert response == {'batchItemFailures': [{'itemIdentifier': records[1]['dynamodb']['SequenceNumber']}]}


def test_a_run_sends_one_request_per_distinct_counter_rather_than_one_per_record(twin_tables):
    from aggregator import handler

    inserts, records = _scenario_above_the_floor()
    _, coalesced = twin_tables
    _seed(coalesced, inserts)
    distinct_counters = {key for item in ITEMS for key in handler.counter_keys(item, item['date'])}
    scored_days = {item['date'] for item in ITEMS if item['sentiment_score']}

    with patch.object(coalesced, 'update_item', wraps=coalesced.update_item) as update_item:
        _apply(coalesced, records, handler.processor)

    assert update_item.call_count == len(distinct_counters) + len(scored_days)
