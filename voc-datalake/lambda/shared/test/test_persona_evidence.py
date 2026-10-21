"""Tests for shared.persona_evidence — "Review #N" citations to feedback ids."""
from shared.persona_evidence import input_feedback_ids, resolve_evidence_ids

ITEMS = [{'feedback_id': f'fb{i}'} for i in range(1, 11)]  # Review #1 -> fb1


class TestResolveEvidenceIds:
    def test_maps_review_numbers_to_the_ids_at_those_positions(self):
        assert resolve_evidence_ids(['Review #1', 'Review #4'], ITEMS, 10) == ['fb1', 'fb4']

    def test_accepts_every_citation_shape_the_model_has_produced(self):
        """The stored corpus holds both "Review #N" and "Review N"."""
        evidence = ['Review #2', 'Review 3', 'review#5', 'Reviews #6']
        assert resolve_evidence_ids(evidence, ITEMS, 10) == ['fb2', 'fb3', 'fb5', 'fb6']

    def test_reads_several_citations_from_one_string(self):
        assert resolve_evidence_ids(['Review #2 and Review #7'], ITEMS, 10) == ['fb2', 'fb7']

    def test_drops_a_number_beyond_what_the_model_saw(self):
        """Review #8 was truncated away before the prompt; position 8 is not it."""
        assert resolve_evidence_ids(['Review #2', 'Review #8'], ITEMS, 7) == ['fb2']

    def test_drops_review_zero_and_numbers_past_the_list(self):
        assert resolve_evidence_ids(['Review #0', 'Review #99'], ITEMS, 99) == []

    def test_deduplicates_in_first_cited_order(self):
        assert resolve_evidence_ids(['Review #3', 'Review #1', 'Review #3'], ITEMS, 10) == ['fb3', 'fb1']

    def test_ignores_numbers_that_are_not_citations(self):
        assert resolve_evidence_ids(['3 of the reviewers agreed'], ITEMS, 10) == []

    def test_returns_nothing_for_untrusted_non_list_evidence(self):
        for evidence in (None, 'Review #1', {'Review': 1}, 7):
            assert resolve_evidence_ids(evidence, ITEMS, 10) == []

    def test_skips_non_string_entries(self):
        assert resolve_evidence_ids([1, None, 'Review #2'], ITEMS, 10) == ['fb2']

    def test_skips_a_cited_item_without_a_feedback_id(self):
        items = [{'feedback_id': ''}, {}, {'feedback_id': 'fb3'}]
        assert resolve_evidence_ids(['Review #1', 'Review #2', 'Review #3'], items, 3) == ['fb3']


class TestInputFeedbackIds:
    def test_returns_the_ids_that_reached_the_model_in_order(self):
        assert input_feedback_ids(ITEMS, 3) == ['fb1', 'fb2', 'fb3']

    def test_skips_items_without_an_id(self):
        assert input_feedback_ids([{'feedback_id': 'a'}, {}, {'feedback_id': 'c'}], 3) == ['a', 'c']

    def test_returns_everything_when_more_were_seen_than_exist(self):
        assert input_feedback_ids(ITEMS[:2], 50) == ['fb1', 'fb2']
