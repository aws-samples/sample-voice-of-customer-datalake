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

Which writes may create a row, and which may not
------------------------------------------------
* an INCREMENT may create the row. That is how a date's first item registers, and
  it is equally true of a rebucket: the first item edited into a category today is
  that category's first row today;
* a DECREMENT may not. An aggregate that has already aged out has nothing left to
  correct, and creating it would mean serving a negative count no feedback ever
  justified. Guarded with `attribute_exists(pk) AND #field >= :floor`, whose
  ConditionalCheckFailedException is the expected, benign outcome — swallowed, and
  counted as REFUSED_METRIC so a run of them is visible rather than silent;
* a REBUCKET OF AN AGED-OUT DAY writes nothing at all. Its decrements would be
  refused anyway, but the increments would not, and `PUT /data-explorer/feedback`
  can edit a record of any age while its aggregate rows are gone after 90 days —
  leaving a fresh 90-day-TTL'd fragment (`count = 1`, and a one-score
  `daily_sentiment_avg` row) for a date whose real totals were collected months
  ago. `validate_days` admits windows up to 365 days, so `/metrics/summary` and
  `/metrics/trends` would serve those fragments as the day's totals. The check is
  on the DAY, not per row — see `_day_has_aggregates` for why the per-row form
  drops legitimate counts instead of protecting anything.

A reversal also refuses to GUESS a date. `_image_date` falls back to today when an
image carries no `date` field, which is defensible for an INSERT (today is at
least the day the row was created) and arbitrary for a REMOVE: an undated item
ingested on D and deleted on D+40 would decrement the D+40 counters, corrupting a
legitimate current-day aggregate while leaving D overstated — and no
ConditionExpression can catch that, because the target row exists and is above the
floor. So the reversal and rebucket paths read `_image_date_or_none` and skip when
it answers None. A missed `-1` beats a `-1` aimed at the wrong day, the same
direction the TTL argument takes.

Known residuals
---------------
* NO BACKFILL. Aggregate rows written before this change carry the drift from
  every past deletion; nothing here repairs stored values, it only stops new
  drift. Repairing them needs a rebuild-from-scan path that does not exist.
* NOT IDEMPOTENT UNDER REDELIVERY. DynamoDB Streams deliver at-least-once, and
  the event source is configured with `retryAttempts: 3` and
  `reportBatchItemFailures: true`, so a batch that partially fails re-presents
  records whose writes already landed. A redelivered REMOVE decrements a second
  time (the floor at zero only makes that a no-op when the counter is ALREADY at
  zero — against a counter at 3 it lands on 1, not 2), and a redelivered MODIFY
  moves the count twice in both directions. What the conditions do guarantee is
  narrower and still worth having: no resurrected row, and no negative counter.
  Fixing this properly means recording each record's `eventID`/`sequence_number`
  through `shared/idempotency.py` — the shared `processingRole` is already granted
  the idempotency table, but this function is not given its name in the
  environment, so it is a CDK change as well as a code one, and it buys a write
  per stream record on the hot path. Deliberately left for its own change, with
  the tests in TestRedeliveryMovesACounterTwice pinning today's behaviour so this
  note and the code cannot drift apart.
* `update_average` FLOORS `count`, NOT `sum` — see its docstring for why adding a
  bound on `sum` would refuse legitimate reversals rather than fix anything.
