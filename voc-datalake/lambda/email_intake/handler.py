"""``voc-email-intake``: SQS (S3 ``ObjectCreated`` under ``inbound/``) -> one processing-queue message per email.

SES receiving stores each email in the inbound bucket; S3 notifies the ``voc-email-intake``
queue; this worker decides each email (``email_intake.intake``) and reports partial batch
failures, so one bad email never re-runs its neighbours. An email past the daily model
budget or the overall daily cap is DEFERRED: its SQS message is made invisible until the
next UTC day and reported as failed, so SQS redelivers it then (``maxReceiveCount`` leaves
room for that). An object over ``MAX_RAW_BYTES`` is dropped (``too_large``) from its
``HeadObject`` size, never downloaded.

Nothing here ever sends mail.
"""
from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from typing import Any, Final
from urllib.parse import unquote_plus

from botocore.exceptions import ClientError

from email_intake.intake import MAX_RAW_BYTES, DeferredError, IntakeContext, Outcome, drop, process_email
from email_intake.state import IntakeState
from shared.aws import get_bedrock_client, get_dynamodb_resource, get_s3_client, get_sqs_client, is_missing_s3_object
from shared.email_intake_settings import today
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics

INBOUND_PREFIX: Final = 'inbound/'
SES_SETUP_OBJECT: Final = 'AMAZON_SES_SETUP_NOTIFICATION'
#: SQS caps a visibility timeout at 12 hours; a deferral waits at most that long per receive.
MAX_VISIBILITY_SECONDS: Final = 43_200
MIN_DEFER_SECONDS: Final = 60
#: Deferred mail comes back a few minutes into the new UTC day, after the counters roll over.
DEFER_UNTIL_MINUTE: Final = 5


def _context() -> IntakeContext:
    dynamodb = get_dynamodb_resource()
    return IntakeContext(
        s3=get_s3_client(),
        sqs=get_sqs_client(),
        bedrock=get_bedrock_client(),
        state=IntakeState(dynamodb.Table(os.environ['WATERMARKS_TABLE']),
                          dynamodb.Table(os.environ['AGGREGATES_TABLE']), day=today()),
        bucket=os.environ['INBOUND_BUCKET'],
        queue_url=os.environ['PROCESSING_QUEUE_URL'],
        inbox_domain=os.environ.get('INBOUND_EMAIL_DOMAIN', '').strip().lower(),
    )


def object_keys(body: str) -> list[tuple[str, str]]:
    """``(bucket, key)`` of every email object an S3 notification names (the test event names none)."""
    try:
        notification = json.loads(body)
    except json.JSONDecodeError:
        return []
    keys: list[tuple[str, str]] = []
    for record in notification.get('Records', []) if isinstance(notification, dict) else []:
        s3 = record.get('s3') if isinstance(record, dict) else None
        bucket = ((s3 or {}).get('bucket') or {}).get('name')
        key = unquote_plus(((s3 or {}).get('object') or {}).get('key') or '')
        if isinstance(bucket, str) and key.startswith(INBOUND_PREFIX) and not key.endswith(SES_SETUP_OBJECT):
            keys.append((bucket, key))
    return keys


def seconds_until_tomorrow(now: datetime | None = None) -> int:
    current = now or datetime.now(UTC)
    midnight = (current + timedelta(days=1)).replace(hour=0, minute=DEFER_UNTIL_MINUTE, second=0, microsecond=0)
    return max(MIN_DEFER_SECONDS, min(MAX_VISIBILITY_SECONDS, int((midnight - current).total_seconds())))


def _decide(ctx: IntakeContext, key: str) -> Outcome:
    """The size first (HeadObject, covered by ``s3:GetObject``): an oversized email is never downloaded."""
    size = int(ctx.s3.head_object(Bucket=ctx.bucket, Key=key).get('ContentLength', 0))
    if size > MAX_RAW_BYTES:
        return drop(ctx, 'too_large')
    raw = ctx.s3.get_object(Bucket=ctx.bucket, Key=key)['Body'].read()
    return process_email(raw, key, ctx)


def _handle_object(ctx: IntakeContext, key: str) -> Outcome:
    outcome = _decide(ctx, key)
    # The decision is made: the only copy left is the restricted inbound-raw/ one (accepted mail).
    ctx.s3.delete_object(Bucket=ctx.bucket, Key=key)
    logger.info('Email decided', extra={'status': outcome.status, 'reason': outcome.reason,
                                        'item_id': outcome.item_id})
    metrics.add_metric(name=f'Email{outcome.status.capitalize()}', unit='Count', value=1)
    return outcome


def _defer(ctx: IntakeContext, record: dict[str, Any], error: DeferredError) -> None:
    queue_url = os.environ.get('INTAKE_QUEUE_URL', '')
    if queue_url and record.get('receiptHandle'):
        ctx.sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=record['receiptHandle'],
                                          VisibilityTimeout=seconds_until_tomorrow())
    ctx.state.count('deferred')
    if error.reason == 'daily_cap':
        # Worth an operator's look: a mail flood, or a cap set too low for the real volume.
        metrics.add_metric(name='EmailDailyCapHit', unit='Count', value=1)
        logger.warning('Email deferred: the overall daily cap is reached', extra={'reason': error.reason})
        return
    logger.info('Email deferred: the daily model budget is spent', extra={'reason': error.reason})


def _handle_record(ctx: IntakeContext, record: dict[str, Any]) -> bool:
    """True when the record is done; False when SQS must deliver it again."""
    for bucket, key in object_keys(str(record.get('body', ''))):
        if bucket != ctx.bucket:
            logger.warning('Notification for another bucket ignored')
            continue
        try:
            _handle_object(ctx, key)
        except DeferredError as error:
            _defer(ctx, record, error)
            return False
        except ClientError as error:
            if not is_missing_s3_object(error):
                raise
            logger.info('Email object already handled')
    return True


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    ctx = _context()
    failures: list[dict[str, str]] = []
    for record in event.get('Records', []):
        try:
            done = _handle_record(ctx, record)
        except Exception:
            logger.exception('Email intake failed; SQS will retry')
            done = False
        if not done:
            failures.append({'itemIdentifier': str(record.get('messageId', ''))})
    return {'batchItemFailures': failures}
