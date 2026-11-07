"""Users API test fixtures: a moto aggregates table wired into ``users_handler`` (flags and way-of-working
rows) and a Cognito double that knows a few users' subs."""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

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


def cognito_users(subs: dict[str, str]) -> MagicMock:
    """A Cognito client double: ``admin_get_user`` answers each username's sub from ``subs``, and the
    ``UserNotFoundException`` the handler catches is a real class. A spec programs the group calls itself."""
    cognito = MagicMock()
    cognito.exceptions.UserNotFoundException = type('UserNotFoundException', (Exception,), {})
    cognito.admin_get_user.side_effect = lambda Username, **_kw: {
        'UserAttributes': [{'Name': 'sub', 'Value': subs[Username]}]}
    return cognito
