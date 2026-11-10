"""Saving a generated persona set into its project, one transaction per persona.

5.35.01 live (e2e s3 step 02): the project was deleted while its personas were
being written. The first persona's transaction was cancelled with
``[ConditionalCheckFailed, None]`` (the project-writable check), the generator
raised a generic "Please try again" ServiceError after ten avatars had been
billed, and the reasons were never logged. Here:

- every cancellation logs its ``CancellationReasons`` codes;
- a refused project-writable check (index 0) is ``ProjectNotWritableError``, a
  terminal 404 for the job (no retry, no DLQ): a deleted project never takes
  personas back;
- an existing row at the persona's key (index 1, a redelivered job that already
  wrote it) is skipped, not fatal, so the rest of the set is still saved;
- a transient cancellation (a concurrent transaction on META, throttling) is
  retried, so one contended write does not throw the billed set away;
- the project's ``persona_count`` is recounted from its rows, which stays right
  when an agent appends (``keep_existing_personas``) instead of replacing.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.dynamo_paging import iter_query
from shared.exceptions import NotFoundError
from shared.logging import logger
from shared.project_writes import (
    PROJECT_WRITABLE_ATTRIBUTE_NAMES,
    PROJECT_WRITABLE_ATTRIBUTE_VALUES,
    PROJECT_WRITABLE_CONDITION,
    is_project_tombstone,
    project_meta_key,
    put_project_item,
)

#: Index of the project-writable ConditionCheck / of the persona Put in ``put_project_item``'s transaction.
WRITABLE_CHECK_INDEX = 0
PERSONA_PUT_INDEX = 1
#: Cancellation codes a retry can clear (a concurrent transaction on the same rows, a throttle).
RETRYABLE_CODES = frozenset({'TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded', 'RequestLimitExceeded'})
MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 0.2

PROJECT_GONE_MESSAGE = 'The project was deleted while its personas were being generated'


class ProjectNotWritableError(NotFoundError):
    """The project is deleted (or being deleted): nothing may be written into it."""


def cancellation_codes(error: ClientError) -> list[str | None]:
    """The per-item codes of a cancelled transaction (``None`` = that item was fine); [] otherwise."""
    reasons = error.response.get('CancellationReasons')
    if not isinstance(reasons, list):
        return []
    codes: list[str | None] = []
    for reason in reasons:
        code = reason.get('Code')
        codes.append(code if isinstance(code, str) and code != 'None' else None)
    return codes


def _code_at(codes: list[str | None], index: int) -> str | None:
    return codes[index] if len(codes) > index else None


def require_writable_project(table: Any, project_id: str) -> None:
    """Raise ``ProjectNotWritableError`` unless the project META exists and is not a tombstone.

    Checked before the avatar batch, the billed tail of a generation: a project
    deleted during the model calls gets no avatars made for it.
    """
    item = table.get_item(Key=project_meta_key(project_id), ConsistentRead=True).get('Item')
    if not isinstance(item, dict) or is_project_tombstone(item):
        logger.info(f'[PERSONA] Project {project_id} is gone or being deleted; no avatars or personas are written')
        raise ProjectNotWritableError(PROJECT_GONE_MESSAGE)


def _retryable(error: ClientError, project_id: str, item: dict, attempt: int) -> bool:
    """Classify a refused persona write: True = retry; False = the row already exists; else raises."""
    if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
        raise error
    codes = cancellation_codes(error)
    logger.warning(
        f"[PERSONA] Save of {item.get('persona_id')} cancelled (attempt {attempt}/{MAX_ATTEMPTS})",
        extra={'project_id': project_id, 'cancellation_reasons': codes},
    )
    if _code_at(codes, WRITABLE_CHECK_INDEX) == 'ConditionalCheckFailed':
        raise ProjectNotWritableError(PROJECT_GONE_MESSAGE) from error
    if _code_at(codes, PERSONA_PUT_INDEX) == 'ConditionalCheckFailed':
        return False
    if attempt == MAX_ATTEMPTS or not RETRYABLE_CODES.intersection(c for c in codes if c):
        raise error
    return True


def _put_once(table: Any, project_id: str, item: dict, sleep: Callable[[float], None]) -> bool:
    """Write one persona; True when written, False when its row already existed."""
    attempt = 0
    while True:
        attempt += 1
        try:
            put_project_item(table, project_id, item)
        except ClientError as error:
            if not _retryable(error, project_id, item, attempt):
                return False
            sleep(RETRY_BASE_SECONDS * attempt)
        else:
            return True


def save_persona_items(
    table: Any, project_id: str, items: list[dict], *, sleep: Callable[[float], None] = time.sleep,
) -> list[dict]:
    """Write each persona in order; the items that are now stored (an already-stored one included)."""
    saved: list[dict] = []
    for i, item in enumerate(items):
        logger.info(f"[PERSONA] Saving persona {i + 1}/{len(items)}: {item.get('name', 'unnamed')}")
        if _put_once(table, project_id, item, sleep):
            logger.info(f"[PERSONA] Saved persona: {item.get('name')}")
        else:
            logger.info(f"[PERSONA] Persona {item.get('persona_id')} was already stored (a redelivered job); kept")
        saved.append(item)
    return saved


def count_personas(table: Any, project_id: str) -> int:
    """How many PERSONA# rows the project holds (every page)."""
    return sum(1 for _ in iter_query(table, {
        'KeyConditionExpression': Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('PERSONA#'),
        'ProjectionExpression': 'sk',
    }))


def store_persona_count(table: Any, project_id: str, now: str) -> int:
    """Set META ``persona_count`` to the project's real persona total; the total."""
    total = count_personas(table, project_id)
    try:
        table.update_item(
            Key=project_meta_key(project_id),
            UpdateExpression='SET persona_count = :count, updated_at = :now',
            ConditionExpression=PROJECT_WRITABLE_CONDITION,
            ExpressionAttributeNames=dict(PROJECT_WRITABLE_ATTRIBUTE_NAMES),
            ExpressionAttributeValues={**PROJECT_WRITABLE_ATTRIBUTE_VALUES, ':count': total, ':now': now},
        )
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise ProjectNotWritableError(PROJECT_GONE_MESSAGE) from error
        raise
    return total
