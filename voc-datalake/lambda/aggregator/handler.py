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

A reversal may also have to reverse a row THIS DEPLOY WOULD NOT HAVE WRITTEN. The
persona axis moved from `persona_name` to `persona_type`, and a decrement reads the
OLD IMAGE of an item whose insert may predate that move — so the row named by
today's derivation was never created for it, while the row that WAS created is left
inflated. The floor-and-existence condition means this cannot go negative or
resurrect anything, but it would leave a persistent over-count in one dimension for
every delete or edit of pre-deploy feedback. The ABSENT ROW is the evidence — a
refusal is two facts and only "there was no such row" is the trigger, never "the row
is sitting at its floor" — so the reversal path (and the decrement half of a
rebucket) follows an archetype decrement that found NO row with one conditional
write to the row the old derivation names. It is confined to the reversal direction,
needs no stored state and nothing configured, and is deletable once the pre-deploy
rows have aged out — see `LEGACY_PERSONA_FIELD` and
`_reverse_a_pre_deploy_persona_row`.

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
  drift. Repairing them means the rebuild-from-scan procedure recorded below.
* REDELIVERY IS CLOSED ON THE ARRIVAL PATH ONLY, and the asymmetry is a
  consequence of the conditions above rather than an unfinished job. Streams
  deliver at-least-once and the event source carries `retryAttempts: 3` with
  `reportBatchItemFailures: true`, so a batch that partially fails re-presents
  records whose writes already landed — permanently, since nothing recomputes a
  counter from source. An INSERT now claims the record's `eventID` in the shared
  idempotency table INSIDE the same `TransactWriteItems` as its counters
  (`apply_arrival_once`), which closes both halves at once: a redelivery moves
  nothing, and a record that dies partway leaves no partial application for the
  retry to land on top of.
  ⚠️ A REVERSAL (REMOVE, and the decrement half of a MODIFY) IS NOT TRANSACTED, so
  a redelivered one still decrements a second time. Not an omission: every
  decrement is a CONDITIONAL write whose refusal the code above it reads —
  `_reverse_a_pre_deploy_persona_row` triggers on `ROW_ABSENT`, `_rebucket_average`
  pairs on a refused reversal — and `TransactWriteItems` reports no per-item
  outcome, cancelling the whole transaction on one refused item instead. Moving
  them in would turn "this decrement had nothing to correct, so carry on" into
  "the edit wrote nothing at all", which silently disables the aged-out-day
  protections that exist BY observing a refusal. Closing it properly needs a
  dedupe claim that is not a transaction participant — a claim written first, then
  compensated if the writes fail — which is new failure machinery rather than a
  wider transaction, and it is out of scope here. What the conditions still
  guarantee for those paths is what they always did: no resurrected row, and no
  negative counter, with the tests in TestRedeliveryMovesACounterTwice pinning
  the reversal behaviour so this note and the code cannot drift apart.
* AN ARRIVAL COSTS MORE AND CONTENDS MORE THAN IT DID, which is the price of the
  point above and is recorded rather than hidden. DynamoDB bills a transactional
  write at TWICE the WCU of the same write sent alone, so an arrival's writes cost
  double what they did as independent `update_item` calls; the aggregates table is
  PAY_PER_REQUEST, so this is a bill and not a ceiling. And every record of a date
  moves `METRIC#daily_total`, so same-date records in one batch now CONTEND on it
  where two plain `update_item`s would simply have serialised — a bulk import
  through the `s3_import` plugin is exactly the shape that produces this. Bounded
  in three places, none of them accidental: the transaction is re-attempted in
  process with a jittered backoff (`TRANSACT_WRITE_ATTEMPTS`, and
  CONFLICTED_METRIC is what makes the rate visible), past that bound the stream
  redelivers, and the claim makes every one of those retries a no-op if an earlier
  attempt landed. So contention converges rather than losing records — but if
  CONFLICTED_METRIC climbs under import, the lever is the event source's
  `parallelizationFactor` and `batchSize` in
  `lib/stacks/processing-stack-consolidated.ts`, not a wider transaction.
