"""Mutation hardening for `shared/feedback.py`.

`test_feedback.py` pins the shape of the sampling walk and the formatter by
membership (`'Review 1' in result`, `call_count < 30`), and the persona axis is
pinned only from the aggregator/metrics side. A mutation run found what that view
cannot see:

* the LITERALS other Lambdas spell alike: the date-basis values, the persona
  field, its archetypes, the `unknown` bucket and the `METRIC#persona#` prefix —
  a renamed value fails no test in this package, only a lockstep elsewhere.
* the exact BOUNDARIES of the windows: `days=1` is one day (not "all time"),
  90 dated days and 400 calendar days are the caps, the pool stops at its row
  cap.
* the exact BUDGET arithmetic: 200 000 tokens give 320 000 characters, not
  merely "more than a smaller window".
"""
import logging
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Key

from shared.channel_index import ChannelIndexUnavailable
from shared.feedback import (
    PERSONA_PREFIX,
    feedback_char_budget,
    feedback_item_limit,
    format_feedback_for_llm,
    get_feedback_context,
    get_feedback_statistics,
    has_legacy_persona_buckets,
    lookback_days,
    persona_bucket,
    query_feedback_by_date,
    sample_walk_days,
    truncate_feedback_context,
    validate_date_basis,
    window_cutoff,
)
from shared.feedback_sampling import POOL_FIELDS, Partition, read_pool
from shared.item_filters import parse_item_filters
from shared.logging import logger as powertools_logger
from shared.prompt_labels import PromptLabels
from shared.test.feedback_doubles import fetch_rows_as_read
from shared.time_budget import WalkBudget

ARCHETYPES = ('existing_customer', 'prospect', 'churn_risk', 'advocate', 'unknown')


@pytest.fixture(autouse=True)
def _pool_rows_are_full(monkeypatch):
    fetch_rows_as_read(monkeypatch)


def _pages(*pages: dict) -> MagicMock:
    """A table double answering successive queries with *pages* (exhaustible)."""
    table = MagicMock()
    table.query.side_effect = list(pages)
    return table


class TestDateBasisValues:
    @pytest.mark.parametrize(('value', 'expected'), [
        (None, 'imported'),
        (7, 'imported'),
        ('', 'imported'),
        ('bogus', 'imported'),
        ('imported', 'imported'),
        ('review', 'review'),
        (' Review ', 'review'),
    ])
    def test_every_value_resolves_to_a_known_basis(self, value, expected):
        assert validate_date_basis(value) == expected


class TestThePersonaAxisIsClosed:
    @pytest.mark.parametrize('archetype', ARCHETYPES)
    def test_each_archetype_is_its_own_bucket(self, archetype):
        assert persona_bucket({'persona_type': archetype}) == archetype
        assert has_legacy_persona_buckets([archetype]) is False

    @pytest.mark.parametrize('item', [
        {},
        {'persona_type': None},
        {'persona_type': ''},
        {'persona_type': 'loyal'},
        {'persona_name': 'advocate'},
    ])
    def test_anything_else_lands_in_unknown(self, item):
        assert persona_bucket(item) == 'unknown'

    @pytest.mark.parametrize(('buckets', 'expected'), [
        ([], False),
        (['advocate', 'unknown'], False),
        (['advocate', 'Unknown'], True),
        (['Jane Doe'], True),
    ])
    def test_a_bucket_outside_the_archetypes_is_legacy(self, buckets, expected):
        assert has_legacy_persona_buckets(buckets) is expected

    def test_the_counter_rows_prefix(self):
        assert PERSONA_PREFIX == 'METRIC#persona#'


