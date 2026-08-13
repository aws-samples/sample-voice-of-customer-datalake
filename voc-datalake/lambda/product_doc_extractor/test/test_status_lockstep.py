"""The extractor's status partition must cover exactly the API's vocabulary.

`handler.py` splits product-doc statuses into two independent tuples —
`NON_TERMINAL_STATUSES` (records it may write over) and `TERMINAL_STATUSES` (the
API already gave this document up as stalled) — and `_log_refused_write` treats
"in neither tuple" as its third case: a record that is malformed or predates the
status field.

That third case is only true while the two tuples together cover every status a
record can hold. Add a legitimate new status in the API — `queued`, say — and a
perfectly well-formed record starts being logged as "malformed or predates the
status field, so no read path put it in this state", which is the same wrong-cause
diagnosis the three-way split was written to fix, one status later. And that line
is the one an operator reads during a diagnosis, so a false positive there
misleads exactly the person it is there to help.

`test_handler.py` already pins the NON_TERMINAL half against the API's
`STALLABLE_STATUSES`. What nothing pinned is COMPLETENESS: the terminal half, and
the claim that the two halves exhaust the vocabulary. So the API now names that
vocabulary once, in `PRODUCT_DOC_STATUSES`, and this pins the partition against
it — better than a set inferred from literals scattered across both modules,
which would agree with whatever the code happened to say.

The extractor cannot import product_context at runtime (that module reaches
powertools through `shared/`), but a TEST can — the pattern
`test_content_type_lockstep.py` and `test_default_model_lockstep.py` already use.
"""
import re
from pathlib import Path

import pytest
from api.product_context import PRODUCT_DOC_STATUSES, STALLABLE_STATUSES

from product_doc_extractor.handler import NON_TERMINAL_STATUSES, TERMINAL_STATUSES

TYPES_SOURCE = 'frontend/src/api/types.ts'


def _frontend_statuses() -> set[str]:
    """Members of the `ProductDocStatus` union, read out of the TypeScript source.

    Source text rather than execution — a Python test cannot import a `.ts` file,
    and this is the approach the sibling lockstep tests already use.
    """
    # lambda/product_doc_extractor/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / TYPES_SOURCE
    if not path.is_file():
        # A backend-only tree (packaging, a partial checkout) has nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test. Same precedent as test_image_limits_lockstep.py.
        pytest.skip(f'{TYPES_SOURCE} not present in this tree')
    match = re.search(
        r'export type ProductDocStatus\s*=\s*([^\n]+)',
        path.read_text(encoding='utf-8'),
    )
    assert match, f'ProductDocStatus not found in {TYPES_SOURCE}'
    return set(re.findall(r"'([^']+)'", match.group(1)))


class TestStatusPartitionLockstep:
    def test_the_two_tuples_together_cover_exactly_the_api_vocabulary(self):
        partition = set(NON_TERMINAL_STATUSES) | set(TERMINAL_STATUSES)
        vocabulary = set(PRODUCT_DOC_STATUSES)

        assert partition == vocabulary, (
            'The API can hold '
            f'{sorted(vocabulary - partition)} that the extractor classifies as '
            'neither non-terminal nor terminal — a well-formed record logged as '
            '"malformed or predates the status field" — and/or the extractor '
            f'classifies {sorted(partition - vocabulary)} that no record can hold. '
            'PRODUCT_DOC_STATUSES in lambda/api/product_context.py is the '
            'canonical set; add to it and to one of these two tuples in the same '
            'commit.'
        )

    def test_the_two_tuples_do_not_overlap(self):
        """A status in both halves would make `_log_refused_write` report a record
        the extractor may still legitimately write over as one the API gave up as
        stalled — and `_update_doc` would then also allow writing over a terminal
        record, which is the clobber the condition exists to prevent."""
        assert not (set(NON_TERMINAL_STATUSES) & set(TERMINAL_STATUSES))

    def test_neither_tuple_is_empty(self):
        """Vacuity guard. Emptying TERMINAL_STATUSES sends every refused write down
        the malformed branch, and emptying NON_TERMINAL_STATUSES makes the update
        condition unsatisfiable, so every extraction result is silently discarded.
        Both are exactly the bugs above, and neither would disturb the equality
        test if the canonical tuple were emptied along with them."""
        assert NON_TERMINAL_STATUSES
        assert TERMINAL_STATUSES
        assert PRODUCT_DOC_STATUSES

    def test_every_stallable_status_is_one_the_extractor_may_still_write(self):
        """The direction that matters between the two modules: if the API can fail
        a record from status X as stalled, the extractor must consider X
        non-terminal. Otherwise a record still waiting for extraction would have
        its result discarded AND be logged as "the API already gave this document
        up as stalled" — before the API had done anything of the kind."""
        assert set(STALLABLE_STATUSES) <= set(NON_TERMINAL_STATUSES)


class TestFrontendStatusMirrorLockstep:
    """The third copy of the vocabulary, in TypeScript.

    `PRODUCT_DOC_STATUSES`'s own comment says it is "Mirrored in
    frontend/src/api/types.ts as ProductDocStatus", and by this repo's habit a
    comment making a claim about another file is a claim to test — otherwise the
    next edit makes the comment wrong silently. The Python↔Python partition above
    is pinned; this mirror was not, which is the same drift risk one language over.

    Concretely: a status added to the API and to the extractor but not to the union
    type gives a `status` value the frontend's own type says is impossible.
    `DocStatusBadge` in ProductDocsUpload.tsx switches on `ready` and `failed` and
    falls through to the "Extracting…" spinner for everything else, so an
    unmodelled status renders as a permanent in-flight spinner — the exact
    never-resolving badge this whole rung was written to remove.

    Read as SOURCE TEXT rather than executed, the same approach as
    test_image_limits_lockstep.py and test_avatar_image_model_lockstep.py.
    """

    def test_the_frontend_union_matches_the_canonical_vocabulary(self):
        frontend = _frontend_statuses()
        canonical = set(PRODUCT_DOC_STATUSES)

        assert frontend == canonical, (
            f'ProductDocStatus in {TYPES_SOURCE} is {sorted(frontend)} but the '
            f'canonical PRODUCT_DOC_STATUSES is {sorted(canonical)}. A status the '
            'backend can write and the union does not name renders as a permanent '
            '"Extracting…" spinner, because DocStatusBadge falls through to it for '
            'anything that is not ready or failed.'
        )

    def test_the_union_was_actually_parsed(self):
        """Vacuity guard: a regex that stopped matching would otherwise compare an
        empty set against an empty set, passing while pinning nothing."""
        assert len(_frontend_statuses()) >= 4
