"""A Bedrock model's access in this account and region, from ``bedrock:GetFoundationModelAvailability``: the one
mapping of its answer to the access vocabulary, shared by Administration -> AI models (``image_model_status.py``,
``model_agreements.py``) and the engineering readiness checks (``engineering/readiness_aws.py``, 7.50.00). Pure: no
client, no import beyond the standard library, so a Lambda that reads access needs no other module's dependencies.
"""
from __future__ import annotations

from typing import Final, Literal

AccessStatus = Literal['available', 'no_access', 'not_subscribed', 'not_in_region', 'unknown']

# Our field name -> the GetFoundationModelAvailability field it is read from (a plain string there).
_AVAILABILITY_FIELDS: Final = {
    'authorization': 'authorizationStatus',
    'entitlement': 'entitlementAvailability',
    'region_availability': 'regionAvailability',
}


def availability_fields(availability: dict) -> dict[str, str]:
    """The four GetFoundationModelAvailability fields as plain strings ('' when absent)."""
    agreement = availability.get('agreementAvailability')
    fields = {'agreement': str(agreement.get('status', '')) if isinstance(agreement, dict) else ''}
    fields.update((ours, str(availability.get(theirs, ''))) for ours, theirs in _AVAILABILITY_FIELDS.items())
    return fields


def access_status(availability: dict) -> AccessStatus:
    """Map a GetFoundationModelAvailability answer to the access vocabulary (region first, then IAM, then EULA)."""
    fields = availability_fields(availability)
    if fields['region_availability'] == 'NOT_AVAILABLE':
        return 'not_in_region'
    if fields['authorization'] == 'NOT_AUTHORIZED':
        return 'no_access'
    if fields['agreement'] not in ('', 'AVAILABLE') or fields['entitlement'] == 'NOT_AVAILABLE':
        return 'not_subscribed'
    if fields['region_availability'] == 'AVAILABLE' and fields['authorization'] == 'AUTHORIZED':
        return 'available'
    return 'unknown'
