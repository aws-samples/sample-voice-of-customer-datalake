"""Participant lists, memberships and project links in voc-participants.

A membership is two rows: ``LIST#{list}`` / ``MEMBER#{person}`` (the list's side)
and its mirror ``PERSON#{person}`` / ``LIST#{list}`` (the person's side), and the
list META's ``member_count`` moves with the first one (conditional, so a repeat add
or remove never counts twice). The person META's ``list_ids`` set moves with it too,
so a page of up to 500 people shows their lists from the one read that fetched them
(no Query per person). A project link is ``PROJECT#{project}`` /
``LIST#{list}`` or ``PERSON#{person}``; the linked list / person keeps the project in
its ``project_ids`` set, so deleting a list or erasing a person can find its links.

Every store takes a keyword-only ``workspace`` (plumbing since 7.31.00, docs/multi-workspace.md, the project plan,
3d; no route passes one yet): without one each request is the one sent before; in one every key is the workspace's
(shared/participants_keys.py: a project link in ``WS#{ws}#PROJECT#{project}``, so a project's links are its
workspace's), every call goes through the workspace layer (shared/participants_tables.py), a new list is listed first
in the workspace's index (``WS#{ws}#PARTICIPANTS``), where it stays after the list is deleted (the hard delete
sweeps it).
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.engagement_common import (
    conditional_write,
    new_id,
    now_iso,
    optional_text,
    public_fields,
    required_text,
    update_existing,
)
from shared.exceptions import NotFoundError, ValidationError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.ingest_tables import scoped_calls
from shared.participants_keys import (
    LIST_PARTITION_PREFIX,
    list_key,
    list_members,
    list_partition,
    lists_index_pk,
    member_key,
    membership_key,
    participants_index_key,
    person_key,
    person_partition,
    project_link_key,
)
from shared.participants_store import PERSON_NOT_FOUND
from shared.participants_tables import (
    cancellation_codes,
    delete_many,
    rows_by_id_in,
    scoped_rows,
    transact,
)
from shared.project_keys import project_pk
from shared.ws_repo import WorkspaceScope

LIST_PREFIX: Final = 'lst'
LIST_KINDS: Final = frozenset({'employees', 'paid', 'beta', 'sales', 'customers', 'requesters', 'custom'})
MAX_LIST_NAME: Final = 120
MAX_LIST_DESCRIPTION: Final = 1000
MAX_LISTS: Final = 1000
MAX_MEMBERS_LISTED: Final = 2000
MAX_PROJECT_LINKS: Final = 1000
#: How many times ``add_member`` sends its transaction when a concurrent write cancels it.
ADD_ATTEMPTS: Final = 3
LIST_NOT_FOUND: Final = 'List not found'
_HIDDEN: Final = frozenset({'project_ids'})


def list_view(item: Mapping[str, Any]) -> dict[str, Any]:
    view = public_fields(item, _HIDDEN)
    view['member_count'] = max(int(view.get('member_count') or 0), 0)
    return view


def list_fields(body: Mapping[str, Any], *, partial: bool) -> dict[str, Any]:
    """name / description / kind from ``body`` (all three on create, any of them on update)."""
    fields: dict[str, Any] = {}
    if not partial or 'name' in body:
        fields['name'] = required_text(body, 'name', MAX_LIST_NAME)
        fields['gsi1sk'] = fields['name'].lower()
    if not partial or 'description' in body:
        fields['description'] = optional_text(body, 'description', MAX_LIST_DESCRIPTION) or ''
    if not partial or 'kind' in body:
        kind = body.get('kind', 'custom')
        if kind not in LIST_KINDS:
            raise ValidationError(f'kind must be one of: {", ".join(sorted(LIST_KINDS))}')
        fields['kind'] = kind
    return fields


def create_list(table: Any, fields: Mapping[str, Any], created_by: str, *, workspace: WorkspaceScope | None = None,
                **extra: Any) -> dict[str, Any]:
    list_id = new_id(LIST_PREFIX)
    now = now_iso()
    item = {**list_key(list_id, workspace=workspace), 'list_id': list_id, 'member_count': 0,
            'created_by': created_by, 'created_at': now, 'updated_at': now,
            'gsi1pk': lists_index_pk(workspace=workspace), **fields, **extra}
    view = scoped_calls(table, workspace)
    if workspace is not None:
        # Listed first: a list the index does not name is never written.
        view.put_item(Item=participants_index_key(list_partition(list_id, workspace=workspace), workspace=workspace))
    view.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
    return item


def get_list(table: Any, list_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, Any] | None:
    item = scoped_calls(table, workspace).get_item(Key=list_key(list_id, workspace=workspace)).get('Item')
    return item if isinstance(item, dict) else None


def require_list(table: Any, list_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    item = get_list(table, list_id, workspace=workspace)
    if item is None:
        raise NotFoundError(LIST_NOT_FOUND)
    return item


def get_lists(table: Any, list_ids: Iterable[str], *,
              workspace: WorkspaceScope | None = None) -> dict[str, dict[str, Any]]:
    return rows_by_id_in(table, workspace, [list_key(list_id, workspace=workspace) for list_id in dict.fromkeys(list_ids)],
                         'list_id', 'lists')


def all_lists(table: Any, *, workspace: WorkspaceScope | None = None) -> list[dict[str, Any]]:
    """Every list, by name."""
    return list(scoped_rows(table, workspace, lists_index_pk(workspace=workspace), attribute='gsi1pk',
                            limit=MAX_LISTS, index=PARTICIPANTS_LISTING_INDEX, placeholders=(':p', ':s')))


def update_list(table: Any, list_id: str, fields: Mapping[str, Any], *,
                workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    return update_existing(scoped_calls(table, workspace), list_key(list_id, workspace=workspace), fields, LIST_NOT_FOUND)


def _rows(table: Any, pk: str, prefix: str, limit: int | None, workspace: WorkspaceScope | None) -> list[dict[str, Any]]:
    return list(scoped_rows(table, workspace, pk, sort_prefix=prefix, limit=limit))


def member_ids(table: Any, list_id: str, limit: int | None = MAX_MEMBERS_LISTED, *,
               workspace: WorkspaceScope | None = None) -> list[str]:
    """The list's member ids (at most ``limit``; None = every one, for deletion)."""
    partition, prefix = list_members(list_id, workspace=workspace)
    found = _rows(table, partition, prefix, limit, workspace)
    return [str(row['person_id']) for row in found if row.get('person_id')]


