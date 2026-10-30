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

The live-job check alone is check-then-act: two requests in the same instant
could both pass it. The source's LOCK row closes that race: ``pk JOB#erasure``,
``sk SRCLOCK#<source>``, written with a condition (no row, a released row, or
one taken more than ``STALE_AFTER`` ago), so exactly one of two concurrent
starts wins and the other answers 409. The worker renews ``locked_at`` at each
hand-over (``refresh_source_lock``), so a job that runs for hours never presents
a stale lock, and releases it when the job
completes or fails, by UpdateItem (``released_at``): voc-retention holds no
delete on voc-aggregates, and a release names its job, so a job whose stale
lock was taken over never frees its successor's. A job's ``sk`` starts with
``er_``, so the job list never shows a lock row.

``known_sources`` reads the counted sources once per ``KNOWN_SOURCES_TTL_SECONDS``
per warm container (keys only, deduped while paging): GET and POST of
``/settings/erasure`` both need it.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX
from shared.logging import logger
from shared.metric_keys import SOURCE_PREFIX
from shared.retention import ERASURE_JOB_PK, ERASURE_JOB_PREFIX

__all__ = [
    'SourceLocked',
    'acquire_source_lock',
    'blocking_job',
    'known_sources',
    'refresh_source_lock',
    'release_source_lock',
    'reset_known_sources_cache',
]

SOURCE_METRIC_TYPE: Final = 'source'
LIVE_STATUSES: Final = ('queued', 'running')
STALE_AFTER: Final = timedelta(hours=1)
SOURCE_LOCK_PREFIX: Final = 'SRCLOCK#'
KNOWN_SOURCES_TTL_SECONDS: Final = 60

# Warm-container memo of the counted sources: table name -> (expires at, source ids).
_counted_cache: dict[str, tuple[float, frozenset[str]]] = {}


class SourceLocked(Exception):
    """Another erasure of the source holds its lock (the API answers 409)."""


def reset_known_sources_cache() -> None:
    """Forget the warm-container memo of counted sources (tests, between cases)."""
    _counted_cache.clear()


def _counted_sources(table: Any) -> frozenset[str]:
    """Every source with a ``METRIC#daily_source#<id>`` row: keys only, deduped while paging, memoised."""
    name = str(getattr(table, 'name', '') or id(table))
    now = time.monotonic()
    cached = _counted_cache.get(name)
    if cached is not None and now < cached[0]:
        return cached[1]
    counted: set[str] = set()
    rows = iter_query(table, {
        'IndexName': AGGREGATES_BY_METRIC_TYPE_INDEX,
        'KeyConditionExpression': Key('metric_type').eq(SOURCE_METRIC_TYPE),
        'ProjectionExpression': 'pk',
    })
    for row in rows:
        pk = row.get('pk')
        if isinstance(pk, str) and pk.startswith(SOURCE_PREFIX) and len(pk) > len(SOURCE_PREFIX):
            counted.add(pk.removeprefix(SOURCE_PREFIX))
    result = frozenset(counted)
    _counted_cache[name] = (now + KNOWN_SOURCES_TTL_SECONDS, result)
    return result


def known_sources(table: Any, profile_ids: Iterable[str]) -> list[str]:
    """Sorted source ids a whole-source erasure may name: the profiles plus every counted source.

    The profiles are the caller's fresh read; the counted sources come from a
    ``KNOWN_SOURCES_TTL_SECONDS`` warm-container memo (one source per day row,
    so the index holds many rows per source).
    """
    return sorted(set(profile_ids) | _counted_sources(table))


def source_lock_key(source: str) -> dict[str, str]:
    """The key of ``source``'s erasure lock row in voc-aggregates."""
    return {'pk': ERASURE_JOB_PK, 'sk': f'{SOURCE_LOCK_PREFIX}{source}'}


def acquire_source_lock(table: Any, source: str, job_id: str, now: datetime) -> None:
    """Take ``source``'s erasure lock for ``job_id``; raises ``SourceLocked`` when another job holds it.

    Free when there is no row, its holder released it, or it was taken more
    than ``STALE_AFTER`` ago (the holder died without a release).
    """
    try:
        table.put_item(
            Item={**source_lock_key(source), 'source': source, 'job_id': job_id, 'locked_at': now.isoformat()},
            ConditionExpression='attribute_not_exists(pk) OR attribute_exists(released_at) OR locked_at < :stale',
            ExpressionAttributeValues={':stale': (now - STALE_AFTER).isoformat()},
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            raise SourceLocked(source) from e
        raise


def refresh_source_lock(table: Any, source: str, job_id: str, now: datetime) -> None:
    """Renew ``locked_at`` while ``job_id`` still holds ``source``'s lock (the worker, at each hand-over).

    A whole-source erasure of a large table runs for several 15-minute
    invocations; without the renewal its lock would read as stale after
    ``STALE_AFTER`` and a second start could take it over. A lock that is
    released or held by another job is left alone.
    """
    _set_on_own_lock(table, source, job_id, now, 'locked_at', extra_condition=' AND attribute_not_exists(released_at)')


def release_source_lock(table: Any, source: str, job_id: str, now: datetime) -> None:
    """Mark ``source``'s lock released, only while ``job_id`` still holds it (UpdateItem, never a delete)."""
    _set_on_own_lock(table, source, job_id, now, 'released_at')


def _set_on_own_lock(table: Any, source: str, job_id: str, now: datetime, stamp: str, *,
                     extra_condition: str = '') -> None:
    """Set ``stamp`` to ``now`` on ``source``'s lock row while ``job_id`` holds it; a no-op otherwise."""
    try:
        table.update_item(
            Key=source_lock_key(source),
            UpdateExpression=f'SET {stamp} = :now',
            ConditionExpression=f'attribute_exists(pk) AND job_id = :job{extra_condition}',
            ExpressionAttributeValues={':now': now.isoformat(), ':job': job_id},
        )
    except ClientError as e:
        # Gone, or taken over by a later job: that lock is not ours to touch.
        if not is_conditional_check_failure(e):
            raise


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
    """The id of a live erasure job of ``source`` that has moved within ``STALE_AFTER``, else None.

    Reads only the job rows (``sk`` ``er_…``), not the partition's lock rows. A
    live row with no readable ``progress_at`` / ``created_at`` cannot show it is
    alive, so it counts as stale (logged) instead of blocking the source forever;
    the lock row still keeps two new starts apart.
    """
    jobs = iter_query(table, {
        'KeyConditionExpression': Key('pk').eq(ERASURE_JOB_PK) & Key('sk').begins_with(ERASURE_JOB_PREFIX),
        'FilterExpression': Attr('status').is_in(list(LIVE_STATUSES)) & Attr('source').eq(source),
    })
    for job in jobs:
        moved = _last_moved(job)
        if moved is None:
            logger.warning('A live erasure job has no readable timestamp; treating it as stale',
                           extra={'job_id': str(job.get('job_id') or job.get('sk'))})
        elif now - moved < STALE_AFTER:
            return str(job.get('job_id') or job.get('sk'))
    return None