"""
import os
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, is_conditional_check_failure

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

# Configuration
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

processor = BatchProcessor(event_type=EventType.DynamoDBStreams)

# One metric name per BEHAVIOUR, not one for all three.
#
# Before this change the Lambda did one thing and emitted one metric. It now does
# three materially different things, and emitting `AggregatesUpdated` for all of
# them would leave the new behaviour unobservable in production — which is a small
# echo of why the original bug lasted as long as it did: nothing outside the
# database could show whether aggregates ever came back DOWN. An operator
# confirming this fix is live wants to see AggregatesReversed climb.
#
# REFUSED_METRIC is the one that matters when something is wrong: a steady trickle
# is ordinary (deletions of aged-out days), a spike means either a redelivery
# storm or that rows are expiring while their feedback is still being edited.
UPDATED_METRIC = "AggregatesUpdated"
REVERSED_METRIC = "AggregatesReversed"
REBUCKETED_METRIC = "AggregatesRebucketed"
REFUSED_METRIC = "AggregateWriteRefused"

# The feedback field the persona counter buckets by, as a constant so that
# test_persona_field_lockstep.py can pin it against the field the PROCESSOR
# writes. It is a constant rather than an inline `item.get('persona_name')` for
# one reason: this name has to change on both sides of the stream at once. A
# decrement reads it out of the OLD image of an item whose insert read it out of
# the new one, so "fix" it here alone and every reversal misses the row its own
# insert created — the counter goes up and never comes down, which is the shape of
# the bug this module was just repaired for. The processor writes `persona_name`
# AND `persona_type` (`processor/handler.py`), so either is a real field; the
# lockstep is about the two sides agreeing, not about which of the two wins.
PERSONA_FIELD = 'persona_name'


def get_metric_type(pk: str) -> str | None:
    """Extract metric type from pk for GSI indexing."""
    if pk.startswith('METRIC#daily_source#'):
        return 'source'
    elif pk.startswith('METRIC#persona#'):
        return 'persona'
    return None


def _log_refusal(what: str, pk: str, sk: str):
    """A write the condition refused. Ordinary, but not to be silent about.

    Counted as well as logged, because "did the reversal path ever refuse
    anything?" is a question about production, not about one invocation, and
    CloudWatch is where it gets answered.
    """
    logger.info(f"Refused {what} on {pk}/{sk}: nothing to correct")
    metrics.add_metric(name=REFUSED_METRIC, unit="Count", value=1)


def update_counter(pk: str, sk: str, field: str, increment: int = 1, ttl_days: int = 90):
    """Atomically update a counter in the aggregates table.

    An increment may create the row — that is how a date's first item registers,
    and it stays true for a REBUCKET, because the first item edited into a category
    today is that category's first row today just as much as a fresh arrival would
    be. What keeps a rebucket from creating rows for an AGED-OUT day is a check on
    the day, not on the row: see `_day_has_aggregates`.

    A DEcrement may not create. Two failures are prevented, both invisible without
    the guard:

    * a row that has already expired under its 90-day TTL has nothing left to
      correct, and `if_not_exists(#field, :zero) + :inc` would resurrect it holding
      a negative count with a fresh 90-day TTL, which a window query reaching that
      far back would then serve;
    * the floor at zero keeps a decrement from driving a counter NEGATIVE.

    The floor is not idempotency: a redelivered REMOVE against a counter at 3 still
    lands on 2 and then 1 — see the module docstring's known residuals.

    ConditionalCheckFailedException is therefore an expected, benign outcome of a
    decrement with nothing to decrement, and is swallowed (and counted).
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
        if 'ConditionExpression' not in kwargs or not is_conditional_check_failure(e):
            raise
        _log_refusal(f'decrement of {field}', pk, sk)


