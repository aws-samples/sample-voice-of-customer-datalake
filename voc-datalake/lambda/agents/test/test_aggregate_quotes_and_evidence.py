"""The aggregate keeps quotes from the reviews each problem cites, and the writers' evidence names
the scope's review count first (5.35.02 live: no PR/FAQ version cited the 108 reviews it was built on).
"""
from __future__ import annotations

from typing import ClassVar

from agents.graph import Node
from agents.nodes import aggregate_reviews
from agents.nodes.base import NodeContext

PROBLEMS = [
    {'title': 'No rebooking', 'review_ids': ['a', 'b', 'c']},
    {'title': 'Lost bags', 'review_ids': ['d', 'missing']},
]
REVIEWS = [
    {'feedback_id': 'a', 'original_text': 'Nobody rebooked me'},
    {'feedback_id': 'b', 'original_text': '', 'text': 'Slept at the gate'},
    {'feedback_id': 'c', 'original_text': 'A third one'},
    {'feedback_id': 'd', 'original_text': 'word ' * 100},
]


class TestQuotes:
    def test_at_most_two_quotes_per_problem_from_the_reviews_it_cites(self):
        quotes = aggregate_reviews._quotes(PROBLEMS, REVIEWS)

        assert [(q['problem'], q['text'][:18]) for q in quotes] == [
            ('No rebooking', 'Nobody rebooked me'), ('No rebooking', 'Slept at the gate'),
            ('Lost bags', 'word word word wor'),
        ]

    def test_a_long_review_is_quoted_on_a_whole_word(self):
        long_quote = aggregate_reviews._quotes(PROBLEMS, REVIEWS)[-1]['text']

        assert len(long_quote) <= aggregate_reviews.MAX_QUOTE_CHARS
        assert long_quote.endswith('word…')

    def test_a_review_without_text_is_not_quoted(self):
        assert aggregate_reviews._quotes([{'title': 'T', 'review_ids': ['x']}], [{'feedback_id': 'x'}]) == []


def _ctx(aggregate: object) -> NodeContext:
    node = Node(id='n', type='write_prfaq', title='Write', instructions='', role='worker', params={})
    return NodeContext(agent={'agent_id': 'ag'}, run={'run_id': 'ar', 'context': {'aggregate': aggregate}},
                       node=node, envelope='')


class TestEvidenceText:
    AGGREGATE: ClassVar[dict] = {'title': 'Stranded', 'problem_summary': 'No care.', 'review_count': 108, 'days': 30,
                 'top_problems': [{'title': 'No rebooking', 'category': 'support', 'evidence_count': 41}],
                 'quotes': [{'problem': 'No rebooking', 'text': 'Nobody rebooked me'}, 'bad', {'text': 5}]}

    def test_the_count_comes_first_then_the_problems_then_the_quotes(self):
        assert _ctx(self.AGGREGATE).evidence_text() == (
            '108 customer reviews in scope from the last 30 days; each problem below counts the reviews '
            'that back it.\n'
            'Stranded\nNo care.\n- No rebooking (Support): 41 reviews\n'
            'Quotes from the reviews:\n- (No rebooking) "Nobody rebooked me"'
        )

    def test_a_clip_keeps_the_count(self):
        assert _ctx(self.AGGREGATE).evidence_text(40).startswith('108 customer reviews in scope')

    def test_without_a_count_or_window_only_the_problems_remain(self):
        aggregate = {**self.AGGREGATE, 'review_count': True, 'days': None, 'quotes': []}
        assert _ctx(aggregate).evidence_text() == 'Stranded\nNo care.\n- No rebooking (Support): 41 reviews'

    def test_a_count_without_a_window_names_no_window(self):
        text = _ctx({**self.AGGREGATE, 'days': 0}).evidence_text()
        assert text.startswith('108 customer reviews in scope; ')

    def test_no_aggregate_no_evidence(self):
        assert _ctx(None).evidence_text() == ''
