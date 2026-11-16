"""One page of a Query, as the export job reads it (entities.py, memory.py, conversations.py): the job pages by hand, a page at a time
with a checkpointed cursor, so a hand-over between any two rows resumes from the last row's key."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final

from shared.project_walk import sort_key

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceTable

__all__ = ['TABLE_KEY', 'Page', 'Row', 'count_page', 'items', 'key', 'last_key', 'only', 'sort_key', 'start']

#: A table's key: the cursor that resumes after a row.
TABLE_KEY: Final = ('pk', 'sk')


@dataclass(frozen=True)
class Row:
    """One row to export, the cursor that resumes right after it, and the counts the row adds once it is written
    (``tally``: handler.py ``_write_pages``, so a row a hand-over leaves unwritten counts when it is)."""

    item: dict[str, Any]
    after: dict[str, Any]
    tally: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Page:
    """One page of an entity: its rows, the cursor of the next page (None: the entity is done), and the counts the
    page adds once every row of it is written (``tally``: handler.py ``_write_pages``; a page a hand-over cuts is read
    again from its last row, so it counts once)."""

    rows: list[Row]
    following: dict[str, Any] | None
    tally: Mapping[str, int] = field(default_factory=dict)


def only(item: Mapping[str, Any], names: tuple[str, ...] | frozenset[str]) -> dict[str, Any]:
    """``item``'s fields that ``names`` lists, and no other (every allowlisted entity's rows)."""
    kept = set(names) & set(item)
    return {name: item[name] for name in sorted(kept)}


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
