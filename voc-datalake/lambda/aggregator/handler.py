"""
VoC Aggregation Processor Lambda
Updates real-time aggregates in DynamoDB as feedback is inserted, edited and
deleted via Streams.

Why REMOVE is handled two different ways
----------------------------------------
Two TTLs meet in this file, and they have different lengths:

* the feedback table's items are stamped `ttl = now + 365 days`
  (`processor/handler.py`), and the table has `timeToLiveAttribute: 'ttl'`
  (`lib/stacks/core-stack.ts`). One year after ingestion DynamoDB deletes them
  en masse, and every deletion arrives here as a REMOVE record;
* the aggregate rows this Lambda writes expire after 90 days
  (`ttl_days=90` below), refreshed on each write. The row for date D is
  therefore gone around D+90 — long before the raw items of date D age out.

So a REMOVE arriving from TTL expiry is a record about a date whose aggregate row
no longer exists, and `if_not_exists(#field, :zero) + :inc` with `:inc = -1`
would RECREATE that row holding `count = -1` and stamp it with a fresh 90-day
TTL. A window query reaching back that far would then serve a negative count that
no feedback ever justified. That failure only starts about a year after deploy,
which is exactly why it has to be designed against rather than tested into.

Hence: TTL expiry is not a correction (the feedback of 2026-01-15 really did
arrive on 2026-01-15; garbage-collecting the raw item a year later does not
change that daily total) and is skipped. A user-initiated delete IS a correction
and decrements — under a condition that cannot create a row and cannot go below
zero.
"""
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

# Configuration
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

processor = BatchProcessor(event_type=EventType.DynamoDBStreams)


def get_metric_type(pk: str) -> str | None:
    """Extract metric type from pk for GSI indexing."""
    if pk.startswith('METRIC#daily_source#'):
        return 'source'
    elif pk.startswith('METRIC#persona#'):
        return 'persona'
    return None


def _is_conditional_check_failure(error: Exception) -> bool:
    """True for DynamoDB's ConditionalCheckFailedException, however it arrives.

    The error CODE in the response is the dependable signal — boto3's resource
    layer raises a dynamically-built ClientError subclass, so its type name is a
    botocore implementation detail. The type name is checked as well because a
    test double raises the named exception with no response payload. Same helper
    shape as `product_doc_extractor/handler.py`.
    """
    response = getattr(error, 'response', None)
    code = (response.get('Error') or {}).get('Code') if isinstance(response, dict) else None
    return (code == 'ConditionalCheckFailedException'
            or type(error).__name__ == 'ConditionalCheckFailedException')


def update_counter(pk: str, sk: str, field: str, increment: int = 1, ttl_days: int = 90):
    """Atomically update a counter in the aggregates table.

    An increment may create the row (that is how a date's first item registers).
    A DEcrement may not: it is guarded so that it applies only to a row that is
    still there and still above zero. Two distinct failures are prevented, and
    both would be invisible without the guard:

    * a row that has already expired under its 90-day TTL has nothing left to
      correct, and `if_not_exists(#field, :zero) + :inc` would happily resurrect
      it holding a negative count with a fresh 90-day TTL;
    * DynamoDB Streams deliver at-least-once, so the same REMOVE can arrive
      twice; the floor at zero makes the second delivery a no-op rather than a
      count of -1.

    ConditionalCheckFailedException is therefore the expected, benign outcome of
    a decrement with nothing to decrement, and is swallowed.
    """
    ttl = int(datetime.now(timezone.utc).timestamp() + ttl_days * 24 * 60 * 60)

    # Build update expression - include metric_type for GSI if applicable
    metric_type = get_metric_type(pk)
    update_expr = 'SET #field = if_not_exists(#field, :zero) + :inc, #ttl = :ttl, updated_at = :now'
    attr_names = {'#field': field, '#ttl': 'ttl'}
    attr_values = {
        ':inc': increment,
        ':zero': 0,
        ':ttl': ttl,
        ':now': datetime.now(timezone.utc).isoformat()
    }

    if metric_type:
        update_expr += ', metric_type = :metric_type'
        attr_values[':metric_type'] = metric_type

    kwargs: dict[str, Any] = {}
    if increment < 0:
        kwargs['ConditionExpression'] = 'attribute_exists(pk) AND #field >= :floor'
        attr_values[':floor'] = -increment

    try:
        aggregates_table.update_item(
            Key={'pk': pk, 'sk': sk},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=attr_names,
            ExpressionAttributeValues=attr_values,
            **kwargs
        )
    except ClientError as e:
        if increment >= 0 or not _is_conditional_check_failure(e):
            raise
        logger.info(f"Skipped decrement of {field} on {pk}/{sk}: nothing to correct")