class TestWindowBoundaries:
    @pytest.mark.parametrize(('days', 'expected'), [
        (-3, 90), (0, 90), (1, 1), (2, 2), (89, 89), (90, 90), (91, 90), (9999, 90),
    ])
    def test_lookback_days(self, days, expected):
        assert lookback_days(days) == expected

    @pytest.mark.parametrize(('days', 'expected'), [
        (-3, 400), (0, 400), (1, 1), (2, 2), (399, 399), (400, 400), (401, 400), (9999, 400),
    ])
    def test_sample_walk_days(self, days, expected):
        assert sample_walk_days(days) == expected


def _first_page(count: int) -> dict:
    return {'Items': [{'id': str(i)} for i in range(count)], 'LastEvaluatedKey': {'pk': 'next'}}


def _day_partitions(count: int) -> list[Partition]:
    return [Partition('gsi1-by-date', Key('gsi1pk').eq(f'DATE#{n}'), dated=True) for n in range(count)]


def _read(table: MagicMock, partitions: list[Partition], **kwargs):
    return read_pool(table, partitions, admit=lambda _row: True, budget=WalkBudget(), **kwargs)


class TestThePoolRowCap:
    def test_a_partition_stops_paging_at_the_cap(self):
        table = _pages(_first_page(10), {'Items': [{'id': 'beyond'}]})
        pool = _read(table, _day_partitions(3), max_rows=10)
        assert (len(pool.rows), pool.read, pool.capped, table.query.call_count) == (10, 10, True, 1)

    def test_a_partition_one_short_of_the_cap_keeps_paging(self):
        table = _pages(_first_page(9), {'Items': [{'id': 'a'}, {'id': 'b'}]})
        pool = _read(table, _day_partitions(1), max_rows=10)
        assert (len(pool.rows), pool.rows[-1], pool.capped, table.query.call_count) == (10, {'id': 'a'}, True, 2)

    def test_a_last_page_exactly_at_the_cap_is_complete_for_that_partition(self):
        table = _pages({'Items': [{'id': str(i)} for i in range(4)]}, {'Items': [{'id': 'next-day'}]})
        pool = _read(table, _day_partitions(2), max_rows=4)
        assert (pool.read, pool.capped, table.query.call_count) == (4, True, 1)

    def test_an_uncapped_walk_reads_every_partition(self):
        table = _pages(*[{'Items': [{'id': str(i)}]} for i in range(3)])
        pool = _read(table, _day_partitions(3), max_rows=10)
        assert (pool.read, pool.capped) == (3, False)

    def test_the_days_with_data_limit_ends_the_walk_uncapped(self):
        table = _pages({'Items': [{'id': '1'}]}, {'Items': []}, {'Items': [{'id': '2'}]}, {'Items': [{'id': '3'}]})
        pool = _read(table, _day_partitions(4), max_dated=2)
        assert ([r['id'] for r in pool.rows], pool.capped, table.query.call_count) == (['1', '2'], False, 3)

    def test_an_exhausted_budget_stops_at_a_page_boundary(self):
        table = _pages(_first_page(2), {'Items': [{'id': 'beyond'}]})
        pool = read_pool(table, _day_partitions(2), admit=lambda _row: True, budget=WalkBudget(seconds=-1))
        assert (pool.read, pool.capped, table.query.call_count) == (2, True, 1)

    def test_stop_after_ends_the_read_at_the_first_admitted_rows(self):
        table = _pages({'Items': [{'id': 'x'}]}, {'Items': [{'id': '1'}]}, {'Items': [{'id': '2'}]})
        pool = read_pool(table, _day_partitions(3), admit=lambda row: row['id'] != 'x',
                         budget=WalkBudget(), stop_after=1)
        assert ([r['id'] for r in pool.rows], table.query.call_count) == (['1'], 2)

    def test_every_query_is_projected_to_the_pool_fields(self):
        table = _pages({'Items': []})
        _read(table, _day_partitions(1))
        kwargs = table.query.call_args.kwargs
        assert kwargs['ProjectionExpression'].split(', ') == list(kwargs['ExpressionAttributeNames'])
        assert tuple(kwargs['ExpressionAttributeNames'].values()) == POOL_FIELDS


