"""The persona-avatar image model's requests-per-minute quota, for Administration -> AI models.

The image model (``avatar-generation.json`` "image_model", Stability in us-west-2) has an
on-demand quota named ``On-demand model inference requests per minute for Stability.ai <model>``
in the IMAGE model's region, not the app's. Finding it means listing every Bedrock quota of
that region (~1,050, 10-15 s; docs/deployment.md), so a request never does that itself when
the settings worker twin exists:

1. the container's memory copy (10 minutes);
2. the row ``SETTINGS#image_model_quota`` / ``current`` in the aggregates table, fresh for an
   hour;
3. older or absent: the request answers with what is stored (``stale``) or nothing
   (``pending``) and async-invokes the worker twin (``REFRESH_ACTION``) once per
   ``REFRESH_CLAIM_SECONDS``; the worker lists the quotas and rewrites the row.

Without a worker (local runs) the listing runs inline. Every read and write is best effort:
a failure means "quota unknown", never a failed request.
"""
from __future__ import annotations

import os
import time
from decimal import Decimal
from functools import lru_cache
from typing import Any, Final, Literal, TypedDict

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import invoke_lambda_async
from shared.logging import logger
from shared.model_quota_store import claim_row_refresh, read_row
from shared.tables import get_aggregates_table

QUOTA_PREFIX: Final = 'On-demand model inference requests per minute for Stability.ai '
UNIT: Final = 'requests_per_minute'
REFRESH_ACTION: Final = 'image_model_quota_refresh'
ROW_KEY: Final = {'pk': 'SETTINGS#image_model_quota', 'sk': 'current'}
FRESH_SECONDS: Final = 3600
MEMORY_SECONDS: Final = 600
REFRESH_CLAIM_SECONDS: Final = 120
_PAGE_SIZE: Final = 100
_CLIENT_CONFIG: Final = Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 3, 'mode': 'adaptive'})

QuotaState = Literal['fresh', 'stale', 'pending', 'unknown']


class ImageQuota(TypedDict):
    """One reading: the quota's Service Quotas name, its applied value and unit."""
    name: str
    value: int
    unit: str


class ImageQuotaReading(TypedDict):
    quota: ImageQuota | None
    state: QuotaState


# Per container: model id -> (reading, expires at). Module-level on purpose (warm invocations); tests clear it.
_memory: dict[str, tuple[ImageQuotaReading, float]] = {}


def _model_words(label: str) -> str:
    """'Stable Image Core 1.0' -> 'stable image core': the quota names the model without its version."""
    words = label.split()
    if words and words[-1].replace('.', '').isdigit():
        words = words[:-1]
    return ' '.join(words).lower()


def match_quota(quotas: list[dict], label: str) -> ImageQuota | None:
    """The Stability requests-per-minute quota of the model called ``label`` in a ListServiceQuotas page set."""
    wanted = _model_words(label)
    for quota in quotas:
        name, value = quota.get('QuotaName'), quota.get('Value')
        if not isinstance(name, str) or isinstance(value, bool) or not isinstance(value, int | float):
            continue
        if not name.startswith(QUOTA_PREFIX):
            continue
        rest = name[len(QUOTA_PREFIX):].strip().lower()
        if rest == wanted or rest.startswith(f'{wanted} '):
            return {'name': name, 'value': int(value), 'unit': UNIT}
    return None


@lru_cache(maxsize=2)
def _quotas_client(region: str) -> Any:
    """One Service Quotas client per region per container."""
    return boto3.client('service-quotas', region_name=region, config=_CLIENT_CONFIG)


def list_quota(region: str, label: str) -> ImageQuota | None:
    """List the Bedrock quotas of ``region`` (slow) and pick the image model's. Raises on AWS errors."""
    paginator = _quotas_client(region).get_paginator('list_service_quotas')
    found: list[dict] = []
    for page in paginator.paginate(ServiceCode='bedrock', PaginationConfig={'PageSize': _PAGE_SIZE}):
        found.extend(q for q in page.get('Quotas', []) if str(q.get('QuotaName', '')).startswith(QUOTA_PREFIX))
    return match_quota(found, label)


