"""
Memory retention (``voc-memory-retention``) — daily EventBridge schedule.

Archives (never deletes — archive is restorable) every company and personal
memory that ``memory_policy.should_archive`` says has run out:

* ``decay``     — no +1 / use / confirmation for 90 days;
* ``dated``     — past ``expires_at`` (e.g. a quarter objective at quarter end);
* ``long_term`` — never.

Reads the gsi1 status partitions (active, proposed, conflict) so personal
memories are covered without enumerating users, projected to the fields the
decision needs (no embeddings). Bounded by the invocation's remaining time;
whatever is left is picked up the next day.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.metrics import MetricUnit

from shared import memory_policy as policy
from shared import memory_store as store
from shared.aws import is_conditional_check_failure
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics

SWEPT_STATUSES: Final = (policy.STATUS_ACTIVE, policy.STATUS_PROPOSED, policy.STATUS_CONFLICT)
SAFETY_MARGIN_MS: Final = 15_000
DECISION_ATTRIBUTES: Final = (
    'pk', 'sk', 'memory_id', 'scope', 'status', 'retention', 'expires_at',
    'created_at', 'last_reinforced_at', 'last_used_at',
)


def get_memory_table():
    return store.get_memory_table()


def archive(table, item: Mapping[str, Any], reason: str, now: datetime) -> bool:
    """Archive one memory; False when it vanished meanwhile."""
    try:
        store.set_fields(table, item, {'status': policy.STATUS_ARCHIVED, 'archived_reason': reason,
                                       'archived_at': store.now_iso(now)}, now=now)
    except Exception as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    store.append_event(table, str(item.get('memory_id')), 'archived', detail={'reason': reason}, now=now)
    return True


def sweep(table, now: datetime, time_left_ms) -> dict[str, int]:
    archived = {'expired': 0, 'decayed': 0}
    checked = 0
    for scope in policy.SCOPES:
        for status in SWEPT_STATUSES:
            for item in store.query_status(table, scope, status, attributes=DECISION_ATTRIBUTES):
                if time_left_ms() < SAFETY_MARGIN_MS:
                    logger.warning('Memory retention stopped on its time budget')
                    return {'checked': checked, **archived}
                checked += 1
                reason = policy.should_archive(item, now)
                if reason is not None and archive(table, item, reason, now):
                    archived[reason] += 1
    return {'checked': checked, **archived}


@instrumented_handler
def lambda_handler(_event: dict, context: Any) -> dict:
    table = get_memory_table()
    if table is None:
        raise RuntimeError('MEMORY_TABLE is not configured')
    result = sweep(table, datetime.now(UTC), context.get_remaining_time_in_millis)
    total = result['expired'] + result['decayed']
    if total:
        metrics.add_metric(name='MemoriesArchived', unit=MetricUnit.Count, value=total)
    return result
