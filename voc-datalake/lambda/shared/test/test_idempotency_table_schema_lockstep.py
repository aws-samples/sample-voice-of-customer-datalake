"""The idempotency table's schema is declared twice, and one copy is unverifiable.

`shared/idempotency.py` names the two attributes BOTH of that table's writers spend:
`IDEMPOTENCY_KEY_ATTRIBUTE` (the partition key, which is also Powertools'
`key_attr` default) and `IDEMPOTENCY_EXPIRY_ATTRIBUTE` (the TTL attribute that makes
a dedupe marker self-deleting). `lib/stacks/core-stack.ts` declares the same two on
the `IdempotencyTable` construct. Nothing linked them.

🔑 WHY THIS ONE IS WORSE THAN A NORMAL DRIFT. The expiry attribute's whole job is to
be READ BY DYNAMODB, and DynamoDB does not complain about an item that lacks the
attribute its TTL names — it simply never deletes it. So a marker written under any
other name leaks, forever, with no error, no log and nothing served wrongly. The
module's own comment says exactly that ("spelled differently, every marker would
live forever and nothing would say so"), and the fix was HALF applied: the test that
checks a marker carries an expiry reads the attribute name THROUGH the constant, so
renaming the constant changes the production write and the expectation together and
that test stays green while the table's `timeToLiveAttribute` still says
`expiration`. A lockstep is the only shape that fails on it.

The key attribute is pinned for a smaller but real reason: two writers share this
table (Powertools' `idempotent_function` in `processor/handler.py`, and
`dedupe_claim_item` from the aggregator), and a claim written under one attribute
while the table keys on another is a `ValidationException` at runtime rather than a
leak — loud, but still worth catching in CI given it is free once this file exists.

WHICH MUTATION FAILS WHICH ASSERTION. Change `timeToLiveAttribute: 'expiration'` in
`core-stack.ts` (or `IDEMPOTENCY_EXPIRY_ATTRIBUTE` in `shared/idempotency.py`)
without changing the other and `test_the_ttl_attribute_is_the_one_the_writers_stamp`
fails naming both spellings. Do the same for the partition key and
`test_the_partition_key_is_the_one_the_writers_claim` fails. Delete the
`timeToLiveAttribute` line entirely and `test_the_table_has_a_ttl_at_all` fails —
which is the other way this leaks, and the one a value comparison alone would report
as a missing pattern rather than as the defect it is. Both were verified by making
the change and watching the failure, then reverting.

Read by PARSING the TypeScript, as `test_indexes.py` and
`test_lookback_window_lockstep.py` do: there is no parser for it on this side, and
the construct's properties are simple literals, so a scoped regular expression is
the available tool. Scoped to the construct's own block, not the file — this stack
declares a dozen tables and several of them have a `timeToLiveAttribute`, so an
unscoped pattern would happily read the FEEDBACK table's `'ttl'` and report the
idempotency table as correct (or as broken) on the strength of another table's line.
"""
import re
from pathlib import Path

from shared.idempotency import (
    IDEMPOTENCY_EXPIRY_ATTRIBUTE,
    IDEMPOTENCY_KEY_ATTRIBUTE,
)

# lambda/shared/test/ -> voc-datalake/
_CORE_STACK = Path(__file__).resolve().parents[3] / 'lib' / 'stacks' / 'core-stack.ts'

# The construct id CDK gives the table, which is also what its logical id is derived
# from — so renaming it is a CloudFormation REPLACEMENT and a deliberate act, not the
# kind of edit this file is guarding against.
_CONSTRUCT = "new dynamodb.Table(this, 'IdempotencyTable'"

# Quoting is not part of the contract: this file must not fail on a reformat.
_Q = r"""['"]"""


def _table_block() -> str:
    """The `IdempotencyTable` construct's properties, and nothing else's.

    The scope IS the assertion's soundness. `core-stack.ts` declares a dozen tables,
    several with their own `timeToLiveAttribute` — the feedback table's is `'ttl'` —
    so a pattern run over the whole file answers with whichever table happens to
    match first. That would make this lockstep report on a table it is not about, in
    both directions: green while the idempotency table's TTL was renamed, red when
    another table's was.

    The block ends at the closing `});` of the construct call, found as the first
    such line at the construct's own indentation. Read from the source text rather
    than from a synthesized template deliberately: a synth needs Docker and an
    esbuild bundle in this repo, which would make an attribute-name lockstep fail for
    reasons that have nothing to do with attribute names.
    """
    source = _CORE_STACK.read_text(encoding='utf-8')
    start = source.find(_CONSTRUCT)
    assert start != -1, (
        f'{_CONSTRUCT} not found in {_CORE_STACK.name}. If the idempotency table was '
        f'renamed or moved, follow it here — this file is the only thing that fails '
        f'when its TTL attribute stops matching the name the writers stamp, and a '
        f'wrong TTL attribute leaks every dedupe marker silently.'
    )
    rest = source[start:]
    end = re.search(r'^\s*\}\);\s*$', rest, re.MULTILINE)
    assert end, (
        f'The {_CONSTRUCT} call in {_CORE_STACK.name} has no closing brace this '
        f'helper can find, so it cannot tell where the construct ends and would '
        f'scope every assertion below to the rest of the file — where another '
        f"table's timeToLiveAttribute would satisfy them."
    )
    return rest[:end.end()]


