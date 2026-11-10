"""The aggregator bumps data_version ONCE per stream batch that carried a feedback write (docs/caching.md)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from shared.data_version import DATA_VERSION_KEY, BatchBump, bump_data_version


@pytest.fixture(autouse=True)
def _clean_batch_mark(monkeypatch):
    """Other suites call `record_handler` directly, which marks without a flush: start from a fresh batch."""
    from aggregator import handler
    monkeypatch.setattr(handler, 'data_changed', BatchBump(bump_data_version))


def _batch(*records: tuple[dict, str]) -> dict:
    return {'Records': [
        {**record, 'eventSource': 'aws:dynamodb', 'eventID': f'evt-{sequence}',
         'dynamodb': {**record['dynamodb'], 'SequenceNumber': sequence}}
        for record, sequence in records
    ]}


def _version_bumps(table) -> int:
    return sum(1 for call in table.update_item.call_args_list if call.kwargs.get('Key') == DATA_VERSION_KEY)


def test_a_batch_of_three_inserts_bumps_once(sample_dynamodb_stream_record, lambda_context):
    from aggregator.handler import lambda_handler

    records = [(sample_dynamodb_stream_record, str(n)) for n in (111, 222, 333)]
    with patch('aggregator.handler.aggregates_table') as table:
        lambda_handler(_batch(*records), lambda_context)
    assert _version_bumps(table) == 1


def test_a_batch_without_a_feedback_write_bumps_nothing(sample_dynamodb_stream_record, lambda_context):
    from aggregator.handler import lambda_handler

    unknown = {**sample_dynamodb_stream_record, 'eventName': 'TRUNCATE'}
    with patch('aggregator.handler.aggregates_table') as table:
        lambda_handler(_batch((unknown, '444')), lambda_context)
    assert _version_bumps(table) == 0


def test_each_batch_gets_its_own_bump(sample_dynamodb_stream_record, lambda_context):
    from aggregator.handler import lambda_handler

    with patch('aggregator.handler.aggregates_table') as table:
        lambda_handler(_batch((sample_dynamodb_stream_record, '555')), lambda_context)
        lambda_handler(_batch((sample_dynamodb_stream_record, '666')), lambda_context)
    assert _version_bumps(table) == 2
