"""The Problem Analysis tree, built on the server (``GET /feedback/problems``).

The page used to page ``/feedback`` in the browser and stop at the newest 2,000
reviews, so on a large window every count it showed was a fraction. The route now
reads the WHOLE window as slim rows (only :data:`PROBLEM_FIELDS`) and answers with
the finished category -> subcategory -> problem tree: counts, urgent counts,
sentiment, a root-cause hypothesis and a few sample review ids per problem, never
the reviews themselves. Ported from PR #429 (``_aggregate_problems``, @aws-bryan).

The grouping is the browser's (``problemGrouping.ts``): a review needs a
``problem_summary``; a missing category is ``uncategorized``, a missing
subcategory ``general``; problems within a subcategory merge by keyword similarity
at the page's Similarity setting (``shared.problem_clustering``), first-seen
(newest) problem as the representative; everything is sorted largest first.

The answer is bounded: at most :data:`MAX_PROBLEMS_LISTED` problems are listed
(the largest), every total stays exact (``problem_count`` per subcategory counts
them all) and ``problems_truncated`` says when the long tail was left out.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Final

from shared.problem_clustering import merge_by_similarity

__all__ = [
    'PROBLEM_READ',
    'SlimRead',
    'aggregate_problems',
    'parse_problem_query',
]

# The page's Similarity tokens (useProblemFilters.ts SIMILARITY_LEVELS), default `med`.
SIMILARITY_LEVELS: Final = {'low': 0.2, 'med': 0.4, 'high': 0.6, 'off': 1.0}
DEFAULT_SIMILARITY: Final = 'med'

# Everything the tree and the route's filters read off a review: the grouping
# (category, subcategory, problem text, root cause), the counts (urgency,
# sentiment), the window (both date bases), the caller's scope (category, source)
# and the channel / dims / tag / stars filters (shared/item_filters.py).
PROBLEM_FIELDS: Final = (
    'feedback_id', 'category', 'subcategory', 'problem_summary', 'problem_root_cause_hypothesis',
    'urgency', 'sentiment_score', 'sentiment_label', 'source_platform', 'source_channel',
    'date', 'source_created_at', 'dimensions', 'tags', 'rating',
)

# Response size: Lambda answers a synchronous call with at most 6 MB. A listed problem is
# at most ~2 KB (problem + root cause at MAX_TEXT_CHARS, MAX_SIMILAR_LISTED similar texts at
# MAX_SIMILAR_CHARS, sample ids, counts), so 1,000 of them stay near 2 MB. Every total still
# counts every problem; past the cap only the largest are listed (`problems_truncated`).
MAX_PROBLEMS_LISTED: Final = 1_000
MAX_SAMPLE_IDS: Final = 10
MAX_SIMILAR_LISTED: Final = 3
MAX_SIMILAR_CHARS: Final = 200
MAX_TEXT_CHARS: Final = 500
# CPU: similarity merging is close to quadratic at a low threshold, and it runs after a walk
# that may have used most of the 29 s. Per subcategory only the largest MAX_CLUSTERED_LEAVES
# distinct problem texts are merged; the rest stay single problems (`similarity_partial`).
MAX_CLUSTERED_LEAVES: Final = 5_000
UNCATEGORIZED: Final = 'uncategorized'
GENERAL: Final = 'general'
URGENT: Final = 'high'


@dataclass(frozen=True)
class SlimRead:
    """How a day walk reads projected rows: which fields, and the bigger caps they afford.

    A projected row is a few hundred bytes, so a walk can hold far more of them than
    the 5,000 full reviews the list routes stop at; the request's walk budget still
    bounds the time, and past either limit the answer is marked partial.
    """

    fields: tuple[str, ...]
    soft_cap: int
    max_scanned_per_partition: int
    page_limit: int

    def query_kwargs(self) -> dict[str, Any]:
        """``ProjectionExpression`` + its names, a FRESH dict per query (boto3 merges into it)."""
        names = {f'#pf{n}': name for n, name in enumerate(self.fields)}
        return {'ProjectionExpression': ', '.join(names), 'ExpressionAttributeNames': names}


# A 25,000-review day reads in full; 100,000 rows is the most one request holds.
PROBLEM_READ: Final = SlimRead(
    fields=PROBLEM_FIELDS, soft_cap=100_000, max_scanned_per_partition=100_000, page_limit=2_000)


@dataclass(frozen=True)
class ProblemQuery:
    """The page's narrowing filters (the window, source and channel are the walk's)."""

    category: str | None = None
    subcategory: str | None = None
    urgent_only: bool = False
    threshold: float = SIMILARITY_LEVELS[DEFAULT_SIMILARITY]

    def admits(self, item: Mapping[str, Any], *, ignore_subcategory: bool = False) -> bool:
        if self.category is not None and _category(item) != self.category:
            return False
        if not ignore_subcategory and self.subcategory is not None and _subcategory(item) != self.subcategory:
            return False
        return not self.urgent_only or item.get('urgency') == URGENT


def _text_param(params: Mapping[str, Any], name: str) -> str | None:
    value = params.get(name)
    return value if isinstance(value, str) and value else None


def parse_problem_query(params: Mapping[str, Any] | None) -> ProblemQuery:
    """``category``, ``subcategory``, ``urgent=1`` and ``similarity``; ValueError on an unknown level."""
    params = params or {}
    similarity = _text_param(params, 'similarity') or DEFAULT_SIMILARITY
    if similarity not in SIMILARITY_LEVELS:
        raise ValueError(f'similarity must be one of {", ".join(SIMILARITY_LEVELS)}')
    return ProblemQuery(
        category=_text_param(params, 'category'),
        subcategory=_text_param(params, 'subcategory'),
        urgent_only=params.get('urgent') in ('1', 'true'),
        threshold=SIMILARITY_LEVELS[similarity],
    )


def _category(item: Mapping[str, Any]) -> str:
    value = item.get('category')
    return value if isinstance(value, str) and value else UNCATEGORIZED


def _subcategory(item: Mapping[str, Any]) -> str:
    value = item.get('subcategory')
    return value if isinstance(value, str) and value else GENERAL


def _problem(item: Mapping[str, Any]) -> str:
    value = item.get('problem_summary')
    return value.strip() if isinstance(value, str) else ''


def _score(item: Mapping[str, Any]) -> float:
    value = item.get('sentiment_score')
    return float(value) if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool) else 0.0


def _clip(text: str) -> str:
    return text[:MAX_TEXT_CHARS]


@dataclass
class _Leaf:
    """Every review of one exact problem text in one subcategory."""

    problem: str
    count: int = 0
    urgent: int = 0
    score_sum: float = 0.0
    labels: dict[str, int] = field(default_factory=dict)
    root_cause: str | None = None
    sample_ids: list[str] = field(default_factory=list)

    def add(self, item: Mapping[str, Any]) -> None:
        self.count += 1
        self.urgent += 1 if item.get('urgency') == URGENT else 0
        self.score_sum += _score(item)
        label = item.get('sentiment_label')
        label = label if isinstance(label, str) and label else 'neutral'
        self.labels[label] = self.labels.get(label, 0) + 1
        cause = item.get('problem_root_cause_hypothesis')
        if self.root_cause is None and isinstance(cause, str) and cause:
            self.root_cause = _clip(cause)
        feedback_id = item.get('feedback_id')
        if len(self.sample_ids) < MAX_SAMPLE_IDS and isinstance(feedback_id, str) and feedback_id:
            self.sample_ids.append(feedback_id)


def _merged(leaves: list[_Leaf]) -> dict[str, Any]:
    """One problem group from its leaves, representative first."""
    count = sum(leaf.count for leaf in leaves)
    labels: dict[str, int] = {}
    for leaf in leaves:
        for label, n in leaf.labels.items():
            labels[label] = labels.get(label, 0) + n
    similar = [leaf.problem for leaf in leaves[1:]]
    return {
        'problem': _clip(leaves[0].problem),
        'similar_problems': [text[:MAX_SIMILAR_CHARS] for text in similar[:MAX_SIMILAR_LISTED]],
        'similar_count': len(similar),
        'root_cause': next((leaf.root_cause for leaf in leaves if leaf.root_cause), None),
        'count': count,
        'urgent_count': sum(leaf.urgent for leaf in leaves),
        'avg_sentiment': round(sum(leaf.score_sum for leaf in leaves) / count, 4),
        'sentiment_counts': labels,
        'sample_ids': [fid for leaf in leaves for fid in leaf.sample_ids][:MAX_SAMPLE_IDS],
    }


def _leaf_tree(items: Iterable[Mapping[str, Any]], query: ProblemQuery) -> dict[str, dict[str, dict[str, _Leaf]]]:
    """category -> subcategory -> exact problem text -> leaf, all in first-seen order."""
    tree: dict[str, dict[str, dict[str, _Leaf]]] = {}
    for item in items:
        problem = _problem(item)
        if not problem or not query.admits(item):
            continue
        leaves = tree.setdefault(_category(item), {}).setdefault(_subcategory(item), {})
        leaves.setdefault(problem, _Leaf(problem)).add(item)
    return tree


def _clustered_groups(ordered: list[_Leaf], threshold: float) -> tuple[list[list[int]], bool]:
    """Similarity groups over ``ordered`` (indices), and whether the leaf cap left some unmerged.

    Only the ``MAX_CLUSTERED_LEAVES`` largest leaves are merged (in their first-seen order, so
    the merge rule is unchanged for them); every other leaf is its own group.
    """
    if len(ordered) <= MAX_CLUSTERED_LEAVES:
        return merge_by_similarity([leaf.problem for leaf in ordered], threshold), False
    largest = sorted(sorted(range(len(ordered)), key=lambda i: -ordered[i].count)[:MAX_CLUSTERED_LEAVES])
    merged = merge_by_similarity([ordered[i].problem for i in largest], threshold)
    groups = [[largest[i] for i in group] for group in merged]
    chosen = set(largest)
    groups.extend([i] for i in range(len(ordered)) if i not in chosen)
    return groups, True


def _subcategory_node(name: str, leaves: dict[str, _Leaf], threshold: float) -> dict[str, Any]:
    ordered = list(leaves.values())
    groups, unmerged = _clustered_groups(ordered, threshold)
    problems = sorted((_merged([ordered[i] for i in group]) for group in groups), key=lambda p: -p['count'])
    return {
        'similarity_partial': unmerged,
        'subcategory': name,
        'total_items': sum(p['count'] for p in problems),
        'urgent_count': sum(p['urgent_count'] for p in problems),
        'problem_count': len(problems),
        'problems': problems,
    }


def _category_node(name: str, subcategories: dict[str, dict[str, _Leaf]], threshold: float) -> dict[str, Any]:
    subs = _by_total([_subcategory_node(sub, leaves, threshold) for sub, leaves in subcategories.items()])
    return {
        'category': name,
        'subcategories': subs,
        'total_items': sum(s['total_items'] for s in subs),
        'urgent_count': sum(s['urgent_count'] for s in subs),
    }


def _by_total(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(nodes, key=lambda node: -node['total_items'])


def _listed_ids(categories: list[dict[str, Any]]) -> set[int] | None:
    """``id()`` of the problems to list when there are more than the cap (the largest), else None."""
    every = [p for c in categories for s in c['subcategories'] for p in s['problems']]
    if len(every) <= MAX_PROBLEMS_LISTED:
        return None
    return {id(p) for p in sorted(every, key=lambda p: -p['count'])[:MAX_PROBLEMS_LISTED]}


def _subcategory_names(items: Iterable[Mapping[str, Any]], query: ProblemQuery) -> list[str]:
    """The subcategories the filter can offer: of the chosen category, whatever subcategory is chosen."""
    names = {
        item['subcategory'] for item in items
        if isinstance(item.get('subcategory'), str) and item['subcategory']
        and query.admits(item, ignore_subcategory=True)
    }
    return sorted(names)


def aggregate_problems(items: Sequence[Mapping[str, Any]], query: ProblemQuery) -> dict[str, Any]:
    """The tree over ``items`` (already windowed, scoped and source/channel filtered, newest first)."""
    tree = _leaf_tree(items, query)
    categories = _by_total([_category_node(name, subs, query.threshold) for name, subs in tree.items()])
    listed = _listed_ids(categories)
    if listed is not None:
        for category in categories:
            for sub in category['subcategories']:
                sub['problems'] = [p for p in sub['problems'] if id(p) in listed]
    return {
        'feedback_count': sum(c['total_items'] for c in categories),
        'problem_count': sum(s['problem_count'] for c in categories for s in c['subcategories']),
        'problems_truncated': listed is not None,
        'similarity_partial': any(s['similarity_partial'] for c in categories for s in c['subcategories']),
        'subcategories': _subcategory_names(items, query),
        'categories': categories,
    }