def _declared(property_name: str, pattern: str) -> str:
    block = _table_block()
    matches = re.findall(pattern, block)
    assert len(matches) == 1, (
        f'Expected exactly one {property_name} on the idempotency table in '
        f'{_CORE_STACK.name}; found {len(matches)}. If the declaration was '
        f'restructured, update the pattern in this file rather than deleting the '
        f'assertion that depends on it.'
    )
    return matches[0]


class TestIdempotencyTableSchemaLockstep:
    def test_the_ttl_attribute_is_the_one_the_writers_stamp(self):
        """🔑 THE ASSERTION THIS FILE EXISTS FOR.

        A marker whose expiry attribute is not the table's `timeToLiveAttribute` is
        one DynamoDB will never delete. Nothing reports it: not an error, not a log,
        not a served value — the table simply grows without end. Every other test
        that touches this name reads it through the constant, so the constant and the
        stack are the two things that have to be compared.
        """
        declared = _declared(
            'timeToLiveAttribute', rf'timeToLiveAttribute:\s*{_Q}([^\'"]+){_Q}',
        )
        assert declared == IDEMPOTENCY_EXPIRY_ATTRIBUTE, (
            f'the idempotency table expires items on {declared!r} but both of its '
            f'writers stamp {IDEMPOTENCY_EXPIRY_ATTRIBUTE!r} '
            f'(IDEMPOTENCY_EXPIRY_ATTRIBUTE in shared/idempotency.py). Every dedupe '
            f'marker would then live forever, and nothing would report it. Change '
            f'both.'
        )

    def test_the_partition_key_is_the_one_the_writers_claim(self):
        """The louder half, pinned because it is free once the block is scoped.

        `dedupe_claim_item` puts an item keyed on IDEMPOTENCY_KEY_ATTRIBUTE and
        conditions on `attribute_not_exists` of the same name; Powertools' default
        `key_attr` is the same string. A table keyed on anything else answers a
        `ValidationException` — which at least fails loudly, but on the aggregator's
        hot path, for every ingested record.
        """
        declared = _declared(
            'partitionKey', rf'partitionKey:\s*\{{\s*name:\s*{_Q}([^\'"]+){_Q}',
        )
        assert declared == IDEMPOTENCY_KEY_ATTRIBUTE, (
            f'the idempotency table is keyed on {declared!r} but its writers claim '
            f'{IDEMPOTENCY_KEY_ATTRIBUTE!r} (IDEMPOTENCY_KEY_ATTRIBUTE in '
            f'shared/idempotency.py), so every claim would be a ValidationException. '
            f'Change both.'
        )

    def test_the_table_has_a_ttl_at_all(self):
        """The other way the markers leak, and it is not a value mismatch.

        Deleting the `timeToLiveAttribute` line leaves nothing for the assertion
        above to compare, and a lockstep that reported "pattern not found" would be
        describing its own reader rather than the defect. Stated as its own
        expectation so the failure says what is wrong: the table has no expiry, so
        every marker either writer has ever written is permanent.
        """
        assert 'timeToLiveAttribute' in _table_block(), (
            'the idempotency table no longer declares a timeToLiveAttribute, so no '
            'dedupe marker is ever deleted — neither the processor\'s hourly keys '
            'nor the aggregator\'s per-stream-record claims. The attribute both '
            'writers stamp is IDEMPOTENCY_EXPIRY_ATTRIBUTE.'
        )

    def test_the_two_attributes_are_not_the_same_name(self):
        """The premise of both assertions above, asserted rather than assumed.

        If the key and the expiry were ever spelled the same, each comparison would
        be satisfiable by the other's declaration and neither would be pinning
        anything — a lockstep passing for the wrong reason. Also a real error: a TTL
        on the partition key would make DynamoDB delete rows by their own id.
        """
        assert IDEMPOTENCY_KEY_ATTRIBUTE != IDEMPOTENCY_EXPIRY_ATTRIBUTE