def _table() -> Any:
    return get_aggregates_table() if os.environ.get('AGGREGATES_TABLE') else None


def _load_row(model_id: str) -> dict | None:
    item = read_row(_table(), ROW_KEY, 'Stored image quota unreadable')
    return item if item is not None and item.get('model_id') == model_id else None


def _row_quota(row: dict) -> ImageQuota | None:
    name, value = row.get('name'), row.get('value')
    if not isinstance(name, str) or not isinstance(value, int | Decimal):
        return None
    return {'name': name, 'value': int(value), 'unit': UNIT}


def _save_row(model_id: str, quota: ImageQuota | None) -> None:
    table = _table()
    if table is None:
        return
    item: dict[str, Any] = {**ROW_KEY, 'model_id': model_id, 'fetched_at': Decimal(str(round(time.time(), 3)))}
    if quota is not None:
        item.update({'name': quota['name'], 'value': quota['value']})
    try:
        table.put_item(Item=item)
    except (ClientError, BotoCoreError) as error:
        logger.warning('Image quota not stored', extra={'error': type(error).__name__})


def _claim_refresh() -> bool:
    """Mark a refresh as started; False when another request did so in the last REFRESH_CLAIM_SECONDS."""
    return claim_row_refresh(_table(), ROW_KEY, time.time(), window_seconds=REFRESH_CLAIM_SECONDS, require_row=False)


def _start_refresh(model_id: str, region: str, label: str) -> bool:
    """Hand the listing to the settings worker twin; False when there is none."""
    worker = os.environ.get('ASSIST_WORKER_FUNCTION', '')
    if not worker:
        return False
    if _claim_refresh():
        try:
            invoke_lambda_async(worker, {'action': REFRESH_ACTION, 'model_id': model_id, 'region': region, 'label': label})
        except (ClientError, BotoCoreError) as error:
            logger.warning('Image quota refresh not started', extra={'error': type(error).__name__})
    return True


def _read_inline(model_id: str, region: str, label: str) -> ImageQuotaReading:
    try:
        quota = list_quota(region, label)
    except (ClientError, BotoCoreError) as error:
        logger.warning('Image quota listing failed; quota unknown', extra={'error': type(error).__name__})
        return {'quota': None, 'state': 'unknown'}
    _save_row(model_id, quota)
    return {'quota': quota, 'state': 'fresh'}


def _read(model_id: str, region: str, label: str) -> ImageQuotaReading:
    row = _load_row(model_id)
    stored = _row_quota(row) if row is not None else None
    fetched_at = row.get('fetched_at') if row is not None else None
    if isinstance(fetched_at, int | Decimal) and time.time() - float(fetched_at) < FRESH_SECONDS:
        return {'quota': stored, 'state': 'fresh'}
    if _start_refresh(model_id, region, label):
        return {'quota': stored, 'state': 'stale' if stored is not None else 'pending'}
    return _read_inline(model_id, region, label)


def image_quota(model_id: str, region: str, label: str) -> ImageQuotaReading:
    """The image model's requests-per-minute quota and how current it is. Never raises."""
    cached = _memory.get(model_id)
    if cached is not None and time.time() < cached[1]:
        return cached[0]
    reading: ImageQuotaReading
    try:
        reading = _read(model_id, region, label)
    except Exception:  # a quota lookup must never fail the AI models card
        logger.exception('Unexpected image quota failure; quota unknown')
        reading = {'quota': None, 'state': 'unknown'}
    # Only a fresh reading is kept for long: a pending/stale one is re-read on the next request.
    if reading['state'] == 'fresh':
        _memory[model_id] = (reading, time.time() + MEMORY_SECONDS)
    return reading


def run_refresh_event(event: dict) -> dict[str, bool]:
    """The worker side of ``REFRESH_ACTION``: list the quotas of the image region into the row."""
    model_id, region, label = (str(event.get(key, '')) for key in ('model_id', 'region', 'label'))
    if not model_id or not region:
        return {'refreshed': False}
    reading = _read_inline(model_id, region, label)
    return {'refreshed': reading['state'] == 'fresh'}
