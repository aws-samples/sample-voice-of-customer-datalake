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
  drops legitimate counts instead of protecting anything — and it is applied PER
  SIDE, because an edit can move an item from a live day onto a dead one and every
  increment then lands on the dead day.

A rebucket's two halves of the AVERAGE stand or fall together WHEN THEY TARGET ONE
ROW. The counters cannot split (a symmetric difference never sends `-1` and `+1` to
one key), but the average is two conditional writes to (SENTIMENT_AVG_PK, date): a
reversal refused against a row at `count == 0` while the re-application applies would
leave that row asserting an item no feedback justifies, and `get_summary` divides
`sum/count` into the day's average and weights it into the headline number.

The pairing is keyed on the ROW rather than on the edit, because an edited `date`
sends the two writes to two different days and a refusal on one says nothing about the
other — pairing across that gap dropped the item from the new day's average while
every one of its counters moved there, the same split relocated to the day that
UNDERSTATES. Within one row, though, EITHER refusal blocks: a reversal is attempted
only when the old image carried a score, which means the insert did write that row, so
finding it gone means it EXPIRED rather than that it never existed. Creating it again
from the one edited item gives the date a `count == 1` average that `get_summary`
serves as the whole day's figure, next to a `daily_total` collected from every item of
that date — the one-score fragment described above, arriving below the granularity the
day sentinel can see, because `daily_total`'s TTL is refreshed by every item while the
average row's is refreshed only by scored ones. A write declined by that rule is
counted as DECLINED_METRIC — REFUSED_METRIC cannot cover it, since a write never
issued gives DynamoDB nothing to refuse. See `_rebucket_average`.

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
* AN EDIT THAT MOVES AN ITEM ONTO A LIVE DAY WHOSE AVERAGE ROW HAS EXPIRED still
  creates that row holding the one arriving score. The pairing rule learns a row is
  gone only from a reversal aimed at it, and a cross-day increment lands where no
  reversal went. It is undecidable from the two images: a live day with no average
  row looks identical whether the row expired or the day is taking its first scored
  item, and the second must be created. Closing it needs a per-day marker for "has
  ever held a scored item", i.e. new state, so it is left as a residual with
  `test_a_cross_day_arrival_onto_an_expired_average_still_fragments_it` pinning
  today's behaviour. The same-day case IS closed, because there the refused reversal
  is the evidence.
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
# The persona axis, declared in the data layer because BOTH sides of it spend the
# same two values — see the note above `counter_dimensions`.
from shared.feedback import PERSONA_FIELD, PERSONA_UNKNOWN

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
#
# DECLINED_METRIC is its counterpart for a write this module chose NOT to attempt.
# REFUSED_METRIC can only ever count DynamoDB's refusals — `_log_refusal` runs in an
# `except ClientError`, so a write never issued is invisible to it by construction.
# The average's pairing rule declines exactly such a write, and without its own
# metric that skip would be unobservable while REBUCKETED_METRIC still fired for the
# counter writes that landed: an operator would see a healthy rebucket and no
# anomaly, with the day's average having quietly lost an item. Distinct from REFUSED
# because the two need different responses — a refusal is DynamoDB reporting there
# was nothing to correct, a decline is this code declining to make a row
# inconsistent, and only the second is a decision an operator can argue with.
UPDATED_METRIC = "AggregatesUpdated"
REVERSED_METRIC = "AggregatesReversed"
REBUCKETED_METRIC = "AggregatesRebucketed"
REFUSED_METRIC = "AggregateWriteRefused"
DECLINED_METRIC = "AggregateWriteDeclined"

# The two aggregate rows this module names outside `counter_dimensions`, hoisted
# for the reason PERSONA_FIELD is named: a second unmarked copy of one of these
# strings is what makes an argument elsewhere in the file true or false.
#
# DAILY_TOTAL_PK is the sentinel `_day_has_aggregates` reads, and that read is only
# a sound test of "is this day still here?" because this is the ONE counter every
# item writes unconditionally — see that docstring. Spelling it twice would leave a
# reader of the sentinel having to know that the copy in `counter_dimensions` is
# what licenses the argument.
DAILY_TOTAL_PK = 'METRIC#daily_total'
SENTIMENT_AVG_PK = 'METRIC#daily_sentiment_avg'

