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
    processor's item literal really writes, and the empty-bucket name is a value
    the enrichment contract's own enum declares. NOT pinned: WHICH of the
    processor's two persona fields it should be. That is a product decision, and
    asserting it here would be this file inventing a requirement; what it must not
    be is a field production does not produce.

    The decision itself, for the record, because it is the reason the field moved:
    the axis buckets by `persona_type` (the archetype) and not by `persona_name`
    (the LLM's free-text name). `persona_name` is `null` whenever the model returns
    no name, the processor strips None values before writing, and this platform's
    corpus is scraped reviews and mostly anonymous form submissions — so an
    anonymous item HAS no name to give and carries no `persona_name` at all. An
    audit found 99.97% of a 6,239-item corpus in one `Unknown` bucket as a result.
    That was not a data-quality defect in the enrichment output (a null name for
    anonymous feedback is correct) and not a field nothing writes; it was the wrong
    field for the question. `persona_type` is populated and is a closed enum, which
    is what a dimension you group by has to be.

REVERT MAP
    * Point PERSONA_FIELD at a field the processor does not write (`persona`,
      `persona_label`) — fails
      test_the_persona_field_is_one_the_processor_writes.
    * Inline `item.get('persona_type')` back into `counter_dimensions` and drop the
      constant — fails test_the_persona_field_is_read_through_the_constant, which
      is what keeps the two directions reading ONE name rather than two literals
      that happen to match today.
    * Have the processor stop writing the field this reads — fails the first test,
      from the other side.
    * Spell the empty bucket as a bespoke `Unknown` again (or anything else outside
      the contract's enum) — fails
      test_the_empty_bucket_is_a_value_the_enrichment_enum_declares.
    * Point PERSONA_FIELD back at `persona_name` — fails
      test_an_item_with_an_archetype_and_no_name_buckets_under_its_archetype, which
      is the 99.97% case, and (from the API side)
      test_the_scan_path_and_the_aggregates_path_bucket_one_item_identically in
      lambda/api/test/test_persona_dimension_lockstep.py.
    * Spell the partition prefix here instead of importing PERSONA_PREFIX — fails
      test_neither_side_spells_the_persona_partition_in_its_own_code, in that same
      file, which reads the parsed CODE of the four functions that spend it.
    * Delete the reversal's pre-deploy fallback
      (`_reverse_a_pre_deploy_persona_row`) — fails
      TestAPreDeployImageIsReversedOnTheRowItsInsertCreated in test_handler.py, which
      is where the cross-deploy case is pinned.
    * Add a value to `shared/feedback.py::PERSONA_ARCHETYPES` that the enrichment
      prompt does not admit, or drop one it does — fails
      test_the_shared_archetypes_are_the_ones_the_enrichment_enum_declares. That set
      is a COPY of the contract, kept for a write-side guard, so it is pinned to the
      prompt the way the empty bucket already is.

    Every name cited above was grepped against the repo and resolves — as of this
    edit, by running the grep rather than by intending to. That check is worth
    repeating on every edit, and NOT worth asserting in prose without doing: review
    found this map naming a test (`..._agree_on_one_item`) that existed nowhere, then
    found a class name (`...OnTheArchetype`) stale three lines above a sentence
    claiming the check had been done. In a repo where the REVERT MAP is the index from
    mutation to failing test, a citation that resolves to nothing is the one kind of
    staleness these files cannot absorb — the next reader greps for it, finds nothing,
    and has to reconstruct whether the coverage exists at all. A false assurance is
    worse, because it stops them checking.
"""
import ast
import re
from pathlib import Path

from aggregator.handler import (
    PERSONA_FIELD,
    PERSONA_PREFIX,
    PERSONA_UNKNOWN,
    counter_dimensions,
)

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


def _processor_persona_type_enum() -> set[str]:
    """The values the enrichment prompt's `persona.type` contract admits.

    Read out of the prompt template, because that string IS the contract: it is
    what the model is told to return, so it is the only place that says which
    archetype names can ever reach the counter. `null` is dropped — it is the
    JSON contract's way of saying "no value", which is the case the bucket name
    below stands in for, not a value the bucket could be named after.
    """
    source = _read(PROCESSOR_SOURCE)
    # re.DOTALL so `.` crosses newlines. Without it the pattern depended on
    # `USER_PROMPT_TEMPLATE` staying one ~1000-character line, and wrapping it for
    # readability — a plausible edit that changes no contract — would have found zero
    # matches. The `len == 1` assertion below makes that loud rather than silent
    # either way, but a pin should not be spendable on formatting at all.
    declarations = re.findall(r'"persona":.*?"type":"([^"]+)"', source, re.DOTALL)
    assert len(declarations) == 1, (
        f'Expected exactly one `persona.type` declaration in the enrichment prompt '
        f'in {PROCESSOR_SOURCE}; found {len(declarations)}. Two contracts for one '
        f'field is drift of its own; if the prompt was restructured, follow it here '
        f'rather than loosening the pattern — an empty match would make the '
        f'assertion below pass for the wrong reason.\n'
        f'The remaining dependency, now that newlines are crossed: `"persona":` must '
        f'precede its own `"type":"..."` with no other `"type":"` in between, since '
        f'`.*?` stops at the FIRST one. A prompt that declares another object\'s '
        f'`type` between the two would match that instead and report the wrong enum.'
    )
    return {value for value in declarations[0].split('|') if value != 'null'}


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


class TestTheAxisMeasuresTheArchetype:
    """The 99.97% case: an anonymous item still lands in a bucket that means
    something.

    Written as an item carrying an archetype and NO name, because that is the shape
    of nearly every item this platform ingests — scraped reviews and anonymous form
    submissions, for which the enrichment contract returns a null `persona.name` and
    the processor writes no `persona_name` key at all. Under the old field every one
    of them bucketed as `Unknown`, and no assertion anywhere noticed, because the
    fixtures agreed with the aggregator about a field production rarely produces.
    """

    def test_an_item_with_an_archetype_and_no_name_buckets_under_its_archetype(self):
        anonymous = {'persona_type': 'churn_risk'}
        assert 'persona_name' not in anonymous, (
            'the arrangement is the point: this item must carry no name at all, the '
            'way a stripped item from an anonymous review arrives'
        )

        assert (f'{PERSONA_PREFIX}churn_risk', 'count') in counter_dimensions(anonymous)

    def test_a_name_alone_does_not_decide_the_bucket(self):
        """The negative half of the same fact.

        An item carrying ONLY a name has no archetype, so it belongs in the empty
        bucket — and must not resurrect the old axis by being counted under the
        name. Without this, pointing PERSONA_FIELD back at `persona_name` would
        leave the test above failing but nothing asserting that the name is no
        longer what a bucket can be called.
        """
        named_only = {'persona_name': 'Veronica Chen'}
        personas = [pk for pk, _ in counter_dimensions(named_only)
                    if pk.startswith(PERSONA_PREFIX)]

        assert personas == [f'{PERSONA_PREFIX}{PERSONA_UNKNOWN}'], (
            f'{named_only} produced {personas}. A free-text name is an identifier, '
            f'not an archetype, and must not name a metrics bucket.'
        )


class TestTheDefaultBucketIsStable:
    """An item with no persona must land in a NAMED bucket, the same one in both
    directions — and never in one built out of `None`.

    `METRIC#persona#None` is the failure a `.get(field, DEFAULT)` default does not
    prevent: the processor strips None values, but a stream image edited by hand, or
    any writer that stores an explicit null, delivers the key present and empty. The
    default then does not apply, the empty bucket name is not used, and the counter
    goes to a partition nothing else writes to or reads from — invisible, and
    unreachable by the reversal if the field is ever repopulated.
    """

    def test_a_missing_persona_buckets_under_the_empty_value(self):
        assert (f'{PERSONA_PREFIX}{PERSONA_UNKNOWN}', 'count') in counter_dimensions({})

    def test_an_explicitly_null_persona_buckets_under_it_too(self):
        assert (f'{PERSONA_PREFIX}{PERSONA_UNKNOWN}', 'count') in counter_dimensions(
            {PERSONA_FIELD: None}
        )

    def test_an_empty_persona_value_buckets_under_it_too(self):
        assert (f'{PERSONA_PREFIX}{PERSONA_UNKNOWN}', 'count') in counter_dimensions(
            {PERSONA_FIELD: ''}
        )

    def test_a_populated_item_does_not_bucket_under_the_empty_value(self):
        """The POSITIVE CONTROL for the three above.

        Without it, all three pass just as well if everything collapses into one
        bucket — which is precisely the defect this change repairs, so an
        empty-bucket assertion with no populated counterexample would be asserting
        the bug.
        """
        personas = [pk for pk, _ in counter_dimensions({PERSONA_FIELD: 'prospect'})
                    if pk.startswith(PERSONA_PREFIX)]

        assert personas == [f'{PERSONA_PREFIX}prospect'], personas

    def test_the_empty_bucket_is_a_value_the_enrichment_enum_declares(self):
        """Not a bespoke label: a value the contract already defines.

        The bucket was `Unknown`, which appears in no contract — so a caller reading
        the axis got one value that was not from the enum and could not tell whether
        it meant "the model said unknown" or "we had nothing". Spelling it the
        enum's way makes every bucket name, once the pre-deploy rows have aged out,
        a value the contract declares.
        """
        admitted = _processor_persona_type_enum()

        assert PERSONA_UNKNOWN in admitted, (
            f'the empty persona bucket is `{PERSONA_UNKNOWN}`, which the enrichment '
            f'contract in {PROCESSOR_SOURCE} does not admit — it admits '
            f'{sorted(admitted)}. Name it with a value the contract defines, so the '
            f'axis has no values invented outside it.'
        )

    def test_the_shared_archetypes_are_the_ones_the_enrichment_enum_declares(self):
        """`PERSONA_ARCHETYPES` is a COPY of the contract, so it is pinned to it.

        The prompt is the contract — it is what the model is told to return — and this
        set exists only because a WRITE-side guard needs to recognise the value space
        in code: `_reverse_a_pre_deploy_persona_row` refuses to aim its `-1` at a row
        this deploy actively writes, which it can only know by membership. A copy that
        drifted would break that guard in the more dangerous direction, admitting a
        legacy decrement onto a live archetype row.

        Compared as a whole set, not by membership of one value, so a value ADDED
        here that the contract never declares fails just as loudly as one dropped.
        """
        from shared.feedback import PERSONA_ARCHETYPES

        admitted = _processor_persona_type_enum()

        assert set(PERSONA_ARCHETYPES) == admitted, (
            f'PERSONA_ARCHETYPES is {sorted(PERSONA_ARCHETYPES)} while the enrichment '
            f'contract in {PROCESSOR_SOURCE} admits {sorted(admitted)}. The set is a '
            f'copy of the contract kept for the reversal\'s collision guard; if the '
            f'prompt\'s enum moved, follow it here, and if a value was added here that '
            f'the model is never told to return, remove it — the guard would refuse a '
            f'legitimate legacy decrement, or admit one onto a live row.'
        )

    def test_the_persona_dimension_is_never_absent(self):
        """Urgency is the only conditional dimension.

        Pinned because `counter_dimensions` is the single description both
        directions read: a dimension that is sometimes present and sometimes not,
        for a reason other than the item's own value, is how one direction writes a
        row the other never comes back for.
        """
        for item in ({}, {PERSONA_FIELD: None}, {PERSONA_FIELD: 'advocate'}):
            personas = [pk for pk, _ in counter_dimensions(item)
                        if pk.startswith(PERSONA_PREFIX)]
            assert len(personas) == 1, (
                f'{item} produced {personas}; exactly one persona counter must be '
                f'written for every item, in both directions.'
            )
