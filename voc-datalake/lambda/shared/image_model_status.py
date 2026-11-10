"""The persona-avatar image model as Administration -> AI models shows it.

The image model is not a picker choice: it is fixed in ``avatar-generation.json``
("image_model", Stability in us-west-2; ``shared.avatar.get_image_model_config``). This
module answers, for the settings routes (settings_handler.py):

- ``image_model_info()`` -> ``{id, label, region, avatars_enabled}`` (``GET /settings/model``);
- ``image_access()`` -> the account's access to it from ``bedrock:GetFoundationModelAvailability``
  in the IMAGE region, mapped to ``available | no_access | not_subscribed | not_in_region | unknown``;
- ``image_capacity()`` -> info + access + requests-per-minute quota (``GET /settings/model/capacity``,
  quota from ``shared.image_model_quota``);
- ``probe_image_model()`` -> ONE minimal image call (``POST /settings/model/test``), the same
  answer shape and status vocabulary as ``shared.model_capacity.probe_model``, the error
  classified by ``shared.avatar_failure``. Nothing is stored (no S3 write) and the prompt is
  fixed, so no customer data leaves the app's region.

The deploy requests the model's agreement / Marketplace subscription itself
(``ImageModelAccess`` in lib/stacks/bedrock-access-stack.ts); this is how an admin sees
whether that worked.
"""
from __future__ import annotations

import json
import time
from functools import lru_cache
from typing import Any, Final, Literal, TypedDict

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from shared import avatar_failure as af
from shared.avatar import avatars_enabled, get_image_model_config
from shared.image_model_quota import ImageQuota, QuotaState, image_quota
from shared.logging import logger
from shared.model_capacity import STATUS_MESSAGES, ProbeResult
from shared.timestamps import now_iso

# Product names of the image models avatar-generation.json may name (identical in every language).
IMAGE_MODEL_LABELS: Final = {
    'stability.stable-image-core-v1:1': 'Stable Image Core 1.0',
    'stability.stable-image-ultra-v1:1': 'Stable Image Ultra 1.0',
    'stability.sd3-5-large-v1:0': 'Stable Diffusion 3.5 Large',
}

AccessStatus = Literal['available', 'no_access', 'not_subscribed', 'not_in_region', 'unknown']

ACCESS_CACHE_SECONDS: Final = 300
# A fixed, harmless prompt: the test is about the model answering, not about a persona.
PROBE_PROMPT: Final = 'A plain light grey square, flat colour, no details'
PROBE_SEED: Final = 1
# One attempt and a read timeout well inside the settings Lambda's 30 s (an image takes a few seconds).
_PROBE_CONFIG: Final = Config(connect_timeout=5, read_timeout=20, retries={'max_attempts': 1, 'mode': 'standard'})
_CONTROL_CONFIG: Final = Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 2, 'mode': 'standard'})

# avatar_failure reason -> the model test status vocabulary (shared.model_capacity.STATUS_MESSAGES).
_REASON_STATUS: Final = {
    af.NO_ACCESS: 'no_access',
    af.MODEL_NOT_FOUND: 'not_in_region',
    af.THROTTLED: 'throttled',
    af.REGION_UNAVAILABLE: 'unavailable',
    af.VALIDATION: 'error',
    af.ERROR: 'error',
}


class ImageModelInfo(TypedDict):
    id: str
    label: str
    region: str
    avatars_enabled: bool


class ImageAccess(TypedDict):
    status: AccessStatus
    agreement: str
    authorization: str
    entitlement: str
    region_availability: str
    checked_at: str


class ImageCapacity(ImageModelInfo):
    access: ImageAccess
    quota: ImageQuota | None
    quota_state: QuotaState


# Per container, model id -> (access, expires at). Tests clear it directly.
_access_cache: dict[str, tuple[ImageAccess, float]] = {}


def image_model_info() -> ImageModelInfo:
    """The configured image model, its product name, region and whether avatars are on."""
    config = get_image_model_config()
    model_id = str(config['model_id'])
    return {
        'id': model_id,
        'label': IMAGE_MODEL_LABELS.get(model_id, model_id),
        'region': str(config['region']),
        'avatars_enabled': avatars_enabled(),
    }


# Our field name -> the GetFoundationModelAvailability field it is read from (a plain string there).
_AVAILABILITY_FIELDS: Final = {
    'authorization': 'authorizationStatus',
    'entitlement': 'entitlementAvailability',
    'region_availability': 'regionAvailability',
}


def _availability_fields(availability: dict) -> dict[str, str]:
    """The four GetFoundationModelAvailability fields as plain strings ('' when absent)."""
    agreement = availability.get('agreementAvailability')
    fields = {'agreement': str(agreement.get('status', '')) if isinstance(agreement, dict) else ''}
    fields.update((ours, str(availability.get(theirs, ''))) for ours, theirs in _AVAILABILITY_FIELDS.items())
    return fields


