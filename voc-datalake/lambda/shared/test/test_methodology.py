"""shared/methodology.py: the upstream steps a generation skips, said on the answer and the artifact."""
import pytest

from shared import methodology as m


def _items(*sks):
    return [{'sk': sk, 'document_id': sk.split('#', 1)[1]} for sk in sks]


class TestAssess:
    def test_prd_on_an_empty_project_skips_personas_and_prfaq(self):
        out = m.assess('prd', [])
        assert out['step'] == 'prd'
        assert out['skipped'] == [
            {'step': 'personas', 'reason': 'missing'},
            {'step': 'prfaq', 'reason': 'missing'},
        ]
        assert [w['code'] for w in out['warnings']] == ['missing_upstream', 'missing_upstream']
        assert out['evidence'] is None

    def test_feedback_is_never_missing_only_not_selected(self):
        out = m.assess('prfaq', _items('PERSONA#p1'), used={'feedback': False})
        assert out['skipped'] == [{'step': 'feedback', 'reason': 'not_selected'}]
        assert out['warnings'][0]['code'] == 'upstream_not_selected'

    def test_present_but_unused_upstream_is_not_selected(self):
        out = m.assess('prd', _items('PERSONA#p1', 'PRFAQ#f1'), used={'personas': False, 'prfaq': True})
        assert out['skipped'] == [{'step': 'personas', 'reason': 'not_selected'}]

    def test_the_full_path_skips_nothing(self):
        out = m.assess('prd', _items('PERSONA#p1', 'PRFAQ#f1'), evidence=12)
        assert out == {'step': 'prd', 'skipped': [], 'warnings': [], 'evidence': 12}

    def test_zero_evidence_is_a_warning(self):
        out = m.assess('prfaq', _items('PERSONA#p1'), evidence=0)
        assert [w['code'] for w in out['warnings']] == ['no_evidence']

    def test_unknown_step_is_refused(self):
        with pytest.raises(ValueError, match='unknown methodology step'):
            m.assess('review', [])


class TestDocumentRequest:
    def test_feedback_defaults_on(self):
        assert m.data_sources_with_defaults(None) == {'feedback': True}
        assert m.data_sources_with_defaults({'personas': True}) == {'personas': True, 'feedback': True}

    def test_explicit_false_is_honoured(self):
        assert m.data_sources_with_defaults({'feedback': False}) == {'feedback': False}

    def test_a_non_object_reads_as_empty(self):
        assert m.data_sources_with_defaults('yes') == {'feedback': True}

    def test_prd_reading_documents_with_no_selection_uses_the_prfaq(self):
        out = m.for_document_request('prd', _items('PERSONA#p1', 'PRFAQ#f1'), {
            'data_sources': {'feedback': True, 'personas': True, 'documents': True},
        })
        assert out['skipped'] == []

    def test_prd_selecting_other_documents_does_not_use_the_prfaq(self):
        out = m.for_document_request('prd', _items('PERSONA#p1', 'PRFAQ#f1', 'DOC#d1'), {
            'data_sources': {'feedback': True, 'personas': True, 'documents': True},
            'selected_document_ids': ['d1'],
        })
        assert out['skipped'] == [{'step': 'prfaq', 'reason': 'not_selected'}]

    def test_headless_post_with_no_data_sources(self):
        out = m.for_document_request('prfaq', [], {})
        assert out['skipped'] == [{'step': 'personas', 'reason': 'missing'}]


class TestPrototype:
    def test_no_source_is_blocked(self):
        out = m.for_prototype_request([])
        assert m.is_blocked(out)
        assert {'step': 'prd', 'reason': 'missing'} in out['skipped']

    def test_a_prfaq_alone_warns_but_is_not_blocked(self):
        out = m.for_prototype_request(_items('PRFAQ#f1'))
        assert not m.is_blocked(out)
        assert out['skipped'] == [{'step': 'prd', 'reason': 'missing'}]


class TestHumanAndOverview:
    def test_human_document_has_zero_evidence(self):
        out = m.human_document('prfaq')
        assert out['evidence'] == 0
        assert out['warnings'][0]['code'] == 'no_evidence'

    def test_documents_skipped_warning(self):
        w = m.documents_skipped_warning(['a', 'b'], 3)
        assert w['code'] == 'reference_documents_skipped'
        assert w['document_ids'] == ['a', 'b']
        assert w['cap'] == 3

    def test_overview_on_an_empty_project(self):
        out = m.overview([{'sk': 'META'}])
        assert out['order'] == ['personas', 'research', 'prfaq', 'prd', 'prototype']
        assert out['steps']['prd'] == {'missing': ['personas', 'prfaq'], 'count': 0}
        assert out['steps']['prototype']['blocked'] is True

    def test_overview_counts_and_unblocks(self):
        out = m.overview(_items('PERSONA#p1', 'PRFAQ#f1', 'PRFAQ#f2'))
        assert out['steps']['prfaq'] == {'missing': [], 'count': 2}
        assert out['steps']['prototype'] == {'missing': ['prd'], 'count': 0, 'blocked': False}
        assert out['steps']['research']['missing'] == []
