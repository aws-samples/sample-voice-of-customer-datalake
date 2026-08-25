"""Tests for aggregator/handler.py

Tests the core aggregation functions:
- update_counter()
- update_average()
- process_new_feedback()
- record_handler()

The stream consumer used to count only INSERTs, so every aggregate held items
EVER inserted and never came back down — `get_metrics_summary` (aggregates) and
`search_feedback` (scan) then reported different totals for the same window.
Handling REMOVE and MODIFY is the fix, and the classes below pin the three
decisions inside it that a naive implementation gets wrong. The revert map:

  TestTtlExpiryLeavesHistoryAlone
    — the feedback table expires items at 365 days while aggregate rows expire at
      90, so a TTL REMOVE always concerns a date whose row is already gone.
      Deleting the `is_ttl_expiry` skip in `record_handler` fails
      `test_a_ttl_expiry_writes_nothing_at_all`; its sibling
      `test_a_user_delete_of_the_same_item_does_write` is the positive control,
      so the pair cannot both pass by the mock being inert.
      `test_a_remove_with_no_user_identity_is_treated_as_a_user_delete` pins the
      chosen direction for an unreadable identity; inverting that default fails
      it.

  TestADeleteReversesExactlyWhatTheInsertAdded
    — derives both write sets from the handler rather than restating them, so a
      dimension added to the increment path without a matching reverse fails
      `test_the_reversed_dimensions_are_exactly_the_incremented_ones`. Replacing
      the shared `counter_dimensions` with an inverted hand-written twin is the
      mutation this is aimed at.

  TestADecrementCannotCreateOrGoNegative
    — dropping the `ConditionExpression` from `update_counter`'s decrement branch
      fails `test_a_decrement_against_a_missing_row_creates_nothing` (moto really
      does refuse the write, and without the condition the row is created holding
      `-1` with a fresh 90-day TTL) and
      `test_a_repeated_remove_does_not_push_a_counter_below_zero` (Streams are
      at-least-once). Re-raising ConditionalCheckFailedException instead of
      swallowing it fails `test_a_refused_decrement_is_not_an_error`.

  TestAnEditMovesAnItemBetweenBuckets
    — restoring the old `if event_name != 'INSERT': return` for MODIFY fails
      seven of these plus `test_skips_a_modify_missing_an_image`. Rebucketing
      every dimension instead of only the changed ones fails
      `test_dimensions_whose_value_did_not_change_are_not_written` and
      `test_an_edit_touching_no_dimension_writes_nothing`; dropping the
      `urgency == 'high'` guard fails five tests across three classes, including
      `test_urgency_raised_to_high_adds_the_urgent_count`.

  TestBothDirectionsAgreeOnThePersonaBucket
    — the persona axis buckets by `persona_type` (the archetype), not by
      `persona_name`: a null name is correct output for anonymous feedback, which is
      most of this corpus, so the name-based axis put 99.97% of it in one `Unknown`
      bucket. ⚠️ NOT CAUGHT BY THIS CLASS, and an earlier version of this map
      claimed it was: pointing `PERSONA_FIELD` back at `persona_name` fails ELEVEN
      tests and NONE of them are here. `_expected_persona_pk` derives the expected
      pk by calling `counter_dimensions` — the code under test — so moving the field
      moves both sides of the assertion together. That is deliberate and is what
      lets the class catch a SECOND derivation, but it is exactly what makes it
      unable to catch a WRONG one. The field move is caught by
      `test_persona_field_lockstep.py::TestTheAxisMeasuresTheArchetype::test_an_item_with_an_archetype_and_no_name_buckets_under_its_archetype`,
      by `TestProcessNewFeedback::test_updates_persona_counter`, and by five tests
      in `api/test/test_persona_dimension_lockstep.py` — which is the file that
      compares the two SIDES rather than one side with itself. What this class does
      catch is naming the bucket in a second place instead of through
      `counter_dimensions`: that fails
      `test_the_two_directions_name_one_row_and_only_the_sign_differs` as soon as
      the two copies disagree, which is what a half-moved field name is.

  TestAPreDeployImageIsReversedOnTheRowItsInsertCreated
    — the class above cannot see a cross-deploy image, because both of its images are
      built by the same deployed code. A REMOVE whose INSERT ran before the persona
      axis moved was counted under the OLD derivation's bucket, so a decrement from
      the shared description alone leaves that row inflated for up to 90 days while
      decrementing an archetype row the item never contributed to. What tells the
      reversal it is looking at such an item is that archetype decrement reporting
      `ROW_ABSENT` — no counter moved for the bucket — which is a fact about the
      TABLE, so every test there arranges the table rather than the fixture.
      Deleting `_reverse_a_pre_deploy_persona_row`'s call in `apply_feedback` fails
      six of these; deleting it in `process_modified_feedback` fails
      `test_a_rebucket_of_a_pre_deploy_image_reverses_the_legacy_row_too` and
      `test_an_edit_whose_only_landing_write_was_the_pre_deploy_compatibility_counts_as_nothing`.
      Acting on EITHER refusal instead of only on the absent row fails the three
      redelivery tests. The class's own REVERT MAP has the rest, including the
      accepted busy-day residual and three mutations that do NOT fail — one of them
      a citation this map used to make and could not support.

  TestAReversalRefusesToGuessTheDay
    — `_image_date`'s today-fallback is safe for an arrival and arbitrary for a
      reversal. Having `process_deleted_feedback` or `process_modified_feedback`
      read `_image_date` instead of `_image_date_or_none` fails
      `test_a_dateless_remove_writes_nothing` and both MODIFY tests here;
      `test_a_dateless_insert_still_buckets_under_today` is the other direction —
      the insert path's fallback is deliberately KEPT, so removing it fails too.

  TestARebucketCannotResurrectAnAgedOutDay
    — deleting the `_day_has_aggregates` check fails the first three. Writing it
      as `attribute_exists(pk)` on each increment instead — the obvious form —
      fails `test_an_edit_into_a_brand_new_bucket_on_a_live_day_still_lands` and
      `test_an_edit_that_moves_an_item_onto_a_live_day_lands`, which is how that
      form was found to DROP counts rather than protect anything. Making the
      unreadable-day case fail closed fails
      `test_an_unreadable_day_is_treated_as_live`.
      The check is PER SIDE: restoring `old_live or new_live` fails
      `test_an_edit_moving_an_item_onto_a_dead_day_creates_no_row_there`, and
      over-correcting it to `old_live and new_live` fails
      `test_that_edit_still_decrements_the_live_day_it_left` plus two others — so
      neither direction of that guard can be got wrong silently. Evaluating the
      sentinel once per SIDE rather than per distinct DATE fails
      `test_a_same_day_rebucket_reads_the_sentinel_once`.

  TestTheAveragesTwoHalvesCannotSplit
    — the average is two conditional writes to ONE row, so unlike the counters it
      can split: dropping the pairing fails
      `test_a_refused_reversal_does_not_let_its_increment_land`, and skipping the
      re-application unconditionally (the over-correction) fails four tests
      including `test_an_item_gaining_a_score_it_never_had_is_applied`. Moto-backed
      of necessity — a mock cannot refuse the reversal, so the pairing rule would
      never be exercised against one.

  TestThePairingIsPerRowAndNotPerEdit
    — the pairing above is keyed on the ROW, not on one flag consulted however far
      apart the two writes are aimed. Restoring the flag (`if blocked_row is not
      None`) fails `test_a_cross_day_edit_still_reaches_the_new_days_average` and
      nothing else, which is why that test exists: every test in the class above
      passes with the defect present. Removing the block altogether fails three,
      including `test_the_same_day_block_is_not_weakened_by_that`, so neither
      direction can be got wrong silently. Making the decline silent fails
      `test_a_declined_re_application_is_counted_rather_than_silent` (REFUSED_METRIC
      counts DynamoDB's refusals, so a write never issued is invisible to it).
      Within ONE row EITHER refusal blocks, because a reversal is attempted only for
      an old image that carried a score, so an absent row is one that EXPIRED:
      letting that case through fails
      `test_a_reversal_refused_for_an_expired_row_does_not_recreate_it`, and
      over-correcting to block on the row's absence rather than on a refused reversal
      fails `test_an_absent_row_is_still_created_when_no_reversal_was_attempted`.
      Those two differ only in whether a reversal was attempted, so neither
      direction can be got wrong silently either.
      `test_a_cross_day_arrival_onto_an_expired_average_still_fragments_it` is the
      RESIDUAL of that rule, pinned rather than fixed: the increment on the far side
      of a cross-day edit lands where no reversal went, so an expired row there is
      invisible. It fails if the residual is ever closed, which is deliberate.

  TestUpdateAverageReportsWhetherItLanded
    — the signal the class above spends, pinned on its own. Returning True from the
      refusal branch fails `test_a_reversal_against_an_empty_row_reports_false` and
      `test_a_reversal_against_a_missing_row_reports_false`; re-raising instead of
      swallowing an unreadable refusal fails
      `test_an_unreadable_refusal_is_still_a_refusal`.

  TestTheDaySentinelIsTheCounterEveryItemWrites
    — `_day_has_aggregates`'s soundness is a fact about `counter_dimensions`, so it
      is asserted rather than commented. Spelling the sentinel as a second literal
      fails 13 tests; logging a non-transient read failure at `warning` fails
      `test_a_denied_day_read_fails_open_but_is_logged_as_an_error`.

  TestARedeliveredArrivalMovesNothing
    — issue #264. An INSERT claims the stream record's `eventID` in the SAME
      `TransactWriteItems` as its counters, which closes both halves of the defect:
      a redelivered record moves nothing, and a record that dies partway leaves no
      partial application for the retry to land on top of. Deleting the claim from
      the transaction fails four; applying the counters as separate writes with the
      claim merely written first or last — a marker without a transaction — fails
      the partial-application pair, which is the half that produces internally
      inconsistent metrics. That class's own revert map has the rest, including
      which mutation each citation was measured against and the one test there
      that passes in both states and why that is correct.

  TestTheTransactionIsAnArrivalAndOnlyAnArrival
    — what the transactional path may BUILD, asserted on the request rather than
      through the handler, because none of these is reachable from a record. Giving
      any builder a `sign` again fails one — the original defect: the sign reached the
      counters while the average hardcoded `+1`, so `-1` decremented every counter and
      INCREMENTED the average, atomically. A second dimension on an EXISTING pk fails
      another, where production would answer `ValidationException` for every ingested
      record. Bypassing `_counter_request` fails the `metric_type` one, where the GSI
      that `/metrics/sources` and `/metrics/personas` read would silently empty while
      every count stayed correct. Its parity test is the one to keep in mind when
      adding a dimension test: `_record` omits `event_id` by default, so those tests
      take the path production no longer takes for an INSERT.

  TestAWriteConflictIsRetriedRatherThanReported
    — contention on `METRIC#daily_total` must not cost a record. Botocore does not
      auto-retry a cancelled transaction, so without the in-process retry a same-date
      collision spends the event source's `retryAttempts: 3` and the record is then
      DROPPED, its aggregates lost permanently — worse than the double-count. Deleting
      the retry fails four; retrying ANY cancellation fails the one whose subject is
      that a request which will fail identically must not be re-sent.

  TestRedeliveryMovesACounterTwice
    — the residual that REMAINS after that: a REVERSAL is not transacted, because
      every decrement is a conditional write whose refusal the code above it READS
      and a transaction reports no per-item outcome. These pin that, so the module
      docstring's remaining residual and the behaviour cannot drift apart.

  TestAnUnrecognizedEventIsSkippedRatherThanFatal
    — restoring `str(record.event_name)` in place of the `raw_event` read fails
      `test_an_unrecognized_event_name_is_skipped` with the KeyError that would
      have made the record a poison pill in production.
      `test_powertools_really_does_raise_on_an_unknown_event_name` asserts the
      premise, so a Powertools that stopped raising is reported rather than
      silently making the workaround redundant.

  TestTtlExpiryIsReadFromTheEventNotFromPowertools
    — narrowing `isinstance(identity, Mapping)` back to `dict` fails
      `test_an_identity_arriving_as_another_mapping_is_still_ttl_expiry`, which is
      the case that would otherwise turn every TTL REMOVE into a decrement with
      the branch dead and the suite green.

  TestEachBehaviourEmitsItsOwnMetric
    — collapsing the three metrics back into one fails all of these. Emitting the
      rebucket metric unconditionally fails
      `test_an_edit_that_moved_nothing_counts_as_nothing`. Counting writes
      ATTEMPTED rather than LANDED — in `apply_counter_keys`, or by having
      `update_counter` always report success — fails
      `test_an_edit_whose_every_write_was_refused_counts_as_nothing`, whose whole
      subject is that "aggregates moved" is a claim about writes that landed.

  TestAReversalRefusesToGuessTheDay::test_a_dateless_insert_still_buckets_under_today
    — freezes the clock the HANDLER reads (`_frozen_clock`) rather than reading
      `datetime.now()` a second time in the test. Restoring the second read fails
      the test whenever the two clocks disagree, which across UTC midnight they do;
      deleting the fallback it is a positive control for fails it always.

Each of those reverts was RUN, not predicted. Two more were run for the same
reason:

  * having the reverse path skip one dimension — the shape an inverted
    hand-written twin of the original per-dimension `update_counter` calls would
    eventually take — fails
    `test_the_reversed_dimensions_are_exactly_the_incremented_ones`;
  * treating an absent `userIdentity` as TTL expiry fails
    `test_a_remove_with_no_user_identity_is_treated_as_a_user_delete` plus both
    tests that delete without one.
"""
import boto3
import itertools
import pytest
from botocore.exceptions import ClientError
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import datetime
from moto import mock_aws
from unittest.mock import patch, MagicMock
from decimal import Decimal
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

TTL_IDENTITY = {'principalId': 'dynamodb.amazonaws.com', 'type': 'Service'}


def _to_ddb(item: dict) -> dict:
    """Serialize a plain dict the way a stream image arrives."""
    out = {}
    for key, value in item.items():
        if isinstance(value, bool):
            out[key] = {'BOOL': value}
        elif isinstance(value, (int, float, Decimal)):
            out[key] = {'N': str(value)}
        else:
            out[key] = {'S': str(value)}
    return out


def _record(event_name: str, *, new=None, old=None, user_identity=None,
            event_id=None) -> DynamoDBRecord:
    """A real Powertools stream record, not a MagicMock.

    A MagicMock answers any attribute, so `record.user_identity` on one would be
    a truthy mock and the TTL branch could never be exercised honestly.

    `event_id` is the stream's own `eventID`, which the aggregator claims to make an
    arrival idempotent (issue #264). OMITTED BY DEFAULT, and that default is a
    statement about what the other tests here are for: they ask which counters a
    given event moves, and a dedupe claim would make the SECOND record built by a
    test — a redelivery as far as the handler is concerned — write nothing, so every
    such test would be measuring the claim instead of the dimensions. A record with
    no id routes to the non-transactional path, exactly as it does in production when
    `IDEMPOTENCY_TABLE` is unset, so those tests keep asserting what they always did.
    The idempotency behaviour has its own class, where the id is passed explicitly.
    """
    body: dict = {'eventName': event_name, 'eventSource': 'aws:dynamodb', 'dynamodb': {}}
    if new is not None:
        body['dynamodb']['NewImage'] = _to_ddb(new)
    if old is not None:
        body['dynamodb']['OldImage'] = _to_ddb(old)
    if user_identity is not None:
        body['userIdentity'] = user_identity
    if event_id is not None:
        body['eventID'] = event_id
    return DynamoDBRecord(body)


def _writes(mock_table) -> list[tuple[str, str, str, int]]:
    """Every write a mocked aggregates table received, as (pk, sk, field, delta).

    Derived from the calls rather than restated, so the assertions below compare
    what the handler DID in one direction against what it did in the other.
    """
    out = []
    for call in mock_table.update_item.call_args_list:
        kwargs = call.kwargs
        key, names, values = kwargs['Key'], kwargs['ExpressionAttributeNames'], kwargs['ExpressionAttributeValues']
        if '#field' in names:
            out.append((key['pk'], key['sk'], names['#field'], values[':inc']))
        else:
            # update_average: `:one` carries the sign of the count movement.
            out.append((key['pk'], key['sk'], 'sum', values[':one']))
    return out


def _dimensions(writes) -> set[tuple[str, str, str]]:
    """The (pk, sk, field) triples written, dropping the direction."""
    return {(pk, sk, field) for pk, sk, field, _ in writes}


@contextmanager
def _frozen_clock(instant: str):
    """Freeze the clock the HANDLER reads, yielding the date it will bucket under.

    Any test whose expected value is "today" has to read the same clock the code
    does, or the two disagree across UTC midnight and the test fails for no defect.
    Yielding the date rather than letting the caller compute one is what makes that
    impossible to get wrong here.

    A `datetime` SUBCLASS, not a MagicMock: the handler also calls `.timestamp()`
    for the TTL and `.isoformat()` for `updated_at`, and a mock would answer those
    with mocks that DynamoDB then refuses — so the frozen clock has to be a real
    datetime in every respect but `now`.
    """
    fixed = datetime.fromisoformat(instant)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed

    with patch('aggregator.handler.datetime', _Frozen):
        yield fixed.strftime('%Y-%m-%d')


@pytest.fixture
def live_day_table():
    """A mocked aggregates table whose day check answers "this day is live".

    A rebucket first asks `_day_has_aggregates` whether the day's aggregates still
    exist, because an edit must not partially recreate a day that aged out. An
    UNCONFIGURED MagicMock answers that question with a MagicMock, and
    `'Item' in <MagicMock>` is False — so every MODIFY test written against a bare
    mock would assert on the writes of a rebucket that had been skipped, i.e. on
    nothing. Stating the day is live is therefore part of the arrangement of any
    test whose subject is which counters an edit moves; the aged-out case has its
    own class, against moto, where the answer comes from a real table.
    """
    with patch('aggregator.handler.aggregates_table') as table:
        table.get_item.return_value = {'Item': {'pk': 'METRIC#daily_total', 'count': Decimal(1)}}
        yield table


@pytest.fixture
def real_aggregates_table():
    """A moto-backed aggregates table, so condition expressions are really evaluated.

    The floor-at-zero and no-resurrection properties are properties of DynamoDB's
    evaluation of the ConditionExpression. A mock cannot refuse a write, so
    against a mock those tests would pass with the condition deleted.
    """
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-aggregates',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        with patch('aggregator.handler.aggregates_table', table):
            yield table


@pytest.fixture
def deduped_tables():
    """The aggregates table AND the dedupe table, as production has them.

    The claim and the counter updates go out as one `TransactWriteItems` across two
    tables, so a fixture with only the aggregates table cannot exercise the
    idempotency at all — the transaction would be rejected for a missing table, which
    would look like a failing handler rather than a missing arrangement.

    `AGGREGATES_TABLE` is patched as well as `aggregates_table`, because the
    transaction item names the table by STRING while the single-write path names it by
    resource. The module reads that env var once at import, so the name it holds is
    whatever `lambda/conftest.py` set — and a transaction built with a different name
    than the fixture created would fail for a reason no test is about.

    Yields (aggregates, idempotency), both moto-backed: the point of the whole design
    is a condition DynamoDB evaluates and a cancellation it reports, neither of which
    a mock can do.

    ⚠️ THE MODULE ATTRIBUTES ARE PATCHED ONLY IF THEY EXIST, which is what lets this
    class be run against the UNFIXED handler to see it red. `patch` raises
    AttributeError for a name a module does not define, so a fixture that named
    `IDEMPOTENCY_TABLE` unconditionally would turn every test in the class into a
    setup ERROR when the attribute is absent — and an error on the arrangement is not
    evidence about the behaviour. Skipping the absent ones lets each test reach its own
    assertion and fail on the counter it is really about.
    """
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        aggregates = resource.create_table(
            TableName='test-aggregates',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        idempotency = resource.create_table(
            TableName='test-idempotency',
            KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}],
            BillingMode='PAY_PER_REQUEST',
        )
        from aggregator import handler

        names = {
            'aggregates_table': aggregates,
            'AGGREGATES_TABLE': 'test-aggregates',
            'IDEMPOTENCY_TABLE': 'test-idempotency',
        }
        patches = [patch.object(handler, name, value)
                   for name, value in names.items() if hasattr(handler, name)]
        for one in patches:
            one.start()
        try:
            yield aggregates, idempotency
        finally:
            for one in patches:
                one.stop()


def _counts(table) -> dict[str, Decimal]:
    """Every COUNTER row's value, by pk. One day per test, so the pk identifies it.

    The running average is excluded although it too has a `count` attribute: it holds
    a `count` of SCORES beside a `sum`, which is a different quantity from a bucket's
    item count and does not belong in a total. Including it made an assertion about
    "how many counter rows are there" read one high, in a way that looked like an
    off-by-one in the handler rather than in the helper.
    """
    return {item['pk']: item['count'] for item in table.scan()['Items']
            if 'count' in item and 'sum' not in item}


class TestGetMetricType:
    """Tests for get_metric_type() function."""

    def test_returns_source_for_daily_source_pk(self):
        """Returns 'source' for daily_source metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_source#webscraper')
        
        assert result == 'source'

    def test_returns_persona_for_persona_pk(self):
        """Returns 'persona' for persona metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#persona#advocate')
        
        assert result == 'persona'

    def test_returns_none_for_other_pk(self):
        """Returns None for non-indexed metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_total')
        
        assert result is None

    def test_returns_none_for_category_pk(self):
        """Returns None for category metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_category#product_quality')
        
        assert result is None


