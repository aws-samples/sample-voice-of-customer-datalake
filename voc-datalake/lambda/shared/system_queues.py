"""`GET /logs/system/queues`: the deployment's dead-letter and failure queues, with a peek inside.

A message in one of these queues is work that failed for good: a feedback record the processor
gave up on, an EventBridge tick that never reached its ingestor, an async API job that died
before it could record its own failure (its body carries the Lambda's `errorMessage`). The queue
list is the one alerting watches (`OPS_ALERTS_QUEUES`, lib/stacks/dlq-alarms.ts).

For each queue: the message count, the age of the oldest message (CloudWatch
`ApproximateAgeOfOldestMessage`, omitted when CloudWatch has no point) and up to three bodies,
redacted and cut. The peek is a `ReceiveMessage` with `VisibilityTimeout=0`: nothing is
deleted and the messages stay visible, but each peek raises their receive count by one. These
queues have no further redrive, so that count moves nothing. Bodies are never logged.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger
from shared.ops_alerts import load_targets
from shared.pii_redaction import redact_text
from shared.system_log_groups import truncate
from shared.system_logs import aws_error_code

SAMPLE_SIZE: Final = 3
MAX_BODY_CHARS: Final = 2000
# Long polling, briefly: a short poll (0 s) asks only a sample of SQS's servers and often
# answers nothing for a queue holding one message. Only queues that hold messages are peeked.
PEEK_WAIT_SECONDS: Final = 1
AGE_WINDOW_MINUTES: Final = 30
AGE_PERIOD_SECONDS: Final = 300
UNREADABLE: Final = 'The queue could not be read.'
_COUNT_ATTRIBUTES: Final = ('ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible')


def configured_queues() -> tuple[tuple[str, str], ...]:
    """(short name, physical name) of every failure queue, as alerting knows them."""
    targets = load_targets()
    return targets.queues if targets is not None else ()


def _count(attributes: dict[str, str]) -> int:
    total = 0
    for name in _COUNT_ATTRIBUTES:
        value = attributes.get(name, '0')
        total += int(value) if str(value).isdigit() else 0
    return total


def _sample(sqs: Any, url: str) -> tuple[list[str], list[str]]:
    """(redacted bodies, their sent times) of up to three messages, left in the queue."""
    response = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=SAMPLE_SIZE, VisibilityTimeout=0,
                                   WaitTimeSeconds=PEEK_WAIT_SECONDS, AttributeNames=['SentTimestamp'])
    bodies, sent = [], []
    for message in response.get('Messages', []):
        bodies.append(truncate(redact_text(message.get('Body', '')).text, MAX_BODY_CHARS))
        stamp = (message.get('Attributes') or {}).get('SentTimestamp', '')
        sent.append(datetime.fromtimestamp(int(stamp) / 1000, UTC).isoformat() if stamp.isdigit() else '')
    return bodies, sent


def _read_queue(sqs: Any, slug: str, queue_name: str) -> dict[str, Any]:
    try:
        url = sqs.get_queue_url(QueueName=queue_name)['QueueUrl']
        attributes = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=list(_COUNT_ATTRIBUTES))
        messages = _count(attributes.get('Attributes') or {})
        bodies, sent = _sample(sqs, url) if messages > 0 else ([], [])
    except (ClientError, BotoCoreError) as error:
        logger.warning('Failure queue read failed', extra={'queue': slug, 'error_code': aws_error_code(error)})
        return {'name': slug, 'messages': None, 'sample': [], 'error': UNREADABLE}
    return {'name': slug, 'messages': messages, 'sample': bodies, 'sample_sent_at': sent}


def _oldest_ages(cloudwatch: Any, names: dict[str, str], now: datetime) -> dict[str, int]:
    """slug → the latest ApproximateAgeOfOldestMessage (s); {} when CloudWatch cannot say."""
    if not names:
        return {}
    queries = [{
        'Id': f'q{index}', 'ReturnData': True,
        'MetricStat': {'Metric': {'Namespace': 'AWS/SQS', 'MetricName': 'ApproximateAgeOfOldestMessage',
                                  'Dimensions': [{'Name': 'QueueName', 'Value': queue_name}]},
                       'Period': AGE_PERIOD_SECONDS, 'Stat': 'Maximum'},
    } for index, queue_name in enumerate(names.values())]
    try:
        response = cloudwatch.get_metric_data(MetricDataQueries=queries, ScanBy='TimestampDescending',
                                              StartTime=now - timedelta(minutes=AGE_WINDOW_MINUTES), EndTime=now)
    except (ClientError, BotoCoreError):
        return {}
    slugs = list(names)
    ages: dict[str, int] = {}
    for result in response.get('MetricDataResults', []):
        index = str(result.get('Id', ''))[1:]
        values = result.get('Values') or []
        if index.isdigit() and int(index) < len(slugs) and values:
            ages[slugs[int(index)]] = int(values[0])
    return ages


def _sampled_age(sent_at: list[str], now: datetime) -> int | None:
    """Seconds since the oldest SAMPLED message was sent (None without a timestamp).

    CloudWatch's ApproximateAgeOfOldestMessage stops pointing at a message once it has been
    received three times or more (SQS then reports the second-oldest), and every peek here is
    a receive — so on a dead-letter queue the metric can read "1.5 hours" for a message that
    has waited three days. The sampled send time is the message's real age.
    """
    stamps = [datetime.fromisoformat(stamp) for stamp in sent_at if stamp]
    return max(0, int((now - min(stamps)).total_seconds())) if stamps else None


def failure_queues(sqs: Any, cloudwatch: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """The `GET /logs/system/queues` body.

    ``oldest_age_seconds`` is the larger of CloudWatch's age and the oldest sampled message's
    real age (see ``_sampled_age``), so a peeked message never reads younger than it is.
    """
    moment = now or datetime.now(UTC)
    configured = configured_queues()
    queues = [_read_queue(sqs, slug, queue_name) for slug, queue_name in configured]
    holding = {slug: queue_name for queue, (slug, queue_name) in zip(queues, configured, strict=True)
               if queue.get('messages')}
    ages = _oldest_ages(cloudwatch, holding, moment)
    for queue in queues:
        candidates = [age for age in (ages.get(queue['name']), _sampled_age(queue.get('sample_sent_at') or [], moment))
                      if age is not None]
        if candidates:
            queue['oldest_age_seconds'] = max(candidates)
    return {'queues': queues}