def access_status(availability: dict) -> AccessStatus:
    """Map a GetFoundationModelAvailability answer to the access vocabulary (region first, then IAM, then EULA)."""
    fields = _availability_fields(availability)
    if fields['region_availability'] == 'NOT_AVAILABLE':
        return 'not_in_region'
    if fields['authorization'] == 'NOT_AUTHORIZED':
        return 'no_access'
    if fields['agreement'] not in ('', 'AVAILABLE') or fields['entitlement'] == 'NOT_AVAILABLE':
        return 'not_subscribed'
    if fields['region_availability'] == 'AVAILABLE' and fields['authorization'] == 'AUTHORIZED':
        return 'available'
    return 'unknown'


def _access_record(status: AccessStatus, availability: dict) -> ImageAccess:
    fields = _availability_fields(availability)
    entitlement, region_availability = fields['entitlement'], fields['region_availability']
    return {
        'status': status,
        'agreement': fields['agreement'],
        'authorization': fields['authorization'],
        'entitlement': entitlement,
        'region_availability': region_availability,
        'checked_at': now_iso(),
    }


@lru_cache(maxsize=4)
def _client(service: Literal['bedrock', 'bedrock-runtime'], region: str) -> Any:
    """One client per (service, region) per container: ``bedrock`` (control plane) or ``bedrock-runtime``."""
    config = _PROBE_CONFIG if service == 'bedrock-runtime' else _CONTROL_CONFIG
    return boto3.client(service, region_name=region, config=config)


def prime_control_client(region: str) -> None:
    """Create the cached control-plane client before threads share it (``boto3.client`` is not
    thread-safe to create; the cached client is safe to use from several threads)."""
    _client('bedrock', region)


def image_access(model_id: str, region: str) -> ImageAccess:
    """The account's access to the image model in its region (cached 5 minutes). Never raises."""
    cached = _access_cache.get(model_id)
    if cached is not None and time.time() < cached[1]:
        return cached[0]
    try:
        availability = _client('bedrock', region).get_foundation_model_availability(modelId=model_id)
    except (ClientError, BotoCoreError) as error:
        logger.warning('Image model availability unreadable', extra={
            'model_id': model_id, 'region': region, 'error_code': af.aws_error_code(error)})
        return _access_record('unknown', {})
    record = _access_record(access_status(availability), availability)
    _access_cache[model_id] = (record, time.time() + ACCESS_CACHE_SECONDS)
    return record


def image_capacity() -> ImageCapacity:
    """Everything the image row shows: model, region, access and quota (no image call)."""
    info = image_model_info()
    reading = image_quota(info['id'], info['region'], info['label'])
    quota_state = reading['state']
    return {
        'id': info['id'],
        'label': info['label'],
        'region': info['region'],
        'avatars_enabled': info['avatars_enabled'],
        'access': image_access(info['id'], info['region']),
        'quota': reading['quota'],
        'quota_state': quota_state,
    }


def _probe_status(error: BaseException) -> str:
    return _REASON_STATUS.get(af.classify_avatar_error(error), 'error')


def _invoke_probe(model_id: str, region: str, output_format: str) -> tuple[str, str | None]:
    """One minimal image call; (status, error code). The image itself is discarded."""
    client = _client('bedrock-runtime', region)
    body = {'prompt': PROBE_PROMPT, 'mode': 'text-to-image', 'aspect_ratio': '1:1',
            'output_format': output_format, 'seed': PROBE_SEED}
    try:
        response = client.invoke_model(modelId=model_id, body=json.dumps(body))
        result = json.loads(response['body'].read())
    except (ClientError, BotoCoreError) as error:
        return _probe_status(error), af.aws_error_code(error)
    except ValueError:
        return 'error', 'InvalidResponse'
    return ('available', None) if _model_answered(result) else ('error', 'NoImageReturned')


def _model_answered(result: object) -> bool:
    """An image, or a content-filter finish reason (the model answered; the image was withheld)."""
    if not isinstance(result, dict):
        return False
    return bool(result.get('images')) or 'filter' in str(result.get('finish_reasons', '')).lower()


def probe_image_model() -> ProbeResult:
    """Send ONE minimal request to the image model and classify it like a text-model test."""
    config = get_image_model_config()
    model_id, region = str(config['model_id']), str(config['region'])
    started = time.monotonic()
    status, code = _invoke_probe(model_id, region, str(config['output_format']))
    latency_ms = round((time.monotonic() - started) * 1000)
    logger.info('Image model test finished', extra={
        'model_id': model_id, 'region': region, 'status': status, 'error_code': code, 'latency_ms': latency_ms})
    message = STATUS_MESSAGES[status]
    return {
        'model_id': model_id,
        'invoked_id': model_id,
        'status': status,
        'ok': status == 'available',
        'latency_ms': latency_ms if status == 'available' else None,
        'message': f'{message} ({code})' if code else message,
        # The token-quota field of a text-model test; the image quota is on the capacity row.
        'quota': None,
        'checked_at': now_iso(),
    }