class TestCharBudgetArithmetic:
    @pytest.mark.parametrize(('window', 'expected'), [
        (200_000, 320_000),
        (100_000, 120_000),
        (40_001, 0),
        (40_002, 4),
        (40_000, 0),
        (0, 0),
    ])
    def test_budget_for_a_window(self, window, expected):
        assert feedback_char_budget(window_tokens=window) == expected

    def test_the_defaults(self):
        assert feedback_char_budget() == 320_000

    def test_the_default_window_is_200000_tokens(self):
        assert feedback_char_budget(overhead_tokens=0, utilisation=1.0) == 800_000

    def test_a_window_below_the_overhead_has_nothing_usable(self):
        assert feedback_char_budget(window_tokens=0, utilisation=1.0) == 0

    @pytest.mark.parametrize(('budget', 'expected'), [
        (0, 1), (2_199, 1), (2_200, 1), (4_399, 1), (4_400, 2), (320_000, 145),
    ])
    def test_item_limit_is_the_budget_over_2200_chars(self, budget, expected):
        assert feedback_item_limit(budget) == expected


ITEM = {
    'source_platform': 'web',
    'source_created_at': '2025-03-04T10:00:00Z',
    'sentiment_label': 'negative',
    'sentiment_score': -0.5,
    'category': 'delivery',
    'rating': 2,
    'urgency': 'high',
    'persona_type': 'advocate',
    'journey_stage': 'usage',
    'original_text': 'Late again',
}


def _record(original_text: str = 'Late again', tail: str = '\n\n\n') -> str:
    return (
        # Sources and categories by their labels (never the ids: shared/prompt_labels.py).
        '\n### Review 1\n- Source: Web\n- Date: 2025-03-04\n'
        '- Sentiment: negative (score: -0.50)\n- Category: Delivery\n- Rating: 2/5\n'
        '- Urgency: high\n- Customer Type: advocate\n- Journey Stage: usage\n'
        f'- Full Text: "{original_text}"\n{tail}'
    )


class TestPerFieldCaps:
    @pytest.mark.parametrize(('length', 'kept'), [(600, 600), (601, 600)])
    def test_original_text_keeps_600_characters(self, length, kept):
        out = format_feedback_for_llm([{**ITEM, 'original_text': 'a' * length}])
        assert out == _record('a' * kept)

    @pytest.mark.parametrize(('length', 'shown'), [
        (400, 's' * 400),
        (401, 's' * 400 + '…'),
    ])
    def test_an_enrichment_field_keeps_400_characters(self, length, shown):
        out = format_feedback_for_llm([{**ITEM, 'problem_summary': 's' * length}])
        assert out == _record(tail=f'\n- Problem Summary: {shown}\n\n')

    @pytest.mark.parametrize(('length', 'shown'), [
        (60, 'C' + 'c' * 59),
        (61, 'C' + 'c' * 59 + '…'),
    ])
    def test_a_label_keeps_60_characters(self, length, shown):
        out = format_feedback_for_llm([{**ITEM, 'category': 'c' * length}])
        assert f'\n- Category: {shown}\n' in out

    def test_a_stored_null_enrichment_field_is_omitted(self):
        out = format_feedback_for_llm([{**ITEM, 'direct_customer_quote': None}])
        assert out == _record()


TRUNCATED = '\n\n[... additional feedback truncated ...]'


class TestTruncationBoundaries:
    def test_a_context_exactly_at_the_budget_is_untouched(self):
        context = format_feedback_for_llm([ITEM, ITEM])
        assert truncate_feedback_context(context, len(context)) == (context, 2, False)

    def test_a_one_character_budget_still_truncates(self):
        context = format_feedback_for_llm([ITEM])
        assert truncate_feedback_context(context, 1) == ('\n' + TRUNCATED, 0, True)

    def test_a_single_partial_record_is_kept_rather_than_emptied(self):
        context = format_feedback_for_llm([ITEM, ITEM])
        assert truncate_feedback_context(context, 100) == (context[:100] + TRUNCATED, 1, True)

    def test_a_boundary_at_offset_one_is_cut_on(self):
        context = 'x\n### Review 1 aaaa\n### Review 2 bbbb'
        assert truncate_feedback_context(context, 15) == ('x' + TRUNCATED, 0, True)


