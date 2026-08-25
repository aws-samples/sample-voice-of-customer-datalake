"""`dedupe_claim_item`, tested where it is DECLARED rather than only where it is spent.

It was covered transitively from the aggregator's suite, which is the right place for
"does a redelivered stream record move a counter" but the wrong place for "what
exactly does this shared helper put on the wire". Two consequences of that gap:

* the aggregator's tests assert on the marker they can SEE — the one the transaction
  wrote — so the condition expression, which only matters when the item is already
  there, was pinned only by a redelivery happening to be refused. A condition
  naming the wrong attribute would still refuse (an absent attribute is absent), so
  that assertion could not distinguish it;
* nothing exercised the helper for a SECOND caller. It is in `shared/` because the
  next Lambda with at-least-once delivery should reuse it rather than write a second
  copy, and a shared helper whose only test is one caller's integration test is one
  the next caller has to re-derive the contract of.

The attribute names themselves are pinned against `core-stack.ts` in
`test_idempotency_table_schema_lockstep.py` — that is the drift no runtime error
reports. These are about the REQUEST: the shape, the condition, and the horizon.
"""
from shared.idempotency import (
    DEDUPE_CLAIM_TTL_SECONDS,
    IDEMPOTENCY_EXPIRY_ATTRIBUTE,
    IDEMPOTENCY_KEY_ATTRIBUTE,
    dedupe_claim_item,
)

NOW = 1_700_000_000
TABLE = 'some-idempotency-table'
KEY = 'caller#some-unit-of-work'


