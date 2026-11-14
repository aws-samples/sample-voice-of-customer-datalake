"""Replace-mode persona generation: removing the project's current personas before the new set is saved.

The old clear read ONE query page (so a project with more personas than fit in
1 MB kept the rest) and deleted through a batch writer, so the first failed batch
stopped every later delete. Here every page is read, each persona is deleted on
its own, a failure is logged and the walk carries on, and the caller learns
exactly which rows went (only those take their avatar objects with them).

A persona marked ``protected`` (``PUT /projects/{id}/personas/{pid}/protection``,
ported from #429 by @aws-bryan) is kept by a replace run. Protection is read from
the rows at clear time, and each delete is conditional on the row still being
unprotected: a generation takes minutes, and a persona protected meanwhile survives.
Absent means unprotected, so every persona written before the flag keeps the old
behaviour.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.exceptions import NotFoundError
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.project_keys import project_pk
from shared.project_tables import iter_project_rows
from shared.ws_repo import OutOfScopeError, WorkspaceScope

#: The persona attribute; only a literal ``True`` protects.
PROTECTED_FIELD: Final = 'protected'

_UNPROTECTED_CONDITION: Final = 'attribute_not_exists(#protected) OR #protected <> :true'


def is_protected(row: dict) -> bool:
    return row.get(PROTECTED_FIELD) is True


@dataclass
class ClearedPersonas:
    """What a replace-mode clear did: the sort keys it removed, kept protected, or failed to remove.

    ``names`` maps a removed sort key to the persona's name (when it had one), so the
    documents written from it can say which persona was replaced.
    """

    deleted: list[str] = field(default_factory=list)
    names: dict[str, str] = field(default_factory=dict)
    protected: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def _persona_rows(table: Any, project_id: str, *, workspace: WorkspaceScope | None) -> list[dict]:
    return list(iter_project_rows(table, project_id, workspace=workspace, sort_prefix='PERSONA#',
                                  ProjectionExpression='pk, sk, #protected, #name',
                                  ExpressionAttributeNames={'#protected': PROTECTED_FIELD, '#name': 'name'}))


def _delete_unprotected(table: Any, project_id: str, sort_key: str, *, workspace: WorkspaceScope | None) -> None:
    table_view(workspace, table).delete_item(
        {'pk': project_pk(project_id, workspace=workspace), 'sk': sort_key},
        ConditionExpression=_UNPROTECTED_CONDITION,
        ExpressionAttributeNames={'#protected': PROTECTED_FIELD},
        ExpressionAttributeValues={':true': True},
    )


def clear_personas(table: Any, project_id: str, *, workspace: WorkspaceScope | None = None) -> ClearedPersonas:
    """Delete every unprotected persona row of the project, one by one; a failed delete never stops the rest. A key
    the workspace layer refuses (``OutOfScopeError``) is a programming error: raised, never counted as failed."""
    result = ClearedPersonas()
    for row in _persona_rows(table, project_id, workspace=workspace):
        sort_key = row.get('sk')
        if not isinstance(sort_key, str):
            continue
        if is_protected(row):
            result.protected.append(sort_key)
            continue
        try:
            _delete_unprotected(table, project_id, sort_key, workspace=workspace)
        except OutOfScopeError:
            raise
        except Exception as error:
            if is_conditional_check_failure(error):
                result.protected.append(sort_key)  # protected after the read: kept, by design
                continue
            logger.exception(
                '[PERSONA] Could not delete a persona before regeneration (keeping it)',
                extra={'project_id': project_id, 'sk': sort_key},
            )
            result.failed.append(sort_key)
        else:
            result.deleted.append(sort_key)
            if isinstance(name := row.get('name'), str) and name:
                result.names[sort_key] = name
    return result


def set_protection(table: Any, project_id: str, persona_id: str, protected: bool, now: str, *,
                   workspace: WorkspaceScope | None = None) -> None:
    """Mark a persona protected (or not); ``NotFoundError`` when the project has no such persona."""
    try:
        table_view(workspace, table).update_item(
            {'pk': project_pk(project_id, workspace=workspace), 'sk': f'PERSONA#{persona_id}'},
            UpdateExpression='SET #protected = :protected, updated_at = :now',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeNames={'#protected': PROTECTED_FIELD},
            ExpressionAttributeValues={':protected': protected, ':now': now},
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            raise NotFoundError('Persona not found') from error
        raise
