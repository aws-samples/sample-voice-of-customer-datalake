"""The LLM-context read samples the WHOLE window evenly (shared/feedback_sampling.py).

Regression (a customer deployment): one CSV import put 25,229 reviews on one day,
and every persona was built from that day alone whatever window the user chose,
because the read walked the days newest first and stopped at ``3 x limit`` rows.
These tests run on moto with the real index shapes: a huge newest day plus older
days, and the sample must cover every day in proportion, with the filters and the
caller's category scope still applied.
"""
from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import boto3
import pytest
from moto import mock_aws

from shared.category_access import CategoryScope, scope_to_config
from shared.channel_index import CHANNEL_INDEX_FIELDS
from shared.feedback import feedback_context_exists, get_feedback_context, query_feedback_by_date
from shared.feedback_sampling import (
    MAX_INPUT_FEEDBACK_IDS,
    SampleFetchFailed,
    fetch_full,
    input_feedback_fields,
    input_feedback_ids,
    received_input_feedback_ids,
    sample_evenly,
    spread_order,
)

BIG_DAY = 1_500     # the bulk import, today
SMALL_DAY = 50      # each of the six older days
OLDER_DAYS = 6
LIMIT = 120


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(n: int, offset: int) -> dict:
    day = _day(offset)
    category = 'delivery' if n % 2 else 'billing'
    sentiment = 'negative' if n % 3 == 0 else 'positive'
    return {
        'pk': 'SOURCE#web' if n % 4 else 'SOURCE#app_store', 'sk': f'FEEDBACK#r{offset}-{n:05d}',
        'feedback_id': f'r{offset}-{n:05d}', 'date': day, 'source_created_at': f'{day}T09:00:00Z',
        'source_platform': 'web' if n % 4 else 'app_store', 'source_channel': 'email' if n % 5 == 0 else 'chat',
        'category': category, 'sentiment_label': sentiment, 'rating': Decimal(n % 5 + 1),
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T09:{n % 60:02d}:00+00:00#r{n}',
        'gsi2pk': f'CATEGORY#{category}', 'gsi2sk': f'-0.5#{day}#{n:05d}',
        'original_text': f'Full review text {offset}-{n}',
    }


_INDEXES = (  # (name, hash key, range key, INCLUDE fields or None for ALL), as in core-stack.ts
    ('gsi1-by-date', 'gsi1pk', 'gsi1sk', None),
    ('gsi2-by-category', 'gsi2pk', 'gsi2sk', None),
    ('gsi5-by-channel', 'source_channel', 'gsi1sk', CHANNEL_INDEX_FIELDS),
)


def _key(hash_key: str, range_key: str) -> list:
    return [{'AttributeName': hash_key, 'KeyType': 'HASH'}, {'AttributeName': range_key, 'KeyType': 'RANGE'}]


def _projection(fields) -> dict:
    return {'ProjectionType': 'ALL'} if fields is None else {
        'ProjectionType': 'INCLUDE', 'NonKeyAttributes': list(fields)}


def _feedback_table():
    keys = sorted({'pk', 'sk', *(k for _, h, r, _ in _INDEXES for k in (h, r))})
    indexes: list[Any] = [
        {'IndexName': name, 'KeySchema': _key(h, r), 'Projection': _projection(fields)}
        for name, h, r, fields in _INDEXES
    ]
    return boto3.resource('dynamodb', region_name='us-east-1').create_table(
        TableName='feedback', BillingMode='PAY_PER_REQUEST', KeySchema=_key('pk', 'sk'),
        AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in keys],
        GlobalSecondaryIndexes=indexes,
    )


@pytest.fixture(scope='module')
def table():
    with mock_aws():
        feedback = _feedback_table()
        with feedback.batch_writer() as writer:
            for n in range(BIG_DAY):
                writer.put_item(Item=_review(n, 0))
            for offset in range(1, OLDER_DAYS + 1):
                for n in range(SMALL_DAY):
                    writer.put_item(Item=_review(n, offset))
        yield feedback


