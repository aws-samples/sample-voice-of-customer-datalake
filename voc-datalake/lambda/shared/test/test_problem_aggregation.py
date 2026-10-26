"""The Problem Analysis tree, pure over rows (the route's moto cases are in api/test/test_metrics_problems.py)."""
from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

import pytest

from shared.problem_aggregation import ProblemQuery, SlimRead, aggregate_problems, parse_problem_query


def _row(fid: str, problem: str | None, **fields) -> dict:
    return {'feedback_id': fid, 'problem_summary': problem, 'sentiment_score': Decimal('-0.5'), **fields}


def test_defaults_match_the_browser_grouping():
    body = aggregate_problems([_row('1', 'Late parcel'), _row('2', ''), _row('3', None)], ProblemQuery())
    [category] = body['categories']
    assert (category['category'], category['subcategories'][0]['subcategory']) == ('uncategorized', 'general')
    assert body['feedback_count'] == 1


def test_largest_first_at_every_level_and_sentiment_is_the_mean():
    rows = [_row('a', 'Refund missing', category='billing'),
            _row('b', 'Late parcel', category='delivery', sentiment_score=Decimal('0.5')),
            _row('c', 'Late parcel', category='delivery', sentiment_label='positive'),
            _row('d', 'Box crushed', category='delivery', subcategory='packaging')]
    body = aggregate_problems(rows, ProblemQuery(threshold=1.0))
    assert [c['category'] for c in body['categories']] == ['delivery', 'billing']
    general = body['categories'][0]['subcategories'][0]
    assert (general['subcategory'], general['total_items']) == ('general', 2)
    late = general['problems'][0]
    assert (late['avg_sentiment'], late['sentiment_counts']) == (0.0, {'neutral': 1, 'positive': 1})


def test_the_long_tail_is_left_out_but_every_total_stays_exact():
    rows = [_row(str(n), f'problem{n:03d} unique{n:03d}') for n in range(30)]
    rows += [_row('big1', 'problem000 unique000')]
    with patch('shared.problem_aggregation.MAX_PROBLEMS_LISTED', 5):
        body = aggregate_problems(rows, ProblemQuery(threshold=1.0))
    sub = body['categories'][0]['subcategories'][0]
    assert (len(sub['problems']), sub['problem_count'], sub['total_items']) == (5, 30, 31)
    assert sub['problems'][0]['count'] == 2
    assert (body['problems_truncated'], body['problem_count'], body['feedback_count']) == (True, 30, 31)


def test_samples_and_similar_lists_are_bounded():
    rows = [_row(str(n), 'Late parcel again') for n in range(25)]
    group = aggregate_problems(rows, ProblemQuery())['categories'][0]['subcategories'][0]['problems'][0]
    assert (group['count'], group['sample_ids']) == (25, [str(n) for n in range(10)])


@pytest.mark.parametrize(('params', 'expected'), [
    ({}, ProblemQuery()),
    ({'category': 'billing', 'subcategory': '', 'urgent': '1', 'similarity': 'off'},
     ProblemQuery(category='billing', urgent_only=True, threshold=1.0)),
    ({'urgent': '0', 'similarity': 'low'}, ProblemQuery(threshold=0.2)),
])
def test_parse_problem_query(params, expected):
    assert parse_problem_query(params) == expected


def test_parse_rejects_an_unknown_similarity():
    with pytest.raises(ValueError, match='similarity'):
        parse_problem_query({'similarity': 'max'})


def test_the_projection_names_every_field_once():
    kwargs = SlimRead(fields=('date', 'category'), soft_cap=1, max_scanned_per_partition=1, page_limit=1).query_kwargs()
    assert kwargs == {'ProjectionExpression': '#pf0, #pf1',
                      'ExpressionAttributeNames': {'#pf0': 'date', '#pf1': 'category'}}


def test_only_the_largest_leaves_are_clustered_and_the_answer_says_so():
    """CPU bound: past MAX_CLUSTERED_LEAVES distinct texts the rest stay single problems."""
    rows = [_row('a1', 'login fails'), _row('a2', 'login fails'), _row('b1', 'login fails again'),
            _row('b2', 'login fails again'), _row('c1', 'login fails twice')]
    with patch('shared.problem_aggregation.MAX_CLUSTERED_LEAVES', 2):
        capped = aggregate_problems(rows, ProblemQuery(threshold=0.3))
    full = aggregate_problems(rows, ProblemQuery(threshold=0.3))
    sub, whole = capped['categories'][0]['subcategories'][0], full['categories'][0]['subcategories'][0]
    assert (capped['similarity_partial'], sub['similarity_partial'], full['similarity_partial']) == (True, True, False)
    # The two largest texts merged; the smallest stayed alone. Totals are exact either way.
    assert sorted(p['count'] for p in sub['problems']) == [1, 4]
    assert [p['count'] for p in whole['problems']] == [5]
    assert capped['feedback_count'] == full['feedback_count'] == 5


def test_similar_texts_are_bounded_in_number_and_length():
    """Response size: a listed problem carries at most 3 similar texts of 200 characters."""
    long_tail = 'x' * 600
    rows = [_row(str(n), f'checkout broken {n} {long_tail}') for n in range(8)]
    body = aggregate_problems(rows, ProblemQuery(threshold=0.1))
    [problem] = body['categories'][0]['subcategories'][0]['problems']
    assert (len(problem['similar_problems']), problem['similar_count']) == (3, 7)
    assert {len(text) for text in problem['similar_problems']} == {200}
    assert len(problem['problem']) == 500
