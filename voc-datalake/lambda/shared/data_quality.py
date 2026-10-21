"""Data Quality: async profiling and (re)calculation of enrichment fields.

Two job kinds, both run by the `voc-data-quality-worker` Lambda off one SQS queue
so the Settings API never does the heavy work inside a 29-second request:

- ``profile``  — scans the feedback table and writes a per-source snapshot of the
  rating / sentiment / enrichment-field / text-length distributions.
- ``enrich``   — for one source partition and one registry field
  (shared/enrichment_fields.py), derives the value with the same guide the
  processor uses: ``mode='missing'`` fills only unscored rows (the "initial
  calculation" for rows enriched before the field existed), ``mode='all'``
  recalculates every row.

Message flow (all JSON on the data-quality queue):

    settings API ──► {type: profile_scan}  ──► worker scans pages, re-enqueues
                                               itself with the cursor until done
    settings API ──► {type: enrich_plan}   ──► worker pages the source partition,
                                               fans out one enrich_item per row,
                                               re-enqueues itself with the cursor
                     {type: enrich_item}   ──► worker derives + update_items one row

State lives in the aggregates table (the settings Lambda already owns it):

    DATA_QUALITY#JOBS / <job_id>              job record + progress counters
    DATA_QUALITY#LOCK / <kind>#<source>#<field>  one active job per target
    DATA_QUALITY#STATS / latest               the last completed profile

Writing an enrichment value is an ``update_item`` of one attribute guarded by
``attribute_exists(pk)``: the feedback stream turns it into a MODIFY that the
aggregator recognises as touching no counter (a no-op), and the guard stops an
update on a just-deleted row from upserting a phantom item the aggregator would
count as an INSERT.
"""
from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError

from shared.enrichment_fields import (
    ENRICHMENT_FIELDS,
    EnrichmentField,
    item_value,
    normalize_value,
)

JOBS_PK = 'DATA_QUALITY#JOBS'
LOCK_PK = 'DATA_QUALITY#LOCK'
STATS_PK = 'DATA_QUALITY#STATS'
STATS_SK = 'latest'

KIND_PROFILE = 'profile'
KIND_ENRICH = 'enrich'
MODE_MISSING = 'missing'
MODE_ALL = 'all'
ENRICH_MODES = (MODE_MISSING, MODE_ALL)

MSG_PROFILE_SCAN = 'profile_scan'
MSG_ENRICH_PLAN = 'enrich_plan'
MSG_ENRICH_ITEM = 'enrich_item'

STATUS_RUNNING = 'running'
STATUS_COMPLETED = 'completed'
STATUS_FAILED = 'failed'
STATUS_CANCELLED = 'cancelled'

JOB_TTL_DAYS = 30
# A lock outlives any healthy job; an expired one is taken over, so a worker that
# died without releasing it cannot block a source forever.
LOCK_TTL_HOURS = 24
RECENT_JOBS_LIMIT = 20
# A source name is the pk segment after SOURCE#; DynamoDB caps a key at 2048 bytes.
MAX_SOURCE_LENGTH = 256

FEEDBACK_PK_PREFIX = 'SOURCE#'
FEEDBACK_SK_PREFIX = 'FEEDBACK#'

# Profile buckets.
RATING_NONE = 'none'
LENGTH_BUCKETS: tuple[tuple[str, int], ...] = (
    ('0-100', 100), ('101-500', 500), ('501-1000', 1000), ('1001-2000', 2000),
)
LENGTH_OVERFLOW_BUCKET = '2000+'
# The partial profile rides inside an SQS message (256 KB cap) between scan
# continuations, and the snapshot is one DynamoDB item (400 KB cap); one source's
# entry is well under 1 KB, so past this many partitions the rest are folded into
# one bucket.
MAX_PROFILE_SOURCES = 200
OVERFLOW_SOURCE = '(other sources)'


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_job_id(now: datetime | None = None) -> str:
    """Time-sortable id, so the jobs partition lists newest-first by sort key."""
    now = now or utc_now()
    return f"dq_{now.strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"


def lock_sk(kind: str, source: str = '', field: str = '') -> str:
    return f'{kind}#{source}#{field}'


def job_lock_sk(job: Mapping[str, Any]) -> str:
    return lock_sk(job.get('kind', ''), job.get('source', ''), job.get('field', ''))


