"""The keys of Radar's settings, scan-state and owner-list rows in ``voc-radar``: the deployment's, or one
workspace's (decision 13).

Radar is each workspace's (docs/multi-workspace.md, "Per-workspace configuration"): its scan settings and brand list
live in the workspace's own partition, ``WS#{ws}#SETTINGS#radar`` (``config``, ``brands``), read through
shared/workspace_config.py ``get_scoped_item`` (so a key outside the workspace never reaches DynamoDB). Without a
workspace (``scope`` None: a request that names none, the deployment-wide data path) the deployment's
``SETTINGS#radar``, as before. Its ``version`` row (shared/data_version.py) is each workspace's too, so a write in one
workspace invalidates only its own cached Radar reads.

The scan's state rows (``RADARSCAN`` ``LOCK`` and ``LAST``, ``RADARSCAN#{brand}`` ``STATE``) are each workspace's as
well, so each workspace's scan runs, waits and resumes on its own (``scan_key``, ``brand_state_key``).

Every per-brand partition a workspace's Radar writes (a release timeline, a brand's scan state; a review's month,
marker and counters when its producer writes them) is first named in the workspace's owner list, ``WS#{ws}#RADAR_OWNED`` / ``{partition}``
(``owned_row``), so the workspace's hard delete finds them all, a brand dropped from the list since included
(lambda/jobs/workspace_delete/sweeps.py, the ``radar`` sweep).
"""
from __future__ import annotations

from typing import Final

from shared.scoped_keys import scoped_pk
from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope

__all__ = ['brand_state_key', 'owned_row', 'radar_owned_pk', 'radar_settings_key', 'scan_key']

_SETTINGS_PARTITION: Final = 'SETTINGS#radar'
#: The rows a workspace has of its own.
_WORKSPACE_SORT_KEYS: Final = frozenset({'config', 'brands', 'version'})
_SCAN_PARTITION: Final = 'RADARSCAN'
_SCAN_SORT_KEYS: Final = frozenset({'LOCK', 'LAST'})


def radar_settings_key(sort_key: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """``SETTINGS#radar`` / ``sort_key``, or the workspace's: ``config``, ``brands`` and ``version``
    (shared/data_version.py) have one in each workspace (ValueError for any other)."""
    if scope is not None and sort_key not in _WORKSPACE_SORT_KEYS:
        raise ValueError(f'a workspace has no Radar {sort_key!r} row')
    # A workspace's partition is built where every workspace settings key is (shared/workspace_settings.py).
    pk = _SETTINGS_PARTITION if scope is None else settings_key(scope.ws, 'radar')['pk']
    return {'pk': pk, 'sk': sort_key}


def scan_key(sort_key: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """``RADARSCAN`` / ``LOCK`` (the running scan's claim) or ``LAST`` (the latest scan's outcome): the deployment's,
    or the workspace's ``WS#{ws}#RADARSCAN`` (ValueError for any other row)."""
    if sort_key not in _SCAN_SORT_KEYS:
        raise ValueError(f'no Radar scan row {sort_key!r}')
    return {'pk': scoped_pk(scope, _SCAN_PARTITION), 'sk': sort_key}


def radar_owned_pk(scope: WorkspaceScope) -> str:
    """The workspace's list of the Radar partitions it wrote: ``WS#{ws}#RADAR_OWNED``."""
    return scope.key('RADAR_OWNED')


def owned_row(scope: WorkspaceScope, partition: str) -> dict[str, str]:
    """The owner list's row naming ``partition`` (one of the workspace's; ValueError for any other)."""
    if not scope.owns(partition):
        raise ValueError('a Radar partition outside the workspace')
    return {'pk': radar_owned_pk(scope), 'sk': partition}


def brand_state_key(brand_key: str, scope: WorkspaceScope | None = None) -> dict[str, str]:
    """``RADARSCAN#{brand}`` / ``STATE`` (where the brand's searches resume): the deployment's or the workspace's."""
    return {'pk': scoped_pk(scope, f'{_SCAN_PARTITION}#{brand_key}'), 'sk': 'STATE'}