def _days(items: list[dict]) -> Counter:
    return Counter(item['date'] for item in items)


class TestTheSampleCoversTheWholeWindow:
    def test_every_day_is_sampled_in_proportion(self, table):
        items = query_feedback_by_date(table, days=7, limit=LIMIT)
        total = BIG_DAY + OLDER_DAYS * SMALL_DAY
        assert len(items) == LIMIT
        per_day = _days(items)
        # The old read stopped inside today (3 x limit rows), so it held ONE day.
        assert set(per_day) == {_day(offset) for offset in range(OLDER_DAYS + 1)}
        assert abs(per_day[_day(0)] - LIMIT * BIG_DAY / total) <= 1
        for offset in range(1, OLDER_DAYS + 1):
            assert abs(per_day[_day(offset)] - LIMIT * SMALL_DAY / total) <= 1

    def test_every_prefix_of_the_sample_covers_the_window(self, table):
        """Regression (live, 5.25.00 pre-release): 872 reviews were sampled over 7 days, the model
        read the first 500 and all 500 were from today, because the sample was in date order and the
        token budget trims its tail. Any prefix must be an even sample of the whole window."""
        items = get_feedback_context(table, {'days': 7}, limit=LIMIT)
        # Half the sample still holds every day (each small day expects ~1.7 of the 60).
        assert len(_days(items[:LIMIT // 2])) == OLDER_DAYS + 1

    def test_the_sample_is_full_and_deterministic(self, table):
        items = get_feedback_context(table, {'days': 7}, limit=LIMIT)
        assert all(item['original_text'].startswith('Full review text') for item in items)
        assert len({item['feedback_id'] for item in items}) == LIMIT
        assert items == get_feedback_context(table, {'days': 7}, limit=LIMIT)

    def test_a_shorter_window_samples_only_its_days(self, table):
        assert set(_days(query_feedback_by_date(table, days=2, limit=LIMIT))) == {_day(0), _day(1)}


class TestFiltersAndScopeStillApply:
    def test_sources_and_sentiments(self, table):
        items = get_feedback_context(
            table, {'days': 7, 'sources': ['app_store'], 'sentiments': ['negative']}, limit=LIMIT)
        assert items
        assert {(i['source_platform'], i['sentiment_label']) for i in items} == {('app_store', 'negative')}
        assert len(_days(items)) == OLDER_DAYS + 1

    def test_a_restricted_category_scope_reads_only_its_categories(self, table):
        scope = scope_to_config(CategoryScope(all=False, categories=frozenset({'delivery'})))
        items = get_feedback_context(table, {'days': 7, 'category_scope': scope}, limit=LIMIT)
        assert len(items) == LIMIT
        assert {i['category'] for i in items} == {'delivery'}
        assert len(_days(items)) == OLDER_DAYS + 1

    def test_a_denied_source_never_reaches_the_sample(self, table):
        scope = scope_to_config(CategoryScope(all=True, source_deny=frozenset({'app_store'})))
        items = get_feedback_context(table, {'days': 7, 'category_scope': scope}, limit=LIMIT)
        assert items
        assert {i['source_platform'] for i in items} == {'web'}

    def test_a_channel_reads_through_its_index_across_the_window(self, table):
        items = get_feedback_context(table, {'days': 7, 'channel': 'email'}, limit=LIMIT)
        assert items
        assert {i['source_channel'] for i in items} == {'email'}
        assert len(_days(items)) == OLDER_DAYS + 1
        assert all('original_text' in i for i in items)

    def test_dims_tag_and_review_basis_filter_in_memory(self, table):
        assert get_feedback_context(table, {'days': 7, 'tag': 'vip'}, limit=LIMIT) == []
        items = get_feedback_context(table, {'days': 3, 'date_basis': 'review'}, limit=LIMIT)
        assert set(_days(items)) == {_day(0), _day(1), _day(2)}


def _finish_reads_regardless_of_load(monkeypatch) -> None:
    """An unfinished probe answers 'may match' (True): lift the wall-clock budget so a slow, loaded
    machine cannot turn a finished-read assertion into a budget assertion (it flaked in the release gate)."""
    monkeypatch.setattr('shared.feedback.PROBE_BUDGET_SECONDS', 600)


class TestTheExistenceProbe:
    def test_it_answers_without_reading_the_whole_window(self, table, monkeypatch):
        _finish_reads_regardless_of_load(monkeypatch)
        assert feedback_context_exists(table, {'days': 7}) is True
        assert feedback_context_exists(table, {'days': 7, 'tag': 'vip'}) is False

    def test_an_emptied_scope_matches_nothing(self, table):
        scope = scope_to_config(CategoryScope(all=False, categories=frozenset({'delivery'})))
        assert feedback_context_exists(table, {'days': 7, 'categories': ['billing'], 'category_scope': scope}) is False


class TestSampleEvenly:
    @pytest.mark.parametrize(('count', 'size', 'expected'), [
        (10, 5, [0, 2, 4, 6, 8]),
        (3, 5, [0, 1, 2]),
        (7, 0, []),
        (5, 5, [0, 1, 2, 3, 4]),
    ])
    def test_strides_across_the_rows(self, count, size, expected):
        picked = sample_evenly([{'n': n} for n in range(count)], size)
        assert sorted(row['n'] for row in picked) == expected

    def test_the_picked_rows_come_in_spread_order(self):
        assert [row['n'] for row in sample_evenly([{'n': n} for n in range(8)], 8)] == [0, 4, 2, 6, 1, 5, 3, 7]

    @pytest.mark.parametrize(('count', 'small', 'large'), [(872, 100, 500), (50_000, 145, 872), (7, 3, 20)])
    def test_a_smaller_sample_is_the_head_of_a_larger_one(self, count, small, large):
        rows = [{'n': n} for n in range(count)]
        assert sample_evenly(rows, small) == sample_evenly(rows, large)[:small]


class TestPagesTileOneSample:
    """query_feedback_by_date(offset, limit): pages are disjoint slices of ONE even sample."""

    def test_consecutive_pages_never_overlap_or_skip(self, table):
        pages = [query_feedback_by_date(table, days=7, limit=40, offset=offset) for offset in (0, 40, 80)]
        ids = [[item['feedback_id'] for item in page] for page in pages]
        assert [len(page) for page in ids] == [40, 40, 40]
        assert len({fid for page in ids for fid in page}) == 120
        assert [fid for page in ids for fid in page] == [
            item['feedback_id'] for item in query_feedback_by_date(table, days=7, limit=120)]

    def test_every_page_spans_the_window(self, table):
        for offset in (0, 60):
            assert len(_days(query_feedback_by_date(table, days=7, limit=60, offset=offset))) == OLDER_DAYS + 1


class TestSpreadOrder:
    @pytest.mark.parametrize('count', [0, 1, 2, 3, 5, 8, 13, 100, 872])
    def test_is_a_permutation(self, count):
        assert sorted(spread_order(count)) == list(range(count))

    @pytest.mark.parametrize(('count', 'prefix'), [(872, 500), (872, 100), (100, 10), (13, 4)])
    def test_every_prefix_reaches_both_ends_and_every_quarter(self, count, prefix):
        head = spread_order(count)[:prefix]
        quarters = {position * 4 // count for position in head}
        assert quarters == {0, 1, 2, 3}


class TestInputFeedbackIds:
    def test_the_first_used_items_in_prompt_order(self):
        items = [{'feedback_id': 'b'}, {'feedback_id': 'a'}, {'feedback_id': 'c'}]
        assert input_feedback_ids(items, 2) == ['b', 'a']
        assert input_feedback_ids(items) == ['b', 'a', 'c']
        assert input_feedback_ids(items, -1) == []

    def test_items_without_an_id_are_skipped_and_the_list_is_capped(self):
        items = [{}, {'feedback_id': ''}, {'feedback_id': 7}] + [{'feedback_id': f'f{n}'} for n in range(600)]
        ids = input_feedback_ids(items)
        assert len(ids) == MAX_INPUT_FEEDBACK_IDS == 500
        assert ids[0] == 'f0'


class TestFetchFull:
    def test_no_keys_reads_nothing(self):
        stub = MagicMock()
        assert fetch_full(stub, [{'feedback_id': 'x'}]) == []
        stub.meta.client.batch_get_item.assert_not_called()

    def test_vanished_rows_are_dropped_and_order_is_kept(self, table):
        rows = [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r1-00002'}, {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#gone'},
                {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#r0-00001'}]
        assert [i['feedback_id'] for i in fetch_full(table, rows)] == ['r1-00002', 'r0-00001']

    def test_keys_left_unprocessed_fail_closed(self, monkeypatch):
        monkeypatch.setattr('shared.batch_get.time.sleep', lambda _seconds: None)
        stub = MagicMock()
        stub.name = 'feedback'
        stub.meta.client.batch_get_item.return_value = {
            'Responses': {}, 'UnprocessedKeys': {'feedback': {'Keys': [{'pk': 'a', 'sk': 'b'}]}}}
        with pytest.raises(SampleFetchFailed):
            fetch_full(stub, [{'pk': 'a', 'sk': 'b'}])


class TestTheProbeIsBounded:
    """`feedback_context_exists` runs on a synchronous REST call: bounded, and 'unfinished' means 'may match'."""

    def test_a_read_it_could_not_finish_lets_the_job_decide(self, table, monkeypatch):
        monkeypatch.setattr('shared.feedback.PROBE_MAX_ROWS', 10)
        # Nothing in the window carries this tag, so only an unfinished read can answer True.
        assert feedback_context_exists(table, {'days': 7, 'tag': 'vip'}) is True

    def test_a_finished_read_with_no_match_is_no(self, table, monkeypatch):
        _finish_reads_regardless_of_load(monkeypatch)
        assert feedback_context_exists(table, {'days': 7, 'tag': 'vip'}) is False


class TestTheSampleIsRecheckedOnTheFullItems:
    def test_a_review_recategorised_between_the_reads_is_dropped(self, table, monkeypatch):
        """Pool rows are admitted on the projected read; the full item must still match."""
        import shared.feedback as feedback

        real = feedback.fetch_full

        def moved(tbl, rows):
            items = real(tbl, rows)
            return [{**item, 'category': 'billing'} if i == 0 else item for i, item in enumerate(items)]

        monkeypatch.setattr(feedback, 'fetch_full', moved)
        items = get_feedback_context(table, {'days': 7, 'categories': ['delivery']}, limit=20)
        assert items
        assert {i['category'] for i in items} == {'delivery'}
        assert len(items) == 19


class TestInputFeedbackFields:
    def test_the_field_holds_the_ids_capped(self):
        assert input_feedback_fields(['a', 'b']) == {'input_feedback_ids': ['a', 'b']}
        assert len(input_feedback_fields([f'f{n}' for n in range(600)])['input_feedback_ids']) == 500

    def test_no_ids_is_no_field(self):
        assert input_feedback_fields([]) == {}


class TestReceivedInputFeedbackIds:
    def test_a_list_of_ids_is_kept_capped(self):
        assert received_input_feedback_ids(['b', 'a']) == ['b', 'a']
        assert len(received_input_feedback_ids([f'f{n}' for n in range(600)]) or []) == 500

    @pytest.mark.parametrize('value', [None, 'a', ['a', 3], ['a', ''], {'a': 1}])
    def test_anything_else_reads_as_not_reported(self, value):
        assert received_input_feedback_ids(value) is None