def update_average(pk: str, sk: str, value: Decimal, ttl_days: int = 90, sign: int = 1):
    """Update running average in aggregates table.

    `sign=-1` reverses a previously recorded value (subtract from `sum`,
    decrement `count`). It carries the same condition as a counter decrement,
    for the same reason: an expired row must not be recreated holding
    `count = -1`, and a redelivered REMOVE must not push `count` below zero.
    """
    ttl = int(datetime.now(timezone.utc).timestamp() + ttl_days * 24 * 60 * 60)

    attr_values: dict[str, Any] = {
        ':val': value if sign > 0 else -value,
        ':one': sign,
        ':zero': Decimal('0'),
        ':ttl': ttl,
        ':now': datetime.now(timezone.utc).isoformat()
    }

    kwargs: dict[str, Any] = {}
    if sign < 0:
        # A distinct :floor rather than reusing :one, which is -1 here.
        kwargs['ConditionExpression'] = 'attribute_exists(pk) AND #count >= :floor'
        attr_values[':floor'] = 1

    try:
        aggregates_table.update_item(
            Key={'pk': pk, 'sk': sk},
            UpdateExpression='''
                SET #sum = if_not_exists(#sum, :zero) + :val,
                    #count = if_not_exists(#count, :zero) + :one,
                    #ttl = :ttl,
                    updated_at = :now
            ''',
            ExpressionAttributeNames={'#sum': 'sum', '#count': 'count', '#ttl': 'ttl'},
            ExpressionAttributeValues=attr_values,
            **kwargs
        )
    except ClientError as e:
        if sign >= 0 or not _is_conditional_check_failure(e):
            raise
        logger.info(f"Skipped reversal of average on {pk}/{sk}: nothing to correct")


def _image_date(item: dict) -> str:
    """The date bucket an image belongs to."""
    return item.get('date') or datetime.now(timezone.utc).strftime('%Y-%m-%d')


def _image_score(item: dict) -> Decimal:
    """The sentiment score an image contributes to the running average."""
    return item.get('sentiment_score', Decimal('0'))


def counter_dimensions(item: dict) -> list[tuple[str, str]]:
    """The (pk, field) counters one feedback item contributes to.

    ONE description of the dimensions, shared by the increment and the decrement
    path, because the two drifting apart is the failure mode this fix exists to
    remove: a dimension added to the insert path only would go up forever and
    never come back down — precisely the shape of the original bug, just narrower.
    This replaces eight hardcoded `update_counter` calls; an inverted copy of
    those eight would have re-created that hazard on day one.

    NOTE `persona_name` is read here even though the processor writes
    `persona_type` (so ~everything buckets as `Unknown`). That is a separate
    finding, tracked separately; reading a different field here than the insert
    path read would make decrements miss the row the insert created, which is
    strictly worse than the wrong bucket name. Fix it in one place when it is
    fixed.
    """
    source_platform = item.get('source_platform', 'unknown')
    category = item.get('category', 'other')
    sentiment_label = item.get('sentiment_label', 'neutral')
    urgency = item.get('urgency', 'low')
    persona = item.get('persona_name', 'Unknown')

    dimensions = [
        ('METRIC#daily_total', 'count'),
        (f'METRIC#daily_source#{source_platform}', 'count'),
        (f'METRIC#daily_category#{category}', 'count'),
        (f'METRIC#daily_sentiment#{sentiment_label}', 'count'),
    ]

    # Urgency counts (for alerts) — only urgent items have a row at all, so a
    # non-high item must not write one in either direction.
    if urgency == 'high':
        dimensions.append(('METRIC#urgent', 'count'))

    if persona:
        dimensions.append((f'METRIC#persona#{persona}', 'count'))

    # Category + sentiment combo
    dimensions.append((f'METRIC#category_sentiment#{category}#{sentiment_label}', 'count'))

    return dimensions


