"""Which workspaces enabled a plugin: the list the scheduled tick fans out over (docs/multi-workspace.md, "Scheduled
ingestion").

One partition per plugin in ``voc-workspaces``, one row per workspace that enabled it::

    PLUGIN#{plugin_id} / WS#{ws}

so a plugin's tick reads its workspaces with one paged Query of a single partition, never a Scan. This module is
the one reader; the per-workspace plugin settings write the rows (a later change: until then nothing writes them,
and every tick fans out to no workspace). A row whose sort key does not name a well-formed workspace id is
skipped, so a stray row can never become a run under a guessed workspace.
"""
from __future__ import annotations

from typing import Any, Final

from shared.dynamo_paging import iter_query
from shared.plugin_identity import is_valid_plugin_identifier
from shared.workspace_ids import is_workspace_id

__all__ = ['plugin_partition', 'workspaces_with_plugin']

PLUGIN_PARTITION_PREFIX: Final = 'PLUGIN#'
WORKSPACE_SORT_PREFIX: Final = 'WS#'


def plugin_partition(plugin_id: str) -> str:
    """``PLUGIN#{plugin_id}``: the partition of the workspaces that enabled ``plugin_id``. ValueError for an id that
    is not a plugin id (shared/plugin_identity.py), so the read never names another partition."""
    if not is_valid_plugin_identifier(plugin_id):
        raise ValueError('not a plugin id')
    return f'{PLUGIN_PARTITION_PREFIX}{plugin_id}'


def workspaces_with_plugin(table: Any, plugin_id: str) -> list[str]:
    """The ids of the workspaces that enabled ``plugin_id``, in sort-key order, each once and well formed.

    A paged, strongly consistent Query of ``PLUGIN#{plugin_id}`` for the ``WS#`` sort keys (only the sort key is
    read back). Every DynamoDB error propagates: a tick that cannot read its list starts no workspace's run (the
    caller logs and meters it; the next tick reads again).
    """
    request = {
        'KeyConditionExpression': '#pk = :pk AND begins_with(#sk, :ws)',
        'ExpressionAttributeNames': {'#pk': 'pk', '#sk': 'sk'},
        'ExpressionAttributeValues': {':pk': plugin_partition(plugin_id), ':ws': WORKSPACE_SORT_PREFIX},
        'ProjectionExpression': '#sk',
        'ConsistentRead': True,
    }
    found: dict[str, None] = {}
    for row in iter_query(table, request):
        sort_key = row.get('sk')
        ws = sort_key.removeprefix(WORKSPACE_SORT_PREFIX) if isinstance(sort_key, str) else ''
        if is_workspace_id(ws):
            found[ws] = None
    return list(found)
