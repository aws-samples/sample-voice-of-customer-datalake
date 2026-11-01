"""Each allowlisted Claude model's agreement as Administration -> AI models shows it.

The deploy accepts every Claude model's agreement (EULA + Marketplace subscription) best effort
(``BedrockModelAgreements`` in lib/stacks/bedrock-access-stack.ts, VocCoreStack). A refused one
does not fail the deploy, so without this an admin would only learn of it from an AccessDenied
at call time. ``with_access(rows)`` adds the account's live access to each row of
``GET /settings/model/capacity``: ``bedrock:GetFoundationModelAvailability`` for the model's
foundation id in the app's region, read and mapped exactly like the image model's row
(``shared.image_model_status.image_access``: cached 5 minutes, never raises, ``unknown`` on an
error). It reads the account's state, so an agreement accepted later in the Bedrock console
shows as available too, without a redeploy.

The settings role already holds that action (account-level, ``*``; lib/stacks/api-marketplace.ts
``grantImageModelProbe``), so this adds no permission.
"""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor, wait
from typing import Final

import boto3

from shared.image_model_status import ImageAccess, image_access, prime_control_client
from shared.logging import logger
from shared.model_capacity import ModelCapacity
from shared.model_config import GLOBAL_PROFILE_PREFIX

# The reads run side by side; whatever has not answered after this many seconds reads `unknown`
# (the next request reads it again; the cache keeps answers 5 minutes). That bounds the whole call
# well inside the settings Lambda's 30 s. An abandoned read ends on its own within the control-plane
# client's limits (image_model_status: connect 5 s, read 10 s, 2 attempts).
ACCESS_BUDGET_SECONDS: Final = 8.0
# Few at a time: a throttled control-plane read answers `unknown`, and the notice skips unknown rows.
MAX_PARALLEL_READS: Final = 4
DEFAULT_REGION: Final = 'us-east-1'


class ModelCapacityWithAccess(ModelCapacity):
    access: ImageAccess


def foundation_model_id(model_id: str) -> str:
    """The foundation-model id of an allowlisted inference profile (``global.`` stripped), the id
    the agreement is on (lib/utils/model-allowlist.ts ``toFoundationModelId``)."""
    return model_id.removeprefix(GLOBAL_PROFILE_PREFIX)


def app_region() -> str:
    """The region the deploy created the Claude agreements in: the Lambda's own."""
    return boto3.session.Session().region_name or DEFAULT_REGION


def _unread() -> ImageAccess:
    """A row not read within the budget (``checked_at`` empty)."""
    return {'status': 'unknown', 'agreement': '', 'authorization': '', 'entitlement': '',
            'region_availability': '', 'checked_at': ''}


def with_access(rows: list[ModelCapacity]) -> list[ModelCapacityWithAccess]:
    """``rows`` with each model's ``access`` (status ``available | no_access | not_subscribed |
    not_in_region | unknown``). Never raises; returns within about ACCESS_BUDGET_SECONDS."""
    if not rows:
        return []
    region = app_region()
    try:
        prime_control_client(region)
    except Exception:  # never raises: a client that cannot be built reads every row as unknown
        logger.warning('Bedrock control-plane client unavailable; model access reads unknown', exc_info=True)
        return [{**row, 'access': _unread()} for row in rows]
    pool = ThreadPoolExecutor(max_workers=min(len(rows), MAX_PARALLEL_READS))
    futures = [pool.submit(image_access, foundation_model_id(row['model_id']), region) for row in rows]
    wait(futures, timeout=ACCESS_BUDGET_SECONDS)
    # A read still running is abandoned, not awaited: the answer must not wait for it.
    pool.shutdown(wait=False, cancel_futures=True)
    return [{**row, 'access': _answer(future)} for row, future in zip(rows, futures, strict=True)]


def _answer(future: Future[ImageAccess]) -> ImageAccess:
    if not future.done() or future.cancelled() or future.exception() is not None:
        return _unread()
    return future.result()
