"""Arrange helpers shared by the `shared/document_versions.py` mutation suites."""
import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

import shared.document_versions as dv

COUNTER_KEY = {'pk': 'DOCUMENT_VERSIONS#PROJECT#p1', 'sk': 'PRD#digest'}
NOW_ISO = '2026-09-01T00:00:00+00:00'
NOW_EPOCH = 1_000


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def client_error(code: str, *reasons: str) -> ClientError:
    """A ClientError with *code*; *reasons* become its ``CancellationReasons``."""
    if not reasons:
        return ClientError({'Error': {'Code': code, 'Message': code}}, 'Op')
    return ClientError(
        {
            'Error': {'Code': code, 'Message': code},
            'CancellationReasons': [{'Code': reason} for reason in reasons],
        },
        'Op',
    )


def mock_table(name: object = 'projects') -> MagicMock:
    table = MagicMock()
    table.name = name
    return table


def transactions(table: MagicMock) -> list[list[dict[str, Any]]]:
    """The ``TransactItems`` of every ``transact_write_items`` call, in order."""
    return [c.kwargs['TransactItems'] for c in table.meta.client.transact_write_items.call_args_list]


@contextmanager
def frozen_time() -> Iterator[tuple[MagicMock, MagicMock]]:
    """Freeze wall clock, monotonic clock, sleep and the ISO timestamp; yield (monotonic, sleep)."""
    fake_datetime = MagicMock()
    fake_datetime.now.return_value.isoformat.return_value = NOW_ISO
    with (
        patch.object(dv.time, 'time', return_value=NOW_EPOCH),
        patch.object(dv.time, 'monotonic', return_value=0.0) as monotonic,
        patch.object(dv.time, 'sleep') as sleep,
        patch.object(dv, 'datetime', fake_datetime),
    ):
        yield monotonic, sleep
