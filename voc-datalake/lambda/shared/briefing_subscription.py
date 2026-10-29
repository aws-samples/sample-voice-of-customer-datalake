"""The brief's email subscription and the subscriber index (settings API only).

One SNS topic, ``voc-briefing-<acct>-<region>`` (KMS), one EMAIL subscription per
user with the filter policy ``{"sub": [<sub>]}``: every message the worker publishes
carries a ``sub`` attribute, so each person receives only their own brief.

The endpoint is ALWAYS the caller's own verified Cognito email, read here with
``AdminGetUser`` — never an address from the request — so the widget cannot be
used to mail a third party. AWS sends the confirmation email; until the user
confirms, the status is ``pending`` (``GetSubscriptionAttributes``).

The address itself is never stored: the row keeps the subscription ARN and a
hash of the endpoint (to notice a changed Cognito email on the next save).
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared import briefing_prefs as prefs
from shared import briefing_store as store
from shared.digests import sha256_hex
from shared.exceptions import ConfigurationError, ServiceError, ValidationError
from shared.logging import logger
from shared.project_access import Caller

ORIGIN_ENV: Final = 'ALLOWED_ORIGIN'

_clients: dict[str, Any] = {}


def _sns() -> Any:
    if 'sns' not in _clients:
        _clients['sns'] = boto3.client('sns')
    return _clients['sns']


def _cognito() -> Any:
    if 'cognito' not in _clients:
        _clients['cognito'] = boto3.client('cognito-idp')
    return _clients['cognito']


def _topic_arn() -> str:
    arn = os.environ.get(store.TOPIC_ENV, '')
    if not arn:
        raise ConfigurationError('Brief email is not configured')
    return arn


def site_url() -> str:
    """The SPA's origin (the API's CORS origin); '' in a dev deployment (``*``)."""
    origin = os.environ.get(ORIGIN_ENV, '')
    return origin if origin.startswith('https://') else ''


def endpoint_hash(email: str) -> str:
    return sha256_hex(email.strip().lower())


def verified_email(username: str, sub: str) -> str:
    """The caller's own verified Cognito email; 400 when the account has none."""
    pool = os.environ.get(store.USER_POOL_ENV, '')
    if not pool or not username:
        raise ConfigurationError('User directory is not configured')
    try:
        user = _cognito().admin_get_user(UserPoolId=pool, Username=username)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Brief email: user lookup failed')
        raise ServiceError('Could not read your account. Please retry.') from exc
    attributes = {a.get('Name'): a.get('Value') for a in user.get('UserAttributes', []) if isinstance(a, dict)}
    email = attributes.get('email')
    if attributes.get('sub') != sub or not isinstance(email, str) or not email:
        raise ValidationError('Your account has no email address to send the brief to')
    if attributes.get('email_verified') != 'true':
        raise ValidationError('Verify your email address before turning on the brief email')
    return email


def _subscribe(sub: str, email: str) -> str:
    try:
        response = _sns().subscribe(
            TopicArn=_topic_arn(), Protocol='email', Endpoint=email,
            Attributes={'FilterPolicy': json.dumps({'sub': [sub]})},
            ReturnSubscriptionArn=True,
        )
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Brief email: subscribe failed')
        raise ServiceError('Could not subscribe your email. Please retry.') from exc
    return str(response.get('SubscriptionArn') or '')


#: SNS answers these while a subscription is still pending confirmation or is already gone: the
#: expected outcome of turning email off before the AWS confirmation mail was clicked.
_EXPECTED_UNSUBSCRIBE_CODES = frozenset({'InvalidParameter', 'NotFound'})


def unsubscribe(arn: object) -> None:
    """Best effort: a pending subscription cannot be removed until it is confirmed,
    and no brief is published to a user whose email setting is off anyway."""
    if not isinstance(arn, str) or not arn.startswith('arn:'):
        return
    try:
        _sns().unsubscribe(SubscriptionArn=arn)
    except ClientError as exc:
        code = str(exc.response.get('Error', {}).get('Code') or '')
        if code in _EXPECTED_UNSUBSCRIBE_CODES:
            logger.info('Brief email: subscription still pending or already gone', extra={'error_code': code})
        else:
            logger.warning('Brief email: unsubscribe failed', extra={'error_code': code})
    except BotoCoreError as exc:
        logger.warning('Brief email: unsubscribe failed', extra={'error_type': type(exc).__name__})


