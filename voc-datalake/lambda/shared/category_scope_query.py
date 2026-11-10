"""A ``CategoryScope`` as a DynamoDB ``FilterExpression``, for scoped item walks.

The metrics API's item path walks ``gsi1-by-date`` day by day under a soft cap on
the rows it keeps. Filtering the caller's scope only AFTER the walk made that cap
count every category: a viewer restricted to one category of a 17,000-review
workspace had the walk stop after 5,000 rows of mostly other categories, so their
all-time total was a third of the truth. Pushing the scope into the query keeps
the cap (and ``max_matched``) counting only rows the caller may see.

The expression is an optimisation of what is READ, never the policy: every caller
still runs ``category_access.filter_items`` on the result, so a row the expression
lets through (or a scope too large to express) is dropped there.
"""

from __future__ import annotations

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.category_access import FALLBACK_CATEGORY, CategoryScope

# DynamoDB accepts at most 100 operands in one IN comparison; a larger list is
# left to the in-memory filter rather than split into OR'd INs.
MAX_IN_OPERANDS = 100


def admits_nothing(scope: CategoryScope) -> bool:
    """True when no item can pass ``scope`` (no category, or an empty source grant)."""
    no_category = not scope.categories_all and not scope.categories
    no_source = scope.source_allow is not None and not scope.source_allow
    return no_category or no_source


def _category_condition(scope: CategoryScope) -> ConditionBase | None:
    # One operand is kept free for the '' an uncategorised 'other' item may carry.
    if scope.categories_all or not scope.categories or len(scope.categories) >= MAX_IN_OPERANDS:
        return None
    names = sorted(scope.categories)
    if FALLBACK_CATEGORY not in scope.categories:
        return Attr('category').is_in(names)
    # An item with no (or an empty) category reads as 'other' (`item_category`).
    return Attr('category').is_in([*names, '']) | Attr('category').not_exists()


def _source_condition(scope: CategoryScope) -> ConditionBase | None:
    if scope.source_allow is not None:
        allow = sorted(scope.source_allow)
        return Attr('source_platform').is_in(allow) if 0 < len(allow) <= MAX_IN_OPERANDS else None
    deny = sorted(scope.source_deny)
    return ~Attr('source_platform').is_in(deny) if 0 < len(deny) <= MAX_IN_OPERANDS else None


def scope_filter(scope: CategoryScope | None) -> ConditionBase | None:
    """The condition admitting only rows ``scope`` may see; None when nothing is pushed down."""
    if scope is None or scope.all:
        return None
    return combine(_category_condition(scope), _source_condition(scope))


def combine(*conditions: ConditionBase | None) -> ConditionBase | None:
    """AND the given conditions, skipping None; None when all are None."""
    present = [condition for condition in conditions if condition is not None]
    if not present:
        return None
    combined = present[0]
    for condition in present[1:]:
        combined = combined & condition
    return combined
