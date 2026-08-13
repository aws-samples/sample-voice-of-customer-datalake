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
from api.product_context import PRODUCT_DOC_STATUSES, STALLABLE_STATUSES

from product_doc_extractor.handler import NON_TERMINAL_STATUSES, TERMINAL_STATUSES


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