def confirmation_status(arn: str) -> str | None:
    """``pending`` / ``confirmed``, or None when the subscription no longer exists."""
    try:
        attributes = _sns().get_subscription_attributes(SubscriptionArn=arn).get('Attributes') or {}
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'NotFound':
            return None
        logger.warning('Brief email: status read failed')
        return prefs.EMAIL_PENDING
    except BotoCoreError:
        return prefs.EMAIL_PENDING
    return prefs.EMAIL_PENDING if attributes.get('PendingConfirmation') == 'true' else prefs.EMAIL_CONFIRMED


def _email_fields(row: Mapping[str, Any], wanted: Mapping[str, Any], caller: Caller) -> dict[str, Any]:
    """``subscription_arn`` / ``endpoint_hash`` / ``email_status`` after this save."""
    stored_arn = row.get('subscription_arn')
    if not (wanted['enabled'] and wanted['email']):
        unsubscribe(stored_arn)
        return {'subscription_arn': None, 'endpoint_hash': None, 'email_status': prefs.EMAIL_OFF}
    email = verified_email(caller.username, caller.subject)
    if stored_arn and row.get('endpoint_hash') == endpoint_hash(email):
        return {key: row.get(key) for key in ('subscription_arn', 'endpoint_hash', 'email_status')}
    unsubscribe(stored_arn)
    arn = _subscribe(caller.subject, email)
    return {'subscription_arn': arn, 'endpoint_hash': endpoint_hash(email), 'email_status': prefs.EMAIL_PENDING}


def _sync_subscriber_index(table: Any, caller: Caller, wanted: Mapping[str, Any]) -> None:
    """The dispatcher's row exists exactly while the scheduled brief is on."""
    key = store.subscriber_key(caller.subject)
    if not wanted['enabled']:
        table.delete_item(Key=key)
        return
    table.update_item(
        Key=key,
        UpdateExpression='SET #sub = :sub, username = :username, #hour = :hour, time_zone = :zone, site_url = :site',
        ExpressionAttributeNames={'#sub': 'sub', '#hour': 'hour'},
        ExpressionAttributeValues={':sub': caller.subject, ':username': caller.username, ':hour': wanted['hour'],
                                   ':zone': wanted['time_zone'], ':site': site_url()},
    )


def _without_none(item: Mapping[str, Any]) -> dict[str, Any]:
    """DynamoDB would store a None as NULL; an absent attribute reads the same and stays clean."""
    return {key: value for key, value in item.items() if value is not None}


def get_preferences(table: Any, sub: str) -> dict[str, Any]:
    """The caller's preferences; a pending email subscription is re-checked with SNS."""
    row = table.get_item(Key=prefs.preferences_key(sub)).get('Item')
    if isinstance(row, dict) and row.get('subscription_arn') and row.get('email_status') == prefs.EMAIL_PENDING:
        status = confirmation_status(str(row['subscription_arn']))
        if status != prefs.EMAIL_PENDING:
            # Confirmed, or deleted (the user used the email's unsubscribe link).
            changes = ({'email_status': status} if status else
                       {'email_status': prefs.EMAIL_OFF, 'subscription_arn': None, 'email': False})
            row = _without_none({**row, **changes})
            table.put_item(Item=row)
    return prefs.preferences_view(row)


def put_preferences(table: Any, caller: Caller, changes: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """Apply validated ``changes`` for ``caller`` (a ``project_access.Caller``) and return the view."""
    row = table.get_item(Key=prefs.preferences_key(caller.subject)).get('Item') or {}
    wanted = prefs.merged(row, changes)
    email = _email_fields(row, wanted, caller)
    item = {**prefs.preferences_key(caller.subject), **wanted, **email, 'username': caller.username,
            'updated_at': now.isoformat()}
    table.put_item(Item=_without_none(item))
    _sync_subscriber_index(table, caller, wanted)
    return prefs.preferences_view(item)
