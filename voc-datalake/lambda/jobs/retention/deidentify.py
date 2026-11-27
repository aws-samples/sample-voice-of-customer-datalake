"""voc-retention: what the projects walk (project_people.py) and the pins' (pins.py) share when they de-identify a row
an erasure by email reaches (7.98.00, 3g-pin round 1: one copy of the rule, so a later fix lands once).

- ``same_name``: whether a stored name or address is the erased address (``casefold``), or its first
  ``MAX_NAME_CHARS`` characters (before 7.43.00 a name that fell back to a long address was stored cut to that length);
- ``MAX_TRIES`` and ``RowKeptChanging``: a row that changed meanwhile is read again and rewritten at most that many
  times; past that, if it still holds the address, the job fails (an admin runs it again: every step is idempotent);
- ``id_page``: one page of a partition's sort keys under a prefix, the ids after it kept by their shape and the others
  counted (``project_ids_malformed``).
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

from jobs.retention import workspaces
from shared.document_comments import MAX_NAME_CHARS
from shared.project_walk import ID_PAGE, checked_key, merged, query_page, sort_key
from shared.retention import MALFORMED_ID_COUNTER
from shared.scoped_query import SK_BEGINS

#: A row that changed meanwhile is read again and rewritten at most this many times, then the job fails.
MAX_TRIES: Final = 3


class RowKeptChanging(RuntimeError):
    """A row changed under every one of ``MAX_TRIES`` writes and still holds the address: the job fails and says
    so (an admin reruns it), never leaving the address silently."""


def same_name(value: object, wanted: str) -> bool:
    """Whether ``value`` is the address ``wanted`` (already stripped and casefolded), or its first ``MAX_NAME_CHARS``
    characters."""
    if not isinstance(value, str):
        return False
    held = value.strip().casefold()
    return held == wanted or (len(wanted) > MAX_NAME_CHARS and held == wanted[:MAX_NAME_CHARS])


def id_page(view: Any, pk: str, start: object, prefix: str, shaped: Callable[[str], bool],
            run: dict[str, Any]) -> tuple[list[str], dict[str, Any] | None]:
    """One page (``ID_PAGE``, strongly consistent, the sort keys only) of ``pk``'s rows whose sort key starts with
    ``prefix``: the ids after it that ``shaped`` accepts, and the key the next page starts from (None at the end); an id
    of another shape is counted (``project_ids_malformed``), never read further."""
    rows, following = query_page(view, pk, checked_key(start), Limit=ID_PAGE, ConsistentRead=True,
                                 **merged(sort_key(SK_BEGINS, {':sk': prefix}), {'ProjectionExpression': '#sk'}))
    listed = [str(row.get('sk', '')).removeprefix(prefix) for row in rows]
    kept = [each for each in listed if shaped(each)]
    workspaces.count(run, MALFORMED_ID_COUNTER, len(listed) - len(kept))
    return kept, following
