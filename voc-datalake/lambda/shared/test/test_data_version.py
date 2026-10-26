"""shared.data_version: the cache version counters (docs/caching.md)."""
from __future__ import annotations

import threading
from decimal import Decimal
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from shared import data_version
from shared.data_version import (
    CONFIG_VERSION_KEY,
    DATA_VERSION_KEY,
    RADAR_VERSION_KEY,
    BatchBump,
    Versions,
    bump_config_version,
    bump_data_version,
    bump_radar_version,
    read_versions,
)
from shared.earliest_date import EARLIEST_DATE_KEY


def _table(name: str):
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName=name,
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                              {'AttributeName': 'sk', 'AttributeType': 'S'}],
        BillingMode='PAY_PER_REQUEST',
    )


@pytest.fixture
def tables():
    with mock_aws():
        yield _table('aggregates'), _table('radar')


class TestBumps:
    def test_each_bump_adds_one_to_its_own_row(self, tables):
        aggregates, radar = tables
        assert bump_data_version(aggregates)
        assert bump_data_version(aggregates)
        assert bump_config_version(aggregates)
        assert bump_radar_version(radar)
        assert aggregates.get_item(Key=DATA_VERSION_KEY)['Item']['v'] == 2
        assert aggregates.get_item(Key=CONFIG_VERSION_KEY)['Item']['v'] == 1
        assert radar.get_item(Key=RADAR_VERSION_KEY)['Item']['v'] == 1

    def test_a_bump_stamps_updated_at(self, tables):
        aggregates, _ = tables
        bump_data_version(aggregates)
        assert aggregates.get_item(Key=DATA_VERSION_KEY)['Item']['updated_at'].startswith('20')

    def test_a_failed_bump_is_logged_and_never_raises(self):
        table = MagicMock()
        table.update_item.side_effect = ClientError({'Error': {'Code': 'AccessDeniedException'}}, 'UpdateItem')
        assert bump_data_version(table) is False

    def test_no_table_is_a_no_op(self):
        assert bump_config_version(None) is False


class TestBatchBump:
    def test_many_marks_make_one_bump(self):
        bump = MagicMock(return_value=True)
        batch = BatchBump(bump)
        for _ in range(25):
            batch.mark()
        assert batch.flush('table') is True
        bump.assert_called_once_with('table')

    def test_nothing_marked_bumps_nothing(self):
        bump = MagicMock(return_value=True)
        assert BatchBump(bump).flush('table') is False
        bump.assert_not_called()

    def test_a_flush_resets_so_the_next_batch_starts_clean(self):
        bump = MagicMock(return_value=True)
        batch = BatchBump(bump)
        batch.mark()
        batch.flush('table')
        batch.flush('table')
        assert bump.call_count == 1

    def test_marks_from_many_threads_still_make_one_bump(self):
        bump = MagicMock(return_value=True)
        batch = BatchBump(bump)
        workers = [threading.Thread(target=batch.mark) for _ in range(16)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        batch.flush('table')
        assert bump.call_count == 1


class TestReadVersions:
    def test_unset_rows_read_as_zero(self, tables):
        aggregates, _ = tables
        read = read_versions(aggregates)
        assert read.versions == Versions(0, 0, None)
        assert read.earliest_date is None

    def test_one_call_returns_both_counters_and_the_watermark(self, tables):
        aggregates, _ = tables
        bump_data_version(aggregates)
        bump_config_version(aggregates)
        bump_config_version(aggregates)
        aggregates.put_item(Item={**EARLIEST_DATE_KEY, 'date': '2025-01-15'})
        read = read_versions(aggregates)
        assert read.versions == Versions(1, 2, None)
        assert read.earliest_date == '2025-01-15'

    def test_the_radar_counter_comes_from_the_radar_table_in_the_same_call(self, tables):
        aggregates, radar = tables
        bump_radar_version(radar)
        assert read_versions(aggregates, radar).versions == Versions(0, 0, 1)

    def test_the_read_is_a_single_strongly_consistent_batch_get(self):
        table = MagicMock()
        table.name = 'aggregates'
        table.meta.client.batch_get_item.return_value = {'Responses': {'aggregates': []}}
        read_versions(table)
        request = table.meta.client.batch_get_item.call_args.kwargs['RequestItems']['aggregates']
        assert request['ConsistentRead'] is True
        assert request['Keys'] == [DATA_VERSION_KEY, CONFIG_VERSION_KEY, EARLIEST_DATE_KEY]
        table.get_item.assert_not_called()

    def test_unprocessed_keys_mean_no_versions_and_a_plain_watermark_read(self):
        table = MagicMock()
        table.name = 'aggregates'
        table.meta.client.batch_get_item.return_value = {
            'Responses': {'aggregates': []}, 'UnprocessedKeys': {'aggregates': {'Keys': [DATA_VERSION_KEY]}}}
        table.get_item.return_value = {'Item': {'date': '2025-02-01'}}
        read = read_versions(table)
        assert read.versions is None
        assert read.earliest_date == '2025-02-01'

    def test_a_failed_read_fails_open_to_no_versions(self):
        table = MagicMock()
        table.name = 'aggregates'
        table.meta.client.batch_get_item.side_effect = ClientError({'Error': {'Code': 'Throttling'}}, 'BatchGetItem')
        table.get_item.return_value = {}
        read = read_versions(table)
        assert read.versions is None
        assert read.earliest_date is None

    @pytest.mark.parametrize('bad', ['3', True, None, Decimal('1.0')])
    def test_a_malformed_counter_means_no_versions(self, bad):
        table = MagicMock()
        table.name = 'aggregates'
        row = {**DATA_VERSION_KEY, 'v': bad}
        table.meta.client.batch_get_item.return_value = {'Responses': {'aggregates': [row]}}
        table.get_item.return_value = {}
        expected_ok = isinstance(bad, Decimal)
        assert (read_versions(table).versions is not None) is expected_ok

    def test_no_table_reads_nothing(self):
        assert read_versions(None) == data_version.VersionRead(None, None)
