"""One page of a Query, as the export job reads it (entities.py, memory.py, conversations.py): the job pages by hand, a page at a time
with a checkpointed cursor, so a hand-over between any two rows resumes from the last row's key."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceTable

__all__ = ['TABLE_KEY', 'count_page', 'items', 'key', 'last_key', 'start']

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


def count_page(view: WorkspaceTable, attribute: str, partition: str, state: dict[str, Any],
               time_left: Callable[[], bool], *, more_after: bool, **kwargs: Any) -> bool:
    """One ``Select COUNT`` page of ``partition`` (memory.py's counts, its one caller: no row is ever read; the
    conversations' count asks one row per owner and does not page, conversations.py),
    from ``state['cursor']``: its ``Count`` added to ``state['total']``, its cursor carried in ``state['cursor']``
    (None once the partition is counted). Then the counts' hand-over rule: False when there is more to count (this
    partition's next page, or ``more_after``, another partition after it) and ``time_left`` says no, so the caller
    hands over with ``state`` where the next invocation goes on; True otherwise. Each invocation so reads at least one
    page, and at most one past the reserve."""
    page = view.query(attribute, partition, Select='COUNT', **kwargs, **start(state.get('cursor')))
    state['total'] = int(state.get('total') or 0) + int(page.get('Count') or 0)
    state['cursor'] = last_key(page)
    return not ((state['cursor'] is not None or more_after) and not time_left())
