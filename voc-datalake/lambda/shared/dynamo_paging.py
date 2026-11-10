"""DynamoDB pagination: every item of a Query, following ``LastEvaluatedKey``.

The one place a plain "read the whole result" walk lives. Loops that carry a
client cursor, a time budget or an early exit keep their own code.

Normalised at the boundary: non-dict items are skipped, and a malformed page
or cursor ends the walk. Lazy: a caller that stops early (or reaches
``max_items``) reads no further page. The caller's ``kwargs`` are never mutated.
"""
from collections.abc import Iterator, Mapping
from typing import Any


def iter_query(table: Any, kwargs: Mapping[str, Any], *, max_items: int | None = None) -> Iterator[dict]:
    """Yield the items of ``table.query(**kwargs)`` across every page (at most ``max_items``)."""
    if max_items is not None and max_items <= 0:
        return
    request = dict(kwargs)
    yielded = 0
    while True:
        response = table.query(**request)
        if not isinstance(response, dict):
            return
        page_items = response.get('Items')
        for item in page_items if isinstance(page_items, list) else ():
            if not isinstance(item, dict):
                continue
            yield item
            yielded += 1
            if yielded == max_items:
                return
        cursor = response.get('LastEvaluatedKey')
        if not isinstance(cursor, dict) or not cursor:
            return
        request['ExclusiveStartKey'] = cursor


def query_all(table: Any, kwargs: Mapping[str, Any], *, max_items: int | None = None) -> list[dict]:
    """``iter_query`` materialised: call it inside any ``try`` that guards the reads."""
    return list(iter_query(table, kwargs, max_items=max_items))


def count_query(table: Any, kwargs: Mapping[str, Any]) -> int:
    """How many items ``table.query(**kwargs)`` matches across every page (``Select='COUNT'``:
    after any ``FilterExpression``, no item is read back)."""
    request = {**kwargs, 'Select': 'COUNT'}
    total = 0
    while True:
        response = table.query(**request)
        if not isinstance(response, dict):
            return total
        count = response.get('Count')
        total += count if isinstance(count, int) else 0
        cursor = response.get('LastEvaluatedKey')
        if not isinstance(cursor, dict) or not cursor:
            return total
        request['ExclusiveStartKey'] = cursor