class TestUpdateCounter:
    """Tests for update_counter() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_one(self, mock_table):
        """Increments counter field by 1 by default."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count')
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_total', 'sk': '2025-01-15'}
        assert ':inc' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_custom_amount(self, mock_table):
        """Increments counter by specified amount."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=5)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 5

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the counter item."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', ttl_days=30)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']
        # TTL should be approximately 30 days from now
        ttl_value = call_kwargs['ExpressionAttributeValues'][':ttl']
        assert isinstance(ttl_value, int)

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_source_pk(self, mock_table):
        """Includes metric_type for source metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_source#webscraper', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'source'

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_persona_pk(self, mock_table):
        """Includes metric_type for persona metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#persona#advocate', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'persona'


class TestUpdateAverage:
    """Tests for update_average() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_updates_sum_and_count(self, mock_table):
        """Updates sum and count for running average calculation."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-01-15'}
        assert ':val' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':val'] == Decimal('0.85')
        assert ':one' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':one'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the average item."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'), ttl_days=60)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']


class TestProcessNewFeedback:
    """Tests for process_new_feedback() function."""

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_total(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily total counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        # Check daily total was updated
        calls = mock_counter.call_args_list
        daily_total_call = [c for c in calls if c.args[0] == 'METRIC#daily_total']
        assert len(daily_total_call) == 1
        assert daily_total_call[0].args[1] == '2025-01-15'

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_source(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily source counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        source_call = [c for c in calls if 'daily_source#webscraper' in c.args[0]]
        assert len(source_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_category(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily category counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        category_call = [c for c in calls if 'daily_category#product_quality' in c.args[0]]
        assert len(category_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_sentiment(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily sentiment counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        sentiment_call = [c for c in calls if 'daily_sentiment#positive' in c.args[0]]
        assert len(sentiment_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_sentiment_average(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates sentiment score average."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        mock_avg.assert_called_once()
        call_args = mock_avg.call_args
        assert call_args.args[0] == 'METRIC#daily_sentiment_avg'
        assert call_args.args[1] == '2025-01-15'
        assert call_args.args[2] == Decimal('0.85')

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_urgent_counter_for_high_urgency(self, mock_counter, mock_avg, sample_urgent_feedback_item):
        """Updates urgent counter when urgency is high."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_urgent_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_urgent_counter_for_low_urgency(self, mock_counter, mock_avg, sample_feedback_item):
        """Does not update urgent counter when urgency is low."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 0

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_persona_counter(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates the persona counter, under the item's ARCHETYPE."""
        from aggregator.handler import process_new_feedback

        process_new_feedback(sample_feedback_item)

        calls = mock_counter.call_args_list
        persona_call = [c for c in calls if 'persona#advocate' in c.args[0]]
        assert len(persona_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_category_sentiment_combo(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates category + sentiment combination counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        combo_call = [c for c in calls if 'category_sentiment#product_quality#positive' in c.args[0]]
        assert len(combo_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_uses_current_date_when_date_missing(self, mock_counter, mock_avg):
        """Uses current date when date field is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_date = {
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
        }
        
        process_new_feedback(item_without_date)
        
        # Should still call update_counter with some date
        assert mock_counter.called

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_sentiment_average_when_score_missing(self, mock_counter, mock_avg):
        """Skips sentiment average update when score is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_score = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
            'sentiment_score': None,
        }
        
        process_new_feedback(item_without_score)
        
        mock_avg.assert_not_called()


class TestRecordHandler:
    """Tests for record_handler() function."""

    @patch('aggregator.handler.process_new_feedback')
    def test_processes_insert_event(self, mock_process, sample_feedback_item):
        """Processes INSERT events from DynamoDB stream."""
        from aggregator.handler import record_handler
        
        # Create mock DynamoDB record
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'pk': {'S': 'SOURCE#webscraper'},
            'sk': {'S': 'FEEDBACK#abc123'},
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'category': {'S': 'product_quality'},
            'sentiment_label': {'S': 'positive'},
            'sentiment_score': {'N': '0.85'},
        }
        
        result = record_handler(record)
        
        assert result['status'] == 'success'
        mock_process.assert_called_once()

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_does_not_treat_a_modify_as_an_insert(self, mock_process, mock_table):
        """A MODIFY is rebucketed, never counted as a fresh arrival."""
        from aggregator.handler import record_handler

        record = _record('MODIFY', old={'date': '2025-01-15'}, new={'date': '2025-01-15'})

        record_handler(record)

        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_a_modify_missing_an_image(self, mock_process):
        """Cannot rebucket without both images, so writes nothing."""
        from aggregator.handler import record_handler

        result = record_handler(_record('MODIFY', new={'date': '2025-01-15'}))

        assert result['status'] == 'skipped'
        assert result['reason'] == 'incomplete images'
        mock_process.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_does_not_treat_a_remove_as_an_insert(self, mock_process, mock_table):
        """A REMOVE reverses, never counts up."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old={'date': '2025-01-15'}))

        mock_process.assert_not_called()

    @patch('aggregator.handler.process_deleted_feedback')
    def test_skips_a_remove_with_no_old_image(self, mock_process):
        """Without an old image there is nothing to reverse."""
        from aggregator.handler import record_handler

        result = record_handler(_record('REMOVE'))

        assert result['status'] == 'skipped'
        assert result['reason'] == 'no old image'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_when_no_new_image(self, mock_process):
        """Skips when new_image is missing."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = None
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'no new image'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_converts_dynamodb_format_to_dict(self, mock_process):
        """Converts DynamoDB format to regular dict."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'sentiment_score': {'N': '0.85'},
        }
        
        record_handler(record)
        
        # Check the item passed to process_new_feedback
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'
        assert item['sentiment_score'] == Decimal('0.85')

    @patch('aggregator.handler.process_new_feedback')
    def test_handles_already_deserialized_format(self, mock_process):
        """Handles already deserialized DynamoDB format."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        # Powertools may already deserialize the data
        record.dynamodb.new_image = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'sentiment_score': Decimal('0.85'),
        }
        
        record_handler(record)
        
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'


class TestTtlExpiryLeavesHistoryAlone:
    """A REMOVE from the TTL reaper must not change any aggregate.

    Feedback items live 365 days; the aggregate row for the date they arrived on
    lives 90. So the TTL REMOVE for the feedback of date D arrives around D+365,
    when the row for D is long gone — and an unconditional decrement would
    RECREATE it holding a negative count with a fresh 90-day TTL. The item really
    did arrive on D; garbage-collecting it later is not a correction.
    """

    @patch('aggregator.handler.aggregates_table')
    def test_a_ttl_expiry_writes_nothing_at_all(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        result = record_handler(
            _record('REMOVE', old=sample_feedback_item, user_identity=TTL_IDENTITY)
        )

        assert result == {"status": "skipped", "reason": "ttl expiry"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_user_delete_of_the_same_item_does_write(self, mock_table, sample_feedback_item):
        """Positive control for the test above: the mock is not inert."""
        from aggregator.handler import record_handler

        result = record_handler(_record('REMOVE', old=sample_feedback_item))

        assert result == {"status": "success"}
        assert mock_table.update_item.call_count > 0

    @patch('aggregator.handler.aggregates_table')
    def test_a_remove_with_no_user_identity_is_treated_as_a_user_delete(
        self, mock_table, sample_feedback_item
    ):
        """An absent identity fails TOWARD correcting the count.

        A real user delete is the case this fix exists for, and misreading one as
        TTL expiry leaves the aggregate permanently overstated. The opposite
        misreading costs one decrement, and the ConditionExpression keeps even
        that from corrupting a row.
        """
        from aggregator.handler import record_handler

        record = _record('REMOVE', old=sample_feedback_item)
        assert 'userIdentity' not in record.raw_event

        assert record_handler(record) == {"status": "success"}
        assert mock_table.update_item.call_count > 0

    @patch('aggregator.handler.aggregates_table')
    def test_a_non_service_identity_is_a_user_delete(self, mock_table, sample_feedback_item):
        """Only `dynamodb.amazonaws.com` + `Service` means the reaper."""
        from aggregator.handler import record_handler

        record = _record(
            'REMOVE', old=sample_feedback_item,
            user_identity={'principalId': 'AIDAEXAMPLE', 'type': 'AssumedRole'},
        )

        assert record_handler(record) == {"status": "success"}
        assert mock_table.update_item.call_count > 0


class TestADeleteReversesExactlyWhatTheInsertAdded:
    """Every dimension the insert incremented, the delete decrements.

    Both sets are derived from the handler, never restated here, so a dimension
    added to one path only fails this rather than passing a stale list.
    """

    @patch('aggregator.handler.aggregates_table')
    def test_the_reversed_dimensions_are_exactly_the_incremented_ones(
        self, mock_table, sample_urgent_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_urgent_feedback_item))
        inserted = _writes(mock_table)
        mock_table.reset_mock()

        record_handler(_record('REMOVE', old=sample_urgent_feedback_item))
        removed = _writes(mock_table)

        assert _dimensions(inserted) == _dimensions(removed)
        assert all(delta == 1 for *_, delta in inserted)
        assert all(delta == -1 for *_, delta in removed)

    @patch('aggregator.handler.aggregates_table')
    def test_the_sentiment_average_is_reversed_too(self, mock_table, sample_feedback_item):
        """`sum` moves back by the same score, and `count` back by one."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item))

        avg = [c.kwargs for c in mock_table.update_item.call_args_list
               if c.kwargs['Key']['pk'] == 'METRIC#daily_sentiment_avg']
        assert len(avg) == 1
        assert avg[0]['ExpressionAttributeValues'][':val'] == Decimal('-0.85')
        assert avg[0]['ExpressionAttributeValues'][':one'] == -1

    @patch('aggregator.handler.aggregates_table')
    def test_a_non_urgent_delete_does_not_touch_the_urgent_row(
        self, mock_table, sample_feedback_item
    ):
        """No urgent row was ever written for it, so none may be decremented."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item))

        assert not [c for c in mock_table.update_item.call_args_list
                    if c.kwargs['Key']['pk'] == 'METRIC#urgent']


class TestADecrementCannotCreateOrGoNegative:
    """The guard on the decrement, evaluated by a real DynamoDB implementation."""

    def test_a_decrement_against_a_missing_row_creates_nothing(self, real_aggregates_table):
        """An aggregate that has already expired has nothing to correct.

        Without the ConditionExpression, `if_not_exists(#field, :zero) + :inc`
        creates the row holding `-1` and stamps a fresh 90-day TTL on it — a
        negative count served by any window query reaching that far back.
        """
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        assert real_aggregates_table.scan()['Items'] == []

    def test_a_repeated_remove_does_not_push_a_counter_below_zero(self, real_aggregates_table):
        """Streams deliver at-least-once, so the same REMOVE can arrive twice."""
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=1)
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        items = real_aggregates_table.scan()['Items']
        assert [i['count'] for i in items] == [Decimal(0)]

    def test_an_average_reversal_against_a_missing_row_creates_nothing(self, real_aggregates_table):
        from aggregator.handler import update_average

        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)

        assert real_aggregates_table.scan()['Items'] == []

    def test_an_average_count_does_not_go_below_zero(self, real_aggregates_table):
        from aggregator.handler import update_average

        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)

        item = real_aggregates_table.scan()['Items'][0]
        assert item['count'] == Decimal(0)
        assert item['sum'] == Decimal(0)

    @patch('aggregator.handler.aggregates_table')
    def test_a_refused_decrement_is_not_an_error(self, mock_table):
        """ConditionalCheckFailedException is the expected benign outcome."""
        from aggregator.handler import update_counter

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}},
            'UpdateItem',
        )

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

    @patch('aggregator.handler.aggregates_table')
    def test_any_other_dynamodb_error_still_raises(self, mock_table):
        """Only the condition failure is benign; a throttle must reach the batch processor."""
        from aggregator.handler import update_counter

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
            'UpdateItem',
        )

        with pytest.raises(ClientError):
            update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

    @patch('aggregator.handler.aggregates_table')
    def test_an_increment_carries_no_condition(self, mock_table):
        """A date's FIRST item has no row yet, so the increment must be free to create one."""
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count')

        assert 'ConditionExpression' not in mock_table.update_item.call_args.kwargs


