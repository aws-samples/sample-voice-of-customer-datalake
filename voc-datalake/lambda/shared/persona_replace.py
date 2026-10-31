"""Replace-mode persona generation: removing the project's current personas before the new set is saved.

The old clear read ONE query page (so a project with more personas than fit in
1 MB kept the rest) and deleted through a batch writer, so the first failed batch
stopped every later delete. Here every page is read, each persona is deleted on
its own, a failure is logged and the walk carries on, and the caller learns
exactly which rows went (only those take their avatar objects with them).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from boto3.dynamodb.conditions import Key

from shared.dynamo_paging import iter_query
from shared.logging import logger


@dataclass
class ClearedPersonas:
    """What a replace-mode clear did: the sort keys it removed, and the ones still there."""

    deleted: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


def _persona_rows(table: Any, project_id: str) -> list[dict]:
    return list(iter_query(table, {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('PERSONA#'),
        'ProjectionExpression': 'pk, sk',
    }))


def clear_personas(table: Any, project_id: str) -> ClearedPersonas:
    """Delete every persona row of the project, one by one; a failed delete never stops the rest."""
    result = ClearedPersonas()
    for row in _persona_rows(table, project_id):
        sort_key = row.get('sk')
        if not isinstance(sort_key, str):
            continue
        try:
            table.delete_item(Key={'pk': f'PROJECT#{project_id}', 'sk': sort_key})
        except Exception:
            logger.exception(
                '[PERSONA] Could not delete a persona before regeneration (keeping it)',
                extra={'project_id': project_id, 'sk': sort_key},
            )
            result.failed.append(sort_key)
        else:
            result.deleted.append(sort_key)
    return result
