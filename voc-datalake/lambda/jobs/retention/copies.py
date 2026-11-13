"""voc-retention: the tombstone and the copies of each matched item (shared/retention.py says what).

For every item a run deletes, a tombstone is written FIRST, in one batch per
scanned page (``AUDIT#tombstone#{source}`` / ``{feedback_id}`` in
voc-aggregates, no content and no ``ttl``: TENETS.md D4, D5; a workspace's item
``{ws}#{feedback_id}`` with its ``workspace_id``, ``tombstone_key``). A crash or a
hand-over can therefore leave a tombstone whose item is still there (the next
generation deletes it, and re-writes the same key), never a delete without a
tombstone.

Then the item goes with its own raw archive (``retention.delete_item`` /
``retention.delete_radar_item``). The whole-file upload an item came from is
deleted only by a whole-source erasure; any other run lists it for review. An S3 import's
original file is linked from no row, so a run that deletes an S3 import's item lists the
originals folder of the item's scope for review instead (``shared/retention.py``).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final

from jobs.retention import exports
from jobs.retention.runs import MODE_ERASE, note_erased_source, note_review_file
from shared import retention
from shared.legal_basis import legal_basis_or_legacy
from shared.retention import FEEDBACK_SK_PREFIX, SOURCE_FIELD, STORE_FEEDBACK, STORE_RADAR, WORKSPACE_ITEM_COUNTER
from shared.timestamps import now_iso
from shared.ws_repo import WorkspaceScope

TOMBSTONE_PK_PREFIX: Final = 'AUDIT#tombstone#'
_UNKNOWN_SOURCE: Final = 'unknown'


def item_source(item: Mapping[str, Any]) -> str:
    """The source an item was ingested from (its ``source_platform``)."""
    source = item.get('source_platform')
    return source if isinstance(source, str) and source else _UNKNOWN_SOURCE


def _feedback_id(item: Mapping[str, Any]) -> str:
    feedback_id = item.get('feedback_id')
    if isinstance(feedback_id, str) and feedback_id:
        return feedback_id
    return str(item['sk']).removeprefix(FEEDBACK_SK_PREFIX)


def tombstone_key(source: str, feedback_id: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """The key of one deleted item's tombstone in voc-aggregates.

    A workspace's item keeps the same partition (``AUDIT#tombstone#{source}``, so the audit-row guard, which pins
    ``AUDIT#*``, protects it like every other tombstone; a ``WS#{ws}#AUDIT#…`` partition would be outside it) and
    names its workspace in the sort key, ``{ws}#{feedback_id}``: two workspaces' copies of one source item, and the
    deployment's, share a ``feedback_id`` but never a tombstone.
    """
    return {'pk': f'{TOMBSTONE_PK_PREFIX}{source}', 'sk': feedback_id if scope is None else f'{scope.ws}#{feedback_id}'}


def legal_basis_for(run: Mapping[str, Any], source: str) -> str:
    """The legal basis a run deletes ``source``'s items under: the job's, or the source profile's."""
    if run['mode'] == MODE_ERASE:
        return legal_basis_or_legacy(run.get('legal_basis'))
    bases = run.get('legal_bases')
    return legal_basis_or_legacy(bases.get(source) if isinstance(bases, Mapping) else None)


def tombstone_record(run: Mapping[str, Any], source: str, item_id: str, store: str, now: str,
                     scope: WorkspaceScope | None = None) -> dict[str, Any]:
    """The fields every tombstone carries: its key, the run, the legal basis, the time, a workspace item's
    ``workspace_id``; never content."""
    return {
        **tombstone_key(source, item_id, scope), 'source': source, 'store': store,
        'mode': run['mode'], 'run_id': run['run_id'], 'legal_basis': legal_basis_for(run, source),
        'deleted_at': now, **({'job_id': run['job_id']} if run.get('job_id') else {}),
        **({'workspace_id': scope.ws} if scope is not None else {}),
    }


