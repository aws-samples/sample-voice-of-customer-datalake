"""What the mutation run of ``target_reader`` found that the pagination suite could not see.

The suite read whole pages under a cap the page itself never passed, so a cap checked with ``>``
instead of ``>=`` (one review too many) and a stop checked with ``<=`` (one page too many) both
survived. It never put a skipped review before a new one on the same page (``continue`` →
``break``), never fed two reviews with the same text, and never looked at a result's defaults
(``blocked``, ``off_host``) or at the frozen dataclasses.
"""
import dataclasses

import pytest
from target_reader import ReadLimits, ReadReview, TargetResult, read_target
from test_web_reviews_pagination import BASE, ScriptedTab, chain, limits, per_page, public_dns, review

__all__ = ['public_dns']  # the autouse no-DNS fixture of the pagination suite applies here too


def texts(result: TargetResult) -> list[str]:
    return [r.review.text for r in result.reviews]


class TestTheReviewCap:
    def test_a_page_with_more_reviews_than_the_cap_is_cut_at_the_cap(self):
        tab = ScriptedTab(chain(2))
        result = read_target(tab, BASE, per_page([review('a'), review('b'), review('c')], [review('d')]), limits(max_reviews=2))
        assert (texts(result), result.pages_read, tab.visited) == (['a', 'b'], 1, [BASE])

    def test_reaching_the_cap_on_a_page_reads_no_further_page(self):
        tab = ScriptedTab(chain(2))
        result = read_target(tab, BASE, per_page([review('a'), review('b')], [review('c')]), limits(max_reviews=2))
        assert (texts(result), result.pages_read, tab.visited) == (['a', 'b'], 1, [BASE])

    def test_one_below_the_cap_reads_the_next_page(self):
        tab = ScriptedTab(chain(2))
        result = read_target(tab, BASE, per_page([review('a')], [review('b'), review('c')]), limits(max_reviews=2))
        assert (texts(result), result.pages_read, tab.visited) == (['a', 'b'], 2, [BASE, f'{BASE}?page=2'])


class TestASkippedReviewDoesNotEndThePage:
    def test_an_old_review_before_a_new_one(self):
        extract = per_page([review('old', '2020-01-01'), review('new')])
        result = read_target(ScriptedTab(chain(1)), BASE, extract, limits(is_new=lambda r: r.date != '2020-01-01'))
        assert texts(result) == ['new']

    def test_a_duplicate_before_a_new_one(self):
        result = read_target(ScriptedTab(chain(1)), BASE, per_page([review('a'), review('a'), review('b')]), limits())
        assert texts(result) == ['a', 'b']


class TestAReviewIsItsTextAndDate:
    def test_the_same_text_on_two_dates_is_two_reviews(self):
        extract = per_page([review('same', '2026-10-01'), review('same', '2026-10-02')])
        result = read_target(ScriptedTab(chain(1)), BASE, extract, limits())
        assert [(r.review.text, r.review.date) for r in result.reviews] == [('same', '2026-10-01'), ('same', '2026-10-02')]

    def test_the_same_text_without_a_date_is_one_review(self):
        result = read_target(ScriptedTab(chain(1)), BASE, per_page([review('same', None), review('same', None)]), limits())
        assert [(r.review.text, r.review.date) for r in result.reviews] == [('same', None)]


def test_a_read_that_ends_normally_is_neither_blocked_nor_off_host():
    result = read_target(ScriptedTab(chain(1)), BASE, per_page([review('a')]), limits())
    assert (result.blocked, result.off_host, result.pages_read) == (None, False, 1)


@pytest.mark.parametrize(('value', 'attribute'), [
    (ReadReview(review('a'), 1, BASE), 'page'),
    (ReadLimits(max_pages=1, max_reviews=1, has_time=lambda: True, is_new=lambda _r: True), 'max_pages'),
])
def test_read_records_and_limits_are_frozen(value, attribute):
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(value, attribute, 2)
