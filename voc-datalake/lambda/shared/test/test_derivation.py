"""Tests for shared.derivation — the one shape every document-creating path
writes to answer "what was this built from".

Expectations are literals: nothing here re-derives its expected value from the
code under test.
"""
import pytest

from shared.derivation import (
    DERIVATION_FIELD,
    DERIVATION_ROLES,
    ROLE_MERGE_INPUT,
    ROLE_PROTOTYPE_PRD,
    ROLE_PROTOTYPE_PRFAQ,
    ROLE_REFERENCE,
    build_derivation,
    derivation_source,
)


class TestVocabulary:
    def test_role_vocabulary_is_exactly_the_four_relations_the_code_creates(self):
        assert DERIVATION_ROLES == (
            'reference',
            'prototype_prd',
            'prototype_prfaq',
            'merge_input',
        )

    def test_field_name_is_derivation(self):
        assert DERIVATION_FIELD == 'derivation'


class TestDerivationSource:
    def test_names_the_document_and_the_role_it_played(self):
        assert derivation_source('prd_1', ROLE_PROTOTYPE_PRD) == {
            'document_id': 'prd_1',
            'role': 'prototype_prd',
        }

    def test_absent_source_is_no_entry_rather_than_an_empty_id(self):
        """`(prd or {}).get('document_id')` yields None when a prototype was
        built from a PR/FAQ alone; that must not become a source."""
        assert derivation_source(None, ROLE_PROTOTYPE_PRD) is None
        assert derivation_source('', ROLE_PROTOTYPE_PRFAQ) is None

    def test_non_string_id_is_no_entry(self):
        assert derivation_source(42, ROLE_REFERENCE) is None

    def test_role_outside_the_closed_vocabulary_is_rejected(self):
        with pytest.raises(ValueError, match='Unknown derivation role'):
            derivation_source('doc_1', 'inspired_by')


class TestBuildDerivation:
    def test_records_used_sources_and_the_larger_selected_count_separately(self):
        """The generator caps reference documents; the record must show both the
        documents that reached the model and how many were asked for."""
        derivation = build_derivation(
            sources=[
                derivation_source('doc_1', ROLE_REFERENCE),
                derivation_source('doc_2', ROLE_REFERENCE),
                derivation_source('doc_3', ROLE_REFERENCE),
            ],
            selected_document_count=5,
        )
        assert derivation['sources'] == [
            {'document_id': 'doc_1', 'role': 'reference'},
            {'document_id': 'doc_2', 'role': 'reference'},
            {'document_id': 'doc_3', 'role': 'reference'},
        ]
        assert derivation['selected_document_count'] == 5

    def test_drops_none_entries_so_callers_need_no_prefiltering(self):
        derivation = build_derivation(
            sources=[
                derivation_source(None, ROLE_PROTOTYPE_PRD),
                derivation_source('prfaq_9', ROLE_PROTOTYPE_PRFAQ),
            ],
        )
        assert derivation['sources'] == [{'document_id': 'prfaq_9', 'role': 'prototype_prfaq'}]

    def test_records_non_document_inputs(self):
        derivation = build_derivation(
            feedback_count=12,
            persona_ids=['persona_1', 'persona_2'],
            visual_document_ids=['a1b2c3d4e5f60718'],
            product_context_included=True,
        )
        assert derivation['feedback_count'] == 12
        assert derivation['persona_ids'] == ['persona_1', 'persona_2']
        assert derivation['visual_document_ids'] == ['a1b2c3d4e5f60718']
        assert derivation['product_context_included'] is True

    def test_empty_derivation_answers_no_inputs_without_missing_keys(self):
        assert build_derivation() == {
            'sources': [],
            'selected_document_count': 0,
            'feedback_count': 0,
            'persona_ids': [],
            'visual_document_ids': [],
            'product_context_included': False,
        }

    def test_counts_degrade_to_zero_rather_than_failing_the_generation(self):
        derivation = build_derivation(feedback_count='not a number', selected_document_count=-4)
        assert derivation['feedback_count'] == 0
        assert derivation['selected_document_count'] == 0

    def test_persona_ids_keep_only_usable_identifiers(self):
        derivation = build_derivation(persona_ids=['persona_1', '', None, 7])
        assert derivation['persona_ids'] == ['persona_1']

    def test_records_identifiers_and_counts_only_never_content(self):
        """Guards the privacy line: a derivation is metadata, so no field may
        carry document text, feedback text, or instructions."""
        derivation = build_derivation(
            sources=[derivation_source('doc_1', ROLE_MERGE_INPUT)],
            feedback_count=3,
            persona_ids=['persona_1'],
            visual_document_ids=['a1b2c3d4e5f60718'],
            product_context_included=True,
        )
        assert set(derivation) == {
            'sources',
            'selected_document_count',
            'feedback_count',
            'persona_ids',
            'visual_document_ids',
            'product_context_included',
        }
        assert set(derivation['sources'][0]) == {'document_id', 'role'}


class TestVisualDocumentIds:
    """Uploaded IMAGE product documents ("visuals") whose extracted descriptions
    were injected as a visual brief.

    A plain id list, following `persona_ids` rather than `sources`: a visual is
    not a ProjectDocument, so a `sources` entry would promise a title lookup that
    can only ever come back unresolved. These tests pin the id-list contract, not
    a role.
    """

    def test_records_the_visuals_that_grounded_the_generation(self):
        """The honesty requirement: a prototype must be able to say which
        uploaded visual it was built from."""
        derivation = build_derivation(visual_document_ids=['a1b2c3d4e5f60718'])

        assert derivation['visual_document_ids'] == ['a1b2c3d4e5f60718']

    def test_keeps_only_usable_identifiers(self):
        """Same tolerance as persona_ids — junk is dropped, not raised, because
        provenance bookkeeping must not fail the job that produced the document."""
        derivation = build_derivation(
            visual_document_ids=['a1b2c3d4e5f60718', '', None, 7, {'document_id': 'x'}],
        )

        assert derivation['visual_document_ids'] == ['a1b2c3d4e5f60718']

    def test_preserves_selection_order(self):
        """The revision flow re-reads this list to inherit the base prototype's
        visual selection, so the order the user chose has to survive."""
        derivation = build_derivation(visual_document_ids=['vis_c', 'vis_a', 'vis_b'])

        assert derivation['visual_document_ids'] == ['vis_c', 'vis_a', 'vis_b']

    def test_no_visuals_reads_as_an_empty_list_not_a_missing_key(self):
        """Every existing writer omits the argument. Absent must mean "no
        visuals", answerable without a KeyError at the read side."""
        assert build_derivation()['visual_document_ids'] == []
        assert build_derivation(persona_ids=['persona_1'])['visual_document_ids'] == []

    def test_is_never_turned_into_a_source_entry(self):
        """The design decision, pinned: recording a visual must not add a
        `sources` entry, because the frontend resolver looks every source id up
        in the project's ProjectDocument list and a visual is stored elsewhere —
        it would render as a bare hex id under "Built from"."""
        derivation = build_derivation(visual_document_ids=['a1b2c3d4e5f60718'])

        assert derivation['sources'] == []
        assert derivation['selected_document_count'] == 0

    def test_needs_no_new_role_in_the_closed_vocabulary(self):
        """The other half of that decision: no ROLE_* was added, so the
        Python↔TypeScript role lockstep is unaffected by this field."""
        assert DERIVATION_ROLES == (
            'reference',
            'prototype_prd',
            'prototype_prfaq',
            'merge_input',
        )
