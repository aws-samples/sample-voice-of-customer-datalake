"""A generated persona stores the reviews it cites as ``evidence_feedback_ids`` (ported from #429 by @aws-bryan).

``supporting_evidence`` numbers reviews in prompt order; ``_build_persona_items`` resolves them against
that order while it still exists, never past the reviews the model read, and keeps the text as written.
"""
from datetime import UTC, datetime

import projects

FEEDBACK = [{'feedback_id': f'fb-{n}', 'source_platform': 'web'} for n in range(1, 6)]


def _item(evidence: object, items_seen: int) -> dict:
    [(_pid, _persona, item)] = projects._build_persona_items(
        'proj-1', [{'name': 'Ada Moreno', 'supporting_evidence': evidence}], FEEDBACK,
        persona_count=1, source_breakdown={'web': 5}, llm_time=1, now_dt=datetime(2026, 10, 1, tzinfo=UTC),
        model_id='model', date_basis='imported', input_ids=[f['feedback_id'] for f in FEEDBACK[:items_seen]],
        items_seen=items_seen,
    )
    return item


def test_cited_reviews_are_stored_as_ids_in_cited_order():
    item = _item(['Review #4', 'Review #2'], items_seen=5)
    assert item['evidence_feedback_ids'] == ['fb-4', 'fb-2']
    assert item['supporting_evidence'] == ['Review #4', 'Review #2']


def test_a_citation_past_what_the_model_read_is_kept_as_text_only():
    item = _item(['Review #2', 'Review #5', 'Mostly business travellers'], items_seen=3)
    assert item['evidence_feedback_ids'] == ['fb-2']
    assert item['supporting_evidence'] == ['Review #2', 'Review #5', 'Mostly business travellers']


def test_no_citations_store_an_empty_list():
    assert _item('Review #1', items_seen=5)['evidence_feedback_ids'] == []