class TestDedupeClaimItem:
    """What the claim puts on the wire, asserted directly.

    REVERT MAP, each entry RUN:
      * Drop the `ConditionExpression` — fails
        test_the_claim_refuses_a_key_that_is_already_there, and NOTHING else here,
        which is the point: a claim without it is a `Put` that overwrites, so every
        redelivery would be applied and the helper would still look correct.
      * Condition on `attribute_not_exists` of some other attribute — fails
        test_the_condition_names_the_attribute_the_item_is_keyed_on. A condition on an
        attribute the item does not carry is refused by nothing, so it reads as a
        working claim right up to the first redelivery.
      * Return the `Put` without the `{'Put': ...}` wrapper, or add a second operation
        — fails test_the_item_is_one_transaction_entry.
      * Stamp `now` rather than `now + expires_after_seconds` — fails
        test_the_marker_expires_in_the_future.
      * Shorten `DEDUPE_CLAIM_TTL_SECONDS` to the stream's own 24 hours — fails
        test_the_default_horizon_outlives_a_streams_retention, which is the assertion
        that caught the first version of that constant.
    """

    def _put(self, **kwargs) -> dict:
        return dedupe_claim_item(TABLE, KEY, NOW, **kwargs)['Put']

    def test_the_item_is_one_transaction_entry(self):
        """One `Put`, and nothing else: `transact_write_items` takes exactly one
        operation per entry and rejects an entry carrying two."""
        entry = dedupe_claim_item(TABLE, KEY, NOW)

        assert list(entry) == ['Put'], entry
        assert entry['Put']['TableName'] == TABLE

    def test_the_claim_refuses_a_key_that_is_already_there(self):
        """🔑 THE WHOLE MECHANISM. Without the condition this is a `Put` that
        OVERWRITES, so a second delivery of the same key succeeds and the writes it
        guards are applied twice — while every other assertion in this file still
        passes, because the item it produces is identical.
        """
        assert 'ConditionExpression' in self._put(), (
            'the claim carries no condition, so it cannot refuse a key it has already '
            'seen: it would overwrite the marker and let the guarded writes re-apply'
        )

    def test_the_condition_names_the_attribute_the_item_is_keyed_on(self):
        """The condition and the key must be the SAME attribute, and this is the
        failure mode nothing at runtime reports.

        `attribute_not_exists(<anything the item does not carry>)` is true of every
        item, so a condition on the wrong attribute is never refused — the claim looks
        like it works until a redelivery arrives, and then it silently does not. Read
        out of the two rather than compared against a literal, so this cannot become
        the stale copy of the name.
        """
        put = self._put()

        assert IDEMPOTENCY_KEY_ATTRIBUTE in put['Item']
        assert put['ConditionExpression'] == (
            f'attribute_not_exists({IDEMPOTENCY_KEY_ATTRIBUTE})'
        ), (
            f"the claim conditions on something other than {IDEMPOTENCY_KEY_ATTRIBUTE!r}, "
            f'the attribute it keys the item on. attribute_not_exists of an attribute '
            f'the item does not carry is true of every item, so the claim would never '
            f'refuse anything and the redelivery it exists to catch would be applied.'
        )

    def test_the_key_is_the_one_the_caller_asked_for(self):
        """A helper that derived its own key would deduplicate the wrong unit of work.

        The aggregator's key is per stream RECORD (`eventID`), which is what makes it
        a redelivery test rather than a de-duplication of the feedback itself — a
        decision that belongs to the caller and cannot be made here.
        """
        assert self._put()['Item'][IDEMPOTENCY_KEY_ATTRIBUTE] == KEY

    def test_the_marker_expires_in_the_future(self):
        """The horizon is `now + expires_after_seconds`, stamped on the attribute the
        table collects. A marker whose expiry is in the PAST is deleted at DynamoDB's
        leisure and the key becomes claimable again — the leak's opposite, and equally
        silent: it looks like a working claim that occasionally lets one through.
        """
        expiry = self._put()['Item'][IDEMPOTENCY_EXPIRY_ATTRIBUTE]

        assert expiry == NOW + DEDUPE_CLAIM_TTL_SECONDS
        assert expiry > NOW

    def test_the_horizon_is_the_callers_to_shorten(self):
        """`expires_after_seconds` is honoured, so a caller whose redelivery window is
        not a DynamoDB stream's can say so. It defaults rather than being required
        because the aggregator's window is the common case, but a default nothing can
        override is a constant with extra steps.
        """
        assert self._put(expires_after_seconds=60)['Item'][
            IDEMPOTENCY_EXPIRY_ATTRIBUTE
        ] == NOW + 60

    def test_the_default_horizon_outlives_a_streams_retention(self):
        """A marker must outlive the window a redelivery can arrive IN.

        DynamoDB Streams retain a record for 24 hours, so that is the latest a
        redelivery of one can appear. Asserting `>` rather than `>=` is the point: an
        expiry equal to the horizon leaves the last possible redelivery racing the TTL
        that deletes its own marker, and TTL deletion is best-effort besides
        (documented as up to 48 hours of lag). This is what caught the first version of
        the constant, which was exactly 24 hours.
        """
        stream_retention_seconds = 24 * 60 * 60

        assert DEDUPE_CLAIM_TTL_SECONDS > stream_retention_seconds, (
            f'a claim lives {DEDUPE_CLAIM_TTL_SECONDS}s, which does not outlast the '
            f'{stream_retention_seconds}s a stream record survives — so the last '
            f'possible redelivery can find the marker gone and be applied twice'
        )

    def test_the_marker_carries_nothing_else(self):
        """Two attributes, and no stored result.

        This is the difference from Powertools' `idempotent_function`, which remembers
        a RESPONSE so a replay can return it. The result of a claimed unit of work here
        is a set of DynamoDB writes that either committed with the claim or did not
        exist, so there is nothing to remember and a marker carrying a payload would be
        storing state whose only use is to become stale.
        """
        assert set(self._put()['Item']) == {
            IDEMPOTENCY_KEY_ATTRIBUTE, IDEMPOTENCY_EXPIRY_ATTRIBUTE,
        }

    def test_two_callers_get_two_different_claims(self):
        """No shared mutable state between calls: it builds a request and issues
        nothing, so the same helper can serve two tables in one invocation. The reason
        it takes `now` rather than reading a clock is the same — one invocation stamps
        one instant across everything it writes, and a test can freeze one clock.
        """
        first = dedupe_claim_item('table-a', 'key-a', NOW)
        second = dedupe_claim_item('table-b', 'key-b', NOW + 5)

        assert first['Put']['TableName'] == 'table-a'
        assert second['Put']['TableName'] == 'table-b'
        assert first['Put']['Item'][IDEMPOTENCY_KEY_ATTRIBUTE] == 'key-a'
        assert second['Put']['Item'][IDEMPOTENCY_EXPIRY_ATTRIBUTE] == (
            NOW + 5 + DEDUPE_CLAIM_TTL_SECONDS
        )