def counter_keys(item: dict) -> set[tuple[str, str, str]]:
    """`counter_dimensions` with the item's date filled in: (pk, date, field).

    Every counter in this module is written under a BARE `YYYY-MM-DD` sort key,
    because the streaming reader sums a window with `sk BETWEEN :oldest AND
    :newest` — see test_streaming_categories_lockstep.py. Producing the sort key
    in exactly one place is what keeps that pinnable now that the call sites are
    generic.
    """
    date = _image_date(item)
    return {(pk, date, field) for pk, field in counter_dimensions(item)}


def apply_counter_keys(keys: set[tuple[str, str, str]], sign: int):
    """Move every named counter by `sign`.

    The ONE place a counter key is unpacked into an `update_counter` call, so
    there is exactly one line in this module deciding what a counter's sort key
    is. Sorted only to make the write order deterministic for tests and logs.
    """
    for pk, date, field in sorted(keys):
        update_counter(pk, date, field, increment=sign)


def apply_feedback(item: dict, sign: int):
    """Add (`sign=1`) or reverse (`sign=-1`) one item's contribution."""
    apply_counter_keys(counter_keys(item), sign)

    # Daily sentiment score average
    sentiment_score = _image_score(item)
    if sentiment_score:
        date = _image_date(item)
        update_average('METRIC#daily_sentiment_avg', date, sentiment_score, sign=sign)

    verb = 'Updated' if sign > 0 else 'Reversed'
    logger.info(
        f"{verb} aggregates for source={item.get('source_platform', 'unknown')}, "
        f"category={item.get('category', 'other')}"
    )


@tracer.capture_method
def process_new_feedback(item: dict):
    """Update aggregates for a new feedback item."""
    apply_feedback(item, 1)


@tracer.capture_method
def process_deleted_feedback(item: dict):
    """Reverse the aggregates a now-deleted feedback item contributed.

    Only for a USER-initiated delete. TTL expiry is filtered out upstream in
    `record_handler` — see the module docstring for why ageing out must not
    change a past day's totals.
    """
    apply_feedback(item, -1)


@tracer.capture_method
def process_modified_feedback(old_item: dict, new_item: dict):
    """Move an item between buckets after an in-place edit.

    The ingestion path cannot emit MODIFY (`processor/handler.py` writes with a
    single `put_item`), but the Data Explorer's `PUT /data-explorer/feedback`
    edits records in place and its allowlist includes `category`,
    `sentiment_label`, `sentiment_score` and `urgency` — four of the dimensions
    `counter_dimensions` buckets on. So MODIFY is not hypothetical, and skipping
    it would leave an edited item counted under the bucket it left.

    Only dimensions whose value actually changed are touched, so an edit to, say,
    `problem_summary` writes nothing at all: with `-1` then `+1` on an identical
    (pk, sk) the net is zero, but each pair of writes would refresh the row's
    90-day TTL and burn capacity, and the decrement half could be refused as a
    conditional check failure against a row sitting at zero and so leave the
    increment un-cancelled. Symmetric difference of the two dimension sets is
    also the only formulation that stays correct when `date` itself is edited,
    which moves EVERY counter to another sk.
    """
    old_keys, new_keys = counter_keys(old_item), counter_keys(new_item)

    apply_counter_keys(old_keys - new_keys, -1)
    apply_counter_keys(new_keys - old_keys, 1)

    old_date, new_date = _image_date(old_item), _image_date(new_item)
    old_score, new_score = _image_score(old_item), _image_score(new_item)
    if (old_date, old_score) != (new_date, new_score):
        if old_score:
            update_average('METRIC#daily_sentiment_avg', old_date, old_score, sign=-1)
        if new_score:
            update_average('METRIC#daily_sentiment_avg', new_date, new_score, sign=1)

    logger.info(
        f"Rebucketed aggregates: {len(old_keys - new_keys)} decrement(s), "
        f"{len(new_keys - old_keys)} increment(s)"
    )