def list_ids_of_person(table: Any, person_id: str, *, workspace: WorkspaceScope | None = None) -> list[str]:
    found = _rows(table, person_partition(person_id, workspace=workspace), LIST_PARTITION_PREFIX, MAX_LISTS, workspace)
    return [str(row['list_id']) for row in found if row.get('list_id')]


def _count(table: Any, list_id: str, delta: int, workspace: WorkspaceScope | None) -> None:
    """Move ``member_count`` (a list deleted meanwhile has nothing to count)."""
    conditional_write(scoped_calls(table, workspace).update_item, Key=list_key(list_id, workspace=workspace),
                      UpdateExpression='ADD member_count :d', ConditionExpression='attribute_exists(pk)',
                      ExpressionAttributeValues={':d': delta})


def _track_membership(table: Any, person_id: str, list_id: str, *, member: bool,
                      workspace: WorkspaceScope | None) -> None:
    """Keep the person META's ``list_ids`` set in step (a person erased meanwhile is fine)."""
    conditional_write(scoped_calls(table, workspace).update_item, Key=person_key(person_id, workspace=workspace),
                      UpdateExpression=f'{"ADD" if member else "DELETE"} list_ids :l',
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':l': {list_id}})


def add_member(table: Any, list_id: str, person_id: str, added_by: str, *,
               workspace: WorkspaceScope | None = None) -> bool:
    """True when the person joined now, False when they already were a member; NotFoundError when the person is gone.

    The member row and its mirror are written in ONE transaction that also checks the person's ``META`` is there,
    so an add racing the person's erasure fails instead of leaving the erased id in the list (since 7.31.00)."""
    now = now_iso()
    entries = [
        {'Put': {'Item': {**member_key(list_id, person_id, workspace=workspace), 'person_id': person_id,
                          'added_at': now, 'added_by': added_by},
                 'ConditionExpression': 'attribute_not_exists(pk)'}},
        {'Put': {'Item': {**membership_key(person_id, list_id, workspace=workspace), 'list_id': list_id,
                          'added_at': now}}},
        {'ConditionCheck': {'Key': person_key(person_id, workspace=workspace),
                            'ConditionExpression': 'attribute_exists(pk)'}},
    ]
    for attempt in range(ADD_ATTEMPTS):
        try:
            transact(table, workspace, entries)
            break
        except ClientError as error:
            codes = cancellation_codes(error)
            if len(codes) > 2 and codes[2] == 'ConditionalCheckFailed':
                raise NotFoundError(PERSON_NOT_FOUND) from error
            if codes[:1] == ['ConditionalCheckFailed']:
                return False
            # A cancel for a concurrent write (TransactionConflict) is tried again, a bounded number of times.
            if 'TransactionConflict' not in codes or attempt == ADD_ATTEMPTS - 1:
                raise
    _count(table, list_id, 1, workspace)
    _track_membership(table, person_id, list_id, member=True, workspace=workspace)
    return True


