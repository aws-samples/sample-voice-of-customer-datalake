"""The category-access gate: turn a request into a ``CategoryScope``.

``shared.category_access`` is the pure policy; this module does the single
read it needs (the caller's access row, plus the categories config only when
the row restricts them, for implicit owner access). Admins are decided without
any read, so admin paths cost nothing extra.

A failed read is a 500, never "all categories": the gate must not widen access
on a transient failure.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shared import category_access
from shared.api import get_raw_categories_config
from shared.category_access import CategoryScope
from shared.exceptions import ServiceError
from shared.gate_reads import read_gate_item
from shared.project_access import Caller
from shared.project_gate import caller_from_event
from shared.source_profiles import SOURCES_KIND, SOURCES_SETTINGS_KEY
from shared.workspace_config import get_config_item
from shared.ws_repo import WorkspaceScope

CATEGORIES_PK = 'SETTINGS#categories'
CATEGORIES_SK = 'config'
#: A workspace's categories row is ``WS#{ws}#SETTINGS#categories`` (shared/workspace_config.py); the deployment's is
#: shared/categories_key.py ``CATEGORIES_SETTINGS_KEY``.
CATEGORIES_KIND = 'categories'


class _ScopedReader:
    """``get_item()`` of one configuration row of one workspace (the deployment's without one), in the shape
    shared/gate_reads.py ``read_gate_item`` calls: a strong read through shared/workspace_config.py."""

    def __init__(self, table: Any, kind: str, deployment_key: Mapping[str, str],
                 scope: WorkspaceScope | None) -> None:
        self._table, self._kind, self._key, self._scope = table, kind, deployment_key, scope

    def get_item(self) -> dict:
        return {'Item': get_config_item(self._table, self._kind, self._key, self._scope) or None}


def read_categories_config(aggregates_table: Any, scope: WorkspaceScope | None = None) -> list[dict]:
    """The stored categories config of ``scope``'s workspace (the deployment's without one), read strongly (no
    cache), ``[]`` when unset.

    For write paths that validate against the config (granting access,
    correcting a review's category): a category added a moment ago must be
    usable at once, which the 5-minute cache in ``shared.api`` cannot promise.
    """
    item = read_gate_item(
        _ScopedReader(aggregates_table, CATEGORIES_KIND, {'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK}, scope),
        log_message='Categories config read failed',
        error_message='Could not read categories. Please retry.',
    )
    raw = item.get('categories') if item else None
    return [c for c in raw if isinstance(c, dict) and c.get('name')] if isinstance(raw, list) else []


def read_access_row(aggregates_table: Any, subject: str) -> dict | None:
    """``subject``'s access row, or None when there is none."""
    return read_gate_item(
        aggregates_table, log_message='Category access read failed',
        error_message='Could not verify category access. Please retry.',
        Key=category_access.access_key(subject),
    )


def read_restricted_sources(aggregates_table: Any, scope: WorkspaceScope | None = None) -> frozenset[str]:
    """Ids of the restricted sources of ``scope``'s workspace (``SETTINGS#sources``, the deployment's without one),
    read strongly; empty when unset.

    Parsed leniently entry by entry so one malformed profile cannot un-restrict
    the others: any entry naming an id with ``restricted: true`` counts. A failed
    read is a 500, never "nothing restricted".
    """
    item = read_gate_item(
        _ScopedReader(aggregates_table, SOURCES_KIND, SOURCES_SETTINGS_KEY, scope),
        log_message='Source profiles read failed', error_message='Could not verify source access. Please retry.',
    )
    raw = item.get('sources') if item else None
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(
        entry['id'] for entry in raw
        if isinstance(entry, Mapping) and entry.get('restricted') is True
        and isinstance(entry.get('id'), str) and entry['id']
    )


def scope_for_caller(caller: Caller, aggregates_table: Any, workspace: WorkspaceScope | None = None) -> CategoryScope:
    """The scope ``caller`` sees (see ``category_access.resolve_scope``), against ``workspace``'s categories and
    restricted sources (the deployment's without one). The caller's access row is still the deployment's (the users
    API's category access moves with its own area)."""
    if caller.is_admin and not caller.delegated:
        return category_access.UNRESTRICTED
    if not caller.subject:
        return category_access.NOTHING
    if aggregates_table is None:
        # Fail closed: an unconfigured deployment cannot prove the row is absent.
        raise ServiceError('Could not verify category access. Please retry.')
    row = read_access_row(aggregates_table, caller.subject)
    # The categories config (cached up to 5 min by shared.api) is read only when
    # owner grants can matter, so an owner change reaches readers within that TTL.
    config = (
        get_raw_categories_config(aggregates_table, workspace)
        if category_access.needs_categories_config(caller, row) else ()
    )
    # The restricted source ids matter only to a caller without an explicit
    # `sources` grant; read uncached, so restricting a source applies at once.
    restricted = (
        read_restricted_sources(aggregates_table, workspace)
        if category_access.needs_restricted_sources(caller, row) else frozenset()
    )
    return category_access.resolve_scope(caller, row, config, restricted)


def scope_for_event(event: Mapping[str, Any], aggregates_table: Any,
                    workspace: WorkspaceScope | None = None) -> CategoryScope:
    """The scope for an API Gateway proxy event (403 without a subject), against ``workspace``'s configuration."""
    return scope_for_caller(caller_from_event(event), aggregates_table, workspace)
