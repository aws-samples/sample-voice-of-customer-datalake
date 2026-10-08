"""Lockstep: every doc_type the document route ACCEPTS has a generator (#397).

`projects_handler.GENERATED_DOC_TYPES` is what POST /projects/{id}/document
validates against; `CHAIN_DOC_TYPES` in lambda/jobs/document_generator/handler.py
is the generator's whole dispatch. Before the map existed the generator branched
`doc_type == 'prd'` with PR-FAQ as the unconditional `else`, so a type added to
the tuple alone was accepted, billed and saved as a PR-FAQ under its own label.
Now an unmapped type fails the job before any model call — and this test fails
first, at CI, when the two sets drift in either direction.

Same pattern as test_doc_type_lockstep.py (route ↔ frontend `DocType`), which
covers the other half of a widening; the generator's map docstring lists the
frontend literal sites neither test can see.
"""
from jobs.document_generator.handler import CHAIN_DOC_TYPES
from projects_handler import GENERATED_DOC_TYPES


def test_the_generator_maps_exactly_the_doc_types_the_route_accepts():
    assert set(CHAIN_DOC_TYPES) == set(GENERATED_DOC_TYPES)


def test_the_route_tuple_has_no_duplicates_the_set_comparison_would_hide():
    assert len(set(GENERATED_DOC_TYPES)) == len(GENERATED_DOC_TYPES)
