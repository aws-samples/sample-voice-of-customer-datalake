"""Where an erasure job's row lives, on either path, and a workspace's one live erasure at a time (TENETS.md D5;
docs/source-policies.md, "Workspace items").

* The deployment's jobs: ``pk JOB#erasure`` / ``sk er_<12 hex>`` in voc-aggregates, exactly as before.
* A workspace's jobs: their own partition, ``WS#{ws}#JOB#erasure`` (shared/ws_repo.py ``erasure_job_pk``), read and
  written through the workspace layer (``ws_table``), so a workspace's volume never pushes the deployment's jobs or
  another workspace's out of a list: each list is one bounded Query of its own partition. The settings API writes
  the row and names the workspace on the worker's invoke event (``workspace_payload``); voc-retention reads the row
  by that key (``job_key``) and checks that the row names the same workspace.
* One live erasure per workspace: its lock row ``WS#{ws}#JOB#erasure`` / ``LOCK``, put with a condition (no row, a
  released one, or one taken more than ``STALE_AFTER`` ago), the same rule as a source's lock
  (shared/source_erasure.py): the second start answers 409. The worker renews it at each hand-over and releases it
  (UpdateItem ``released_at``, never a delete) when the job completes or fails; a release names its job, so a job
  whose stale lock was taken over never frees its successor's. A lock row's ``sk`` does not start ``er_``, so no list
  shows it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Final

from shared.retention import ERASURE_JOB_PK
from shared.source_erasure import LockWrite, put_free_lock, stamp_own_lock
from shared.ws_repo import WorkspaceScope, erasure_job_pk, ws_table

__all__ = [
    'WorkspaceErasureRunning',
    'acquire_workspace_lock',
    'job_key',
    'job_partition',
    'refresh_workspace_lock',
    'release_workspace_lock',
]

WORKSPACE_LOCK_SK: Final = 'LOCK'


class WorkspaceErasureRunning(Exception):
    """Another erasure of the workspace holds its lock (the API answers 409)."""


def job_partition(scope: WorkspaceScope | None) -> str:
    """The partition of ``scope``'s erasure jobs: the deployment's ``JOB#erasure`` or ``WS#{ws}#JOB#erasure``."""
    return ERASURE_JOB_PK if scope is None else erasure_job_pk(scope)


def job_key(job_id: str, scope: WorkspaceScope | None) -> dict[str, str]:
    """The key of one erasure job's row."""
    return {'pk': job_partition(scope), 'sk': job_id}


def _lock_key(scope: WorkspaceScope) -> dict[str, str]:
    return {'pk': erasure_job_pk(scope), 'sk': WORKSPACE_LOCK_SK}


def acquire_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Take the workspace's erasure lock for ``job_id``; ``WorkspaceErasureRunning`` when another job holds it."""
    put_free_lock(ws_table(scope, table).put_item, {**_lock_key(scope), 'job_id': job_id, 'locked_at': now.isoformat()},
                  now, WorkspaceErasureRunning(scope.ws))


def refresh_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Renew ``locked_at`` while ``job_id`` still holds the lock (the worker, at each hand-over)."""
    stamp_own_lock(_lock_update(table, scope), job_id, now, 'locked_at', ' AND attribute_not_exists(released_at)')


def release_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Mark the lock released, only while ``job_id`` still holds it (UpdateItem, never a delete)."""
    stamp_own_lock(_lock_update(table, scope), job_id, now, 'released_at')


def _lock_update(table: Any, scope: WorkspaceScope) -> LockWrite:
    """The workspace lock row's UpdateItem, through the workspace layer."""
    return lambda **request: ws_table(scope, table).update_item(_lock_key(scope), **request)
