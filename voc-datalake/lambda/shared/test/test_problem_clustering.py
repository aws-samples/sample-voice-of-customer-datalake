"""
Tests for shared/problem_clustering.py, the server-side port of the browser's
problem-text clustering primitives.

The parity cases load from fixtures/problem_clustering_cases.json, the SAME file
the frontend problemClustering.test.ts asserts against — so a drift between the
two implementations fails here or there.
"""
import json
import math
import os

import pytest

from shared.problem_clustering import (
    normalize_text,
    extract_keywords,
    jaccard_similarity,
)

_FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'problem_clustering_cases.json')
with open(_FIXTURE, encoding='utf-8') as f:
    CASES = json.load(f)


class TestNormalizeText:
    @pytest.mark.parametrize('case', CASES['normalize'])
    def test_matches_fixture(self, case):
        assert normalize_text(case['input']) == case['expected']


class TestExtractKeywords:
    @pytest.mark.parametrize('case', CASES['keywords'])
    def test_matches_fixture(self, case):
        # Sorted for a stable comparison; the function returns an unordered set.
        assert sorted(extract_keywords(case['input'])) == case['expected']

    def test_drops_short_words_and_stopwords(self):
        # "is"/"a" are stopwords; "no" is a stopword; "ok" is length 2 (dropped).
        assert extract_keywords('is a no ok problem') == frozenset({'problem'})


class TestJaccardSimilarity:
    @pytest.mark.parametrize('case', CASES['jaccard'])
    def test_matches_fixture(self, case):
        got = jaccard_similarity(
            extract_keywords(case['a']), extract_keywords(case['b'])
        )
        assert math.isclose(got, case['expected'], rel_tol=1e-9, abs_tol=1e-12)

    def test_two_empty_sets_are_identical(self):
        assert jaccard_similarity(frozenset(), frozenset()) == 1.0

    def test_one_empty_set_shares_nothing(self):
        assert jaccard_similarity(frozenset({'a'}), frozenset()) == 0.0
        assert jaccard_similarity(frozenset(), frozenset({'a'})) == 0.0
