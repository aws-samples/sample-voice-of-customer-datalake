"""The methodology block a PR/FAQ / PRD job stores on its document (shared/methodology.py, tenet 2)."""
from jobs.document_generator import handler as H


def _gathered(items_used=0, feature_request_ids=(), skipped=()):
    return H.GatheredContext(
        'FB', 'PE', {}, H.FeedbackSample('FB', items_used, False), tuple(feature_request_ids), tuple(skipped),
    )


def _docs(n):
    return [{'sk': f'DOC#d{i}', 'document_id': f'd{i}'} for i in range(n)]


class TestFinalMethodology:
    def test_the_forecasts_skipped_steps_are_kept_and_evidence_counted(self):
        forecast = {'skipped': [{'step': 'prfaq', 'reason': 'missing'}]}
        out = H._final_methodology({'doc_type': 'prd', 'methodology': forecast},
                                   _gathered(items_used=4, feature_request_ids=('fr1',)))
        assert out['step'] == 'prd'
        assert out['skipped'] == [{'step': 'prfaq', 'reason': 'missing'}]
        assert out['evidence'] == 5
        assert [w['code'] for w in out['warnings']] == ['missing_upstream']

    def test_no_evidence_is_said(self):
        out = H._final_methodology({'doc_type': 'prfaq'}, _gathered())
        assert out['evidence'] == 0
        assert [w['code'] for w in out['warnings']] == ['no_evidence']

    def test_documents_past_the_cap_are_recorded(self):
        out = H._final_methodology({'doc_type': 'prd'}, _gathered(items_used=1, skipped=('d3', 'd4')))
        [warning] = out['warnings']
        assert warning['code'] == 'reference_documents_skipped'
        assert warning['document_ids'] == ['d3', 'd4']
        assert warning['cap'] == H.REFERENCE_DOCUMENT_CAP


class TestCappedReferenceIds:
    def test_within_the_cap_nothing_is_skipped(self):
        assert H._capped_reference_ids(_docs(3), {}) == ()

    def test_past_the_cap_the_rest_are_named(self):
        assert H._capped_reference_ids(_docs(5), {}) == ('d3', 'd4')

    def test_the_selection_is_applied_first(self):
        assert H._capped_reference_ids(_docs(5), {'selected_document_ids': ['d0', 'd4']}) == ()


class TestItemFields:
    def test_the_block_is_stored_on_the_document(self):
        fields = H._document_item_fields('p', 'j', 'idea', 'C', {}, {}, {}, {}, {'step': 'prd'})
        assert fields['methodology'] == {'step': 'prd'}

    def test_no_block_no_field(self):
        assert 'methodology' not in H._document_item_fields('p', 'j', 'idea', 'C', {}, {}, {}, {})
