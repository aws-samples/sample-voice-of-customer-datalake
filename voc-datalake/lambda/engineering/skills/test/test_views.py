"""The administrators' reads' pure rules: a page's events ranges and the scorecards' one source of numbers."""
from __future__ import annotations

from engineering.skills.store import MAX_PAGE
from engineering.skills.views import SCORE_SOURCE, event_spans, shipped_versions


def test_a_pages_numbers_are_read_in_ranges_of_at_most_a_page_each() -> None:
    assert event_spans([20, 3, 1, 2]) == [(1, 20)]
    assert event_spans([1, 2, 152, 302, 400]) == [(1, 2), (152, 152), (302, 400)]
    assert event_spans([1, MAX_PAGE, MAX_PAGE + 1]) == [(1, MAX_PAGE), (MAX_PAGE + 1, MAX_PAGE + 1)]
    assert event_spans([]) == []


def test_the_default_scorecards_are_the_shipped_versions_alone() -> None:
    assert (SCORE_SOURCE, shipped_versions('fixer'), shipped_versions('coordinator')) == ('shipped', [1], [2, 1])
    assert shipped_versions('coach') == []
