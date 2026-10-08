"""Tests for `scripts/retention/rebuild_aggregates.py`, the absolute-value aggregate rebuild.

The central property is that the rebuild produces the SAME rows the live aggregator
would have produced for the same items, so these tests drive the real
`aggregator.handler.record_handler` over the fixtures into one moto table, run the
rebuild into another, and compare the two. Lives under `lambda/` so the default
`testpaths` runs it; the script is loaded by path because `scripts/` is not a package.
"""
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord
from moto import mock_aws

from aggregator.test.aggregator_fixtures import stream_record as _record
from shared.test.moto_tables import create_pk_sk_table
from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'retention' / 'rebuild_aggregates.py'
_OLD = '2026-01-01T00:00:00+00:00'  # processed long before any test's "now"


@pytest.fixture(scope='module')
def rebuild():
    module = load_module_from_path('rebuild_aggregates', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


def _item(n: int, day: str, **fields: Any) -> dict[str, Any]:
    base = {
        'pk': f'SOURCE#{fields.get("source_platform", "webscraper")}', 'sk': f'FEEDBACK#{n}',
        'feedback_id': f'f{n}', 'date': day, 'processed_at': _OLD,
    }
    return {**base, **fields}


# Every dimension and every edge the aggregator's bucketing has: defaults for absent
# fields, an out-of-enum persona, an explicit-null-ish persona, urgent/non-urgent,
# key-safe and unsafe subcategories, zero / absent / negative scores, three dates.
ITEMS = [
    _item(1, '2026-02-11', source_platform='webscraper', category='delivery', sentiment_label='negative',
          sentiment_score=Decimal('-0.8'), urgency='high', persona_type='churn_risk', subcategory='late'),
    _item(2, '2026-02-11', source_platform='webscraper', category='delivery', sentiment_label='positive',
          sentiment_score=Decimal('0.6'), urgency='low', persona_type='advocate', subcategory='has space'),
    _item(3, '2026-02-11', source_platform='feedback_form', category='pricing', sentiment_label='neutral',
          sentiment_score=Decimal('0'), persona_type='loyal'),
    _item(4, '2026-02-12', source_platform='manual_import', category='pricing', sentiment_label='mixed',
          sentiment_score=Decimal('0.1'), urgency='high', persona_type='', subcategory='refunds'),
    _item(5, '2026-02-12'),  # every field absent: aggregator defaults apply
    _item(6, '2026-06-15', source_platform='webscraper', category='support', sentiment_label='negative',
          sentiment_score=Decimal('-0.25'), persona_type='prospect'),
]


@pytest.fixture
def tables() -> Iterator[dict[str, Any]]:
    """feedback + two aggregates tables (one the live aggregator writes, one the rebuild writes)."""
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        yield {
            'feedback': create_pk_sk_table('rb-feedback', resource),
            'live': create_pk_sk_table('rb-live-aggregates', resource),
            'rebuilt': create_pk_sk_table('rb-rebuilt-aggregates', resource),
        }


def _aggregate(table, records: list[DynamoDBRecord]) -> None:
    """Run the REAL aggregator over stream records, writing into `table`."""
    from aggregator import handler

    with patch.object(handler, 'aggregates_table', table), patch.object(handler, 'IDEMPOTENCY_TABLE', ''):
        handler._known_earliest_date = None
        for record in records:
            handler.record_handler(record)
        handler._known_earliest_date = None


def _put_feedback(table, items: list[dict]) -> None:
    for item in items:
        table.put_item(Item=item)


def _rows(table) -> dict[tuple[str, str], dict[str, Any]]:
    """Every METRIC# counter row, reduced to the attributes the read paths use."""
    out = {}
    for row in table.scan()['Items']:
        if row['pk'] == 'METRIC#meta':
            continue
        out[(row['pk'], row['sk'])] = {k: row[k] for k in ('count', 'sum', 'metric_type') if k in row}
    return out


def test_the_rebuild_matches_what_the_aggregator_produced_for_the_same_items(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    _aggregate(tables['live'], [_record('INSERT', new=item) for item in ITEMS])

    plan = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    expected = _rows(tables['live'])
    assert _rows(tables['rebuilt']) == expected
    # Spot checks that the comparison is about something: every read family is present.
    assert expected[('METRIC#daily_total', '2026-02-11')]['count'] == 3
    assert expected[('METRIC#urgent', '2026-02-12')]['count'] == 1
    assert expected[('METRIC#daily_source#webscraper', '2026-02-11')]['metric_type'] == 'source'
    assert expected[('METRIC#persona#unknown', '2026-02-11')] == {'count': 1, 'metric_type': 'persona'}
    assert expected[('METRIC#daily_sentiment_avg', '2026-02-11')] == {'sum': Decimal('-0.2'), 'count': 2}
    assert ('METRIC#daily_subcategory#delivery#late', '2026-02-11') in expected
    assert rebuild.daily_total_sum(plan) == len(ITEMS)
    assert plan.conflicted == []
    meta = tables['rebuilt'].get_item(Key={'pk': 'METRIC#meta', 'sk': 'earliest_date'})['Item']
    assert meta['date'] == '2026-02-11'


def test_rebuilt_rows_carry_no_ttl_and_overwrite_a_wrong_count(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    tables['rebuilt'].put_item(Item={'pk': 'METRIC#daily_total', 'sk': '2026-02-11', 'count': 99,
                                     'ttl': 1, 'updated_at': _OLD})

    rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    row = tables['rebuilt'].get_item(Key={'pk': 'METRIC#daily_total', 'sk': '2026-02-11'})['Item']
    assert row['count'] == 3
    assert all('ttl' not in item for item in tables['rebuilt'].scan()['Items'] if item['pk'] != 'METRIC#meta')


def test_the_dry_run_writes_nothing(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    seeded = {'pk': 'METRIC#daily_category#gone', 'sk': '2026-02-11', 'count': 4, 'updated_at': _OLD}
    tables['rebuilt'].put_item(Item=seeded)

    plan = rebuild.run(tables['feedback'], tables['rebuilt'], apply=False)

    assert sum(plan.written.values()) > 0
    assert plan.zeroed['METRIC#daily_category#*'] == 1
    assert tables['rebuilt'].scan()['Items'] == [seeded]
    assert plan.watermark_written is False


def test_apply_is_idempotent(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    first = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)
    after_first = tables['rebuilt'].scan()['Items']

    second = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    assert sum(first.written.values()) == len(first.targets)
    assert sum(second.written.values()) == 0
    assert sum(second.unchanged.values()) == len(first.targets)
    assert tables['rebuilt'].scan()['Items'] == after_first


def test_a_stale_bucket_is_zeroed_not_deleted(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    table = tables['rebuilt']
    # A category that no longer has items on a rebuilt date, and an average row on a
    # rebuilt date whose items carry no score; plus a row on a date with no feedback.
    table.put_item(Item={'pk': 'METRIC#daily_category#gone', 'sk': '2026-02-11', 'count': 4, 'updated_at': _OLD})
    table.put_item(Item={'pk': 'METRIC#daily_source#old', 'sk': '2026-02-12', 'count': 2,
                         'metric_type': 'source', 'ttl': 5, 'updated_at': _OLD})
    table.put_item(Item={'pk': 'METRIC#daily_total', 'sk': '2025-12-31', 'count': 7, 'updated_at': _OLD})

    plan = rebuild.run(tables['feedback'], table, apply=True)

    gone = table.get_item(Key={'pk': 'METRIC#daily_category#gone', 'sk': '2026-02-11'})['Item']
    assert gone['count'] == 0
    old = table.get_item(Key={'pk': 'METRIC#daily_source#old', 'sk': '2026-02-12'})['Item']
    assert (old['count'], old['metric_type'], 'ttl' in old) == (0, 'source', False)
    untouched = table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': '2025-12-31'})['Item']
    assert untouched['count'] == 7
    assert plan.untouched_existing_dates == {'2025-12-31'}
    assert sum(plan.zeroed.values()) == 2


def test_a_zeroed_average_row_holds_zero_sum_and_count(rebuild, tables):
    _put_feedback(tables['feedback'], [_item(1, '2026-03-01', sentiment_score=Decimal('0'))])
    tables['rebuilt'].put_item(Item={'pk': 'METRIC#daily_sentiment_avg', 'sk': '2026-03-01',
                                     'sum': Decimal('2.5'), 'count': 5, 'updated_at': _OLD})

    rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    row = tables['rebuilt'].get_item(Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': '2026-03-01'})['Item']
    assert (row['sum'], row['count']) == (0, 0)


def test_later_stream_events_on_top_of_a_rebuild_match_a_fresh_rebuild(rebuild, tables):
    """The safety argument: absolute rows plus the aggregator's later deltas stay correct."""
    _put_feedback(tables['feedback'], ITEMS)
    rebuild.run(tables['feedback'], tables['live'], apply=True)

    edited = {**ITEMS[0], 'category': 'pricing', 'sentiment_label': 'neutral', 'urgency': 'low'}
    arrival = _item(7, '2026-06-15', source_platform='feedback_form', category='support',
                    sentiment_label='positive', sentiment_score=Decimal('0.9'))
    _put_feedback(tables['feedback'], [edited, arrival])
    _aggregate(tables['live'], [_record('MODIFY', old=ITEMS[0], new=edited), _record('INSERT', new=arrival)])

    rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    live, fresh = _rows(tables['live']), _rows(tables['rebuilt'])
    # The aggregator never deletes the bucket an edit emptied; it leaves it at 0,
    # exactly as the rebuild would zero it on a table that had it.
    assert {k: v for k, v in live.items() if v.get('count') != 0} == fresh
    assert live[('METRIC#urgent', '2026-02-11')]['count'] == 0


def test_a_row_the_aggregator_wrote_during_the_rebuild_is_not_overwritten(rebuild, tables):
    _put_feedback(tables['feedback'], ITEMS)
    future = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    tables['rebuilt'].put_item(Item={'pk': 'METRIC#daily_total', 'sk': '2026-02-11', 'count': 4,
                                     'updated_at': future})

    plan = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)

    assert plan.conflicted == [('METRIC#daily_total', '2026-02-11')]
    row = tables['rebuilt'].get_item(Key={'pk': 'METRIC#daily_total', 'sk': '2026-02-11'})['Item']
    assert row['count'] == 4


def test_apply_refuses_while_feedback_may_still_be_in_the_stream(rebuild, tables):
    recent = _item(9, '2026-06-15', processed_at=datetime.now(UTC).isoformat())
    _put_feedback(tables['feedback'], [*ITEMS, recent])

    with pytest.raises(rebuild.RecentFeedbackError):
        rebuild.run(tables['feedback'], tables['rebuilt'], apply=True)
    assert tables['rebuilt'].scan()['Items'] == []

    dry = rebuild.run(tables['feedback'], tables['rebuilt'], apply=False)
    assert dry.recent_items == 1
    forced = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True, allow_recent=True)
    assert rebuild.daily_total_sum(forced) == len(ITEMS) + 1


def test_undated_items_are_reported_and_a_window_limits_the_dates(rebuild, tables):
    undated = {k: v for k, v in _item(8, '').items() if k != 'date'}
    _put_feedback(tables['feedback'], [*ITEMS, undated])

    plan = rebuild.run(tables['feedback'], tables['rebuilt'], apply=True, window=('2026-02-12', '2026-02-12'))

    assert plan.undated_items == 1
    assert plan.outside_window == 4
    assert plan.dates == {'2026-02-12'}
    assert {sk for _, sk in _rows(tables['rebuilt'])} == {'2026-02-12'}


def test_the_cli_dry_run_prints_a_per_dimension_summary(rebuild, tables, capsys, monkeypatch):
    _put_feedback(tables['feedback'], ITEMS)
    monkeypatch.setenv('AGGREGATES_TABLE', 'test-aggregates')

    code = rebuild.main(['--feedback-table', 'rb-feedback', '--aggregates-table', 'rb-rebuilt-aggregates',
                         '--region', 'us-east-1'])

    out = capsys.readouterr().out
    assert code == 0
    assert 'DRY RUN' in out
    assert 'sum of daily totals:           6 (MATCHES dated items)' in out
    assert 'METRIC#daily_category#*' in out
    assert tables['rebuilt'].scan()['Items'] == []
