"""A workspace's rename: ``PUT /me/workspaces/current`` ``{name}`` (docs/multi-workspace.md, "Control plane"; 7.40.00).

For the workspace's admins (a member admin, or a platform admin who entered: live-checked and audited), the role
resolved from the table, never the warm cache. The slug, and so every ``/workspace/{slug}`` address, stays the same.

The name lives on three kinds of row in voc-workspaces:

    WS#{ws}      / META              name: the workspace's own row
    WORKSPACES   / {name}#{ws}       name, and in its SORT KEY (case-folded): the platform console's listing
    USER#{sub}   / WS#{ws}           name: each member's "my workspaces" row

1. The audit row first (kind ``workspace_renamed``: actor, at, platform_admin). It records no name: an audit row can
   never be changed or removed (the audit-row guard), and a name may name a person (TENETS.md D5), as the creation's
   row records the slug only.
2. ONE transaction: META's ``name`` updated while it is still the name the request read (409 otherwise: renamed
   meanwhile); the listing row moved to its new sort key (the old one deleted while the workspace is still ``active``,
   the new one put whole), or put over itself when only the case changed (the same key), stamped ``renamed_at`` (the
   audit row's time, 7.43.00: a retention walk of the listing that began before it reads the row again,
   jobs/retention/workspaces.py); and, for a member admin, a
   check that they are still admin (403 when they were demoted meanwhile). A delete that marked the workspace
   ``deleting`` first fails the listing row's condition (409); the rename never revives it.
3. Then every member's ``USER#`` row, one conditional UpdateItem each (a paged, strongly consistent Query of the
   ``MEMBER#`` rows): a member removed meanwhile is skipped. A failure here leaves some members' menus showing the old
   name; the same rename again (the name unchanged) writes no audit row and no transaction and repeats only this step,
   so it is the repair. A member added in the moment between the META commit and this step's Query of their row
   gets the new name from META (shared/workspace_members.py ``add_member`` copies the resolved name), or this step.
"""
from __future__ import annotations

import secrets
from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.audit_rows import put_new_audit_row
from shared.dynamo_paging import iter_query
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError
from shared.logging import logger
from shared.persona_save import CONDITION_FAILED, cancellation_codes
from shared.platform_workspaces import LISTING_PK, RENAMED_AT, listing_sort_key, validated_workspace_name
from shared.request_body import reject_unknown_fields
from shared.timestamps import now_iso
from shared.workspace import ACTIVE, NOT_FOUND, WorkspaceContext, audit_key, audit_sort_key, ws_key
from shared.workspace_members import MEMBER_PREFIX as _MEMBER
from shared.workspace_members import NO_LONGER_ADMIN

WORKSPACE_RENAMED: Final = 'workspace_renamed'
RENAME_CHANGED_MEANWHILE: Final = 'The workspace changed meanwhile: reload and try again'


def parse_rename(body: Mapping[str, Any]) -> str:
    """``{name}`` validated (the create's rules: shared/platform_workspaces.py), or a 400 that says what to fix."""
    reject_unknown_fields(body, ('name',))
    return validated_workspace_name(body.get('name'))


def _listing_row(table: Any, context: WorkspaceContext) -> dict[str, Any]:
    """The workspace's listing row, read strongly consistent; the workspace's one 404 when it is missing (a workspace
    whose listing row is gone is being swept)."""
    key = {'pk': LISTING_PK, 'sk': listing_sort_key(context.name, context.ws)}
    row = table.get_item(Key=key, ConsistentRead=True).get('Item')
    if not isinstance(row, dict) or row.get('workspace_id') != context.ws:
        raise NotFoundError(NOT_FOUND)
    return row


def _listing_moves(table_name: str, row: Mapping[str, Any], context: WorkspaceContext, name: str,
                   at: str) -> list[dict]:
    """The listing row's move to the new name's sort key: a delete of the old key (while ``active``) and a put of the
    new one, or one put over the same key when only the case changed (a transaction names an item once); the new row
    stamped ``renamed_at`` ``at`` (the audit row's time)."""
    still_active = {'ConditionExpression': '#status = :active AND workspace_id = :ws',
                    'ExpressionAttributeNames': {'#status': 'status'},
                    'ExpressionAttributeValues': {':active': ACTIVE, ':ws': context.ws}}
    moved = {**row, 'sk': listing_sort_key(name, context.ws), 'name': name, RENAMED_AT: at}
    if moved['sk'] == row['sk']:
        return [{'Put': {'TableName': table_name, 'Item': moved, **still_active}}]
    return [
        {'Delete': {'TableName': table_name, 'Key': {'pk': LISTING_PK, 'sk': row['sk']}, **still_active}},
        {'Put': {'TableName': table_name, 'Item': moved, 'ConditionExpression': 'attribute_not_exists(pk)'}},
    ]


