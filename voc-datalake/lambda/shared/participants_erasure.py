"""Erase one person from voc-participants (``DELETE /participants/people/{id}``, admin).

Deleted: the person (META), its email guard, every membership on both sides (each
list's ``member_count`` down by one), its project links, every token minted for it,
and the person's ask mirrors. Each recipient row it had keeps ONLY ``person_id`` and
its delivery status (the response token hash and any error code are removed), so an
ask's counts stay true while nothing on it can identify the person any more.
Feedback a person already submitted is customer data in voc-feedback: erase it with
Administration → Privacy & access → Source policies (``POST /settings/erasure``), docs/source-policies.md.

An erasure states its legal basis (``shared/legal_basis.py``) and is recorded before
anything is deleted (TENETS.md D4, D5), in voc-participants, with no email and no name:

- a tombstone ``AUDIT#tombstone#participant`` / ``{sha256 of the person id}``:
  the legal basis, the ``actor`` and ``deleted_at`` (no ``ttl``; the same field names as the
  delete record);
- the ``AUDIT#delete`` row every workspace delete writes (``shared/delete_audit.py``),
  naming the opaque person id (as the ask's recipient rows still do), under the deterministic
  ``participant#{sha256 of the person id}`` (``record_delete_once``, since 7.31.00).

Both are put only if absent, on every attempt, and both come before any delete (a workspace path reads the person's
rows first, to refuse asks or tokens before anything is written); the guard is deleted first and the
person's ``META`` last, so an erasure stopped anywhere is simply run again and ends with one tombstone and one record.

In a workspace (plumbing since 7.31.00, docs/multi-workspace.md, the project plan, 3d; no route passes one yet) the
person's rows are the workspace's (shared/participants_keys.py), deleted through the workspace layer; its guard's row
in the workspace's index goes last, only while no guard of that address is back, and its own index row (an opaque id)
stays for the hard delete. Its tombstone is the workspace's (shared/ws_repo.py ``workspace_tombstone_key``:
``AUDIT#tombstone#participant`` / ``{ws}#{sha256 of the person id}``, so it never meets the deployment's, put only if
new) and its delete record names the workspace beside the person id (ids only). The asks and the tokens are not per
workspace yet (none is written in one): a workspace person holding either is refused before anything is recorded or
deleted (``PARTICIPANT_ASKS_STORE``).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.delete_audit import record_delete_once
from shared.digests import sha256_hex
from shared.engagement_common import conditional_write
from shared.ingest_tables import scoped_calls
from shared.logging import logger
from shared.participants_asks import RESPONSE_SK, UNSUBSCRIBE_SK, hashed_token_key, recipient_key
from shared.participants_keys import (
    LIST_PARTITION_PREFIX,
    META_SORT_KEY,
    PARTICIPANT_ASKS_STORE,
    email_guard_key,
    participants_index_key,
    person_key,
    person_partition,
    project_link_key,
)
from shared.participants_lists import remove_member
from shared.participants_store import require_person
from shared.participants_tables import delete_many, scoped_rows, unlist_if_empty
from shared.project_keys import NotPerWorkspaceError
from shared.timestamps import now_iso
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, workspace_tombstone_key, ws_table

TOMBSTONE_PK: Final = 'AUDIT#tombstone#participant'
#: The tombstone's kind (``AUDIT#tombstone#{kind}``): the deployment's partition is ``TOMBSTONE_PK``.
_TOMBSTONE_KIND: Final = 'participant'
_ASK_MIRROR_PREFIX: Final = 'ASK#'


def _ids(rows_read: list[dict[str, Any]], prefix: str, field: str) -> list[str]:
    return [str(row[field]) for row in rows_read if str(row.get('sk', '')).startswith(prefix) and row.get(field)]


def _strip_recipient(table: Any, ask_id: str, person_id: str) -> None:
    """Keep the recipient row's person_id and status only (a row already gone is fine)."""
    conditional_write(table.update_item, Key=recipient_key(ask_id, person_id),
                      UpdateExpression='REMOVE response_token_hash, #e', ConditionExpression='attribute_exists(pk)',
                      ExpressionAttributeNames={'#e': 'error'})