def _assert_newest_first(table: MagicMock, index: str, key: str, value: str) -> None:
    kwargs = table.query.call_args.kwargs
    expression = kwargs['KeyConditionExpression'].get_expression()
    assert kwargs['IndexName'] == index
    assert kwargs['ScanIndexForward'] is False
    assert expression['values'][0].name == key
    assert expression['values'][1] == value


class TestTheQueriesTheWalkSends:
    def test_a_date_partition_is_read_newest_first_on_gsi1pk(self):
        table = _pages({'Items': [{'id': '1'}]})
        query_feedback_by_date(table, days=1)
        _assert_newest_first(table, 'gsi1-by-date', 'gsi1pk', f'DATE#{window_cutoff(1)}')

    def test_a_category_partition_is_read_newest_first_on_gsi2pk(self):
        table = _pages({'Items': []})
        query_feedback_by_date(table, days=1, categories=['delivery'])
        _assert_newest_first(table, 'gsi2-by-category', 'gsi2pk', 'CATEGORY#delivery')

    @pytest.mark.parametrize('categories', [[], ['delivery']])
    def test_a_channel_reads_its_index_from_the_window_cutoff(self, categories):
        table = _pages({'Items': [{'id': '1', 'source_channel': 'google_play', 'category': 'delivery', 'date': window_cutoff(1)}]})
        items = query_feedback_by_date(table, days=1, categories=categories,
                                       item_filters=parse_item_filters({'channel': 'google_play'}))
        kwargs = table.query.call_args.kwargs
        key = kwargs['KeyConditionExpression'].get_expression()
        assert kwargs['IndexName'] == 'gsi5-by-channel'
        assert [part.get_expression()['values'][1] for part in key['values']] == ['google_play', window_cutoff(1)]
        assert [item['id'] for item in items] == ['1']

    # Regression (customer import, 5.23.04): the channel was matched only in memory after the
    # capped page walk, so a small channel deep in a big day partition came back empty. Without
    # the index (mid-upgrade) the day walk still pushes it down.
    @pytest.mark.parametrize('categories', [[], ['delivery']])
    def test_without_the_index_the_channel_rides_in_the_filter_expression(self, categories, monkeypatch):
        def missing(*_args, **_kwargs):
            raise ChannelIndexUnavailable('no gsi5')

        monkeypatch.setattr('shared.feedback_sampling.walk_channel', missing)
        table = _pages({'Items': [{'id': '1', 'source_channel': 'google_play', 'category': 'delivery', 'date': window_cutoff(1)}]})
        items = query_feedback_by_date(table, days=1, categories=categories,
                                       item_filters=parse_item_filters({'channel': 'google_play'}))
        expression = table.query.call_args.kwargs['FilterExpression'].get_expression()
        assert (expression['values'][0].name, expression['values'][1]) == ('source_channel', 'google_play')
        assert [item['id'] for item in items] == ['1']

    def test_no_channel_sends_no_filter_expression(self):
        table = _pages({'Items': []})
        query_feedback_by_date(table, days=1, item_filters=parse_item_filters({'tag': 'vip'}))
        assert 'FilterExpression' not in table.query.call_args.kwargs

    def test_a_small_limit_still_reads_the_whole_window(self):
        """The old walk stopped at 3 x limit raw rows, so the sample was the newest rows only."""
        table = _pages(
            {'Items': [{'id': '1'}, {'id': '2'}], 'LastEvaluatedKey': {'pk': 'p2'}},
            {'Items': [{'id': '3'}, {'id': '4'}]},
            *[{'Items': [{'id': f'old{n}'}]} for n in range(6)],
        )
        # 10 rows read; the spread order takes positions 0 and 8 (`spread_order(10)` = 0, 8, 4, ...).
        assert query_feedback_by_date(table, days=7, limit=2) == [{'id': '1'}, {'id': 'old4'}]
        assert table.query.call_count == 8


