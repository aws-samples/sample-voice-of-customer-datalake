"""The upstream pull requests' records (upstream_records.py, 7.57.00): the run's, never replaced once opened, read back
for the run's overview, in the runs' writes' partitions with a claim's attributes alone (the broker's grant,
unchanged)."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.connectors.hosts import UpstreamRecord
from engineering.connectors.upstream_records import UpstreamRecords
from engineering.run_links import run_upstream

RUN = '01JC8Z3K4M5N6P7Q8R9S0T1V2W'
UPSTREAM = 'upstream-org/refund-service'
#: What the broker's grant lets it write (engineering-broker.ts BROKER_CLAIM_ATTRIBUTES).
CLAIM_ATTRIBUTES = {'pk', 'sk', 'state', 'op', 'at', 'result', 'closed_at'}


@pytest.fixture
def client() -> Iterator[Any]:
    with mock_aws():
        yield create_table()


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