def _ttl(now: datetime, delta: timedelta) -> int:
    return int((now + delta).timestamp())


def is_conditional_failure(error: ClientError) -> bool:
    return error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'


# ---------------------------------------------------------------------------
# Job store (aggregates table)
# ---------------------------------------------------------------------------

def acquire_lock(table, sk: str, job_id: str, now: datetime | None = None) -> bool:
    """Take the per-target lock; False when another live job holds it."""
    now = now or utc_now()
    try:
        table.put_item(
            Item={
                'pk': LOCK_PK, 'sk': sk, 'job_id': job_id,
                'acquired_at': now.isoformat(),
                'ttl': _ttl(now, timedelta(hours=LOCK_TTL_HOURS)),
            },
            ConditionExpression='attribute_not_exists(pk) OR #ttl < :now',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':now': int(now.timestamp())},
        )
        return True
    except ClientError as e:
        if is_conditional_failure(e):
            return False
        raise


def release_lock(table, sk: str, job_id: str) -> None:
    """Drop the lock only if this job still holds it."""
    try:
        table.delete_item(
            Key={'pk': LOCK_PK, 'sk': sk},
            ConditionExpression='job_id = :job',
            ExpressionAttributeValues={':job': job_id},
        )
    except ClientError as e:
        if not is_conditional_failure(e):
            raise


def create_job_record(table, job: dict, now: datetime | None = None) -> dict:
    now = now or utc_now()
    item = {
        'pk': JOBS_PK,
        'sk': job['job_id'],
        'status': STATUS_RUNNING,
        'total': 0,
        'processed': 0,
        'updated': 0,
        'skipped': 0,
        'failed': 0,
        'planned': False,
        'created_at': now.isoformat(),
        'updated_at': now.isoformat(),
        'ttl': _ttl(now, timedelta(days=JOB_TTL_DAYS)),
        **job,
    }
    table.put_item(Item=item)
    return item


def get_job(table, job_id: str) -> dict | None:
    return table.get_item(Key={'pk': JOBS_PK, 'sk': job_id}).get('Item')


def list_recent_jobs(table, limit: int = RECENT_JOBS_LIMIT) -> list[dict]:
    response = table.query(
        KeyConditionExpression='pk = :pk',
        ExpressionAttributeValues={':pk': JOBS_PK},
        ScanIndexForward=False,
        Limit=limit,
    )
    return response.get('Items', [])


def add_progress(table, job_id: str, **counters: int) -> dict | None:
    """Atomically ADD the given counters; returns the updated record."""
    deltas = {k: v for k, v in counters.items() if v}
    if not deltas:
        return get_job(table, job_id)
    names = {f'#{k}': k for k in deltas}
    values = {f':{k}': v for k, v in deltas.items()}
    values[':now'] = utc_now().isoformat()
    response = table.update_item(
        Key={'pk': JOBS_PK, 'sk': job_id},
        UpdateExpression='ADD ' + ', '.join(f'#{k} :{k}' for k in deltas) + ' SET updated_at = :now',
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ConditionExpression='attribute_exists(pk)',
        ReturnValues='ALL_NEW',
    )
    return response.get('Attributes')


def set_job_fields(table, job_id: str, **fields: Any) -> dict | None:
    """SET the given fields; returns the updated record."""
    names = {f'#{k}': k for k in fields}
    values = {f':{k}': v for k, v in fields.items()}
    values[':now'] = utc_now().isoformat()
    response = table.update_item(
        Key={'pk': JOBS_PK, 'sk': job_id},
        UpdateExpression='SET ' + ', '.join(f'#{k} = :{k}' for k in fields) + ', updated_at = :now',
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ConditionExpression='attribute_exists(pk)',
        ReturnValues='ALL_NEW',
    )
    return response.get('Attributes')


