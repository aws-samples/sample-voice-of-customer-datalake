"""Why a persona avatar was not generated, in words an admin can act on.

``shared.avatar.generate_persona_avatar`` degrades every failure to "no avatar"
(the persona is still saved). Without a reason the only evidence was an ERROR line
whose wording differed per branch, and the regenerate-avatar job answered a bare
"Avatar generation failed". This module turns the failure into:

* one ``reason`` from a fixed set (``AVATAR_FAILURE_REASONS``),
* the AWS error code (``AccessDeniedException``, ...), the model id and its region,
* a plain-language ``message`` the regenerate job shows the user, and
* exactly ONE ERROR log line carrying all of the above — the line Administration →
  System → Logs lists, so a developer without AWS access can read the cause there.

The ERROR line never carries the persona's name, bio or image prompt (PII); the
persona id is an opaque key and is logged.

Kept free of boto3/botocore imports (exceptions are recognised by their
``response['Error']['Code']`` and type name), like the rest of the avatar module's
narrow import graph.
"""
from __future__ import annotations

from typing import Final, TypedDict

from shared.exceptions import ApiError
from shared.logging import logger

NO_ACCESS: Final = 'no_access'
MODEL_NOT_FOUND: Final = 'model_not_found'
THROTTLED: Final = 'throttled'
CONTENT_FILTERED: Final = 'content_filtered'
VALIDATION: Final = 'validation'
REGION_UNAVAILABLE: Final = 'region_unavailable'
DISABLED: Final = 'disabled'
NOT_CONFIGURED: Final = 'not_configured'
ERROR: Final = 'error'

AVATAR_FAILURE_REASONS: Final = (
    NO_ACCESS, MODEL_NOT_FOUND, THROTTLED, CONTENT_FILTERED, VALIDATION,
    REGION_UNAVAILABLE, DISABLED, NOT_CONFIGURED, ERROR,
)

# How much of the AWS error text the ERROR line keeps. AWS messages name the role and
# the model ARN, never the request body, so they are safe to log; the cap keeps a
# chatty one from crowding the System errors sample.
MAX_AWS_MESSAGE_CHARS: Final = 500

_ACCESS_CODES: Final = frozenset({
    'AccessDeniedException', 'AccessDenied', 'UnrecognizedClientException',
    'ExpiredTokenException', 'NotAuthorized',
})
_THROTTLE_CODES: Final = frozenset({
    'ThrottlingException', 'TooManyRequestsException', 'ServiceQuotaExceededException',
    'ModelNotReadyException', 'ServiceUnavailableException',
})
_NOT_FOUND_CODES: Final = frozenset({'ResourceNotFoundException', 'ModelNotFoundException'})
# botocore's connection errors: the regional endpoint cannot be reached at all.
_REGION_TYPES: Final = frozenset({
    'EndpointConnectionError', 'UnknownEndpointError', 'NoRegionError', 'ConnectTimeoutError',
})


class AvatarFailure(TypedDict):
    """The ``failure`` key of a failed ``generate_persona_avatar`` answer."""

    reason: str
    message: str
    model_id: str
    region: str
    error_code: str


class AvatarGenerationFailed(ApiError):
    """The regenerate-avatar job failed for a reason the user can be told.

    424 (Failed Dependency: the image model, not the request, failed) so the assist
    worker records THIS message as the job's ``error`` — it shows a 4xx's own text and
    replaces anything else with the kind's generic label (``shared/assist_jobs.py``).
    The message holds only the model id, its region, the AWS error code and advice.
    """

    status_code = 424


def _error_field(error: BaseException, field: str) -> str:
    """``response['Error'][field]`` of a botocore ``ClientError`` (``''`` when absent)."""
    response = getattr(error, 'response', None)
    details = response.get('Error') if isinstance(response, dict) else None
    value = details.get(field) if isinstance(details, dict) else None
    return value if isinstance(value, str) else ''


def aws_error_code(error: BaseException) -> str:
    """The AWS error code of a botocore ``ClientError``, else the exception's type name."""
    return _error_field(error, 'Code') or type(error).__name__


def aws_error_message(error: BaseException) -> str:
    """The AWS error text (else ``str(error)``), capped for the ERROR line's ``aws_message``."""
    return (_error_field(error, 'Message') or str(error))[:MAX_AWS_MESSAGE_CHARS]


def _classify_validation(text: str) -> str:
    lowered = text.lower()
    if 'filter' in lowered or 'moderation' in lowered or 'content polic' in lowered:
        return CONTENT_FILTERED
    if 'region' in lowered and ('not supported' in lowered or 'not available' in lowered):
        return REGION_UNAVAILABLE
    if 'model identifier is invalid' in lowered or 'end of its life' in lowered or 'legacy' in lowered:
        return MODEL_NOT_FOUND
    return VALIDATION


