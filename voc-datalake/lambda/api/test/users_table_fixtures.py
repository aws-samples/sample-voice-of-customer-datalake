"""A moto aggregates table wired into ``users_handler`` (flags and way-of-working rows)."""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import boto3
from moto import mock_aws

import users_handler
from shared.test.moto_tables import create_pk_sk_table


@contextmanager
def users_aggregates_table() -> Generator[Any, None, None]:
    """Yield the table; ``users_handler`` reads and writes it (and batch-reads through its resource)."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        table = create_pk_sk_table('test-aggregates', resource)
        with patch.object(users_handler, 'aggregates_table', table), \
                patch.object(users_handler, 'get_dynamodb_resource', return_value=resource):
            yield table