def finish_job(table, job: Mapping[str, Any], status: str, error: str | None = None) -> bool:
    """Move a running job to a terminal status once; release its lock.

    Conditional on the job still running, so two workers racing to complete the
    same job (or a cancel racing a completion) produce one transition.
    """
    values: dict[str, Any] = {
        ':status': status, ':running': STATUS_RUNNING, ':now': utc_now().isoformat(),
    }
    expression = 'SET #status = :status, completed_at = :now, updated_at = :now'
    if error:
        expression += ', #error = :error'
        values[':error'] = error[:500]
    try:
        table.update_item(
            Key={'pk': JOBS_PK, 'sk': job['job_id']},
            UpdateExpression=expression,
            ConditionExpression='#status = :running',
            ExpressionAttributeNames={'#status': 'status', **({'#error': 'error'} if error else {})},
            ExpressionAttributeValues=values,
        )
    except ClientError as e:
        if is_conditional_failure(e):
            return False
        raise
    release_lock(table, job_lock_sk(job), job['job_id'])
    return True


def is_complete(job: Mapping[str, Any]) -> bool:
    """Every planned item has been accounted for."""
    return bool(job.get('planned')) and int(job.get('processed', 0)) >= int(job.get('total', 0))


# ---------------------------------------------------------------------------
# Profile accumulation (pure)
# ---------------------------------------------------------------------------

def _empty_source_profile() -> dict:
    return {
        'count': 0,
        'ratings': {},
        'sentiments': {},
        'lengths': {},
        'enrichment': {f.name: {} for f in ENRICHMENT_FIELDS},
    }


def _bump(counter: dict, key: str) -> None:
    counter[key] = counter.get(key, 0) + 1


def rating_bucket(rating: Any) -> str:
    try:
        value = round(float(rating))
    except (TypeError, ValueError):
        return RATING_NONE
    return str(value) if 1 <= value <= 5 else RATING_NONE


def length_bucket(text: Any) -> str:
    length = len(text) if isinstance(text, str) else 0
    for name, upper in LENGTH_BUCKETS:
        if length <= upper:
            return name
    return LENGTH_OVERFLOW_BUCKET


def source_of(item: Mapping[str, Any]) -> str | None:
    pk = item.get('pk')
    if not isinstance(pk, str) or not pk.startswith(FEEDBACK_PK_PREFIX):
        return None
    return pk[len(FEEDBACK_PK_PREFIX):]


def accumulate_profile(profile: dict, items: list[Mapping[str, Any]]) -> dict:
    """Fold scanned feedback items into `{source: source_profile}` (mutates + returns)."""
    for item in items:
        sk = item.get('sk')
        source = source_of(item)
        if source is None or not (isinstance(sk, str) and sk.startswith(FEEDBACK_SK_PREFIX)):
            continue
        if source not in profile and len(profile) >= MAX_PROFILE_SOURCES:
            source = OVERFLOW_SOURCE
        entry = profile.setdefault(source, _empty_source_profile())
        entry['count'] += 1
        _bump(entry['ratings'], rating_bucket(item.get('rating')))
        _bump(entry['sentiments'], str(item.get('sentiment_label') or 'unknown'))
        _bump(entry['lengths'], length_bucket(item.get('original_text')))
        for ef in ENRICHMENT_FIELDS:
            _bump(entry['enrichment'].setdefault(ef.name, {}), item_value(item, ef))
    return profile


def profile_projection() -> tuple[str, dict[str, str]]:
    """ProjectionExpression + names for the profile scan (only what is counted)."""
    attributes = ['pk', 'sk', 'rating', 'sentiment_label', 'original_text', *[f.name for f in ENRICHMENT_FIELDS]]
    names = {f'#p{i}': a for i, a in enumerate(attributes)}
    return ', '.join(names), names


def snapshot_sources(profile: Mapping[str, dict]) -> list[dict]:
    """The stored snapshot's source list, largest first."""
    return sorted(
        ({'source': source, **entry} for source, entry in profile.items()),
        key=lambda s: s['count'], reverse=True,
    )


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

def to_plain(value: Any) -> Any:
    """`value` with DynamoDB Decimals turned into ints/floats, recursively."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    return value


def to_json(value: Any) -> str:
    """JSON for SQS bodies (Decimal-safe)."""
    return json.dumps(to_plain(value))


_JSON_OBJECT = re.compile(r'\{.*\}', re.DOTALL)


def parse_single_field_answer(field: EnrichmentField, answer: str) -> str | None:
    """The model's value for `field`, validated, or None for any unusable answer."""
    if not isinstance(answer, str):
        return None
    match = _JSON_OBJECT.search(answer)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return normalize_value(field, parsed.get(field.name)) if isinstance(parsed, dict) else None