def update_average(pk: str, sk: str, value: Decimal, ttl_days: int = 90, sign: int = 1):
    """Update running average in aggregates table.

    `sign=-1` reverses a previously recorded value (subtract from `sum`, decrement
    `count`), under the same condition as an `update_counter` decrement and for the
    same reasons — see that docstring and the module one.

    WHAT THE CONDITION DOES NOT COVER: it floors `count`, not `sum`. `:val` is the
    score the CURRENT image carries, while the row holds the sum of the scores
    actually applied, so a reversal quoting a different score than its insert did
    (an edit whose two halves were split across batches, a replayed record) leaves
    `sum` inconsistent with `count` in a way `count` cannot reveal, and
    `get_summary` serves `sum/count` as the day's average.

    A bound on `sum` was considered and rejected: scores run -1..1, so removing a
    NEGATIVE score raises `sum` and the bound would have to mirror, and any such
    bound refuses the legitimate reversal it cannot distinguish from the stale one
    — trading a skewed average for a permanently overstated `count`, which is the
    bug this module exists to remove. The coherent fix is to store per-item
    contributions so a reversal subtracts what was actually added; that is a schema
    change, and out of scope here. Recorded in the module docstring as a residual.
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
        if 'ConditionExpression' not in kwargs or not is_conditional_check_failure(e):
            raise
        _log_refusal('reversal of average', pk, sk)


def _day_has_aggregates(date: str) -> bool:
    """Does the daily total for `date` still exist?

    The question a REBUCKET has to answer before it may write, and it is a question
    about the DAY rather than about any one counter row. `attribute_exists(pk)` on
    each increment looks like the same guard and is not: an edit that moves an item
    into a category no item has used TODAY has no row for that category yet, and
    refusing it would DROP the count — the decrement lands on the bucket the item
    left and the increment vanishes, so the day's per-category counts stop summing
    to its total. That is a new inconsistency of exactly the kind this module was
    repaired for, so the per-row form is not the conservative choice it appears to
    be. (A moto test caught it: `test_rebucketing_a_day_that_does_have_rows_...`.)

    `METRIC#daily_total` is the right sentinel because EVERY item writes it — it is
    the one counter with no condition attached to its presence, so it exists if and
    only if some item of that date was ingested and the row has not yet aged out.
    If it is gone, the whole day is gone, and an edit to an item of that day must
    leave no trace rather than plant a one-count fragment under a fresh 90-day TTL
    that a 365-day metrics window would serve as the day's totals.

    A read per rebucket, on a day whose edits are rare, against a table this
    function already holds read access to. A failed read answers True: a rebucket
    that cannot check is treated as a live day, which risks one fragment rather than
    silently dropping every edit if the table is briefly unreadable.
    """
    try:
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
    except ClientError as e:
        logger.warning(f"Could not read the daily total for {date}: {e}; treating the day as live")
        return True
    return 'Item' in response


def _image_date_or_none(item: dict) -> str | None:
    """The date bucket an image belongs to, or None if it does not say.

    The STRICT accessor, for the paths that must not guess: a reversal or a
    rebucket aimed at a date the image never named would move a counter that has
    nothing to do with the item, and no ConditionExpression can catch that because
    the row it hits exists and is above the floor. See the module docstring.
    """
    return item.get('date') or None


def _image_date(item: dict) -> str:
    """The date bucket a NEWLY INSERTED image belongs to.

    The today-fallback is only defensible here: for an arrival, today is at least
    the day the row was created. Reversal paths read `_image_date_or_none` and skip
    rather than substitute now() — a missed `-1` beats a `-1` on the wrong day.
    """
    return _image_date_or_none(item) or datetime.now(timezone.utc).strftime('%Y-%m-%d')


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

    URGENCY IS THE ONLY CONDITIONAL DIMENSION. Every other item below is appended
    unconditionally, because each read has a non-empty default — a reader asking
    "which of these might be absent?" gets one answer, not two.

    The persona field is read through PERSONA_FIELD, and
    test_persona_field_lockstep.py pins that name against the field
    `processor/handler.py` actually writes. Prose could not hold that: reading a
    different field here than the insert path read makes every DECREMENT miss the
    row its insert created, so the two must move together, and "fix it in one
    place" is only true while something fails when they diverge.
    """
    source_platform = item.get('source_platform', 'unknown')
    category = item.get('category', 'other')
    sentiment_label = item.get('sentiment_label', 'neutral')
    urgency = item.get('urgency', 'low')
    # `or`, not a `.get` default: a stripped item can carry an explicit None, and
    # `METRIC#persona#None` is a bucket nothing else would ever write to.
    persona = item.get(PERSONA_FIELD) or 'Unknown'

    dimensions = [
        ('METRIC#daily_total', 'count'),
        (f'METRIC#daily_source#{source_platform}', 'count'),
        (f'METRIC#daily_category#{category}', 'count'),
        (f'METRIC#daily_sentiment#{sentiment_label}', 'count'),
        (f'METRIC#persona#{persona}', 'count'),
    ]

    # Urgency counts (for alerts) — only urgent items have a row at all, so a
    # non-high item must not write one in either direction.
    if urgency == 'high':
        dimensions.append(('METRIC#urgent', 'count'))

    # Category + sentiment combo
    dimensions.append((f'METRIC#category_sentiment#{category}#{sentiment_label}', 'count'))

    return dimensions


def counter_keys(item: dict, date: str) -> set[tuple[str, str, str]]:
    """`counter_dimensions` with a date filled in: (pk, date, field).

    Every counter in this module is written under a BARE `YYYY-MM-DD` sort key,
    because the streaming reader sums a window with `sk BETWEEN :oldest AND
    :newest` — see test_streaming_categories_lockstep.py. Producing the sort key
    in exactly one place is what keeps that pinnable now that the call sites are
    generic.

    The date is PASSED IN rather than read from the item here, because the two
    directions read it differently: an arrival may fall back to today, a reversal
    may not guess at all. Deciding that inside this function would mean either the
    reversal silently guessing or the insert path refusing an undated arrival it
    used to accept.
    """
    return {(pk, date, field) for pk, field in counter_dimensions(item)}


