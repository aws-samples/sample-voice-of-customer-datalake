"""The wizards' live count (shared/persona_feedback_preview.py, ported from #429 by @aws-bryan).

The exact count is the generation's own read, so it is checked against the data on moto with
the real index shapes; the estimate's scaling and the cache are checked with a stub table.
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from shared import persona_feedback_preview as preview
from shared.category_access import CategoryScope, scope_to_config
from shared.feedback import get_feedback_context
from shared.time_budget import WalkBudget

TODAY_ROWS = 300
OLDER_ROWS = 40
OLDER_DAYS = 5


class _UnhurriedWalkBudget(WalkBudget):
    """Coverage tracing slows a moto walk; the budget is not what these tests are about."""

    def __init__(self, seconds: float = 600, **kwargs: Any) -> None:
        super().__init__(seconds=max(seconds, 600), **kwargs)


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr('shared.feedback.WalkBudget', _UnhurriedWalkBudget)
    monkeypatch.setattr(preview, 'WalkBudget', _UnhurriedWalkBudget)
    # A fresh container: no cached answer and no cached index count leaks between tests.
    monkeypatch.setattr(preview, '_cache', OrderedDict())
    monkeypatch.setattr(preview, '_index_counts', {})


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(n: int, offset: int) -> dict:
    day = _day(offset)
    category = 'delivery' if n % 2 else 'billing'
    return {
        'pk': f'SOURCE#{"web" if n % 3 else "app_store"}', 'sk': f'FEEDBACK#r{offset}-{n:04d}',
        'feedback_id': f'r{offset}-{n:04d}', 'date': day, 'source_created_at': f'{day}T09:00:00Z',
        'source_platform': 'web' if n % 3 else 'app_store', 'category': category,
        'sentiment_label': 'negative' if n % 4 == 0 else 'positive',
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T09:00:00+00:00#{n:04d}',
        'gsi2pk': f'CATEGORY#{category}', 'gsi2sk': f'-0.5#{day}#{n:04d}',
    }


def _rows() -> list[dict]:
    return [_review(n, 0) for n in range(TODAY_ROWS)] + [
        _review(n, offset) for offset in range(1, OLDER_DAYS + 1) for n in range(OLDER_ROWS)]


def _index(name: str, hash_key: str, range_key: str | None = None) -> Any:
    schema = [{'AttributeName': hash_key, 'KeyType': 'HASH'}]
    if range_key:
        schema.append({'AttributeName': range_key, 'KeyType': 'RANGE'})
    return {'IndexName': name, 'KeySchema': schema, 'Projection': {'ProjectionType': 'ALL'}}


@pytest.fixture(scope='module')
def table():
    with mock_aws():
        keys = ('pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'feedback_id')
        feedback = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='feedback', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in keys],
            GlobalSecondaryIndexes=[
                _index('gsi1-by-date', 'gsi1pk', 'gsi1sk'), _index('gsi2-by-category', 'gsi2pk', 'gsi2sk'),
                _index('gsi4-by-feedback-id', 'feedback_id'),
            ],
        )
        with feedback.batch_writer() as writer:
            for row in _rows():
                writer.put_item(Item=row)
        yield feedback


def _expected(**match: str) -> int:
    return sum(1 for row in _rows() if all(row[key] == value for key, value in match.items()))


class TestTheExactCountIsTheGenerationsRead:
    def test_every_matching_review_in_the_window(self, table):
        answer = preview.exact_count(table, {'days': 30})
        assert answer == {'matched': len(_rows()), 'matched_is_lower_bound': False, 'estimated': False}

    def test_filters_narrow_it_like_the_generation(self, table):
        filters = {'days': 30, 'sources': ['web'], 'sentiments': ['negative']}
        matched = preview.exact_count(table, filters)['matched']
        assert matched == _expected(source_platform='web', sentiment_label='negative')
        # The generation's read of the same filters draws from exactly that many.
        assert len(get_feedback_context(table, filters, limit=10_000)) == matched

    def test_a_shorter_window_counts_only_its_days(self, table):
        assert preview.exact_count(table, {'days': 1})['matched'] == TODAY_ROWS

    def test_the_callers_category_scope_applies(self, table):
        scope = scope_to_config(CategoryScope(all=False, categories=frozenset({'delivery'})))
        matched = preview.exact_count(table, {'days': 30, 'category_scope': scope})['matched']
        assert matched == _expected(category='delivery')

    def test_a_read_cut_by_the_budget_is_a_lower_bound(self, table, monkeypatch):
        monkeypatch.setattr(preview, 'WalkBudget', WalkBudget)
        ticks = iter(range(0, 10_000, 30))
        answer = preview.exact_count(table, {'days': 30}, clock=lambda: float(next(ticks)))
        assert answer['matched_is_lower_bound'] is True
        assert answer['matched'] < len(_rows())


class TestTheEstimate:
    def test_a_sample_that_covers_the_whole_index_is_the_count(self, table):
        answer = preview.estimate_count(table, {'days': 30, 'categories': ['billing']})
        assert answer == {'matched': _expected(category='billing'), 'matched_is_lower_bound': False,
                          'estimated': True}

    def test_a_partial_sample_is_scaled_by_the_index_item_count(self):
        rows = [_review(n, 0) for n in range(100)]
        stub = _stub_table(rows, item_count=10_000)
        answer = preview.estimate_count(stub, {'days': 30, 'sources': ['web']}, pages=1)
        web = sum(1 for row in rows if row['source_platform'] == 'web')  # 66 of 100
        assert answer['matched'] == round(web / 100 * 10_000, -2)
        assert answer['estimated'] is True

    def test_a_thin_sample_says_nothing_rather_than_zero(self):
        stub = _stub_table([_review(n, 0) for n in range(5)], item_count=10_000)
        assert preview.estimate_count(stub, {'days': 30}, pages=1)['matched'] is None

    def test_the_day_walk_floor_is_the_newest_days_with_data(self):
        request = MagicMock(days=400, max_dated_days=2, by_category=False)
        request.extra.channel = None
        sample = [{'date': _day(0)}, {'date': _day(3)}, {'date': _day(9)}]
        assert preview.import_floor(request, sample) == _day(3)


def _stub_table(rows: list[dict], *, item_count: int) -> MagicMock:
    stub = MagicMock()
    stub.name = 'feedback'
    stub.scan.return_value = {'Items': rows, 'LastEvaluatedKey': {'feedback_id': 'next'}}
    stub.meta.client.describe_table.return_value = {'Table': {'GlobalSecondaryIndexes': [
        {'IndexName': 'gsi4-by-feedback-id', 'ItemCount': item_count}]}}
    return stub


class TestTheCache:
    def test_an_exact_count_is_reused_and_answers_an_estimate(self, monkeypatch):
        exact = MagicMock(return_value={'matched': 7, 'matched_is_lower_bound': False, 'estimated': False})
        estimate = MagicMock()
        monkeypatch.setattr(preview, 'exact_count', exact)
        monkeypatch.setattr(preview, 'estimate_count', estimate)
        filters = {'days': 30, 'sources': ['a', 'b']}
        preview.preview_feedback(None, 'p1', filters, 'exact', clock=lambda: 0.0)
        reordered = {'days': 30, 'sources': ['b', 'a']}
        assert preview.preview_feedback(None, 'p1', reordered, 'estimate', clock=lambda: 10.0)['matched'] == 7
        estimate.assert_not_called()
        assert exact.call_count == 1

    def test_it_expires_and_is_kept_apart_per_project_and_scope(self, monkeypatch):
        exact = MagicMock(return_value={'matched': 7, 'matched_is_lower_bound': False, 'estimated': False})
        monkeypatch.setattr(preview, 'exact_count', exact)
        preview.preview_feedback(None, 'p1', {'days': 30}, 'exact', clock=lambda: 0.0)
        preview.preview_feedback(None, 'p2', {'days': 30}, 'exact', clock=lambda: 1.0)
        preview.preview_feedback(None, 'p1', {'days': 30, 'category_scope': {'categories': ['x']}}, 'exact',
                                 clock=lambda: 2.0)
        preview.preview_feedback(None, 'p1', {'days': 30}, 'exact', clock=lambda: preview.CACHE_SECONDS + 1.0)
        assert exact.call_count == 4

    def test_a_lower_bound_is_never_cached(self, monkeypatch):
        exact = MagicMock(return_value={'matched': 7, 'matched_is_lower_bound': True, 'estimated': False})
        monkeypatch.setattr(preview, 'exact_count', exact)
        for _ in range(2):
            preview.preview_feedback(None, 'p1', {'days': 30}, 'exact', clock=lambda: 0.0)
        assert exact.call_count == 2

    def test_an_unknown_mode_is_refused(self):
        with pytest.raises(ValueError, match='mode must be one of'):
            preview.preview_feedback(None, 'p1', {}, 'guess')
