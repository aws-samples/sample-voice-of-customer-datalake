"""The administrators' reads' pure rules: a page's events ranges and the scorecards' one source of numbers."""
from __future__ import annotations

from engineering.skills.store import MAX_PAGE
from engineering.skills.views import NOT_SHIPPED, SCORE_SOURCE, event_spans, score_source, shipped_versions


def test_a_pages_numbers_are_read_in_ranges_of_at_most_a_page_each() -> None:
    assert event_spans([20, 3, 1, 2]) == [(1, 20)]
    assert event_spans([1, 2, 152, 302, 400]) == [(1, 2), (152, 152), (302, 400)]
    assert event_spans([1, MAX_PAGE, MAX_PAGE + 1]) == [(1, MAX_PAGE), (MAX_PAGE + 1, MAX_PAGE + 1)]
    assert event_spans([]) == []


def test_a_number_is_labelled_shipped_only_if_the_role_shipped_it() -> None:
    # (7.53.00: the shipped skills are the compiled bundle's: the coordinator's v7 since 7.54.00, the fixer's v3)
    assert [score_source('coordinator', n) for n in (1, 7, 8)] == ['shipped', 'shipped', NOT_SHIPPED]
    assert (score_source('fixer', 4), score_source('fixer', 5), score_source('coach', 1)) == (
        'shipped', NOT_SHIPPED, NOT_SHIPPED)


def test_the_default_scorecards_are_the_shipped_versions_alone() -> None:
    assert (SCORE_SOURCE, shipped_versions('fixer'), shipped_versions('coordinator')) == (
        'shipped', [4, 3, 2, 1], [7, 6, 5, 4, 3])   # (at most DEFAULT_COMPARED, newest first)
    assert shipped_versions('coach') == []
