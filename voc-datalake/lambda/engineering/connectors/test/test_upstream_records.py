"""The upstream pull requests' records (upstream_records.py, 7.57.00): the run's, never replaced once opened, read back
for the run's overview; and the day's caps, the deployment's and each upstream's, a run counted once, every slot its
audit, all in the runs' writes' partitions with a claim's attributes alone (the broker's grant, unchanged)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.connectors.hosts import UpstreamRecord
from engineering.connectors.upstream_records import UpstreamRecords, caps_partition
from engineering.run_links import run_upstream

TABLE = 'voc-engineering'
RUN = '01JC8Z3K4M5N6P7Q8R9S0T1V2W'
UPSTREAM = 'upstream-org/refund-service'
#: What the broker's grant lets it write (engineering-broker.ts BROKER_CLAIM_ATTRIBUTES).
CLAIM_ATTRIBUTES = {'pk', 'sk', 'state', 'op', 'at', 'result', 'closed_at'}


@pytest.fixture
def client() -> Iterator[Any]:
    with mock_aws():
        dynamodb = boto3.client('dynamodb', region_name='us-east-1')
        dynamodb.create_table(TableName=TABLE, BillingMode='PAY_PER_REQUEST',
                              KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                         {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                              AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                                    {'AttributeName': 'sk', 'AttributeType': 'S'}])
        yield dynamodb


def every_item(client: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = client.scan(TableName=TABLE)['Items']
    return items


def test_the_runs_record_is_kept_and_an_opened_one_is_never_replaced(client: Any) -> None:
    records = UpstreamRecords(client, TABLE, clock=lambda: 1_800_000_000.0)
    records.record(RUN, UpstreamRecord('refused', UPSTREAM, reason='The upstream is archived.'))
    assert records.recorded(RUN) == UpstreamRecord('refused', UPSTREAM, reason='The upstream is archived.')
    opened = UpstreamRecord('opened', UPSTREAM, number=314, url=f'https://github.com/{UPSTREAM}/pull/314',
                            login='casey-dev')
    records.record(RUN, opened)
    records.record(RUN, UpstreamRecord('refused', UPSTREAM, reason='A later repeat refused.'))
    assert records.recorded(RUN) == opened
    assert run_upstream(client, TABLE, 'default', RUN) == {
        'state': 'opened', 'upstream': UPSTREAM, 'number': 314, 'url': f'https://github.com/{UPSTREAM}/pull/314',
        'as': 'casey-dev', 'reason': None, 'at': '2027-01-15T08:00:00+00:00', 'compare_url': None, 'title': None,
        'description': None}
    assert all(set(item) <= CLAIM_ATTRIBUTES for item in every_item(client))
    assert all(item['pk']['S'].startswith('WS#default#WRITES#') for item in every_item(client))


def test_an_address_off_the_upstream_is_read_back_as_none(client: Any) -> None:
    records = UpstreamRecords(client, TABLE)
    records.record(RUN, UpstreamRecord('opened', UPSTREAM, number=314, url='https://elsewhere.example.com/pull/314'))
    found = run_upstream(client, TABLE, 'default', RUN)
    assert found is not None
    assert (found['number'], found['url']) == (None, None)


def test_the_day_caps_count_each_run_once_and_refuse_past_them(client: Any) -> None:
    records = UpstreamRecords(client, TABLE, daily_cap=3, repo_cap=2)
    day = '2026-11-19'
    assert records.take_slot(day, UPSTREAM, 'run-a', 'fork-1') is None
    assert records.take_slot(day, UPSTREAM, 'run-a', 'fork-1') is None   # (the same run: counted once)
    assert records.take_slot(day, UPSTREAM, 'run-b', 'fork-1') is None
    refused = records.take_slot(day, UPSTREAM, 'run-c', 'fork-1')
    assert refused is not None
    assert f'{UPSTREAM} takes at most 2' in refused
    assert records.take_slot(day, 'other-org/tool', 'run-d', 'fork-2') is None
    full = records.take_slot(day, 'third-org/app', 'run-e', 'fork-3')
    assert full is not None
    assert 'this deployment opens at most 3' in full
    assert records.take_slot('2026-11-20', UPSTREAM, 'run-c', 'fork-1') is None   # (a new UTC day)
    assert all(set(item) <= CLAIM_ATTRIBUTES for item in every_item(client))


def test_each_slot_is_the_audit_of_its_upstream_pull_request(client: Any) -> None:
    records = UpstreamRecords(client, TABLE)
    records.take_slot('2026-11-19', UPSTREAM, RUN, 'fork-1')
    records.close_slot('2026-11-19', UPSTREAM, RUN, {'state': 'done', 'number': 314, 'as': 'casey-dev'})
    for partition in (caps_partition('2026-11-19'), caps_partition('2026-11-19', UPSTREAM)):
        [slot] = client.query(TableName=TABLE, KeyConditionExpression='pk = :pk',
                              ExpressionAttributeValues={':pk': {'S': partition}})['Items']
        assert slot['state']['S'] == 'done'
        assert json.loads(slot['result']['S']) == {'run_id': RUN, 'upstream': UPSTREAM, 'day': '2026-11-19',
                                                   'state': 'done', 'number': 314, 'as': 'casey-dev'}
    assert caps_partition('2026-11-19', 'Upstream-Org/X') == 'WS#default#WRITES#_upstream#2026-11-19#upstream-org/x'
