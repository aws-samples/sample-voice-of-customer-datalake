"""Operational alerts: the CloudWatch alarms and email recipients behind Settings → Logs → Alerts.

No alarm exists, and none costs anything, until an admin turns alerting on. The
SNS topic they notify (``voc-ops-alarms-…``, VocCoreStack) is deployed by CDK
because a topic has no fixed cost; the alarms are created here at runtime with
``PutMetricAlarm`` and deleted with ``DeleteAlarms``.

Every alarm this module owns is named ``<OPS_ALERTS_ALARM_PREFIX>-<slug>``. The
prefix is the deployment's ``uniqueName('voc-alerts')`` and belongs to this
feature alone, so the Lambda's IAM grant is scoped to
``alarm:<prefix>-*`` and "turn off" deletes everything under it — including an
alarm whose target has since gone (a plugin disabled at the next deploy).

What is alarmed, and from where, comes from CDK as environment variables:

* ``OPS_ALERTS_QUEUES`` — ``slug=queueName`` pairs, comma-separated: every
  dead-letter / failure queue. Alarm: Max(ApproximateNumberOfMessagesVisible) > 0
  over one 5-minute period (the shape CDK used to deploy unconditionally).
* ``OPS_ALERTS_PROCESSOR_FUNCTION`` / ``OPS_ALERTS_AGGREGATOR_FUNCTION`` — Lambda
  ``Errors`` > 0 over 5 minutes; the aggregator also alarms on ``IteratorAge``
  (its DynamoDB stream falling more than 15 minutes behind for 15 minutes).
* ``OPS_ALERTS_INGESTOR_FUNCTIONS`` — every enabled plugin ingestor; ONE metric
  math alarm SUMs their ``Errors`` (CloudWatch allows 10 metrics per alarm, so
  more ingestors than that split into further alarms). A math alarm is billed
  per metric, exactly like one alarm per ingestor, but notifies once.
"""
from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.exceptions import ValidationError

ALERTS_SETTINGS_KEY: Final = {'pk': 'SETTINGS#alerts', 'sk': 'config'}
MAX_SUBSCRIBERS: Final = 10
MAX_EMAIL_LENGTH: Final = 254
# SNS lists an unconfirmed subscription with this in place of its ARN.
PENDING_CONFIRMATION: Final = 'PendingConfirmation'

PERIOD_SECONDS: Final = 300
ITERATOR_AGE_THRESHOLD_MS: Final = 15 * 60 * 1000
ITERATOR_AGE_PERIODS: Final = 3
MAX_METRICS_PER_ALARM: Final = 10
DELETE_BATCH: Final = 100

# Deliberately simple and linear (every repetition is bounded or separated by a
# literal): a local part, one `@`, then two or more dot-separated domain labels.
# SNS sends the recipient a confirmation mail, which is the real check.
_EMAIL: Final = re.compile(r'[a-z0-9._%+\-]{1,64}@[a-z0-9\-]{1,63}(?:\.[a-z0-9\-]{1,63})+')

# Breach on any non-zero datapoint in a single 5-minute period.
_ANY_IN_ONE_PERIOD: Final = {'Threshold': 0, 'EvaluationPeriods': 1, 'DatapointsToAlarm': 1}

_QUEUE_DESCRIPTION: Final = (
    'This failure queue holds failed or rejected messages. Inspect them in the SQS console '
    '(Send and receive messages > Poll), fix the cause, then re-drive or purge.'
)


@dataclass(frozen=True)
class AlertTargets:
    """What this deployment alarms on, read from the Lambda environment."""

    topic_arn: str
    alarm_prefix: str
    queues: tuple[tuple[str, str], ...]
    processor_function: str
    aggregator_function: str
    ingestor_functions: tuple[str, ...]


def _csv(raw: str | None) -> list[str]:
    return [part.strip() for part in (raw or '').split(',') if part.strip()]


def _queue_pairs(raw: str | None) -> tuple[tuple[str, str], ...]:
    pairs = []
    for entry in _csv(raw):
        slug, sep, queue = entry.partition('=')
        if sep and slug.strip() and queue.strip():
            pairs.append((slug.strip(), queue.strip()))
    return tuple(pairs)


