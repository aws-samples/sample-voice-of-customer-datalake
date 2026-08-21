"""Lockstep test: the field the persona counter buckets by is a field the
processor actually writes.

WHY THIS IS A TEST AND NOT A COMMENT
    `counter_dimensions` used to say, in prose, "`persona_name` is read here even
    though the processor writes `persona_type`; do not just change it". Prose
    cannot hold that, for a reason particular to this function: it is now the
    SINGLE description of the dimensions, spent in both directions. The insert path
    reads this field out of an item's NEW image and creates a counter row named
    after the value; the reversal path reads the same field out of the OLD image of
    the same item to find that row again. Change the name on its own and every
    decrement misses the row its own insert created — the counter goes up and never
    comes back down, which is the exact shape of the bug this module was repaired
    for, reintroduced in one dimension.

    So the hazard is not "the wrong field name". It is a field name changed HERE
    while the writer is left alone, or a writer field renamed while this is left
    alone. Both are drift between two copies of one fact, which is what a lockstep
    is for, and neither is visible in any other test: a wrong name buckets
    everything as `Unknown` and every existing assertion still passes, because the
    fixtures and the handler agree with each other about a field the production
    writer may not produce at all.

WHAT IS PINNED, AND WHAT IS DELIBERATELY NOT
    Pinned: the field `aggregator/handler.py::PERSONA_FIELD` names is one the
    processor's item literal really writes. NOT pinned: WHICH of the processor's two
    persona fields it should be. `persona_name` (the LLM's free-text name) and
    `persona_type` (a small enum) are both real fields, and bucketing by either is
    a defensible product decision — one gives many partitions, the other a handful.
    Asserting a specific choice here would be this file inventing a requirement.

    That leaves one thing worth naming out loud, because it is the reason the
    deferral in the PR was contentious: `persona_name` is `null` whenever the model
    returns no name, and the processor strips None values before writing, so those
    items carry NO `persona_name` and bucket as `Unknown`. That is a data-quality
    property of the enrichment output, not a lockstep violation — the counter is
    genuinely counting "items whose persona we could not name". If the product
    decision becomes "bucket by type instead", changing PERSONA_FIELD is the whole
    change, and this test keeps passing because `persona_type` is written too.

REVERT MAP
    * Point PERSONA_FIELD at a field the processor does not write (`persona`,
      `persona_label`) — fails
      test_the_persona_field_is_one_the_processor_writes.
    * Inline `item.get('persona_name')` back into `counter_dimensions` and drop the
      constant — fails test_the_persona_field_is_read_through_the_constant, which
      is what keeps the two directions reading ONE name rather than two literals
      that happen to match today.
    * Have the processor stop writing the field this reads — fails the first test,
      from the other side.
"""
import ast
import re
from pathlib import Path

from aggregator.handler import PERSONA_FIELD, counter_dimensions

PROCESSOR_SOURCE = 'lambda/processor/handler.py'
AGGREGATOR_SOURCE = 'lambda/aggregator/handler.py'
DIMENSIONS_FUNCTION = 'counter_dimensions'


def _read(relative: str) -> str:
    # lambda/aggregator/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? If so, update the path '
        f'constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _processor_persona_fields() -> set[str]:
    """The `persona_*` keys the processor's feedback item literal writes.

    Read as source text rather than by calling the builder, because building an
    item means an LLM response, a Bedrock client and a dozen environment
    variables; the question here is only which KEYS the literal names.
    """
    source = _read(PROCESSOR_SOURCE)
    fields = set(re.findall(r"^\s*'(persona_\w+)':", source, re.MULTILINE))
    assert fields, (
        f'No `persona_*` keys found in {PROCESSOR_SOURCE}. If the item literal was '
        f'restructured, follow it here — an empty set would make the assertion '
        f'below pass for the wrong reason.'
    )
    return fields


