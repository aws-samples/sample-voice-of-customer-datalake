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

Expected values are LITERALS — `'id'`, `'expiration'`, `172_800` — not reads of the
module's own constants. A test that compares the production write against the
production constant moves with every edit and so pins nothing; the lockstep in
`test_idempotency_table_schema_lockstep.py` is what ties the same two names to
`core-stack.ts`, so a rename that is deliberate has two files to update and a rename
that is accidental has two files that fail.
"""
from shared.idempotency import DEDUPE_CLAIM_TTL_SECONDS, dedupe_claim_item

NOW = 1_700_000_000
TABLE = 'some-idempotency-table'
KEY = 'caller#some-unit-of-work'


class TestDedupeClaimItem:
    """What the claim puts on the wire, asserted as one literal request.

    REVERT MAP, each entry RUN against the whole-request assertion:
      * Drop the `ConditionExpression` — the claim is a `Put` that OVERWRITES, so a
        second delivery of the same key succeeds and the writes it guards are applied
        twice, while the item it produces is otherwise identical. 🔑 THE WHOLE
        MECHANISM, and the one thing the aggregator's own tests cannot see.
      * Condition on `attribute_not_exists` of some other attribute — refused by
        nothing, because an attribute the item does not carry is absent from every
        item. Reads as a working claim right up to the first redelivery.
      * Return the `Put` without the `{'Put': ...}` wrapper, or add a second
        operation — `transact_write_items` takes exactly one operation per entry.
      * Stamp `now` (or `now - ttl`) rather than `now + ttl` — a marker already in the
        past is deleted at DynamoDB's leisure and the key becomes claimable again.
      * Carry a third attribute — a stored RESULT is Powertools' shape; the result of
        a claimed unit of work here is the writes that committed with it.
      * Change `DEDUPE_CLAIM_TTL_SECONDS` by any amount — the expiry literal moves.
    """

    def test_the_claim_is_one_conditional_put_of_a_two_attribute_marker(self):
        assert dedupe_claim_item(TABLE, KEY, NOW) == {
            'Put': {
                'TableName': TABLE,
                'Item': {'id': KEY, 'expiration': 1_700_172_800},
                'ConditionExpression': 'attribute_not_exists(id)',
            },
        }

    def test_the_horizon_is_the_callers_to_shorten(self):
        """`expires_after_seconds` is honoured, so a caller whose redelivery window is
        not a DynamoDB stream's can say so. It defaults rather than being required
        because the aggregator's window is the common case, but a default nothing can
        override is a constant with extra steps.
        """
        put = dedupe_claim_item(TABLE, KEY, NOW, expires_after_seconds=60).get('Put')
        assert put is not None

        item = put['Item']
        assert item['expiration'] == 1_700_000_060

    def test_the_default_horizon_is_two_days_and_outlives_a_streams_retention(self):
        """A marker must outlive the window a redelivery can arrive IN.

        DynamoDB Streams retain a record for 24 hours, so that is the latest a
        redelivery of one can appear. The `>` is the invariant: an expiry equal to the
        horizon leaves the last possible redelivery racing the TTL that deletes its
        own marker, and TTL deletion is best-effort besides (documented as up to 48
        hours of lag). This is what caught the first version of the constant, which
        was exactly 24 hours. The `==` is the chosen value: double the window, the
        smallest horizon with headroom on both sides.
        """
        stream_retention_seconds = 86_400

        assert stream_retention_seconds < DEDUPE_CLAIM_TTL_SECONDS, (
            f'a claim lives {DEDUPE_CLAIM_TTL_SECONDS}s, which does not outlast the '
            f'{stream_retention_seconds}s a stream record survives — so the last '
            f'possible redelivery can find the marker gone and be applied twice'
        )
        assert DEDUPE_CLAIM_TTL_SECONDS == 172_800
