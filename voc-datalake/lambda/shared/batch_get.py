"""Bounded BatchGetItem over one table: chunks of 100 keys, UnprocessedKeys retried.

Issued on the RESOURCE's client (``table.meta.client``), which takes and returns
native Python values rather than ``{'S': ...}`` wire types.

Fails closed: when keys are still unprocessed after ``BATCH_GET_ATTEMPTS`` the
caller's ``failure`` exception is raised. A read that quietly returned fewer rows
would make a live token, or a project the caller can see, vanish without an error.
"""
from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any, Final

from shared.logging import logger

# BatchGetItem's per-request key ceiling.
BATCH_GET_MAX_KEYS: Final = 100
BATCH_GET_ATTEMPTS: Final = 5
BATCH_GET_BACKOFF_SECONDS: Final = 0.05


def _chunk(table: Any, keys: Sequence[Mapping[str, Any]], read_options: Mapping[str, Any],
           failure: Exception) -> list[dict]:
    request: dict[str, Any] = {table.name: {**read_options, 'Keys': list(keys), 'ConsistentRead': True}}
    rows: list[dict] = []
    for attempt in range(BATCH_GET_ATTEMPTS):
        if attempt:
            # AWS's guidance for UnprocessedKeys: back off before re-asking.
            time.sleep(BATCH_GET_BACKOFF_SECONDS * 2 ** attempt)
        response = table.meta.client.batch_get_item(RequestItems=request)
        rows.extend(item for item in (response.get('Responses') or {}).get(table.name, [])
                    if isinstance(item, dict))
        unprocessed = response.get('UnprocessedKeys') or {}
        if not unprocessed.get(table.name, {}).get('Keys'):
            return rows
        request = unprocessed
    logger.error('BatchGetItem left keys unprocessed', extra={'attempts': BATCH_GET_ATTEMPTS})
    raise failure


def batch_get_all(table: Any, keys: Sequence[Mapping[str, Any]], *, failure: Exception,
                  read_options: Mapping[str, Any] | None = None) -> list[dict]:
    """Every row found for ``keys`` (strongly consistent; missing keys are simply absent).

    ``read_options`` adds e.g. ``ProjectionExpression``/``ExpressionAttributeNames``.
    """
    rows: list[dict] = []
    for start in range(0, len(keys), BATCH_GET_MAX_KEYS):
        rows.extend(_chunk(table, keys[start:start + BATCH_GET_MAX_KEYS], read_options or {}, failure))
    return rows