def classify_avatar_error(error: BaseException) -> str:
    """The reason an image-model call raised, one of ``AVATAR_FAILURE_REASONS``.

    Recognised by the AWS error code first, then by the exception's type name and text
    (a wrapped error may only carry the code in its message).
    """
    code = aws_error_code(error)
    text = f'{code} {type(error).__name__} {error}'
    if code in _ACCESS_CODES or 'AccessDenied' in text or 'aws-marketplace' in text:
        return NO_ACCESS
    if code in _THROTTLE_CODES or 'Throttling' in text:
        return THROTTLED
    if code in _NOT_FOUND_CODES or 'ResourceNotFound' in text:
        return MODEL_NOT_FOUND
    if type(error).__name__ in _REGION_TYPES or code in _REGION_TYPES:
        return REGION_UNAVAILABLE
    if 'ValidationException' in text:
        return _classify_validation(aws_error_message(error))
    return ERROR


_MESSAGES: Final = {
    NO_ACCESS: ('the image model {model} is not enabled in {region} for this account, or the role may not '
                'invoke it ({code}). Marketplace models such as Stability need aws-marketplace:ViewSubscriptions '
                '+ Subscribe on first use, and the model must be granted in the Bedrock console'),
    MODEL_NOT_FOUND: ('the image model {model} was not found in {region} ({code}). It may be retired or legacy '
                      '(access is lost after 15+ idle days or past its end-of-life date); choose an active '
                      'image model in avatar-generation.json'),
    THROTTLED: ('the image model {model} in {region} is throttling requests or over its quota ({code}). '
                'Try again in a few minutes'),
    CONTENT_FILTERED: ('the image model {model} filtered the image for this persona ({code}). Edit the persona '
                       'description and try again'),
    VALIDATION: ('the image model {model} in {region} rejected the request as invalid ({code}). Stability models '
                 'take prompt/mode/aspect_ratio/output_format; another vendor needs its own request body'),
    REGION_UNAVAILABLE: 'the image model {model} cannot be reached in {region} ({code})',
    DISABLED: 'avatars are switched off for this deployment (AVATARS_ENABLED=false)',
    NOT_CONFIGURED: 'no avatar bucket is configured for this function (RAW_DATA_BUCKET is empty)',
    ERROR: 'unexpected error from the image model {model} in {region} ({code})',
}


_UPLOAD_MESSAGE: Final = 'the image was generated by {model} but storing it in the raw data bucket failed ({code})'


def avatar_failure(
    reason: str, *, model_id: str = '', region: str = '', error_code: str = '', template: str | None = None,
) -> AvatarFailure:
    """The failure record, its ``message`` in plain words (no leading "Avatar generation failed").

    *template* overrides the reason's own wording (the upload stage uses it).
    """
    reason = reason if reason in AVATAR_FAILURE_REASONS else ERROR
    wording = template or _MESSAGES[reason]
    message = wording.format(model=model_id or 'unknown', region=region or 'unknown', code=error_code or reason)
    return {'reason': reason, 'message': message, 'model_id': model_id, 'region': region,
            'error_code': error_code or reason}


def log_avatar_failure(
    failure: AvatarFailure, *, persona_id: str, stage: str, aws_message: str = '', exc_info: bool = False,
) -> None:
    """Write the ONE ERROR line of a failed avatar (no persona name, bio or prompt)."""
    logger.error(
        f"[PERSONA_AVATAR] Avatar generation failed ({failure['reason']}, {failure['error_code']}): "
        f"{failure['message']}",
        extra={
            'persona_id': persona_id,
            'avatar_failure_reason': failure['reason'],
            'error_code': failure['error_code'],
            'model_id': failure['model_id'],
            'region': failure['region'],
            'stage': stage,
            'aws_message': aws_message[:MAX_AWS_MESSAGE_CHARS],
        },
        exc_info=exc_info,
    )


def failure_from_exception(error: BaseException, *, model_id: str, region: str, stage: str) -> AvatarFailure:
    """Classify *error* raised at *stage* (``invoke`` or ``upload``) into a failure record.

    An upload failure is the raw bucket's, not the model's: it is never read as a model
    access problem (an S3 AccessDenied would otherwise say "the image model is not enabled").
    """
    code = aws_error_code(error)
    if stage == 'upload':
        return avatar_failure(ERROR, model_id=model_id, region=region, error_code=code, template=_UPLOAD_MESSAGE)
    return avatar_failure(classify_avatar_error(error), model_id=model_id, region=region, error_code=code)