class TestTheWindowEdgeIsInclusive:
    def test_a_category_item_dated_on_the_cutoff_is_kept(self):
        edge = {'id': 'edge', 'category': 'delivery', 'date': window_cutoff(7)}
        table = _pages({'Items': [edge, {'id': 'undated', 'category': 'delivery'}]})
        assert query_feedback_by_date(table, days=7, categories=['delivery']) == [edge]

    def test_a_review_written_on_the_cutoff_is_kept(self):
        edge = {'id': 'edge', 'date': window_cutoff(1), 'source_created_at': window_cutoff(1)}
        table = _pages({'Items': [edge]})
        assert query_feedback_by_date(table, days=1, date_basis='review') == [edge]


class TestQueryDefaults:
    def test_the_default_window_is_30_days(self):
        table = _pages(*[{'Items': []} for _ in range(30)])
        assert query_feedback_by_date(table) == []
        assert table.query.call_count == 30

    def test_the_default_limit_is_500(self):
        table = _pages({'Items': [{'id': str(i)} for i in range(1500)]})
        assert len(query_feedback_by_date(table, days=1)) == 500


class TestContextDefaults:
    def test_no_table_is_logged_and_answers_empty(self, caplog):
        with caplog.at_level(logging.INFO):
            assert query_feedback_by_date(None) == []
        assert [r.getMessage() for r in caplog.records] == [
            'No feedback table provided, returning empty list']

    def test_the_default_context_is_50_items(self):
        table = _pages({'Items': [{'id': str(i)} for i in range(60)]}, *[{'Items': []} for _ in range(29)])
        assert len(get_feedback_context(table, {'days': 1})) == 50

    def test_the_default_context_window_is_30_days(self):
        table = _pages(*[{'Items': [{'id': str(i)}]} for i in range(30)])
        assert len(get_feedback_context(table, {})) == 30
        assert table.query.call_count == 30


BARE_RECORD = (
    '\n### Review {n}\n- Source: Unknown\n- Date: N/A\n- Sentiment: unknown (score: 0.00)\n'
    '- Category: Other\n- Rating: N/A/5\n- Urgency: low\n- Customer Type: unknown\n'
    '- Journey Stage: unknown\n- Full Text: ""\n\n\n\n'
)


class TestTheRecordFormat:
    def test_every_missing_field_has_its_placeholder(self):
        assert format_feedback_for_llm([{}]) == BARE_RECORD.format(n=1)

    def test_records_are_joined_by_one_newline(self):
        assert format_feedback_for_llm([{}, {}]) == (
            BARE_RECORD.format(n=1) + '\n' + BARE_RECORD.format(n=2))

    def test_the_quote_and_root_cause_lines(self):
        out = format_feedback_for_llm([
            {**ITEM, 'direct_customer_quote': 'q', 'problem_root_cause_hypothesis': 'r'}])
        assert out == _record(tail='- Key Quote: "q"\n\n- Root Cause Hypothesis: r\n')


