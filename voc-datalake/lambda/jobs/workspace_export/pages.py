"""One page of a Query, as the export job reads it (entities.py, memory.py): the job pages by hand, a page at a time
with a checkpointed cursor, so a hand-over between any two rows resumes from the last row's key."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

__all__ = ['TABLE_KEY', 'items', 'key', 'last_key', 'start']

#: A table's key: the cursor that resumes after a row.
TABLE_KEY: Final = ('pk', 'sk')


def key(item: Mapping[str, Any], attributes: tuple[str, ...]) -> dict[str, Any]:
    """The key a Query resumes after ``item`` from: every one of ``attributes`` (a key attribute: always there)."""
    return {attribute: item[attribute] for attribute in attributes}


def start(cursor_start: object) -> dict[str, Any]:
    """``ExclusiveStartKey`` from a cursor's saved key, or nothing for the first page."""
    return {'ExclusiveStartKey': dict(cursor_start)} if isinstance(cursor_start, Mapping) and cursor_start else {}


def items(page: Mapping[str, Any]) -> list[dict[str, Any]]:
    found = page.get('Items')
    return [dict(item) for item in found if isinstance(item, Mapping)] if isinstance(found, list) else []


def last_key(page: Mapping[str, Any]) -> dict[str, Any] | None:
    """A page's cursor: the job pages by hand (a time budget, a hand-over between rows, a checkpointed cursor)."""
    last = page.get('LastEvaluatedKey')
    return dict(last) if isinstance(last, Mapping) and last else None
