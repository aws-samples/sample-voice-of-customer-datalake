"""
Problem-text clustering for the Problem Analysis aggregation (server side).

A FAITHFUL port of the client algorithm that used to run in the browser
(frontend/src/pages/ProblemAnalysis/ProblemAnalysis.tsx): normalize text,
extract stopword-filtered keywords, and merge problem summaries by Jaccard
similarity of their keyword sets. The server now does the heavy O(rows) pass so
a 50k-row window never ships to the browser; the client only re-merges the small
set of DISTINCT problems this produces (see /metrics/problems).

PARITY IS LOAD-BEARING. The slider still re-clusters client-side at a chosen
threshold, so the two implementations must agree on normalize/keywords/Jaccard
or the server's finest-grain groups and the client's merge disagree. The shared
fixture `shared/test/fixtures/problem_clustering_cases.json` is asserted by BOTH
`shared/test/test_problem_clustering.py` and the frontend
`problemClustering.test.ts`, so a change to one side that drifts fails the other.
"""

from __future__ import annotations

import re

# Mirrors `extractKeywords`'s stopword set in ProblemAnalysis.tsx VERBATIM.
# Any edit must be made in both places and reflected in the parity fixture.
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


def normalize_text(text: str) -> str:
    """Lowercase, strip non-alphanumerics, collapse whitespace. Mirrors `normalizeText`."""
    lowered = text.lower()
    stripped = _NON_ALNUM.sub('', lowered)
    return _WHITESPACE.sub(' ', stripped).strip()


def extract_keywords(text: str) -> frozenset[str]:
    """Normalized tokens longer than two chars that are not stopwords.

    Mirrors `extractKeywords`: split the normalized text on spaces, keep words
    with length > 2 that are not in the stopword set.
    """
    words = normalize_text(text).split(' ')
    return frozenset(w for w in words if len(w) > 2 and w not in _STOP_WORDS)


def jaccard_similarity(set1: frozenset[str], set2: frozenset[str]) -> float:
    """|A ∩ B| / |A ∪ B|. Mirrors `jaccardSimilarity`, including the empty-set edges.

    Two empty sets are identical (1.0); one empty set shares nothing (0.0).
    """
    if not set1 and not set2:
        return 1.0
    if not set1 or not set2:
        return 0.0
    intersection = len(set1 & set2)
    union = len(set1 | set2)
    return intersection / union
