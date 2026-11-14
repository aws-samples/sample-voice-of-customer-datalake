"""The fixed partitions of a workspace's memory in voc-memory, named once for its export and its hard delete
(docs/multi-workspace.md, "Export and delete"), so the two never read different partitions.

``memory_partitions(scope)``, in order: the company memories (``WS#{ws}#MEM#company``, by its key), each personal
status partition of ``gsi1-by-memory-status`` (``WS#{ws}#MEMSTATUS#personal#{status}``: every personal memory sits
in exactly one, as shared/memory_store.py writes it), the extraction cursors (``WS#{ws}#MEMCURSOR``) and the imports
(``WS#{ws}#MEMIMPORT``). A memory's events (``WS#{ws}#MEMEVT#{memory id}``) are one partition per memory, found from
the memories themselves. The export (jobs/workspace_export/memory.py) exports the company memories and imports and
only counts the personal ones and the cursors; the delete (jobs/workspace_delete/sweeps.py) deletes them all.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from shared.indexes import MEMORY_BY_STATUS_INDEX
from shared.memory_policy import SCOPE_PERSONAL, STATUSES
from shared.ws_repo import (
    WorkspaceScope,
    memory_company_pk,
    memory_cursor_pk,
    memory_import_pk,
    memory_status_pk,
)

__all__ = ['CURSORS', 'memory_partitions']

COMPANY: Final = 'company'
CURSORS: Final = 'cursors'
IMPORTS: Final = 'imports'
#: The personal status partitions' names: ``personal#{status}``.
PERSONAL_PREFIX: Final = f'{SCOPE_PERSONAL}#'


@dataclass(frozen=True)
class MemoryPartition:
    """One partition of a workspace's memory: its name, the attribute it is a partition of, and its index (None:
    the table itself)."""

    name: str
    attribute: str
    partition: str
    index: str | None = None

    def query_options(self) -> dict[str, Any]:
        """What a Query of it adds to the partition: the index, when it is one."""
        return {'IndexName': self.index} if self.index else {}

    @property
    def personal(self) -> bool:
        return self.name.startswith(PERSONAL_PREFIX)


def memory_partitions(scope: WorkspaceScope) -> tuple[MemoryPartition, ...]:
    """The workspace's fixed memory partitions, in order (the module docstring)."""
    return (
        MemoryPartition(COMPANY, 'pk', memory_company_pk(scope)),
        *(MemoryPartition(f'{PERSONAL_PREFIX}{status}', 'gsi1pk', memory_status_pk(scope, SCOPE_PERSONAL, status),
                          MEMORY_BY_STATUS_INDEX) for status in STATUSES),
        MemoryPartition(CURSORS, 'pk', memory_cursor_pk(scope)),
        MemoryPartition(IMPORTS, 'pk', memory_import_pk(scope)),
    )