def _aggregator_persona_reads() -> list[str]:
    """Every `item.get(...)` argument inside `counter_dimensions`, unparsed.

    Parsed with `ast`, scoped to the one function, so a mention in a docstring or
    another function cannot answer for it — the convention the rest of this repo's
    locksteps follow, and for the usual reason: a pattern that reads a comment as
    code fails a correct module.
    """
    tree = ast.parse(_read(AGGREGATOR_SOURCE))
    functions = [node for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name == DIMENSIONS_FUNCTION]
    assert len(functions) == 1, (
        f'Expected exactly one {DIMENSIONS_FUNCTION} in {AGGREGATOR_SOURCE}; found '
        f'{len(functions)}. A second copy is the drift this file exists to prevent.'
    )
    reads: list[str] = []
    for statement in functions[0].body:
        for node in ast.walk(statement):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == 'get' and node.args):
                reads.append(ast.unparse(node.args[0]))
    return reads


class TestThePersonaCounterReadsAFieldThatExists:
    def test_the_persona_field_is_one_the_processor_writes(self):
        written = _processor_persona_fields()
        assert PERSONA_FIELD in written, (
            f'{AGGREGATOR_SOURCE} buckets the persona counter by '
            f'`{PERSONA_FIELD}`, which {PROCESSOR_SOURCE} does not write — it '
            f'writes {sorted(written)}. Every item would bucket as `Unknown`, and '
            f'no other test would notice, because the aggregator fixtures agree '
            f'with the aggregator rather than with the writer.'
        )

    def test_the_persona_field_is_read_through_the_constant(self):
        """One name, not two literals that happen to agree.

        The increment and the decrement path both come through this function, so a
        literal here is only one copy — but a literal is also what makes it
        possible to "fix" the field in a way that changes what the reversal looks
        for without changing what the insert created. The constant is the seam this
        lockstep and the handler share; reading the field any other way puts the
        pin and the code back out of contact.
        """
        reads = _aggregator_persona_reads()
        assert 'PERSONA_FIELD' in reads, (
            f'{AGGREGATOR_SOURCE}::{DIMENSIONS_FUNCTION} reads {reads} — none of '
            f'them the PERSONA_FIELD constant this test pins. Read the field '
            f'through the constant so that changing it changes both directions at '
            f'once and this lockstep still has something to hold.'
        )
        assert PERSONA_FIELD not in reads, (
            f'{AGGREGATOR_SOURCE}::{DIMENSIONS_FUNCTION} also reads the literal '
            f'"{PERSONA_FIELD}" alongside the constant. Two spellings of one field '
            f'is the drift, whichever of them is currently right.'
        )


class TestTheDefaultBucketIsStable:
    """An item with no persona must land in a NAMED bucket, the same one in both
    directions — and never in one built out of `None`.

    `METRIC#persona#None` is the failure a `.get(field, 'Unknown')` default does not
    prevent: the processor strips None values, but a stream image edited by hand, or
    any writer that stores an explicit null, delivers the key present and empty. The
    default then does not apply, `Unknown` is not used, and the counter goes to a
    partition nothing else writes to or reads from — invisible, and unreachable by
    the reversal if the field is ever repopulated.
    """

    def test_a_missing_persona_buckets_under_unknown(self):
        assert ('METRIC#persona#Unknown', 'count') in counter_dimensions({})

    def test_an_explicitly_null_persona_buckets_under_unknown_too(self):
        assert ('METRIC#persona#Unknown', 'count') in counter_dimensions(
            {PERSONA_FIELD: None}
        )

    def test_an_empty_persona_name_buckets_under_unknown_too(self):
        assert ('METRIC#persona#Unknown', 'count') in counter_dimensions(
            {PERSONA_FIELD: ''}
        )

    def test_the_persona_dimension_is_never_absent(self):
        """Urgency is the only conditional dimension.

        Pinned because `counter_dimensions` is the single description both
        directions read: a dimension that is sometimes present and sometimes not,
        for a reason other than the item's own value, is how one direction writes a
        row the other never comes back for.
        """
        for item in ({}, {PERSONA_FIELD: None}, {PERSONA_FIELD: 'Happy Customer'}):
            personas = [pk for pk, _ in counter_dimensions(item)
                        if pk.startswith('METRIC#persona#')]
            assert len(personas) == 1, (
                f'{item} produced {personas}; exactly one persona counter must be '
                f'written for every item, in both directions.'
            )
