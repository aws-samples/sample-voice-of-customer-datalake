"""Test support: the ``voc-engineering`` table on moto, with one run whose META row carries its task cap."""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from itertools import count
from typing import Any

import boto3
from moto import mock_aws

from engineering.board.store import BoardStore

TABLE = 'voc-engineering'
RUN = '01JD0000000000000000000000'


def create_table(region: str = 'us-east-1') -> Any:
    """Inside a moto context: the table, empty; a low-level client on it."""
    dynamo = boto3.client('dynamodb', region_name=region)
    dynamo.create_table(TableName=TABLE, BillingMode='PAY_PER_REQUEST',
                        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                   {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                        AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                              {'AttributeName': 'sk', 'AttributeType': 'S'}])
    return dynamo


def start_run(dynamo: Any, run_id: str = RUN, max_tasks: int = 10) -> None:
    """The run's META row, as the run's start writes it (with its task cap)."""
    dynamo.put_item(TableName=TABLE, Item={'pk': {'S': f'WS#default#RUN#{run_id}'}, 'sk': {'S': 'META'},
                                           'max_tasks': {'N': str(max_tasks)}})


@contextmanager
def engineering_table(max_tasks: int = 10, run_id: str = RUN) -> Generator[Any]:
    """A low-level DynamoDB client on the table; the run exists (the run's start writes its META row)."""
    with mock_aws():
        dynamo = create_table()
        start_run(dynamo, run_id, max_tasks)
        yield dynamo


def board(client: Any) -> BoardStore:
    ids = count(1)
    return BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}')
