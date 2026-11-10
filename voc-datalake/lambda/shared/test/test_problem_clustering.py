"""The indexed similarity merge gives exactly the browser's brute-force answer."""
from __future__ import annotations

import pytest

from shared.problem_clustering import extract_keywords, jaccard_similarity, merge_by_similarity, normalize_text


def _brute_force(texts: list[str], threshold: float) -> list[list[int]]:
    """problemGrouping.ts's loop: join the first group with ANY member similar enough."""
    groups: list[list[int]] = []
    for position, text in enumerate(texts):
        keywords = extract_keywords(text)
        target = next((g for g in groups
                       if any(jaccard_similarity(keywords, extract_keywords(texts[m])) >= threshold for m in g)), None)
        if target is None:
            groups.append([position])
        else:
            target.append(position)
    return groups


def test_normalize_and_keywords_match_the_browser():
    assert normalize_text('  The App CRASHES!!  on   login ') == 'the app crashes on login'
    assert extract_keywords('The app crashes on login, again') == frozenset({'app', 'crashes', 'login'})
    assert extract_keywords('it is so') == frozenset()


def test_jaccard_edges():
    assert jaccard_similarity(frozenset(), frozenset()) == 1.0
    assert jaccard_similarity(frozenset({'a'}), frozenset()) == 0.0
    assert jaccard_similarity(frozenset({'aaa', 'bbb'}), frozenset({'bbb', 'ccc'})) == pytest.approx(1 / 3)


def test_a_problem_joins_the_first_group_that_matches():
    texts = ['slow delivery times', 'delivery too slow', 'app crashes on login', 'slow delivery app']
    assert merge_by_similarity(texts, 0.4) == [[0, 1, 3], [2]]
    assert merge_by_similarity(texts, 1.0) == [[0], [1], [2], [3]]


def test_keywordless_problems_merge_together_as_in_the_browser():
    assert merge_by_similarity(['it is', 'app broken', 'so so'], 0.4) == [[0, 2], [1]]


def test_the_float_edge_of_the_prefix_does_not_miss_a_match():
    # |x| = 5 at t = 0.6: 0.6 * 5 is 3.0000000000000004 in floating point (J = 4/6 here).
    texts = ['alpha bravo charlie delta echo', 'alpha bravo charlie delta foxtrot']
    assert merge_by_similarity(texts, 0.6) == _brute_force(texts, 0.6) == [[0, 1]]


def _word_soup(seed: int, count: int):
    """Deterministic overlapping texts of 0-5 words from a 14-word vocabulary (a small LCG)."""
    state = seed + 1
    for _ in range(count):
        state = (state * 1103515245 + 12345) % 2**31
        size = state % 6
        words = {f'word{(state >> (4 * n)) % 14:02d}' for n in range(size)}
        yield ' '.join(sorted(words))


@pytest.mark.parametrize('threshold', [0.2, 0.4, 0.6, 1.0])
@pytest.mark.parametrize('seed', range(8))
def test_randomized_parity_with_the_brute_force_merge(threshold: float, seed: int):
    texts = list(_word_soup(seed, count=120))
    assert merge_by_similarity(texts, threshold) == _brute_force(texts, threshold)


def test_a_size_ratio_exactly_at_the_threshold_still_matches():
    # |y| / |x| = 2 / 5 = 0.4 and y is a subset of x, so J = 0.4: the size filter must keep it.
    texts = ['alpha bravo charlie delta echo', 'alpha bravo']
    assert merge_by_similarity(texts, 0.4) == _brute_force(texts, 0.4) == [[0, 1]]
    assert merge_by_similarity(texts[::-1], 0.4) == _brute_force(texts[::-1], 0.4) == [[0, 1]]


def _wide_soup(seed: int, count: int):
    """Like `_word_soup`, with 1-12 words from a 20-word vocabulary (sizes the size filter prunes)."""
    state = seed + 7
    for _ in range(count):
        state = (state * 1103515245 + 12345) % 2**31
        size = 1 + state % 12
        words = {f'term{(state >> n) % 20:02d}' for n in range(size)}
        yield ' '.join(sorted(words))


@pytest.mark.parametrize('threshold', [0.2, 0.4, 0.6])
@pytest.mark.parametrize('seed', range(6))
def test_randomized_parity_across_wide_size_ranges(threshold: float, seed: int):
    texts = list(_wide_soup(seed, count=150))
    assert merge_by_similarity(texts, threshold) == _brute_force(texts, threshold)


def test_threshold_zero_puts_everything_in_one_group():
    assert merge_by_similarity(['aaa', 'bbb'], 0) == [[0, 1]]
    assert merge_by_similarity([], 0.4) == []
