"""Test doubles for the admin's stored model config read by shared/model_config.py."""
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest


@contextmanager
def stored_model_config(
    monkeypatch: pytest.MonkeyPatch, item: object, error: Exception | None = None,
) -> Iterator[MagicMock]:
    """An aggregates table whose model-config item is *item* (or absent when
    falsy), or whose every read raises *error*, wired in as the module's
    DynamoDB resource. Yields the table double."""
    monkeypatch.setenv('AGGREGATES_TABLE', 'agg')
    table = MagicMock()
    if error is not None:
        table.get_item.side_effect = error
    else:
        table.get_item.return_value = {'Item': item} if item else {}
    resource = MagicMock()
    resource.Table.return_value = table
    with patch('shared.model_config.get_dynamodb_resource', return_value=resource):
        yield table
