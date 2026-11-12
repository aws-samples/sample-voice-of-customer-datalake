"""Test doubles for the admin's stored model config read by shared/model_config.py."""
from collections.abc import Generator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest


@contextmanager
def stored_model_config(
    monkeypatch: pytest.MonkeyPatch, item: object, error: Exception | None = None, default: object = None,
) -> Generator[MagicMock, None, None]:
    """An aggregates table whose model-config item (the picks, ``SETTINGS#model``) is *item* and whose deployment
    default (``SETTINGS#model_default``) is *default* (each absent when falsy), or whose every read raises *error*,
    wired in as the module's DynamoDB resource. Yields the table double."""
    monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
    table = MagicMock()
    if error is not None:
        table.get_item.side_effect = error
    else:
        rows = {'SETTINGS#model': item, 'SETTINGS#model_default': default}

        def get_item(Key: dict, **_kwargs: object) -> dict:
            row = rows.get(Key['pk'])
            return {'Item': row} if row else {}

        table.get_item.side_effect = get_item
    resource = MagicMock()
    resource.Table.return_value = table
    with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
        yield table


def picks_reads(table: MagicMock) -> int:
    """How many times the picks' row was read: one per cache fill (the deployment default is read beside it)."""
    return sum(1 for call in table.get_item.call_args_list if call.kwargs.get('Key', {}).get('pk') == 'SETTINGS#model')


#: The reads of one model lookup, in order: the picks' row, then the deployment's default (pinned at deploy).
MODEL_ROWS_READ = [{'Key': {'pk': 'SETTINGS#model', 'sk': 'config'}},
                   {'Key': {'pk': 'SETTINGS#model_default', 'sk': 'config'}}]
