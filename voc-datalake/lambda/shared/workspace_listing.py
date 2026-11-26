"""Every active workspace, for a scheduled worker that serves each one (docs/multi-workspace.md): memory retention's
sweep, Radar's scan fan-out.

One Query a page of the platform's listing partition (shared/platform_workspaces.py ``list_workspaces``), never a
Scan; a workspace whose status is not ``active`` (being deleted, paused) is left out. Each id comes back as a
``WorkspaceScope`` (shared/ws_repo.py ``scope_from_message``: the listing's row is our own code's, written from a
scope).
"""
from __future__ import annotations

from typing import Any, Final

from shared.platform_workspaces import list_workspaces
from shared.ws_repo import WorkspaceScope, scope_from_message

__all__ = ['active_workspaces']

#: A page of the platform's listing of workspaces.
LISTING_PAGE: Final = 100


def active_workspaces(workspaces_table: Any) -> list[WorkspaceScope]:
    """Every active workspace, from the platform's listing (one Query a page; never a Scan)."""
    found: list[WorkspaceScope] = []
    cursor = None
    while True:
        page, cursor = list_workspaces(workspaces_table, limit=LISTING_PAGE, cursor=cursor)
        found += [scope_from_message({'workspace_id': row['id']}) for row in page if row.get('status') == 'active']
        if not cursor:
            return found
