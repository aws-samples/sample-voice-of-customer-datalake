"""The Bedrock tokens-per-minute quotas the Settings model picker shows, kept between containers.

5.35.01 live: ``GET /settings/model/capacity`` took 14.5-15.9 s on the first load of
Administration -> AI models. Service Quotas pages the ~1,050 Bedrock quotas a few at
a time, the Anthropic token quotas are spread over the whole listing, and the
listing was cached only in the container's memory, so every cold container paid it.

Now ``shared.model_capacity`` reads, in order:

1. its in-memory copy (10 minutes);
2. this row in the aggregates table (``SETTINGS#model_quotas`` / ``current``): the
   Anthropic token quotas with their quota codes and when they were read. Fresh for
   an hour: one GetItem;
3. a stale row whose codes cover every allowlisted model: one ``GetServiceQuota`` per
   model, in parallel (well under a second), then the row is rewritten;
4. otherwise (first use, a model added to the allowlist) the full listing at 100 per
   page, which also learns the codes.

A request never waits on steps 3 and 4 when a row is stored (5.35.02 e2e: a cold
``GET /settings/model/capacity`` took 5.2 s, budget 4.5 s): it answers with the stored
values marked ``stale`` and the settings worker twin refreshes the row in the background
(``shared.model_capacity``). ``claim_refresh`` lets one request per ``REFRESH_CLAIM_SECONDS``
start that refresh, so a burst of cold containers starts one, not one each. Only the very
first reading of a deployment (nothing stored yet) is read inline.

Service Quotas throttles (``TooManyRequestsException``; 5.35 live, parallel e2e): the
client retries adaptively (``shared.model_capacity``), the by-code refresh runs at most
``REFRESH_WORKERS`` reads at a time, and a refresh or listing that still fails answers
with the stored values marked ``stale`` instead of "quota unknown".

Every read and write here is best effort: a missing table or a DynamoDB error means
"no stored copy", never a failed request.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import is_conditional_check_failure
from shared.logging import logger
from shared.tables import get_aggregates_table

ROW_KEY: Final = {'pk': 'SETTINGS#model_quotas', 'sk': 'current'}
FRESH_SECONDS: Final = 3600
# At most this many GetServiceQuota reads in flight: the API is rate limited per account,
# and 8 at once (5.35 live) tripped TooManyRequestsException under parallel load.
REFRESH_WORKERS: Final = 3
THROTTLE_CODES: Final = frozenset({'TooManyRequestsException', 'ThrottlingException'})
SERVICE_CODE: Final = 'bedrock'
# One background refresh per this many seconds: a refresh that never landed (a throttle, a
# failed invoke) is started again by the first request after it.
REFRESH_CLAIM_SECONDS: Final = 120


@dataclass(frozen=True)
class StoredQuotas:
    """Quota name -> applied value, quota name -> quota code, when the values were read (epoch s),
    and the quota names the reading was taken for (the allowlist then: a model added since re-lists)."""
    values: dict[str, float]
    codes: dict[str, str]
    fetched_at: float
    names: frozenset[str] = frozenset()

    def is_fresh(self, now: float) -> bool:
        return now - self.fetched_at < FRESH_SECONDS

    def answers(self, names: list[str]) -> bool:
        """Was this reading taken for (at least) these quota names?"""
        return self.names.issuperset(names)


def _table() -> Any:
    return get_aggregates_table()


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float | Decimal):
        return float(value)
    return None


def _parse(item: dict) -> StoredQuotas | None:
    values, codes, fetched_at = item.get('values'), item.get('codes'), _number(item.get('fetched_at'))
    names = item.get('names')
    if not isinstance(values, dict) or not isinstance(codes, dict) or fetched_at is None:
        return None
    parsed_names = frozenset(str(n) for n in names) if isinstance(names, list | set) else frozenset()
    parsed_values = {str(k): v for k, raw in values.items() if (v := _number(raw)) is not None}
    parsed_codes = {str(k): str(v) for k, v in codes.items() if isinstance(v, str)}
    return StoredQuotas(values=parsed_values, codes=parsed_codes, fetched_at=fetched_at, names=parsed_names)


def read_row(table: Any, key: dict[str, str], failure: str) -> dict | None:
    """One row by ``key`` (best effort): None with no table, no row, or an AWS error (logged as ``failure``)."""
    if table is None:
        return None
    try:
        item = table.get_item(Key=key).get('Item')
    except (ClientError, BotoCoreError) as error:
        logger.warning(failure, extra={'error': type(error).__name__})
        return None
    return item if isinstance(item, dict) else None


def load() -> StoredQuotas | None:
    """The stored quotas, or None (no table, no row, unreadable)."""
    item = read_row(_table(), ROW_KEY, 'Stored model quotas unreadable; listing them')
    return _parse(item) if item is not None else None


def save(stored: StoredQuotas) -> None:
    """Write the row (best effort)."""
    table = _table()
    if table is None:
        return
    try:
        table.put_item(Item={
            **ROW_KEY,
            'values': {name: Decimal(str(value)) for name, value in stored.values.items()},
            'codes': dict(stored.codes),
            'fetched_at': Decimal(str(round(stored.fetched_at, 3))),
            'names': sorted(stored.names),
        })
    except (ClientError, BotoCoreError) as error:
        logger.warning('Model quotas not stored', extra={'error': type(error).__name__})


def claim_refresh(now: float) -> bool:
    """Mark the stored row as being refreshed; False when another request did so in the last
    ``REFRESH_CLAIM_SECONDS``. A DynamoDB error claims (best effort: a second refresh is harmless).

    ``save`` rewrites the whole row, so a landed refresh clears the mark."""
    return claim_row_refresh(_table(), ROW_KEY, now, window_seconds=REFRESH_CLAIM_SECONDS, require_row=True)


def claim_row_refresh(table: Any, key: dict[str, str], now: float, *, window_seconds: float,
                      require_row: bool) -> bool:
    """Set ``refresh_requested_at`` on the row ``key`` unless it was set in the last ``window_seconds``.

    False only when another request holds the claim. No table, or a DynamoDB error, claims (best
    effort: a second refresh is harmless). ``require_row``: claim only an existing row.
    """
    if table is None:
        return True
    fresh = 'attribute_not_exists(refresh_requested_at) OR refresh_requested_at < :cutoff'
    try:
        table.update_item(
            Key=key,
            UpdateExpression='SET refresh_requested_at = :now',
            ConditionExpression=f'attribute_exists(pk) AND ({fresh})' if require_row else fresh,
            ExpressionAttributeValues={
                ':now': Decimal(str(round(now, 3))),
                ':cutoff': Decimal(str(round(now - window_seconds, 3))),
            },
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        logger.warning('Quota refresh not marked; refreshing anyway', extra={'error': error_code(error)})
    except BotoCoreError as error:
        logger.warning('Quota refresh not marked; refreshing anyway', extra={'error': type(error).__name__})
    return True


def error_code(error: ClientError | BotoCoreError) -> str | None:
    """The AWS error code of a ClientError, else the botocore exception's type name."""
    return error.response.get('Error', {}).get('Code') if isinstance(error, ClientError) else type(error).__name__