def _rename_items(table_name: str, row: Mapping[str, Any], context: WorkspaceContext, name: str,
                  actor: str, at: str) -> tuple[list[dict], int | None]:
    """The transaction (META first, then the listing row's move, then the acting admin's check if any) and the check's
    index."""
    items: list[dict] = [{'Update': {
        'TableName': table_name, 'Key': {'pk': ws_key(context.ws), 'sk': 'META'},
        'UpdateExpression': 'SET #name = :name', 'ConditionExpression': '#name = :before',
        'ExpressionAttributeNames': {'#name': 'name'},
        'ExpressionAttributeValues': {':name': name, ':before': context.name},
    }}, *_listing_moves(table_name, row, context, name, at)]
    if context.platform_admin:
        # A platform admin acts by the group (live-checked when they entered), not by a MEMBER# row.
        return items, None
    items.append({'ConditionCheck': {
        'TableName': table_name, 'Key': {'pk': ws_key(context.ws), 'sk': f'{_MEMBER}{actor}'},
        'ConditionExpression': '#role = :admin', 'ExpressionAttributeNames': {'#role': 'role'},
        'ExpressionAttributeValues': {':admin': 'admin'},
    }})
    return items, len(items) - 1


def _commit(table: Any, context: WorkspaceContext, name: str, actor: str) -> None:
    row = _listing_row(table, context)
    at = now_iso()
    put_new_audit_row(table, {'pk': audit_key(context.ws), 'sk': audit_sort_key(at), 'kind': WORKSPACE_RENAMED,
                              'actor': actor, 'at': at, 'platform_admin': context.platform_admin})
    items, actor_index = _rename_items(table.name, row, context, name, actor, at)
    try:
        # A token per request: botocore's own retry of a transaction whose answer was lost succeeds instead of
        # failing its own conditions (DynamoDB keeps it idempotent for 10 minutes).
        table.meta.client.transact_write_items(TransactItems=items, ClientRequestToken=secrets.token_hex(16))
    except ClientError as exc:
        codes = cancellation_codes(exc)
        if actor_index is not None and codes[actor_index:actor_index + 1] == [CONDITION_FAILED]:
            raise AuthorizationError(NO_LONGER_ADMIN) from exc
        if CONDITION_FAILED in codes or 'TransactionConflict' in codes:
            raise ConflictError(RENAME_CHANGED_MEANWHILE) from exc
        raise


def sync_member_names(table: Any, ws: str, name: str) -> int:
    """Every member's ``USER#{sub}`` / ``WS#{ws}`` row set to ``name`` (a member removed meanwhile is skipped); the
    number of rows updated."""
    members = iter_query(table, {
        'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :member)',
        'ProjectionExpression': 'sk',
        'ExpressionAttributeValues': {':pk': ws_key(ws), ':member': _MEMBER},
        'ConsistentRead': True,
    })
    updated = 0
    for member in members:
        sk = member.get('sk')
        if not isinstance(sk, str) or not sk.startswith(_MEMBER):
            continue
        try:
            table.update_item(Key={'pk': f'USER#{sk.removeprefix(_MEMBER)}', 'sk': f'WS#{ws}'},
                              UpdateExpression='SET #name = :name', ConditionExpression='attribute_exists(pk)',
                              ExpressionAttributeNames={'#name': 'name'}, ExpressionAttributeValues={':name': name})
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
            continue
        updated += 1
    return updated


def rename_workspace(table: Any, context: WorkspaceContext, name: str, actor: str) -> dict[str, Any]:
    """Rename the workspace ``context`` names to ``name`` (see the module docstring) and answer it as
    ``GET /me/workspaces/current`` does. The same name changes nothing but repeats the members' sync (the repair)."""
    if name != context.name:
        _commit(table, context, name, actor)
        logger.info('Workspace renamed', extra={'workspace_id': context.ws})
    updated = sync_member_names(table, context.ws, name)
    logger.info('Workspace members\' names synced', extra={'workspace_id': context.ws, 'count': updated})
    return {'id': context.ws, 'name': name, 'slug': context.slug, 'role': context.role,
            'platform_admin': context.platform_admin}