def deserialize_image(image: dict) -> dict:
    """Convert a stream image to a plain dict.

    Powertools may already have deserialized it, so both formats are accepted.
    """
    item = {}
    for key, value in image.items():
        if isinstance(value, dict):
            # Raw DynamoDB format
            if 'S' in value:
                item[key] = value['S']
            elif 'N' in value:
                item[key] = Decimal(value['N'])
            elif 'M' in value:
                item[key] = value['M']
            elif 'L' in value:
                item[key] = value['L']
            elif 'BOOL' in value:
                item[key] = value['BOOL']
        else:
            # Already deserialized
            item[key] = value
    return item


def is_ttl_expiry(record: DynamoDBRecord) -> bool:
    """True when this REMOVE is DynamoDB's own TTL reaper, not a person.

    A TTL deletion is the only REMOVE that carries `userIdentity`, with
    `principalId == 'dynamodb.amazonaws.com'` and `type == 'Service'`; a delete
    made through the API carries none.

    A MISSING or unreadable `userIdentity` is therefore treated as a USER
    deletion. That is the deliberate direction to fail in: a real user delete is
    the case this fix exists for, and misreading one as TTL expiry would leave
    the aggregate permanently overstated — the bug we are here to remove. The
    opposite misreading costs at most one decrement, and even that cannot corrupt
    the row: the decrement is conditional, so against an aged-out row it is a
    no-op rather than a resurrected negative count.
    """
    identity = record.user_identity if hasattr(record, 'user_identity') else None
    if not isinstance(identity, dict):
        return False
    return (identity.get('principalId') == 'dynamodb.amazonaws.com'
            and identity.get('type') == 'Service')


def record_handler(record: DynamoDBRecord) -> dict:
    """Process a single DynamoDB Stream record.

    INSERT adds to the aggregates, REMOVE takes back out (unless TTL did the
    deleting) and MODIFY moves an item between buckets. Counting only INSERTs is
    what made `get_metrics_summary` (aggregates) and `search_feedback` (scan)
    report different totals for the same window.
    """
    # event_name is an enum in Powertools, compare with .value or string representation
    event_name = str(record.event_name).split('.')[-1] if record.event_name else None
    logger.info(f"Processing record: event_name={event_name}")

    if event_name not in ('INSERT', 'REMOVE', 'MODIFY'):
        logger.info(f"Skipping unrecognized event: {event_name}")
        return {"status": "skipped", "reason": "unrecognized event"}

    stream = record.dynamodb
    new_image = stream.new_image if stream else None
    old_image = stream.old_image if stream else None

    if event_name == 'REMOVE':
        if is_ttl_expiry(record):
            # Ageing out is not a correction — see the module docstring.
            logger.info("Skipping TTL-driven REMOVE: aggregates keep the historical count")
            return {"status": "skipped", "reason": "ttl expiry"}
        if not old_image:
            logger.warning("No old_image in REMOVE record")
            return {"status": "skipped", "reason": "no old image"}
        item = deserialize_image(old_image)
        logger.info(f"Reversing feedback: date={item.get('date')}, source={item.get('source_platform')}")
        process_deleted_feedback(item)
        metrics.add_metric(name="AggregatesUpdated", unit="Count", value=1)
        return {"status": "success"}

    if event_name == 'MODIFY':
        if not old_image or not new_image:
            logger.warning("MODIFY record is missing an image; cannot rebucket")
            return {"status": "skipped", "reason": "incomplete images"}
        process_modified_feedback(deserialize_image(old_image), deserialize_image(new_image))
        metrics.add_metric(name="AggregatesUpdated", unit="Count", value=1)
        return {"status": "success"}

    if not new_image:
        logger.warning("No new_image in record")
        return {"status": "skipped", "reason": "no new image"}

    logger.info(f"new_image keys: {list(new_image.keys()) if new_image else 'None'}")

    item = deserialize_image(new_image)

    logger.info(f"Processing feedback: date={item.get('date')}, source={item.get('source_platform')}")
    process_new_feedback(item)
    metrics.add_metric(name="AggregatesUpdated", unit="Count", value=1)

    return {"status": "success"}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for DynamoDB Streams."""
    return processor.response()