* NO RECONCILIATION JOB. Nothing recomputes a stored aggregate from the feedback
  table, so drift already written stays written — the point above only stops new
  drift arriving. A rebuild has to write ABSOLUTE values rather than replay
  deltas: `if_not_exists(#field, :zero) + :inc` against a row that aged out of its
  90-day TTL recreates that row under a fresh TTL, so a replayed delta is exactly
  the negative-count resurrection the decrement condition exists to prevent. The
  procedure is written up in `docs/processing-pipeline.md` ("Rebuilding aggregates
  for a window") rather than shipped as a job, because it is a rare operator action
  on a table the API already reads and a scheduled job would be a new Lambda, a new
  role and a new schedule for it.
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
* THE PRE-DEPLOY PERSONA FALLBACK IS INERT ON A BUSY DAY. It triggers on the
  archetype decrement finding NO row, which is only observable on a day no
  post-deploy item has written that bucket. On a day the new axis has already
  populated it, a pre-deploy item's REMOVE decrements the archetype row it never
  contributed to, and the legacy row it did contribute to stays inflated until its
  90-day TTL. Exactly one counter still moves per deletion, which is the property
  that matters and the one a wall-clock trigger broke.
  ⚠️ NOT because the images cannot decide it. `processed_at` IS on the old image
  (the processor writes it, the stream is NEW_AND_OLD_IMAGES), so a module constant
  naming the axis-move instant plus EXCLUSIVE routing — legacy row or archetype
  row, never both — would be correct on a busy day, with no env var and no CDK
  change. It is not taken because it is not correct either, only differently
  wrong: it misreads an item written just before the deploy whose INSERT was
  aggregated just after it, and for that item it would skip the archetype
  decrement that IS holding its count, leaving that row inflated permanently
  rather than for 90 days. A date in the code buying a permanent error in place of
  an ageing one is the trade this declines — see
  `_reverse_a_pre_deploy_persona_row`.
* A REDELIVERED REMOVE DRAINS THE LEGACY PERSONA ROW AGAIN. The compatibility runs
  per reversal EVENT while the debt is per ITEM, and a refused decrement creates
  nothing, so the evidence is unchanged on the second delivery. The LEGITIMATE
  multi-reversal cases are bounded by the trigger itself (the first reversal's
  increment creates the archetype row, so later decrements land and never reach the
  fallback — measured in TestOneItemOwesOneLegacyDecrement); redelivery is not, and is
  accepted as an instance of the at-least-once residual above rather than closed for
  one row. Cost, exactly: the first drain per item moves toward the truth and any
  further one makes that row UNDERSTATE, bounded below by the floor.
* THE ABSENT ROW IS NOT PROOF OF VINTAGE, only of "no live row here". A
  post-deploy INSERT whose stream record never landed — a batch failure, a window
  where this function was erroring — leaves no archetype row either, so deleting
  that item aims one `-1` at the bucket its free-text name spells. Bounded by the
  same condition (at most one count, in a row that is ageing out), self-limiting
  once the legacy rows are gone, and strictly smaller than the over-count above.
"""
import os
import secrets
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from botocore.exceptions import ClientError

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, is_conditional_check_failure
from shared.idempotency import dedupe_claim_item
# The persona axis, declared in the data layer because BOTH sides of it spend the
# same values AND the same derivation — see the note above `counter_dimensions`.
from shared.feedback import (
    PERSONA_ARCHETYPES,
    PERSONA_PREFIX,
    # Not read by this module's code — `persona_bucket` is what spends it — but
    # re-exported here deliberately: the LEGACY_PERSONA_UNKNOWN comment's argument is
    # that the two empty-bucket spellings must differ, and a reader checking that
    # should find both names in one namespace.
    PERSONA_UNKNOWN,  # noqa: F401
    persona_bucket,
)

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

# Configuration
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

# The dedupe table for stream records (issue #264). Empty when the function has not
# been given it, which is not fatal: the aggregates are still written, exactly as
# they were before that change, and the warning below is what says the protection is
# off. The shared `processingRole` is already granted this table for the processor,
# so what an unset value really means is a CDK regression rather than a permission.
IDEMPOTENCY_TABLE = os.environ.get('IDEMPOTENCY_TABLE', '')
if not IDEMPOTENCY_TABLE:
    logger.warning(
        "IDEMPOTENCY_TABLE not configured - a redelivered stream record will move "
        "these counters a second time"
    )

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
# REPLAYED_METRIC is the one that says the dedupe claim EARNED its write. A stream
# record whose key was already claimed is a redelivery, which is ordinary and is
# supposed to happen — but "ordinary" is the reason it needs a metric rather than a
# reason it does not: at zero, the protection has never fired and a reviewer cannot
# tell a working guard from an inert one (the shape `_day_has_aggregates` logs at
# `error` for), and a spike is the batch failing and re-presenting records, which is
# the condition this change exists to make survivable. Distinct from REFUSED and
# DECLINED because it is neither a write DynamoDB rejected nor one this module
# declined to attempt: it is a whole record correctly doing nothing.
#
# CONFLICTED_METRIC counts a transaction re-attempted after contention, and it is the
# one metric here that measures a COST rather than a behaviour. Two records of the same
# date both move `METRIC#daily_total`, and a transaction cancelled by that contention is
# retried in process (see `_claimed_transaction`) — invisibly, since the retry then
# succeeds. So without this the trade the retry makes is unmeasurable: a rising count
# is contention the batch size or the parallelization factor is creating, and it is the
# number that says whether the bound of three attempts is still generous. Not folded
# into REFUSED_METRIC, which counts a condition DynamoDB was right to enforce; a
# conflict is nobody being wrong.
UPDATED_METRIC = "AggregatesUpdated"
REVERSED_METRIC = "AggregatesReversed"
REBUCKETED_METRIC = "AggregatesRebucketed"
REFUSED_METRIC = "AggregateWriteRefused"
DECLINED_METRIC = "AggregateWriteDeclined"
REPLAYED_METRIC = "AggregateRecordReplayed"
CONFLICTED_METRIC = "AggregateTransactionConflicted"

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

# --- Reversing an item whose INSERT ran before the persona axis moved ---------
# 🔑 THE ONE PLACE THE OLD PERSONA AXIS IS STILL READ, and only in the direction
# that cannot be got wrong by reading it.
#
# `counter_dimensions` is a single description spent by BOTH directions, which is
# what stops the increment and the decrement from drifting — but the decrement
# reads the OLD IMAGE of an item whose insert may have run under the previous
# deploy. That insert created `METRIC#persona#<persona_name, or Unknown>`; this
# deploy's decrement names `METRIC#persona#<persona_type>`, a row that item never
# contributed to. So the row today's derivation names was never created for it, while
# the row that WAS created is left inflated.
#
# What this is NOT: it cannot drive a counter negative or resurrect an expired row.
# Every decrement is guarded by `attribute_exists(pk) AND #field >= :floor`, so one
# aimed at an absent or already-zero row is refused, swallowed and counted as
# REFUSED_METRIC. No second clamp is needed anywhere, on either write.
#
# THE TRIGGER IS THE ARCHETYPE DECREMENT REPORTING `ROW_ABSENT` — the one outcome
# meaning NO counter moved for that bucket. No clock, no environment variable, no
# CDK change, no cutover date: nothing to configure, and nothing to un-configure
# later, since the fallback stops firing on its own as pre-deploy rows disappear.
# ⚠️ WHAT IT IS EVIDENCE OF is "no live row under this bucket", which is NOT the
# same fact as "this item's insert predates the axis move". They come apart when a
# post-deploy INSERT produced no row at all — a stream record lost to a batch
# failure, or a window where this function was erroring — and then the fallback
# aims one `-1` at the bucket that item's free-text name spells. Bounded by the
# same condition and self-limiting as the legacy rows expire; recorded with the
# other residuals in the module docstring rather than guarded against, because the
# guard would be the stored state this design is declining to add.
# WHEN IT IS SAFE TO DELETE IS STILL NOT A DATE, though: `update_counter` writes a
# fresh `#ttl` on every write, decrements included, so each compatibility write
# RENEWS the legacy row it touches for another 90 days. The signal that this is
# deletable is `AggregateWriteDeclined` and the log line below going quiet, not the
# calendar.
#
# THE RESIDUAL, unsoftened. An absent archetype row is available as evidence ONLY on
# a day no post-deploy item has written that bucket. On a day the new axis has
# populated it, a pre-deploy item's REMOVE decrements the archetype row — one it never
# contributed to — and the legacy row it did contribute to is never brought down,
# ageing out on its 90-day TTL. Accepted deliberately: exactly one counter moves per
# deletion either way, the property a wall-clock stamp broke. Deciding the busy day
# correctly is POSSIBLE — `processed_at` is on the old image — and declined anyway,
# because a constant naming the deploy instant is only differently wrong: it
# misreads an item written just before the deploy and aggregated just after it, and
# skips the archetype decrement that is really holding that item's count, leaving
# that row inflated permanently instead of for 90 days. A missed `-1` is the
# direction this module already errs in — see `process_deleted_feedback` on a
# dateless image — and an ageing error beats a permanent one.
#
# A permanent dual-READ on the INCREMENT path was rejected: this repo refused that
# shape once already, for the MCP legacy-token decision, where preserving a legacy
# path would have meant carrying a permanent extra field to serve a path with a
# sunset date.
LEGACY_PERSONA_FIELD = 'persona_name'
# The bespoke empty bucket the old derivation used — deliberately capitalised the
# way it was written, because this constant's whole job is to name rows that ALREADY
# EXIST. It is not a value anything writes fresh: `counter_dimensions` spells the
# empty bucket PERSONA_UNKNOWN, the enum's way.
#
# 🔑 THE CASE IS A CORRECTNESS PROPERTY, not only fidelity to how the old rows were
# spelled. `PERSONA_UNKNOWN` is `unknown`; unify the two and every reversal of an
# anonymous pre-deploy image — the majority shape — would decrement the LIVE
# `unknown` archetype row instead of the legacy bucket, which is the largest bucket
# on the current axis. The two are also not symmetric in kind: `unknown` is a value
# the enrichment contract declares, while `Unknown` was a label the old derivation
# invented, so the new one must never be substituted for the old. Unifying them was
# RUN, not predicted: the collision guard below then swallows the reversal entirely,
# because `unknown` IS an archetype, so the majority shape stops being reversed at
# all. Setting this to PERSONA_UNKNOWN fails
# test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current
# and test_an_edit_whose_only_landing_write_was_the_pre_deploy_compatibility_counts_as_nothing.
#
# The GENERAL form of that collision is closed by code rather than by this
# capitalisation. `_reverse_a_pre_deploy_persona_row` declines when the legacy value
# is a member of PERSONA_ARCHETYPES, and `persona_bucket` is what makes that set the
# whole space of rows this deploy writes — so a populated `persona_name` equal to any
# live bucket is refused too, which the capitalisation alone never covered.
LEGACY_PERSONA_UNKNOWN = 'Unknown'

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

# --- Contention on the rows every record of a date shares ----------------------
# 🔑 THE CODE DYNAMODB PUTS IN `CancellationReasons` FOR A CONTENDED ITEM, which is
# `TransactionConflict` — NOT the `TransactionConflictException` in the set above.
# Those are two spellings of one condition, one per API surface: the exception code on
# a plain request, the reason code inside a cancelled transaction. Neither is
# derivable from the other, so both are named, and this one is a constant because
# matching it wrongly is silent — an unmatched reason simply never retries, which
# looks exactly like a system under no contention.
TRANSACTION_CONFLICT_REASON = 'TransactionConflict'

# How many times an aggregate transaction is re-attempted in process, and how long it
# waits first. The reasoning is `_claimed_transaction`'s; the numbers are
# `ballots_handler`'s (BALLOT_WRITE_ATTEMPTS / BALLOT_WRITE_BACKOFF_SECONDS), and
# deliberately so — both are a small bounded budget for contention on ONE hot item,
# and there is no reason for this Lambda to make a different guess. Three attempts
# spans ~150ms of backoff at most, which is nothing against a 30-second batching
# window and far less than a stream redelivery of the whole batch.
TRANSACT_WRITE_ATTEMPTS = 3
TRANSACT_WRITE_BACKOFF_SECONDS = 0.05


class CounterWrite(Enum):
    """How one `update_counter` call ended.

    🔑 THREE OUTCOMES, NOT TWO, because "the write was refused" is two different
    facts and the difference is load-bearing for exactly one caller. A decrement's
    condition is `attribute_exists(pk) AND #field >= :floor`, so a refusal means
    EITHER there was no row at all OR the row is at zero, and
    `_reverse_a_pre_deploy_persona_row` must not act on the second: a row sitting at
    zero EXISTS, which is proof this deploy's derivation counted the item, so there
    is no legacy row owed a `-1`. A bool cannot carry that, which is what made the
    fallback fire on a redelivered REMOVE of an ordinary post-deploy item.

    DynamoDB is the one that knows, and it will say so for free:
    `ReturnValuesOnConditionCheckFailure='ALL_OLD'` returns the refused item, or no
    item when there was none. So the distinction is OBSERVED rather than inferred.

    WHAT THE ABSENT ROW IS FOR: it is what the pre-deploy persona fallback TRIGGERS
    on, being the only outcome that means no counter moved for that bucket. Its known
    limitation is that it is observable only on a day no post-deploy item has written
    the bucket — on a busier day a pre-deploy item's decrement LANDS on the archetype
    row it never contributed to and the legacy row it did contribute to is left
    inflated until its TTL. Accepted, and recorded as a residual: see
    `_reverse_a_pre_deploy_persona_row` and the module docstring.
    """

    LANDED = 'landed'
    # The row exists; the floor refused this decrement because the counter is at
    # zero. An ordinary outcome of a redelivered REMOVE, and a row that exists is a
    # row a counter for this bucket already sits in — so the pre-deploy fallback must
    # not add a second `-1` for one deletion, and no legacy row is owed anything.
    # Also the outcome of a refusal whose response could not be read, because this is
    # the one no caller acts on.
    REFUSED_AT_FLOOR = 'refused_at_floor'
    # There is no such row: `attribute_exists(pk)` failed, and DynamoDB said so with a
    # readable response carrying no item. Either it aged out under its TTL, or this
    # item's insert never created it — and the second is what the pre-deploy persona
    # fallback triggers on.
    ROW_ABSENT = 'row_absent'

    def __bool__(self) -> bool:
        """`LANDED` is truthy, both refusals falsy.

        So that `if update_counter(...)` keeps reading as "did it land?" at the call
        sites that only need that, and so that widening the return from a bool could
        not silently invert a caller that had not been updated.
        """
        return self is CounterWrite.LANDED


def get_metric_type(pk: str) -> str | None:
    """Extract metric type from pk for GSI indexing.

    The persona prefix comes from PERSONA_PREFIX rather than a literal: this tag is
    what puts the row on the `metric_type` GSI that both of `metrics_handler`'s
    aggregates branches query, so a prefix spelled here and differently where the pk
    is BUILT would leave every persona row untagged and the dimension empty with
    every count still computed correctly.
    """
    if pk.startswith('METRIC#daily_source#'):
        return 'source'
    elif pk.startswith(PERSONA_PREFIX):
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


def _counter_request(pk: str, sk: str, field: str, increment: int,
                     ttl_days: int) -> dict[str, Any]:
    """One counter movement, as `update_item` arguments.

    🔑 THE ONE PLACE A COUNTER'S UPDATE EXPRESSION IS WRITTEN, spent by both issuers:
    `update_counter`, which sends it on its own and reports how it ended, and
    `_counter_transaction_item`, which wraps the identical arguments for
    `TransactWriteItems`. The transaction is what makes an arrival's writes — one
    counter per dimension, plus the average — all-or-nothing (issue #264), and
    building its expression separately would have meant two copies of
    `if_not_exists(#field, :zero) + :inc`, with the drift landing on whichever path
    had fewer tests. That is exactly the failure mode `counter_dimensions` exists to
    prevent one level up.

    Both callers are inside this module, so the `Key`/`UpdateExpression` shape is the
    interface rather than the argument names: `transact_write_items` spells its
    fields the same way `update_item` does, which is what lets one dict serve both
    with a rename rather than a rebuild.

    THE RETURNED DICT IS COMPLETE AT THE LITERAL THAT BUILDS IT. The conditional
    half used to be added by mutating `attr_values` through the local alias after it
    had already been embedded, which worked (one object, two names) and meant the
    request was not described by the expression that constructs it. It is decided
    first and merged once now, because this is the single source of BOTH paths'
    counter expression and the transactional one cannot report a per-item outcome —
    so how it was assembled is the only thing a reader has to go on.
    """
    now = datetime.now(timezone.utc)
    ttl = int(now.timestamp() + ttl_days * 24 * 60 * 60)

    # Build update expression - include metric_type for GSI if applicable
    metric_type = get_metric_type(pk)
    metric_type_values = {':metric_type': metric_type} if metric_type else {}
    # A DEcrement may not create a row and may not go below zero — see
    # `update_counter`. Decided here rather than bolted on afterwards, so the
    # condition, its `:floor` and the refused-item request travel together.
    #
    # `ReturnValuesOnConditionCheckFailure` asks for the refused item, so a refusal
    # can say WHICH half of the condition failed. Only on the conditional path: an
    # increment carries no condition and so cannot be refused.
    conditional: dict[str, Any] = {
        'ConditionExpression': 'attribute_exists(pk) AND #field >= :floor',
        'ReturnValuesOnConditionCheckFailure': 'ALL_OLD',
    } if increment < 0 else {}
    floor_value = {':floor': -increment} if increment < 0 else {}

    return {
        'Key': {'pk': pk, 'sk': sk},
        'UpdateExpression': (
            'SET #field = if_not_exists(#field, :zero) + :inc, #ttl = :ttl, '
            'updated_at = :now'
            + (', metric_type = :metric_type' if metric_type else '')
        ),
        'ExpressionAttributeNames': {'#field': field, '#ttl': 'ttl'},
        'ExpressionAttributeValues': {
            ':inc': increment,
            ':zero': 0,
            ':ttl': ttl,
            ':now': now.isoformat(),
            **metric_type_values,
            **floor_value,
        },
        **conditional,
    }


def _average_request(pk: str, sk: str, value: Decimal, ttl_days: int,
                     sign: int) -> dict[str, Any]:
    """One movement of a running average, as `update_item` arguments.

    🔑 THE ONE PLACE THE AVERAGE'S UPDATE EXPRESSION IS WRITTEN, and the counterpart
    of `_counter_request` for the row that misleads most: `get_summary` divides
    `sum/count` per date and weights it into the headline `avg_sentiment`, so the two
    attributes have to move together or the day asserts an average no item justifies.

    Both issuers spend it — `update_average`, which sends it alone and reports whether
    it landed, and `_average_transaction_item`, which wraps it for
    `TransactWriteItems`. It was spelled out twice when the arrival path became
    transactional (issue #264), which put `#sum`/`#count`/`#ttl` in two places on
    paths with very different test coverage: the retention lockstep compared only the
    `ttl_days` defaults, so an attribute NAME could have drifted between the two
    writers with nothing failing, and a transactional row writing `total` where the
    reader looks for `sum` reads as a day with no average at all.

    `sign` carries the direction, exactly as `update_average`'s does: `:val` is
    negated for a reversal and `:one` IS the count movement, so `sign=-1` subtracts
    the score and decrements the count. The CONDITION for a reversal is the caller's
    to add — see `update_average`, which is the only issuer that may make a
    conditional average write, and `_average_transaction_item` for why a transaction
    may not.
    """
    now = datetime.now(timezone.utc)
    ttl = int(now.timestamp() + ttl_days * 24 * 60 * 60)
    return {
        'Key': {'pk': pk, 'sk': sk},
        'UpdateExpression': (
            'SET #sum = if_not_exists(#sum, :zero) + :val, '
            '#count = if_not_exists(#count, :zero) + :one, '
            '#ttl = :ttl, updated_at = :now'
        ),
        'ExpressionAttributeNames': {'#sum': 'sum', '#count': 'count', '#ttl': 'ttl'},
        'ExpressionAttributeValues': {
            ':val': value if sign > 0 else -value,
            ':one': sign,
            ':zero': Decimal('0'),
            ':ttl': ttl,
            ':now': now.isoformat(),
        },
    }


def update_counter(pk: str, sk: str, field: str, increment: int = 1,
                   ttl_days: int = 90) -> 'CounterWrite':
    """Atomically update a counter in the aggregates table.

    Returns HOW the write ended, as one of the three `CounterWrite` outcomes —
    landed, or refused for one of the two distinguishable reasons. Not a bool,
    because "refused" is two different facts and one caller has to tell them apart:
    see that enum. Callers that only need landed-or-not compare against
    `CounterWrite.LANDED`.

    A refusal is an ordinary outcome for a decrement and never happens to an
    increment (they carry no condition). Callers that must know the difference: the
    rebucket, whose two halves have to stand or fall together, and the metric that
    claims "aggregates moved" — a count of writes ATTEMPTED would make that claim
    false for an edit whose every write was refused.

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

    The floor is not idempotency, and this function is the path that does not have
    any: a redelivered REMOVE against a counter at 3 still lands on 2 and then 1.
    Redelivery is closed for ARRIVALS, by claiming the record's `eventID` in the same
    transaction as its writes — see `apply_arrival_once`, and the module docstring
    for why a conditional decrement cannot join that transaction.

    ConditionalCheckFailedException is therefore an expected, benign outcome of a
    decrement with nothing to decrement, and is swallowed (and counted).

    `ReturnValuesOnConditionCheckFailure='ALL_OLD'` is what makes the two refusals
    distinguishable: on a conditional failure DynamoDB returns the item it refused
    to write, or nothing at all if there was no item. That is the ONE authoritative
    answer to "was this row absent, or merely at the floor?", and it costs no extra
    request — see `CounterWrite.ROW_ABSENT` for the caller that needs it.

    A refusal whose response cannot be read is reported as `REFUSED_AT_FLOOR`, the
    outcome no caller acts on. `ROW_ABSENT` is a conclusion with a write attached, so
    it is drawn only from a readable response that positively lacks an item.

    THE EXPRESSION IS BUILT ELSEWHERE — `_counter_request` — because the INSERT path
    now sends the same writes as ONE `TransactWriteItems` and a transaction item
    carries the identical expression. Two spellings of `if_not_exists(#field, :zero)
    + :inc` would be two increments to keep in step, and the one that drifted would
    be the one no test covers. This function is the SINGLE-WRITE issuer of that
    request, and the only one that can report a per-key outcome: a transaction has no
    per-item outcome to report, which is why the conditional paths still come through
    here. See `apply_counter_keys`.
    """
    request = _counter_request(pk, sk, field, increment, ttl_days)
    conditional = 'ConditionExpression' in request

    try:
        aggregates_table.update_item(**request)
    except ClientError as e:
        if not conditional or not is_conditional_check_failure(e):
            raise
        _log_refusal(f'decrement of {field}', pk, sk)
        # WHICH half of the condition failed, when the response can be read.
        #
        # 🔑 `ROW_ABSENT` REQUIRES POSITIVE EVIDENCE, not the absence of evidence. It
        # is the conclusion a caller ACTS on, so an unreadable or unexpected payload
        # has to resolve to the do-nothing outcome instead. That is reachable rather
        # than theoretical: `is_conditional_check_failure` recognises this exception
        # by TYPE NAME as well as by code precisely because it arrives with no
        # `response` payload on some paths, and `e.response is None` would otherwise
        # have read as "there was no row" — the fail-OPEN direction, where open means
        # issuing a write. `_day_has_aggregates` fails open too but says so at
        # `error`; this one would have been silent.
        response = e.response if isinstance(e.response, Mapping) else None
        if response is not None and 'Item' not in response:
            # A well-formed conditional-failure response with no item: DynamoDB is
            # saying the row was not there. The one case that is real evidence.
            return CounterWrite.ROW_ABSENT
        return CounterWrite.REFUSED_AT_FLOOR
    return CounterWrite.LANDED


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

    THE EXPRESSION IS BUILT ELSEWHERE — `_average_request` — for the reason
    `update_counter`'s is: an arrival now sends the same movement as one
    `TransactWriteItems` entry, and two spellings of `if_not_exists(#sum, :zero) +
    :val` would be two sets of attribute names to keep in step, with `sum` and `count`
    being exactly the names `get_summary` reads back. This function is the SINGLE-WRITE
    issuer, and the only one that may make the write CONDITIONAL: a refusal is
    information `_rebucket_average` reads, and a transaction has no per-item outcome to
    report it with.
    """
    request = _average_request(pk, sk, value, ttl_days, sign)
    conditional = sign < 0
    if conditional:
        # A distinct :floor rather than reusing :one, which is -1 here.
        request['ConditionExpression'] = 'attribute_exists(pk) AND #count >= :floor'
        request['ExpressionAttributeValues'][':floor'] = 1

    try:
        aggregates_table.update_item(**request)
    except ClientError as e:
        if not conditional or not is_conditional_check_failure(e):
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
    This replaces a hardcoded `update_counter` call per dimension; an inverted copy
    of that list would have re-created the hazard on day one.

    URGENCY IS THE ONLY CONDITIONAL DIMENSION. Every other item below is appended
    unconditionally, because each read has a non-empty default — a reader asking
    "which of these might be absent?" gets one answer, not two. So this returns SEVEN
    dimensions for an urgent item and six otherwise; no docstring in this module states
    the number, deliberately, because the list below is designed to be extended and a
    count restated in prose is a fact that goes stale where nothing checks it.

    ⚠️ A SECOND DIMENSION ON AN EXISTING pk IS NOW A TRANSACTION-BREAKING CHANGE.
    `counter_keys` turns each entry into `(pk, date, field)`, and an arrival sends every
    one of them as an entry of a single `TransactWriteItems` — where DynamoDB rejects
    two operations on ONE item outright, failing the whole request. Two dimensions
    sharing a pk with different FIELDS are two distinct entries here and one DynamoDB
    item there, so adding such a pair would fail every ingested record rather than
    counting one dimension oddly. Harmless on the single-write reversal path, which
    issues them sequentially. `test_the_transaction_names_each_item_once` is the guard;
    a dimension on a NEW pk, which is what every entry below is, needs nothing.

    The persona bucket comes from `shared.feedback.persona_bucket`, the one
    derivation this Lambda and `metrics_handler`'s scan path share, and
    test_persona_field_lockstep.py pins the field it reads against the field
    `processor/handler.py` actually writes. Prose could not hold that: reading a
    different field here than the insert path read makes every DECREMENT miss the
    row its insert created, so the two must move together, and "fix it in one
    place" is only true while something fails when they diverge.

    THAT DERIVATION IS ALSO WHAT CLOSES THE AXIS. It buckets a value outside
    PERSONA_ARCHETYPES as PERSONA_UNKNOWN, so every persona row this deploy writes
    is named by a member of that set — which the reversal's collision guard relies
    on to tell a legacy row from a live one, and which nothing could guarantee while
    `persona_type` reached the pk verbatim. Review found a live `METRIC#persona#loyal`
    row (this repo's own fixtures use that value, and `PUT /data-explorer/feedback`
    accepts the field with no allowlist) decremented for an item counted elsewhere,
    precisely because the axis was open.

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

    That move is FORWARD-ONLY on the READ side. Rows already written keep their
    `Unknown` bucket, so a window spanning the deploy shows old `Unknown` alongside
    the new enum values; aggregate rows carry a 90-day TTL
    (`AGGREGATE_RETENTION_DAYS`), so the axis becomes fully correct within 90 days
    with no backfill. Nothing rewrites stored rows — a rewrite would have to
    re-derive each row from feedback the row no longer references.

    THE WRITE SIDE HAS ONE EXCEPTION, because forward-only is not enough there. A
    REMOVE (or the decrement half of a rebucket) reads the OLD IMAGE of an item
    whose insert may have run before this deploy, and that insert counted it under
    the row the OLD derivation names. A decrement derived from this function alone
    would therefore name a row the item never contributed to: the row its insert
    really created is never brought down and stays inflated for up to 90 days, while
    the archetype row is decremented for an item it never counted. `update_counter`
    keeps that from being worse than wrong-by-one — its
    `attribute_exists(pk) AND #field >= :floor` condition refuses a decrement
    against an absent or zeroed row, so no counter goes negative and no expired row
    is resurrected; the refusal is counted as REFUSED_METRIC. What tells the reversal
    that it is looking at such an item is that decrement finding NO row to move — see
    LEGACY_PERSONA_FIELD and `_reverse_a_pre_deploy_persona_row`, which is the whole
    of the compatibility, needs nothing configured, and is deletable once the
    pre-deploy rows have aged out.
    """
    source_platform = item.get('source_platform', 'unknown')
    category = item.get('category', 'other')
    sentiment_label = item.get('sentiment_label', 'neutral')
    urgency = item.get('urgency', 'low')
    # `persona_bucket`, the ONE derivation, shared with `metrics_handler`'s scan
    # path: it is what makes every row this deploy writes a member of
    # PERSONA_ARCHETYPES, which the reversal's collision guard depends on being a
    # fact rather than an expectation. See that function.
    persona = persona_bucket(item)

    dimensions = [
        # DAILY_TOTAL_PK, not the literal: `_day_has_aggregates` reads this same
        # constant as its sentinel, and its argument for doing so is that this line
        # is unconditional. Two spellings would leave that dependency unmarked.
        (DAILY_TOTAL_PK, 'count'),
        (f'METRIC#daily_source#{source_platform}', 'count'),
        (f'METRIC#daily_category#{category}', 'count'),
        (f'METRIC#daily_sentiment#{sentiment_label}', 'count'),
        # PERSONA_PREFIX, not the literal: `get_metric_type` tags this row for the
        # `metric_type` GSI by the same prefix and `metrics_handler` strips it back
        # off, across two Lambdas that cannot import each other.
        (f'{PERSONA_PREFIX}{persona}', 'count'),
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


def apply_counter_keys(
    keys: set[tuple[str, str, str]], sign: int,
) -> tuple[int, dict[tuple[str, str, str], 'CounterWrite']]:
    """Move every named counter by `sign`.

    The ONE place a counter key is unpacked into an `update_counter` call, so
    there is exactly one line in this module deciding what a counter's sort key
    is. Sorted only to make the write order deterministic for tests and logs.

    Returns `(writes that LANDED, how each key's write ended)`.

    Landed, not attempted: a caller counting attempts would report that aggregates
    moved for an edit whose every write was refused by its condition.

    🔑 THE OUTCOMES ARE RETURNED PER KEY, which is what lets the persona
    compatibility aim a follow-up write at the DAY the write it is correcting
    concerned — read out of the key rather than re-derived, so a follow-up can never
    land on another day. A count could not carry that. See
    `_reverse_a_pre_deploy_persona_row`.
    """
    landed, outcomes = 0, {}
    # Unpacked in the `for`, not from a `key` local, because
    # test_streaming_categories_lockstep.py pins the small set of expressions a
    # counter's sort key may be bound from — `sorted(keys)` is one of them and an
    # intermediate name is not, deliberately, since that is where a suffix could be
    # appended unnoticed.
    for pk, date, field in sorted(keys):
        outcome = update_counter(pk, date, field, increment=sign)
        outcomes[(pk, date, field)] = outcome
        if outcome is CounterWrite.LANDED:
            landed += 1
    return landed, outcomes


def counter_transaction_items(
    keys: set[tuple[str, str, str]],
) -> list[dict[str, Any]]:
    """Every named counter's INCREMENT, as `TransactWriteItems` entries.

    `apply_counter_keys`' counterpart for the transactional path, and it is a
    FUNCTION rather than a comprehension at the call site for the same reason that one
    is: it is the ONE place a counter key is unpacked into a transactional write, so
    there is exactly one line here deciding what a counter's sort key is.

    NO `sign`, and that is the scope of the whole transactional path made structural.
    It took one until review pointed out that the parameter was only half honoured —
    threaded into the counters and dropped for the average, which hardcodes `+1` — so
    a `sign=-1` call decremented every counter while INCREMENTING the average, and the
    transaction then guaranteed that inconsistent state committed whole. Taking the
    parameter away is what makes "reversals do not come through here" a fact about the
    signature rather than a sentence in a docstring; see `apply_arrival_once` for why
    a conditional decrement cannot join a transaction at all.

    🔑 THE UNPACKING IS SPELLED `for pk, date, field in sorted(keys)` DELIBERATELY.
    `test_streaming_categories_lockstep.py` pins the small set of expressions a
    counter's sort key may be bound from, because the streaming reader sums a window
    with `sk BETWEEN :oldest AND :newest` and a composite sort key sorts INSIDE a date
    window it is unrelated to. That lockstep reads the name `date` bound from
    `sorted(keys)`; writing this as a comprehension over `date_` (which it was first)
    would have left this path's sort keys outside the guard entirely — a second,
    unpinned way to key a counter, which is exactly the drift the guard exists to
    catch. Sorted for the same reason `apply_counter_keys` sorts: a deterministic
    order for tests and logs, and here it also fixes which item a cancellation reason
    refers to.

    ⚠️ ONE ENTRY PER `(pk, sk)`, WHICH IS DYNAMODB'S RULE AND NOT A PREFERENCE. See
    `_claimed_transaction`; `counter_dimensions` is the function that decides it, and
    `test_the_transaction_names_each_item_once` fails if it stops holding.
    """
    return [_counter_transaction_item(pk, date, field)
            for pk, date, field in sorted(keys)]


def _counter_transaction_item(pk: str, sk: str, field: str, increment: int = 1,
                              ttl_days: int = 90) -> dict[str, Any]:
    """One counter INCREMENT as a `TransactWriteItems` entry.

    The same request `update_counter` issues on its own — `_counter_request` builds
    it, so the expression exists once, including the `metric_type` tag the
    `gsi1-by-metric-type` GSI needs on the source and persona rows — with the table
    name added and the whole thing wrapped in the `{'Update': ...}` shape the
    transaction API takes.

    `increment` defaults to 1 and every caller leaves it there. It is still a
    parameter because `_counter_request` reads its SIGN to decide whether the write
    carries the floor condition, and a builder that could not express that would have
    to re-derive the condition rather than forward it — but a NEGATIVE value must not
    reach here, and `counter_transaction_items` no longer offers a way to pass one.
    See `apply_arrival_once`: a decrement's refusal is information, and a transaction
    cannot report it.

    `ttl_days` defaults here as it does on every other writer, and
    `test_aggregate_retention_lockstep.py` reads the default of all four writers
    because every one of them stamps a row's TTL from its own copy of the number.
    """
    return {'Update': {'TableName': AGGREGATES_TABLE,
                       **_counter_request(pk, sk, field, increment, ttl_days)}}


def _average_transaction_item(pk: str, sk: str, value: Decimal,
                              ttl_days: int = 90) -> dict[str, Any]:
    """The running average's INCREMENT half as a `TransactWriteItems` entry.

    Increment only, and that is a scope statement rather than an omission — enforced
    by taking no `sign` at all rather than by this paragraph. The transaction exists
    for the arrival path, whose average write is unconditional; every DECREMENT of the
    average is a conditional write whose refusal `_rebucket_average` has to observe to
    decide the pairing, and a transaction reports no per-item outcome — a refused item
    cancels the whole transaction instead. Putting a reversal in here would therefore
    replace a rule that reads "the reversal was refused, so do not re-apply" with "the
    edit wrote nothing at all", which is a different behaviour and not the one that
    class pins.

    The expression is `update_average`'s because `_average_request` builds both: the
    `sum`/`count` attribute names are what `get_summary` reads back, so a second
    spelling of them here would be free to drift into a row the read path cannot see —
    the retention lockstep compares the TTL defaults and would not have noticed.
    `sign=1` is passed as the literal it is, since this path has no other direction.
    """
    return {'Update': {'TableName': AGGREGATES_TABLE,
                       **_average_request(pk, sk, value, ttl_days, 1)}}


def _claimed_transaction(dedupe_key: str, items: list[dict[str, Any]]) -> bool:
    """Apply `items` and claim `dedupe_key`, together or not at all.

    🔑 THE WHOLE OF THE IDEMPOTENCY, and it is one request. The marker's `Put` carries
    `attribute_not_exists(id)`, so on a SECOND delivery of the same stream record that
    item is refused — and a refused item cancels the entire transaction, leaving every
    counter in it exactly where the first delivery left it. On a FIRST delivery
    everything commits at once, so there is no window in which some counters have
    moved and the record is not yet recorded as applied.

    That second property is the one the floor could never give. `retryAttempts: 3`
    with `reportBatchItemFailures: true` means a record that dies on its fifth write
    comes back with four applied, and those four are a daily total that no longer
    equals the sum of its per-category counts — permanently, since nothing recomputes
    a counter from source. Transacting them removes the partial state itself rather
    than compensating for it, which is why this is a transaction and not just a
    marker: a marker alone still leaves the half-applied record, and would then
    RECORD it as done.

    Returns whether the writes were applied. False means the key was already claimed,
    which is the ordinary redelivery outcome and not an error. Any other cancellation
    reason is re-raised, because the batch processor reporting the record failed is
    what gets it retried — and a transaction that failed for a reason this function
    cannot name has NOT applied anything, so a retry is the correct response.

    🔑 A `TransactionConflict` IS RE-ATTEMPTED IN PROCESS, up to
    `TRANSACT_WRITE_ATTEMPTS` times with a jittered backoff, and this is the one place
    the aggregator's calculus is worth stating because `ballots_handler._write_ballot`
    reaches the same conclusion from the same DynamoDB fact for its own reasons.
    `METRIC#daily_total` is written by EVERY record of a date, `batchSize` is 100, and
    botocore does NOT auto-retry `TransactionCanceledException` (only
    `TransactionInProgressException` and `ReplicatedWriteConflictException` carry retry
    policies), so contention that a plain `update_item` used to absorb invisibly at the
    request level now arrives here as a cancellation. Left to propagate it becomes a
    reported record failure, and the record has only the event source's
    `retryAttempts: 3` left before it is DROPPED and its aggregates lost for good —
    which is strictly worse than the double-count this whole change exists to remove.
    Retrying is safe by construction: nothing was written, and if a concurrent attempt
    of the SAME record landed, the claim refuses the re-attempt. Bounded and jittered
    rather than unbounded, because a Lambda holding concurrency in a tight loop is its
    own outage; past the bound the record is reported failed and the stream redelivers,
    which the claim also makes safe. CONFLICTED_METRIC is what makes the contention
    observable rather than merely survivable.

    ⚠️ EVERY ITEM MUST NAME A DIFFERENT `(pk, sk)`. DynamoDB rejects a transaction
    containing two operations on ONE item with a `ValidationException` — the whole
    request, so every ingested record would fail, an outage rather than a drift — and
    what decides it is `counter_dimensions`: `counter_keys` returns `(pk, date, field)`
    tuples, so two dimensions sharing a pk with DIFFERENT fields deduplicate to two set
    members naming one DynamoDB item. Harmless on the single-write path (two sequential
    `update_item`s), fatal here. Today every dimension names its pk once;
    `test_the_transaction_names_each_item_once` is what fails if a new one stops doing
    so, rather than production.

    The 100-item cap, by contrast, is NOT reachable and is not defended against: one
    record produces one counter per dimension, plus the average, plus the marker. A
    batch is applied one record at a time, deliberately, since the alternative would
    make one poison record fail every other record's writes with it.
    """
    for attempt in range(TRANSACT_WRITE_ATTEMPTS):
        now = int(datetime.now(timezone.utc).timestamp())
        try:
            aggregates_table.meta.client.transact_write_items(
                # The claim FIRST, so that a cancellation naming index 0 is the
                # redelivery case and the reasons list lines up with `items` from 1.
                TransactItems=[
                    dedupe_claim_item(IDEMPOTENCY_TABLE, dedupe_key, now), *items,
                ],
            )
        except ClientError as e:
            if _claim_was_refused(e):
                logger.info(
                    f"Stream record {dedupe_key} was already applied; leaving "
                    f"{len(items)} aggregate write(s) alone"
                )
                metrics.add_metric(name=REPLAYED_METRIC, unit="Count", value=1)
                return False
            if _conflicted(e) and attempt + 1 < TRANSACT_WRITE_ATTEMPTS:
                # Logged BEFORE the sleep, as `_write_ballot` logs its own: the line
                # records the DECISION to re-attempt, and someone timing a slow record
                # should see it at the moment the wait began rather than after it.
                metrics.add_metric(name=CONFLICTED_METRIC, unit="Count", value=1)
                logger.warning(
                    f"Aggregate transaction for {dedupe_key} hit a write conflict; "
                    f"retrying (attempt {attempt + 2} of {TRANSACT_WRITE_ATTEMPTS})"
                )
                delay = TRANSACT_WRITE_BACKOFF_SECONDS * (2 ** attempt)
                # Jittered, so records that collided once do not re-collide having
                # waited the same interval.
                time.sleep(delay * (0.5 + secrets.randbelow(500) / 1000))
                continue
            raise
        return True
    # UNREACHABLE while TRANSACT_WRITE_ATTEMPTS >= 1, and kept because falling out of
    # this loop would be INDISTINGUISHABLE FROM A REDELIVERY: `False` here means "the
    # record was already applied", which `record_handler` reports as a success and
    # never retries — so a bound of 0 would silently drop every record's aggregates
    # while reporting the batch clean.
    # `test_the_attempt_bound_leaves_at_least_one_attempt` pins the bound; this is the
    # guard for the case where it stops holding anyway.
    raise RuntimeError(
        'TRANSACT_WRITE_ATTEMPTS is not at least 1, so no aggregate transaction was '
        'attempted. Raising rather than reporting a record that was never applied.'
    )


def _claim_was_refused(error: ClientError) -> bool:
    """Was this cancellation the dedupe claim, or something else?

    The distinction decides whether the record is DONE or has to be retried, so it is
    drawn from the claim's own cancellation reason rather than from the exception
    being a cancellation at all. A transaction can also be cancelled by a
    TransactionConflictException on a counter row (two records of the same day
    arriving together, which is ordinary), and calling that "already applied" would
    silently drop a record's aggregates: nothing was written, and reporting success
    means nothing ever will be.

    The claim is item 0 by construction — see `_claimed_transaction` — and its reason
    is `ConditionalCheckFailed` when and only when the key was already there.
    Cancellation reasons are positional and complete, so index 0 is the claim's.

    A cancellation whose reasons cannot be read is NOT treated as a refused claim.
    That is the fail-toward-retry direction: a retry of an unapplied record is
    correct, and a retry of an applied one is refused by the claim it already holds —
    so being wrong here costs nothing, whereas the other direction would drop
    aggregates on any response shape this could not parse.
    """
    response = error.response if isinstance(error.response, Mapping) else None
    if response is None:
        return False
    if (response.get('Error') or {}).get('Code') != 'TransactionCanceledException':
        return False
    reasons = response.get('CancellationReasons')
    if not isinstance(reasons, list) or not reasons:
        return False
    first = reasons[0]
    return isinstance(first, Mapping) and first.get('Code') == 'ConditionalCheckFailed'


def _conflicted(error: ClientError) -> bool:
    """Was this cancellation contention on one of the rows, and nothing else?

    The one cancellation worth re-attempting in process, and the reason is that it is
    ORDINARY rather than exceptional: every record of a date moves
    `METRIC#daily_total`, so same-day records arriving in one batch contend by design.
    Read from the reasons rather than from the exception, exactly as
    `_claim_was_refused` is, because the decision it drives is different — a retry
    versus reporting the record failed — and only one code licenses it.

    ANY reason being unreadable answers False, which routes to the raise. That is the
    same fail-toward-the-stream direction the claim check takes: the stream redelivers
    and the claim makes that safe, so declining to retry costs a round trip, while
    retrying a cancellation this cannot name would spend the invocation's time on a
    request that will fail identically (a `ValidationException` does not become valid).

    `_TRANSIENT_READ_ERRORS` already names `TransactionConflictException` for the day
    read; the spelling HERE is the reason code DynamoDB puts in `CancellationReasons`,
    which is `TransactionConflict` without the suffix — two different strings for the
    same condition, one per API surface, which is why neither can be derived from the
    other.
    """
    response = error.response if isinstance(error.response, Mapping) else None
    if response is None:
        return False
    if (response.get('Error') or {}).get('Code') != 'TransactionCanceledException':
        return False
    reasons = response.get('CancellationReasons')
    if not isinstance(reasons, list) or not reasons:
        return False
    return any(isinstance(reason, Mapping)
               and reason.get('Code') == TRANSACTION_CONFLICT_REASON
               for reason in reasons)


def _reverse_a_pre_deploy_persona_row(
    item: dict, outcomes: dict[tuple[str, str, str], 'CounterWrite'],
) -> int:
    """Bring down the persona row an item's PRE-DEPLOY insert really created.

    The whole of the persona axis's write-side compatibility, and the only place
    LEGACY_PERSONA_FIELD is read. See that constant for the argument; the mechanism
    is:

    `counter_dimensions` is one description spent by both directions, so a reversal
    names `METRIC#persona#<archetype>`. For an item inserted before the axis moved,
    that row is not the one its insert created — the insert counted it under the old
    derivation's bucket — so the reversal follows the archetype decrement with one
    conditional write to the row the old derivation names, on the DAY the decrement
    concerned (read out of the key, not re-derived, so a follow-up can never land on
    another day).

    🔑 THE TRIGGER IS THAT DECREMENT REPORTING `ROW_ABSENT`. It is the only outcome
    that means NO counter moved for the bucket, so it is at once the evidence that
    this deploy's derivation never counted the item and what holds one deletion to one
    decrement. Its two limitations are named rather than hidden, and both are recorded
    as residuals in the module docstring: an absent row is observable only on a day no
    post-deploy item has written the bucket, so on a busy day a pre-deploy item's
    decrement lands on the archetype row and the legacy row stays inflated until its
    TTL; and an absent row means "no live row here" rather than "this insert was
    pre-deploy", so a post-deploy INSERT that never reached this function makes its
    item look pre-deploy on deletion.

    NOTHING IS ATTEMPTED AGAINST A ROW THIS DEPLOY WRITES. `legacy_pk` is built from a
    free-text, LLM-produced name — the one pk in this module not derived from a closed
    value space — and a name equal to a bucket this deploy writes would aim this `-1`
    at a LIVE row for an item counted under a different archetype. Conditional writes
    cannot catch that: the row exists and is above the floor, so it lands cleanly and
    corrupts a current number. PERSONA_ARCHETYPES is the whole space of rows this
    deploy writes — `persona_bucket` is what makes that true, by bucketing anything
    outside the set as the empty value — so membership is a complete test, which it
    was not while `persona_type` reached the pk verbatim. A missed legacy `-1` is the
    right way to be wrong here, the judgement `process_deleted_feedback` already makes
    for a dateless image.

    It is CONDITIONAL like every other decrement, so the compatibility cannot
    resurrect a legacy row or drive one negative: if the old row has also aged out,
    this is refused in turn and counted as REFUSED_METRIC.

    🔑 ONE ITEM OWES ONE `-1`, AND THE TRIGGER BOUNDS THE LEGITIMATE CASES BY
    CONSTRUCTION. This runs per reversal EVENT, while the debt is per ITEM — and one
    item can be reversed many times (each edit that changes its archetype or date, then
    its delete). It settles once anyway: the first reversal's INCREMENT creates the
    archetype row for the item's new bucket, so every later decrement of that row LANDS
    and never reaches here. Nothing was added to get that; it falls out of triggering on
    "no counter moved" rather than on a fact about the item. Measured against moto in
    TestOneItemOwesOneLegacyDecrement — three successive edits drain the legacy row
    ONCE, and an edit followed by the delete once.

    ⚠️ REDELIVERY IS THE EXCEPTION, and is accepted rather than closed. A refused
    decrement creates nothing, so a redelivered REMOVE sees `ROW_ABSENT` again and
    decrements the legacy row again — N deliveries, N writes. That is the module's
    general at-least-once residual rather than one this path invents (every counter here
    behaves the same way; see the module docstring, and closing it means routing
    `eventID` through `shared/idempotency.py`, a CDK change as well as a code one), so
    fixing it for this row alone would be a special case of a module-wide gap.
    Its cost, stated exactly: the direction is toward the truth for the FIRST drain of
    each item only. Past that the legacy row UNDERSTATES — it is bounded below by the
    floor, never negative, but it is a row `/metrics/personas` still serves for a window
    overlapping the move.

    Returns how many writes landed.
    """
    # 🔑 ONLY THE PERSONA KEYS WHOSE WRITE FOUND NO ROW. `ROW_ABSENT` is the one
    # outcome that means NO counter moved for this bucket, so it is at once the
    # evidence that this deploy's derivation never counted the item AND what keeps one
    # deletion to one decrement. The other two are excluded for the same reason:
    # `LANDED` means a counter already moved for this bucket, and `REFUSED_AT_FLOOR`
    # means the row exists at zero (the redelivered-REMOVE shape) — so in both cases a
    # row exists under the archetype bucket, and a second `-1` would take two counts
    # off one deletion.
    #
    # `sorted` below because these ARE counter keys and
    # test_streaming_categories_lockstep.py pins the small set of expressions allowed
    # to produce a counter's sort key — the bare item date, never anything composite,
    # because the streaming reader sums a window with `sk BETWEEN`.
    keys = {key for key in outcomes
            if key[0].startswith(PERSONA_PREFIX)
            and outcomes[key] is CounterWrite.ROW_ABSENT}
    if not keys:
        return 0

    # The old derivation, reproduced exactly — including its bespoke `Unknown`,
    # which is a row name that already EXISTS rather than one anything writes fresh.
    legacy_value = item.get(LEGACY_PERSONA_FIELD) or LEGACY_PERSONA_UNKNOWN
    # The earliest day the reversal concerned, so a log or a decline names a real day
    # rather than one recomputed here. `min` over the DATES, not over the keys: `min`
    # on (pk, date, field) tuples orders by pk first, which is the day belonging to
    # the smallest pk and not the earliest day at all.
    earliest_day = min(date for _, date, _ in keys)
    if legacy_value in PERSONA_ARCHETYPES:
        # A free-text name that collides with the current value space. This deploy
        # writes that row, so a `-1` on it is a live number corrupted rather than a
        # legacy one corrected — and it cannot be told apart from a legitimate
        # legacy row by anything at this point. Declined, and counted as such: a
        # write never issued gives DynamoDB nothing to refuse, so REFUSED_METRIC
        # could not see it.
        _log_decline(
            'the pre-deploy persona reversal', f'{PERSONA_PREFIX}{legacy_value}',
            earliest_day,
            f'`{LEGACY_PERSONA_FIELD}` is `{legacy_value}`, which is one of the '
            f'archetypes this deploy actively writes, so that row cannot be '
            f'distinguished from a live one and must not be decremented',
        )
        return 0

    legacy_pk = f'{PERSONA_PREFIX}{legacy_value}'
    landed = 0
    for pk, date, field in sorted(keys):
        logger.info(
            f"Persona decrement on {pk}/{date} found no row, so this item's insert "
            f"ran before the axis moved; also reversing {legacy_pk}, the row it created"
        )
        if update_counter(legacy_pk, date, field, increment=-1):
            landed += 1
    return landed


def apply_arrival_once(item: dict, date: str, dedupe_key: str) -> bool:
    """One ARRIVAL's every write, in ONE transaction keyed on `dedupe_key`.

    🔑 THE PATH THAT IS IDEMPOTENT, and it is the arrival path because that is the one
    whose writes are all unconditional and so can all be transacted. Two properties,
    and the acceptance criteria of issue #264 name both:

    * A REDELIVERED RECORD MOVES NOTHING. The claim's `attribute_not_exists` refuses,
      the transaction cancels, and every counter stays where the first delivery left
      it — where the floor at zero could only ever no-op a decrement that was already
      at zero.
    * A RECORD THAT FAILED PARTWAY LEAVES NOTHING PARTIAL. One counter per dimension
      plus the average commit at once, so a daily total can never disagree with the sum
      of its per-category counts. This is the half a marker alone does not fix: a
      marker written before the writes records a half-applied record as done, and one
      written after leaves the half-application to be re-applied on top.

    Returns whether the writes were applied — False for a redelivery, which is a
    success from the batch processor's point of view and must not be reported as a
    failed record (that would redeliver it forever).

    🔑 NAMED FOR THE ARRIVAL, AND TAKES NO `sign`, WHICH IS THE POINT OF THE NAME. It
    was `apply_feedback_once(item, sign, ...)` and threaded that sign into the counters
    while the average builder hardcoded `+1` — so a `sign=-1` call decremented every
    counter, INCREMENTED the average, and the transaction then guaranteed the
    inconsistent state committed whole: strictly worse than the non-transactional split
    it exists to prevent. Nothing raised, because a half-honoured parameter has nothing
    to raise about. The paragraph below always said reversals must not come through
    here; the signature now says it too, which is the difference between a rule and a
    note, and the next person to attempt transacting a reversal meets a missing
    argument rather than a green test suite.

    THE REVERSAL PATHS DO NOT COME THROUGH HERE, and that is a scope decision rather
    than an oversight. Every decrement is a conditional write whose refusal the code
    ABOVE it reads — `_reverse_a_pre_deploy_persona_row` triggers on `ROW_ABSENT`, and
    `_rebucket_average` pairs on a refused reversal — and a transaction reports no
    per-item outcome: one refused item cancels the whole thing. Transacting them would
    replace "this decrement had nothing to correct, so carry on" with "the edit wrote
    nothing at all", which is a different behaviour from the one those classes pin,
    and it would silently disable the aged-out-day protections that depend on
    observing a refusal. What those paths keep is the floor-and-existence guard they
    already had; what they do not get is redelivery protection, which is recorded as a
    residual in the module docstring rather than half-implemented here.
    """
    items = counter_transaction_items(counter_keys(item, date))

    sentiment_score = _image_score(item)
    if sentiment_score:
        items.append(_average_transaction_item(SENTIMENT_AVG_PK, date, sentiment_score))

    if not _claimed_transaction(dedupe_key, items):
        return False

    logger.info(
        f"Updated aggregates for source={item.get('source_platform', 'unknown')}, "
        f"category={item.get('category', 'other')}"
    )
    return True


def apply_feedback(item: dict, sign: int, date: str):
    """Add (`sign=1`) or reverse (`sign=-1`) one item's contribution on `date`.

    The NON-transactional issuer, now reached only by the reversal paths — see
    `apply_arrival_once` for which writes may be transacted and why a decrement may
    not be. Kept as one function serving both signs because the shared description in
    `counter_dimensions` is what stops the two directions drifting, and that argument
    is about the DIMENSIONS rather than about how the writes are issued.
    """
    _, outcomes = apply_counter_keys(counter_keys(item, date), sign)
    if sign < 0:
        # Reversal only. Reading the old persona field on the INCREMENT path would
        # make the axis permanently dual-SOURCED to serve a path with a sunset date,
        # which this repo has rejected before; on the reversal it can only change
        # which row a `-1` lands on, never which bucket anything is COUNTED in. See
        # `_reverse_a_pre_deploy_persona_row`.
        _reverse_a_pre_deploy_persona_row(item, outcomes)

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
def process_new_feedback(item: dict, dedupe_key: str | None = None) -> bool:
    """Update aggregates for a new feedback item.

    Returns whether the writes were applied. False means this stream record had
    already been applied, which is a redelivery and an ordinary success.

    `dedupe_key` is the stream record's `eventID`, unique per record, and it is what
    makes this path idempotent — see `apply_arrival_once`. It is OPTIONAL, and None
    routes to the non-transactional path deliberately: the function must still work
    when `IDEMPOTENCY_TABLE` is unset (a CDK regression must degrade to the pre-#264
    behaviour rather than stop aggregating), and the two dozen callers in the test
    suite that ask "which counters does an arrival move?" are asking a question the
    dedupe key is not part of.
    """
    date = _image_date(item)
    if dedupe_key and IDEMPOTENCY_TABLE:
        return apply_arrival_once(item, date, dedupe_key)
    apply_feedback(item, 1, date)
    return True


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
        landed, outcomes = apply_counter_keys(decrements, -1)
        writes += landed
        # The same pre-deploy compatibility the REMOVE path gets, for the same
        # reason: this decrement reads an OLD IMAGE, which may be an image whose
        # insert ran before the persona axis moved. It is reached only by an edit
        # that CHANGES the archetype (or the date) — an edit leaving `persona_type`
        # alone cancels in the symmetric difference and issues no persona write at
        # all, so there is nothing to be refused. Derived from `old_item`, because
        # the row to bring down is the one the OLD image's insert created.
        #
        # 🔑 DELIBERATELY NOT ADDED TO `writes`, which is this function's claim that
        # THIS EDIT moved aggregates — `record_handler` gates REBUCKETED_METRIC on
        # it. This write is not one the edit asked for: it corrects a row a previous
        # deploy created. Folding it in would let that metric fire for an edit whose
        # own decrements and increments were every one refused, which is the same
        # distinction DECLINED_METRIC and REFUSED_METRIC exist to keep — a metric
        # that gates on a count is a consumer of the count, not just a reader.
        # Logged instead, so the compatibility is observable without being conflated.
        compatibility_writes = _reverse_a_pre_deploy_persona_row(old_item, outcomes)
        if compatibility_writes:
            logger.info(
                f"Also brought down {compatibility_writes} pre-deploy persona row(s) "
                f"for this edit; not counted as aggregates the edit itself moved"
            )
    elif decrements:
        logger.info(f"Not decrementing {len(decrements)} counter(s) on the aged-out {old_date}")
    if new_live:
        writes += apply_counter_keys(increments, 1)[0]
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


def _dedupe_key(record: DynamoDBRecord) -> str | None:
    """The identity of ONE stream record, for the dedupe claim (issue #264).

    `eventID` is the right field: the stream API documents it as a unique identifier
    for the record, so a redelivery of the SAME record carries the SAME value while
    two genuinely different edits of one item do not — which `sequence_number` also
    gives, and which the feedback_id could not (an item edited twice would look like
    one record and the second edit would be dropped).

    NAMESPACED, because the idempotency table is shared with the processor, whose keys
    are `{source_platform}:{source_id}`. A prefix is what keeps a stream `eventID`
    from ever being mistaken for one of those, and keeps this Lambda's markers
    identifiable in a table two functions write to.

    Read from `raw_event` for the reason `_event_name` is: it is the EVENT's field, and
    the older tests build records from raw dicts. Returns None when the record carries
    no readable id — in which case the caller applies the writes non-transactionally
    rather than dropping them. That is the fail-open direction, and it is the same one
    `is_ttl_expiry` and `_day_has_aggregates` take: aggregating a record twice is
    recoverable, never aggregating it is not.
    """
    raw = getattr(record, 'raw_event', None)
    if not isinstance(raw, Mapping):
        return None
    event_id = raw.get('eventID')
    return f'aggregator#stream#{event_id}' if isinstance(event_id, str) and event_id else None


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
    if not process_new_feedback(item, _dedupe_key(record)):
        # Already applied by an earlier delivery of this same record. A SUCCESS, and
        # emphatically not a failure: reporting it failed under
        # `reportBatchItemFailures: true` would redeliver it until it aged out of the
        # stream, and Streams preserve per-shard order, so that record would block its
        # partition. UPDATED_METRIC is not emitted either — nothing was updated, and a
        # metric claiming otherwise is what made the original bug invisible.
        return {"status": "skipped", "reason": "already applied"}
    metrics.add_metric(name=UPDATED_METRIC, unit="Count", value=1)

    return {"status": "success"}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for DynamoDB Streams."""
    return processor.response()