def apply_counter_keys(keys: set[tuple[str, str, str]], sign: int):
    """Move every named counter by `sign`.

    The ONE place a counter key is unpacked into an `update_counter` call, so
    there is exactly one line in this module deciding what a counter's sort key
    is. Sorted only to make the write order deterministic for tests and logs.
    """
    for pk, date, field in sorted(keys):
        update_counter(pk, date, field, increment=sign)


def apply_feedback(item: dict, sign: int, date: str):
    """Add (`sign=1`) or reverse (`sign=-1`) one item's contribution on `date`."""
    apply_counter_keys(counter_keys(item, date), sign)

    # Daily sentiment score average
    sentiment_score = _image_score(item)
    if sentiment_score:
        update_average('METRIC#daily_sentiment_avg', date, sentiment_score, sign=sign)

    verb = 'Updated' if sign > 0 else 'Reversed'
    logger.info(
        f"{verb} aggregates for source={item.get('source_platform', 'unknown')}, "
        f"category={item.get('category', 'other')}"
    )


@tracer.capture_method
def process_new_feedback(item: dict):
    """Update aggregates for a new feedback item."""
    date = _image_date(item)
    apply_feedback(item, 1, date)


@tracer.capture_method
def process_deleted_feedback(item: dict) -> bool:
    """Reverse the aggregates a now-deleted feedback item contributed.

    Only for a USER-initiated delete. TTL expiry is filtered out upstream in
    `record_handler` — see the module docstring for why ageing out must not
    change a past day's totals.

    Returns False, having written NOTHING, when the deleted image named no date.
    Substituting today would decrement whichever day this Lambda happens to run
    on — a legitimate current-day aggregate — while leaving the item's real day
    overstated, and the ConditionExpression cannot catch it because that row exists
    and is above the floor. Only legacy or hand-written rows lack `date` (the
    processor always sets it), which makes this latent rather than active; a missed
    `-1` is still the right way to be wrong about it.
    """
    date = _image_date_or_none(item)
    if date is None:
        logger.warning("REMOVE image carries no `date`; refusing to guess which day to reverse")
        return False
    apply_feedback(item, -1, date)
    return True


@tracer.capture_method
def process_modified_feedback(old_item: dict, new_item: dict) -> int | None:
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

    AN EDIT TO AN AGED-OUT DAY WRITES NOTHING. The decrements are refused anyway
    (their rows are gone), but the increments are not: an unconditional `+1` leaves
    a one-count fragment — and a one-score `daily_sentiment_avg` row, the worst of
    them, since `get_summary` divides `sum/count` per date and weights it by count —
    for a date whose real totals were collected months ago, stamped with a fresh
    90-day TTL. `validate_days` admits windows up to 365 days, so `/metrics/summary`
    and `/metrics/trends` would then serve those fragments as the day's totals.
    `PUT /data-explorer/feedback` can edit a record of any age, so this is reachable
    by ordinary use, not by a race.

    The check is on the DAY (`_day_has_aggregates`), not on each row. Guarding each
    increment with `attribute_exists(pk)` instead looks equivalent and is not: an
    edit that moves an item into a category no item has used today has no row for
    that category yet, and refusing it DROPS the count — the decrement lands, the
    increment vanishes, and the day's per-category counts no longer sum to its
    total. Trading one inconsistency for another is not a fix, so the two cases have
    to be told apart, and only the day can tell them apart.

    Returns the number of writes attempted (0 when the day is gone or the edit
    touched no dimension), or None when either image named no date — a rebucket
    needs both days, and guessing one of them moves a counter that has nothing to do
    with the item.
    """
    old_date, new_date = _image_date_or_none(old_item), _image_date_or_none(new_item)
    if old_date is None or new_date is None:
        logger.warning("MODIFY image carries no `date`; refusing to guess which days to rebucket")
        return None

    old_keys = counter_keys(old_item, old_date)
    new_keys = counter_keys(new_item, new_date)
    decrements, increments = old_keys - new_keys, new_keys - old_keys

    old_score, new_score = _image_score(old_item), _image_score(new_item)
    moves_the_average = (old_date, old_score) != (new_date, new_score)
    if not (decrements or increments or moves_the_average):
        # Nothing to do, and no read to pay for: the common case, an edit to a field
        # no counter buckets on.
        return 0

    # Checked once for the pair. An edited `date` makes these two different days,
    # and a live day on either side is enough to make the edit a real correction
    # rather than an attempt to rewrite history — the half that lands on the dead
    # day is refused (decrement) or plants nothing anyone asked for.
    if not (_day_has_aggregates(old_date) or _day_has_aggregates(new_date)):
        logger.info(
            f"Skipping rebucket of an aged-out day ({old_date} -> {new_date}): "
            f"its aggregates have expired and must not be partially recreated"
        )
        return 0

    apply_counter_keys(decrements, -1)
    apply_counter_keys(increments, 1)

    writes = len(decrements) + len(increments)
    if moves_the_average:
        if old_score:
            update_average('METRIC#daily_sentiment_avg', old_date, old_score, sign=-1)
            writes += 1
        if new_score:
            update_average('METRIC#daily_sentiment_avg', new_date, new_score, sign=1)
            writes += 1

    logger.info(
        f"Rebucketed aggregates: {len(decrements)} decrement(s), "
        f"{len(increments)} increment(s)"
    )
    return writes


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

    Read from `raw_event` and accepted as any Mapping, so this branch is pinned to
    the EVENT SHAPE rather than to a Powertools return type. `record.user_identity`
    returns a bare dict today and `None`/`{}` when absent, but a release that
    wrapped it in a `DictWrapper` would fail an `isinstance(..., dict)` test and
    quietly reclassify EVERY TTL REMOVE as a user delete — the whole branch dead,
    the suite still green, because the tests build records from raw event dicts and
    so follow Powertools rather than pinning it.
    """
    identity = record.raw_event.get('userIdentity') if isinstance(record.raw_event, Mapping) else None
    if not isinstance(identity, Mapping):
        return False
    return (identity.get('principalId') == 'dynamodb.amazonaws.com'
            and identity.get('type') == 'Service')