def load_targets(env: Mapping[str, str] | None = None) -> AlertTargets | None:
    """The deployment's alert targets, or None when CDK did not configure alerting."""
    source = os.environ if env is None else env
    topic_arn = source.get('OPS_ALERTS_TOPIC_ARN', '').strip()
    alarm_prefix = source.get('OPS_ALERTS_ALARM_PREFIX', '').strip()
    if not topic_arn or not alarm_prefix:
        return None
    return AlertTargets(
        topic_arn=topic_arn,
        alarm_prefix=alarm_prefix,
        queues=_queue_pairs(source.get('OPS_ALERTS_QUEUES')),
        processor_function=source.get('OPS_ALERTS_PROCESSOR_FUNCTION', '').strip(),
        aggregator_function=source.get('OPS_ALERTS_AGGREGATOR_FUNCTION', '').strip(),
        ingestor_functions=tuple(_csv(source.get('OPS_ALERTS_INGESTOR_FUNCTIONS'))),
    )


# ============================================
# Alarm definitions
# ============================================

def _base(targets: AlertTargets, slug: str, description: str) -> dict[str, Any]:
    return {
        'AlarmName': f'{targets.alarm_prefix}-{slug}',
        'AlarmDescription': description,
        'AlarmActions': [targets.topic_arn],
        'ComparisonOperator': 'GreaterThanThreshold',
        'TreatMissingData': 'notBreaching',
    }


def _single_metric(namespace: str, metric: str, dimension: tuple[str, str], statistic: str) -> dict[str, Any]:
    return {
        'Namespace': namespace,
        'MetricName': metric,
        'Dimensions': [{'Name': dimension[0], 'Value': dimension[1]}],
        'Period': PERIOD_SECONDS,
        'Statistic': statistic,
    }


def _queue_alarm(targets: AlertTargets, slug: str, queue: str) -> dict[str, Any]:
    return {
        **_base(targets, slug, _QUEUE_DESCRIPTION),
        **_single_metric('AWS/SQS', 'ApproximateNumberOfMessagesVisible', ('QueueName', queue), 'Maximum'),
        **_ANY_IN_ONE_PERIOD,
    }


def _errors_alarm(targets: AlertTargets, slug: str, function_name: str, label: str) -> dict[str, Any]:
    description = f'The {label} Lambda reported errors. Check its CloudWatch logs.'
    return {
        **_base(targets, slug, description),
        **_single_metric('AWS/Lambda', 'Errors', ('FunctionName', function_name), 'Sum'),
        **_ANY_IN_ONE_PERIOD,
    }


def _iterator_age_alarm(targets: AlertTargets, function_name: str) -> dict[str, Any]:
    description = ('The aggregator is more than 15 minutes behind the feedback stream; '
                   'dashboard metrics are stale until it catches up.')
    return {
        **_base(targets, 'aggregator-iterator-age', description),
        **_single_metric('AWS/Lambda', 'IteratorAge', ('FunctionName', function_name), 'Maximum'),
        'Threshold': ITERATOR_AGE_THRESHOLD_MS,
        'EvaluationPeriods': ITERATOR_AGE_PERIODS, 'DatapointsToAlarm': ITERATOR_AGE_PERIODS,
    }


def _ingestor_alarm(targets: AlertTargets, slug: str, functions: list[str]) -> dict[str, Any]:
    metrics: list[dict[str, Any]] = [{
        'Id': f'm{index}',
        'MetricStat': {
            'Metric': {'Namespace': 'AWS/Lambda', 'MetricName': 'Errors',
                       'Dimensions': [{'Name': 'FunctionName', 'Value': name}]},
            'Period': PERIOD_SECONDS,
            'Stat': 'Sum',
        },
        'ReturnData': False,
    } for index, name in enumerate(functions)]
    ids = ','.join(metric['Id'] for metric in metrics)
    metrics.append({'Id': 'total', 'Expression': f'SUM([{ids}])', 'Label': 'Ingestor errors', 'ReturnData': True})
    description = 'A data-source ingestor reported errors. Check Administration → System → Logs and the ingestor logs.'
    return {
        **_base(targets, slug, description),
        'Metrics': metrics,
        **_ANY_IN_ONE_PERIOD,
    }


def alarm_definitions(targets: AlertTargets) -> list[dict[str, Any]]:
    """Every alarm alerting creates, as ``PutMetricAlarm`` arguments."""
    alarms = [_queue_alarm(targets, slug, queue) for slug, queue in targets.queues]
    if targets.processor_function:
        alarms.append(_errors_alarm(targets, 'processor-errors', targets.processor_function, 'feedback processor'))
    if targets.aggregator_function:
        alarms.append(_errors_alarm(targets, 'aggregator-errors', targets.aggregator_function, 'aggregator'))
        alarms.append(_iterator_age_alarm(targets, targets.aggregator_function))
    ingestors = list(targets.ingestor_functions)
    for start in range(0, len(ingestors), MAX_METRICS_PER_ALARM):
        chunk = ingestors[start:start + MAX_METRICS_PER_ALARM]
        number = start // MAX_METRICS_PER_ALARM + 1
        alarms.append(_ingestor_alarm(targets, 'ingestor-errors' if number == 1 else f'ingestor-errors-{number}', chunk))
    return alarms


