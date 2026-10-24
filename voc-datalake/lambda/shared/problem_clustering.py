"""Problem-text similarity merge for Problem Analysis (server side).

A port of the grouping the browser used to run over every loaded review
(``frontend/src/pages/ProblemAnalysis/problemGrouping.ts``): problem summaries are
reduced to stopword-filtered keyword sets, and a problem joins the FIRST existing
group (in creation order) that holds any member whose keyword set has a Jaccard
similarity of at least the threshold with its own; otherwise it starts a group.
Ported from PR #429 (``shared/problem_clustering.py``, @aws-bryan).

The browser compared every new problem with every member of every group, which is
quadratic: fine over 2,000 reviews, not over the 25,000 a large window holds. This
module gives the same answer with a prefix-filtered inverted index (the standard
all-pairs similarity-join bound): for ``J(x, y) >= t`` the two sets must share a
token among the first ``|x| - ceil(t * |x|) + 1`` tokens of each, under one global
token order (rarest first). Only those prefix tokens are indexed, so a candidate
check touches the few members that could possibly match, and each candidate is then
verified with the exact Jaccard the browser computed.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence

__all__ = ['merge_by_similarity']

# The browser's stopword set, verbatim (problemGrouping.ts `extractKeywords`).
_STOP_WORDS = frozenset({
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'although', 'though', 'whenever',
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
    'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'get', 'got', 'getting',
})

_NON_ALNUM = re.compile(r'[^a-z0-9\s]')
_WHITESPACE = re.compile(r'\s+')

# Float slack for the prefix length: `0.6 * 5` is 3.0000000000000004, and a ceil of
# that would shorten the prefix by one and miss a real match. A longer prefix only
# adds candidates, which the exact check then discards.
_EPSILON = 1e-9


def normalize_text(text: str) -> str:
    """Lowercase, strip everything but ``a-z0-9`` and whitespace, collapse whitespace."""
    return _WHITESPACE.sub(' ', _NON_ALNUM.sub('', text.lower())).strip()


def extract_keywords(text: str) -> frozenset[str]:
    """The normalized words longer than two characters that are not stopwords."""
    return frozenset(word for word in normalize_text(text).split(' ') if len(word) > 2 and word not in _STOP_WORDS)


def jaccard_similarity(first: frozenset[str], second: frozenset[str]) -> float:
    """``|A & B| / |A | B|``; two empty sets are identical (1.0), one empty set shares nothing (0.0)."""
    if not first and not second:
        return 1.0
    if not first or not second:
        return 0.0
    shared = len(first & second)
    return shared / (len(first) + len(second) - shared)


class _MemberIndex:
    """The keyword sets already placed in a group, indexed by their prefix tokens."""

    def __init__(self, keyword_sets: Sequence[frozenset[str]], threshold: float) -> None:
        frequency = Counter(word for keywords in set(keyword_sets) for word in keywords)
        # Rarest first, ties by the word itself, so the order is deterministic.
        self._rank = {word: n for n, word in enumerate(sorted(frequency, key=lambda w: (frequency[w], w)))}
        self._threshold = threshold
        self._postings: dict[str, list[frozenset[str]]] = {}
        # Every distinct member set -> the lowest group index holding a member with it.
        self._group_of: dict[frozenset[str], int] = {}

    def _prefix(self, keywords: frozenset[str]) -> list[str]:
        ordered = sorted(keywords, key=self._rank.__getitem__)
        length = len(ordered) - math.ceil(self._threshold * len(ordered) - _EPSILON) + 1
        return ordered[:max(1, length)]

    def first_match(self, keywords: frozenset[str]) -> int | None:
        """The lowest group index with a member at least ``threshold`` similar, else None."""
        if not keywords:
            return self._group_of.get(keywords)
        best: int | None = None
        seen: set[frozenset[str]] = set()
        threshold = self._threshold
        size = len(keywords)
        # The size filter of the same similarity join: `J(x, y) <= min(|x|, |y|) / max(|x|, |y|)`,
        # so a member whose size ratio is below the threshold (with float slack) cannot match and
        # its exact Jaccard is never computed. It only skips pairs the exact check would refuse.
        smallest = threshold * size - _EPSILON
        largest = size / threshold + _EPSILON
        for word in self._prefix(keywords):
            for member in self._postings.get(word, ()):
                if member in seen:
                    continue
                seen.add(member)
                group = self._group_of[member]
                if best is not None and group >= best:
                    continue
                if not smallest <= len(member) <= largest:
                    continue
                if jaccard_similarity(keywords, member) >= threshold:
                    best = group
        return best

    def add(self, keywords: frozenset[str], group: int) -> None:
        known = self._group_of.get(keywords)
        if known is not None:
            self._group_of[keywords] = min(known, group)
            return
        self._group_of[keywords] = group
        if keywords:
            for word in self._prefix(keywords):
                self._postings.setdefault(word, []).append(keywords)


def merge_by_similarity(texts: Sequence[str], threshold: float) -> list[list[int]]:
    """Group ``texts`` (distinct problems, in first-seen order) by keyword similarity.

    Returns the groups in creation order, each a list of indices into ``texts`` whose
    first index is the group's representative (the problem that opened it).
    """
    keyword_sets = [extract_keywords(text) for text in texts]
    if threshold <= 0:
        # Every pair is at least 0 similar: the first problem absorbs the rest.
        return [list(range(len(texts)))] if texts else []
    index = _MemberIndex(keyword_sets, threshold)
    groups: list[list[int]] = []
    for position, keywords in enumerate(keyword_sets):
        group = index.first_match(keywords)
        if group is None:
            group = len(groups)
            groups.append([])
        groups[group].append(position)
        index.add(keywords, group)
    return groups
