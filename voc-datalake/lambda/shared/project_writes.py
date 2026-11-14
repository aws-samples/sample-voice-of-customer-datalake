"""Atomic project-partition writes guarded by the retained META tombstone.

Every writer takes an optional workspace (plumbing since 7.21.00: no route passes one yet, docs/multi-workspace.md):
None writes the deployment's ``PROJECT#{id}`` rows exactly as before, through the table's own client; a workspace
writes its ``WS#{ws}#PROJECT#{id}`` rows through shared/ws_repo.py ``ws_table`` (``transact_project_writes``), which
refuses an entry outside the workspace before the transaction is sent.

A project made in a workspace (``create_workspace_project``, since 7.26.00; no route passes a workspace yet) writes
its id's deployment-wide claim (shared/ws_repo.py ``claim_project_id``), its ``META`` and its row in the workspace's
registry in one scoped transaction.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime
from typing import Any

from shared.ids import write_with_fresh_id
from shared.project_keys import project_pk, project_registry_key
from shared.timestamps import now_iso
from shared.ws_repo import OutOfScopeError, ProjectClaim, WorkspaceScope, claim_project_id, ws_table

#: A create's own condition: the new row's key is free.
NEW_ROW_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
PROJECT_DELETION_ATTRIBUTE = 'deletion_started_at'
PROJECT_DELETING_STATUS = 'deleting'
PROJECT_DELETED_STATUS = 'deleted'
PROJECT_TERMINAL_STATUSES = frozenset({
    PROJECT_DELETING_STATUS,
    PROJECT_DELETED_STATUS,
})
PROJECT_WRITABLE_CONDITION = (
    'attribute_exists(pk) AND attribute_exists(sk) '
    'AND attribute_not_exists(#deleting) '
    'AND (attribute_not_exists(#status) OR '
    '(#status <> :deleting_status AND #status <> :deleted_status))'
)
# Written by lambda/api/verification_fixture_provider.py on every fixture record.
# Keep the two in lockstep: renaming it there without renaming it here makes
# fixture projects visible in the ordinary project list.
VERIFICATION_FIXTURE_ATTRIBUTE = 'verification_fixture_id'
PROJECT_WRITABLE_ATTRIBUTE_NAMES = {
    '#deleting': PROJECT_DELETION_ATTRIBUTE,
    '#status': 'status',
}
PROJECT_WRITABLE_ATTRIBUTE_VALUES = {
    ':deleting_status': PROJECT_DELETING_STATUS,
    ':deleted_status': PROJECT_DELETED_STATUS,
}


#: Where `put_project_item_and_increment`'s Put sits in its transaction, for
#: `shared.ids.write_with_fresh_id(put_index=...)`: a collision is only the
#: cancellation reason AT the Put, never the project-writable update.
PUT_AND_INCREMENT_PUT_INDEX = 0


def project_meta_key(project_id: str, *, workspace: WorkspaceScope | None = None) -> dict[str, str]:
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': 'META'}


def is_project_tombstone(item: dict[str, Any] | None) -> bool:
    return bool(item) and (
        PROJECT_DELETION_ATTRIBUTE in item
        or item.get('status') in PROJECT_TERMINAL_STATUSES
    )


def is_verification_fixture(item: dict[str, Any] | None) -> bool:
    """Rows seeded by the ABCA verification fixture provider.

    Those rows are indexed like ordinary projects — they have to be, because the
    point of the fixture is to exercise the real read paths — so nothing but this
    marker distinguishes them. Anything enumerating projects or prioritization
    rows for a human must skip them, or a verification run shows up as somebody's
    project.

    Keyed on PRESENCE of the attribute, not on its value. That is safe only while
    no ordinary write path can set it: every project write here is
    attribute-restricted (see PROJECT_WRITABLE_ATTRIBUTE_NAMES), and the fixture
    provider is the sole writer. If a future route ever accepts arbitrary
    attributes, this predicate becomes a way to hide a project from its owner —
    switch it to matching a known fixture id at that point.
    """
    return bool(item) and VERIFICATION_FIXTURE_ATTRIBUTE in item


def projects_table_name(table) -> str:
    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        table_name = os.environ.get('PROJECTS_TABLE', '')
    if not table_name:
        raise ValueError('Projects table name is required')
    return table_name


def project_writable_condition(
    table_name: str, project_id: str, *, workspace: WorkspaceScope | None = None,
) -> dict[str, Any]:
    """DynamoDB condition check shared by every project child mutation."""
    return {
        'ConditionCheck': {
            'TableName': table_name,
            'Key': project_meta_key(project_id, workspace=workspace),
            'ConditionExpression': PROJECT_WRITABLE_CONDITION,
            'ExpressionAttributeNames': dict(
                PROJECT_WRITABLE_ATTRIBUTE_NAMES,
            ),
            'ExpressionAttributeValues': dict(
                PROJECT_WRITABLE_ATTRIBUTE_VALUES,
            ),
        },
    }


def transact_project_writes(
    table,
    entries: list[dict[str, Any]],
    *,
    workspace: WorkspaceScope | None = None,
    claim: ProjectClaim | None = None,
) -> None:
    """One TransactWriteItems of ``entries`` (boto3's client shape, each naming ``table`` in ``TableName``).

    Without a workspace: exactly ``table.meta.client.transact_write_items(TransactItems=entries)``. In one: through
    ``ws_table``, every entry checked to name this table (``OutOfScopeError`` otherwise: the layer sends to its own)
    and to stay inside the workspace, before anything is sent. ``claim`` (a workspace's only): the project id's
    claim the layer built (shared/ws_repo.py ``claim_project_id``), put first in the same transaction.
    """
    if workspace is None:
        if claim is not None:
            raise OutOfScopeError('a project claim names a workspace, never the deployment')
        table.meta.client.transact_write_items(TransactItems=entries)
        return
    table_name = projects_table_name(table)
    scoped_entries = []
    for entry in entries:
        [(action, body)] = entry.items()
        if body.get('TableName') != table_name:
            raise OutOfScopeError('a workspace transaction writes its own table only')
        scoped_entries.append({action: {field: value for field, value in body.items() if field != 'TableName'}})
    ws_table(workspace, table).transact_write_items(scoped_entries, claim=claim)


def create_workspace_project(table, item: dict[str, Any], *, workspace: WorkspaceScope) -> None:
    """Write a new project's ``META`` (``item``, keyed ``WS#{ws}#PROJECT#{id}`` / ``META``) in ``workspace``.

    One scoped transaction, all or nothing: the id's deployment-wide claim (``claim_project_id``, first, at
    ``PROJECT_CLAIM_INDEX``, put only if no claim of the id exists), the ``META`` and the project's registry row
    (``project_registry_key``), each put only if absent. A claim already held cancels it with
    ConditionalCheckFailed at the claim's index, which shared/ids.py ``write_with_fresh_id(put_index=
    PROJECT_CLAIM_INDEX)`` takes for a collision (a fresh id, once); any other cancellation is raised as it came.
    Nothing is written in either case, so no claim is ever left without its project.
    """
    project_id = item.get('project_id')
    if not isinstance(project_id, str) or {'pk': item.get('pk'), 'sk': item.get('sk')} != project_meta_key(
            project_id, workspace=workspace):
        raise OutOfScopeError("a workspace project's META is keyed in that workspace")
    claim = claim_project_id(project_id, workspace=workspace, claimed_at=str(item['created_at']))
    table_name = projects_table_name(table)
    registry_row = {**project_registry_key(project_id, workspace=workspace), 'created_at': item['created_at']}
    transact_project_writes(table, [
        {'Put': {'TableName': table_name, 'Item': item, 'ConditionExpression': NEW_ROW_CONDITION}},
        {'Put': {'TableName': table_name, 'Item': registry_row, 'ConditionExpression': NEW_ROW_CONDITION}},
    ], workspace=workspace, claim=claim)


def transact_project_actions(
    table,
    project_id: str,
    actions: list[dict[str, Any]],
    *,
    workspace: WorkspaceScope | None = None,
) -> None:
    """Commit child-only actions iff the project META row is writable."""
    transact_project_writes(table, [
        project_writable_condition(projects_table_name(table), project_id, workspace=workspace),
        *actions,
    ], workspace=workspace)


def put_project_item(
    table,
    project_id: str,
    item: dict[str, Any],
    *,
    workspace: WorkspaceScope | None = None,
) -> None:
    """Create one project child without allowing overwrite or resurrection."""
    transact_project_actions(table, project_id, [{
        'Put': {
            'TableName': projects_table_name(table),
            'Item': item,
            'ConditionExpression': NEW_ROW_CONDITION,
        },
    }], workspace=workspace)


def put_project_item_and_increment(
    table,
    project_id: str,
    item: dict[str, Any],
    count_attribute: str,
    *,
    workspace: WorkspaceScope | None = None,
) -> None:
    """Atomically create one child and increment its project META count."""
    table_name = projects_table_name(table)
    now = str(item.get('created_at') or now_iso())
    transact_project_writes(table, [
        {
            'Put': {
                'TableName': table_name,
                'Item': item,
                'ConditionExpression': NEW_ROW_CONDITION,
            },
        },
        {
            'Update': {
                'TableName': table_name,
                'Key': project_meta_key(project_id, workspace=workspace),
                'UpdateExpression': (
                    'SET #count = if_not_exists(#count, :zero) + :one, '
                    'updated_at = :now'
                ),
                'ConditionExpression': PROJECT_WRITABLE_CONDITION,
                'ExpressionAttributeNames': {
                    **PROJECT_WRITABLE_ATTRIBUTE_NAMES,
                    '#count': count_attribute,
                },
                'ExpressionAttributeValues': {
                    **PROJECT_WRITABLE_ATTRIBUTE_VALUES,
                    ':zero': 0,
                    ':one': 1,
                    ':now': now,
                },
            },
        },
    ], workspace=workspace)


def create_counted_project_child(
    table,
    project_id: str,
    prefix: str,
    build_item: Callable[[str], dict[str, Any]],
    *,
    now: datetime | None = None,
    workspace: WorkspaceScope | None = None,
) -> dict[str, Any]:
    """Mint a ``prefix`` id, build the document from it, put it and bump the project's ``document_count``.

    A same-id row already in the partition (a same-second create) is retried
    once with a fresh id; a refused project-writable check is not. ``now`` is the
    reading the caller stamped ``created_at`` with, so the id names the same second.
    """
    def write(child_id: str) -> dict[str, Any]:
        item = build_item(child_id)
        put_project_item_and_increment(table, project_id, item, 'document_count', workspace=workspace)
        return item

    return write_with_fresh_id(prefix, write, put_index=PUT_AND_INCREMENT_PUT_INDEX, now=now)
