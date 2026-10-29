"""Participant lists, memberships and project links in voc-participants.

A membership is two rows: ``LIST#{list}`` / ``MEMBER#{person}`` (the list's side)
and its mirror ``PERSON#{person}`` / ``LIST#{list}`` (the person's side), and the
list META's ``member_count`` moves with the first one (conditional, so a repeat add
or remove never counts twice). The person META's ``list_ids`` set moves with it too,
so a page of up to 500 people shows their lists from the one read that fetched them
(no Query per person). A project link is ``PROJECT#{project}`` /
``LIST#{list}`` or ``PERSON#{person}``; the linked list / person keeps the project in
its ``project_ids`` set, so deleting a list or erasing a person can find its links.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from shared.dynamo_paging import iter_query, query_all
from shared.engagement_common import (
    conditional_write,
    new_id,
    now_iso,
    optional_text,
    public_fields,
    required_text,
    rows_by_id,
    update_existing,
)
from shared.exceptions import NotFoundError, ValidationError
from shared.indexes import PARTICIPANTS_LISTING_INDEX
from shared.participants_store import person_key

LIST_PREFIX: Final = 'lst'
LISTS_PARTITION: Final = 'LISTS'
LIST_KINDS: Final = frozenset({'employees', 'paid', 'beta', 'sales', 'customers', 'requesters', 'custom'})
MAX_LIST_NAME: Final = 120
MAX_LIST_DESCRIPTION: Final = 1000
MAX_LISTS: Final = 1000
MAX_MEMBERS_LISTED: Final = 2000
MAX_PROJECT_LINKS: Final = 1000
LIST_NOT_FOUND: Final = 'List not found'
_HIDDEN: Final = frozenset({'project_ids'})


def list_key(list_id: str) -> dict[str, str]:
    return {'pk': f'LIST#{list_id}', 'sk': 'META'}


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


def create_list(table: Any, fields: Mapping[str, Any], created_by: str, **extra: Any) -> dict[str, Any]:
    list_id = new_id(LIST_PREFIX)
    now = now_iso()
    item = {**list_key(list_id), 'list_id': list_id, 'member_count': 0, 'created_by': created_by,
            'created_at': now, 'updated_at': now, 'gsi1pk': LISTS_PARTITION, **fields, **extra}
    table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
    return item


def get_list(table: Any, list_id: str) -> dict[str, Any] | None:
    item = table.get_item(Key=list_key(list_id)).get('Item')
    return item if isinstance(item, dict) else None


def require_list(table: Any, list_id: str) -> dict[str, Any]:
    item = get_list(table, list_id)
    if item is None:
        raise NotFoundError(LIST_NOT_FOUND)
    return item


def get_lists(table: Any, list_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    return rows_by_id(table, [list_key(list_id) for list_id in dict.fromkeys(list_ids)], 'list_id', 'lists')


def all_lists(table: Any) -> list[dict[str, Any]]:
    """Every list, by name."""
    return query_all(table, {
        'IndexName': PARTICIPANTS_LISTING_INDEX, 'KeyConditionExpression': 'gsi1pk = :p',
        'ExpressionAttributeValues': {':p': LISTS_PARTITION},
    }, max_items=MAX_LISTS)


def update_list(table: Any, list_id: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    return update_existing(table, list_key(list_id), fields, LIST_NOT_FOUND)


def _rows(table: Any, pk: str, prefix: str, limit: int | None) -> list[dict[str, Any]]:
    return query_all(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :prefix)',
        'ExpressionAttributeValues': {':pk': pk, ':prefix': prefix},
    }, max_items=limit)


def member_ids(table: Any, list_id: str, limit: int | None = MAX_MEMBERS_LISTED) -> list[str]:
    """The list's member ids (at most ``limit``; None = every one, for deletion)."""
    return [str(row['person_id']) for row in _rows(table, f'LIST#{list_id}', 'MEMBER#', limit) if row.get('person_id')]


def list_ids_of_person(table: Any, person_id: str) -> list[str]:
    return [str(row['list_id']) for row in _rows(table, f'PERSON#{person_id}', 'LIST#', MAX_LISTS) if row.get('list_id')]