def remove_member(table: Any, list_id: str, person_id: str, *, workspace: WorkspaceScope | None = None) -> bool:
    """True when the person was a member (both rows gone, the count down by one)."""
    view = scoped_calls(table, workspace)
    old = view.delete_item(Key=member_key(list_id, person_id, workspace=workspace),
                           ReturnValues='ALL_OLD').get('Attributes')
    view.delete_item(Key=membership_key(person_id, list_id, workspace=workspace))
    _track_membership(table, person_id, list_id, member=False, workspace=workspace)
    if not old:
        return False
    _count(table, list_id, -1, workspace)
    return True


def delete_list(table: Any, list_id: str, *, workspace: WorkspaceScope | None = None) -> None:
    """The list, every membership (both sides) and every project link. People stay. In a workspace its row in the
    workspace's index (an opaque id) stays: a membership a concurrent add writes into the deleted list's partition is
    still found by the hard delete."""
    item = require_list(table, list_id, workspace=workspace)
    members = member_ids(table, list_id, limit=None, workspace=workspace)
    projects = [str(project_id) for project_id in item.get('project_ids') or ()]
    if workspace is None:
        with table.batch_writer() as batch:
            for person_id in members:
                batch.delete_item(Key=membership_key(person_id, list_id))
                batch.delete_item(Key=member_key(list_id, person_id))
            for project_id in projects:
                batch.delete_item(Key=project_link_key(project_id, 'LIST', list_id))
    else:
        delete_many(table, workspace, [
            *(key for person_id in members for key in (membership_key(person_id, list_id, workspace=workspace),
                                                       member_key(list_id, person_id, workspace=workspace))),
            *(project_link_key(project_id, 'LIST', list_id, workspace=workspace) for project_id in projects)])
    for person_id in members:
        _track_membership(table, person_id, list_id, member=False, workspace=workspace)
    scoped_calls(table, workspace).delete_item(Key=list_key(list_id, workspace=workspace))


# ── Project links ─────────────────────────────────────────────────────────────

def _track(table: Any, kind: str, target_id: str, project_id: str, *, linked: bool,
           workspace: WorkspaceScope | None) -> None:
    """Keep the linked list's / person's ``project_ids`` in step (a row already gone is fine)."""
    key = list_key(target_id, workspace=workspace) if kind == 'LIST' else person_key(target_id, workspace=workspace)
    conditional_write(scoped_calls(table, workspace).update_item, Key=key,
                      UpdateExpression=f'{"ADD" if linked else "DELETE"} project_ids :p',
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':p': {project_id}})


def link(table: Any, project_id: str, kind: str, target_id: str, added_by: str, *,
         workspace: WorkspaceScope | None = None) -> None:
    """Link a list (``kind`` 'LIST') or a person ('PERSON') to a project (idempotent)."""
    scoped_calls(table, workspace).put_item(Item={**project_link_key(project_id, kind, target_id, workspace=workspace),
                                           'target_id': target_id, 'added_at': now_iso(), 'added_by': added_by})
    _track(table, kind, target_id, project_id, linked=True, workspace=workspace)


def unlink(table: Any, project_id: str, kind: str, target_id: str, *, workspace: WorkspaceScope | None = None) -> None:
    scoped_calls(table, workspace).delete_item(Key=project_link_key(project_id, kind, target_id, workspace=workspace))
    _track(table, kind, target_id, project_id, linked=False, workspace=workspace)


def project_links(table: Any, project_id: str, *,
                  workspace: WorkspaceScope | None = None) -> tuple[list[str], list[str]]:
    """``(list_ids, person_ids)`` linked to the project."""
    lists: list[str] = []
    people: list[str] = []
    for row in scoped_rows(table, workspace, project_pk(project_id, workspace=workspace), limit=MAX_PROJECT_LINKS):
        kind, _, target = str(row.get('sk', '')).partition('#')
        (lists if kind == 'LIST' else people).append(target)
    return lists, people
