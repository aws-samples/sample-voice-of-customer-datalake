"""Where an erasure job's row lives, on either path, and a workspace's one live job at a time (TENETS.md D5;
docs/source-policies.md, "Workspace items").

* The deployment's jobs: ``pk JOB#erasure`` / ``sk er_<12 hex>`` in voc-aggregates, exactly as before.
* A workspace's jobs: their own partition, ``WS#{ws}#JOB#erasure`` (shared/ws_repo.py ``erasure_job_pk``), read and
  written through the workspace layer (``ws_table``), so a workspace's volume never pushes the deployment's jobs or
  another workspace's out of a list: each list is one bounded Query of its own partition. The settings API writes
  the row and names the workspace on the worker's invoke event (``workspace_payload``); voc-retention reads the row
  by that key (``job_key``) and checks that the row names the same workspace.
* One live job per workspace and kind: its lock row ``{partition}`` / ``LOCK``, put with a condition (no row, a
  released one, or one taken more than ``STALE_AFTER`` ago), the same rule as a source's lock
  (shared/source_erasure.py): the second start answers 409. The worker renews it at each hand-over and releases it
  (UpdateItem ``released_at``, never a delete) when the job ends; a release names its job, so a job whose stale lock
  was taken over never frees its successor's. A lock row's ``sk`` does not start ``er_`` (nor ``ex_``), so no list
  shows it.

The lock helpers (``acquire_lock``, ``refresh_lock``, ``release_lock``, ``release_quietly``) take the job
partition and, for a start, the exception a held lock raises: a workspace's erasure (``WS#{ws}#JOB#erasure``,
``WorkspaceErasureRunning``) and its export (``WS#{ws}#JOB#export``, shared/export_jobs.py ``ExportRunning``) share
them.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger
from shared.retention import ERASURE_JOB_PK
from shared.source_erasure import LockWrite, put_free_lock, stamp_own_lock
from shared.ws_repo import WorkspaceScope, WorkspaceTable, erasure_job_pk, ws_table

__all__ = [
    'WorkspaceErasureRunning',
    'acquire_lock',
    'acquire_workspace_lock',
    'job_key',
    'job_partition',
    'lock_holder',
    'refresh_lock',
    'refresh_workspace_lock',
    'release_lock',
    'release_quietly',
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


def _lock_key(partition: str) -> dict[str, str]:
    return {'pk': partition, 'sk': WORKSPACE_LOCK_SK}


def acquire_lock(view: WorkspaceTable, partition: str, job_id: str, now: datetime, held: Exception) -> None:
    """Take the lock of the workspace's job ``partition`` for ``job_id``; raises ``held`` when another job holds it."""
    put_free_lock(view.put_item, {**_lock_key(partition), 'job_id': job_id, 'locked_at': now.isoformat()}, now, held)


def refresh_lock(view: WorkspaceTable, partition: str, job_id: str, now: datetime) -> None:
    """Renew ``locked_at`` while ``job_id`` still holds the lock (the worker, at each hand-over)."""
    stamp_own_lock(_lock_update(view, partition), job_id, now, 'locked_at', ' AND attribute_not_exists(released_at)')


def release_lock(view: WorkspaceTable, partition: str, job_id: str, now: datetime) -> None:
    """Mark the lock released, only while ``job_id`` still holds it (UpdateItem, never a delete)."""
    stamp_own_lock(_lock_update(view, partition), job_id, now, 'released_at')


def lock_holder(view: WorkspaceTable, partition: str) -> str | None:
    """The job id holding the lock of the workspace's job ``partition`` (its ``job_id``, released or not), or None:
    one strongly consistent Query of the lock row (a route may Query a job partition, not GetItem it)."""
    found = view.query('pk', partition, sort_condition='#sk = :lock', ExpressionAttributeNames={'#sk': 'sk'},
                       ExpressionAttributeValues={':lock': WORKSPACE_LOCK_SK}, ConsistentRead=True).get('Items') or []
    holder = found[0].get('job_id') if found and isinstance(found[0], Mapping) else None
    return holder if isinstance(holder, str) else None


def release_quietly(release: Callable[[], None], what: str) -> None:
    """Free a lock on an error path, best effort: a failed release is logged (its type only), so the caller's own
    error is the one reported; an unreleased lock goes stale after ``STALE_AFTER`` anyway."""
    try:
        release()
    except (ClientError, BotoCoreError) as exc:
        logger.warning(f'Could not release the {what} lock', extra={'error_type': type(exc).__name__})


def _lock_update(view: WorkspaceTable, partition: str) -> LockWrite:
    """The lock row's UpdateItem, through the workspace layer."""
    return lambda **request: view.update_item(_lock_key(partition), **request)


def acquire_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Take the workspace's erasure lock for ``job_id``; ``WorkspaceErasureRunning`` when another job holds it."""
    acquire_lock(ws_table(scope, table), erasure_job_pk(scope), job_id, now, WorkspaceErasureRunning(scope.ws))


def refresh_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Renew the workspace's erasure lock while ``job_id`` still holds it (the worker, at each hand-over)."""
    refresh_lock(ws_table(scope, table), erasure_job_pk(scope), job_id, now)


def release_workspace_lock(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Mark the workspace's erasure lock released, only while ``job_id`` still holds it."""
    release_lock(ws_table(scope, table), erasure_job_pk(scope), job_id, now)
