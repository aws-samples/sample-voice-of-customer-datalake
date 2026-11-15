"""A workspace's copy of a deployment-wide key: the same key inside its partitions (docs/multi-workspace.md).

Radar's and memory's rows (shared/radar_reads.py, shared/memory_store.py), like the metrics the data path keeps
(shared/ws_repo.py ``metric_pk``), are the deployment's keys with the workspace's prefix. A project's objects
(prototypes, product documents; since 7.35.00) are the deployment's object keys under the workspace's ``ws/{ws}/``
(``scoped_object_key``).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['scoped_object_key', 'scoped_pk']


def scoped_pk(workspace: WorkspaceScope | None, pk: str) -> str:
    """``pk`` itself without a workspace, else the workspace's copy of it (``WS#{ws}#{pk}``)."""
    return pk if workspace is None else workspace.key(pk)


def scoped_object_key(workspace: WorkspaceScope | None, key: str) -> str:
    """The object key ``key`` itself without a workspace, else under the workspace's own prefix (shared/ws_repo.py
    ``s3_prefix``, ``ws/{ws}/``), which no other workspace's key starts with."""
    if workspace is None:
        return key
    # Imported here: this module stays standard library only for the deployment's callers (boto3-free bundles).
    from shared.ws_repo import s3_prefix

    return f'{s3_prefix(workspace)}{key}'