class TestAnEditMovesAnItemBetweenBuckets:
    """MODIFY comes from `PUT /data-explorer/feedback`, which edits in place."""

    def test_a_changed_category_moves_the_count(self, live_day_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'category': 'billing'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        writes = _writes(live_day_table)
        assert ('METRIC#daily_category#product_quality', '2025-01-15', 'count', -1) in writes
        assert ('METRIC#daily_category#billing', '2025-01-15', 'count', 1) in writes

    def test_dimensions_whose_value_did_not_change_are_not_written(
        self, live_day_table, sample_feedback_item
    ):
        """An unrelated edit writes nothing; a category edit touches only category rows.

        Rebucketing everything would net to zero but refresh each row's 90-day
        TTL, and a decrement refused against a row at zero would leave its paired
        increment un-cancelled.
        """
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))
        touched = {pk for pk, _, _, _ in _writes(live_day_table)}

        assert touched == {
            'METRIC#daily_category#product_quality',
            'METRIC#daily_category#billing',
            'METRIC#category_sentiment#product_quality#positive',
            'METRIC#category_sentiment#billing#positive',
        }

    def test_an_edit_touching_no_dimension_writes_nothing(self, live_day_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'problem_summary': 'reworded by a human'}

        result = record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert result == {"status": "success"}
        live_day_table.update_item.assert_not_called()

    def test_urgency_downgraded_from_high_removes_the_urgent_count(
        self, live_day_table, sample_urgent_feedback_item
    ):
        from aggregator.handler import record_handler

        edited = {**sample_urgent_feedback_item, 'urgency': 'low'}

        record_handler(_record('MODIFY', old=sample_urgent_feedback_item, new=edited))

        writes = _writes(live_day_table)
        assert ('METRIC#urgent', '2025-01-15', 'count', -1) in writes
        assert not [w for w in writes if w[0] == 'METRIC#urgent' and w[3] == 1]

    def test_a_non_urgent_edit_never_writes_an_urgent_row(self, live_day_table, sample_feedback_item):
        """Neither side is high, so `METRIC#urgent` must not appear in either direction."""
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'urgency': 'medium'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert not [w for w in _writes(live_day_table) if w[0] == 'METRIC#urgent']

    def test_urgency_raised_to_high_adds_the_urgent_count(self, live_day_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'urgency': 'high'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert ('METRIC#urgent', '2025-01-15', 'count', 1) in _writes(live_day_table)

    def test_an_edited_date_moves_every_counter_to_the_new_day(
        self, live_day_table, sample_feedback_item
    ):
        """`date` is the one field whose edit rebuckets all dimensions at once."""
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'date': '2025-02-01'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        writes = _writes(live_day_table)
        assert {sk for _, sk, _, delta in writes if delta == -1} == {'2025-01-15'}
        assert {sk for _, sk, _, delta in writes if delta == 1} == {'2025-02-01'}

    def test_an_edited_sentiment_score_moves_the_average(self, live_day_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'sentiment_score': Decimal('0.10')}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        avg = [c.kwargs['ExpressionAttributeValues'] for c in live_day_table.update_item.call_args_list
               if c.kwargs['Key']['pk'] == 'METRIC#daily_sentiment_avg']
        assert [(v[':val'], v[':one']) for v in avg] == [
            (Decimal('-0.85'), -1), (Decimal('0.10'), 1),
        ]


class TestCounterDimensions:
    """The single description of the dimensions both directions are built from."""

    def test_an_urgent_item_adds_the_urgent_dimension(
        self, sample_feedback_item, sample_urgent_feedback_item
    ):
        from aggregator.handler import counter_dimensions

        plain = set(counter_dimensions(sample_feedback_item))
        urgent = set(counter_dimensions(sample_urgent_feedback_item))

        assert ('METRIC#urgent', 'count') in urgent
        assert ('METRIC#urgent', 'count') not in plain

    def test_a_missing_dimension_falls_back_to_the_same_default_both_ways(self):
        """Increment and decrement must derive identical pks for a sparse item."""
        from aggregator.handler import counter_dimensions

        assert counter_dimensions({}) == counter_dimensions({'date': '2025-01-15'})
        assert ('METRIC#daily_source#unknown', 'count') in counter_dimensions({})


class TestBothDirectionsAgreeOnThePersonaBucket:
    """The persona row an insert creates is the row a delete comes back for.

    A dimension read out of the NEW image on the way in and out of the OLD image on
    the way back is the one place a field name can be changed on half the axis: the
    increment lands on `METRIC#persona#<new field's value>` while the decrement
    looks for `METRIC#persona#<old field's value>`, so the counter goes up and never
    comes down. That is the bug this module was repaired for, and moving the field
    is exactly the edit that could reintroduce it in this one dimension.

    Both the EXPECTED bucket and the OBSERVED ones are derived — the expectation
    from `counter_dimensions`, the observations from the writes the handler issued —
    so nothing here restates the pk, and a second place naming the persona bucket
    cannot pass by agreeing with a literal in this file.

    The subject is the ANONYMOUS fixture (an archetype, no name), because that is
    the shape of nearly every item in production and the shape the old field
    bucketed as `Unknown`.
    """

    @staticmethod
    def _expected_persona_pk(item: dict) -> str:
        from aggregator.handler import counter_dimensions

        personas = [pk for pk, _ in counter_dimensions(item)
                    if pk.startswith('METRIC#persona#')]
        assert len(personas) == 1, personas
        return personas[0]

    @staticmethod
    def _persona_writes(mock_table) -> list[tuple[str, str, str, int]]:
        return [w for w in _writes(mock_table) if w[0].startswith('METRIC#persona#')]

    @patch('aggregator.handler.aggregates_table')
    def test_an_anonymous_items_insert_writes_the_bucket_counter_dimensions_names(
        self, mock_table, sample_anonymous_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_anonymous_feedback_item))

        assert self._persona_writes(mock_table) == [
            (self._expected_persona_pk(sample_anonymous_feedback_item),
             '2025-01-15', 'count', 1)
        ]

    @patch('aggregator.handler.aggregates_table')
    def test_its_delete_decrements_that_same_bucket(
        self, mock_table, sample_anonymous_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_anonymous_feedback_item))

        assert self._persona_writes(mock_table) == [
            (self._expected_persona_pk(sample_anonymous_feedback_item),
             '2025-01-15', 'count', -1)
        ]

    @patch('aggregator.handler.aggregates_table')
    def test_the_two_directions_name_one_row_and_only_the_sign_differs(
        self, mock_table, sample_anonymous_feedback_item
    ):
        """The property, stated without either side being written down.

        Compared as sets of (pk, sk, field) so the assertion is about WHICH row,
        which is the thing a half-moved field name gets wrong; the signs are checked
        separately, so a reversal that incremented could not pass either.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_anonymous_feedback_item))
        inserted = self._persona_writes(mock_table)
        mock_table.reset_mock()

        record_handler(_record('REMOVE', old=sample_anonymous_feedback_item))
        removed = self._persona_writes(mock_table)

        assert _dimensions(inserted) == _dimensions(removed)
        assert [delta for *_, delta in inserted] == [1]
        assert [delta for *_, delta in removed] == [-1]


class TestAPreDeployImageIsReversedOnTheRowItsInsertCreated:
    """The one case in which the reversal reads the OLD persona field.

    The class above is the property for images written by THIS deploy, and it cannot
    see this case: both of its images are built by the same deployed code, so both
    derive the same bucket. A REMOVE whose INSERT ran before the axis moved is
    different — that insert counted the item under `METRIC#persona#<persona_name, or
    Unknown>`, a row today's derivation never names — and without a fallback the
    delete leaves that row inflated for up to 90 days while decrementing an archetype
    row the item never contributed to.

    NO COUNTER GOES NEGATIVE AND NO EXPIRED ROW IS RESURRECTED, here or anywhere
    else on this path: `update_counter` guards every decrement with
    `attribute_exists(pk) AND #field >= :floor`, pinned against a real DynamoDB by
    TestADecrementCannotCreateOrGoNegative. The damage this fallback repairs was a
    persistent OVER-count of a legacy row, not a negative one.

    🔑 THE TRIGGER IS THE ARCHETYPE DECREMENT REPORTING `ROW_ABSENT`, AND NOTHING
    ABOUT THE ITEM — argued at `_reverse_a_pre_deploy_persona_row`. What follows from
    it HERE is how every test below is arranged: pre-deploy versus post-deploy is a
    fact about the TABLE, set with `_refuse`, never a field on a fixture. No fixture in
    conftest.py says which deploy wrote it, deliberately. That the two refusals are
    distinguishable at all is an assumption about DynamoDB rather than about this code,
    so it is checked against a real table by
    test_a_real_dynamodb_tells_a_row_at_zero_from_a_row_that_is_not_there.

    THE ACCEPTED RESIDUAL, recorded here rather than softened: an absent archetype row
    is available as evidence ONLY on a day no post-deploy item has written that
    bucket. On a busier day a pre-deploy item's decrement LANDS on the archetype row it
    never contributed to, the fallback does not fire, and the legacy row it did
    contribute to stays inflated until its 90-day TTL. That observable is the same one
    test_a_post_deploy_image_does_not_touch_the_legacy_row asserts — the cases are
    indistinguishable, which is the residual — so it is pinned there rather than in a
    test of its own, and `handler.py`'s `Known residuals` says the same. What holds
    either way is that EXACTLY ONE counter moves per deletion
    (test_exactly_one_persona_bucket_moves_per_deletion), which is the property the
    wall-clock trigger this replaced broke: it read a stamp on the item, so it issued a
    legacy `-1` on top of a decrement that had already landed.

    The collision guard and the reversal-only confinement are argued where they live,
    in `_reverse_a_pre_deploy_persona_row` — not restated here. What this class adds is
    that the guard is COMPLETE only because `persona_bucket` closed the axis, which is
    a property rather than an instance and so has its own test
    (test_the_rows_this_deploy_writes_are_all_in_the_enum).

    REVERT MAP for this class. Every entry below was RUN against the real source and
    its citations are the tests that really failed, not the ones that ought to have.
      * Delete `_reverse_a_pre_deploy_persona_row`'s call in `apply_feedback` — fails
        six: test_the_row_the_pre_deploy_insert_created_is_the_one_brought_down,
        test_a_pre_deploy_image_with_no_name_either_falls_back_to_the_old_default,
        test_exactly_one_persona_bucket_moves_per_deletion,
        test_a_name_the_closed_axis_can_no_longer_write_is_reversed_not_declined,
        test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current
        and test_the_fallback_lands_on_the_day_the_decrement_concerned. That last one
        survived this mutation until review found it: asserting only WHICH DAY the
        writes landed on was satisfied by the archetype decrement alone, so it now
        asserts the COUNT as well.
        Not the rebucket test: MODIFY has its own call, and deleting THAT one instead
        fails test_a_rebucket_of_a_pre_deploy_image_reverses_the_legacy_row_too and,
        in TestEachBehaviourEmitsItsOwnMetric,
        test_an_edit_whose_only_landing_write_was_the_pre_deploy_compatibility_counts_as_nothing.
      * Widen the gate from `is CounterWrite.ROW_ABSENT` to `is not
        CounterWrite.LANDED`, i.e. act on EITHER refusal — fails
        test_a_redelivered_remove_of_a_post_deploy_item_leaves_the_legacy_row_alone,
        test_a_redelivered_remove_of_an_anonymous_item_does_not_drain_the_legacy_default
        and test_a_redelivered_remove_of_a_pre_deploy_item_does_not_decrement_twice.
        Those three are the redelivered-REMOVE shape, which is the only place the two
        refusals differ observably.
      * Drop the outcome condition from the gate entirely, firing for every persona
        key — fails eight, in three classes: the three above, plus
        test_a_post_deploy_image_does_not_touch_the_legacy_row,
        test_exactly_one_persona_bucket_moves_per_deletion,
        TestADeleteReversesExactlyWhatTheInsertAdded's
        test_the_reversed_dimensions_are_exactly_the_incremented_ones, and both of
        TestBothDirectionsAgreeOnThePersonaBucket's shared-derivation tests
        (test_its_delete_decrements_that_same_bucket,
        test_the_two_directions_name_one_row_and_only_the_sign_differs). A
        compatibility that fires unconditionally is not a compatibility, and it stops
        being a fact about ONE axis.
      * Drop the PERSONA_ARCHETYPES collision guard — fails
        test_a_name_equal_to_an_archetype_does_not_aim_the_reversal_at_a_live_row and
        test_one_deletion_never_decrements_one_row_twice. Both need the archetype row
        arranged ABSENT to reach the guard at all; without that `_refuse` in the
        arrangement the gate returns early and this mutation fails nothing, which is
        how the first of them was found to have gone vacuous when the trigger changed.
      * Open the axis again (have `persona_bucket` interpolate `persona_type`
        verbatim) — fails test_the_rows_this_deploy_writes_are_all_in_the_enum,
        test_a_name_the_closed_axis_can_no_longer_write_is_reversed_not_declined and, outside
        this file, in api/test/test_persona_dimension_lockstep.py,
        test_an_out_of_contract_archetype_is_counted_as_unclassified — the read path
        buckets by the same derivation, so opening the axis moves both at once.
      * Trigger on the ITEM rather than on the row's outcome — any per-item test, a
        `processed_at` stamp or a persona SHAPE, reduces here to "act unless refused at
        the floor" — fails three in TestOneItemOwesOneLegacyDecrement:
        test_three_successive_edits_of_one_item_drain_the_legacy_row_once,
        test_an_edit_then_the_delete_drain_it_once and
        test_a_busy_day_does_not_drain_the_legacy_row_at_all. That class is where the
        per-ITEM bound lives; review measured 3 and 2 drains for those first two
        arrangements under the wall-clock trigger this replaced.
      * Have `update_counter` classify an unreadable refusal as `ROW_ABSENT` instead of
        `REFUSED_AT_FLOOR` — fails
        test_an_unreadable_refusal_is_not_evidence_that_a_row_was_absent, and only
        that: it is the fail direction of the one conclusion carrying a write.
      * Drop `ReturnValuesOnConditionCheckFailure='ALL_OLD'` from `update_counter` —
        fails test_a_real_dynamodb_tells_a_row_at_zero_from_a_row_that_is_not_there,
        and only that, because it is the only test that asks a real table which
        refusal it gave. Every mocked refusal in this class is hand-built, so the
        mutation is invisible to all of them — which is exactly why that test exists.
      * Drop `update_counter`'s decrement ConditionExpression — fails 16 across five
        classes, of which this one's is
        test_the_fallback_cannot_resurrect_an_aged_out_legacy_row: the compatibility is
        one `update_counter` call and inherits the condition rather than restating it.

    WHY THE TRIGGER IS NOT THE ITEM'S PERSONA SHAPE, recorded because it is the fix
    that suggests itself and does not work: "no `persona_type`, but a `persona_name`"
    looks like a pre-deploy image and is not one. `processor/handler.py` has written
    BOTH persona fields since the initial commit, so the axis move changed only the
    READER — an anonymous pre-deploy item carries a `persona_type` and no name,
    exactly like a post-deploy one, and that is the 99.97% case this compatibility
    exists for. A shape test would therefore be silently inert for the majority of the
    corpus while looking like a tightening;
    test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current
    is the case that fails under it, and its subject is the ORDINARY post-deploy
    fixture — the same item, reversed on the strength of the table alone.

    MUTATIONS THAT DO NOT FAIL ANYTHING, run and recorded rather than asserted into
    existence, because a REVERT MAP is only worth what its citations are:
      * `if sign < 0` → `if True` in `apply_feedback`: passes. An increment carries no
        ConditionExpression, so it can only ever report LANDED and the gate finds no
        `ROW_ABSENT` key to act on — the guard STATES that the compatibility is
        reversal-only rather than being what makes it so. (It was a no-op under the
        previous wall-clock trigger too, for a weaker reason: that one relied on a
        stream INSERT of a pre-deploy item being impossible.)
      * MAKING THE AXIS DUAL-SOURCED — `item.get(PERSONA_FIELD) or
        item.get('persona_name') or PERSONA_UNKNOWN` in `persona_bucket`: passes, and
        this one is a finding rather than a formality. An earlier version of this map
        claimed it failed two named tests; it does not. The membership filter absorbs
        it — a free-text name is not a member of PERSONA_ARCHETYPES, so it buckets as
        the empty value exactly as an absent field does, and every fixture and
        assertion here uses names like `Veronica Chen`. The mutation is observable only
        for a `persona_name` that happens to BE an archetype value with no
        `persona_type` beside it, a shape nothing in this repo pins. Closing the axis
        made the dual-read harmless, which is worth knowing, but it also means the
        shape this change is careful not to be is NOT held off by a failing test.
      * Reading the day from `_image_date(item)` instead of out of the counter key:
        passes, because for one reversal every key carries the very date `counter_keys`
        was given. Reading it out of the key is structural rather than observable — it
        makes it impossible for a future caller to hand this function keys from one day
        and an item naming another, the failure `_image_date_or_none` exists to prevent
        elsewhere and which no ConditionExpression can catch.
        test_the_fallback_lands_on_the_day_the_decrement_concerned therefore pins the
        OUTCOME (both writes on the item's own day) rather than the mechanism.
    """

    @staticmethod
    def _persona_writes(mock_table) -> list[tuple[str, str, str, int]]:
        return [w for w in _writes(mock_table) if w[0].startswith('METRIC#persona#')]

    @staticmethod
    def _legacy_pk(item: dict) -> str:
        """The row a pre-deploy insert created, derived from the handler's own
        constants rather than written out, so a change to either is visible here."""
        from aggregator.handler import (
            LEGACY_PERSONA_FIELD,
            LEGACY_PERSONA_UNKNOWN,
            PERSONA_PREFIX,
        )

        return f'{PERSONA_PREFIX}{item.get(LEGACY_PERSONA_FIELD) or LEGACY_PERSONA_UNKNOWN}'

    @staticmethod
    def _archetype_pk(item: dict) -> str:
        """The row today's derivation names — from `counter_dimensions`, so nothing
        here restates a pk."""
        from aggregator.handler import counter_dimensions

        personas = [pk for pk, _ in counter_dimensions(item)
                    if pk.startswith('METRIC#persona#')]
        assert len(personas) == 1, personas
        return personas[0]

    @staticmethod
    def _refuse(mock_table, *, unless_pk: str | None = None, at_floor: bool = False):
        """Make the mocked table refuse EVERY conditional write, or all but one.

        A decrement against a row that does not exist is what production really
        answers with, and an unconfigured mock accepts everything — so without this
        the fallback could never be reached and the tests below would pass with it
        deleted.

        `at_floor` picks WHICH refusal is mimicked, and the two are not
        interchangeable. DynamoDB reports a conditional failure with the refused item
        attached when there was one (`ReturnValuesOnConditionCheckFailure='ALL_OLD'`),
        and with no item when the row was absent — which is how `update_counter`
        tells a row that never existed from one sitting at zero. A helper that
        answered only one of the two would make one of those cases untestable, and it
        is the difference the fallback's trigger now turns on.
        """
        floor_item = {'pk': {'S': 'set-below'}, 'sk': {'S': 'd'}, 'count': {'N': '0'}}

        def update_item(**kwargs):
            if 'ConditionExpression' in kwargs and kwargs['Key']['pk'] != unless_pk:
                response = {
                    'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no'},
                }
                if at_floor:
                    response['Item'] = {**floor_item, 'pk': {'S': kwargs['Key']['pk']}}
                raise ClientError(response, 'UpdateItem')
            return {}

        mock_table.update_item.side_effect = update_item

    @patch('aggregator.handler.aggregates_table')
    def test_the_row_the_pre_deploy_insert_created_is_the_one_brought_down(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The blocking half of the finding: without this, deleting pre-deploy
        feedback leaves its persona row inflated until the row's TTL expires."""
        from aggregator.handler import record_handler

        self._refuse(mock_table)
        item = sample_pre_deploy_feedback_item

        record_handler(_record('REMOVE', old=item))

        assert self._persona_writes(mock_table) == [
            (self._archetype_pk(item), '2025-01-15', 'count', -1),
            (self._legacy_pk(item), '2025-01-15', 'count', -1),
        ], (
            'a REMOVE of a pre-deploy image must try the archetype row first (the '
            'shared derivation, so both directions still read one description) and, '
            'when that is refused because the insert never created it, bring down '
            'the row the insert really did create.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_a_pre_deploy_image_with_no_name_either_falls_back_to_the_old_default(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The old derivation's empty bucket was a bespoke `Unknown`, which is where
        99.97% of the corpus went — so it is the row most pre-deploy deletes have to
        bring down, and it is spelled the OLD way on purpose: this names rows that
        already exist, not a value anything writes fresh."""
        from aggregator.handler import (
            LEGACY_PERSONA_UNKNOWN,
            PERSONA_PREFIX,
            record_handler,
        )

        self._refuse(mock_table)
        nameless = {k: v for k, v in sample_pre_deploy_feedback_item.items()
                    if k != 'persona_name'}

        record_handler(_record('REMOVE', old=nameless))

        assert (f'{PERSONA_PREFIX}{LEGACY_PERSONA_UNKNOWN}', '2025-01-15', 'count', -1) \
            in self._persona_writes(mock_table)

    @patch('aggregator.handler.aggregates_table')
    def test_a_post_deploy_image_does_not_touch_the_legacy_row(
        self, mock_table, sample_anonymous_feedback_item
    ):
        """The POSITIVE CONTROL for the whole class — and the residual, in one call.

        Nothing is refused, so the archetype decrement LANDS, which is what an item
        this deploy counted looks like: a counter for that bucket has already come
        down and no legacy row is owed a second one. Without this, a fallback that
        fired on every reversal would pass every test above while double-counting
        every ordinary delete against a legacy row.

        🔑 IT IS ALSO THE ACCEPTED BUSY-DAY RESIDUAL, because the two are one
        observable. A landed decrement is equally what a PRE-deploy item deleted on a
        day the new axis has already written that bucket looks like — and then the row
        its own insert created is not brought down, and ages out on its 90-day TTL
        instead. Deciding it is possible — `processed_at` is on the old image — and
        declined: a constant naming the deploy instant misreads an item written just
        before the deploy and aggregated just after it, and leaves THAT row inflated
        permanently rather than for 90 days. Either way exactly one counter moves
        (test_exactly_one_persona_bucket_moves_per_deletion). Recorded in `handler.py`
        under `Known residuals`, and this assertion is what would fail if the residual
        were ever closed — a separate test for it would assert the same call twice.
        """
        from aggregator.handler import record_handler

        item = sample_anonymous_feedback_item

        record_handler(_record('REMOVE', old=item))

        assert self._persona_writes(mock_table) == [
            (self._archetype_pk(item), '2025-01-15', 'count', -1)
        ]

    @patch('aggregator.handler.aggregates_table')
    def test_one_deletion_never_decrements_one_row_twice(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The property the removed `pk == legacy_pk` branch used to carry.

        One deletion taking two counts off one row would need the legacy value to
        equal the archetype value — and it cannot: the archetype is always a member of
        PERSONA_ARCHETYPES (`persona_bucket` guarantees it) and the collision guard
        declines every legacy value in that set, so the case is refused one line
        earlier by a guard that exists for a stronger reason. Asserted over every
        arrangement that could reach it rather than one, because the argument is
        exhaustive and a single example would not show that.
        """
        from aggregator.handler import PERSONA_UNKNOWN, record_handler

        for name in (PERSONA_UNKNOWN, 'Unknown', 'churn_risk', 'Veronica Chen'):
            for archetype in (None, 'churn_risk', PERSONA_UNKNOWN, 'loyal'):
                mock_table.reset_mock()
                self._refuse(mock_table)
                item = {**sample_pre_deploy_feedback_item, 'persona_name': name}
                if archetype:
                    item['persona_type'] = archetype

                record_handler(_record('REMOVE', old=item))

                rows = [pk for pk, *_ in self._persona_writes(mock_table)]
                assert len(rows) == len(set(rows)), (
                    f'{item} produced writes to {rows}: one deletion decremented one '
                    f'row twice.'
                )

    @patch('aggregator.handler.aggregates_table')
    def test_an_insert_never_writes_the_legacy_bucket(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The fallback is REVERSAL-ONLY. A dual-read on the increment path would
        make the axis permanently two-sourced to serve a path with a sunset date."""
        from aggregator.handler import record_handler

        item = sample_pre_deploy_feedback_item

        record_handler(_record('INSERT', new=item))

        assert self._persona_writes(mock_table) == [
            (self._archetype_pk(item), '2025-01-15', 'count', 1)
        ], (
            'an arriving item is counted by the archetype axis and nothing else — '
            'including an item that happens to carry only a name, which counts as '
            'unclassified rather than under its name.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_the_fallback_lands_on_the_day_the_decrement_concerned(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The date is read out of the counter KEY, not re-derived.

        A follow-up write that recomputed the day could land on another one, which is
        the failure `_image_date_or_none` exists to prevent elsewhere in this module:
        no ConditionExpression can catch a `-1` aimed at the wrong day, because that
        row exists and is above the floor.
        """
        from aggregator.handler import record_handler

        self._refuse(mock_table)
        item = {**sample_pre_deploy_feedback_item, 'date': '2024-11-02'}

        record_handler(_record('REMOVE', old=item))

        writes = self._persona_writes(mock_table)
        # BOTH writes, not just the days they landed on: asserting the day alone was
        # satisfied by the archetype decrement on its own, so this test used to pass
        # with the fallback deleted outright. The count is what makes it about the
        # follow-up write at all.
        assert len(writes) == 2, (
            f'{writes}: expected the archetype decrement and the legacy follow-up, '
            f'not one of them'
        )
        assert {sk for _, sk, _, _ in writes} == {'2024-11-02'}, writes

    @patch('aggregator.handler.aggregates_table')
    def test_a_redelivered_remove_of_a_post_deploy_item_leaves_the_legacy_row_alone(
        self, mock_table, sample_feedback_item
    ):
        """A refused decrement is not evidence of a pre-deploy insert.

        Streams are at-least-once, so a REMOVE is redelivered after its counters have
        already come down — and the archetype row then sits at ZERO, where the floor
        refuses the second decrement. A refusal is two facts, and only "there was no
        such row" is evidence of a pre-deploy insert: a version triggering on ANY
        refusal fails here, which is what this arrangement is for.
        """
        from aggregator.handler import record_handler

        # Every conditional write refused BY THE FLOOR: the rows are all there.
        self._refuse(mock_table, at_floor=True)
        item = sample_feedback_item
        assert item.get('persona_name') and item.get('persona_type'), (
            'the subject must carry BOTH fields, or the two derivations name one row '
            'and a stray write would be invisible'
        )

        record_handler(_record('REMOVE', old=item))

        assert self._persona_writes(mock_table) == [
            (self._archetype_pk(item), '2025-01-15', 'count', -1)
        ], (
            'a redelivered REMOVE of a post-deploy item must attempt its archetype '
            'row and stop there. The row being at zero says the row exists, so the '
            'insert created it, so there is no pre-deploy row to bring down.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_a_redelivered_remove_of_an_anonymous_item_does_not_drain_the_legacy_default(
        self, mock_table, sample_anonymous_feedback_item
    ):
        """The same case in the shape production actually has, which is the costly one.

        An anonymous item derives the legacy bucket from the OLD DEFAULT, so a stray
        decrement lands on `METRIC#persona#Unknown` — the single row holding ~99.97%
        of the pre-deploy corpus. Every redelivered REMOVE would have taken a count
        off it, for items it never held.
        """
        from aggregator.handler import (
            LEGACY_PERSONA_UNKNOWN,
            PERSONA_PREFIX,
            record_handler,
        )

        self._refuse(mock_table, at_floor=True)

        record_handler(_record('REMOVE', old=sample_anonymous_feedback_item))

        legacy_default = f'{PERSONA_PREFIX}{LEGACY_PERSONA_UNKNOWN}'
        written = [pk for pk, *_ in self._persona_writes(mock_table)]
        assert legacy_default not in written, written

    @patch('aggregator.handler.aggregates_table')
    def test_a_redelivered_remove_of_a_pre_deploy_item_does_not_decrement_twice(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The ROW'S OUTCOME is the only evidence, and here it rules the fallback OUT.

        A REMOVE redelivered after this item's counters have already come down finds the
        ARCHETYPE row refused AT THE FLOOR — and a row refused at the floor EXISTS,
        which is a counter for that bucket already holding this item. One deletion owes
        one `-1`, so no legacy write is due, however pre-deploy the image looks: this
        one carries a name and no archetype, the shape most readily mistaken for a
        trigger. Excluding `REFUSED_AT_FLOOR` alongside `LANDED` is the whole of what
        keeps a redelivery from draining the legacy row again.
        """
        from aggregator.handler import record_handler

        self._refuse(mock_table, at_floor=True)

        record_handler(_record('REMOVE', old=sample_pre_deploy_feedback_item))

        written = [pk for pk, *_ in self._persona_writes(mock_table)]
        assert written == [self._archetype_pk(sample_pre_deploy_feedback_item)], (
            f'{written}: a row refused at the floor EXISTS, so this deploy counted the '
            f'item there and no legacy write is owed.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_exactly_one_persona_bucket_moves_per_deletion(
        self, mock_table, sample_pre_deploy_feedback_item, sample_anonymous_feedback_item
    ):
        """🔑 THE PROPERTY THE WALL-CLOCK TRIGGER BROKE, stated on its own.

        An item was counted in exactly ONE persona bucket, so exactly one persona
        counter may move when it is deleted — whichever side of the deploy its insert
        fell on. The trigger that read a stamp off the item lost this: it issued a
        legacy `-1` on top of an archetype decrement that had already landed, so one
        deletion took two counts off the axis. Reading the archetype row's outcome
        instead makes the two mutually exclusive by construction, and this is that
        exclusivity asserted over both arrangements rather than inferred from either.

        LANDED writes, not attempted ones: a refused `update_item` is still a call on
        the table, so `_persona_writes` sees it. What did not land is what `_refuse`
        was told to refuse, which is why the arrangement carries the pk allowed through.
        """
        from aggregator.handler import record_handler

        pre_deploy, post_deploy = (sample_pre_deploy_feedback_item,
                                   sample_anonymous_feedback_item)
        # (what the arrangement is, the old image, the pk a conditional write may land
        # on — None meaning nothing is refused, so every write lands.)
        arrangements = [
            # The archetype row this item's insert never created is ABSENT, so that
            # decrement moves nothing and the compatibility brings down the row the
            # insert did create.
            ('PRE-DEPLOY, on a quiet day', pre_deploy, self._legacy_pk(pre_deploy)),
            # The archetype row is there, so its decrement lands and the gate is never
            # reached: no legacy write is attempted at all.
            ('POST-DEPLOY', post_deploy, None),
        ]

        for what, item, may_land in arrangements:
            mock_table.reset_mock()
            if may_land is None:
                mock_table.update_item.side_effect = None
            else:
                self._refuse(mock_table, unless_pk=may_land)

            record_handler(_record('REMOVE', old=item))

            attempted = self._persona_writes(mock_table)
            landed = [w for w in attempted if may_land is None or w[0] == may_land]
            assert len(landed) == 1, (
                f'{what}: persona writes attempted {attempted}, of which {landed} '
                f'landed. The item was counted in exactly one persona bucket, so '
                f'exactly one counter may move for its deletion.'
            )
            assert landed[0][3] == -1, landed

    def test_the_rows_this_deploy_writes_are_all_in_the_enum(self):
        """What makes the collision guard COMPLETE rather than partial.

        The guard declines a legacy value that is a member of PERSONA_ARCHETYPES,
        justified as "a row this deploy writes" — and that justification only holds
        while the set really is every row this deploy can write. It was not: review
        found a live `METRIC#persona#loyal` row (this repo's own fixtures use that
        value, and `PUT /data-explorer/feedback` accepts `persona_type` with no
        allowlist) decremented for an item counted elsewhere, because `loyal` reached
        the pk verbatim and so passed the guard.

        `persona_bucket` closing the axis is what fixed it, so this asserts the
        property the guard depends on rather than one more instance of the symptom.
        """
        from aggregator.handler import PERSONA_ARCHETYPES, counter_dimensions

        for value in ('loyal', 'VIP customer', 'power_user', '', None, 'churn_risk'):
            personas = [pk for pk, _ in counter_dimensions({'persona_type': value})
                        if pk.startswith('METRIC#persona#')]
            assert len(personas) == 1, personas
            bucket = personas[0].removeprefix('METRIC#persona#')
            assert bucket in PERSONA_ARCHETYPES, (
                f'persona_type={value!r} writes METRIC#persona#{bucket}, which is not '
                f'a member of PERSONA_ARCHETYPES. The reversal\'s collision guard '
                f'tests membership of that set to decide whether a row is live, so a '
                f'row outside it is a live row the guard cannot recognise.'
            )

    @patch('aggregator.handler.aggregates_table')
    def test_a_name_equal_to_an_archetype_does_not_aim_the_reversal_at_a_live_row(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """`legacy_pk` is the one pk built out of free text, so it can collide.

        `persona_name` is an LLM-produced person name, and nothing constrains it to
        the value space this axis uses — `unknown` is entirely plausible for anonymous
        feedback, and it names the axis's LARGEST live bucket. A `-1` there is a
        current number corrupted rather than a legacy one corrected, and no condition
        expression can refuse it: that row exists and is above the floor. A missed
        legacy decrement is the right way to be wrong, the judgement
        `process_deleted_feedback` already makes for a dateless image.
        """
        from aggregator.handler import (
            PERSONA_ARCHETYPES,
            PERSONA_PREFIX,
            record_handler,
        )

        # The archetype row absent, so the fallback is REACHED and the guard is what
        # stops it. Without this the decrement lands, the gate returns early, and this
        # test would pass with the collision guard deleted.
        self._refuse(mock_table)
        colliding = {**sample_pre_deploy_feedback_item,
                     'persona_name': 'unknown', 'persona_type': 'advocate'}
        assert 'unknown' in PERSONA_ARCHETYPES, (
            'the arrangement depends on this name being a value the current axis '
            'writes; if the enum changes, pick another member of it'
        )

        record_handler(_record('REMOVE', old=colliding))

        written = [pk for pk, *_ in self._persona_writes(mock_table)]
        assert written == [f'{PERSONA_PREFIX}advocate'], (
            f'{written}: only the archetype decrement may be attempted. The name '
            f'`unknown` names a bucket THIS deploy writes, so it cannot be told '
            f'apart from a live row and must be left alone.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_a_name_the_closed_axis_can_no_longer_write_is_reversed_not_declined(
        self, mock_table, sample_pre_deploy_feedback_item
    ):
        """The half of that collision the guard used to miss, closed at the root.

        A legacy `persona_name` of `loyal` was NOT declined, because `loyal` is not in
        PERSONA_ARCHETYPES — while `METRIC#persona#loyal` was nonetheless a row this
        deploy wrote, for any item whose `persona_type` was `loyal`. Closing the axis
        means that row can no longer be written, so decrementing it is now correct
        rather than corrupting: it can only be a legacy row.

        Asserted as the property (the write goes to the row named by the OLD
        derivation, and the archetype row is the enum's) rather than as "no write
        happens", because the fix removed the hazard instead of adding a second guard.
        """
        from aggregator.handler import PERSONA_PREFIX, record_handler

        # As above: the archetype row has to be absent for the fallback to be reached
        # at all, which is what makes the assertion below about the guard.
        self._refuse(mock_table)
        item = {**sample_pre_deploy_feedback_item,
                'persona_name': 'loyal', 'persona_type': 'loyal'}

        record_handler(_record('REMOVE', old=item))

        written = [pk for pk, *_ in self._persona_writes(mock_table)]
        assert f'{PERSONA_PREFIX}loyal' in written, (
            f'{written}: `loyal` can no longer name a row this deploy writes, so the '
            f'only row of that name is the legacy one this item\'s insert created.'
        )
        assert self._archetype_pk(item) == f'{PERSONA_PREFIX}unknown', (
            'and the archetype side must have bucketed the out-of-contract value as '
            'the empty one — which is what makes the legacy row unambiguous.'
        )

    def test_an_unreadable_refusal_is_not_evidence_that_a_row_was_absent(self):
        """The fail direction of the one conclusion that carries a write.

        `is_conditional_check_failure` recognises this exception by TYPE NAME as well
        as by code, precisely because it arrives with no `response` payload on some
        paths — and `ROW_ABSENT` was the else-branch, so an unreadable refusal read as
        "there was no row". That is the fail-OPEN direction for a conclusion whose
        consequence is a write, so it now resolves to the outcome no caller acts on.
        """
        from aggregator.handler import CounterWrite, update_counter

        class ConditionalCheckFailedException(ClientError):
            def __init__(self):
                self.response = None

        with patch('aggregator.handler.aggregates_table') as table:
            table.update_item.side_effect = ConditionalCheckFailedException()
            outcome = update_counter('METRIC#persona#advocate', '2025-01-15', 'count',
                                     increment=-1)

        assert outcome is CounterWrite.REFUSED_AT_FLOOR, (
            f'{outcome}: a refusal whose response cannot be read says nothing about '
            f'whether the row was there, and ROW_ABSENT is the conclusion that issues '
            f'a follow-up write.'
        )

    @patch('aggregator.handler.aggregates_table')
    def test_an_anonymous_pre_deploy_image_is_still_reversed_though_its_shape_looks_current(
        self, mock_table, sample_anonymous_feedback_item
    ):
        """The 99.97% case, and the reason the trigger cannot be the item's SHAPE.

        `processor/handler.py` has written both persona fields since the initial commit,
        so the axis move changed only the READER: a pre-deploy anonymous item carries a
        `persona_type` and no name, which is byte-identical to a post-deploy one — the
        subject here IS the ordinary post-deploy fixture, and its insert nonetheless
        counted it under the old default bucket if it ran before the move. So "no
        `persona_type` but a `persona_name`" is NOT the pre-deploy shape, and a shape
        test (`PERSONA_FIELD not in item and LEGACY_PERSONA_FIELD in item`) would fail
        this: it looks like a tightening while switching the compatibility off for the
        majority of the corpus it exists for.

        What decides instead is a fact about the TABLE — the archetype row is arranged
        ABSENT — which the item's shape cannot contradict.
        """
        from aggregator.handler import (
            LEGACY_PERSONA_FIELD,
            LEGACY_PERSONA_UNKNOWN,
            PERSONA_PREFIX,
            record_handler,
        )

        self._refuse(mock_table)
        item = sample_anonymous_feedback_item
        assert LEGACY_PERSONA_FIELD not in item and item.get('persona_type'), (
            'the arrangement is the point: the subject must look exactly like an item '
            f'this deploy wrote — an archetype and no `{LEGACY_PERSONA_FIELD}` — or it '
            'does not show that the shape is not what decides'
        )

        record_handler(_record('REMOVE', old=item))

        assert (f'{PERSONA_PREFIX}{LEGACY_PERSONA_UNKNOWN}', '2025-01-15', 'count', -1) \
            in self._persona_writes(mock_table), (
            'an anonymous item whose archetype row was never created must bring down '
            'the old default bucket its insert really incremented — the single row that '
            'held ~99.97% of the pre-deploy corpus.'
        )

    def test_the_fallback_cannot_resurrect_an_aged_out_legacy_row(
        self, real_aggregates_table
    ):
        """Moto-backed of necessity: a mock cannot refuse a write.

        The legacy row may have aged out too — it carries the same 90-day TTL — and
        the compatibility must not create it holding `-1` any more than the ordinary
        decrement may. It is one `update_counter` call, so it inherits that
        condition; this asserts the inheritance rather than assuming it.
        """
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old={
            'date': '2025-01-15', 'source_platform': 'webscraper',
            'category': 'delivery', 'sentiment_label': 'neutral', 'urgency': 'low',
            'persona_name': 'Veronica Chen',
        }))

        assert real_aggregates_table.scan()['Items'] == [], (
            'every write of this reversal — the archetype decrement and the legacy '
            'fallback alike — is conditional, so a day whose rows have expired must '
            'come out of it with no rows at all.'
        )

    def test_a_real_dynamodb_tells_a_row_at_zero_from_a_row_that_is_not_there(
        self, real_aggregates_table
    ):
        """The distinction the trigger rests on, against the thing that supplies it.

        `update_counter` reads it out of `ReturnValuesOnConditionCheckFailure`, so it
        is a property of DynamoDB's response rather than of this repo's code — and a
        mock cannot establish it: the mocked refusals elsewhere in this class are
        hand-built to carry an item or not, which pins how the two are HANDLED but
        assumes DynamoDB draws the distinction at all. This is the assumption.
        """
        from aggregator.handler import CounterWrite, update_counter

        real_aggregates_table.put_item(
            Item={'pk': 'METRIC#persona#advocate', 'sk': '2025-01-15', 'count': Decimal(0)}
        )

        at_floor = update_counter('METRIC#persona#advocate', '2025-01-15', 'count',
                                  increment=-1)
        absent = update_counter('METRIC#persona#nothing_here', '2025-01-15', 'count',
                                increment=-1)

        assert at_floor is CounterWrite.REFUSED_AT_FLOOR, at_floor
        assert absent is CounterWrite.ROW_ABSENT, absent
        assert not at_floor and not absent, (
            'both are refusals, so both must stay falsy — the callers that only ask '
            '"did it land?" read this value as a boolean.'
        )

    def test_a_rebucket_of_a_pre_deploy_image_reverses_the_legacy_row_too(
        self, live_day_table, sample_pre_deploy_feedback_item
    ):
        """MODIFY's decrement half reads an old image as well.

        Reached only by an edit that CHANGES the archetype (or the date): an edit
        leaving `persona_type` alone cancels in the symmetric difference and issues
        no persona write, so there is nothing to be refused — which is why the plain
        `test_a_changed_category_moves_the_count` does not see this.
        """
        from aggregator.handler import record_handler

        self._refuse(live_day_table, unless_pk='METRIC#daily_total')
        old = sample_pre_deploy_feedback_item
        new = {**old, 'persona_type': 'advocate'}

        record_handler(_record('MODIFY', old=old, new=new))

        writes = self._persona_writes(live_day_table)
        assert (self._legacy_pk(old), '2025-01-15', 'count', -1) in writes, (
            f'{writes}: an edit to a pre-deploy item must bring down the row its '
            f'insert created, for the same reason its deletion must.'
        )
        assert (self._archetype_pk(new), '2025-01-15', 'count', 1) in writes, (
            'and still count it under its new archetype — the increment path is '
            'untouched by the compatibility.'
        )


class TestOneItemOwesOneLegacyDecrement:
    """🔑 THE DEBT IS PER-ITEM; THE COMPATIBILITY FIRES PER EVENT. How many times can
    one pre-deploy item drain the legacy row?

    A pre-deploy item contributed exactly `1` to exactly one legacy row, so at most one
    `-1` is ever owed for it — while `_reverse_a_pre_deploy_persona_row` runs on every
    reversal, and one item can be reversed many times: each edit that changes its
    archetype or its date, its eventual delete, and every stream redelivery of any of
    those.

    Raised in review against the WALL-CLOCK trigger, where the answer was N drains for
    N events (the stamp is immutable, so every reversal re-read it as pre-deploy and
    issued another `-1`). It is the property that made "self-limiting" true, so it is
    measured here rather than argued: all moto-backed, because the answer is DynamoDB's
    — whether the archetype row exists after the previous event is the whole mechanism.

    🔑 THE ABSENT-ROW TRIGGER BOUNDS THE LEGITIMATE CASES BY CONSTRUCTION, and that is
    the strongest argument for it. The first reversal's INCREMENT creates the archetype
    row for the item's new bucket, so every later decrement of that row LANDS, and a
    landed decrement never reaches the fallback. Nothing was added to get this: it falls
    out of triggering on "no counter moved" instead of on a fact about the item.

    ⚠️ REDELIVERY IS NOT BOUNDED, and is accepted rather than fixed. A REMOVE redelivered
    N times issues N legacy decrements, because a refused decrement creates nothing — so
    the archetype row is still absent on the second delivery and the evidence is
    unchanged. That is the module's general at-least-once residual (see
    TestRedeliveryMovesACounterTwice: a redelivered REMOVE double-decrements EVERY
    counter this module writes, and closing it means routing `eventID` through
    `shared/idempotency.py`, a CDK change as well as a code one). Fixing it for this one
    row and no other would be a special case of a module-wide residual.

    ⚠️ AND THE HONEST COST, which an earlier docstring understated by calling it "toward
    the truth": that is only so for the FIRST drain of each item. Once the legacy row
    holds the count its remaining pre-deploy items justify, another redelivered `-1`
    makes it UNDERSTATE — and it is a row `/metrics/personas` still serves for any
    window overlapping the move. Bounded below by the floor, never negative.

    REVERT MAP
      * Trigger on the item instead of on the row's outcome (any per-item test: a
        stamp, a shape) — fails
        test_three_successive_edits_of_one_item_drain_the_legacy_row_once and
        test_an_edit_then_the_delete_drain_it_once, which is exactly what review
        measured at 3 and 2 drains before the trigger moved.
      * Fire on `LANDED` as well — fails both of those and
        test_a_busy_day_does_not_drain_the_legacy_row_at_all.
    """

    DAY = '2025-01-15'
    LEGACY_PK = 'METRIC#persona#Unknown'

    @staticmethod
    def _anonymous_pre_deploy(persona_type: str) -> dict:
        """The 99.97% pre-deploy shape: an archetype, NO name, so its insert counted it
        under the old bespoke default. Built here rather than from the conftest fixture
        because these tests walk `persona_type` through several values."""
        return {
            'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#anon1', 'feedback_id': 'anon1',
            'date': '2025-01-15', 'source_platform': 'webscraper',
            'category': 'delivery', 'sentiment_label': 'neutral', 'urgency': 'low',
            'persona_type': persona_type,
        }

    @classmethod
    def _seed(cls, table, *, busy: bool):
        from aggregator.handler import PERSONA_ARCHETYPES

        # `daily_total` is the sentinel `_day_has_aggregates` reads, so seeding it is
        # what makes the day LIVE and lets a rebucket proceed at all.
        table.put_item(Item={'pk': 'METRIC#daily_total', 'sk': cls.DAY,
                             'count': Decimal(100)})
        table.put_item(Item={'pk': cls.LEGACY_PK, 'sk': cls.DAY, 'count': Decimal(6000)})
        if busy:
            # A post-deploy item has already written every archetype bucket for the day,
            # which is the state that makes the absent row unavailable as evidence.
            for archetype in PERSONA_ARCHETYPES:
                table.put_item(Item={'pk': f'METRIC#persona#{archetype}', 'sk': cls.DAY,
                                     'count': Decimal(40)})

    @classmethod
    def _legacy_count(cls, table) -> int | None:
        item = table.get_item(Key={'pk': cls.LEGACY_PK, 'sk': cls.DAY}).get('Item')
        return None if item is None else int(item['count'])

    def test_three_successive_edits_of_one_item_drain_the_legacy_row_once(
        self, real_aggregates_table
    ):
        """Three legitimate archetype edits, one item, one `-1`.

        Review measured THREE here against the wall-clock trigger. The first edit's
        decrement finds no archetype row and settles the debt; its increment then
        CREATES the row for the new bucket, so the second and third edits' decrements
        land and never reach the fallback. No marker, no stored state, no extra guard.
        """
        from aggregator.handler import process_modified_feedback

        self._seed(real_aggregates_table, busy=False)
        walk = ['churn_risk', 'prospect', 'advocate', 'churn_risk']

        for old, new in itertools.pairwise(walk):
            process_modified_feedback(self._anonymous_pre_deploy(old),
                                      self._anonymous_pre_deploy(new))

        assert self._legacy_count(real_aggregates_table) == 5999, (
            'one item owes exactly one legacy `-1`, however many times it is edited.'
        )

    def test_an_edit_then_the_delete_drain_it_once(self, real_aggregates_table):
        """The same property across two DIFFERENT event types.

        Review measured two. Worth its own case because the edit and the delete reach
        the fallback through different callers (`process_modified_feedback` and
        `apply_feedback`), so a bound that held only inside one of them would pass the
        test above.
        """
        from aggregator.handler import (
            process_deleted_feedback,
            process_modified_feedback,
        )

        self._seed(real_aggregates_table, busy=False)

        process_modified_feedback(self._anonymous_pre_deploy('churn_risk'),
                                  self._anonymous_pre_deploy('prospect'))
        process_deleted_feedback(self._anonymous_pre_deploy('prospect'))

        assert self._legacy_count(real_aggregates_table) == 5999

    def test_a_redelivered_remove_drains_it_once_per_delivery(self, real_aggregates_table):
        """⚠️ THE ACCEPTED MULTI-DRAIN, pinned so it is a decision and not an absence.

        A refused decrement creates nothing, so the archetype row is still absent on the
        second delivery and the evidence is unchanged — three deliveries, three `-1`s.
        The module's general at-least-once residual rather than one this path invents,
        and the direction is toward the truth for the FIRST drain only; past it the
        legacy row understates. If this is ever closed it should be closed for every
        counter at once, through `shared/idempotency.py`.
        """
        from aggregator.handler import process_deleted_feedback

        self._seed(real_aggregates_table, busy=False)

        for _ in range(3):
            process_deleted_feedback(self._anonymous_pre_deploy('churn_risk'))

        assert self._legacy_count(real_aggregates_table) == 5997, (
            'three deliveries of one REMOVE take three counts off the legacy row. '
            'Accepted: it is what every other counter in this module does under '
            'redelivery — see TestRedeliveryMovesACounterTwice.'
        )

    def test_a_busy_day_does_not_drain_the_legacy_row_at_all(self, real_aggregates_table):
        """The other side of the same mechanism, and the accepted busy-day residual.

        With the archetype buckets already written for the day, every persona decrement
        LANDS, so the fallback never fires — for an edit, a delete or a redelivery
        alike. The legacy row is left inflated to age out on its TTL. Asserted over all
        three arrangements at once, because on a busy day they are one observable.
        """
        from aggregator.handler import (
            process_deleted_feedback,
            process_modified_feedback,
        )

        self._seed(real_aggregates_table, busy=True)

        process_modified_feedback(self._anonymous_pre_deploy('churn_risk'),
                                  self._anonymous_pre_deploy('prospect'))
        for _ in range(3):
            process_deleted_feedback(self._anonymous_pre_deploy('prospect'))

        assert self._legacy_count(real_aggregates_table) == 6000, (
            'an absent archetype row is the only evidence this path has, and a busy '
            'day does not offer it. Documented in `handler.py` under `Known residuals`.'
        )


class TestAReversalRefusesToGuessTheDay:
    """`_image_date`'s today-fallback is safe on an arrival and unsafe on a reversal.

    For an INSERT, today is at least the day the row was created, so the counter it
    creates is defensible. For a REMOVE it is arbitrary: an undated item ingested on
    D and deleted on D+40 would decrement the D+40 counters — corrupting a
    legitimate current-day aggregate while leaving D overstated — and the
    ConditionExpression cannot catch it, because that row exists and is above the
    floor. A missed `-1` is the right way to be wrong here.

    Only legacy or hand-written rows lack `date` (`processor/handler.py` always sets
    it), so this is latent rather than active; the failure it prevents is a silent
    write to the wrong day, which is the class of bug this module exists to remove.
    """

    @patch('aggregator.handler.aggregates_table')
    def test_a_dateless_remove_writes_nothing(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        dateless = {k: v for k, v in sample_feedback_item.items() if k != 'date'}

        result = record_handler(_record('REMOVE', old=dateless))

        assert result == {"status": "skipped", "reason": "no date"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_dated_remove_of_the_same_item_does_write(self, mock_table, sample_feedback_item):
        """Positive control: the skip above is the date, not an inert mock."""
        from aggregator.handler import record_handler

        assert record_handler(_record('REMOVE', old=sample_feedback_item)) == {"status": "success"}
        assert mock_table.update_item.call_count > 0

    @patch('aggregator.handler.aggregates_table')
    def test_a_modify_whose_old_image_has_no_date_writes_nothing(
        self, mock_table, sample_feedback_item
    ):
        """A rebucket needs BOTH days: one of them guessed moves an unrelated counter."""
        from aggregator.handler import record_handler

        dateless = {k: v for k, v in sample_feedback_item.items() if k != 'date'}

        result = record_handler(_record('MODIFY', old=dateless,
                                       new={**sample_feedback_item, 'category': 'billing'}))

        assert result == {"status": "skipped", "reason": "no date"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_modify_whose_new_image_has_no_date_writes_nothing(
        self, mock_table, sample_feedback_item
    ):
        from aggregator.handler import record_handler

        edited = {k: v for k, v in sample_feedback_item.items() if k != 'date'}

        result = record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert result == {"status": "skipped", "reason": "no date"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_dateless_insert_still_buckets_under_today(self, mock_table):
        """The today-fallback is KEPT for the insert path — behaviour preserved.

        The clock is FROZEN rather than read twice. Reading
        `datetime.now(timezone.utc)` here and letting the handler read its own
        compares two independent clocks, so an invocation that straddles UTC
        midnight fails for a non-defect reason — one run in ~86400, and CI at
        midnight UTC is not exotic. This test is a deliberate positive control
        against someone tidying up the insert path's fallback after the reversal
        paths stopped using it, so it has to be unconditionally reliable rather
        than nearly so. Deleting the fallback still fails it: without one an
        undated insert writes nothing at all.
        """
        from aggregator.handler import record_handler

        with _frozen_clock('2025-06-01T12:00:00+00:00') as frozen:
            result = record_handler(_record('INSERT', new={'source_platform': 'webscraper'}))

        assert result == {"status": "success"}
        assert {sk for _, sk, _, _ in _writes(mock_table)} == {frozen}


class TestARebucketCannotResurrectAnAgedOutDay:
    """An edit to a day whose aggregates have expired writes nothing at all.

    The module's central argument is that a write must not recreate an aggregate row
    that has expired under its 90-day TTL. The decrement half of a rebucket is
    refused by its own condition; the increments are not, and `PUT
    /data-explorer/feedback` can edit a record of any age with no recency
    constraint. So an unguarded rebucket leaves freshly TTL-stamped fragments
    (`count = 1`, and a one-score `daily_sentiment_avg` row) for a date whose real
    totals were collected months ago — and `validate_days` admits windows up to 365
    days, so `/metrics/summary` and `/metrics/trends` serve them as that day's
    totals. The average row is the worst of the three, because `get_summary` divides
    `sum/count` per date and weights it by count into the headline number.

    WHY THE GUARD IS ON THE DAY AND NOT ON EACH ROW is pinned by
    `test_an_edit_into_a_brand_new_bucket_on_a_live_day_still_lands` below, which is
    the test that failed when this was first written as `attribute_exists(pk)` per
    increment: the obvious form drops the count of every edit that moves an item
    into a category no item has used that day yet.

    WHY IT IS ASKED PER SIDE. `old_live or new_live` reads as a reasonable "is this
    edit a real correction?", and an edit whose `date` moves an item FROM a live day
    TO a dead one satisfies it — after which every increment, which carries no
    condition by design, lands on the dead day and recreates the whole fragment,
    `daily_total` included, so the sentinel afterwards calls the dead day live for
    every later edit. Both directions of that are pinned:
    `test_an_edit_moving_an_item_onto_a_dead_day_creates_no_row_there` fails on the
    permissive form, and `test_that_edit_still_decrements_the_live_day_it_left`
    fails on the over-correction (`and`) that would refuse the whole edit and leave
    the item counted on a day it has left.

    Deleting the `_day_has_aggregates` check fails the first three here. All run
    against moto, because a mock can neither refuse a write nor answer a get_item.
    """

    def test_rebucketing_a_day_with_no_rows_writes_nothing(
        self, real_aggregates_table, sample_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert real_aggregates_table.scan()['Items'] == []

    def test_an_edited_score_on_a_day_with_no_rows_creates_no_average_row(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The resurrected average row is the most damaging of the three."""
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.10')}))

        assert real_aggregates_table.scan()['Items'] == []

    def test_an_edited_date_does_not_conjure_a_day_that_is_gone(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Editing `date` moves every counter — onto a day whose rows may be gone."""
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'date': '2025-02-01'}))

        assert real_aggregates_table.scan()['Items'] == []

    def test_rebucketing_a_day_that_does_have_rows_still_moves_the_count(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Positive control: a live day's edit is applied, not refused."""
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_label': 'negative'}))

        counts = {i['pk']: i['count'] for i in real_aggregates_table.scan()['Items']}
        assert counts['METRIC#daily_sentiment#positive'] == Decimal(0)
        assert counts['METRIC#daily_sentiment#negative'] == Decimal(1)
        # The unchanged dimensions were never touched, so they still hold the insert.
        assert counts['METRIC#daily_total'] == Decimal(1)

    def test_an_edit_into_a_brand_new_bucket_on_a_live_day_still_lands(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The reason the guard is a day check rather than `attribute_exists(pk)`.

        No item has used `billing` on this date, so that counter has no row — and
        refusing to create it would DROP the count: the decrement lands on
        `product_quality`, the increment vanishes, and the day's per-category counts
        stop summing to `daily_total`. Guarding each increment on its own row's
        existence trades the resurrection bug for a fresh undercount, which is not a
        fix; only the day can tell "this bucket is new" from "this day is gone".
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        counts = {i['pk']: i['count'] for i in real_aggregates_table.scan()['Items']}
        assert counts['METRIC#daily_category#product_quality'] == Decimal(0)
        assert counts['METRIC#daily_category#billing'] == Decimal(1)
        assert counts['METRIC#daily_category#billing'] + \
            counts['METRIC#daily_category#product_quality'] == counts['METRIC#daily_total']

    def test_an_edit_that_moves_an_item_onto_a_live_day_lands(
        self, real_aggregates_table, sample_feedback_item
    ):
        """One live day of the two is enough: the edit IS a real correction.

        The item is moving off a day whose aggregates are gone and onto one that is
        live. The dead day's decrements are refused by their own condition, and the
        live day's increments must land — otherwise a date correction silently loses
        the item from the metrics surface altogether.
        """
        from aggregator.handler import record_handler

        arrived = {**sample_feedback_item, 'date': '2025-02-01'}
        record_handler(_record('INSERT', new=arrived))
        # Now pretend the item had been recorded under an aged-out day and is being
        # corrected forward onto the live one.
        record_handler(_record('MODIFY', old={**sample_feedback_item, 'date': '2024-01-01'},
                               new=arrived))

        counts = {(i['pk'], i['sk']): i['count'] for i in real_aggregates_table.scan()['Items']}
        assert counts[('METRIC#daily_total', '2025-02-01')] == Decimal(2)
        assert ('METRIC#daily_total', '2024-01-01') not in counts

    def test_an_edit_moving_an_item_onto_a_dead_day_creates_no_row_there(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The direction `old_live or new_live` let through.

        The item leaves a LIVE day for one whose aggregates are gone. A guard that
        asks only whether EITHER side is live passes this, and then every increment
        — which carries no condition, deliberately, so a new bucket on a live day can
        be created — lands on the dead day: seven freshly 90-day-TTL'd rows for a
        date whose real totals were collected months ago, `daily_sentiment_avg` among
        them. Worse than the pre-guard behaviour in one respect, because
        `METRIC#daily_total` is recreated too and the sentinel then reports the dead
        day as LIVE for every subsequent edit.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'date': '2024-01-01'}))

        dead_day = [i for i in real_aggregates_table.scan()['Items'] if i['sk'] == '2024-01-01']
        assert dead_day == []

    def test_that_edit_still_decrements_the_live_day_it_left(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Per SIDE, not all-or-nothing: the live half of that edit is real.

        The item genuinely left 2025-01-15, and that day's aggregates are still
        there to correct. Refusing the whole edit because its destination is gone
        would leave the item counted on a day it is no longer on — the overstatement
        this module exists to remove.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'date': '2024-01-01'}))

        counts = {(i['pk'], i['sk']): i['count'] for i in real_aggregates_table.scan()['Items']}
        assert counts[('METRIC#daily_total', '2025-01-15')] == Decimal(0)

    @patch('aggregator.handler.aggregates_table')
    def test_a_same_day_rebucket_reads_the_sentinel_once(self, mock_table, sample_feedback_item):
        """One read per DISTINCT date, not one per side.

        `date` is not in the Data Explorer's updatable_fields, so both dates being
        equal is the common case — and the short-circuit `or` this replaced only
        skipped the second read when the FIRST answered True, so the dead-day path
        (the one that ends in a skip) read the identical key twice.
        """
        from aggregator.handler import record_handler

        mock_table.get_item.return_value = {}

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert mock_table.get_item.call_count == 1

    @patch('aggregator.handler.aggregates_table')
    def test_a_cross_day_rebucket_reads_both_days(self, mock_table, sample_feedback_item):
        """Positive control for the test above: two dates really are two reads.

        Without this, collapsing the check to a single read of one side would pass
        the same-day assertion while leaving the other side unchecked.
        """
        from aggregator.handler import record_handler

        mock_table.get_item.return_value = {}

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'date': '2025-02-01'}))

        assert sorted(c.kwargs['Key']['sk'] for c in mock_table.get_item.call_args_list) == [
            '2025-01-15', '2025-02-01',
        ]

    @patch('aggregator.handler.aggregates_table')
    def test_an_edit_touching_no_dimension_costs_no_read(self, mock_table, sample_feedback_item):
        """The common case pays for nothing: no writes AND no day check.

        An edit to `problem_summary` moves no counter, so there is no rebucket to
        guard and no reason to read the daily total for it.
        """
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'problem_summary': 'reworded'}))

        mock_table.update_item.assert_not_called()
        mock_table.get_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_an_unreadable_day_is_treated_as_live(self, mock_table, sample_feedback_item):
        """A rebucket that cannot check must not silently drop every edit.

        One fragment on an aged-out day is recoverable and visible; dropping every
        edit while the table is briefly unreadable is the failure that looks like
        nothing happened.
        """
        from aggregator.handler import record_handler

        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
            'GetItem',
        )

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert mock_table.update_item.call_count > 0


