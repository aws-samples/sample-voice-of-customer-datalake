"""``run_agentic_web_search(max_queries=…)`` — an agent run's remaining web budget caps the loop."""
import json
from unittest.mock import MagicMock, patch

import pytest

from shared import agentic_search

RESULT = [{'title': 't', 'url': 'https://example.com/a', 'snippet': 's'}]


def _run(max_queries):
    plans = [json.dumps({'queries': ['a', 'b', 'c']}), json.dumps({'done': False, 'queries': ['d', 'e', 'f']}),
             json.dumps({'done': False, 'queries': ['g', 'h', 'i']})]
    search = MagicMock(return_value=RESULT)
    with patch.object(agentic_search, 'converse', MagicMock(side_effect=plans)), \
            patch.object(agentic_search, 'search_web', search):
        outcome = agentic_search.run_agentic_web_search('Why are refunds slow?', max_queries=max_queries)
    return outcome, search


@pytest.mark.parametrize(('cap', 'executed'), [(None, 8), (2, 2), (4, 4), (20, 8)])
def test_the_cap_bounds_the_executed_searches(cap, executed):
    outcome, search = _run(cap)
    assert (len(outcome.queries), search.call_count) == (executed, executed)


@pytest.mark.parametrize('cap', [0, -3])
def test_no_budget_runs_nothing(cap):
    outcome, search = _run(cap)
    assert (outcome.queries, search.call_count) == ([], 0)
