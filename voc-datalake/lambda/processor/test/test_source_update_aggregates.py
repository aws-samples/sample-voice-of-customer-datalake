"""A re-enrichment's MODIFY moves the aggregates (processor write → aggregator read).

The in-place refresh of an edited issue (`shared/source_updates.py`) is the first
processor write that emits MODIFY. This feeds the real before/after images of one
— produced by `record_handler` against moto — to the aggregator's real
`record_handler` against a moto aggregates table, so the counters a category /
sentiment / urgency change has to move are asserted end to end.
"""
from decimal import Decimal
from unittest.mock import patch

from aggregator.test.aggregator_fixtures import stream_record
from processor.test.test_source_updates import CHANGED, deliver, insights, issue_message, stored, world
from shared.test.moto_tables import create_pk_sk_table


def _counts(table) -> dict:
    return {row['pk']: row.get('count') for row in table.scan()['Items']}


def _aggregate(before: dict, after: dict) -> tuple[dict, dict]:
    """Counters after the INSERT of ``before``, then after its MODIFY to ``after`` (inside mock_aws)."""
    import aggregator.handler as aggregator

    aggregates = create_pk_sk_table('test-aggregates-rebucket')
    with patch.object(aggregator, 'aggregates_table', aggregates), \
         patch.object(aggregator, 'IDEMPOTENCY_TABLE', ''), \
         patch.object(aggregator, 'lower_earliest_date', lambda _date: None):
        aggregator.record_handler(stream_record('INSERT', new=before))
        inserted = _counts(aggregates)
        aggregator.record_handler(stream_record('MODIFY', old=before, new=after))
        return inserted, _counts(aggregates)


def _refresh(answers: list[dict], **change) -> tuple[dict, dict, tuple[dict, dict]]:
    """The stored item before and after a newer copy of the issue arrives, and the counters it moved."""
    with world(answers) as (feedback, _):
        deliver(issue_message())
        before = stored(feedback)
        deliver(issue_message(CHANGED, **change))
        after = stored(feedback)
        return before, after, _aggregate(before, after)


def test_a_re_enriched_issue_moves_its_category_sentiment_and_urgency_counters():
    answers = [insights('product_quality', 0.6, 'low', 'positive'), insights('performance', -0.9, 'high')]
    _, after, (_, counts) = _refresh(answers, text='Chat freezes #7\n\nIt also takes 30 seconds to load.')

    assert after['category'] == 'performance'
    assert counts['METRIC#daily_total'] == Decimal(1)  # moved, not double-counted
    assert counts['METRIC#daily_category#product_quality'] == Decimal(0)
    assert counts['METRIC#daily_category#performance'] == Decimal(1)
    assert counts['METRIC#daily_sentiment#positive'] == Decimal(0)
    assert counts['METRIC#daily_sentiment#negative'] == Decimal(1)
    assert counts['METRIC#urgent'] == Decimal(1)  # low → high: the urgent counter gains the item
    assert counts['METRIC#category_sentiment#product_quality#positive'] == Decimal(0)
    assert counts['METRIC#category_sentiment#performance#negative'] == Decimal(1)


def test_an_attribute_only_refresh_moves_no_counter():
    _, after, (inserted, counts) = _refresh([insights()], labels=['regression'], state='closed')

    assert after['issue_attributes']['state'] == 'closed'
    assert counts == inserted