def _count(table: Any, list_id: str, delta: int) -> None:
    """Move ``member_count`` (a list deleted meanwhile has nothing to count)."""
    conditional_write(table.update_item, Key=list_key(list_id), UpdateExpression='ADD member_count :d',
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':d': delta})


def _track_membership(table: Any, person_id: str, list_id: str, *, member: bool) -> None:
    """Keep the person META's ``list_ids`` set in step (a person erased meanwhile is fine)."""
    conditional_write(table.update_item, Key=person_key(person_id),
                      UpdateExpression=f'{"ADD" if member else "DELETE"} list_ids :l',
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':l': {list_id}})


def add_member(table: Any, list_id: str, person_id: str, added_by: str) -> bool:
    """True when the person joined now, False when they already were a member."""
    now = now_iso()
    if not conditional_write(table.put_item, ConditionExpression='attribute_not_exists(pk)',
                             Item={'pk': f'LIST#{list_id}', 'sk': f'MEMBER#{person_id}', 'person_id': person_id,
                                   'added_at': now, 'added_by': added_by}):
        return False
    table.put_item(Item={'pk': f'PERSON#{person_id}', 'sk': f'LIST#{list_id}', 'list_id': list_id, 'added_at': now})
    _count(table, list_id, 1)
    _track_membership(table, person_id, list_id, member=True)
    return True


def remove_member(table: Any, list_id: str, person_id: str) -> bool:
    """True when the person was a member (both rows gone, the count down by one)."""
    old = table.delete_item(Key={'pk': f'LIST#{list_id}', 'sk': f'MEMBER#{person_id}'},
                            ReturnValues='ALL_OLD').get('Attributes')
    table.delete_item(Key={'pk': f'PERSON#{person_id}', 'sk': f'LIST#{list_id}'})
    _track_membership(table, person_id, list_id, member=False)
    if not old:
        return False
    _count(table, list_id, -1)
    return True


def delete_list(table: Any, list_id: str) -> None:
    """The list, every membership (both sides) and every project link. People stay."""
    item = require_list(table, list_id)
    members = member_ids(table, list_id, limit=None)
    with table.batch_writer() as batch:
        for person_id in members:
            batch.delete_item(Key={'pk': f'PERSON#{person_id}', 'sk': f'LIST#{list_id}'})
            batch.delete_item(Key={'pk': f'LIST#{list_id}', 'sk': f'MEMBER#{person_id}'})
        for project_id in item.get('project_ids') or ():
            batch.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'LIST#{list_id}'})
    for person_id in members:
        _track_membership(table, person_id, list_id, member=False)
    table.delete_item(Key=list_key(list_id))


# ── Project links ─────────────────────────────────────────────────────────────

def _track(table: Any, kind: str, target_id: str, project_id: str, *, linked: bool) -> None:
    """Keep the linked list's / person's ``project_ids`` in step (a row already gone is fine)."""
    key = list_key(target_id) if kind == 'LIST' else person_key(target_id)
    conditional_write(table.update_item, Key=key, UpdateExpression=f'{"ADD" if linked else "DELETE"} project_ids :p',
                      ConditionExpression='attribute_exists(pk)', ExpressionAttributeValues={':p': {project_id}})


def link(table: Any, project_id: str, kind: str, target_id: str, added_by: str) -> None:
    """Link a list (``kind`` 'LIST') or a person ('PERSON') to a project (idempotent)."""
    table.put_item(Item={'pk': f'PROJECT#{project_id}', 'sk': f'{kind}#{target_id}', 'target_id': target_id,
                         'added_at': now_iso(), 'added_by': added_by})
    _track(table, kind, target_id, project_id, linked=True)


def unlink(table: Any, project_id: str, kind: str, target_id: str) -> None:
    table.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': f'{kind}#{target_id}'})
    _track(table, kind, target_id, project_id, linked=False)


def project_links(table: Any, project_id: str) -> tuple[list[str], list[str]]:
    """``(list_ids, person_ids)`` linked to the project."""
    lists: list[str] = []
    people: list[str] = []
    for row in iter_query(table, {'KeyConditionExpression': 'pk = :pk',
                                  'ExpressionAttributeValues': {':pk': f'PROJECT#{project_id}'}},
                          max_items=MAX_PROJECT_LINKS):
        kind, _, target = str(row.get('sk', '')).partition('#')
        (lists if kind == 'LIST' else people).append(target)
    return lists, people
