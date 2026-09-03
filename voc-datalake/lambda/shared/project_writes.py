"""Atomic project-partition writes guarded by the retained META tombstone."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

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
PROJECT_WRITABLE_ATTRIBUTE_NAMES = {
    '#deleting': PROJECT_DELETION_ATTRIBUTE,
    '#status': 'status',
}
PROJECT_WRITABLE_ATTRIBUTE_VALUES = {
    ':deleting_status': PROJECT_DELETING_STATUS,
    ':deleted_status': PROJECT_DELETED_STATUS,
}


def project_meta_key(project_id: str) -> dict[str, str]:
    return {'pk': f'PROJECT#{project_id}', 'sk': 'META'}


def is_project_tombstone(item: dict[str, Any] | None) -> bool:
    return bool(item) and (
        PROJECT_DELETION_ATTRIBUTE in item
        or item.get('status') in PROJECT_TERMINAL_STATUSES
    )


def projects_table_name(table) -> str:
    table_name = getattr(table, 'name', None)
    if not isinstance(table_name, str) or not table_name:
        table_name = os.environ.get('PROJECTS_TABLE', '')
    if not table_name:
        raise ValueError('Projects table name is required')
    return table_name


def project_writable_condition(
    table_name: str, project_id: str,
) -> dict[str, Any]:
    """DynamoDB condition check shared by every project child mutation."""
    return {
        'ConditionCheck': {
            'TableName': table_name,
            'Key': project_meta_key(project_id),
            'ConditionExpression': PROJECT_WRITABLE_CONDITION,
            'ExpressionAttributeNames': dict(
                PROJECT_WRITABLE_ATTRIBUTE_NAMES,
            ),
            'ExpressionAttributeValues': dict(
                PROJECT_WRITABLE_ATTRIBUTE_VALUES,
            ),
        },
    }


def transact_project_actions(
    table,
    project_id: str,
    actions: list[dict[str, Any]],
) -> None:
    """Commit child-only actions iff the project META row is writable."""
    table.meta.client.transact_write_items(TransactItems=[
        project_writable_condition(projects_table_name(table), project_id),
        *actions,
    ])


def put_project_item(
    table,
    project_id: str,
    item: dict[str, Any],
) -> None:
    """Create one project child without allowing overwrite or resurrection."""
    transact_project_actions(table, project_id, [{
        'Put': {
            'TableName': projects_table_name(table),
            'Item': item,
            'ConditionExpression': (
                'attribute_not_exists(pk) AND attribute_not_exists(sk)'
            ),
        },
    }])


def put_project_item_and_increment(
    table,
    project_id: str,
    item: dict[str, Any],
    count_attribute: str,
) -> None:
    """Atomically create one child and increment its project META count."""
    table_name = projects_table_name(table)
    now = str(item.get('created_at') or datetime.now(timezone.utc).isoformat())
    table.meta.client.transact_write_items(TransactItems=[
        {
            'Put': {
                'TableName': table_name,
                'Item': item,
                'ConditionExpression': (
                    'attribute_not_exists(pk) AND attribute_not_exists(sk)'
                ),
            },
        },
        {
            'Update': {
                'TableName': table_name,
                'Key': project_meta_key(project_id),
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
    ])