def _tombstone(run: Mapping[str, Any], item: Mapping[str, Any], store: str, now: str) -> dict[str, Any]:
    feedback_id = _feedback_id(item)
    scope = retention.item_scope(item)
    return {**tombstone_record(run, item_source(item), feedback_id, store, now, scope), 'feedback_id': feedback_id}


def write_tombstones(aggregates_table: Any, run: Mapping[str, Any], items: Sequence[Mapping[str, Any]],
                     store: str) -> None:
    """One tombstone per item, one PutItem each (a retried run re-writes the same keys).

    Not a batch: ``dynamodb:BatchWriteItem`` would also let this role DELETE audit rows (IAM cannot tell a batch
    put from a batch delete), so voc-retention holds PutItem only on voc-aggregates and the audit-row guard
    (lib/utils/audit-row-guard.ts) denies it every change or delete of an ``AUDIT#`` row.
    """
    if not items:
        return
    now = now_iso()
    for item in items:
        aggregates_table.put_item(Item=_tombstone(run, item, store, now))


class ItemDeleter:
    """Deletes one matched item of a store and every copy this run may reach, counting into ``run``."""

    def __init__(self, run: dict[str, Any], s3: Any, bucket: str, tables: Mapping[str, Any]) -> None:
        self._run = run
        self._s3 = s3
        self._bucket = bucket
        self._tables = tables
        # Whole-file uploads already deleted in this invocation (a repeat would only list nothing).
        self._uploads_done: set[str] = set()
        # S3 import originals folders already looked at in this invocation (listed once each).
        self._originals_seen: set[str] = set()

    def delete(self, item: Mapping[str, Any], store: str) -> None:
        """The item's whole-file upload (see the module docstring), then the item with its own archive."""
        run = self._run
        scope = None if store == STORE_RADAR else retention.item_scope(item)
        if scope is not None and run.get('mode') == MODE_ERASE:
            # Its exports hold a copy of the item: closed before any of it goes, cleared by the `exports` phase.
            exports.note_workspace(run, scope, self._tables['aggregates'])
        self._whole_upload(item)
        self._import_originals(item)
        if store == STORE_RADAR:
            _, objects = retention.delete_radar_item(self._tables[STORE_RADAR], self._s3, self._bucket, item)
            run['deleted_radar_items'] += 1
        else:
            _, objects = retention.delete_item(self._tables[STORE_FEEDBACK], self._s3, self._bucket, item)
            run['deleted_items'] += 1
            if scope is not None:
                run[WORKSPACE_ITEM_COUNTER] = int(run.get(WORKSPACE_ITEM_COUNTER) or 0) + 1
        run['deleted_objects'] += objects
        # A workspace item's source too: the lineage pass looks up `{feedback_id}` tombstone keys, which a
        # workspace tombstone (`{ws}#{feedback_id}`) never is.
        note_erased_source(run, item_source(item))

    def _import_originals(self, item: Mapping[str, Any]) -> None:
        """List the S3 import originals folder of the item's scope for review (no row says which file it came
        from, shared/retention.py), when the folder holds any file."""
        prefix = retention.import_originals_prefix(item)
        if prefix is None or prefix in self._originals_seen or not self._bucket:
            return
        self._originals_seen.add(prefix)
        if retention.holds_files(self._s3, self._bucket, prefix):
            note_review_file(self._run, prefix)

    def _whole_upload(self, item: Mapping[str, Any]) -> None:
        key = retention.whole_upload_key(item, self._bucket)
        if key is None:
            return
        whole_source = self._run.get('field') == SOURCE_FIELD and item_source(item) == self._run.get('source')
        if not whole_source:
            note_review_file(self._run, key)
        elif key not in self._uploads_done:
            self._run['deleted_objects'] += retention.delete_whole_upload(self._s3, self._bucket, key)
            self._uploads_done.add(key)