def billed_metric_count(definitions: Iterable[Mapping[str, Any]]) -> int:
    """Alarm metrics CloudWatch bills for: one per single-metric alarm, one per metric in a math alarm."""
    return sum(
        sum(1 for metric in definition['Metrics'] if 'MetricStat' in metric) if 'Metrics' in definition else 1
        for definition in definitions
    )


# ============================================
# Alarm lifecycle
# ============================================

def owned_alarms(cloudwatch: Any, targets: AlertTargets) -> list[dict[str, str]]:
    """Every metric alarm under this deployment's alert prefix: ``{name, state}``."""
    found: list[dict[str, str]] = []
    paginator = cloudwatch.get_paginator('describe_alarms')
    for page in paginator.paginate(AlarmNamePrefix=f'{targets.alarm_prefix}-', AlarmTypes=['MetricAlarm']):
        found.extend(
            {'name': alarm['AlarmName'], 'state': alarm.get('StateValue', 'INSUFFICIENT_DATA')}
            for alarm in page.get('MetricAlarms', [])
        )
    return found


def _delete(cloudwatch: Any, names: list[str]) -> None:
    for start in range(0, len(names), DELETE_BATCH):
        cloudwatch.delete_alarms(AlarmNames=names[start:start + DELETE_BATCH])


def enable_alarms(cloudwatch: Any, targets: AlertTargets) -> int:
    """Create (or overwrite) every alarm, then drop any owned alarm no longer defined; returns the count."""
    definitions = alarm_definitions(targets)
    for definition in definitions:
        cloudwatch.put_metric_alarm(**definition)
    wanted = {definition['AlarmName'] for definition in definitions}
    _delete(cloudwatch, [alarm['name'] for alarm in owned_alarms(cloudwatch, targets) if alarm['name'] not in wanted])
    return len(definitions)


def disable_alarms(cloudwatch: Any, targets: AlertTargets) -> int:
    """Delete every alarm under the alert prefix (and nothing else); returns how many."""
    names = [alarm['name'] for alarm in owned_alarms(cloudwatch, targets)]
    _delete(cloudwatch, names)
    return len(names)


# ============================================
# Email recipients
# ============================================

def normalize_email(raw: object) -> str:
    """A lower-cased, trimmed address, or ValidationError. Never echoes the value back."""
    if not isinstance(raw, str):
        raise ValidationError('email must be a string')
    email = raw.strip().lower()
    if not email or len(email) > MAX_EMAIL_LENGTH or not _EMAIL.fullmatch(email):
        raise ValidationError('email is not a valid address')
    return email


def email_subscriptions(sns: Any, topic_arn: str) -> list[dict[str, str]]:
    """The topic's email subscriptions: ``{email, arn}`` (arn is PendingConfirmation until confirmed)."""
    found: list[dict[str, str]] = []
    paginator = sns.get_paginator('list_subscriptions_by_topic')
    for page in paginator.paginate(TopicArn=topic_arn):
        found.extend(
            {'email': str(sub.get('Endpoint', '')).lower(), 'arn': str(sub.get('SubscriptionArn', ''))}
            for sub in page.get('Subscriptions', [])
            if sub.get('Protocol') == 'email'
        )
    return found


def subscriber_view(subscriptions: list[dict[str, str]]) -> list[dict[str, str]]:
    """What the admin page shows: address and status, sorted by address, one row per address."""
    by_email: dict[str, str] = {}
    for sub in subscriptions:
        status = 'pending' if sub['arn'] == PENDING_CONFIRMATION else 'confirmed'
        if by_email.get(sub['email']) != 'confirmed':
            by_email[sub['email']] = status
    return [{'email': email, 'status': status} for email, status in sorted(by_email.items())]


def subscribe(sns: Any, topic_arn: str, email: str) -> str:
    """Start an email subscription; SNS mails the recipient a confirmation link. Returns its ARN."""
    response = sns.subscribe(TopicArn=topic_arn, Protocol='email', Endpoint=email, ReturnSubscriptionArn=True)
    return str(response.get('SubscriptionArn', ''))


def unsubscribe(sns: Any, subscription_arn: str) -> None:
    """Remove one subscription (confirmed, or pending when its ARN was recorded at subscribe time)."""
    sns.unsubscribe(SubscriptionArn=subscription_arn)
