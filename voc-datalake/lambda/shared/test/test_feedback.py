"""
Tests for shared/feedback.py - Feedback utilities for LLM context building.
"""

from datetime import UTC
from unittest.mock import MagicMock


def _table_returning(items: list[dict]) -> MagicMock:
    """A table double answering every query with *items*."""
    mock_table = MagicMock()
    mock_table.query.return_value = {'Items': items}
    return mock_table


def _table_scanning(*day_pages: list[dict], empty_days: int) -> MagicMock:
    """A table double answering successive per-day queries with *day_pages*,
    then *empty_days* empty pages (one per remaining day of the lookback)."""
    mock_table = MagicMock()
    mock_table.query.side_effect = (
        [{'Items': page} for page in day_pages]
        + [{'Items': []} for _ in range(empty_days)]
    )
    return mock_table


def _numbered_items(count: int) -> list[dict]:
    return [{'feedback_id': str(i)} for i in range(count)]


class TestGetFeedbackContext:
    """Tests for get_feedback_context function."""

    def test_returns_empty_list_when_table_none(self):
        """Returns empty list when feedback_table is None."""
        from shared.feedback import get_feedback_context

        result = get_feedback_context(None, {'days': 7})

        assert result == []

    def test_queries_by_date_when_no_category_filter(self):
        """Queries by date index when no categories specified."""
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()
        # Return items only on first query, empty on subsequent
        mock_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper'},
                {'feedback_id': '2', 'source_platform': 'manual_import'}
            ]},
        ] + [{'Items': []} for _ in range(30)]  # Empty for remaining days

        result = get_feedback_context(mock_table, {'days': 7}, limit=10)

        assert len(result) == 2
        # Should query by date index
        call_args = mock_table.query.call_args_list[0]
        assert call_args.kwargs['IndexName'] == 'gsi1-by-date'

    def test_queries_by_category_when_categories_specified(self):
        """Queries by category index when categories specified without sources."""
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [
            {'feedback_id': '1', 'category': 'delivery'}
        ]}

        get_feedback_context(
            mock_table,
            {'categories': ['delivery', 'support']},
            limit=10
        )

        # Should query by category index
        call_args = mock_table.query.call_args
        assert call_args.kwargs['IndexName'] == 'gsi2-by-category'

    def test_filters_by_source_platform(self):
        """Filters results by source_platform."""
        from shared.feedback import get_feedback_context

        mock_table = _table_scanning([
            {'feedback_id': '1', 'source_platform': 'webscraper'},
            {'feedback_id': '2', 'source_platform': 'manual_import'},
            {'feedback_id': '3', 'source_platform': 'webscraper'}
        ], empty_days=30)

        result = get_feedback_context(
            mock_table,
            {'days': 7, 'sources': ['webscraper']},
            limit=10
        )

        assert len(result) == 2
        assert all(item['source_platform'] == 'webscraper' for item in result)

    def test_filters_by_sentiment(self):
        """Filters results by sentiment_label."""
        from shared.feedback import get_feedback_context

        mock_table = _table_scanning([
            {'feedback_id': '1', 'sentiment_label': 'positive'},
            {'feedback_id': '2', 'sentiment_label': 'negative'},
            {'feedback_id': '3', 'sentiment_label': 'positive'}
        ], empty_days=30)

        result = get_feedback_context(
            mock_table,
            {'days': 7, 'sentiments': ['positive']},
            limit=10
        )

        assert len(result) == 2
        assert all(item['sentiment_label'] == 'positive' for item in result)

    def test_respects_limit(self):
        """Respects the limit parameter."""
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [
            {'feedback_id': str(i)} for i in range(100)
        ]}

        result = get_feedback_context(mock_table, {'days': 7}, limit=5)

        assert len(result) == 5

    def test_combines_multiple_filters(self):
        """Combines source, sentiment, and category filters."""
        from shared.feedback import get_feedback_context

        mock_table = _table_scanning([
            {'feedback_id': '1', 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'delivery'},
            {'feedback_id': '2', 'source_platform': 'manual_import', 'sentiment_label': 'positive', 'category': 'delivery'},
            {'feedback_id': '3', 'source_platform': 'webscraper', 'sentiment_label': 'negative', 'category': 'delivery'},
            {'feedback_id': '4', 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'support'},
        ], empty_days=30)

        result = get_feedback_context(
            mock_table,
            {
                'days': 7,
                'sources': ['webscraper'],
                'sentiments': ['positive'],
                'categories': ['delivery']
            },
            limit=10
        )

        assert len(result) == 1
        assert result[0]['feedback_id'] == '1'