def _guard(person: Mapping[str, Any], workspace: WorkspaceScope | None) -> dict[str, str] | None:
    email_lc = person.get('email_lc')
    return email_guard_key(email_lc, workspace=workspace) if isinstance(email_lc, str) and email_lc else None


def _delete_guard(calls: Any, guard: Mapping[str, str], person_id: str) -> None:
    """The address guard, only while it still names ``person_id``: on a retry the address may already guard a new
    person (re-added after the first try deleted this one's), whose guard is kept (a failed condition is "gone")."""
    conditional_write(calls.delete_item, Key=dict(guard), ConditionExpression='person_id = :id',
                      ExpressionAttributeValues={':id': person_id})


def _rest(rows_read: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The person partition's rows but its ``META`` (deleted last, on its own) and its list mirrors (remove_member
    took them)."""
    return [{'pk': row['pk'], 'sk': row['sk']} for row in rows_read
            if row.get('sk') != META_SORT_KEY and not str(row.get('sk', '')).startswith(LIST_PARTITION_PREFIX)]


def _delete_rows(table: Any, person: Mapping[str, Any], rows_read: list[dict[str, Any]]) -> tuple[int, int]:
    """The guard first, then the tokens, the project links and the person's own partition (list mirrors and
    ``META`` excepted), then ``META`` last: a retry after a failure anywhere still finds the person, and an address
    is never left guarding an erased id."""
    person_id = str(person['person_id'])
    token_hashes = [str(h) for h in person.get('token_hashes') or ()]
    projects = [str(p) for p in person.get('project_ids') or ()]
    if (guard := _guard(person, None)) is not None:
        _delete_guard(table, guard, person_id)
    with table.batch_writer() as batch:
        for token_hash in token_hashes:
            for kind in (RESPONSE_SK, UNSUBSCRIBE_SK):
                batch.delete_item(Key=hashed_token_key(token_hash, kind))
        for project_id in projects:
            batch.delete_item(Key=project_link_key(project_id, 'PERSON', person_id))
        for key in _rest(rows_read):
            batch.delete_item(Key=key)
    table.delete_item(Key=person_key(person_id))
    return len(token_hashes), len(projects)


def _delete_workspace_rows(table: Any, person: Mapping[str, Any], rows_read: list[dict[str, Any]],
                           workspace: WorkspaceScope) -> int:
    """Through the layer, in ``_delete_rows``' order: the guard and its row in the workspace's index (it holds the
    address's hash; unlisted only while no guard is back), then the project links and the person's own partition
    (list mirrors and ``META`` excepted), then ``META`` last. The person's own index row (an opaque id) stays: a late
    write into the partition (a concurrent membership's mirror) is still found by the hard delete."""
    person_id = str(person['person_id'])
    projects = [str(p) for p in person.get('project_ids') or ()]
    view = scoped_calls(table, workspace)
    if (guard := _guard(person, workspace)) is not None:
        _delete_guard(view, guard, person_id)
        unlist_if_empty(table, workspace, participants_index_key(guard['pk'], workspace=workspace), guard)
    delete_many(table, workspace, [
        *(project_link_key(project_id, 'PERSON', person_id, workspace=workspace) for project_id in projects),
        *_rest(rows_read)])
    view.delete_item(Key=person_key(person_id, workspace=workspace))
    return len(projects)


def _record(table: Any, person_id: str, legal_basis: str, actor: Mapping[str, str],
            workspace: WorkspaceScope | None) -> None:
    """The tombstone and the delete record, both written before the person's rows go, each independently put only
    if absent and both on EVERY attempt: a retry of an erasure stopped anywhere (between the two writes too, or after
    a failed record) keeps the first tombstone as it was and ends with exactly one record (D4, D5). The record's key
    is deterministic (``participant#{sha256 of the id}``, ``#{ws}#…`` in a workspace) and a failure to write it
    raises, so the erasure is never done without it."""
    person_hash = sha256_hex(person_id)
    fields = {'legal_basis': legal_basis, 'actor': dict(actor), 'deleted_at': now_iso()}
    target = {'person_id': person_id}
    if workspace is None:
        conditional_write(table.put_item, Item={'pk': TOMBSTONE_PK, 'sk': person_hash, **fields},
                          ConditionExpression='attribute_not_exists(pk)')
        record_id = person_hash
    else:
        ws_table(workspace, table).put_new_tombstone(
            {**workspace_tombstone_key(workspace, _TOMBSTONE_KIND, person_hash), **fields})
        target[WORKSPACE_FIELD] = workspace.ws
        record_id = f'{workspace.ws}#{person_hash}'
    # The record names the opaque id like every other participant delete (the ask's recipient rows keep it too); the
    # tombstone is keyed by its hash. Neither holds the email or the name.
    record_delete_once(table, kind='participant', record_id=record_id, target=target, actor=actor,
                       reason=legal_basis)


def _person_rows(table: Any, person_id: str, workspace: WorkspaceScope | None) -> list[dict[str, Any]]:
    return list(scoped_rows(table, workspace, person_partition(person_id, workspace=workspace)))


def _late_memberships(table: Any, person_id: str, workspace: WorkspaceScope | None) -> int:
    """Once ``META`` is gone no add can commit any more (its transaction checks ``META``), so the memberships an add
    committed between the first read and that delete are found now, from the mirrors it wrote, and removed."""
    late = _ids(_person_rows(table, person_id, workspace), LIST_PARTITION_PREFIX, 'list_id')
    for list_id in late:
        remove_member(table, list_id, person_id, workspace=workspace)
    return len(late)


def _erase_deployment(table: Any, person_id: str, legal_basis: str, actor: Mapping[str, str]) -> dict[str, int]:
    person = require_person(table, person_id)
    _record(table, person_id, legal_basis, actor, None)
    rows_read = _person_rows(table, person_id, None)
    lists = _ids(rows_read, LIST_PARTITION_PREFIX, 'list_id')
    asks = _ids(rows_read, _ASK_MIRROR_PREFIX, 'ask_id')
    for list_id in lists:
        remove_member(table, list_id, person_id)
    for ask_id in asks:
        _strip_recipient(table, ask_id, person_id)
    tokens, projects = _delete_rows(table, person, rows_read)
    late = _late_memberships(table, person_id, None)
    return {'lists': len(lists) + late, 'asks': len(asks), 'tokens': tokens, 'projects': projects}


def _erase_workspace(table: Any, person_id: str, legal_basis: str, actor: Mapping[str, str],
                     workspace: WorkspaceScope) -> dict[str, int]:
    person = require_person(table, person_id, workspace=workspace)
    rows_read = _person_rows(table, person_id, workspace)
    lists = _ids(rows_read, LIST_PARTITION_PREFIX, 'list_id')
    # Read first in a workspace: a person with asks or tokens is refused before anything is written.
    if _ids(rows_read, _ASK_MIRROR_PREFIX, 'ask_id') or person.get('token_hashes'):
        raise NotPerWorkspaceError(f'{PARTICIPANT_ASKS_STORE} is not per workspace yet')
    _record(table, person_id, legal_basis, actor, workspace)
    for list_id in lists:
        remove_member(table, list_id, person_id, workspace=workspace)
    projects = _delete_workspace_rows(table, person, rows_read, workspace)
    late = _late_memberships(table, person_id, workspace)
    return {'lists': len(lists) + late, 'asks': 0, 'tokens': 0, 'projects': projects}


def erase_person(table: Any, person_id: str, *, legal_basis: str, actor: Mapping[str, str],
                 workspace: WorkspaceScope | None = None) -> dict[str, int]:
    """Erase ``person_id`` under ``legal_basis``; NotFoundError when absent. Returns what was removed (counts only)."""
    if workspace is None:
        removed = _erase_deployment(table, person_id, legal_basis, actor)
    else:
        removed = _erase_workspace(table, person_id, legal_basis, actor, workspace)
    logger.info('Participant erased', extra={'person_id': person_id, **removed})
    return removed
