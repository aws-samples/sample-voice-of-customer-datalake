"""An erasure reaches a workspace's exports (TENETS.md D5; docs/source-policies.md, "Workspace items";
docs/multi-workspace.md, "Export and delete").

A workspace's export (``ws/{ws}/exports/{export id}/…``, the zip and its work objects) is a derived copy of its
feedback and members. So once an erasure deleted any item of a workspace (by email, author, source id or CSV row;
the deployment's erasure by email or the workspace's own) or de-identified one of its membership rows (an erasure
by email: the export's ``members/`` holds the email), it closes that workspace's exports as soon as it first meets
the workspace, before it deletes the item or changes the row (``note_workspace``: step 1 below; a job that names
one workspace does it at its start), and its ``exports`` phase, after the item scan and the memberships, for each
such workspace:

1. takes the workspace's export lock for itself (shared/export_jobs.py ``hold_for_erasure``), so a start during the
   sweep answers 409, then marks every export of the workspace that may still have objects (queued, running or
   completed) ``erased`` (``mark_erased``): no download link is signed for it any more, and a running job can no
   longer record its progress or itself completed (it then aborts its upload and deletes the work objects it wrote:
   lambda/jobs/workspace_export/handler.py);
2. aborts every multipart upload still open under its exports (a running export's zip: its completion then fails);
   one gone since it was listed (the export aborted it, or completed it) is done, and step 3, which lists after
   the aborts, deletes a zip completed in that window;
3. deletes every version of every object under ``ws/{ws}/exports/`` (shared/retention.py ``delete_raw_prefix_page``,
   page by page), counted in ``deleted_export_objects``;
4. sweeps once more (steps 2 and 3): an export invocation that was mid-write when step 1 ran may have put a work
   object or a part since;
5. frees the export lock (only while the erasure still holds it): the workspace may export again. A run that fails
   before this leaves the lock to go stale (an hour).

A workspace leaves ``erased_workspaces`` (the one list the run carries) only once all of it is done, so a hand-over
mid-way resumes it from step 1 (every step is idempotent; only objects actually deleted are counted). The window
that remains (an export invocation writing after the last sweep, until it reads its row erased at its next
hand-over or right before it completes the zip, at most one invocation of 15 minutes; it then never completes) is
named in TENETS.md D5's gaps. A daily retention window does not
run this phase (it would clear a workspace's exports every day); the window's deleted items stay in an export until
it expires (10 days), a gap docs/source-policies.md names.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Final

from shared import retention
from shared.export_jobs import ERASURE_HOLDER_PREFIX, hold_for_erasure, mark_erased, release_after_erasure
from shared.retention import EXPORT_OBJECT_COUNTER
from shared.tables import get_workspaces_table
from shared.ws_repo import (
    WORKSPACE_FIELD,
    ExportObjects,
    WorkspaceScope,
    WorkspaceStatusCache,
    exports_prefix,
    scope_from_message,
    workspace_is_active,
    ws_table,
)

#: The run's carried list: the workspaces whose exports it still has to clear.
ERASED_WORKSPACES: Final = 'erased_workspaces'
#: Steps 2 and 3, then once more (the module docstring's step 4).
_SWEEPS: Final = 2


def _holder(run: dict[str, Any]) -> str:
    """The id the erasure holds a workspace's export lock under (one per run, the same across hand-overs)."""
    return f"{ERASURE_HOLDER_PREFIX}{run['run_id']}"


def _workspace_active(scope: WorkspaceScope) -> bool:
    """Whether the workspace's ``META`` reads ``active`` now (a fresh read, no cache); True where the deployment has
    no voc-workspaces configured (no workspace can be deleted there)."""
    table = get_workspaces_table()
    return True if table is None else workspace_is_active(table, scope, WorkspaceStatusCache())


def _close(run: dict[str, Any], scope: WorkspaceScope, aggregates: Any) -> None:
    """Take the workspace's export lock for the erasure, then mark its exports ``erased`` (step 1). A workspace
    delete holding the lock keeps it (``hold_for_erasure``: its sweeps rely on it to the end), and a workspace that is
    not active (deleting, or deleted) gets no lock row created: one made after the delete removed the lock would
    outlive the workspace. The exports are marked all the same (nothing is created for a row that is gone), so a
    delete cancelled later leaves none to download."""
    jobs = ws_table(scope, aggregates)
    hold_for_erasure(jobs, _holder(run), datetime.now(UTC), workspace_active=_workspace_active(scope))
    mark_erased(jobs, datetime.now(UTC))


def note_workspace(run: dict[str, Any], scope: WorkspaceScope, aggregates: Any) -> None:
    """Remember a workspace this run is about to erase an item or a membership of (the ``exports`` phase clears it),
    and the first time, close its exports at once (step 1: the lock, then every export marked ``erased``): from
    then on no link is signed for a zip that holds what the erasure deletes, and no export starts, while the item
    scan and the other phases run. The callers note a workspace before they delete its item or change its row."""
    erased = run.setdefault(ERASED_WORKSPACES, [])
    if scope.ws not in erased:
        _close(run, scope, aggregates)
        erased.append(scope.ws)


def renew(run: dict[str, Any], aggregates: Any) -> None:
    """Close every pending workspace's exports again (the lock renewed, any export that slipped in marked
    ``erased``): the handler does it at each hand-over, so a lock taken by ``note_workspace`` never goes stale while
    the run is still on its way to the ``exports`` phase (an invocation lasts 15 minutes, the lock an hour)."""
    for ws in pending(run):
        _close(run, scope_from_message({WORKSPACE_FIELD: ws}), aggregates)


def pending(run: dict[str, Any]) -> list[str]:
    """The workspaces whose exports this run still has to clear."""
    return list(run.get(ERASED_WORKSPACES) or [])


def clear(run: dict[str, Any], s3: Any, bucket: str, aggregates: Any, time_left: Callable[[], bool]) -> bool:
    """Clear the exports of every pending workspace (see the module docstring); False when the time ran low first
    (the phase resumes the workspace it was in: each step is idempotent)."""
    for ws in pending(run):
        scope = scope_from_message({WORKSPACE_FIELD: ws})
        # Again (the lock may have gone stale over a long item scan, and an export may have started since).
        _close(run, scope, aggregates)
        objects = ExportObjects(scope, s3, bucket)
        for _sweep in range(_SWEEPS):
            for key, upload_id in objects.open_uploads():
                objects.abort_multipart_upload(key, upload_id)
            more = True
            while more:
                if not time_left():
                    return False
                deleted, more = retention.delete_raw_prefix_page(s3, bucket, exports_prefix(scope))
                run[EXPORT_OBJECT_COUNTER] = int(run.get(EXPORT_OBJECT_COUNTER) or 0) + deleted
        release_after_erasure(ws_table(scope, aggregates), _holder(run), datetime.now(UTC))
        run[ERASED_WORKSPACES].remove(ws)
    return True
