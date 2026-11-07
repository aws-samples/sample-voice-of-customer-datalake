"""shared/methodology.py compact / journal_line: the block an agent run or a plan journals, bounded."""
import pytest

from shared import methodology as m

BLOCK = {
    'step': 'prd',
    'skipped': [{'step': 'prfaq', 'reason': 'missing', 'extra': 'dropped'}],
    'warnings': [{'code': 'missing_upstream', 'step': 'prfaq', 'message': 'This PRD is made without a PR/FAQ.'},
                 {'code': 'reference_documents_skipped', 'message': 'Only 3 read.', 'document_ids': ['d1'], 'cap': 3}],
    'evidence': 12,
    'unexpected': {'kept': False},
}


class TestCompact:
    def test_keeps_step_skipped_warnings_and_evidence_only(self):
        assert m.compact(BLOCK) == {
            'step': 'prd',
            'skipped': [{'step': 'prfaq', 'reason': 'missing'}],
            'warnings': [{'code': 'missing_upstream', 'message': 'This PRD is made without a PR/FAQ.', 'step': 'prfaq'},
                         {'code': 'reference_documents_skipped', 'message': 'Only 3 read.'}],
            'evidence': 12,
        }

    @pytest.mark.parametrize('value', [None, 'prd', [], {'step': 'review'}, {'skipped': []}])
    def test_anything_that_is_not_a_block_is_none(self, value):
        assert m.compact(value) is None

    def test_bounds_lists_and_messages(self):
        block = {'step': 'prfaq', 'skipped': [{'step': 'personas', 'reason': 'missing'}] * 30,
                 'warnings': [{'code': 'no_evidence', 'message': 'x' * 1000}] * 30, 'evidence': None}
        out = m.compact(block)
        assert out is not None
        assert len(out['skipped']) == len(out['warnings']) == m.MAX_JOURNAL_ITEMS
        assert len(out['warnings'][0]['message']) == m.MAX_JOURNAL_MESSAGE_CHARS

    @pytest.mark.parametrize(('evidence', 'kept'), [(0, 0), (True, None), ('3', None), (None, None)])
    def test_evidence_is_an_integer_or_none(self, evidence, kept):
        out = m.compact({'step': 'prd', 'evidence': evidence})
        assert out is not None
        assert out['evidence'] == kept

    def test_rows_without_a_step_or_code_are_dropped(self):
        out = m.compact({'step': 'prd', 'skipped': [{'reason': 'missing'}, 'x'], 'warnings': [{'message': 'm'}, 7]})
        assert out is not None
        assert (out['skipped'], out['warnings']) == ([], [])


class TestJournalLine:
    def test_names_the_skipped_steps_evidence_and_warnings(self):
        block = m.compact(BLOCK)
        assert block is not None
        assert m.journal_line(block) == 'Methodology (PRD): skipped a PR/FAQ; 12 evidence item(s); 2 warning(s).'

    def test_a_clean_start_says_so(self):
        assert m.journal_line({'step': 'research', 'skipped': [], 'warnings': [], 'evidence': None}) == (
            'Methodology (research): no step skipped.')
