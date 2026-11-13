"""
Memory retention (``voc-memory-retention``) — daily EventBridge schedule.

Archives (never deletes — archive is restorable) every company and personal
memory that ``memory_policy.should_archive`` says has run out:

* ``decay``     — no +1 / use / confirmation for 90 days;
* ``dated``     — past ``expires_at`` (e.g. a quarter objective at quarter end);
* ``long_term`` — never.

Reads the gsi1 status partitions (active, proposed, conflict) so personal
memories are covered without enumerating users, projected to the fields the
decision needs (no embeddings). The deployment's first, then each active
workspace's own (``WS#{ws}#MEMSTATUS#…``; the workspaces from the platform's
listing in voc-workspaces, shared/platform_workspaces.py). Bounded by the
invocation's remaining time; whatever is left is picked up the next day.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.metrics import MetricUnit

from shared import memory_policy as policy
from shared import memory_store as store
from shared.aws import get_dynamodb_resource, is_conditional_check_failure
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.platform_workspaces import list_workspaces
from shared.timestamps import now_iso
from shared.warm_init import warm_at_init
from shared.ws_repo import WorkspaceScope, partition_scope, scope_from_message

SWEPT_STATUSES: Final = (policy.STATUS_ACTIVE, policy.STATUS_PROPOSED, policy.STATUS_CONFLICT)
SAFETY_MARGIN_MS: Final = 15_000
DECISION_ATTRIBUTES: Final = (
    'pk', 'sk', 'memory_id', 'scope', 'status', 'retention', 'expires_at',
    'created_at', 'last_reinforced_at', 'last_used_at',
)


def archive(table, item: Mapping[str, Any], reason: str, now: datetime) -> bool:
    """Archive one memory; False when it vanished meanwhile."""
    try:
        store.set_fields(table, item, {'status': policy.STATUS_ARCHIVED, 'archived_reason': reason,
                                       'archived_at': now_iso(now)}, now=now)
    except Exception as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    workspace = partition_scope(item.get('pk'))
    in_workspace: dict[str, Any] = {} if workspace is None else {'workspace': workspace}
    store.append_event(table, str(item.get('memory_id')), 'archived', detail={'reason': reason}, now=now,
                       **in_workspace)
    return True


#: A page of the platform's listing of workspaces.
LISTING_PAGE: Final = 100


def active_workspaces(workspaces_table) -> list[WorkspaceScope]:
    """Every active workspace, from the platform's listing (one Query a page; never a Scan)."""
    found: list[WorkspaceScope] = []
    cursor = None
    while True:
        page, cursor = list_workspaces(workspaces_table, limit=LISTING_PAGE, cursor=cursor)
        found += [scope_from_message({'workspace_id': row['id']}) for row in page if row.get('status') == 'active']
        if not cursor:
            return found


def sweep(table, now: datetime, time_left_ms,
          workspaces: Callable[[], Iterable[WorkspaceScope]] = tuple) -> dict[str, int]:
    """The deployment's memories first, then each workspace's (``workspaces()``, read only once the deployment's sweep
    is done, so a listing fault never stops it; logged and counted, those wait for the next run), in an order that
    rotates by day, so a run that ends on its time budget does not leave the same workspaces out every day."""
    archived = {'expired': 0, 'decayed': 0}
    checked, stopped = _sweep_one(table, now, time_left_ms, None, archived)
    if not stopped:
        for workspace in _rotated(_listed(workspaces), now):
            more, stopped = _sweep_one(table, now, time_left_ms, workspace, archived)
            checked += more
            if stopped:
                break
    return {'checked': checked, **archived}


def _listed(workspaces: Callable[[], Iterable[WorkspaceScope]]) -> list[WorkspaceScope]:
    try:
        return list(workspaces())
    except Exception:
        logger.exception('The workspaces could not be listed; their memories are swept on the next run')
        metrics.add_metric(name='MemoryRetentionListingFailures', unit=MetricUnit.Count, value=1)
        return []


def _rotated(workspaces: list[WorkspaceScope], now: datetime) -> list[WorkspaceScope]:
    """``workspaces`` starting at a different one each day."""
    if not workspaces:
        return []
    start = now.toordinal() % len(workspaces)
    return workspaces[start:] + workspaces[:start]


def _sweep_one(table, now: datetime, time_left_ms, workspace: WorkspaceScope | None,
               archived: dict[str, int]) -> tuple[int, bool]:
    """One partition set's sweep (the deployment's, or a workspace's): ``(checked, stopped on the time budget)``."""
    checked = 0
    options: dict[str, Any] = {} if workspace is None else {'workspace': workspace}
    for scope in policy.SCOPES:
        for status in SWEPT_STATUSES:
            for item in store.query_status(table, scope, status, attributes=DECISION_ATTRIBUTES, **options):
                if time_left_ms() < SAFETY_MARGIN_MS:
                    logger.warning('Memory retention stopped on its time budget')
                    return checked, True
                checked += 1
                reason = policy.should_archive(item, now)
                if reason is not None and archive(table, item, reason, now):
                    archived[reason] += 1
    return checked, False


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(_event: dict, context: Any) -> dict:
    table = store.get_memory_table()
    if table is None:
        raise RuntimeError('MEMORY_TABLE is not configured')
    workspaces_name = os.environ.get('WORKSPACES_TABLE', '')

    def workspaces() -> list[WorkspaceScope]:
        return active_workspaces(get_dynamodb_resource().Table(workspaces_name)) if workspaces_name else []

    result = sweep(table, datetime.now(UTC), context.get_remaining_time_in_millis, workspaces=workspaces)
    total = result['expired'] + result['decayed']
    if total:
        metrics.add_metric(name='MemoriesArchived', unit=MetricUnit.Count, value=total)
    return result