class TestTheClipReport:
    def test_the_report_names_every_cap_and_counts_per_field(self, caplog):
        items = [
            {**ITEM, 'original_text': 'o' * 601, 'persona_type': 'p' * 61},
            {**ITEM, 'original_text': 'o' * 601, 'journey_stage': 'j' * 61},
        ]
        with caplog.at_level(logging.INFO):
            format_feedback_for_llm(items)
        [record] = caplog.records
        # The shared Powertools logger: the runtime's stdlib root sits at WARNING, so an
        # INFO record on this module's own logger would never reach CloudWatch.
        assert (record.name, record.levelname) == (powertools_logger.name, 'INFO')
        assert record.getMessage() == ('[FEEDBACK] Per-field caps clipped text out of the LLM context '
                                       '(journey_stage=1, original_text=2, persona_type=1; 2 items)')
        assert {key: getattr(record, key) for key in (
            'items', 'clipped_fields', 'enrichment_cap', 'original_text_cap', 'label_cap')} == {
            'items': 2,
            'clipped_fields': {'persona_type': 1, 'original_text': 2, 'journey_stage': 1},
            'enrichment_cap': 400,
            'original_text_cap': 600,
            'label_cap': 60,
        }


class TestTheStatisticsBlock:
    def test_no_items(self):
        assert get_feedback_statistics([]) == 'No feedback data available.'

    def test_the_whole_block_is_ordered_by_count_and_keeps_the_top_five_categories(self):
        items = [
            {'sentiment_label': 'negative', 'source_platform': 'web', 'urgency': 'high', 'rating': 5},
            {'sentiment_label': 'negative', 'source_platform': 'web', 'urgency': 'high', 'rating': 4},
            {'sentiment_label': 'negative', 'category': 'a', 'source_platform': 'web', 'urgency': 'high'},
            {'sentiment_label': 'negative', 'category': 'b', 'source_platform': 'web', 'urgency': 'medium'},
            {'sentiment_label': 'positive', 'category': 'c', 'source_platform': 'app', 'urgency': 'medium'},
            {'sentiment_label': 'positive', 'category': 'd', 'source_platform': 'app'},
            {'category': 'e'},
        ]
        assert get_feedback_statistics(items) == (
            '## Feedback Statistics (n=7)\n\n'
            '**Sentiment Distribution:**\n'
            '- negative: 4 (57.1%)\n- positive: 2 (28.6%)\n- unknown: 1 (14.3%)\n\n'
            '**Top Categories:**\n'
            '- Other: 2\n- A: 1\n- B: 1\n- C: 1\n- D: 1\n\n'
            '**Sources:**\n'
            '- Web: 4\n- App: 2\n- Unknown: 1\n\n'
            '**Urgency Levels:**\n'
            '- High: 3 | Medium: 2 | Low: 2\n\n'
            '**Average Rating:** 4.5/5 (from 2 rated reviews)\n'
        )


class TestLabelsNotIds:
    """Generated text repeats its prompt: categories and sources reach the model as labels."""

    LABELS = PromptLabels(
        categories=({'name': 'software_firmware', 'description': 'Software & Firmware'},),
        profiles=({'id': 'web_trustpilot_acme', 'label': 'ACME Airlines'},))

    def test_a_record_names_the_configured_labels(self):
        out = format_feedback_for_llm(
            [{**ITEM, 'category': 'software_firmware', 'source_platform': 'web_trustpilot_acme'}], self.LABELS)
        assert ('- Source: ACME Airlines\n' in out, '- Category: Software & Firmware\n' in out,
                'software_firmware' in out, 'web_trustpilot_acme' in out) == (True, True, False, False)

    def test_without_a_config_the_ids_are_humanised(self):
        out = format_feedback_for_llm([{**ITEM, 'category': 'ease_of_use', 'source_platform': 'Example Air - iOS_ios'}])
        assert ('- Source: Example Air (iOS)\n' in out, '- Category: Ease of use\n' in out) == (True, True)

    def test_the_statistics_name_labels(self):
        out = get_feedback_statistics(
            [{'category': 'software_firmware', 'source_platform': 'web_trustpilot_acme'}], self.LABELS)
        assert ('- Software & Firmware: 1' in out, '- ACME Airlines: 1' in out, 'software_firmware' in out) == (
            True, True, False)