def _event_name(record: DynamoDBRecord) -> str | None:
    """The record's `eventName`, as the EVENT spells it.

    Read from `raw_event`, not from `record.event_name`. Powertools resolves that
    property through `DynamoDBRecordEventName[...]`, so it raises `KeyError` for
    any name outside the three the enum knows — which would happen BEFORE the
    membership check below could return a graceful skip, and with
    `reportBatchItemFailures: true` the record would then be reported failed and
    redelivered until it aged out of the stream. Streams preserve per-shard order,
    so one permanently-failing record blocks its partition: a poison pill in place
    of the skip. The stream API has exactly three event names today, so this is
    about the failure MODE rather than a likely event.

    Falls back to the property when `raw_event` is not a mapping, which is the case
    for the MagicMock-based records in the older tests.
    """
    raw = getattr(record, 'raw_event', None)
    if isinstance(raw, Mapping):
        name = raw.get('eventName')
        return name if isinstance(name, str) else None
    # event_name is an enum in Powertools, compare with .value or string representation
    return str(record.event_name).split('.')[-1] if record.event_name else None


def record_handler(record: DynamoDBRecord) -> dict:
    """Process a single DynamoDB Stream record.

    INSERT adds to the aggregates, REMOVE takes back out (unless TTL did the
    deleting) and MODIFY moves an item between buckets. Counting only INSERTs is
    what made `get_metrics_summary` (aggregates) and `search_feedback` (scan)
    report different totals for the same window.

    One metric per behaviour, because the three now do materially different things
    and a single `AggregatesUpdated` would leave reversals invisible from outside
    the table — see the metric constants at the top of this module. A rebucket that
    wrote nothing emits nothing, so the count means "aggregates moved".
    """
    event_name = _event_name(record)
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
        if not process_deleted_feedback(item):
            return {"status": "skipped", "reason": "no date"}
        metrics.add_metric(name=REVERSED_METRIC, unit="Count", value=1)
        return {"status": "success"}

    if event_name == 'MODIFY':
        if not old_image or not new_image:
            logger.warning("MODIFY record is missing an image; cannot rebucket")
            return {"status": "skipped", "reason": "incomplete images"}
        writes = process_modified_feedback(deserialize_image(old_image), deserialize_image(new_image))
        if writes is None:
            return {"status": "skipped", "reason": "no date"}
        if writes:
            metrics.add_metric(name=REBUCKETED_METRIC, unit="Count", value=1)
        return {"status": "success"}

    if not new_image:
        logger.warning("No new_image in record")
        return {"status": "skipped", "reason": "no new image"}

    logger.info(f"new_image keys: {list(new_image.keys()) if new_image else 'None'}")

    item = deserialize_image(new_image)

    logger.info(f"Processing feedback: date={item.get('date')}, source={item.get('source_platform')}")
    process_new_feedback(item)
    metrics.add_metric(name=UPDATED_METRIC, unit="Count", value=1)

    return {"status": "success"}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for DynamoDB Streams."""
    return processor.response()