def is_throttle(error: ClientError | BotoCoreError) -> bool:
    """Is this Service Quotas error a rate limit (retry later, serve what is stored)?"""
    return error_code(error) in THROTTLE_CODES


def _one_value(client: Any, code: str) -> float | None:
    response = client.get_service_quota(ServiceCode=SERVICE_CODE, QuotaCode=code)
    return _number((response.get('Quota') or {}).get('Value'))


def refresh_by_code(client: Any, codes: dict[str, str]) -> dict[str, float] | None:
    """Re-read each named quota by its code, a few at a time; None when any read fails (list instead).

    A throttle is re-raised: listing ~1,050 quotas would only be throttled harder, so the
    caller serves the stored values instead."""
    if not codes:
        return None
    names = list(codes)
    try:
        with ThreadPoolExecutor(max_workers=min(REFRESH_WORKERS, len(names))) as pool:
            read = list(pool.map(lambda name: _one_value(client, codes[name]), names))
    except (ClientError, BotoCoreError) as error:
        if is_throttle(error):
            raise
        logger.warning('Quota refresh by code failed; listing instead', extra={'error_code': error_code(error)})
        return None
    if any(value is None for value in read):
        return None
    return {name: value for name, value in zip(names, read, strict=True) if value is not None}


def stored_now(values: dict[str, float], codes: dict[str, str], names: list[str]) -> StoredQuotas:
    """A reading taken now for the quota ``names``."""
    return StoredQuotas(values=dict(values), codes=dict(codes), fetched_at=time.time(), names=frozenset(names))
