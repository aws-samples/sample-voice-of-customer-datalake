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

from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access
from shared.api import get_raw_categories_config
from shared.category_access import CategoryScope
from shared.exceptions import ServiceError
from shared.logging import logger
from shared.project_access import Caller
from shared.project_gate import caller_from_event
from shared.source_profiles import SOURCES_SETTINGS_KEY

CATEGORIES_PK = 'SETTINGS#categories'
CATEGORIES_SK = 'config'


def read_categories_config(aggregates_table: Any) -> list[dict]:
    """The stored categories config, read strongly (no cache), ``[]`` when unset.

    For write paths that validate against the config (granting access,
    correcting a review's category): a category added a moment ago must be
    usable at once, which the 5-minute cache in ``shared.api`` cannot promise.
    """
    try:
        response = aggregates_table.get_item(
            Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK}, ConsistentRead=True)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Categories config read failed')
        raise ServiceError('Could not read categories. Please retry.') from exc
    item = response.get('Item') if isinstance(response, Mapping) else None
    raw = item.get('categories') if isinstance(item, Mapping) else None
    return [c for c in raw if isinstance(c, dict) and c.get('name')] if isinstance(raw, list) else []


def read_access_row(aggregates_table: Any, subject: str) -> dict | None:
    """``subject``'s access row, or None when there is none."""
    try:
        response = aggregates_table.get_item(Key=category_access.access_key(subject))
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Category access read failed')
        raise ServiceError('Could not verify category access. Please retry.') from exc
    item = response.get('Item') if isinstance(response, Mapping) else None
    return item if isinstance(item, dict) else None


def read_restricted_sources(aggregates_table: Any) -> frozenset[str]:
    """Ids of the restricted sources (``SETTINGS#sources``), read strongly; empty when unset.

    Parsed leniently entry by entry so one malformed profile cannot un-restrict
    the others: any entry naming an id with ``restricted: true`` counts. A failed
    read is a 500, never "nothing restricted".
    """
    try:
        response = aggregates_table.get_item(Key=SOURCES_SETTINGS_KEY, ConsistentRead=True)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Source profiles read failed')
        raise ServiceError('Could not verify source access. Please retry.') from exc
    item = response.get('Item') if isinstance(response, Mapping) else None
    raw = item.get('sources') if isinstance(item, Mapping) else None
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(
        entry['id'] for entry in raw
        if isinstance(entry, Mapping) and entry.get('restricted') is True
        and isinstance(entry.get('id'), str) and entry['id']
    )


def scope_for_caller(caller: Caller, aggregates_table: Any) -> CategoryScope:
    """The scope ``caller`` sees (see ``category_access.resolve_scope``)."""
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
        get_raw_categories_config(aggregates_table)
        if category_access.needs_categories_config(caller, row) else ()
    )
    # The restricted source ids matter only to a caller without an explicit
    # `sources` grant; read uncached, so restricting a source applies at once.
    restricted = (
        read_restricted_sources(aggregates_table)
        if category_access.needs_restricted_sources(caller, row) else frozenset()
    )
    return category_access.resolve_scope(caller, row, config, restricted)


def scope_for_event(event: Mapping[str, Any], aggregates_table: Any) -> CategoryScope:
    """The scope for an API Gateway proxy event (403 without a subject)."""
    return scope_for_caller(caller_from_event(event), aggregates_table)
