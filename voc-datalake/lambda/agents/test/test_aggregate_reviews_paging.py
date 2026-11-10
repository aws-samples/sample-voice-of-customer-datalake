"""The aggregate step counts every review in scope: the run's 30-day window, every page.

5.34.00 live: scope technical_support, 108 reviews in 30 days (102 of them on one day two weeks
earlier), and the aggregate reported "1 reviews → 1 problems" — it read a 7-day window while the
persona, research and document steps read 30, and it read one page of 100 at most.
"""
from __future__ import annotations

import json
from unittest.mock import patch

from agents.graph import Node
from agents.nodes import aggregate_reviews
from agents.nodes.base import NodeContext
from shared.prompt_labels import PromptLabels

AGENT = {'agent_id': 'ag_1', 'scope': {'all': False, 'categories': ['technical_support']}}
ANSWER = {'title': 'Support is slow', 'problem_summary': 's', 'research_question': 'q',
          'top_problems': [{'title': 'Slow replies', 'category': 'technical_support', 'review_ids': ['fb_0']}]}


def _corpus(n: int) -> list[dict]:
    return [{'feedback_id': f'fb_{i}', 'category': 'technical_support', 'urgency': 'low', 'text': f'r{i}'}
            for i in range(n)]


class _FeedbackRoute:
    """``GET /feedback`` over ``corpus``: offset/limit pages with the window's ``total``."""

    def __init__(self, corpus: list[dict]):
        self.corpus = corpus
        self.queries: list[dict] = []

    def __call__(self, _method: str, _path: str, _claims: dict, *, query: dict) -> dict:
        self.queries.append(query)
        offset, limit = query.get('offset', 0), query['limit']
        page = self.corpus[offset:offset + limit]
        return {'count': len(page), 'total': len(self.corpus), 'offset': offset, 'items': page}


def _run(route: _FeedbackRoute, params: dict | None = None) -> dict:
    node = Node(id='aggregate', type='aggregate_reviews', title='Aggregate', instructions='', role='worker',
                params=params or {})
    ctx = NodeContext(agent=AGENT, run={'run_id': 'ar_1', 'context': {}}, node=node, envelope='', claims={})
    with (
        patch('agents.principal.metrics', side_effect=route),
        patch('agents.context_blocks.company_context', return_value=''),
        patch('agents.context_blocks.memories', return_value=''),
        patch('agents.llm.ask', return_value=json.dumps(ANSWER)),
        patch.object(aggregate_reviews, 'load_prompt_labels', return_value=PromptLabels()),
        patch.object(aggregate_reviews, 'get_aggregates_table', return_value=None),
    ):
        return aggregate_reviews.start(ctx)


def test_two_pages_of_reviews_are_all_counted():
    route = _FeedbackRoute(_corpus(108))

    result = _run(route)

    assert result['summary'].startswith('108 reviews → 1 problems')
    assert result['updates']['aggregate']['review_count'] == 108
    assert [q['offset'] for q in route.queries] == [0, 100]


def test_the_window_is_the_runs_thirty_days_unless_the_step_sets_days():
    route = _FeedbackRoute(_corpus(3))
    _run(route)
    assert route.queries[0]['days'] == 30

    route = _FeedbackRoute(_corpus(3))
    _run(route, {'days': 7})
    assert route.queries[0]['days'] == 7


def test_an_exact_page_stops_at_the_total():
    route = _FeedbackRoute(_corpus(100))

    _run(route)

    assert len(route.queries) == 1


def test_paging_stops_at_the_page_cap():
    route = _FeedbackRoute(_corpus(aggregate_reviews.PAGE_SIZE * (aggregate_reviews.MAX_PAGES_PER_CATEGORY + 2)))

    _run(route)

    assert len(route.queries) == aggregate_reviews.MAX_PAGES_PER_CATEGORY
