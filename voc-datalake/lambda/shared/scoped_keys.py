"""A workspace's copy of a deployment-wide key: the same key inside its partitions (docs/multi-workspace.md).

Radar's and memory's rows (shared/radar_reads.py, shared/memory_store.py), like the metrics the data path keeps
(shared/ws_repo.py ``metric_pk``), are the deployment's keys with the workspace's prefix.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['scoped_pk']


def scoped_pk(workspace: WorkspaceScope | None, pk: str) -> str:
    """``pk`` itself without a workspace, else the workspace's copy of it (``WS#{ws}#{pk}``)."""
    return pk if workspace is None else workspace.key(pk)
