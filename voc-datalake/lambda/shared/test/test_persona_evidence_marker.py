"""shared/persona_evidence_marker.py: an imported or copied persona says what evidence it has, never invented."""
import pytest

from shared import persona_evidence_marker as marker


def _codes(block):
    return [w['code'] for w in block['warnings']]


class TestImported:
    def test_counts_no_evidence_and_warns(self):
        fields = marker.imported()
        assert fields['evidence'] == {'source': 'import', 'count': 0, 'inherited': False, 'origin': 'import'}
        block = fields['methodology']
        assert (block['step'], block['skipped'], block['evidence']) == ('personas', [], 0)
        assert _codes(block) == ['no_evidence']
        assert 'Imported persona' in block['warnings'][0]['message']

    def test_the_start_answer_is_the_same_block(self):
        assert marker.import_start() == marker.imported()['methodology']


class TestCopied:
    def test_a_generated_source_keeps_its_review_count(self):
        source = {'input_feedback_ids': ['a', 'b', 'c'], 'evidence_feedback_ids': ['a']}
        fields = marker.copied(source)
        assert fields['evidence'] == {'source': 'copy', 'count': 3, 'inherited': True, 'origin': 'generated'}
        assert fields['methodology']['warnings'] == []
        assert fields['methodology']['evidence'] == 3

    def test_cited_ids_count_when_there_is_no_corpus(self):
        assert marker.copied({'evidence_feedback_ids': ['a', 'b']})['evidence']['count'] == 2

    @pytest.mark.parametrize(('source', 'origin'), [
        ({'imported_from': 'text'}, 'import'),
        ({'evidence': {'source': 'import', 'count': 0}}, 'import'),
        ({'evidence': {'source': 'copy', 'count': 0, 'origin': 'import'}}, 'import'),
        ({}, 'unknown'),
        ({'evidence': {'source': 'copy', 'origin': 'made-up'}}, 'unknown'),
        ({'input_feedback_ids': 'not-a-list'}, 'unknown'),
    ])
    def test_a_source_without_reviews_is_a_copy_without_evidence(self, source, origin):
        fields = marker.copied(source)
        assert fields['evidence'] == {'source': 'copy', 'count': 0, 'inherited': False, 'origin': origin}
        assert _codes(fields['methodology']) == ['no_evidence']
        assert 'Copied from' in fields['methodology']['warnings'][0]['message']

    def test_the_marker_repeats_no_review_id(self):
        fields = marker.copied({'input_feedback_ids': ['fb1']})
        assert 'fb1' not in repr(fields)

    def test_marker_fields_are_recomputed_by_a_copy(self):
        assert frozenset({'evidence', 'methodology'}) == marker.MARKER_FIELDS
