"""A workspace's Documents Library in its export (7.62.00; docs/documents-library.md, "Export and delete").

* ``library``: voc-projects' ``WS#{ws}#LIBRARY``, its item rows (``ITEM#``) by ``sk``, each with only the fields it
  lists (``FIELDS``: the items' metadata and extraction outcome as the library API answers it, plus the row's key and
  its original's object key); never the extraction's claim token. The files themselves (``ws/{ws}/library/{item}/
  original`` and ``…/extracted``) are among the workspace's objects.

Not exported: the slug guards and the count (``SLUG#``, ``META``: routing, rebuilt from the items) and the passages
(``WS#{ws}#LIBRARY_CHUNKS#{item}``: each an embedding and a copy of a slice of the extracted text, derived, recomputed
when the item is extracted again).
"""
from __future__ import annotations

from typing import Any, Final

from jobs.workspace_export.pages import TABLE_KEY, Page, Row, items, key, last_key, only, sort_key, start
from shared.library_keys import ITEM_SK_PREFIX, library_pk
from shared.library_store import PUBLIC_FIELDS
from shared.ws_repo import WorkspaceScope, WorkspaceTable

__all__ = ['ENTITIES', 'LibrarySource']

ENTITIES: Final = ('library',)
#: An item: the library API's fields (shared/library_store.py ``PUBLIC_FIELDS``), its key and its original's key.
FIELDS: Final = ('pk', 'sk', *PUBLIC_FIELDS, 's3_key', 'extracted_at')
_ITEM_ROWS: Final = sort_key('begins_with(#sk, :item)', {':item': ITEM_SK_PREFIX})


class LibrarySource:
    """One workspace's library items, through its view of voc-projects."""

    def __init__(self, scope: WorkspaceScope, projects: WorkspaceTable) -> None:
        self.scope = scope
        self._projects = projects

    def page(self, _entity: str, cursor: dict[str, Any]) -> Page:
        page = self._projects.query('pk', library_pk(workspace=self.scope), **_ITEM_ROWS, **start(cursor.get('start')))
        rows = [Row(only(item, FIELDS), {'start': key(item, TABLE_KEY)}) for item in items(page)]
        last = last_key(page)
        return Page(rows, {'start': last} if last else None)