class TestTheAveragesTwoHalvesCannotSplit:
    """A rebucket's average reversal and re-application stand or fall together.

    The counter dimensions are moved as a symmetric difference so that `-1` and `+1`
    never land on one key. The average gets no such protection from that argument: it
    is TWO conditional writes to (SENTIMENT_AVG_PK, date), and `#count >= :floor` can
    refuse the reversal against a row already at zero while the re-application
    applies unconditionally. The row then claims one item, at the edited score, that
    no present feedback justifies — and `get_summary` divides `sum/count` per date and
    weights it by count into the headline `avg_sentiment`, so it is served-data
    corruption rather than a skew nobody reads.

    Distinct from the `sum`-vs-`count` residual in `update_average`'s docstring, which
    is about a reversal quoting the WRONG score. Here both scores are right and it is
    the pairing that breaks.

    All moto-backed: a mock cannot refuse a write, so against one the reversal would
    always "land" and the pairing rule would never be exercised.
    """

    @staticmethod
    def _avg(table, date='2025-01-15'):
        item = table.get_item(Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': date}).get('Item')
        return None if item is None else (item['count'], item['sum'])

    def test_a_refused_reversal_does_not_let_its_increment_land(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The reproduction: a LIVE day whose average row sits at count == 0.

        An insert then a delete leaves the row present (so the day is live and the
        rebucket proceeds) and empty. The score edit's reversal is refused by the
        floor; its re-application must not apply alone.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('REMOVE', old=sample_feedback_item))
        assert self._avg(real_aggregates_table) == (Decimal(0), Decimal(0))

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.10')}))

        assert self._avg(real_aggregates_table) == (Decimal(0), Decimal(0))

    def test_an_edit_on_a_day_with_items_still_moves_the_average(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Positive control: the pairing must not refuse an ordinary edit.

        Without this, skipping the increment unconditionally would pass the test
        above while silently dropping every legitimate score correction.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.10')}))

        assert self._avg(real_aggregates_table) == (Decimal(1), Decimal('0.10'))

    def test_an_item_gaining_a_score_it_never_had_is_applied(
        self, real_aggregates_table, sample_feedback_item
    ):
        """No reversal to pair with, so nothing is left dangling by applying.

        A zero old score contributed nothing to the average, so there is no half that
        could have been refused — the increment is unconditional and correct.
        """
        from aggregator.handler import record_handler

        scoreless = {**sample_feedback_item, 'sentiment_score': Decimal(0)}
        record_handler(_record('INSERT', new=scoreless))
        record_handler(_record('MODIFY', old=scoreless,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.40')}))

        assert self._avg(real_aggregates_table) == (Decimal(1), Decimal('0.4'))

    def test_an_item_losing_its_score_is_reversed_with_nothing_to_re_apply(
        self, real_aggregates_table, sample_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_score': Decimal(0)}))

        assert self._avg(real_aggregates_table) == (Decimal(0), Decimal(0))

    def test_a_score_edit_moving_off_a_dead_day_still_lands_on_the_live_one(
        self, real_aggregates_table, sample_feedback_item
    ):
        """A dead old day has no reversal to pair with either, and must not block.

        The old row is gone, so there is no half to be inconsistent with; refusing
        the increment would lose the item from the average altogether — the
        count-dropping failure `_day_has_aggregates` exists to avoid.
        """
        from aggregator.handler import record_handler

        arrived = {**sample_feedback_item, 'date': '2025-02-01'}
        record_handler(_record('INSERT', new=arrived))
        record_handler(_record('MODIFY',
                               old={**sample_feedback_item, 'date': '2024-01-01',
                                    'sentiment_score': Decimal('0.20')},
                               new=arrived))

        assert self._avg(real_aggregates_table, '2025-02-01') == (Decimal(2), Decimal('1.70'))
        assert self._avg(real_aggregates_table, '2024-01-01') is None

    def test_a_refused_reversal_is_still_counted_as_refused(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Skipping the pair must not also hide it: the refusal stays visible."""
        from aggregator.handler import REFUSED_METRIC, record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('REMOVE', old=sample_feedback_item))

        with patch('aggregator.handler.metrics') as mock_metrics:
            record_handler(_record('MODIFY', old=sample_feedback_item,
                                   new={**sample_feedback_item,
                                        'sentiment_score': Decimal('0.10')}))

        assert REFUSED_METRIC in [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list]


class TestThePairingIsPerRowAndNotPerEdit:
    """A refusal on one day's average row says nothing about another day's.

    The pairing rule above is right for a SAME-DAY edit, where both writes hit one
    (SENTIMENT_AVG_PK, date). An edited `date` makes them two writes to two rows, and
    consulting a single `reversal_refused` flag across that gap dropped the item from
    the new day's average while every one of its counters — `daily_total` included —
    moved onto that day. The row and the counters then describe different sets of
    items, which is the split the pairing exists to prevent, moved to the day that
    UNDERSTATES: `get_summary` weights each date's `sum/count` by that same count.

    So the block is keyed on the ROW, and these tests are what tell the two
    formulations apart — the flag version passes every test in the class above.

    Keyed on the row is not the same as keyed on the row's EXISTENCE. Within one row
    either refusal blocks, and the two tests at the end of this class are the pair
    that pins it: an absent row whose reversal was refused expired and must not be
    recreated, while an absent row nobody tried to reverse belongs to a day taking
    its first scored item and must be.

    Moto-backed throughout: a mock cannot refuse the reversal, so against one the
    reversal always "lands", `blocked_row` stays None and the distinction is never
    exercised.
    """

    @staticmethod
    def _avg(table, date):
        item = table.get_item(Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': date}).get('Item')
        return None if item is None else (item['count'], item['sum'])

    @staticmethod
    def _count(table, pk, date):
        item = table.get_item(Key={'pk': pk, 'sk': date}).get('Item')
        return None if item is None else item['count']

    def test_a_cross_day_edit_still_reaches_the_new_days_average(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The reproduction. The old day's row is at zero; the new day's is not.

        An insert then a delete leaves `(daily_sentiment_avg, 2025-01-15)` present and
        empty — so the old day reads live and its reversal is refused by the floor —
        while an unrelated scored item keeps 2025-02-01 live with a real average. The
        edit moves the first item onto that day. With the pairing keyed on a flag the
        new day's average stayed at one item while its `daily_total` reached two.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('REMOVE', old=sample_feedback_item))
        assert self._avg(real_aggregates_table, '2025-01-15') == (Decimal(0), Decimal(0))

        other = {**sample_feedback_item, 'feedback_id': 'other', 'date': '2025-02-01',
                 'sentiment_score': Decimal('0.90')}
        record_handler(_record('INSERT', new=other))
        assert self._avg(real_aggregates_table, '2025-02-01') == (Decimal(1), Decimal('0.90'))

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'date': '2025-02-01'}))

        # Both halves of the day now describe the same two items.
        assert self._avg(real_aggregates_table, '2025-02-01') == (Decimal(2), Decimal('1.75'))
        assert self._count(real_aggregates_table, 'METRIC#daily_total', '2025-02-01') == Decimal(2)

    def test_the_same_day_block_is_not_weakened_by_that(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The other direction: keying on the row must still block the same row.

        Without this, dropping the pairing altogether would pass the test above. It is
        the same reproduction as
        `TestTheAveragesTwoHalvesCannotSplit::test_a_refused_reversal_does_not_let_its_increment_land`,
        restated here so the per-row formulation is pinned from both sides in one place.
        """
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('REMOVE', old=sample_feedback_item))

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.10')}))

        assert self._avg(real_aggregates_table, '2025-01-15') == (Decimal(0), Decimal(0))

    def test_a_cross_day_arrival_onto_an_expired_average_still_fragments_it(
        self, real_aggregates_table, sample_feedback_item
    ):
        """THE RESIDUAL, pinned at what the code really does rather than what is nice.

        The rule blocks a re-application only on a row whose OWN reversal was refused,
        so it cannot see an expired row on the far side of a cross-day edit: the
        increment lands where no reversal went. The arrival day therefore gets a
        one-score average row exactly as the same-day case used to.

        Left unfixed because it is undecidable from the two images. A live day with no
        average row is the same observation whether the row expired or the day is
        taking its first scored item — and the second must be created, which
        `test_an_absent_row_is_still_created_when_no_reversal_was_attempted` pins. It
        needs a per-day "has ever held a scored item" marker, i.e. new state.

        This test FAILS if that residual is ever closed, which is the point: whoever
        closes it should have to change this assertion deliberately.
        """
        from aggregator.handler import record_handler

        for n, score in enumerate([Decimal('0.90'), Decimal('0.60'), Decimal('0.30')]):
            record_handler(_record('INSERT', new={
                **sample_feedback_item, 'feedback_id': f'e{n}',
                'date': '2025-02-01', 'sentiment_score': score,
            }))
        mover = {**sample_feedback_item, 'feedback_id': 'mover', 'date': '2025-01-15',
                 'sentiment_score': Decimal('0.50')}
        record_handler(_record('INSERT', new=mover))

        # The arrival day's average row ages out; its daily_total does not.
        real_aggregates_table.delete_item(
            Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-02-01'}
        )

        record_handler(_record('MODIFY', old=mover, new={**mover, 'date': '2025-02-01'}))

        # One score, beside a daily_total of four. Named, not defended.
        assert self._avg(real_aggregates_table, '2025-02-01') == (Decimal(1), Decimal('0.50'))
        assert self._count(real_aggregates_table, 'METRIC#daily_total', '2025-02-01') == Decimal(4)

    def test_an_absent_row_is_still_created_when_no_reversal_was_attempted(
        self, real_aggregates_table, sample_feedback_item
    ):
        """The other side of the test above, and what keeps its guard from over-reaching.

        Both tests act on a live day with no average row; only the ATTEMPTED REVERSAL
        tells them apart. Here the old score is zero, so `apply_feedback` never wrote
        the row and there is nothing to have expired — the day genuinely has its first
        scored item, and the write must land. Blocking on the row's absence rather than
        on a refused reversal would fail this while still passing the test above, which
        is the over-correction this pins.
        """
        from aggregator.handler import record_handler

        unscored = {**sample_feedback_item, 'sentiment_score': Decimal(0)}
        record_handler(_record('INSERT', new=unscored))
        assert self._avg(real_aggregates_table, '2025-01-15') is None

        record_handler(_record('MODIFY', old=unscored,
                               new={**sample_feedback_item, 'sentiment_score': Decimal('0.30')}))

        assert self._avg(real_aggregates_table, '2025-01-15') == (Decimal(1), Decimal('0.30'))

    def test_a_reversal_refused_for_an_expired_row_does_not_recreate_it(
        self, real_aggregates_table, sample_feedback_item
    ):
        """A row that is ABSENT on a live day is absent because it EXPIRED.

        The reversal is attempted only for an old image that carried a score, and
        `apply_feedback` writes the average whenever a score is set — so the insert did
        write this row, and its absence is the 90-day TTL, not a day that never had
        one. The two rows of a day expire independently: `daily_total` is refreshed by
        every item of the date, the average only by scored ones, and TTL deletion is
        best-effort besides. So the day still reads live.

        THE FIXTURE IS THE POINT. Three scored items make the day's real average cover
        three, so re-creating the row from the one edited item is visibly a fragment:
        `count == 1` beside a `daily_total` of 3, which `get_summary` would serve as
        that whole day's figure. Planting a one-item day instead makes `count == 1`
        look consistent and hides exactly this.
        """
        from aggregator.handler import record_handler

        items = [
            {**sample_feedback_item, 'feedback_id': f'f{n}', 'sentiment_score': score}
            for n, score in enumerate([Decimal('0.90'), Decimal('0.60'), Decimal('0.30')])
        ]
        for item in items:
            record_handler(_record('INSERT', new=item))
        assert self._avg(real_aggregates_table, '2025-01-15') == (Decimal(3), Decimal('1.80'))

        real_aggregates_table.delete_item(
            Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-01-15'}
        )
        assert self._count(real_aggregates_table, 'METRIC#daily_total', '2025-01-15') == Decimal(3)

        record_handler(_record('MODIFY', old=items[0],
                               new={**items[0], 'sentiment_score': Decimal('0.10')}))

        # No row at all is the honest outcome: `get_summary` skips what is absent
        # rather than reporting one item's score as the day's average.
        assert self._avg(real_aggregates_table, '2025-01-15') is None

    def test_a_declined_re_application_is_counted_rather_than_silent(
        self, real_aggregates_table, sample_feedback_item
    ):
        """A write we decline to make cannot be counted by DynamoDB refusing it.

        REFUSED_METRIC is emitted from an `except ClientError`, so it can only ever
        count refusals of writes that were ISSUED. The pairing skip issues none, and
        without its own metric an operator would see REBUCKETED_METRIC — the counters
        did move — and no anomaly at all, while the day's average had lost an item.
        """
        from aggregator.handler import (
            DECLINED_METRIC,
            REBUCKETED_METRIC,
            record_handler,
        )

        record_handler(_record('INSERT', new=sample_feedback_item))
        record_handler(_record('REMOVE', old=sample_feedback_item))

        with patch('aggregator.handler.metrics') as mock_metrics:
            record_handler(_record('MODIFY', old=sample_feedback_item,
                                   new={**sample_feedback_item,
                                        'sentiment_score': Decimal('0.10')}))

        names = [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list]
        assert DECLINED_METRIC in names
        # And it is not confused with the rebucket having moved something.
        assert REBUCKETED_METRIC not in names

    def test_nothing_is_declined_when_the_pair_is_left_alone(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Positive control: an ordinary score edit declines nothing.

        Without this, emitting DECLINED_METRIC unconditionally would pass the test
        above while making the new signal meaningless.
        """
        from aggregator.handler import DECLINED_METRIC, record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))

        with patch('aggregator.handler.metrics') as mock_metrics:
            record_handler(_record('MODIFY', old=sample_feedback_item,
                                   new={**sample_feedback_item,
                                        'sentiment_score': Decimal('0.10')}))

        names = [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list]
        assert DECLINED_METRIC not in names
        assert self._avg(real_aggregates_table, '2025-01-15') == (Decimal(1), Decimal('0.10'))


class TestUpdateAverageReportsWhetherItLanded:
    """`update_average`'s contract, against a real DynamoDB implementation.

    It answers a bool, like `update_counter`, because its one branching caller treats
    both refusals alike: neither a row sitting at the floor nor a row that has expired
    may take a re-application on its own. These pin the signal itself rather than only
    its consequence in `_rebucket_average`.
    """

    def test_a_landed_write_reports_true(self, real_aggregates_table):
        from aggregator.handler import update_average

        assert update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))

    def test_a_reversal_against_an_empty_row_reports_false(self, real_aggregates_table):
        from aggregator.handler import update_average

        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)

        assert not update_average(
            'METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1
        )

    def test_a_reversal_against_a_missing_row_reports_false(self, real_aggregates_table):
        """And writes nothing — the row must not be resurrected holding a negative."""
        from aggregator.handler import update_average

        assert not update_average(
            'METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1
        )
        assert real_aggregates_table.get_item(
            Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-01-15'}
        ).get('Item') is None

    def test_an_unreadable_refusal_is_still_a_refusal(self):
        """A refusal whose response cannot be read is swallowed, not re-raised.

        The exception is shaped the way `shared/aws.py::is_conditional_check_failure`
        documents one arriving: a ClientError subclass NAMED
        ConditionalCheckFailedException — which is how boto3's resource layer really
        raises it — carrying no readable response, so the predicate recognises it by
        type name and the refusal branch is reached rather than the error re-raised.
        """
        from aggregator.handler import update_average

        class ConditionalCheckFailedException(ClientError):
            """Named like boto3's own, with an unreadable `response`."""

            def __init__(self):
                super().__init__(
                    {'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem'
                )
                self.response = None  # type: ignore[assignment]

        with patch('aggregator.handler.aggregates_table') as mock_table:
            mock_table.update_item.side_effect = ConditionalCheckFailedException()
            landed = update_average(
                'METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1
            )

        assert landed is False


class TestRedeliveryMovesACounterTwice:
    """The residual that REMAINS after issue #264, pinned at what the code really does.

    Streams deliver at-least-once and the event source carries `retryAttempts: 3`
    with `reportBatchItemFailures: true`, so a batch that partially fails
    re-presents records whose writes already landed. The floor at zero is NOT
    idempotency — it only no-ops a redelivered REMOVE when the counter is already at
    zero.

    ⚠️ THE ARRIVAL PATH IS NOW CLOSED, and these tests are deliberately about the
    REVERSAL paths only — see TestARedeliveredArrivalMovesNothing for the half that
    was fixed. A decrement cannot join the transaction that closes it: every one is a
    conditional write whose refusal the code above it READS (the pre-deploy persona
    fallback triggers on `ROW_ABSENT`, the average's pairing rule on a refused
    reversal), and `TransactWriteItems` reports no per-item outcome — one refused item
    cancels the whole transaction instead. So transacting a reversal would turn "this
    decrement had nothing to correct, so carry on" into "the edit wrote nothing at
    all", disabling the aged-out-day protections that exist BY observing a refusal.

    These therefore stay as they are, and they are what stops the module docstring's
    remaining residual from drifting from the code. Note that both arrangements below
    INSERT without an `event_id`, so their setup uses the non-transactional path
    too — the subject is the reversal, and a claimed insert would make the second
    insert of `test_a_redelivered_modify_moves_the_count_twice` a no-op for a reason
    that has nothing to do with what it measures.
    """

    def test_a_redelivered_remove_decrements_again_above_zero(
        self, real_aggregates_table, sample_feedback_item
    ):
        from aggregator.handler import record_handler

        for _ in range(3):
            record_handler(_record('INSERT', new=sample_feedback_item))
        remove = _record('REMOVE', old=sample_feedback_item)
        record_handler(remove)
        record_handler(remove)

        counts = {i['pk']: i['count'] for i in real_aggregates_table.scan()['Items']}
        # 2 is the true value: three inserts, one deletion. 1 is what redelivery
        # produces, and what the module docstring records as the residual that
        # remains. If this starts failing with 2, the reversal path was closed too —
        # update that note.
        assert counts['METRIC#daily_total'] == Decimal(1)

    def test_a_redelivered_modify_moves_the_count_twice(
        self, real_aggregates_table, sample_feedback_item
    ):
        """Worse than a replayed REMOVE: it re-applies BOTH halves."""
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        edited = {**sample_feedback_item, 'category': 'billing'}
        record_handler(_record('INSERT', new=edited))
        modify = _record('MODIFY', old=sample_feedback_item, new=edited)
        record_handler(modify)
        record_handler(modify)

        counts = {i['pk']: i['count'] for i in real_aggregates_table.scan()['Items']}
        # True values after one edit: product_quality 0, billing 2.
        assert counts['METRIC#daily_category#product_quality'] == Decimal(0)
        assert counts['METRIC#daily_category#billing'] == Decimal(3)


class TestARedeliveredArrivalMovesNothing:
    """Issue #264: the same stream record delivered twice leaves every counter alone.

    Streams are at-least-once, and `retryAttempts: 3` with
    `reportBatchItemFailures: true` means a batch that partially fails re-presents
    records whose writes already landed. Because these counters are only ever
    incremented and nothing recomputes them from source, that divergence is
    PERMANENT — which is why it is closed with a claim rather than compensated for.

    Every test here is moto-backed of necessity: the mechanism is a condition
    DynamoDB evaluates (`attribute_not_exists(id)`) and a cancellation it reports,
    and a mock can do neither — against one, a redelivery would "succeed" and every
    assertion below would pass with the claim deleted.

    REVERT MAP. Each entry was RUN against the source, and cites the tests that
    really failed:
      * Drop the dedupe claim from `_claimed_transaction`'s TransactItems (or route
        `process_new_feedback` past `apply_arrival_once`) — fails
        test_a_redelivered_record_leaves_every_counter_where_the_first_delivery_left_it,
        test_the_second_delivery_is_reported_as_a_skip_not_a_failure,
        test_a_replayed_record_is_counted_so_the_guard_is_not_silently_inert and
        test_the_second_delivery_of_a_record_writes_nothing_at_all.
      * Apply the counters as separate `update_item` calls with the claim written
        first or last, i.e. a marker without a transaction — fails
        test_a_record_that_fails_partway_leaves_no_counter_moved, which is the
        partial-application half and the one that produces internally inconsistent
        metrics.
      * Treat ANY TransactionCanceledException as an already-applied record (drop
        `_claim_was_refused`'s reason check) — fails
        test_a_cancellation_that_is_not_the_claim_is_raised_for_retry, whose subject
        is that a conflict on a counter row must be retried rather than reported
        done: nothing was written, so calling it success loses the record.
      * Claim a key that is not per-RECORD — the feedback id, say — fails
        test_two_different_records_for_one_item_are_both_applied.
      * Leave `IDEMPOTENCY_TABLE` out of the aggregator's CDK environment: caught in
        `lib/stacks/processing-stack-consolidated.test.ts`, not here, and
        test_an_unconfigured_dedupe_table_still_aggregates is the code side of the
        same question — the protection degrades, the aggregation does not stop.

    RED BEFORE, GREEN AFTER, measured rather than asserted: run against the pre-#264
    handler, THIRTEEN of the fourteen tests here fail on their own assertions (not on
    setup — the fixture patches only the module attributes that exist, deliberately, so
    each test reaches its subject). The fourteenth,
    test_a_record_with_no_event_id_is_applied_rather_than_dropped, PASSES both ways and
    is recorded as such rather than dressed up: it is the fail-open control, and what
    it guards against is a future over-correction — dropping a record that carries no
    id. A test whose subject is "this did not change" passing before the change is the
    correct outcome for it, and pretending otherwise is the citation problem this
    file's revert maps exist to avoid.
    """

    ID = 'a-single-stream-record'

    # A counter row that arithmetic cannot touch, used to fail one write of a record
    # PARTWAY through it. `if_not_exists(#field, :zero) + :inc` against a string is a
    # ValidationException, which cancels the transaction.
    #
    # 🔑 THE PK IS CHOSEN FOR WHERE IT SORTS. Keys are applied in sorted order, so
    # `METRIC#daily_sentiment#negative` falls after `METRIC#daily_category#...` and
    # before `METRIC#daily_total` — which against independent writes leaves the
    # category count applied and the daily total not, the internally inconsistent
    # state the issue names. A poison row at either END of that order would let the
    # partial-application tests pass against the very defect they are written for.
    _POISON_PK = 'METRIC#daily_sentiment#negative'
    _POISON_SK = '2025-01-15'

    @classmethod
    def _poison(cls, aggregates):
        aggregates.put_item(Item={
            'pk': cls._POISON_PK, 'sk': cls._POISON_SK, 'count': 'not a number',
        })

    @classmethod
    def _unpoison(cls, aggregates):
        aggregates.delete_item(Key={'pk': cls._POISON_PK, 'sk': cls._POISON_SK})

    def test_a_redelivered_record_leaves_every_counter_where_the_first_delivery_left_it(
        self, deduped_tables, sample_urgent_feedback_item
    ):
        """🔑 THE ACCEPTANCE CRITERION, over EVERY counter rather than one of them.

        The urgent fixture, so EVERY dimension is present — the urgent row is the one
        conditional one — and a claim covering all of them but one is the shape this
        asserts against by comparing the whole table rather than a count of rows.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        record = _record('INSERT', new=sample_urgent_feedback_item, event_id=self.ID)

        record_handler(record)
        after_first = _counts(aggregates)
        record_handler(record)

        assert _counts(aggregates) == after_first, (
            'a redelivered stream record moved a counter; the dedupe claim did not '
            'refuse the second delivery'
        )
        # The denominator: an assertion that both states are EMPTY would pass with
        # the handler doing nothing at all.
        assert after_first['METRIC#daily_total'] == Decimal(1)
        assert len(after_first) == 7, after_first

    def test_the_second_delivery_of_a_record_writes_nothing_at_all(
        self, deduped_tables, sample_feedback_item
    ):
        """Not "writes and then corrects": the transaction never commits.

        Distinct from the test above, which compares values. This one compares the
        whole item — `updated_at` and `ttl` are restamped by any write that lands, so
        an unchanged item is evidence that no write reached the row, which a count
        alone cannot give. A redelivery that renewed a row's 90-day TTL would be a
        real defect: it would keep an aged-out day alive for the day sentinel.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        record = _record('INSERT', new=sample_feedback_item, event_id=self.ID)

        record_handler(record)
        before = sorted(aggregates.scan()['Items'], key=lambda i: (i['pk'], i['sk']))
        record_handler(record)

        assert sorted(aggregates.scan()['Items'], key=lambda i: (i['pk'], i['sk'])) == before

    def test_the_average_is_not_applied_twice_either(
        self, deduped_tables, sample_feedback_item
    ):
        """The average is in the transaction too, and it is the row that misleads most.

        `get_summary` divides `sum/count` per date and weights it by count into the
        headline `avg_sentiment`, so a double-applied score is served-data corruption
        rather than an off-by-one in a counter nobody reads.
        """
        from aggregator.handler import SENTIMENT_AVG_PK, record_handler

        aggregates, _ = deduped_tables
        record = _record('INSERT', new=sample_feedback_item, event_id=self.ID)

        record_handler(record)
        record_handler(record)

        row = aggregates.get_item(Key={'pk': SENTIMENT_AVG_PK, 'sk': '2025-01-15'})['Item']
        assert (row['count'], row['sum']) == (Decimal(1), Decimal('0.85'))

    def test_the_second_delivery_is_reported_as_a_skip_not_a_failure(
        self, deduped_tables, sample_feedback_item
    ):
        """🔑 IT MUST NOT RAISE, and that is not a cosmetic preference.

        `reportBatchItemFailures: true` means a record that raises is reported failed
        and redelivered — and Streams preserve per-shard order, so a record that fails
        forever blocks its partition. An idempotency guard that reported "already
        done" as an error would therefore convert a harmless redelivery into a stalled
        shard: strictly worse than the double-count it was added to prevent.
        """
        from aggregator.handler import record_handler

        record = _record('INSERT', new=sample_feedback_item, event_id=self.ID)

        assert record_handler(record) == {"status": "success"}
        assert record_handler(record) == {"status": "skipped", "reason": "already applied"}

    def test_a_replayed_record_is_counted_so_the_guard_is_not_silently_inert(
        self, deduped_tables, sample_feedback_item
    ):
        """At zero, a working guard and a deleted one look identical from outside.

        REPLAYED_METRIC is what tells them apart, and it is also the signal that a
        batch is failing and re-presenting records — the condition this change exists
        to make survivable. UPDATED_METRIC must NOT fire for the replay: nothing was
        updated, and a metric claiming otherwise is the blindness the per-behaviour
        metrics exist to remove.
        """
        from aggregator.handler import REPLAYED_METRIC, UPDATED_METRIC, record_handler

        record = _record('INSERT', new=sample_feedback_item, event_id=self.ID)
        record_handler(record)

        with patch('aggregator.handler.metrics') as mock_metrics:
            record_handler(record)

        assert [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list] == [
            REPLAYED_METRIC,
        ]
        assert UPDATED_METRIC != REPLAYED_METRIC

    def test_two_different_records_for_one_item_are_both_applied(
        self, deduped_tables, sample_feedback_item
    ):
        """The claim is per RECORD, and the positive control for the whole class.

        Keying on anything about the ITEM — its feedback_id, its source id — would
        pass every test above while dropping the second of two genuine stream records
        about one item. `eventID` is unique per record, which is what makes the guard
        a redelivery test rather than a de-duplication of the feedback itself.
        """
        from aggregator.handler import record_handler

        aggregates, idempotency = deduped_tables

        record_handler(_record('INSERT', new=sample_feedback_item, event_id='first'))
        record_handler(_record('INSERT', new=sample_feedback_item, event_id='second'))

        assert _counts(aggregates)['METRIC#daily_total'] == Decimal(2)
        assert idempotency.scan()['Count'] == 2

    def test_a_record_that_fails_partway_leaves_no_counter_moved(
        self, deduped_tables, sample_urgent_feedback_item
    ):
        """🔑 THE PARTIAL-APPLICATION CRITERION, which the claim alone does not meet.

        This is the case that produces INTERNALLY INCONSISTENT metrics: with one
        independent `update_item` call per dimension, a record that dies partway has
        applied the ones before it, so the daily total no longer equals the sum of the
        per-category counts — and the retry applies every one of them on top. A marker written before
        the writes records the half-application as done; written after, it leaves it to
        be re-applied. Only transacting them removes the partial state itself.

        ⚠️ THE FAILURE IS INJECTED MID-WAY THROUGH THE WRITES, and that is what makes
        the arrangement honest. `_POISON_PK` sorts BETWEEN the per-category counter and
        `METRIC#daily_total`, so against the unfixed code the category count lands, the
        daily total does not, and the two disagree — the exact state the issue
        describes. Poisoning the LAST write instead (the average) was the first
        version and it proved nothing: every counter had already been applied by then,
        so the totals agreed and the test passed against the defect it was written for.

        The assertion is the one the acceptance criteria state — the daily total agrees
        with the sum of the per-category counts — asserted over the aggregates rather
        than over a call count, so it is about the DATA and not the shape of a request.
        """
        from aggregator.handler import record_handler

        aggregates, idempotency = deduped_tables
        self._poison(aggregates)

        with pytest.raises(ClientError):
            record_handler(_record('INSERT', new=sample_urgent_feedback_item,
                                   event_id=self.ID))

        # The poison row itself is excluded: the test PUT it, so its presence says
        # nothing about what the handler wrote, and leaving it in made the assertion
        # fail on the arrangement rather than on the behaviour.
        counts = {pk: value for pk, value in _counts(aggregates).items()
                  if pk != self._POISON_PK}
        assert counts == {}, (
            f'{counts}: some counters moved while the record failed, so the daily '
            f'total and the per-category counts now describe different sets of items '
            f'— the internally inconsistent state a transaction exists to prevent'
        )
        # And the record is NOT recorded as applied, so the retry can do the whole of
        # it. A claim that survived the failure would be worse than no claim at all.
        assert idempotency.scan()['Count'] == 0

    def test_the_retry_of_that_record_applies_it_exactly_once(
        self, deduped_tables, sample_urgent_feedback_item
    ):
        """The other half of the criterion: after the retry, the totals AGREE.

        The positive control for the test above — an implementation that failed
        closed by writing nothing ever would pass that one and fail this.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        self._poison(aggregates)
        record = _record('INSERT', new=sample_urgent_feedback_item, event_id=self.ID)
        with pytest.raises(ClientError):
            record_handler(record)

        # The bad row is cleared and the record is re-presented, which is what
        # `reportBatchItemFailures: true` does.
        self._unpoison(aggregates)
        assert record_handler(record) == {"status": "success"}

        counts = _counts(aggregates)
        categories = sum(v for pk, v in counts.items()
                         if pk.startswith('METRIC#daily_category#'))
        assert counts['METRIC#daily_total'] == categories == Decimal(1), counts

    def test_a_cancellation_that_is_not_the_claim_is_raised_for_retry(
        self, deduped_tables, sample_feedback_item
    ):
        """A conflict on a counter row is NOT an already-applied record.

        Two records of the same day arriving together really do produce
        `TransactionConflictException`, and calling that "already applied" would
        silently lose the record's aggregates: nothing was written, and reporting
        success means nothing ever will be. So the decision reads the CLAIM's own
        cancellation reason rather than the exception being a cancellation.

        Built as the response shape DynamoDB sends — reasons are positional, the claim
        is item 0 — rather than by arranging a real conflict, which moto cannot
        produce on demand.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        conflict = ClientError(
            {
                'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
                'CancellationReasons': [
                    {'Code': 'None'},
                    {'Code': 'TransactionConflict', 'Message': 'conflict'},
                ],
            },
            'TransactWriteItems',
        )
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=conflict):
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

    def test_a_cancellation_whose_reasons_cannot_be_read_is_raised_too(
        self, deduped_tables, sample_feedback_item
    ):
        """The fail direction of the one conclusion that reports success.

        "Already applied" ends the record, so it needs positive evidence — the same
        rule `CounterWrite.ROW_ABSENT` follows. A retry of an unapplied record is
        correct and a retry of an applied one is refused by the claim it holds, so
        being wrong in THIS direction costs nothing, while the other drops aggregates
        for any response shape this could not parse.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        unreadable = ClientError(
            {'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'}},
            'TransactWriteItems',
        )
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=unreadable):
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

    def test_an_unconfigured_dedupe_table_still_aggregates(
        self, real_aggregates_table, sample_feedback_item
    ):
        """A missing table NAME degrades the protection; it must not stop the counting.

        `IDEMPOTENCY_TABLE` unset is a CDK regression, and the right response to one
        is the pre-#264 behaviour plus the warning this module logs at import — not a
        Lambda that raises on every record and blocks its shard. `real_aggregates_table`
        rather than `deduped_tables` IS the arrangement: that fixture is the one where
        the name is not patched in.
        """
        from aggregator.handler import IDEMPOTENCY_TABLE, record_handler

        assert not IDEMPOTENCY_TABLE, 'the arrangement requires an unset table name'

        assert record_handler(_record('INSERT', new=sample_feedback_item,
                                      event_id=self.ID)) == {"status": "success"}

        assert _counts(real_aggregates_table)['METRIC#daily_total'] == Decimal(1)

    def test_a_record_with_no_event_id_is_applied_rather_than_dropped(
        self, deduped_tables, sample_feedback_item
    ):
        """The other fail-open direction, and the same judgement the module makes
        elsewhere: aggregating a record twice is recoverable, never aggregating it is
        not. `is_ttl_expiry` and `_day_has_aggregates` both fail in this direction.
        """
        from aggregator.handler import record_handler

        aggregates, idempotency = deduped_tables

        assert record_handler(
            _record('INSERT', new=sample_feedback_item)
        ) == {"status": "success"}

        assert _counts(aggregates)['METRIC#daily_total'] == Decimal(1)
        assert idempotency.scan()['Count'] == 0, 'nothing to claim without a record id'

    def test_the_claim_expires_so_markers_do_not_accumulate_forever(
        self, deduped_tables, sample_feedback_item
    ):
        """The marker carries the table's TTL attribute, or the table grows without end.

        `lib/stacks/core-stack.ts` gives the idempotency table
        `timeToLiveAttribute: 'expiration'`, and a marker written under any other name
        is one DynamoDB will never delete — a leak no error and no other test reports.

        The horizon is read off the item rather than restated, and what it is compared
        against is the STREAM'S retention: a marker must outlive the window a
        redelivery can arrive in, or the last possible redelivery finds it gone and is
        applied twice. Asserting `> 24h` rather than `>= 24h` is the point — an
        expiry equal to the horizon races the TTL deleting its own marker, and TTL
        deletion is best-effort anyway. This is what caught the first version of the
        constant, which was exactly 24 hours.
        """
        from datetime import timezone as tz

        from aggregator.handler import record_handler
        from shared.idempotency import (
            IDEMPOTENCY_EXPIRY_ATTRIBUTE,
            IDEMPOTENCY_KEY_ATTRIBUTE,
        )

        stream_retention_seconds = 24 * 60 * 60
        _, idempotency = deduped_tables
        record_handler(_record('INSERT', new=sample_feedback_item, event_id=self.ID))

        marker = idempotency.scan()['Items'][0]
        assert IDEMPOTENCY_KEY_ATTRIBUTE in marker
        now = datetime.now(tz.utc).timestamp()
        assert marker[IDEMPOTENCY_EXPIRY_ATTRIBUTE] > now + stream_retention_seconds, (
            'the claim does not outlive the 24 hours a stream record survives, so a '
            'late redelivery would find the marker gone and be applied again'
        )

    def test_the_claim_is_namespaced_away_from_the_processors_keys(
        self, deduped_tables, sample_feedback_item
    ):
        """One table, two writers: a stream `eventID` must not collide with a
        `{source_platform}:{source_id}` the processor claims. A collision would make
        one of the two silently skip real work, in whichever direction lost the race.
        """
        from aggregator.handler import record_handler
        from shared.idempotency import IDEMPOTENCY_KEY_ATTRIBUTE

        _, idempotency = deduped_tables
        record_handler(_record('INSERT', new=sample_feedback_item, event_id=self.ID))

        key = idempotency.scan()['Items'][0][IDEMPOTENCY_KEY_ATTRIBUTE]
        assert key.startswith('aggregator#'), key
        assert self.ID in key, key


class TestTheTransactionIsAnArrivalAndOnlyAnArrival:
    """What the transactional path may build, asserted on the REQUEST it assembles.

    Review of #264 found three ways this path could be right today and wrong after an
    ordinary-looking change, all of them silent, and none of them reachable through
    `record_handler` — so they are pinned where they are decided.

    REVERT MAP, each entry RUN:
      * Give `counter_transaction_items` or `_average_transaction_item` a `sign` again
        and thread it — fails test_no_transaction_builder_offers_a_direction. The
        original defect: the sign reached the counters and the average hardcoded `+1`,
        so `sign=-1` decremented seven counters while INCREMENTING the average, and the
        transaction guaranteed that inconsistent state committed whole. Nothing raised.
      * Add a `counter_dimensions` entry on an EXISTING pk with a different field —
        fails test_the_transaction_names_each_item_once, where production would answer
        `ValidationException` for every ingested record.
      * Strip `metric_type` from `_counter_request`, or build the transaction items
        without going through it — fails test_an_arrival_tags_the_rows_the_gsi_reads.
      * Spell the average's attribute names a second time in
        `_average_transaction_item` and rename one (`total` for `sum`, say) — fails
        test_both_average_writers_spend_one_expression, where the day would simply
        read as having no average.
    """

    DATE = '2025-01-15'

    def _items(self, item) -> list[dict]:
        from aggregator.handler import (
            SENTIMENT_AVG_PK,
            _average_transaction_item,
            _image_score,
            counter_keys,
            counter_transaction_items,
        )

        items = counter_transaction_items(counter_keys(item, self.DATE))
        score = _image_score(item)
        if score:
            items.append(_average_transaction_item(SENTIMENT_AVG_PK, self.DATE, score))
        return items

    def test_no_transaction_builder_offers_a_direction(self):
        """🔑 A `sign=-1` MUST NOT BE EXPRESSIBLE HERE, and the check is on the
        signatures rather than on a call, because the defect was a parameter that
        existed and was half honoured — the counters took it, the average ignored it.
        A test calling with `-1` would have to assert the resulting mixed-direction
        request is "wrong", which is a judgement; a builder that takes no direction
        cannot produce one, which is a fact.

        `_counter_transaction_item` keeps `increment` (`_counter_request` reads its SIGN
        to decide the floor condition), so what is asserted of it is that it DEFAULTS to
        an increment — the pair `counter_transaction_items` no longer passes.
        """
        from inspect import signature

        from aggregator.handler import (
            _average_transaction_item,
            _counter_transaction_item,
            counter_transaction_items,
        )

        for builder in (counter_transaction_items, _average_transaction_item):
            assert 'sign' not in signature(builder).parameters, (
                f'{builder.__name__} takes a direction again. Only the counters can '
                f'honour one — the average row moves `sum` and `count` — so a '
                f'reversal built here commits the counters DOWN and the average UP, '
                f'atomically, which is worse than the split it replaced. Reversals '
                f'stay on the single-write path; see apply_arrival_once.'
            )

        increment = signature(_counter_transaction_item).parameters['increment']
        assert increment.default == 1, (
            'the transactional counter builder no longer defaults to an increment, so '
            'a decrement can reach a transaction — where its refusal, which '
            '_reverse_a_pre_deploy_persona_row reads, cancels every other write '
            'instead of being reported'
        )

    def test_the_transaction_names_each_item_once(self, sample_urgent_feedback_item):
        """DynamoDB refuses two operations on ONE item, and it refuses the whole request.

        So this is not a drift but an outage: every ingested record would fail with
        `ValidationException`. What decides it is `counter_dimensions` — `counter_keys`
        returns `(pk, date, field)`, so two dimensions on one pk with different fields
        are two entries here and one item there. The urgent fixture, so every dimension
        is present.
        """
        keys = {(item['Update']['TableName'],
                 item['Update']['Key']['pk'],
                 item['Update']['Key']['sk'])
                for item in self._items(sample_urgent_feedback_item)}
        items = self._items(sample_urgent_feedback_item)

        assert len(keys) == len(items), (
            f'{len(items)} transaction entries name only {len(keys)} distinct '
            f'(table, pk, sk) triples. DynamoDB rejects a transaction containing two '
            f'operations on one item and rejects the WHOLE request, so every ingested '
            f'record would fail. If a new counter_dimensions entry shares a pk with '
            f'an existing one, that dimension has to be a new pk or the two fields '
            f'have to be one write.'
        )
        # The denominator: an empty list would satisfy the equality above.
        assert len(items) >= 2, items

    def test_an_arrival_tags_the_rows_the_gsi_reads(
        self, deduped_tables, sample_feedback_item
    ):
        """`metric_type` is what puts a row on `gsi1-by-metric-type`, and the existing
        assertions for it inspect `update_item` kwargs — i.e. the path an arrival NO
        LONGER TAKES.

        It is written correctly today because `_counter_transaction_item` delegates to
        the shared `_counter_request`. This is the test that fails if a future
        transaction builder stops doing so: `/metrics/sources` and `/metrics/personas`
        would then read an empty GSI while every count stayed correct — the "dimension
        useless while looking populated" shape `counter_dimensions` describes at length.
        `_counts` projects to `{pk: count}` and drops the tag, so the redelivery tests
        cannot catch it.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        record_handler(_record('INSERT', new=sample_feedback_item, event_id='tagged'))

        tags = {row['pk']: row.get('metric_type')
                for row in aggregates.scan()['Items']}
        source = next(pk for pk in tags if pk.startswith('METRIC#daily_source#'))
        persona = next(pk for pk in tags if pk.startswith('METRIC#persona#'))

        assert tags[source] == 'source', tags
        assert tags[persona] == 'persona', tags
        # And nothing else is tagged: a builder that stamped every row would put the
        # daily total on the GSI, which both metrics routes would then double-count.
        assert tags['METRIC#daily_total'] is None, tags

    def test_both_average_writers_spend_one_expression(self):
        """The average's attribute names exist once, as the counter's already did.

        `sum` and `count` are what `get_summary` reads back, and the retention lockstep
        compares only the writers' `ttl_days` defaults — so a second spelling here was
        free to rename an attribute with nothing failing, and a transactional row
        holding `total` reads as a day with no average at all. Compared as the REQUESTS
        the two writers build, since that is the thing that must agree.
        """
        from aggregator.handler import (
            SENTIMENT_AVG_PK,
            _average_request,
            _average_transaction_item,
        )

        transactional = _average_transaction_item(
            SENTIMENT_AVG_PK, self.DATE, Decimal('0.5'),
        )['Update']
        single = _average_request(SENTIMENT_AVG_PK, self.DATE, Decimal('0.5'), 90, 1)

        assert transactional['UpdateExpression'] == single['UpdateExpression']
        assert (transactional['ExpressionAttributeNames']
                == single['ExpressionAttributeNames']
                == {'#sum': 'sum', '#count': 'count', '#ttl': 'ttl'})
        # `:one` is the COUNT movement, so an arrival's is +1 in both.
        assert transactional['ExpressionAttributeValues'][':one'] == 1
        assert single['ExpressionAttributeValues'][':one'] == 1

    def test_an_arrival_moves_the_average_in_the_same_direction_as_its_counters(
        self, deduped_tables, sample_feedback_item
    ):
        """The end-to-end statement of the same thing, over the DATA.

        The original defect was expressible precisely because nothing compared the two
        directions: the counters went down while the average went up. An arrival is the
        only direction this path has, so both must move UP together.
        """
        from aggregator.handler import SENTIMENT_AVG_PK, record_handler

        aggregates, _ = deduped_tables
        record_handler(_record('INSERT', new=sample_feedback_item, event_id='forwards'))

        average = aggregates.get_item(
            Key={'pk': SENTIMENT_AVG_PK, 'sk': self.DATE},
        )['Item']
        assert _counts(aggregates)['METRIC#daily_total'] == Decimal(1)
        assert average['count'] == Decimal(1)
        assert average['sum'] > Decimal(0), average

    def test_the_two_arrival_paths_write_the_same_rows(
        self, deduped_tables, sample_urgent_feedback_item
    ):
        """🔑 PARITY, because there are now TWO implementations of an arrival and the
        default test path is the OLD one.

        `_record(...)` omits `event_id` by default — deliberately, so the two dozen
        "which counters does an arrival move?" tests measure dimensions rather than the
        claim — which means every one of them exercises `apply_feedback`, the
        non-transactional path production no longer takes for an INSERT. A dimension
        reachable from one and not the other would be green in both directions.

        Compared on the ROWS, not on the calls: `updated_at` and the TTL are stamped
        from the clock, so the comparison is over (pk, sk, count) and the average's
        (sum, count). Two separate fixtures would be cleaner but cannot share one moto
        table, so ONE date is used for both passes and the rows are DELETED between
        them — which is what makes the second pass' counts comparable to the first's
        rather than double them.
        """
        from aggregator.handler import SENTIMENT_AVG_PK, record_handler

        aggregates, _ = deduped_tables

        # The transactional path: a record carrying an eventID.
        record_handler(_record('INSERT', new=sample_urgent_feedback_item,
                               event_id='transactional'))
        transactional = _counts(aggregates)
        transactional_average = aggregates.get_item(
            Key={'pk': SENTIMENT_AVG_PK, 'sk': self.DATE})['Item']

        for pk in list(transactional) + [SENTIMENT_AVG_PK]:
            aggregates.delete_item(Key={'pk': pk, 'sk': self.DATE})

        # The single-write path: the same item, no eventID.
        record_handler(_record('INSERT', new=sample_urgent_feedback_item))
        single = _counts(aggregates)
        single_average = aggregates.get_item(
            Key={'pk': SENTIMENT_AVG_PK, 'sk': self.DATE})['Item']

        assert transactional == single, (
            'the transactional and single-write arrival paths write different counter '
            'rows for one item, so the dimension tests — which take the single-write '
            'path — no longer describe what production does'
        )
        assert (transactional_average['sum'], transactional_average['count']) == (
            single_average['sum'], single_average['count'],
        )
        # The denominator, so an implementation that wrote nothing on both paths could
        # not satisfy the equality.
        assert transactional['METRIC#daily_total'] == Decimal(1), transactional
        assert len(transactional) == 7, transactional


class TestAWriteConflictIsRetriedRatherThanReported:
    """Contention on `METRIC#daily_total` must not cost a record (review of #264).

    Every record of a date moves that one row, `batchSize` is 100, and botocore does
    NOT auto-retry `TransactionCanceledException` — so contention a plain `update_item`
    used to absorb at the request level now arrives as a cancellation. Left to
    propagate it is a reported record failure with only `retryAttempts: 3` left before
    the record is DROPPED and its aggregates lost permanently, which is strictly worse
    than the double-count the transaction was introduced to remove.

    `ballots_handler._write_ballot` faces the same DynamoDB fact and reaches the same
    answer for a different reason (a voter who cannot resubmit); the aggregator's is
    that the stream would otherwise be the only retry budget. Both use three attempts.

    THROTTLING IS THE SAME PROBLEM, and it is retried for the same reason. Botocore's
    throttling policies match the TOP-LEVEL error code, which for a cancelled
    transaction is always `TransactionCanceledException` — the throttle is one level
    down, inside the reasons — so nothing absorbs it and an unretried throttle costs
    the record exactly what an unretried conflict does. This module already calls
    throttling transient for the day READ (`_TRANSIENT_READ_ERRORS`), so the write path
    reaching the opposite conclusion about one condition was the defect, not a policy.

    REVERT MAP, each entry RUN:
      * Delete the `_conflicted` branch from `_claimed_transaction` — fails
        test_a_conflicted_transaction_is_re_attempted and
        test_a_conflict_that_clears_leaves_the_record_applied.
      * Retry ANY cancellation (drop the reason check in `_conflicted`) — fails
        test_a_validation_failure_is_not_retried, whose subject is that a request
        which will fail identically must not be re-sent: it spends the invocation and
        delays the record.
      * Narrow `_RETRYABLE_CANCELLATION_REASONS` back to the conflict alone — fails
        test_a_throttled_transaction_is_re_attempted_like_a_conflict and
        test_every_retryable_reason_is_transient_on_the_read_path_too. Measured: with
        only `TransactionConflict` in the set, a throttled cancellation is attempted
        ONCE and raised, so the record has only `retryAttempts: 3` left before it is
        dropped with its aggregates lost permanently.
      * Make `_conflicted` `any` rather than `all` — fails
        test_a_conflict_alongside_a_permanent_reason_is_not_retried. Measured: reasons
        `[None, TransactionConflict, ValidationError]` were re-attempted to the bound
        (3 attempts, 2 sleeps) on a request that cannot succeed, which is the cost
        test_a_validation_failure_is_not_retried exists to prevent.
      * Treat `NO_CANCELLATION_REASON` as blocking — fails
        test_a_conflicted_transaction_is_re_attempted, since a cancelled transaction
        reports one reason per item and most items did not fail, so `'None'` is the
        commonest entry in any real response.
      * Retry forever — fails test_the_attempts_are_bounded, which is what keeps a
        contended shard from holding Lambda concurrency in a tight loop.
      * Set TRANSACT_WRITE_ATTEMPTS to 0 — fails
        test_the_attempt_bound_leaves_at_least_one_attempt, where a record would
        otherwise be reported "already applied" having never been written.
    """

    ID = 'a-contended-record'

    @staticmethod
    def _cancelled(*codes: str) -> ClientError:
        """A cancellation naming `codes`, one reason per item, in that order.

        Built as the response shape DynamoDB sends rather than by provoking a real
        cancellation, which moto cannot produce on demand. Reasons are POSITIONAL and
        complete — one entry per transaction item, `'None'` for every item that did not
        fail — so the caller passes the codes in item order and the claim at index 0 is
        normally `'None'`: its key is unique per record, so no other record can contend
        or throttle it.
        """
        return ClientError(
            {
                'Error': {'Code': 'TransactionCanceledException',
                          'Message': 'cancelled'},
                'CancellationReasons': [{'Code': code} for code in codes],
            },
            'TransactWriteItems',
        )

    @classmethod
    def _conflict(cls) -> ClientError:
        """The response shape DynamoDB sends for a contended item.

        The conflict sits at index 1 — a counter — which is where contention really
        happens: the claim's key is unique per record and cannot be contended at all.
        """
        return cls._cancelled('None', 'TransactionConflict')

    def test_a_conflicted_transaction_is_re_attempted(
        self, deduped_tables, sample_feedback_item
    ):
        """The first conflict is retried rather than raised, and the retry is what
        writes the record. Without it this record is reported failed on its first
        collision with another record of the same day."""
        from aggregator.handler import TRANSACT_WRITE_ATTEMPTS, record_handler

        aggregates, _ = deduped_tables
        real = aggregates.meta.client.transact_write_items
        # Conflict once, then let the real transaction through.
        attempts = iter([self._conflict()])

        def flaky(**kwargs):
            failure = next(attempts, None)
            if failure is not None:
                raise failure
            return real(**kwargs)

        with patch.object(aggregates.meta.client, 'transact_write_items', flaky), \
                patch('aggregator.handler.time.sleep') as slept:
            assert record_handler(
                _record('INSERT', new=sample_feedback_item, event_id=self.ID)
            ) == {"status": "success"}

        assert _counts(aggregates)['METRIC#daily_total'] == Decimal(1)
        # It WAITED, and it did not wait zero: a retry with no backoff re-collides.
        assert slept.call_count == 1
        assert slept.call_args.args[0] > 0
        assert TRANSACT_WRITE_ATTEMPTS >= 2, 'the arrangement needs a retry to exist'

    def test_a_conflict_that_clears_leaves_the_record_applied_exactly_once(
        self, deduped_tables, sample_feedback_item
    ):
        """The counters are not applied twice by the retry, which is the property that
        makes retrying safe at all: nothing was written by the cancelled attempt.

        The positive control for the test above — an implementation that retried by
        re-issuing only PART of the transaction would pass that one and fail this.
        """
        from aggregator.handler import record_handler

        aggregates, idempotency = deduped_tables
        real = aggregates.meta.client.transact_write_items
        attempts = iter([self._conflict()])

        def flaky(**kwargs):
            failure = next(attempts, None)
            if failure is not None:
                raise failure
            return real(**kwargs)

        with patch.object(aggregates.meta.client, 'transact_write_items', flaky), \
                patch('aggregator.handler.time.sleep'):
            record_handler(_record('INSERT', new=sample_feedback_item, event_id=self.ID))

        counts = _counts(aggregates)
        categories = sum(v for pk, v in counts.items()
                         if pk.startswith('METRIC#daily_category#'))
        assert counts['METRIC#daily_total'] == categories == Decimal(1), counts
        assert idempotency.scan()['Count'] == 1

    def test_the_attempts_are_bounded(self, deduped_tables, sample_feedback_item):
        """A shard that is permanently contended must not hold concurrency forever.

        Past the bound the record is reported failed and the STREAM redelivers it,
        which the claim makes safe — so the in-process budget is a small optimisation
        over that, not a replacement for it.
        """
        from aggregator.handler import TRANSACT_WRITE_ATTEMPTS, record_handler

        aggregates, _ = deduped_tables
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=self._conflict()) as attempted, \
                patch('aggregator.handler.time.sleep'):
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

        assert attempted.call_count == TRANSACT_WRITE_ATTEMPTS, (
            'a permanently conflicted transaction was attempted a different number of '
            'times than the bound allows'
        )

    def test_a_conflict_is_counted_so_the_contention_is_visible(
        self, deduped_tables, sample_feedback_item
    ):
        """A retry that succeeds is invisible, which is exactly why it needs a metric.

        CONFLICTED_METRIC is how an operator sees that the batch size or the
        parallelization factor is creating contention on the day's hot row — the trade
        this retry makes, rather than the behaviour it produces.
        """
        from aggregator.handler import CONFLICTED_METRIC, record_handler

        aggregates, _ = deduped_tables
        real = aggregates.meta.client.transact_write_items
        attempts = iter([self._conflict()])

        def flaky(**kwargs):
            failure = next(attempts, None)
            if failure is not None:
                raise failure
            return real(**kwargs)

        with patch.object(aggregates.meta.client, 'transact_write_items', flaky), \
                patch('aggregator.handler.time.sleep'), \
                patch('aggregator.handler.metrics') as mock_metrics:
            record_handler(_record('INSERT', new=sample_feedback_item, event_id=self.ID))

        emitted = [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list]
        assert CONFLICTED_METRIC in emitted, emitted

    def test_a_validation_failure_is_not_retried(
        self, deduped_tables, sample_feedback_item
    ):
        """A `ValidationException` will fail identically on the next attempt, so
        re-sending it spends the invocation's time and delays the record for nothing —
        the same reason `_write_ballot` does not retry a row that has gone away.

        The complement of the two transient reasons, and the reason
        `_RETRYABLE_CANCELLATION_REASONS` is an allowlist rather than a denylist: a
        reason code this module has never heard of is far more likely to be permanent
        than transient, so an unknown one must not buy a retry.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        permanent = self._cancelled('None', 'ValidationError')
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=permanent) as attempted:
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

        assert attempted.call_count == 1, (
            'a cancellation no contention caused was re-attempted; it will fail the '
            'same way and the record is delayed by every wait'
        )

    @pytest.mark.parametrize('reason', ['ThrottlingError',
                                        'ProvisionedThroughputExceeded'])
    def test_a_throttled_transaction_is_re_attempted_like_a_conflict(
        self, deduped_tables, sample_feedback_item, reason
    ):
        """🔑 A THROTTLE IS AS TRANSIENT AS A CONFLICT, AND NOTHING ELSE ABSORBS IT.

        Botocore's throttling policies match the TOP-LEVEL `service_error_code`, and a
        throttled transaction's is `TransactionCanceledException` — the throttle is one
        level down, in the reasons — so `botocore/data/_retry.json` never matches it.
        Unretried, a throttled arrival gets ONE attempt, then spends the event source's
        `retryAttempts: 3`, and past that is dropped with its aggregates lost for good.

        Both spellings, because `_TRANSIENT_READ_ERRORS` already calls both transient
        for the day read (as `ThrottlingException` and
        `ProvisionedThroughputExceededException`), and the write path reaching the
        opposite conclusion about the same condition was the defect. Fails if
        `_RETRYABLE_CANCELLATION_REASONS` is narrowed back to the conflict alone.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        real = aggregates.meta.client.transact_write_items
        attempts = iter([self._cancelled('None', reason)])

        def flaky(**kwargs):
            failure = next(attempts, None)
            if failure is not None:
                raise failure
            return real(**kwargs)

        with patch.object(aggregates.meta.client, 'transact_write_items', flaky), \
                patch('aggregator.handler.time.sleep') as slept:
            assert record_handler(
                _record('INSERT', new=sample_feedback_item, event_id=self.ID)
            ) == {"status": "success"}

        # The retry is what wrote the record, and it waited first.
        assert _counts(aggregates)['METRIC#daily_total'] == Decimal(1)
        assert slept.call_count == 1

    def test_a_conflict_alongside_a_permanent_reason_is_not_retried(
        self, deduped_tables, sample_feedback_item
    ):
        """🔑 "TRANSIENT AND NOTHING ELSE", which is why `_conflicted` is `all`.

        It was `any`, so one contended item licensed the retry no matter what the other
        reasons said — and a cancellation carrying BOTH a conflict and a
        `ValidationError` was then re-attempted to the full bound on a request that
        cannot succeed. That is exactly the cost
        test_a_validation_failure_is_not_retried exists to prevent, reached whenever the
        two coincide, which the poison-row shape elsewhere in this file makes ordinary:
        a `ValidationError` on one item, and a collision on `METRIC#daily_total` if
        another record of the day arrives in the same batch.

        Nothing is lost by refusing: the transaction wrote nothing either way, and the
        permanent item refuses every re-attempt identically, so a retry could only add
        delay before reporting the same failure.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        mixed = self._cancelled('None', 'TransactionConflict', 'ValidationError')
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=mixed) as attempted, \
                patch('aggregator.handler.time.sleep') as slept:
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

        assert attempted.call_count == 1, (
            'a cancellation carrying a permanent reason was re-attempted because '
            'another item merely contended; every one of those attempts fails on the '
            'permanent item, so the bound is spent to reach the same report'
        )
        assert slept.call_count == 0

    def test_a_cancellation_naming_no_failure_at_all_is_not_retried(
        self, deduped_tables, sample_feedback_item
    ):
        """The denominator for `NO_CANCELLATION_REASON` being treated as "says nothing".

        `'None'` cannot veto a retry — a cancelled transaction reports one reason per
        item and most items did not fail, so it is the commonest entry in any real
        response — but it must not GRANT one either, or a cancellation this module
        cannot explain would be retried to the bound on the strength of no evidence.
        """
        from aggregator.handler import record_handler

        aggregates, _ = deduped_tables
        with patch.object(aggregates.meta.client, 'transact_write_items',
                          side_effect=self._cancelled('None', 'None')) as attempted:
            with pytest.raises(ClientError):
                record_handler(_record('INSERT', new=sample_feedback_item,
                                       event_id=self.ID))

        assert attempted.call_count == 1

    def test_every_retryable_reason_is_transient_on_the_read_path_too(self):
        """The two paths must not disagree about one condition.

        `_TRANSIENT_READ_ERRORS` decides what a transient failure of the day READ is;
        `_RETRYABLE_CANCELLATION_REASONS` decides the same for the transactional WRITE.
        This is what fails if one grows a member the other lacks — the divergence that
        produced the throttling gap, where the read called it transient and the write
        did not.

        🔑 THE PAIRING IS SPELLED OUT RATHER THAN DERIVED, and that is the finding.
        Appending `Exception` works for two of the three and NOT for the throttle: the
        reasons list says `ThrottlingError` where the exception is `ThrottlingException`,
        so a suffix rule would have quietly passed on a mapping it got wrong. There is
        no algorithm relating the two vocabularies, which is exactly why both sets are
        named in full in the module and why this table is written out here.
        """
        from aggregator.handler import (
            _RETRYABLE_CANCELLATION_REASONS,
            _TRANSIENT_READ_ERRORS,
        )

        # reason code (in CancellationReasons) -> exception code (on a plain request)
        same_condition = {
            'TransactionConflict': 'TransactionConflictException',
            'ThrottlingError': 'ThrottlingException',
            'ProvisionedThroughputExceeded': 'ProvisionedThroughputExceededException',
        }

        assert set(same_condition) == set(_RETRYABLE_CANCELLATION_REASONS), (
            'a retryable cancellation reason has no counterpart named here, so nothing '
            'checks whether the read path agrees it is transient'
        )
        for reason, exception in same_condition.items():
            assert exception in _TRANSIENT_READ_ERRORS, (
                f'{reason!r} is retried as a cancelled transaction but {exception!r} '
                f'is not transient for the day read, so the two paths disagree about '
                f'one DynamoDB condition. Add it to _TRANSIENT_READ_ERRORS, or say at '
                f'_RETRYABLE_CANCELLATION_REASONS why the write is special.'
            )

    def test_a_redelivery_is_still_a_skip_and_not_a_retry(
        self, deduped_tables, sample_feedback_item
    ):
        """The claim's refusal must be read BEFORE the conflict check, or a redelivery
        would be retried until the bound and then reported failed — a stalled shard in
        place of a harmless duplicate, which is the outcome this whole change is meant
        to avoid.
        """
        from aggregator.handler import record_handler

        record = _record('INSERT', new=sample_feedback_item, event_id=self.ID)
        assert record_handler(record) == {"status": "success"}

        with patch('aggregator.handler.time.sleep') as slept:
            assert record_handler(record) == {
                "status": "skipped", "reason": "already applied",
            }
        assert slept.call_count == 0, 'a redelivery waited, so it was treated as a conflict'

    def test_the_attempt_bound_leaves_at_least_one_attempt(self):
        """The bound is a tuning number, so the assumption is a test rather than a hope.

        At 0 the loop yields nothing and the function falls through — where returning
        False would be read as "already applied", i.e. a record silently dropped and
        the batch reported clean. `_claimed_transaction` raises there instead; this
        pins the bound so that guard stays unreachable.
        """
        from aggregator.handler import TRANSACT_WRITE_ATTEMPTS

        assert TRANSACT_WRITE_ATTEMPTS >= 1, (
            'no aggregate transaction would be attempted at all, and a record never '
            'written would be reported as one already applied'
        )

    def test_the_conflict_reason_is_not_the_exception_code(self):
        """Two spellings of one condition, and neither is derivable from the other.

        DynamoDB reports a contended item as `TransactionConflict` inside
        `CancellationReasons` and as `TransactionConflictException` when a plain
        request fails. Matching the wrong one here is SILENT — the retry simply never
        fires, which looks identical to a system under no contention — so both
        spellings are named in the module and this says why they differ.
        """
        from aggregator.handler import (
            TRANSACTION_CONFLICT_REASON,
            _TRANSIENT_READ_ERRORS,
        )

        assert TRANSACTION_CONFLICT_REASON == 'TransactionConflict'
        assert TRANSACTION_CONFLICT_REASON not in _TRANSIENT_READ_ERRORS
        assert f'{TRANSACTION_CONFLICT_REASON}Exception' in _TRANSIENT_READ_ERRORS


class TestAnUnrecognizedEventIsSkippedRatherThanFatal:
    """The documented graceful skip has to be REACHABLE.

    `record.event_name` resolves through `DynamoDBRecordEventName[...]`, so reading
    it raises `KeyError` for any name outside the three the enum knows — before the
    membership check could return `skipped`. With `reportBatchItemFailures: true` the
    record would then be reported failed and redelivered until it aged out of the
    stream, and because Streams preserve per-shard order one permanently-failing
    record blocks its partition: a poison pill in place of the skip. Reading
    `raw_event` is what makes the branch reachable and testable.
    """

    def test_powertools_really_does_raise_on_an_unknown_event_name(self):
        """The premise, asserted rather than assumed.

        If a future Powertools stops raising, the handler's `raw_event` read is
        merely redundant instead of load-bearing, and this test says so.
        """
        record = _record('SOMETHING_NEW')
        with pytest.raises(KeyError):
            # Assigned rather than accessed bare, so this reads as the deliberate
            # evaluation it is (and not as a stray statement to a linter).
            resolved = record.event_name
            assert resolved  # unreachable; the property raises

    @patch('aggregator.handler.aggregates_table')
    def test_an_unrecognized_event_name_is_skipped(self, mock_table):
        from aggregator.handler import record_handler

        result = record_handler(_record('SOMETHING_NEW', new={'date': '2025-01-15'}))

        assert result == {"status": "skipped", "reason": "unrecognized event"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_record_with_no_event_name_at_all_is_skipped(self, mock_table):
        from aggregator.handler import record_handler

        record = DynamoDBRecord({'dynamodb': {'NewImage': _to_ddb({'date': '2025-01-15'})}})

        assert record_handler(record) == {"status": "skipped", "reason": "unrecognized event"}
        mock_table.update_item.assert_not_called()


class TestTtlExpiryIsReadFromTheEventNotFromPowertools:
    """The TTL branch must not be able to go dead silently.

    `hasattr(record, 'user_identity')` is always true, and an
    `isinstance(identity, dict)` test ties the branch to Powertools returning a bare
    dict. That holds across the versions in play — but a release that wrapped it in
    a `DictWrapper` would degrade the check to "user delete" for EVERY TTL REMOVE,
    which is the failure the module docstring spends a paragraph arguing against,
    with the whole branch dead and the suite still green (the tests build records
    from raw event dicts, so they follow Powertools rather than pinning it).
    """

    @patch('aggregator.handler.aggregates_table')
    def test_an_identity_arriving_as_another_mapping_is_still_ttl_expiry(self, mock_table):
        """Reading `raw_event` as a Mapping is what survives a wrapped value."""
        from aggregator.handler import is_ttl_expiry

        class Wrapped(Mapping):
            """Not a dict: the shape a future Powertools DictWrapper would take."""

            def __init__(self, data):
                self._data = data

            def __getitem__(self, key):
                return self._data[key]

            def __iter__(self):
                return iter(self._data)

            def __len__(self):
                return len(self._data)

        record = _record('REMOVE', old={'date': '2025-01-15'})
        record.raw_event['userIdentity'] = Wrapped(TTL_IDENTITY)

        assert is_ttl_expiry(record) is True

    def test_an_identity_that_is_not_a_mapping_is_a_user_delete(self):
        """The documented fail-toward-user-delete direction, unchanged."""
        from aggregator.handler import is_ttl_expiry

        record = _record('REMOVE', old={'date': '2025-01-15'})
        record.raw_event['userIdentity'] = 'dynamodb.amazonaws.com'

        assert is_ttl_expiry(record) is False


class TestTheDaySentinelIsTheCounterEveryItemWrites:
    """`_day_has_aggregates`'s argument depends on a fact about another function.

    Reading `METRIC#daily_total` is only a sound test of "is this day still here?"
    because that is the ONE counter every item writes unconditionally. That premise
    lives in `counter_dimensions`, so the two read one constant — and this class
    asserts the premise rather than trusting the comment that states it.
    """

    def test_the_sentinel_is_a_dimension_every_item_writes(self):
        from aggregator.handler import DAILY_TOTAL_PK, counter_dimensions

        for item in ({}, {'date': '2025-01-15'}, {'urgency': 'high', 'category': 'billing'}):
            assert (DAILY_TOTAL_PK, 'count') in counter_dimensions(item), (
                f'{item} writes no {DAILY_TOTAL_PK} counter, so its presence no '
                f'longer means "this day was ingested" and _day_has_aggregates is '
                f'reading a sentinel that can be absent for a live day.'
            )

    @patch('aggregator.handler.aggregates_table')
    def test_the_day_check_reads_that_same_pk(self, mock_table, sample_feedback_item):
        """One constant, so the sentinel and the dimension cannot drift apart."""
        from aggregator.handler import DAILY_TOTAL_PK, record_handler

        mock_table.get_item.return_value = {}

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert [c.kwargs['Key']['pk'] for c in mock_table.get_item.call_args_list] == [
            DAILY_TOTAL_PK,
        ]

    @patch('aggregator.handler.logger')
    @patch('aggregator.handler.aggregates_table')
    def test_a_throttled_day_read_warns_and_fails_open(
        self, mock_table, mock_logger, sample_feedback_item
    ):
        """A blip: survive it, and say so at the level a blip deserves."""
        from aggregator.handler import record_handler

        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
            'GetItem',
        )

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert mock_table.update_item.call_count > 0
        assert mock_logger.warning.called
        assert not mock_logger.error.called

    @patch('aggregator.handler.logger')
    @patch('aggregator.handler.aggregates_table')
    def test_a_denied_day_read_fails_open_but_is_logged_as_an_error(
        self, mock_table, mock_logger, sample_feedback_item
    ):
        """A misconfiguration is not a bad afternoon.

        `AccessDeniedException` means this guard is PERMANENTLY inert: every edit to
        an aged-out day plants the fragments it exists to prevent, indefinitely. The
        fail-open direction is still right — dropping every edit is worse — but at
        `warning` it is indistinguishable from the throttle the fail-open was
        designed for, so nothing would ever surface it.
        """
        from aggregator.handler import record_handler

        mock_table.get_item.side_effect = ClientError(
            {'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'GetItem',
        )

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert mock_table.update_item.call_count > 0
        assert mock_logger.error.called


class TestEachBehaviourEmitsItsOwnMetric:
    """Three materially different behaviours, three metrics.

    One undifferentiated `AggregatesUpdated` would leave reversals unobservable in
    CloudWatch — a small echo of why the original bug lasted as long as it did:
    nothing outside the table could show whether aggregates ever came back DOWN. An
    operator confirming this fix is live watches AggregatesReversed; one watching for
    trouble watches AggregateWriteRefused.
    """

    @staticmethod
    def _names(mock_metrics) -> list[str]:
        return [c.kwargs['name'] for c in mock_metrics.add_metric.call_args_list]

    def test_the_four_metric_names_are_distinct(self):
        """The assertions below read the CONSTANTS, so this reads their values.

        Without this, pointing REVERSED_METRIC and REBUCKETED_METRIC back at
        `AggregatesUpdated` would leave every test in this class green while
        restoring exactly the blindness they exist to remove — the tests would be
        agreeing with the handler about a name instead of pinning that the three
        behaviours are TOLD APART. Verified by running that revert: it passes
        without this assertion and fails with it.
        """
        from aggregator import handler

        names = [handler.UPDATED_METRIC, handler.REVERSED_METRIC,
                 handler.REBUCKETED_METRIC, handler.REFUSED_METRIC]
        assert len(set(names)) == len(names), (
            f'The aggregator emits {names} for four different outcomes; two of them '
            f'share a name, so CloudWatch cannot tell an insert from a reversal — '
            f'which is the observability gap that let the original bug run.'
        )

    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_an_insert_counts_as_updated(self, mock_table, mock_metrics, sample_feedback_item):
        from aggregator.handler import UPDATED_METRIC, record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))

        assert self._names(mock_metrics) == [UPDATED_METRIC]

    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_a_delete_counts_as_reversed(self, mock_table, mock_metrics, sample_feedback_item):
        from aggregator.handler import REVERSED_METRIC, record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item))

        assert self._names(mock_metrics) == [REVERSED_METRIC]

    @patch('aggregator.handler.metrics')
    def test_an_edit_counts_as_rebucketed(self, mock_metrics, live_day_table, sample_feedback_item):
        from aggregator.handler import REBUCKETED_METRIC, record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert self._names(mock_metrics) == [REBUCKETED_METRIC]

    @patch('aggregator.handler.metrics')
    def test_an_edit_that_moved_nothing_counts_as_nothing(
        self, mock_metrics, live_day_table, sample_feedback_item
    ):
        """The metric means "aggregates moved", so a no-op edit must not inflate it."""
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'problem_summary': 'reworded'}))

        assert self._names(mock_metrics) == []

    @patch('aggregator.handler.metrics')
    def test_an_edit_to_an_aged_out_day_counts_as_nothing(
        self, mock_metrics, sample_feedback_item, real_aggregates_table
    ):
        """Skipped for the day being gone is still "no aggregates moved"."""
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert self._names(mock_metrics) == []

    @patch('aggregator.handler.metrics')
    def test_an_edit_whose_every_write_was_refused_counts_as_nothing(
        self, mock_metrics, real_aggregates_table, sample_feedback_item
    ):
        """"Aggregates moved" is a claim about writes that LANDED.

        A live day, and an edit whose only changed dimension is a decrement of
        `METRIC#urgent` — a row that never existed, because the item was never
        urgent. One write attempted, refused by its condition, zero aggregates
        moved. Counting attempts would put a datapoint on the one metric an operator
        reads to confirm reversals are happening, for an edit that moved nothing.

        Moto-backed of necessity: a mock cannot refuse the write, so against one this
        would pass with the landed/attempted distinction deleted.
        """
        from aggregator.handler import REFUSED_METRIC, record_handler

        # A live day (daily_total present) with no `METRIC#urgent` row on it.
        real_aggregates_table.put_item(
            Item={'pk': 'METRIC#daily_total', 'sk': '2025-01-15', 'count': Decimal(1)}
        )

        record_handler(_record('MODIFY', old={**sample_feedback_item, 'urgency': 'high'},
                               new={**sample_feedback_item, 'urgency': 'low'}))

        # The refusal is visible; the rebucket is not claimed.
        assert self._names(mock_metrics) == [REFUSED_METRIC]

    @patch('aggregator.handler.metrics')
    def test_an_edit_whose_only_landing_write_was_the_pre_deploy_compatibility_counts_as_nothing(
        self, mock_metrics, real_aggregates_table, sample_pre_deploy_feedback_item
    ):
        """REBUCKETED_METRIC claims THIS EDIT moved aggregates.

        The pre-deploy persona compatibility is a write the edit did not ask for: it
        corrects a row a previous deploy created. Folding it into the same total would
        make the metric fire for an edit whose own decrements and increments were
        every one refused — so an operator reading it would see an edit that moved
        nothing reported as one that did, which is the distinction REFUSED_METRIC and
        DECLINED_METRIC already exist to keep.

        Moto-backed of necessity: the arrangement needs a live day whose archetype row
        is genuinely ABSENT while the legacy row is genuinely present, and a mock
        cannot refuse the one and accept the other on the strength of the real
        condition.

        THE ARRANGEMENT, because it takes some doing to leave an edit with no landing
        write of its own: increments carry no condition, so they always land — the
        edit therefore has to move the item ONTO AN AGED-OUT DAY, where the increments
        are declined rather than attempted. On the day it leaves, `daily_total` is
        present at ZERO, which keeps the day live for `_day_has_aggregates` while the
        floor refuses its decrement; every other row it names is absent.
        """
        from aggregator.handler import (
            LEGACY_PERSONA_UNKNOWN,
            PERSONA_PREFIX,
            REBUCKETED_METRIC,
            record_handler,
        )

        old = {k: v for k, v in sample_pre_deploy_feedback_item.items()
               if k != 'persona_name'}
        real_aggregates_table.put_item(
            Item={'pk': 'METRIC#daily_total', 'sk': '2025-01-15', 'count': Decimal(0)}
        )
        real_aggregates_table.put_item(Item={
            'pk': f'{PERSONA_PREFIX}{LEGACY_PERSONA_UNKNOWN}', 'sk': '2025-01-15',
            'count': Decimal(3),
        })
        mock_metrics.reset_mock()

        record_handler(_record('MODIFY', old=old, new={**old, 'date': '2024-01-01'}))

        legacy = real_aggregates_table.get_item(Key={
            'pk': f'{PERSONA_PREFIX}{LEGACY_PERSONA_UNKNOWN}', 'sk': '2025-01-15',
        })['Item']
        assert legacy['count'] == Decimal(2), (
            'the arrangement requires the compatibility write to have LANDED, or this '
            'test would pass for want of anything to count'
        )
        assert REBUCKETED_METRIC not in self._names(mock_metrics), (
            f'{self._names(mock_metrics)}: the edit moved none of the aggregates it '
            f'names, so it must not be reported as having rebucketed. The only write '
            f'that landed was the pre-deploy compatibility, which the edit did not '
            f'ask for.'
        )

    @patch('aggregator.handler.metrics')
    def test_an_edit_that_did_move_a_counter_still_counts_as_rebucketed(
        self, mock_metrics, real_aggregates_table, sample_feedback_item
    ):
        """Positive control: counting LANDED writes must not stop counting at all."""
        from aggregator.handler import REBUCKETED_METRIC, record_handler

        record_handler(_record('INSERT', new=sample_feedback_item))
        mock_metrics.reset_mock()

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))

        assert REBUCKETED_METRIC in self._names(mock_metrics)

    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_a_refused_write_is_counted(self, mock_table, mock_metrics):
        """A run of refusals means rows are expiring while their feedback is edited."""
        from aggregator.handler import REFUSED_METRIC, update_counter

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}},
            'UpdateItem',
        )

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        assert self._names(mock_metrics) == [REFUSED_METRIC]

    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_a_skipped_ttl_expiry_counts_as_nothing(
        self, mock_table, mock_metrics, sample_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item, user_identity=TTL_IDENTITY))

        assert self._names(mock_metrics) == []
