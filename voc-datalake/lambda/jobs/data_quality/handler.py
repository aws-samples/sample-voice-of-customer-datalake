"""Data Quality worker — consumes the data-quality SQS queue.

Handles the three message types described in shared/data_quality.py:

- ``profile_scan``: scans the feedback table page by page into a per-source
  profile; when the invocation runs low on time it re-enqueues itself with the
  cursor and the partial counts, and the final page writes the snapshot.
- ``enrich_plan``: pages one source partition (only unscored rows in
  ``missing`` mode) and fans out one ``enrich_item`` message per row, adding to
  the job's ``total`` as it goes; continues itself the same way.
- ``enrich_item``: derives one registry field for one row with the
  ``enrichment`` model surface and writes it with a guarded ``update_item``.

Progress counters are written once per batch. A message for a job that is no
longer running (cancelled, finished, expired) is dropped. Item failures are
retried by SQS until the final delivery, which is counted as failed instead of
going to the DLQ — so every planned item is accounted for and a job always
reaches a terminal status.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from typing import Any

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from shared import data_quality as dq
from shared.aws import get_dynamodb_resource, get_sqs_client
from shared.converse import converse
from shared.enrichment_fields import (
    SINGLE_FIELD_SYSTEM_PROMPT,
    build_single_field_prompt,
    get_field,
)
from shared.logging import logger, tracer

FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
QUEUE_URL = os.environ.get('DATA_QUALITY_QUEUE_URL', '')
# Must equal the queue's redrive maxReceiveCount (set from one constant in CDK):
# the delivery that would otherwise go to the DLQ is counted as failed instead.
MAX_RECEIVE_COUNT = int(os.environ.get('DQ_MAX_RECEIVE_COUNT', '5'))

# Time left for flushing counters and sending a continuation after a page.
TIME_RESERVE_MS = 60_000
SQS_SEND_BATCH = 10
ITEM_MAX_TOKENS = 60

_dynamodb = get_dynamodb_resource()
feedback_table = _dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = _dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None


class RetryLater(Exception):
    """This message should be redelivered by SQS (reported as a batch failure)."""


class Invocation:
    """Per-invocation state: the Lambda context, a job cache, counter deltas."""

    def __init__(self, context: Any):
        self.context = context
        self._jobs: dict[str, dict | None] = {}
        self.deltas: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def time_is_short(self) -> bool:
        remaining = getattr(self.context, 'get_remaining_time_in_millis', None)
        return remaining is not None and remaining() < TIME_RESERVE_MS

    def running_job(self, job_id: str) -> dict | None:
        if job_id not in self._jobs:
            self._jobs[job_id] = dq.get_job(aggregates_table, job_id) if job_id else None
        job = self._jobs[job_id]
        return job if job and job.get('status') == dq.STATUS_RUNNING else None

    def count(self, job_id: str, outcome: str) -> None:
        self.deltas[job_id]['processed'] += 1
        self.deltas[job_id][outcome] += 1

    def flush(self) -> None:
        """Write counter deltas, then complete any job that is now fully accounted for."""
        for job_id, deltas in self.deltas.items():
            job = dq.add_progress(aggregates_table, job_id, **deltas)
            if job and job.get('status') == dq.STATUS_RUNNING and dq.is_complete(job):
                dq.finish_job(aggregates_table, job, dq.STATUS_COMPLETED)
        self.deltas.clear()


# ---------------------------------------------------------------------------
# SQS helpers
# ---------------------------------------------------------------------------

def _send(message: dict) -> None:
    get_sqs_client().send_message(QueueUrl=QUEUE_URL, MessageBody=dq.to_json(message))


def _send_batch(messages: list[dict]) -> tuple[int, bool]:
    """Send in groups of 10, retrying failed entries once.

    Returns ``(sent, complete)``. The caller records `sent` BEFORE acting on an
    incomplete send: a retried plan re-sends the page, and every message that
    was actually enqueued has to be in `total` or the duplicates' `processed`
    counts would complete the job while real items are still queued.
    """
    sqs = get_sqs_client()
    sent = 0
    for start in range(0, len(messages), SQS_SEND_BATCH):
        entries = [
            {'Id': str(i), 'MessageBody': dq.to_json(m)}
            for i, m in enumerate(messages[start:start + SQS_SEND_BATCH])
        ]
        failed_ids = {f['Id'] for f in sqs.send_message_batch(QueueUrl=QUEUE_URL, Entries=entries).get('Failed', [])}
        if failed_ids:
            retry = [e for e in entries if e['Id'] in failed_ids]
            failed_ids = {f['Id'] for f in sqs.send_message_batch(QueueUrl=QUEUE_URL, Entries=retry).get('Failed', [])}
        sent += len(entries) - len(failed_ids)
        if failed_ids:
            return sent, False
    return sent, True


def _receive_count(record: dict) -> int:
    try:
        return int(record.get('attributes', {}).get('ApproximateReceiveCount', '1'))
    except (TypeError, ValueError):
        return 1


# ---------------------------------------------------------------------------
# profile_scan
# ---------------------------------------------------------------------------

@tracer.capture_method
def handle_profile_scan(run: Invocation, job: dict, message: dict) -> None:
    projection, names = dq.profile_projection()
    profile: dict = message.get('partial') or {}
    scanned = int(message.get('scanned', 0))
    start_key = message.get('start_key')
    while True:
        kwargs: dict[str, Any] = {'ProjectionExpression': projection, 'ExpressionAttributeNames': names}
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = feedback_table.scan(**kwargs)
        items = page.get('Items', [])
        dq.accumulate_profile(profile, items)
        scanned += len(items)
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            break
        if run.time_is_short():
            dq.set_job_fields(aggregates_table, job['job_id'], processed=scanned)
            _send({
                'type': dq.MSG_PROFILE_SCAN, 'job_id': job['job_id'],
                'start_key': start_key, 'partial': profile, 'scanned': scanned,
            })
            return

    now = dq.utc_now().isoformat()
    aggregates_table.put_item(Item={
        'pk': dq.STATS_PK, 'sk': dq.STATS_SK,
        'generated_at': now, 'scanned': scanned, 'job_id': job['job_id'],
        'sources': dq.snapshot_sources(profile),
    })
    done = dq.set_job_fields(aggregates_table, job['job_id'], processed=scanned, total=scanned, planned=True)
    dq.finish_job(aggregates_table, done or job, dq.STATUS_COMPLETED)


# ---------------------------------------------------------------------------
# enrich_plan
# ---------------------------------------------------------------------------

@tracer.capture_method
def handle_enrich_plan(run: Invocation, job: dict, message: dict) -> None:
    field = get_field(str(message.get('field')))
    if field is None:
        dq.finish_job(aggregates_table, job, dq.STATUS_FAILED, f"Unknown field {message.get('field')!r}")
        return
    mode = message.get('mode')
    source = str(message.get('source', ''))
    start_key = message.get('start_key')
    while True:
        kwargs: dict[str, Any] = {
            'KeyConditionExpression': Key('pk').eq(f'{dq.FEEDBACK_PK_PREFIX}{source}')
            & Key('sk').begins_with(dq.FEEDBACK_SK_PREFIX),
            'ProjectionExpression': 'pk, sk',
        }
        if mode == dq.MODE_MISSING:
            kwargs['FilterExpression'] = Attr(field.name).not_exists()
        if start_key:
            kwargs['ExclusiveStartKey'] = start_key
        page = feedback_table.query(**kwargs)
        keys = [{'pk': i['pk'], 'sk': i['sk']} for i in page.get('Items', [])]
        sent, complete = _send_batch([
            {'type': dq.MSG_ENRICH_ITEM, 'job_id': job['job_id'], 'field': field.name, 'mode': mode, **key}
            for key in keys
        ])
        if sent:
            dq.add_progress(aggregates_table, job['job_id'], total=sent)
        if not complete:
            raise RetryLater('Could not enqueue every item message')
        start_key = page.get('LastEvaluatedKey')
        if not start_key:
            break
        if run.time_is_short():
            _send({**message, 'start_key': start_key})
            return

    planned = dq.set_job_fields(aggregates_table, job['job_id'], planned=True)
    if planned and dq.is_complete(planned):
        dq.finish_job(aggregates_table, planned, dq.STATUS_COMPLETED)


# ---------------------------------------------------------------------------
# enrich_item
# ---------------------------------------------------------------------------

def _derive(field, text: str) -> str | None:
    answer = converse(
        prompt=build_single_field_prompt(field, text),
        system_prompt=SINGLE_FIELD_SYSTEM_PROMPT,
        max_tokens=ITEM_MAX_TOKENS,
        surface='enrichment',
        max_retries=3,
        raise_on_throttle=True,
        step_name=f'data_quality_{field.name}',
    )
    return dq.parse_single_field_answer(field, answer)


def _write_value(field, key: dict, value: str, mode: str) -> bool:
    """Guarded single-attribute update; False when the guard refused it."""
    condition = 'attribute_exists(pk)'
    if mode == dq.MODE_MISSING:
        condition += ' AND attribute_not_exists(#f)'
    try:
        feedback_table.update_item(
            Key=key,
            UpdateExpression='SET #f = :v',
            ConditionExpression=condition,
            ExpressionAttributeNames={'#f': field.name},
            ExpressionAttributeValues={':v': value},
        )
        return True
    except ClientError as e:
        if dq.is_conditional_failure(e):
            return False
        raise


@tracer.capture_method
def handle_enrich_item(run: Invocation, job: dict, message: dict, receive_count: int) -> None:
    job_id = job['job_id']
    field = get_field(str(message.get('field')))
    key = {'pk': message.get('pk'), 'sk': message.get('sk')}
    if field is None or not all(isinstance(v, str) and v for v in key.values()):
        run.count(job_id, 'failed')
        return
    try:
        row = feedback_table.get_item(Key=key, ProjectionExpression='original_text').get('Item')
        text = (row or {}).get('original_text')
        if not isinstance(text, str) or not text.strip():
            run.count(job_id, 'skipped')
            return
        value = _derive(field, text)
        if value is None:
            # The model answered outside the enum; asking again will not help.
            run.count(job_id, 'failed')
            return
        written = _write_value(field, key, value, str(message.get('mode')))
        run.count(job_id, 'updated' if written else 'skipped')
    except Exception as e:
        if receive_count >= MAX_RECEIVE_COUNT:
            logger.warning(f'Giving up on a data quality item after {receive_count} deliveries: {e}')
            run.count(job_id, 'failed')
            return
        raise RetryLater(str(e)) from e


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Steps that drive a whole job (as opposed to one item): a failure on the final
# delivery fails the job, because the message is all that keeps it moving.
JOB_STEP_HANDLERS = {
    dq.MSG_ENRICH_PLAN: handle_enrich_plan,
    dq.MSG_PROFILE_SCAN: handle_profile_scan,
}


def _run_job_step(run: Invocation, job: dict, message: dict, receive_count: int) -> None:
    try:
        JOB_STEP_HANDLERS[message['type']](run, job, message)
    except Exception as e:
        if receive_count >= MAX_RECEIVE_COUNT:
            logger.exception('Data quality job step failed on its final delivery')
            dq.finish_job(aggregates_table, job, dq.STATUS_FAILED, f'{message["type"]} failed: {e}')
            return
        raise RetryLater(str(e)) from e


def handle_record(run: Invocation, record: dict) -> None:
    try:
        message = json.loads(record.get('body') or '')
    except json.JSONDecodeError:
        logger.warning('Dropping an unparseable data quality message')
        return
    if not isinstance(message, dict):
        logger.warning('Dropping a non-object data quality message')
        return
    job = run.running_job(str(message.get('job_id', '')))
    if job is None:
        return  # cancelled, finished or expired — nothing left to do
    kind = message.get('type')
    if kind == dq.MSG_ENRICH_ITEM:
        handle_enrich_item(run, job, message, _receive_count(record))
    elif kind in JOB_STEP_HANDLERS:
        _run_job_step(run, job, message, _receive_count(record))
    else:
        logger.warning(f'Dropping a data quality message of unknown type {kind!r}')


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    run = Invocation(context)
    failures: list[dict[str, str]] = []
    for record in event.get('Records', []):
        try:
            handle_record(run, record)
        except RetryLater as e:
            logger.info(f'Retrying data quality message later: {e}')
            failures.append({'itemIdentifier': record['messageId']})
        except Exception:  # noqa: BLE001 — e.g. the job lookup itself failed
            logger.exception('Data quality message failed')
            failures.append({'itemIdentifier': record['messageId']})
    # Not caught: if counters cannot be written the whole batch is redelivered, so
    # items are re-derived (wasted calls) rather than silently left uncounted.
    run.flush()
    return {'batchItemFailures': failures}
