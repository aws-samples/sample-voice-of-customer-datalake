"""Whole-source erasure checks for ``POST /settings/erasure`` with ``field = 'source'``.

The settings Lambda starts the job; ``voc-retention`` deletes (``shared/retention.py``).
Before a job is accepted:

- the body repeats the source id in ``confirm`` (a server-side type-to-confirm:
  an SPA bug or a replayed request cannot erase a source nobody typed);
- the source is KNOWN: a configured source profile, or a source the aggregator
  has counted (``METRIC#daily_source#<id>`` rows, read through the
  ``gsi1-by-metric-type`` index, keys only). That covers sources without a
  profile, such as one Web Reviews page per ``web_<site>_<app>`` source id;
- no other erasure job of that source is live (queued or running). A live job
  that has not moved for ``STALE_AFTER`` (its ``progress_at``, else
  ``created_at``) no longer blocks: the worker refreshes a running job's row at
  least every minute, so an hour of silence means it died.

Two requests in the same instant can both pass the live-job check; both jobs
then delete the same items, and the second only repeats no-ops (deletes are
idempotent).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key

from shared.dynamo_paging import iter_query
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX
from shared.metric_keys import SOURCE_PREFIX
from shared.retention import ERASURE_JOB_PK

__all__ = ['blocking_job', 'known_sources']

SOURCE_METRIC_TYPE: Final = 'source'
LIVE_STATUSES: Final = ('queued', 'running')
STALE_AFTER: Final = timedelta(hours=1)
def known_sources(table: Any, profile_ids: Iterable[str]) -> list[str]:
    """Sorted source ids a whole-source erasure may name: the profiles plus every counted source."""
    known = set(profile_ids)
    rows = iter_query(table, {
        'IndexName': AGGREGATES_BY_METRIC_TYPE_INDEX,
        'KeyConditionExpression': Key('metric_type').eq(SOURCE_METRIC_TYPE),
        'ProjectionExpression': 'pk',
    })
    for row in rows:
        pk = row.get('pk')
        if isinstance(pk, str) and pk.startswith(SOURCE_PREFIX) and len(pk) > len(SOURCE_PREFIX):
            known.add(pk.removeprefix(SOURCE_PREFIX))
    return sorted(known)


def _last_moved(job: Mapping[str, Any]) -> datetime | None:
    for field in ('progress_at', 'created_at'):
        value = job.get(field)
        if isinstance(value, str):
            try:
                moved = datetime.fromisoformat(value)
            except ValueError:
                continue
            # A naive stamp would make the comparison with an aware `now` raise.
            return moved if moved.tzinfo else moved.replace(tzinfo=UTC)
    return None


def blocking_job(table: Any, source: str, now: datetime) -> str | None:
    """The id of a live erasure job of ``source`` that has moved within ``STALE_AFTER``, else None."""
    jobs = iter_query(table, {
        'KeyConditionExpression': Key('pk').eq(ERASURE_JOB_PK),
        'FilterExpression': Attr('status').is_in(list(LIVE_STATUSES)) & Attr('source').eq(source),
    })
    for job in jobs:
        moved = _last_moved(job)
        if moved is None or now - moved < STALE_AFTER:
            return str(job.get('job_id') or job.get('sk'))
    return None
