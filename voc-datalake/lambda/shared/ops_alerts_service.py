"""The Settings → Logs → Alerts operations, over the aggregates table, CloudWatch and SNS.

The routes live in ``api/logs_handler.py`` (admin-only, every one); this module
holds what they do so the handler stays a thin router and the logic is testable
with plain stubs. Alarm definitions and the email check are in ``shared/ops_alerts``.

State: the ``SETTINGS#alerts`` / ``config`` row records whether an admin turned
alerting on, who and when, and the ARN of each subscription still awaiting
confirmation (SNS lists a pending one only as ``PendingConfirmation``, so the
ARN returned at subscribe time is the only handle that can cancel it). When the
row is missing, the alarms themselves say whether alerting is on.

Addresses are never logged: they are personal data, and the log group is
readable by more people than this admin-only page.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from shared.exceptions import ConflictError, NotFoundError, ValidationError
from shared.ops_alerts import (
    ALERTS_SETTINGS_KEY,
    MAX_SUBSCRIBERS,
    PENDING_CONFIRMATION,
    AlertTargets,
    alarm_definitions,
    billed_metric_count,
    disable_alarms,
    email_subscriptions,
    enable_alarms,
    normalize_email,
    owned_alarms,
    subscribe,
    subscriber_view,
    unsubscribe,
)


def _settings_row(table: Any) -> dict:
    item = table.get_item(Key=ALERTS_SETTINGS_KEY).get('Item')
    return item if isinstance(item, dict) else {}


def _pending_arns(row: dict) -> dict[str, str]:
    raw = row.get('pending')
    if not isinstance(raw, dict):
        return {}
    return {str(email): str(arn) for email, arn in raw.items() if isinstance(arn, str) and arn}


def _save_pending(table: Any, pending: dict[str, str]) -> None:
    table.update_item(
        Key=ALERTS_SETTINGS_KEY,
        UpdateExpression='SET #pending = :pending',
        ExpressionAttributeNames={'#pending': 'pending'},
        ExpressionAttributeValues={':pending': pending},
    )


def unconfigured_status() -> dict:
    """The answer on a deployment whose Lambda carries no alert targets."""
    return {'configured': False, 'enabled': False, 'alarms': [], 'subscribers': [],
            'expected_alarm_count': 0, 'billed_metric_count': 0, 'max_subscribers': MAX_SUBSCRIBERS}


def alerts_status(table: Any, cloudwatch: Any, sns: Any, targets: AlertTargets) -> dict:
    """On/off, the alarms present (name + state), what turning on would create, and the recipients."""
    row = _settings_row(table)
    alarms = owned_alarms(cloudwatch, targets)
    stored = row.get('enabled')
    enabled = stored if isinstance(stored, bool) else bool(alarms)
    definitions = alarm_definitions(targets)
    return {
        'configured': True,
        'enabled': enabled,
        'updated_at': row.get('updated_at'),
        'updated_by': row.get('updated_by'),
        'alarms': [{'name': alarm['name'], 'state': alarm['state']} for alarm in alarms],
        'expected_alarm_count': len(definitions),
        'billed_metric_count': billed_metric_count(definitions),
        'subscribers': subscriber_view(email_subscriptions(sns, targets.topic_arn)),
        'max_subscribers': MAX_SUBSCRIBERS,
    }


def set_alerting(table: Any, cloudwatch: Any, targets: AlertTargets, body: dict, actor: str) -> dict:
    """Turn alerting on (create every alarm, idempotently) or off (delete every owned alarm)."""
    enabled = body.get('enabled')
    if not isinstance(enabled, bool):
        raise ValidationError('enabled must be true or false')
    count = enable_alarms(cloudwatch, targets) if enabled else disable_alarms(cloudwatch, targets)
    now = datetime.now(UTC).isoformat()
    table.update_item(
        Key=ALERTS_SETTINGS_KEY,
        UpdateExpression='SET #enabled = :enabled, #at = :at, #by = :by',
        ExpressionAttributeNames={'#enabled': 'enabled', '#at': 'updated_at', '#by': 'updated_by'},
        ExpressionAttributeValues={':enabled': enabled, ':at': now, ':by': actor},
    )
    return {'success': True, 'enabled': enabled, 'alarm_count': count if enabled else 0,
            'deleted_count': 0 if enabled else count, 'updated_at': now}


def add_recipient(table: Any, sns: Any, targets: AlertTargets, body: dict) -> dict:
    """Subscribe an address (SNS mails it a confirmation link); re-sends the link for a pending one."""
    email = normalize_email(body.get('email'))
    current = subscriber_view(email_subscriptions(sns, targets.topic_arn))
    existing = next((sub for sub in current if sub['email'] == email), None)
    if existing and existing['status'] == 'confirmed':
        return {'success': True, 'email': email, 'status': 'confirmed'}
    if existing is None and len(current) >= MAX_SUBSCRIBERS:
        raise ValidationError(f'at most {MAX_SUBSCRIBERS} recipients')
    arn = subscribe(sns, targets.topic_arn, email)
    if arn and arn != PENDING_CONFIRMATION:
        pending = _pending_arns(_settings_row(table))
        pending[email] = arn
        _save_pending(table, pending)
    return {'success': True, 'email': email, 'status': 'pending'}


def remove_recipient(table: Any, sns: Any, targets: AlertTargets, body: dict) -> dict:
    """Unsubscribe an address, confirmed or (when its ARN was recorded) still pending."""
    email = normalize_email(body.get('email'))
    matches = [sub for sub in email_subscriptions(sns, targets.topic_arn) if sub['email'] == email]
    if not matches:
        raise NotFoundError('recipient not found')
    pending = _pending_arns(_settings_row(table))
    arns = {sub['arn'] for sub in matches if sub['arn'] != PENDING_CONFIRMATION}
    if any(sub['arn'] == PENDING_CONFIRMATION for sub in matches):
        recorded = pending.get(email)
        if not recorded:
            raise ConflictError('this recipient has not confirmed yet and cannot be cancelled; '
                                'SNS deletes an unconfirmed subscription on its own')
        arns.add(recorded)
    for arn in sorted(arns):
        unsubscribe(sns, arn)
    if email in pending:
        del pending[email]
        _save_pending(table, pending)
    return {'success': True, 'email': email}
