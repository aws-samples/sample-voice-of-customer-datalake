"""Cursor-paged reads of the urgency index for ``GET /feedback/urgent``.

A page walks ``gsi3-by-urgency`` newest first, hydrates each index page with
BatchGetItem, applies the route's post-query filters, and stops once ``limit``
items are admitted. The returned cursor is the index key of the LAST ROW THE PAGE
CONSUMED, not DynamoDB's LastEvaluatedKey: the page can fill part-way through an
index page, and the rows after that point must be read by the next request, not
skipped.

The walk is bounded by ``max_scanned`` index rows; when the bound stops it, the
cursor still points at the next unread row, so the caller can keep loading.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

__all__ = ['URGENCY_KEY_FIELDS', 'UrgentPage', 'read_urgent_page']

#: The urgency index's key plus the table's key: what an ExclusiveStartKey needs.
URGENCY_KEY_FIELDS: Final = frozenset({'gsi3pk', 'gsi3sk', 'pk', 'sk'})

Row = dict[str, Any]
QueryPage = Callable[[Mapping[str, str] | None, int], Mapping[str, Any]]
Hydrate = Callable[[list[Row]], tuple[list[Row], bool]]


@dataclass(frozen=True)
class UrgentPage:
    """One page: the admitted items, the resume key (None = the window is exhausted), and short reads."""

    items: list[Row]
    next_key: dict[str, str] | None
    unread: bool


def _row_key(row: Mapping[str, Any], item: Mapping[str, Any] | None) -> dict[str, str] | None:
    """The index key of ``row`` (falling back to its hydrated item), or None when incomplete.

    Index rows always project their keys, so None only arises for malformed data; the
    caller then resumes from LastEvaluatedKey, which may skip the rest of that index page.
    """
    key = {name: row.get(name) or (item or {}).get(name) for name in URGENCY_KEY_FIELDS}
    if all(isinstance(value, str) and value for value in key.values()):
        return {name: str(value) for name, value in key.items()}
    return None


def _by_key(items: list[Row]) -> dict[tuple[Any, Any], Row]:
    return {(item.get('pk'), item.get('sk')): item for item in items}


@dataclass
class _Walk:
    limit: int
    admits: Callable[[Row], bool]
    items: list[Row]
    unread: bool = False

    def take(self, rows: list[Row], hydrated: dict[tuple[Any, Any], Row]) -> int | None:
        """Admit ``rows`` in order; the index of the row that filled the page, or None."""
        for index, row in enumerate(rows):
            item = hydrated.get((row.get('pk'), row.get('sk')))
            if item is not None and self.admits(item):
                self.items.append(item)
                if len(self.items) >= self.limit:
                    return index
        return None


def read_urgent_page(
    query_page: QueryPage,
    hydrate: Hydrate,
    admits: Callable[[Row], bool],
    *,
    limit: int,
    start_key: Mapping[str, str] | None,
    page_rows: int,
    max_scanned: int,
) -> UrgentPage:
    """Read one page of at most ``limit`` admitted items, starting after ``start_key``.

    ``query_page(start_key, page_rows)`` returns one DynamoDB Query response;
    ``hydrate(rows)`` returns ``(full items, unread)`` as `_batch_get_feedback` does.
    """
    walk = _Walk(limit=limit, admits=admits, items=[])
    key = dict(start_key) if start_key else None
    scanned = 0
    while True:
        response = query_page(key, page_rows)
        rows = list(response.get('Items', []))
        scanned += int(response.get('ScannedCount', len(rows)))
        full, unread = hydrate(rows)
        walk.unread = walk.unread or unread
        hydrated = _by_key(full)
        last_evaluated = response.get('LastEvaluatedKey')
        filled_at = walk.take(rows, hydrated)
        if filled_at is not None:
            consumed_all = filled_at == len(rows) - 1
            if consumed_all and not last_evaluated:
                return UrgentPage(walk.items, None, walk.unread)
            row = rows[filled_at]
            resume = _row_key(row, hydrated.get((row.get('pk'), row.get('sk'))))
            return UrgentPage(walk.items, resume or _string_key(last_evaluated), walk.unread)
        key = _string_key(last_evaluated)
        if key is None or scanned >= max_scanned:
            return UrgentPage(walk.items, key, walk.unread)


def _string_key(raw: object) -> dict[str, str] | None:
    """DynamoDB's LastEvaluatedKey as a string map (the urgency index's keys are all strings)."""
    if not isinstance(raw, Mapping) or not raw:
        return None
    return {str(name): str(value) for name, value in raw.items()}
