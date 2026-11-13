"""The administrators' hard cap (engineering/settings.py): off until saved, a change and its history row."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest

from engineering.board.test.table import TABLE, engineering_table
from engineering.settings import SETTINGS_KEY, HardCap, read_hard_cap, save_hard_cap

AT = datetime(2026, 11, 13, 9, 0, tzinfo=UTC)


@pytest.fixture
def table() -> Iterator[Any]:
    """A pk/sk table (moto), as voc-agents is, through the resource the API and the runtime use."""
    with engineering_table():
        yield boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)


def test_the_hard_cap_is_off_until_an_administrator_turns_it_on(table: Any) -> None:
    assert read_hard_cap(table) == HardCap()
    saved = save_hard_cap(table, on=True, by='admin-1', at=AT)
    assert read_hard_cap(table) == saved == HardCap(on=True, updated_at=AT.isoformat(), updated_by='admin-1')
    assert saved.view() == {'hard_cap': True, 'updated_at': AT.isoformat(), 'updated_by': 'admin-1'}


def test_each_change_keeps_its_history_row(table: Any) -> None:
    save_hard_cap(table, on=True, by='admin-1', at=AT)
    save_hard_cap(table, on=False, by='', at=AT)   # (the same second, no name: still its own row)
    rows = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                       ExpressionAttributeValues={':pk': SETTINGS_KEY['pk'], ':log': 'LOG#'})['Items']
    assert sorted((row['hard_cap'], row['by']) for row in rows) == [(False, 'unknown'), (True, 'admin-1')]
    assert read_hard_cap(table).on is False
