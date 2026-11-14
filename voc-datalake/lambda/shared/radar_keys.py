"""The keys of Radar's settings rows in ``voc-radar``: the deployment's, or one workspace's (decision 13).

Radar is each workspace's (docs/multi-workspace.md, "Per-workspace configuration"): its scan settings and brand list
live in the workspace's own partition, ``WS#{ws}#SETTINGS#radar`` (``config``, ``brands``), read through
shared/workspace_config.py ``get_scoped_item`` (so a key outside the workspace never reaches DynamoDB). Without a
workspace (``scope`` None: a request that names none, the deployment-wide data path) the deployment's
``SETTINGS#radar``, as before; its ``version`` row (shared/data_version.py) stays the deployment's until the cached
reads' version counters move.

No reader passes a workspace yet, and the Radar routes still edit the deployment's rows: the processor's routing,
the scan job and the routes move together at the phase-2 cut-over (shared/workspace_config.py says why: a
workspace's save must land on rows its readers apply).
"""
from __future__ import annotations

from typing import Final

from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

__all__ = ['radar_settings_key']

_SETTINGS_PARTITION: Final = 'SETTINGS#radar'
#: The rows a workspace has of its own (the version counter stays the deployment's for now).
_WORKSPACE_SORT_KEYS: Final = frozenset({'config', 'brands'})


def radar_settings_key(sort_key: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """``SETTINGS#radar`` / ``sort_key``, or the workspace's: ``config`` and ``brands`` have one in each workspace,
    ``version`` (shared/data_version.py) only the deployment's, until the version counters move (ValueError for a
    workspace's)."""
    if scope is not None and sort_key not in _WORKSPACE_SORT_KEYS:
        raise ValueError(f'a workspace has no Radar {sort_key!r} row')
    # A workspace's partition is built where every workspace settings key is (shared/workspace_settings.py).
    pk = _SETTINGS_PARTITION if scope is None else settings_key(scope.ws, 'radar')['pk']
    return {'pk': pk, 'sk': sort_key}
