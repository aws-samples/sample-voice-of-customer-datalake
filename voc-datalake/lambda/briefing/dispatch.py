"""The 15-minute dispatcher: queue the subscribers whose local brief hour has passed today.

Reads only the ``BRIEFSUB`` partition (one row per user with the scheduled brief ON),
so a deployment where nobody subscribed costs one empty Query per tick. A user is
claimed for their local day with a conditional write before the message is sent, so
overlapping ticks never queue the same brief twice; a tick that missed the hour (an
outage) still queues it later the same local day.
"""
from __future__ import annotations

from collections.abc import Iterator, Mapping
from datetime import datetime
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared import briefing_prefs as prefs
from shared import briefing_store as store
from shared.aws import is_conditional_check_failure
from shared.briefing_requests import REASON_SCHEDULED, build_message
from shared.dynamo_paging import iter_query

SQS_BATCH: Final = 10


def due_day(row: Mapping[str, Any], now: datetime) -> str | None:
    """The reader's local day when their hour has passed and today's brief is not queued yet."""
    local = now.astimezone(prefs.zone_of(row.get('time_zone')))
    hour = prefs.stored_preferences({'hour': row.get('hour')})['hour']
    day = local.strftime('%Y-%m-%d')
    if local.hour < hour or row.get('last_day') == day:
        return None
    return day


def subscribers(aggregates_table: Any) -> Iterator[dict]:
    return iter_query(aggregates_table, {'KeyConditionExpression': Key('pk').eq(store.SUBSCRIBERS_PK)})


def claim(aggregates_table: Any, row: Mapping[str, Any], day: str) -> bool:
    """Mark ``day`` as queued for this subscriber; False when another tick already did."""
    try:
        aggregates_table.update_item(
            Key={'pk': row['pk'], 'sk': row['sk']}, UpdateExpression='SET last_day = :day',
            ConditionExpression='attribute_exists(pk) AND (attribute_not_exists(last_day) OR last_day <> :day)',
            ExpressionAttributeValues={':day': day},
        )
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    return True


def _send(sqs: Any, queue_url: str, bodies: list[str]) -> None:
    for start in range(0, len(bodies), SQS_BATCH):
        chunk = bodies[start:start + SQS_BATCH]
        sqs.send_message_batch(QueueUrl=queue_url, Entries=[
            {'Id': str(i), 'MessageBody': body} for i, body in enumerate(chunk)])


def dispatch(aggregates_table: Any, sqs: Any, queue_url: str, now: datetime) -> dict[str, int]:
    """One tick: ``{subscribers, queued}``."""
    bodies, seen = [], 0
    for row in subscribers(aggregates_table):
        seen += 1
        sub, username = row.get('sub'), row.get('username')
        day = due_day(row, now)
        if not isinstance(sub, str) or not isinstance(username, str) or day is None:
            continue
        if claim(aggregates_table, row, day):
            bodies.append(build_message(sub, username, REASON_SCHEDULED))
    _send(sqs, queue_url, bodies)
    return {'subscribers': seen, 'queued': len(bodies)}
