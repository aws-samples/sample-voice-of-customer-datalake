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

import os
import time
from typing import Final

from shared.image_model_status import ImageAccess, image_access
from shared.model_capacity import ModelCapacity

# The reads are sequential (one boto3 client, cached per region); past this many seconds the
# remaining rows answer `unknown` at once, so a slow Bedrock control plane cannot hold the
# settings Lambda (30 s) for every model in turn. The next request reads them (cache: 5 min).
ACCESS_BUDGET_SECONDS: Final = 8.0
_PROFILE_PREFIX: Final = 'global.'


class ModelCapacityWithAccess(ModelCapacity):
    access: ImageAccess


def foundation_model_id(model_id: str) -> str:
    """The foundation-model id of an allowlisted inference profile (``global.`` stripped), the id
    the agreement is on (lib/utils/model-allowlist.ts ``toFoundationModelId``)."""
    return model_id.removeprefix(_PROFILE_PREFIX)


def app_region() -> str:
    """The region the deploy created the Claude agreements in: the Lambda's own."""
    return os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION') or 'us-east-1'


def _unread() -> ImageAccess:
    """A row past the budget: not read this time (``checked_at`` empty)."""
    return {'status': 'unknown', 'agreement': '', 'authorization': '', 'entitlement': '',
            'region_availability': '', 'checked_at': ''}


def with_access(rows: list[ModelCapacity]) -> list[ModelCapacityWithAccess]:
    """``rows`` with each model's ``access`` (status ``available | no_access | not_subscribed |
    not_in_region | unknown``). Never raises."""
    region = app_region()
    deadline = time.monotonic() + ACCESS_BUDGET_SECONDS
    result: list[ModelCapacityWithAccess] = []
    for row in rows:
        model_id = foundation_model_id(row['model_id'])
        access = image_access(model_id, region) if time.monotonic() < deadline else _unread()
        result.append({'model_id': row['model_id'], 'label': row['label'], 'quota': row['quota'], 'access': access})
    return result
