"""Bounded BatchGetItem over one table: chunks of 100 keys, UnprocessedKeys retried.

Issued on the RESOURCE's client (``table.meta.client``), which takes and returns
native Python values rather than ``{'S': ...}`` wire types.

Fails closed: when keys are still unprocessed after ``BATCH_GET_ATTEMPTS`` calls
for one chunk (every call counts, whether or not it made progress), the caller's
``failure`` is raised. A read that quietly returned fewer rows would make a live
token, or a project the caller can see, vanish without an error. The bound keeps
a chunk to 5 calls and at most 1.5 s of backoff, well inside API Gateway's 29 s
for the REST routes that read through it.
"""
from __future__ import annotations

import random
import time
from collections.abc import Mapping, Sequence
from typing import Any, Final

from shared.logging import logger

# BatchGetItem's per-request key ceiling.
BATCH_GET_MAX_KEYS: Final = 100
BATCH_GET_ATTEMPTS: Final = 5
BATCH_GET_BACKOFF_SECONDS: Final = 0.05


def unprocessed_backoff(attempt: int) -> None:
    """AWS's guidance for a batch call's unprocessed keys or items: back off before re-asking, with full jitter so
    concurrent callers spread out (a random wait up to 0.1, 0.2, 0.4 and 0.8 s before the second to the fifth call).
    Also the layer's batch delete (shared/ws_repo.py ``WorkspaceTable.batch_delete``)."""
    time.sleep(random.uniform(0, BATCH_GET_BACKOFF_SECONDS * 2 ** attempt))  # noqa: S311 — jitter needs no cryptographic randomness


def _chunk(table: Any, keys: Sequence[Mapping[str, Any]], read_options: Mapping[str, Any],
           failure: Exception) -> list[dict]:
    # Strongly consistent unless the caller's read_options say otherwise.
    request: dict[str, Any] = {table.name: {'ConsistentRead': True, **read_options, 'Keys': list(keys)}}
    rows: list[dict] = []
    for attempt in range(BATCH_GET_ATTEMPTS):
        if attempt:
            unprocessed_backoff(attempt)
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
    """Every row found for ``keys`` (missing keys are simply absent).

    ``read_options`` adds e.g. ``ProjectionExpression``/``ExpressionAttributeNames``; reads are strongly consistent
    unless it sets ``ConsistentRead`` to False.
    """
    rows: list[dict] = []
    for start in range(0, len(keys), BATCH_GET_MAX_KEYS):
        rows.extend(_chunk(table, keys[start:start + BATCH_GET_MAX_KEYS], read_options or {}, failure))
    return rows
