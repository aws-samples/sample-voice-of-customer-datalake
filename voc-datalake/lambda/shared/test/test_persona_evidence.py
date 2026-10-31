"""The model's "Review #N" citations resolved to feedback ids (ported from #429 by @aws-bryan)."""
import pytest

from shared.feedback_sampling import MAX_INPUT_FEEDBACK_IDS
from shared.persona_evidence import resolve_evidence_ids

ITEMS = [{'feedback_id': f'fb-{n}'} for n in range(1, 11)]


@pytest.mark.parametrize(('evidence', 'expected'), [
    (['Review #3', 'Review #1'], ['fb-3', 'fb-1']),
    (['review 2', 'Reviews #4, #5 and #6'], ['fb-2', 'fb-4', 'fb-5', 'fb-6']),
    (['Review#7 & #8'], ['fb-7', 'fb-8']),
    (['Review #2', 'Review #2', 'see Review 2'], ['fb-2']),
])
def test_citations_resolve_in_first_cited_order(evidence, expected):
    assert resolve_evidence_ids(evidence, ITEMS, len(ITEMS)) == expected


def test_a_number_past_what_the_model_read_resolves_to_nothing():
    # Only the first 4 reviews reached the model: #5 sat in the truncated tail.
    assert resolve_evidence_ids(['Review #4', 'Review #5', 'Review #0'], ITEMS, 4) == ['fb-4']


def test_prose_and_stray_numbers_are_not_citations():
    assert resolve_evidence_ids(['3 of them mention delays', 'Most reviews agree'], ITEMS, len(ITEMS)) == []


@pytest.mark.parametrize('evidence', [None, 'Review #1', {'r': 'Review #1'}, [1, None, {'x': 2}]])
def test_malformed_model_output_resolves_to_nothing(evidence):
    assert resolve_evidence_ids(evidence, ITEMS, len(ITEMS)) == []


def test_an_item_without_an_id_is_skipped():
    items = [{'feedback_id': ''}, {}, {'feedback_id': 'fb-3'}]
    assert resolve_evidence_ids(['Review #1', 'Review #2', 'Review #3'], items, 3) == ['fb-3']


def test_the_list_is_capped():
    items = [{'feedback_id': f'fb-{n}'} for n in range(MAX_INPUT_FEEDBACK_IDS + 20)]
    evidence = [f'Review #{n}' for n in range(1, len(items) + 1)]
    assert len(resolve_evidence_ids(evidence, items, len(items))) == MAX_INPUT_FEEDBACK_IDS