class TestFormatFeedbackForLlm:
    """Tests for format_feedback_for_llm function."""

    def test_returns_empty_string_for_empty_list(self):
        """Returns empty string for empty items list."""
        from shared.feedback import format_feedback_for_llm

        result = format_feedback_for_llm([])

        assert result == ''


class TestGetFeedbackStatistics:
    """Tests for get_feedback_statistics function."""

    def test_handles_items_without_ratings(self):
        """Handles items without ratings gracefully."""
        from shared.feedback import get_feedback_statistics

        items = [
            {'sentiment_label': 'positive'},
            {'sentiment_label': 'negative'},
        ]

        result = get_feedback_statistics(items)

        # Should show 0.0 average with 0 rated reviews
        assert '0.0/5' in result
        assert 'from 0 rated reviews' in result

class TestGetFeedbackContextEdgeCases:
    """Edge case tests for get_feedback_context function."""

    def test_does_not_break_early_when_source_filter_active(self):
        """Regression: early break must not skip dates when source filtering is active.

        When recent dates have many items from *other* sources, the loop
        must keep scanning older dates so that the target source's items
        (which may only exist on older dates) are not missed.
        """
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()

        # Day 0-2: 200 items each from "other_source" (total 600, well above limit*3=150)
        other_items = [{'feedback_id': f'other_{i}', 'source_platform': 'other_source'} for i in range(200)]
        # Day 10: 50 items from the target source
        target_items = [{'feedback_id': f'target_{i}', 'source_platform': 'target_source'} for i in range(50)]

        # Build side_effect list: 30 days of responses
        responses = [{'Items': []} for _ in range(30)]
        responses[0] = {'Items': list(other_items)}  # day 0
        responses[1] = {'Items': list(other_items)}  # day 1
        responses[2] = {'Items': list(other_items)}  # day 2
        responses[10] = {'Items': list(target_items)}  # day 10

        mock_table.query.side_effect = responses

        result = get_feedback_context(
            mock_table,
            {'days': 30, 'sources': ['target_source']},
            limit=50
        )

        # Must find the target source items despite early dates having 600+ other items
        assert len(result) == 50
        assert all(item['source_platform'] == 'target_source' for item in result)
        # Must have queried past day 2 (where the early break would have triggered before the fix)
        assert mock_table.query.call_count >= 11

    def test_does_not_break_early_when_sentiment_filter_active(self):
        """Early break must not skip dates when sentiment filtering is active."""
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()

        # Day 0: 200 negative items (exceeds limit*3=150)
        negative_items = [{'feedback_id': f'neg_{i}', 'sentiment_label': 'negative'} for i in range(200)]
        # Day 5: 10 positive items
        positive_items = [{'feedback_id': f'pos_{i}', 'sentiment_label': 'positive'} for i in range(10)]

        def query_side_effect(**_kwargs):
            call_num = mock_table.query.call_count
            if call_num == 1:
                return {'Items': list(negative_items)}
            if call_num == 6:  # day 5
                return {'Items': list(positive_items)}
            return {'Items': []}

        mock_table.query.side_effect = query_side_effect

        result = get_feedback_context(
            mock_table,
            {'days': 30, 'sentiments': ['positive']},
            limit=50
        )

        assert len(result) == 10
        assert all(item['sentiment_label'] == 'positive' for item in result)

    def test_still_breaks_early_when_no_filters(self):
        """Early break optimization still works when no source/sentiment filters are active."""
        from shared.feedback import get_feedback_context

        # Return 200 items on every query
        mock_table = _table_returning(_numbered_items(200))

        result = get_feedback_context(mock_table, {'days': 30}, limit=10)

        assert len(result) == 10
        # Should break early — not query all 30 days
        assert mock_table.query.call_count < 30