# Client error codes worth failing OPEN for without shouting: a blip, a throttle, a
# retryable server-side fault. Anything outside this set is a misconfiguration
# (`AccessDeniedException`, `ValidationException`, `ResourceNotFoundException`), and
# `_day_has_aggregates` still fails open on it — but says so at `error`, because a
# permanently inert guard must not look like a bad afternoon. See that docstring.
_TRANSIENT_READ_ERRORS = frozenset({
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'ThrottlingException.TooManyRequests',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
    'RequestTimeout',
    'RequestTimeoutException',
    'TransactionConflictException',
})


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


def _log_decline(what: str, pk: str, sk: str, because: str):
    """A write this module chose not to ATTEMPT. Counted, for the same reason.

    `_log_refusal` cannot cover this: it runs inside an `except ClientError`, so a
    write never issued produces no refusal to count and the skip would be invisible
    to REFUSED_METRIC while REBUCKETED_METRIC still claimed the edit moved
    aggregates. A guard that silently declines work is one that gets debugged twice.
    """
    logger.info(f"Declined {what} on {pk}/{sk}: {because}")
    metrics.add_metric(name=DECLINED_METRIC, unit="Count", value=1)


def update_counter(pk: str, sk: str, field: str, increment: int = 1, ttl_days: int = 90) -> bool:
    """Atomically update a counter in the aggregates table.

    Returns whether the write LANDED. False means a condition refused it, which is
    an ordinary outcome for a decrement and never happens to an increment (they
    carry no condition). Callers that must know the difference: the rebucket, whose
    two halves have to stand or fall together, and the metric that claims
    "aggregates moved" — a count of writes ATTEMPTED would make that claim false
    for an edit whose every write was refused.

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
        return False
    return True


def update_average(pk: str, sk: str, value: Decimal, ttl_days: int = 90,
                   sign: int = 1) -> bool:
    """Update running average in aggregates table.

    Returns whether the write LANDED, exactly as `update_counter` does. A refusal
    needs no further explanation, because the rebucket treats BOTH ways a reversal
    can be refused the same: neither licenses re-applying to that row alone. A row
    present at `count == 0` must not be made to claim an item, and a row that is
    ABSENT is absent because it EXPIRED — a reversal is attempted only for an old
    image that carried a score, so the insert did write that row. Re-creating it
    from the single edited item is the one-score fragment `_rebucket_average`
    describes.

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
        return False
    return True


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

    DAILY_TOTAL_PK is the right sentinel because EVERY item writes it — it is the
    one counter with no condition attached to its presence, so it exists if and only
    if some item of that date was ingested and the row has not yet aged out. If it is
    gone, the whole day is gone, and an edit to an item of that day must leave no
    trace rather than plant a one-count fragment under a fresh 90-day TTL that a
    365-day metrics window would serve as the day's totals. That argument depends on
    `counter_dimensions` writing this same pk unconditionally, which is why the two
    read one constant rather than two matching literals.

    A read per rebucket, on a day whose edits are rare, against a table the shared
    `processingRole` already holds read access to (`aggregatesTable.grantReadWriteData`
    in processing-stack-consolidated.ts).

    A FAILED READ ANSWERS TRUE: a rebucket that cannot check is treated as a live
    day, which risks one recoverable fragment rather than silently dropping every
    edit while the table is briefly unreadable. But the two reasons a read fails are
    not equally survivable, so they are not logged alike. A throttle is a bad
    afternoon; `AccessDeniedException` or `ValidationException` is a
    misconfiguration, under which this guard is PERMANENTLY inert and every edit to
    an aged-out day plants the fragments the guard exists to prevent — indefinitely,
    and with `logger.warning` indistinguishable from the blip it was designed for.
    Hence `logger.error` for anything outside `_TRANSIENT_READ_ERRORS`: the fail-open
    direction is unchanged, its cause is not silent.
    """
    try:
        response = aggregates_table.get_item(Key={'pk': DAILY_TOTAL_PK, 'sk': date})
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '') if isinstance(e.response, Mapping) else ''
        message = (
            f"Could not read the daily total for {date}: {e}; treating the day as live"
        )
        if code in _TRANSIENT_READ_ERRORS:
            logger.warning(message)
        else:
            # Not a blip. Until this is fixed the aged-out-day guard cannot refuse
            # anything, so say so at a level an operator is alerted on.
            logger.error(
                f"{message}. `{code}` is not transient, so this guard is INERT until "
                f"it is fixed and every edit to an aged-out day will plant aggregate "
                f"fragments for it."
            )
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

    🔑 THE PERSONA AXIS BUCKETS BY ARCHETYPE (`persona_type`), NOT BY NAME. It
    bucketed by `persona_name` until an audit found 99.97% of a 6,239-item corpus
    in one `Unknown` bucket — a dimension useless while looking populated. The
    cause was NOT a field nothing writes: the processor writes both persona fields,
    and the enrichment contract declares `persona.name` as "string or null"
    precisely because this platform's corpus is scraped reviews and mostly
    anonymous form submissions. An anonymous item HAS no name to give, the
    processor strips None before writing, and so `persona_name` is legitimately
    absent on almost every item. A null name is therefore correct model output, and
    the axis was the thing that was wrong: `persona_type` is populated, and it is a
    closed enum (`existing_customer|prospect|churn_risk|advocate|unknown`), which
    is what a dimension you group by has to be — a person's name is an identifier,
    not an archetype. The `METRIC#persona#` prefix is deliberately unchanged, so
    `get_metric_type`, the `metric_type` GSI and every read path are untouched;
    only the source field moved.

    That move is FORWARD-ONLY. Rows already written keep their `Unknown` bucket, so
    a window spanning the deploy shows old `Unknown` alongside the new enum values;
    aggregate rows carry a 90-day TTL, so the axis becomes fully correct within 90
    days with no backfill. Nothing rewrites stored rows — a rewrite would have to
    re-derive each row from feedback the row no longer references.
    """
    source_platform = item.get('source_platform', 'unknown')
    category = item.get('category', 'other')
    sentiment_label = item.get('sentiment_label', 'neutral')
    urgency = item.get('urgency', 'low')
    # `or`, not a `.get` default: a stripped item can carry an explicit None, and
    # `METRIC#persona#None` is a bucket nothing else would ever write to.
    persona = item.get(PERSONA_FIELD) or PERSONA_UNKNOWN

    dimensions = [
        # DAILY_TOTAL_PK, not the literal: `_day_has_aggregates` reads this same
        # constant as its sentinel, and its argument for doing so is that this line
        # is unconditional. Two spellings would leave that dependency unmarked.
        (DAILY_TOTAL_PK, 'count'),
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


def apply_counter_keys(keys: set[tuple[str, str, str]], sign: int) -> int:
    """Move every named counter by `sign`, returning how many writes LANDED.

    The ONE place a counter key is unpacked into an `update_counter` call, so
    there is exactly one line in this module deciding what a counter's sort key
    is. Sorted only to make the write order deterministic for tests and logs.

    Landed, not attempted: a caller counting attempts would report that aggregates
    moved for an edit whose every write was refused by its condition.
    """
    return sum(
        1 for pk, date, field in sorted(keys)
        if update_counter(pk, date, field, increment=sign)
    )


def apply_feedback(item: dict, sign: int, date: str):
    """Add (`sign=1`) or reverse (`sign=-1`) one item's contribution on `date`."""
    apply_counter_keys(counter_keys(item, date), sign)

    # Daily sentiment score average
    sentiment_score = _image_score(item)
    if sentiment_score:
        update_average(SENTIMENT_AVG_PK, date, sentiment_score, sign=sign)

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

    THE DAY IS CHECKED PER SIDE, not once for the pair. `old_live or new_live` reads
    as a reasonable "is this edit a real correction?" and is not: an edit whose
    `date` moves an item FROM a live day TO a dead one would pass it, and then every
    unconditional increment lands on the dead day — recreating the whole seven-row
    fragment, `daily_total` included, so the sentinel afterwards reports the dead day
    as live for every subsequent edit. So decrements are applied only when the day
    they leave is live, increments only when the day they arrive at is live. Each
    distinct date is read once, which also stops the common same-day rebucket paying
    for two identical reads of one key.

    THE AVERAGE'S TWO HALVES STAND OR FALL TOGETHER. The counter dimensions are a
    symmetric difference precisely so a `-1` and a `+1` never land on the same key,
    but the average has no such protection: it is two conditional writes to
    (SENTIMENT_AVG_PK, date), and `#count >= :floor` can refuse the reversal against
    a row sitting at zero while the re-application applies unconditionally — leaving
    the row asserting one item, at the new score, that no present feedback justifies,
    which `get_summary` then divides into the day's average and weights into the
    headline `avg_sentiment`. So the increment half is applied only if the reversal
    half LANDED, or if there was no reversal to pair with (an old score of zero has
    nothing to reverse, and a dead old day has nothing to correct).

    Returns the number of writes that LANDED (0 when both days are gone, when the
    edit touched no dimension, or when every write was refused), or None when either
    image named no date — a rebucket needs both days, and guessing one of them moves
    a counter that has nothing to do with the item. Landed rather than attempted
    because `record_handler` spends this as REBUCKETED_METRIC, whose claim is that
    aggregates MOVED.
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

    # One read per DISTINCT date: a same-day edit — the common case, since `date` is
    # not in the Data Explorer's updatable_fields — asks the one question once.
    liveness = {date: _day_has_aggregates(date) for date in {old_date, new_date}}
    old_live, new_live = liveness[old_date], liveness[new_date]
    if not (old_live or new_live):
        logger.info(
            f"Skipping rebucket of an aged-out day ({old_date} -> {new_date}): "
            f"its aggregates have expired and must not be partially recreated"
        )
        return 0

    writes = 0
    if old_live:
        writes += apply_counter_keys(decrements, -1)
    elif decrements:
        logger.info(f"Not decrementing {len(decrements)} counter(s) on the aged-out {old_date}")
    if new_live:
        writes += apply_counter_keys(increments, 1)
    elif increments:
        # The half the `or` used to let through. These are unconditional writes, so
        # nothing but this branch stops them creating the day.
        logger.info(f"Not incrementing {len(increments)} counter(s) on the aged-out {new_date}")

    if moves_the_average:
        writes += _rebucket_average(old_date, old_score, old_live, new_date, new_score, new_live)

    logger.info(
        f"Rebucketed aggregates: {len(decrements)} decrement(s), "
        f"{len(increments)} increment(s), {writes} landed"
    )
    return writes


def _rebucket_average(
    old_date: str, old_score: Decimal, old_live: bool,
    new_date: str, new_score: Decimal, new_live: bool,
) -> int:
    """Move one item's contribution to the running average, as a PAIR.

    Split out because the pairing rule is the whole content: reverse first, and
    re-apply only if that reversal left the TARGET ROW able to accept it. A reversal
    refused against a row already at `count == 0` means that row is claiming no
    items, and adding the new score makes it claim one, at the edited score, that no
    feedback justifies. `get_summary` serves `sum/count` per date and weights it by
    count into the headline average, so that is served-data corruption rather than a
    skew nobody reads.

    THE PAIRING IS PER ROW, NOT PER EDIT. This is the correction to the first
    version, which consulted one `reversal_refused` flag however far apart the two
    writes were aimed. When `date` is edited the reversal and the re-application are
    writes to TWO DIFFERENT rows, and a refusal on the old day says nothing whatever
    about the new day's row — but the flag skipped it anyway, so the item vanished
    from the new day's average while all of its counters, `daily_total` included,
    moved onto that day. The two then describe different sets of items: exactly the
    split this pairing exists to prevent, relocated to the day that UNDERSTATES,
    since `get_summary` weights each date's average by its own count. So the
    re-application is blocked only when it targets the very row whose reversal was
    refused, which for a single row is the original rule unchanged.

    Three cases have NO reversal to pair with, and the increment is right in all:

      * an old score of zero contributed nothing to the average, so nothing was
        reversed and nothing is left dangling;
      * an aged-out old day was never asked (`old_live` is False). Its row is gone,
        so there is no half to be inconsistent with, and refusing the increment
        would lose the item from the metrics surface entirely — which is the
        count-dropping failure `_day_has_aggregates` exists to avoid;
    WHAT THIS RULE CANNOT SEE, since it is the failure direction of the rule itself:
    it learns that a row is gone only from a reversal AIMED AT THAT ROW. A cross-day
    edit's increment lands on a day no reversal touched, so an item arriving on a live
    day whose average row has expired still creates it holding one score — the same
    fragment, on the arrival side. Closing that needs evidence this module does not
    have: a live day with no average row is indistinguishable from a day taking its
    FIRST scored item, which must be created, and nothing in the two images tells them
    apart. It would need a per-day marker for "has ever held a scored item", i.e. new
    state. Recorded as a residual in the module docstring and pinned by
    `test_a_cross_day_arrival_onto_an_expired_average_still_fragments_it` so the note
    and the behaviour cannot drift apart.

    A REVERSAL THAT WAS REFUSED BLOCKS ITS OWN ROW EITHER WAY, and the reason the
    absent case is not the exception it looks like is the guard above: a reversal is
    attempted only when the OLD image carried a score, and `apply_feedback` writes
    the average whenever `sentiment_score` is set — so the insert did write this row,
    and finding it gone means it EXPIRED. Recreating it from the one edited item hands
    the date a `count == 1` average, which `get_summary` serves as that whole day's
    figure and weights by 1 against a `total_feedback` drawn from `daily_total` — a
    row collected from every item of the date. That is the one-score fragment
    `process_modified_feedback` calls the worst of them, and the day sentinel cannot
    see it: `daily_total`'s TTL is refreshed by every item while the average row's is
    refreshed only by scored ones, and TTL deletion is best-effort besides, so the
    two rows of one day expire independently and the day still reads live. Leaving no
    row is the honest outcome — an expired average is absent, and `get_summary` skips
    what is not there rather than reporting a wrong number for it.

    WHY THE COUNTERS ARE NOT PAIRED THIS WAY, though they look symmetrical: a
    refused counter decrement and its increment go to DIFFERENT keys (that is what
    makes them a symmetric difference), so each row is left internally consistent
    and the only cost is a bucket that reads one high and another one low. This row
    holds `sum` and `count` for the same day, and a split leaves the two describing
    different sets of items — a state no per-row floor can express, and the one
    `get_summary` divides. Pairing here and not there is that difference, not an
    inconsistency.

    Returns how many of the two writes landed.
    """
    landed = 0
    # The ROW whose reversal was refused, if any — not a bare flag, so a refusal on
    # one day cannot suppress a write aimed at another. `None` means no reversal was
    # refused: it landed, or none was attempted at all.
    blocked_row: str | None = None
    if old_score and old_live:
        if update_average(SENTIMENT_AVG_PK, old_date, old_score, sign=-1):
            landed += 1
        else:
            # Refused, whether by the floor or by the row being gone. Both mean this
            # row cannot take the re-application on its own — see the docstring.
            blocked_row = old_date

    if new_score and new_live:
        if new_date == blocked_row:
            # Same row, and its reversal was refused: applying alone would leave the
            # row claiming one item, at the edited score, that the day's real history
            # does not justify. Declined rather than attempted, so counted as such —
            # DynamoDB never sees this write and cannot refuse it on our behalf.
            _log_decline(
                're-application of the average', SENTIMENT_AVG_PK, new_date,
                f'its reversal on {old_date} was refused, so the row is either at '
                f'zero or expired, and applying the new score alone would leave it '
                f'claiming an item no present feedback justifies',
            )
        elif update_average(SENTIMENT_AVG_PK, new_date, new_score, sign=1):
            landed += 1
    return landed


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
    the table — see the metric constants at the top of this module. A rebucket emits
    nothing unless a write LANDED, so the count means "aggregates moved" rather than
    "a rebucket was attempted": `process_modified_feedback` returns writes that
    landed, and an edit whose every write was refused by its condition moved nothing
    while still being separately visible as REFUSED_METRIC.
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