class TestQueryFeedbackByDate:
    """Tests for query_feedback_by_date — the shared low-level query function."""

    def test_single_source_filter_as_list(self):
        """Accepts a single source wrapped in a list (API handler pattern)."""
        from shared.feedback import query_feedback_by_date

        mock_table = _table_scanning([
            {'feedback_id': '1', 'source_platform': 'target'},
            {'feedback_id': '2', 'source_platform': 'other'},
        ], empty_days=29)

        result = query_feedback_by_date(mock_table, days=30, sources=['target'], limit=50)

        assert len(result) == 1
        assert result[0]['source_platform'] == 'target'

    def test_none_filters_treated_as_no_filter(self):
        """Passing None for sources/categories/sentiments means no filtering."""
        from shared.feedback import query_feedback_by_date

        mock_table = _table_scanning([{'feedback_id': '1'}, {'feedback_id': '2'}], empty_days=29)

        result = query_feedback_by_date(
            mock_table, days=30, sources=None, categories=None, sentiments=None, limit=50,
        )

        assert len(result) == 2

    def test_paginates_via_last_evaluated_key(self):
        """A date partition larger than one DynamoDB page is fully paged through
        via LastEvaluatedKey (regression for the '500개 중' truncation bug)."""
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        # Two pages: first returns 400 items + a continuation key, second
        # returns 300 items and no key (end of partition).
        page1 = [{'id': f'a{i}', 'date': '2099-01-01'} for i in range(400)]
        page2 = [{'id': f'b{i}', 'date': '2099-01-01'} for i in range(300)]
        mock_table.query.side_effect = [
            {'Items': page1, 'LastEvaluatedKey': {'pk': 'x'}},
            {'Items': page2},
        ]

        result = query_feedback_by_date(mock_table, days=1, limit=10000)

        # Both pages followed → 700 items, not truncated at the first page.
        assert mock_table.query.call_count == 2
        # Second query carried the continuation key.
        assert mock_table.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {'pk': 'x'}
        assert len(result) == 700

    def test_days_capped_at_the_sample_walk(self):
        """An empty table walks at most MAX_SAMPLE_WALK_DAYS calendar days, however wide `days` is."""
        from shared.feedback import MAX_SAMPLE_WALK_DAYS, query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        query_feedback_by_date(mock_table, days=9999, limit=10)

        assert mock_table.query.call_count == MAX_SAMPLE_WALK_DAYS

    def test_all_time_walks_the_sample_window(self):
        """days=0 means all time: it walks MAX_SAMPLE_WALK_DAYS, not zero days."""
        from shared.feedback import MAX_SAMPLE_WALK_DAYS, query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        query_feedback_by_date(mock_table, days=0, limit=10)

        assert mock_table.query.call_count == MAX_SAMPLE_WALK_DAYS

    def test_get_feedback_context_passes_all_time_through(self):
        from shared.feedback import MAX_SAMPLE_WALK_DAYS, get_feedback_context

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        get_feedback_context(mock_table, {'days': 0}, limit=10)

        assert mock_table.query.call_count == MAX_SAMPLE_WALK_DAYS

    def test_wide_window_reaches_feedback_older_than_the_lookback(self):
        """Regression (QA s3): newest feedback 120 days old, `days=365` -> found.

        With a 90-calendar-day cap, "Last year" / "All time" read only the last 90
        days, so every persona / document / research job failed with "No feedback
        data found" on a deployment whose newest feedback was older than that.
        """
        from datetime import UTC, datetime, timedelta

        from shared.feedback import query_feedback_by_date

        old_day = (datetime.now(UTC) - timedelta(days=120)).strftime('%Y-%m-%d')
        item = {'feedback_id': 'f1', 'date': old_day, 'source_platform': 'app'}

        def query(**kwargs):
            pk = kwargs['KeyConditionExpression'].get_expression()['values'][1]
            return {'Items': [item] if pk == f'DATE#{old_day}' else []}

        mock_table = MagicMock()
        mock_table.query.side_effect = query

        assert query_feedback_by_date(mock_table, days=365, limit=10) == [item]
        assert query_feedback_by_date(mock_table, days=0, limit=10) == [item]
        # A window the user narrowed still means what it says.
        assert query_feedback_by_date(mock_table, days=90, limit=10) == []

    def test_walk_stops_after_max_lookback_days_with_data(self):
        """Continuous data: the sample still spans MAX_LOOKBACK_DAYS dated days (unchanged cost)."""
        from shared.feedback import MAX_LOOKBACK_DAYS, query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [{'feedback_id': 'x', 'sentiment_label': 'positive'}]}

        # A post-filter disables the fetch-ceiling early break, so only the dated-day budget stops the walk.
        query_feedback_by_date(mock_table, days=0, sentiments=['positive'], limit=10)

        assert mock_table.query.call_count == MAX_LOOKBACK_DAYS

    def test_gsi2_category_query_filters_by_date_range(self):
        """GSI2 category queries filter out items outside the date range."""
        from datetime import datetime

        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        today = datetime.now(UTC).strftime('%Y-%m-%d')
        mock_table.query.return_value = {
            'Items': [
                {'feedback_id': '1', 'category': 'delivery', 'date': today},
                {'feedback_id': '2', 'category': 'delivery', 'date': '2020-01-01'},
            ]
        }

        result = query_feedback_by_date(
            mock_table, days=7, categories=['delivery'], limit=50,
        )

        assert len(result) == 1
        assert result[0]['feedback_id'] == '1'


def _dated_item(feedback_id, imported_days_ago, written_days_ago, **overrides):
    """Feedback item with explicit import and review dates."""
    from datetime import datetime, timedelta
    now = datetime.now(UTC)
    item = {
        'feedback_id': feedback_id,
        'source_platform': 'webscraper',
        'sentiment_label': 'neutral',
        'category': 'delivery',
        'date': (now - timedelta(days=imported_days_ago)).strftime('%Y-%m-%d'),
        'source_created_at': (now - timedelta(days=written_days_ago)).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    item.update(overrides)
    return item


class TestDateBasis:
    """date_basis threading through the shared query pipeline (issue #150).

    A review can never be imported before it was written, so the import
    window always contains the review window — review basis is a post-filter
    on the same scan, no extra GSI needed.
    """

    def test_imported_basis_keeps_backfilled_old_reviews(self):
        """Default basis is unchanged: freshly imported old reviews stay."""
        from shared.feedback import query_feedback_by_date

        mock_table = _table_scanning([_dated_item('old-review', 0, 400)], empty_days=30)

        result = query_feedback_by_date(mock_table, days=7)

        assert [i['feedback_id'] for i in result] == ['old-review']

    def test_review_basis_drops_backfilled_old_reviews(self):
        from shared.feedback import query_feedback_by_date

        mock_table = _table_scanning([
            _dated_item('fresh-review', 0, 2),
            _dated_item('old-review', 0, 400),
        ], empty_days=30)

        result = query_feedback_by_date(mock_table, days=7, date_basis='review')

        assert [i['feedback_id'] for i in result] == ['fresh-review']

    def test_review_basis_disables_early_break(self):
        """The fetch ceiling must not stop the scan before all in-window
        days are read: review-basis matches can hide behind old-review
        items that the post-filter will drop."""
        from shared.feedback import query_feedback_by_date

        # Day 0 is full of backfilled old reviews (post-filter drops them);
        # the only match was written recently but imported on day 1.
        day0 = [_dated_item(f'old-{i}', 0, 400) for i in range(10)]
        day1 = [_dated_item('fresh', 1, 1)]
        mock_table = _table_scanning(day0, day1, empty_days=30)

        # limit=1 => fetch_ceiling=3; day0 alone exceeds it. Without the
        # early-break disable, day1 would never be read.
        result = query_feedback_by_date(mock_table, days=7, limit=1, date_basis='review')

        assert [i['feedback_id'] for i in result] == ['fresh']

    def test_category_branch_applies_review_basis(self):
        from shared.feedback import query_feedback_by_date

        mock_table = _table_scanning([
            _dated_item('fresh-review', 0, 2),
            _dated_item('old-review', 0, 400),
        ], empty_days=0)

        result = query_feedback_by_date(
            mock_table, days=7, categories=['delivery'], date_basis='review',
        )

        assert [i['feedback_id'] for i in result] == ['fresh-review']
        assert mock_table.query.call_args_list[0].kwargs['IndexName'] == 'gsi2-by-category'

    def test_get_feedback_context_unpacks_date_basis(self):
        from shared.feedback import get_feedback_context

        mock_table = _table_scanning([
            _dated_item('fresh-review', 0, 1),
            _dated_item('old-review', 0, 400),
        ], empty_days=30)

        result = get_feedback_context(
            mock_table, {'days': 7, 'date_basis': 'review'}, limit=10,
        )

        assert [i['feedback_id'] for i in result] == ['fresh-review']


class TestWindowHelpers:
    """basis_date / window_cutoff — the shared window definition."""

    def test_window_cutoff_is_days_long_ending_today(self):
        from datetime import datetime, timedelta

        from shared.feedback import window_cutoff

        now = datetime.now(UTC)
        assert window_cutoff(1) == now.strftime('%Y-%m-%d')
        assert window_cutoff(7) == (now - timedelta(days=6)).strftime('%Y-%m-%d')

    def test_basis_date_falls_back_on_malformed_source_date(self):
        from shared.feedback import basis_date

        item = {'date': '2026-07-14', 'source_created_at': 'unavailable-forever'}
        assert basis_date(item, 'review') == '2026-07-14'
        assert basis_date(item, 'imported') == '2026-07-14'

    def test_basis_date_uses_source_created_at_for_review(self):
        from shared.feedback import basis_date

        item = {'date': '2026-07-14', 'source_created_at': '2025-01-02T10:00:00Z'}
        assert basis_date(item, 'review') == '2025-01-02'


def _item(idx, text_len=600):
    """Feedback item whose original_text is text_len chars."""
    prefix = f'Review {idx}: '
    return {
        'feedback_id': f'fb-{idx}',
        'source_platform': 'test',
        'original_text': prefix + 'x' * (text_len - len(prefix)),
        'sentiment_label': 'positive',
        'sentiment_score': 0.5,
        'source_created_at': '2025-01-01T00:00:00',
    }


class TestTruncateFeedbackContext:
    """The context budget helpers (issue #231).

    These are the shared definition of "how much corpus fits and how much of it
    survived", so the persona path, the prompt builder, and any future caller
    cannot disagree. Before this, three independent caps each sliced the corpus
    and none reported doing it.
    """

    def test_a_context_within_budget_is_returned_untouched(self):
        from shared.feedback import format_feedback_for_llm, truncate_feedback_context

        context = format_feedback_for_llm([_item(i) for i in range(5)])
        result, used, truncated = truncate_feedback_context(context, len(context) + 1)
        assert result == context
        assert used == 5
        assert truncated is False

    def test_truncation_cuts_on_a_record_boundary(self):
        """A partial record is data the model may treat as real.

        Slicing at an arbitrary offset can leave an unterminated
        `- Full Text: "…` or a label with no value, so cut back to the last
        complete record instead.
        """
        from shared.feedback import format_feedback_for_llm, truncate_feedback_context

        context = format_feedback_for_llm([_item(i) for i in range(20)])
        # A budget deliberately landing mid-record: verify the fixture really
        # does split a record, so a passing test means the cutback worked rather
        # than that the boundary happened to align.
        budget = len(context) // 2 + 37
        assert not context[:budget].endswith('\n'), 'fixture must cut mid-line'

        result, used, truncated = truncate_feedback_context(context, budget)

        assert truncated is True
        assert 0 < used < 20

        body = result.split('\n\n[... additional feedback truncated ...]')[0]
        # The exact property: what survives is a PREFIX of the original ending
        # on a record boundary, so the next thing in the original is a new
        # record header rather than the middle of the one we kept.
        assert context.startswith(body), 'truncation must not alter the kept text'
        assert context[len(body):].startswith('\n### Review '), (
            'context does not end on a record boundary — the model would '
            'receive a partial review'
        )
        # Whole records only, so the reported count is exact rather than an
        # estimate that includes a fragment.
        assert body.count('### Review ') == used

    def test_reported_count_matches_what_survived(self):
        from shared.feedback import (
            count_feedback_records,
            format_feedback_for_llm,
            truncate_feedback_context,
        )

        context = format_feedback_for_llm([_item(i) for i in range(30)])
        result, used, _ = truncate_feedback_context(context, len(context) // 3)
        assert count_feedback_records(result) == used

    def test_a_non_positive_budget_means_no_limit(self):
        from shared.feedback import format_feedback_for_llm, truncate_feedback_context

        context = format_feedback_for_llm([_item(i) for i in range(3)])
        for budget in (0, -1):
            result, used, truncated = truncate_feedback_context(context, budget)
            assert result == context
            assert used == 3
            assert truncated is False

    def test_a_budget_below_one_record_keeps_the_partial_head(self):
        """Degenerate but must not return an empty context.

        With no boundary to fall back to there is nothing whole to keep, so the
        head survives — and `truncated` still reports the loss.
        """
        from shared.feedback import format_feedback_for_llm, truncate_feedback_context

        context = format_feedback_for_llm([_item(i) for i in range(4)])
        result, _, truncated = truncate_feedback_context(context, 100)
        assert truncated is True
        assert len(result) > 0


class TestFeedbackBudgetDerivation:
    """The item limit and the char budget must be derived from one measurement.

    Chosen independently they drift: a 500-item limit against a 200 000-char cap
    meant any corpus past ~245 items truncated on the DEFAULT path, discarding
    more than half of what had just been read, while reporting nothing.
    """

    def test_a_full_corpus_at_the_derived_limit_fits_the_budget(self):
        from shared.feedback import (
            feedback_char_budget,
            feedback_item_limit,
            format_feedback_for_llm,
        )

        budget = feedback_char_budget()
        limit = feedback_item_limit(budget)
        corpus = [_item(i) for i in range(limit)]
        assert len(format_feedback_for_llm(corpus)) <= budget

    def test_the_per_item_estimate_bounds_the_richest_record(self):
        """Every optional field present is the worst case the limit must cover."""
        from shared.feedback import FEEDBACK_CHARS_PER_ITEM_MAX, format_feedback_for_llm

        richest = {
            **_item(0),
            'direct_customer_quote': 'q' * 500,
            'problem_summary': 's' * 500,
            'problem_root_cause_hypothesis': 'r' * 500,
            'persona_type': 'power_user',
            'journey_stage': 'usage',
        }
        assert len(format_feedback_for_llm([richest])) <= FEEDBACK_CHARS_PER_ITEM_MAX

    def test_budget_scales_with_the_context_window(self):
        """Derived from the model, so a smaller-window model gets less."""
        from shared.feedback import feedback_char_budget

        assert feedback_char_budget(window_tokens=400_000) > feedback_char_budget()
        assert feedback_char_budget(window_tokens=100_000) < feedback_char_budget()

    def test_a_window_smaller_than_the_overhead_yields_no_budget(self):
        """Never returns a negative budget, which would slice to nothing."""
        from shared.feedback import CONTEXT_OVERHEAD_TOKENS, feedback_char_budget

        assert feedback_char_budget(window_tokens=CONTEXT_OVERHEAD_TOKENS // 2) == 0

    def test_the_item_limit_is_never_zero(self):
        """A tiny budget still fetches one item rather than none."""
        from shared.feedback import feedback_item_limit

        assert feedback_item_limit(0) == 1
        assert feedback_item_limit(10) == 1


class TestPerFieldClippingIsReported:
    """A cap that fires without saying so is the defect #231 is about.

    ``format_feedback_for_llm`` clips the LLM-generated enrichment fields so
    ``FEEDBACK_CHARS_PER_ITEM_MAX`` is a real bound and the item limit can be
    derived from the character budget. But this formatter is shared — the
    research step handler and every helper in projects.py call it — and those
    callers get no ``context_truncated`` equivalent. The warning is their signal,
    so it is asserted here rather than assumed.
    """

    @staticmethod
    def _clip_warnings(caplog):
        return [
            r for r in caplog.records
            if 'clipped text out of the LLM context' in r.getMessage()
        ]

    def test_a_clipped_enrichment_field_is_reported_with_its_name_and_count(self, caplog):
        import logging

        from shared.feedback import MAX_ENRICHMENT_FIELD_CHARS, format_feedback_for_llm

        items = [
            {**_item(i), 'problem_summary': 's' * (MAX_ENRICHMENT_FIELD_CHARS + 1)}
            for i in range(3)
        ]
        with caplog.at_level(logging.WARNING, logger='shared.feedback'):
            format_feedback_for_llm(items)

        warnings = self._clip_warnings(caplog)
        assert warnings, 'clipping happened and nothing reported it'
        assert warnings[0].clipped_fields == {'problem_summary': 3}, (
            'the report must name the field and how many records it clipped, so '
            'a caller can tell one verbose record from a systematic cap'
        )

    def test_nothing_is_reported_when_nothing_was_clipped(self, caplog):
        """The control. Without it the assertion above could pass on a warning
        this formatter always emits, rather than on the cap under test."""
        import logging

        from shared.feedback import format_feedback_for_llm

        with caplog.at_level(logging.WARNING, logger='shared.feedback'):
            format_feedback_for_llm([{**_item(i), 'problem_summary': 'short'}
                                     for i in range(3)])

        assert self._clip_warnings(caplog) == []

    def test_a_field_exactly_at_the_cap_is_not_reported(self, caplog):
        """Off-by-one: at the cap nothing is lost, so nothing should be claimed."""
        import logging

        from shared.feedback import MAX_ENRICHMENT_FIELD_CHARS, format_feedback_for_llm

        with caplog.at_level(logging.WARNING, logger='shared.feedback'):
            format_feedback_for_llm(
                [{**_item(0), 'problem_summary': 's' * MAX_ENRICHMENT_FIELD_CHARS}]
            )

        assert self._clip_warnings(caplog) == []

    def test_the_original_text_cap_is_reported_too(self, caplog):
        """It predates this change and is the largest per-record loss.

        Counted but deliberately not altered: adding an ellipsis there would
        change what the model receives, while counting only makes the existing
        loss visible.
        """
        import logging

        from shared.feedback import MAX_ORIGINAL_TEXT_CHARS, format_feedback_for_llm

        with caplog.at_level(logging.WARNING, logger='shared.feedback'):
            format_feedback_for_llm([_item(0, text_len=MAX_ORIGINAL_TEXT_CHARS + 50)])

        warnings = self._clip_warnings(caplog)
        assert warnings, 'the original_text cap fired and nothing reported it'
        assert warnings[0].clipped_fields == {'original_text': 1}

    def test_every_clipped_field_appears_in_one_report(self, caplog):
        import logging

        from shared.feedback import MAX_ENRICHMENT_FIELD_CHARS, format_feedback_for_llm

        long = 'x' * (MAX_ENRICHMENT_FIELD_CHARS + 1)
        with caplog.at_level(logging.WARNING, logger='shared.feedback'):
            format_feedback_for_llm([{
                **_item(0),
                'problem_summary': long,
                'direct_customer_quote': long,
                'problem_root_cause_hypothesis': long,
            }])

        warnings = self._clip_warnings(caplog)
        assert len(warnings) == 1, 'one report per call, not one per field'
        assert warnings[0].clipped_fields == {
            'direct_customer_quote': 1,
            'problem_summary': 1,
            'problem_root_cause_hypothesis': 1,
        }
