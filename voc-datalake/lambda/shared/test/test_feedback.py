"""
Tests for shared/feedback.py - Feedback utilities for LLM context building.
"""

from unittest.mock import MagicMock, patch


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
        
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper'},
                {'feedback_id': '2', 'source_platform': 'manual_import'},
                {'feedback_id': '3', 'source_platform': 'webscraper'}
            ]},
        ] + [{'Items': []} for _ in range(30)]
        
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
        
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'sentiment_label': 'positive'},
                {'feedback_id': '2', 'sentiment_label': 'negative'},
                {'feedback_id': '3', 'sentiment_label': 'positive'}
            ]},
        ] + [{'Items': []} for _ in range(30)]
        
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
        
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'delivery'},
                {'feedback_id': '2', 'source_platform': 'manual_import', 'sentiment_label': 'positive', 'category': 'delivery'},
                {'feedback_id': '3', 'source_platform': 'webscraper', 'sentiment_label': 'negative', 'category': 'delivery'},
                {'feedback_id': '4', 'source_platform': 'webscraper', 'sentiment_label': 'positive', 'category': 'support'},
            ]},
        ] + [{'Items': []} for _ in range(30)]
        
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


class TestGetFeedbackContextExtraFilters:
    """The `feedback_filters` post-pass (shared-model extra dimensions)."""

    def _table_returning(self, items):
        """A mock table whose first date query yields `items`, then empties."""
        mock_table = MagicMock()
        mock_table.query.side_effect = [{'Items': items}] + [{'Items': []} for _ in range(40)]
        return mock_table

    def test_narrows_by_urgent_when_feedback_filters_present(self):
        """urgent=true drops non-high-urgency items the date query returned."""
        from shared.feedback import get_feedback_context

        mock_table = self._table_returning([
            {'feedback_id': '1', 'urgency': 'high'},
            {'feedback_id': '2', 'urgency': 'low'},
            {'feedback_id': '3', 'urgency': 'high'},
        ])

        result = get_feedback_context(
            mock_table,
            {'days': 7, 'feedback_filters': {'urgent': True}},
            limit=10,
        )

        assert [i['feedback_id'] for i in result] == ['1', '3']

    def test_narrows_by_custom_field(self):
        """custom_fields matches on the stored custom_fields map."""
        from shared.feedback import get_feedback_context

        mock_table = self._table_returning([
            {'feedback_id': '1', 'custom_fields': {'tier': 'Gold'}},
            {'feedback_id': '2', 'custom_fields': {'tier': 'Silver'}},
            {'feedback_id': '3', 'custom_fields': {'tier': 'Gold'}},
        ])

        result = get_feedback_context(
            mock_table,
            {'days': 7, 'feedback_filters': {'custom_fields': {'tier': ['Gold']}}},
            limit=10,
        )

        assert [i['feedback_id'] for i in result] == ['1', '3']

    def test_empty_feedback_filters_is_a_noop(self):
        """An empty feedback_filters returns the same set as omitting it."""
        from shared.feedback import get_feedback_context

        items = [{'feedback_id': '1', 'urgency': 'low'}, {'feedback_id': '2', 'urgency': 'high'}]

        result = get_feedback_context(
            self._table_returning(items), {'days': 7, 'feedback_filters': {}}, limit=10,
        )

        assert [i['feedback_id'] for i in result] == ['1', '2']

    def test_limit_applies_after_the_post_pass(self):
        """limit counts items that PASSED the post-filter, not pre-filter rows.

        The query would truncate before the post-pass if the extra filter were
        applied to an already-sliced list; this is the regression guard for that.
        """
        from shared.feedback import get_feedback_context

        # 10 rows: 5 high, 5 low, interleaved so a pre-slice to limit=3 would
        # keep only 2 high. The post-pass must see all 10 and return 3 high.
        rows = []
        for i in range(10):
            rows.append({'feedback_id': str(i), 'urgency': 'high' if i % 2 == 0 else 'low'})

        result = get_feedback_context(
            self._table_returning(rows),
            {'days': 7, 'feedback_filters': {'urgent': True}},
            limit=3,
        )

        assert len(result) == 3
        assert all(i['urgency'] == 'high' for i in result)


def _first_partition_table(items):
    """A table whose first partition query yields ``items`` and every later
    one nothing — how a bulk import looks: everything on one date."""
    table = MagicMock()
    calls = {'n': 0}

    def query(**kwargs):
        calls['n'] += 1
        return {'Items': list(items)} if calls['n'] == 1 else {'Items': []}

    table.query.side_effect = query
    return table


class TestProjection:
    def test_aliases_every_segment_and_reuses_an_alias_per_name(self):
        from shared.feedback import _projection
        expression, names = _projection([('date',), ('custom_fields', 'tier'), ('custom_fields', 'region')])

        assert expression == '#p0, #p1.#p2, #p1.#p3'
        assert names == {'#p0': 'date', '#p1': 'custom_fields', '#p2': 'tier', '#p3': 'region'}

    def test_admin_chosen_keys_never_appear_inline(self):
        """A custom-field key is free text ("Las Vegas, NV.region"), so it may
        contain characters an expression would read as syntax."""
        from shared.feedback import _projection
        expression, names = _projection([('custom_fields', 'odd.key, #x')])

        assert 'odd' not in expression
        assert 'odd.key, #x' in names.values()

    def test_repeated_paths_are_projected_once(self):
        from shared.feedback import _projection
        expression, _ = _projection([('feedback_id',), ('feedback_id',)])
        assert expression == '#p0'


class TestSampleEvenly:
    def test_returns_everything_when_the_pool_fits(self):
        from shared.feedback import sample_evenly
        rows = [{'i': i} for i in range(5)]
        assert sample_evenly(rows, 10) == rows

    def test_spreads_the_sample_across_the_whole_pool(self):
        """Not the first N: the newest-first read order is what collapsed a
        bulk import onto one slice."""
        from shared.feedback import sample_evenly
        rows = [{'i': i} for i in range(100)]
        picked = [r['i'] for r in sample_evenly(rows, 4)]
        assert picked == [0, 25, 50, 75]

    def test_picks_distinct_rows_in_pool_order(self):
        from shared.feedback import sample_evenly
        rows = [{'i': i} for i in range(7)]
        picked = [r['i'] for r in sample_evenly(rows, 6)]
        assert picked == sorted(set(picked))
        assert len(picked) == 6

    def test_is_deterministic(self):
        from shared.feedback import sample_evenly
        rows = [{'i': i} for i in range(1000)]
        assert sample_evenly(rows, 145) == sample_evenly(rows, 145)

    def test_returns_nothing_for_a_non_positive_size(self):
        from shared.feedback import sample_evenly
        assert sample_evenly([{'i': 1}], 0) == []


class TestReadFeedbackPool:
    def test_an_unfiltered_read_keeps_only_the_id(self):
        """Deserialization is what times the preview out, so an unfiltered
        count must not carry anything it does not need."""
        from shared.feedback import read_feedback_pool
        table = _first_partition_table([{'feedback_id': 'a'}])

        read_feedback_pool(table, {'days': 7})

        kwargs = table.query.call_args_list[0].kwargs
        assert set(kwargs['ExpressionAttributeNames'].values()) == {'feedback_id'}

    def test_a_filtered_read_keeps_exactly_what_the_filters_read(self):
        from shared.feedback import read_feedback_pool
        table = _first_partition_table([])

        read_feedback_pool(table, {
            'days': 7,
            'sentiments': ['negative'],
            'date_basis': 'review',
            'feedback_filters': {'urgent': True, 'custom_fields': {'tier_status': ['Gold']}},
        })

        kwargs = table.query.call_args_list[0].kwargs
        names = kwargs['ExpressionAttributeNames']
        alias = {name: key for key, name in names.items()}
        assert set(names.values()) == {
            'feedback_id', 'date', 'source_created_at', 'sentiment_label',
            'urgency', 'custom_fields', 'tier_status',
        }
        # The custom field is a nested path, so only that key of the map comes back.
        assert f"{alias['custom_fields']}.{alias['tier_status']}" in kwargs['ProjectionExpression']
        assert 'original_text' not in names.values()

    def test_counts_every_match_not_just_a_fetch_limit(self):
        from shared.feedback import read_feedback_pool
        table = _first_partition_table([{'feedback_id': str(i)} for i in range(500)])

        rows, capped = read_feedback_pool(table, {'days': 7})

        assert len(rows) == 500
        assert capped is False

    def test_flags_the_count_as_a_lower_bound_at_the_row_cap(self):
        from shared.feedback import read_feedback_pool
        table = _first_partition_table([{'feedback_id': str(i)} for i in range(10)])

        rows, capped = read_feedback_pool(table, {'days': 7}, max_rows=4)

        assert len(rows) == 4
        assert capped is True

    def test_applies_the_list_and_shared_model_filters(self):
        from shared.feedback import read_feedback_pool
        table = _first_partition_table([
            {'feedback_id': 'a', 'sentiment_label': 'negative', 'custom_fields': {'tier': 'Gold'}},
            {'feedback_id': 'b', 'sentiment_label': 'positive', 'custom_fields': {'tier': 'Gold'}},
            {'feedback_id': 'c', 'sentiment_label': 'negative', 'custom_fields': {'tier': 'Silver'}},
        ])

        rows, _ = read_feedback_pool(table, {
            'days': 7,
            'sentiments': ['negative'],
            'feedback_filters': {'custom_fields': {'tier': ['Gold']}},
        })

        assert [r['feedback_id'] for r in rows] == ['a']

    def test_returns_nothing_without_a_table(self):
        from shared.feedback import read_feedback_pool
        assert read_feedback_pool(None, {'days': 7}) == ([], False)

    def test_a_passed_deadline_stops_at_a_page_boundary_and_reports_a_lower_bound(self):
        """One import date is one index partition; a throttled read of it must
        still answer inside the preview's request timeout."""
        from shared.feedback import read_feedback_pool
        table = MagicMock()
        table.query.return_value = {
            'Items': [{'feedback_id': 'a'}, {'feedback_id': 'b'}],
            'LastEvaluatedKey': {'k': 'more'},
        }

        rows, capped = read_feedback_pool(table, {'days': 30}, deadline=0)

        assert table.query.call_count == 1
        assert [r['feedback_id'] for r in rows] == ['a', 'b']
        assert capped is True

    def test_without_a_deadline_a_long_partition_is_read_to_the_end(self):
        from shared.feedback import read_feedback_pool
        table = MagicMock()
        table.query.side_effect = [
            {'Items': [{'feedback_id': 'a'}], 'LastEvaluatedKey': {'k': 1}},
            {'Items': [{'feedback_id': 'b'}]},
        ] + [{'Items': []} for _ in range(29)]

        rows, capped = read_feedback_pool(table, {'days': 30})

        assert [r['feedback_id'] for r in rows] == ['a', 'b']
        assert capped is False


class TestGetFeedbackByIds:
    def test_returns_items_in_the_requested_order_and_reports_missing(self):
        from shared.feedback import get_feedback_by_ids
        table = MagicMock()
        # One response per id, in request order: 'b' has been deleted.
        table.query.side_effect = [
            {'Items': [{'feedback_id': 'c'}]},
            {'Items': []},
            {'Items': [{'feedback_id': 'a'}]},
        ]

        items, missing = get_feedback_by_ids(table, ['c', 'b', 'a'])

        assert [i['feedback_id'] for i in items] == ['c', 'a']
        assert missing == ['b']
        assert table.query.call_args.kwargs['IndexName'] == 'gsi4-by-feedback-id'

    def test_skips_empty_and_non_string_ids_without_querying(self):
        from shared.feedback import get_feedback_by_ids
        table = MagicMock()

        assert get_feedback_by_ids(table, ['', None]) == ([], [])
        table.query.assert_not_called()


class TestSampleFeedback:
    def test_samples_the_pool_evenly_and_fetches_the_picks_in_full(self):
        from shared import feedback
        pool = [{'feedback_id': str(i)} for i in range(10)]
        full = {str(i): {'feedback_id': str(i), 'original_text': f't{i}'} for i in range(10)}

        with patch.object(feedback, 'read_feedback_pool', return_value=(pool, False)), \
             patch.object(feedback, 'get_feedback_by_ids',
                          side_effect=lambda _t, ids: ([full[i] for i in ids], [])):
            items, matched, lower_bound = feedback.sample_feedback(MagicMock(), {}, 5)

        assert [i['feedback_id'] for i in items] == ['0', '2', '4', '6', '8']
        assert all('original_text' in i for i in items)
        assert (matched, lower_bound) == (10, False)


def _estimate_table(pages, index_count=10_000):
    """A table whose feedback-id index scan returns ``pages`` (lists of rows) and
    whose DescribeTable reports ``index_count`` rows on that index."""
    import uuid
    table = MagicMock()
    # A fresh name per table: the index count is cached per table name.
    table.name = f'feedback-{uuid.uuid4().hex}'
    responses = [
        {'Items': rows, **({'LastEvaluatedKey': {'k': i}} if i < len(pages) - 1 else {})}
        for i, rows in enumerate(pages)
    ]
    table.scan.side_effect = responses
    table.meta.client.describe_table.return_value = {'Table': {'GlobalSecondaryIndexes': [
        {'IndexName': 'gsi1-by-date', 'ItemCount': 1},
        {'IndexName': 'gsi4-by-feedback-id', 'ItemCount': index_count},
    ]}}
    return table


def _today():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


class TestEstimateFeedbackMatches:
    def test_scales_the_sample_match_rate_by_the_index_size(self):
        from shared.feedback import estimate_feedback_matches
        today = _today()
        # Two pages of 100 rows, 66 of each page negative -> 66% of 10,000.
        page = [{'date': today, 'sentiment_label': 'negative' if i < 66 else 'positive'} for i in range(100)]
        table = _estimate_table([page, page, page, page, page])

        estimate = estimate_feedback_matches(table, {'days': 30, 'sentiments': ['negative']}, pages=2)

        assert estimate == 6_600
        assert table.scan.call_count == 2
        assert table.scan.call_args.kwargs['IndexName'] == 'gsi4-by-feedback-id'

    def test_rounds_to_two_significant_figures(self):
        from shared.feedback import estimate_feedback_matches
        today = _today()
        page = [{'date': today, 'sentiment_label': 'negative' if i < 67 else 'positive'} for i in range(100)]
        table = _estimate_table([page, page], index_count=42_612)

        # 0.67 * 42,612 = 28,550 -> 29,000
        assert estimate_feedback_matches(table, {'days': 30, 'sentiments': ['negative']}, pages=1) == 29_000

    def test_rows_outside_the_window_do_not_count(self):
        from shared.feedback import estimate_feedback_matches
        today = _today()
        page = [{'date': today}] * 30 + [{'date': '2000-01-01'}] * 70
        table = _estimate_table([page, page])

        assert estimate_feedback_matches(table, {'days': 30}, pages=1) == 3_000

    def test_too_few_matching_sample_rows_return_none_not_zero(self):
        """A thin sample is noise, and zero would read as "nothing matches"."""
        from shared.feedback import ESTIMATE_MIN_SAMPLE_MATCHES, estimate_feedback_matches
        today = _today()
        hits = ESTIMATE_MIN_SAMPLE_MATCHES - 1
        page = [{'date': today, 'urgency': 'high' if i < hits else 'low'} for i in range(500)]
        table = _estimate_table([page, page])

        estimate = estimate_feedback_matches(table, {'days': 30, 'feedback_filters': {'urgent': True}}, pages=1)

        assert estimate is None

    def test_a_sample_that_covered_the_whole_index_is_an_exact_count(self):
        from shared.feedback import estimate_feedback_matches
        today = _today()
        table = _estimate_table([[{'date': today}] * 7])

        assert estimate_feedback_matches(table, {'days': 30}) == 7
        table.meta.client.describe_table.assert_not_called()

    def test_projects_only_the_window_date_and_the_active_filter_paths(self):
        from shared.feedback import estimate_feedback_matches
        table = _estimate_table([[]])

        estimate_feedback_matches(table, {
            'days': 30, 'feedback_filters': {'custom_fields': {'tier_status': ['Gold']}},
        })

        names = set(table.scan.call_args.kwargs['ExpressionAttributeNames'].values())
        assert names == {'date', 'custom_fields', 'tier_status'}

    def test_returns_none_without_a_table(self):
        from shared.feedback import estimate_feedback_matches
        assert estimate_feedback_matches(None, {'days': 30}) is None


class TestRoundSignificant:
    def test_rounds_to_two_significant_figures(self):
        from shared.feedback import _round_significant
        assert _round_significant(28_202) == 28_000
        assert _round_significant(7_316) == 7_300
        assert _round_significant(1_260) == 1_300
        assert _round_significant(46.4) == 46
        assert _round_significant(0.4) == 0


class TestFormatFeedbackForLlm:
    """Tests for format_feedback_for_llm function."""

    def test_formats_basic_feedback_item(self):
        """Formats basic feedback item with required fields."""
        from shared.feedback import format_feedback_for_llm
        
        items = [{
            'source_platform': 'webscraper',
            'source_created_at': '2024-01-15T10:30:00Z',
            'sentiment_label': 'positive',
            'sentiment_score': 0.85,
            'category': 'delivery',
            'rating': 5,
            'urgency': 'low',
            'original_text': 'Great service!'
        }]
        
        result = format_feedback_for_llm(items)
        
        assert 'Review 1' in result
        assert 'webscraper' in result
        assert 'positive' in result
        assert '0.85' in result
        assert 'delivery' in result
        assert 'Great service!' in result

    def test_includes_optional_fields_when_present(self):
        """Includes optional fields when present."""
        from shared.feedback import format_feedback_for_llm
        
        items = [{
            'source_platform': 'manual_import',
            'sentiment_label': 'negative',
            'sentiment_score': -0.7,
            'category': 'support',
            'urgency': 'high',
            'original_text': 'Bad experience',
            'direct_customer_quote': 'Never again!',
            'problem_summary': 'Long wait times',
            'problem_root_cause_hypothesis': 'Understaffed',
            'persona_type': 'frustrated_customer',
            'journey_stage': 'post_purchase'
        }]
        
        result = format_feedback_for_llm(items)
        
        assert 'Never again!' in result
        assert 'Long wait times' in result
        assert 'Understaffed' in result
        assert 'frustrated_customer' in result
        assert 'post_purchase' in result

    def test_handles_missing_optional_fields(self):
        """Handles missing optional fields gracefully."""
        from shared.feedback import format_feedback_for_llm
        
        items = [{
            'source_platform': 'webscraper',
            'sentiment_label': 'neutral',
            'sentiment_score': 0.0,
            'category': 'other',
            'urgency': 'medium',
            'original_text': 'It was okay'
        }]
        
        result = format_feedback_for_llm(items)
        
        # Should not raise and should contain basic info
        assert 'Review 1' in result
        assert 'webscraper' in result

    def test_truncates_long_text(self):
        """Truncates very long original_text."""
        from shared.feedback import format_feedback_for_llm
        
        long_text = 'A' * 1000
        items = [{
            'source_platform': 'webscraper',
            'sentiment_label': 'positive',
            'sentiment_score': 0.5,
            'category': 'other',
            'urgency': 'low',
            'original_text': long_text
        }]
        
        result = format_feedback_for_llm(items)
        
        # Should truncate to 600 chars
        assert 'A' * 600 in result
        assert 'A' * 700 not in result

    def test_formats_multiple_items(self):
        """Formats multiple feedback items with sequential numbering."""
        from shared.feedback import format_feedback_for_llm
        
        items = [
            {'source_platform': 'webscraper', 'sentiment_label': 'positive', 'sentiment_score': 0.8, 'category': 'a', 'urgency': 'low', 'original_text': 'First'},
            {'source_platform': 'manual_import', 'sentiment_label': 'negative', 'sentiment_score': -0.5, 'category': 'b', 'urgency': 'high', 'original_text': 'Second'},
        ]
        
        result = format_feedback_for_llm(items)
        
        assert 'Review 1' in result
        assert 'Review 2' in result
        assert 'First' in result
        assert 'Second' in result

    def test_returns_empty_string_for_empty_list(self):
        """Returns empty string for empty items list."""
        from shared.feedback import format_feedback_for_llm
        
        result = format_feedback_for_llm([])
        
        assert result == ''


class TestGetFeedbackStatistics:
    """Tests for get_feedback_statistics function."""

    def test_returns_no_data_message_for_empty_list(self):
        """Returns appropriate message for empty items list."""
        from shared.feedback import get_feedback_statistics
        
        result = get_feedback_statistics([])
        
        assert 'No feedback data available' in result

    def test_calculates_sentiment_distribution(self):
        """Calculates sentiment distribution correctly."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'positive'},
            {'sentiment_label': 'positive'},
            {'sentiment_label': 'negative'},
            {'sentiment_label': 'neutral'},
        ]
        
        result = get_feedback_statistics(items)
        
        assert 'positive: 2' in result
        assert 'negative: 1' in result
        assert 'neutral: 1' in result

    def test_calculates_category_counts(self):
        """Calculates category counts correctly."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'positive', 'category': 'delivery'},
            {'sentiment_label': 'positive', 'category': 'delivery'},
            {'sentiment_label': 'negative', 'category': 'support'},
        ]
        
        result = get_feedback_statistics(items)
        
        assert 'delivery: 2' in result
        assert 'support: 1' in result

    def test_calculates_source_counts(self):
        """Calculates source platform counts correctly."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'positive', 'source_platform': 'webscraper'},
            {'sentiment_label': 'positive', 'source_platform': 'webscraper'},
            {'sentiment_label': 'negative', 'source_platform': 'manual_import'},
        ]
        
        result = get_feedback_statistics(items)
        
        assert 'webscraper: 2' in result
        assert 'manual_import: 1' in result

    def test_calculates_urgency_counts(self):
        """Calculates urgency level counts correctly."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'negative', 'urgency': 'high'},
            {'sentiment_label': 'negative', 'urgency': 'high'},
            {'sentiment_label': 'neutral', 'urgency': 'medium'},
            {'sentiment_label': 'positive', 'urgency': 'low'},
        ]
        
        result = get_feedback_statistics(items)
        
        assert 'High: 2' in result
        assert 'Medium: 1' in result
        assert 'Low: 1' in result

    def test_calculates_average_rating(self):
        """Calculates average rating correctly."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'positive', 'rating': 5},
            {'sentiment_label': 'positive', 'rating': 4},
            {'sentiment_label': 'neutral', 'rating': 3},
        ]
        
        result = get_feedback_statistics(items)
        
        assert '4.0/5' in result
        assert 'from 3 rated reviews' in result

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

    def test_includes_total_count(self):
        """Includes total feedback count in statistics."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {'sentiment_label': 'positive'},
            {'sentiment_label': 'negative'},
            {'sentiment_label': 'neutral'},
        ]
        
        result = get_feedback_statistics(items)
        
        assert 'n=3' in result

    def test_handles_unknown_values(self):
        """Handles unknown/missing values gracefully."""
        from shared.feedback import get_feedback_statistics
        
        items = [
            {},  # Empty item
            {'sentiment_label': 'positive'},
        ]
        
        result = get_feedback_statistics(items)
        
        # Should count 'unknown' for missing sentiment
        assert 'unknown: 1' in result
        assert 'positive: 1' in result


class TestGetFeedbackContextEdgeCases:
    """Edge case tests for get_feedback_context function."""

    def test_handles_empty_filters(self):
        """Handles empty filters dict."""
        from shared.feedback import get_feedback_context
        
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        
        result = get_feedback_context(mock_table, {})
        
        assert result == []

    def test_uses_default_days_when_not_specified(self):
        """Uses default 30 days when not specified in filters."""
        from shared.feedback import get_feedback_context
        
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        
        get_feedback_context(mock_table, {}, limit=10)
        
        # Should query multiple days (up to 30)
        assert mock_table.query.call_count > 0

    def test_stops_early_when_enough_items(self):
        """Stops querying when enough items collected."""
        from shared.feedback import get_feedback_context
        
        mock_table = MagicMock()
        # Return many items on first query
        mock_table.query.return_value = {'Items': [
            {'feedback_id': str(i)} for i in range(200)
        ]}
        
        result = get_feedback_context(mock_table, {'days': 30}, limit=10)
        
        # Should stop early since we have enough items
        assert len(result) == 10

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

        def query_side_effect(**kwargs):
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

        mock_table = MagicMock()
        # Return 200 items on every query
        mock_table.query.return_value = {'Items': [
            {'feedback_id': str(i)} for i in range(200)
        ]}

        result = get_feedback_context(mock_table, {'days': 30}, limit=10)

        assert len(result) == 10
        # Should break early — not query all 30 days
        assert mock_table.query.call_count < 30


class TestQueryFeedbackByDate:
    """Tests for query_feedback_by_date — the shared low-level query function."""

    def test_returns_empty_when_table_is_none(self):
        """Returns empty list when feedback_table is None."""
        from shared.feedback import query_feedback_by_date

        assert query_feedback_by_date(None, days=7) == []

    def test_single_source_filter_as_list(self):
        """Accepts a single source wrapped in a list (API handler pattern)."""
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                {'feedback_id': '1', 'source_platform': 'target'},
                {'feedback_id': '2', 'source_platform': 'other'},
            ]},
        ] + [{'Items': []} for _ in range(29)]

        result = query_feedback_by_date(mock_table, days=30, sources=['target'], limit=50)

        assert len(result) == 1
        assert result[0]['source_platform'] == 'target'

    def test_none_filters_treated_as_no_filter(self):
        """Passing None for sources/categories/sentiments means no filtering."""
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [{'feedback_id': '1'}, {'feedback_id': '2'}]},
        ] + [{'Items': []} for _ in range(29)]

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

    def test_days_capped_at_max_lookback(self):
        """Days parameter is capped at MAX_LOOKBACK_DAYS."""
        from shared.feedback import MAX_LOOKBACK_DAYS, query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        query_feedback_by_date(mock_table, days=9999, limit=10)

        assert mock_table.query.call_count == MAX_LOOKBACK_DAYS

    def test_gsi2_category_query_filters_by_date_range(self):
        """GSI2 category queries filter out items outside the date range."""
        from datetime import datetime, timezone

        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
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


class TestQueryFeedbackPage:
    """Tests for query_feedback_page — returns (page, total) for pagination."""

    def test_returns_empty_tuple_when_table_is_none(self):
        from shared.feedback import query_feedback_page
        page, total = query_feedback_page(None, days=7)
        assert page == []
        assert total == 0

    def test_returns_total_count_and_page_slice(self):
        from shared.feedback import query_feedback_page

        mock_table = MagicMock()
        all_items = [{'feedback_id': str(i)} for i in range(50)]
        mock_table.query.side_effect = [
            {'Items': list(all_items)},
        ] + [{'Items': []} for _ in range(29)]

        page, total = query_feedback_page(mock_table, days=30, limit=10, offset=0)

        assert total == 50
        assert len(page) == 10
        assert page[0]['feedback_id'] == '0'

    def test_offset_skips_items(self):
        from shared.feedback import query_feedback_page

        mock_table = MagicMock()
        all_items = [{'feedback_id': str(i)} for i in range(50)]
        mock_table.query.side_effect = [
            {'Items': list(all_items)},
        ] + [{'Items': []} for _ in range(29)]

        page, total = query_feedback_page(mock_table, days=30, limit=10, offset=20)

        assert total == 50
        assert len(page) == 10
        assert page[0]['feedback_id'] == '20'

    def test_scans_all_dates_for_accurate_total_with_source_filter(self):
        """query_feedback_page must NOT early-break so total is accurate."""
        from shared.feedback import query_feedback_page

        mock_table = MagicMock()
        other_items = [{'feedback_id': f'o{i}', 'source_platform': 'other'} for i in range(200)]
        target_items = [{'feedback_id': f't{i}', 'source_platform': 'target'} for i in range(30)]

        responses = [{'Items': []} for _ in range(30)]
        responses[0] = {'Items': list(other_items)}
        responses[15] = {'Items': list(target_items)}
        mock_table.query.side_effect = responses

        page, total = query_feedback_page(
            mock_table, days=30, sources=['target'], limit=10, offset=0,
        )

        assert total == 30
        assert len(page) == 10
        assert all(i['source_platform'] == 'target' for i in page)
        # Must have queried all 30 days (no early break)
        assert mock_table.query.call_count == 30



def _dated_item(feedback_id, imported_days_ago, written_days_ago, **overrides):
    """Feedback item with explicit import and review dates."""
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
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

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [_dated_item('old-review', 0, 400)]},
        ] + [{'Items': []} for _ in range(30)]

        result = query_feedback_by_date(mock_table, days=7)

        assert [i['feedback_id'] for i in result] == ['old-review']

    def test_review_basis_drops_backfilled_old_reviews(self):
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                _dated_item('fresh-review', 0, 2),
                _dated_item('old-review', 0, 400),
            ]},
        ] + [{'Items': []} for _ in range(30)]

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
        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': day0}, {'Items': day1},
        ] + [{'Items': []} for _ in range(30)]

        # limit=1 => fetch_ceiling=3; day0 alone exceeds it. Without the
        # early-break disable, day1 would never be read.
        result = query_feedback_by_date(mock_table, days=7, limit=1, date_basis='review')

        assert [i['feedback_id'] for i in result] == ['fresh']

    def test_category_branch_applies_review_basis(self):
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                _dated_item('fresh-review', 0, 2),
                _dated_item('old-review', 0, 400),
            ]},
        ]

        result = query_feedback_by_date(
            mock_table, days=7, categories=['delivery'], date_basis='review',
        )

        assert [i['feedback_id'] for i in result] == ['fresh-review']
        assert mock_table.query.call_args_list[0].kwargs['IndexName'] == 'gsi2-by-category'

    def test_get_feedback_context_unpacks_date_basis(self):
        from shared.feedback import get_feedback_context

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                _dated_item('fresh-review', 0, 1),
                _dated_item('old-review', 0, 400),
            ]},
        ] + [{'Items': []} for _ in range(30)]

        result = get_feedback_context(
            mock_table, {'days': 7, 'date_basis': 'review'}, limit=10,
        )

        assert [i['feedback_id'] for i in result] == ['fresh-review']

    def test_query_feedback_page_totals_respect_review_basis(self):
        from shared.feedback import query_feedback_page

        mock_table = MagicMock()
        mock_table.query.side_effect = [
            {'Items': [
                _dated_item('fresh-1', 0, 0),
                _dated_item('fresh-2', 0, 3),
                _dated_item('old', 0, 100),
            ]},
        ] + [{'Items': []} for _ in range(30)]

        page, total = query_feedback_page(mock_table, days=7, date_basis='review')

        assert total == 2
        assert {i['feedback_id'] for i in page} == {'fresh-1', 'fresh-2'}


class TestWindowHelpers:
    """basis_date / window_cutoff — the shared window definition."""

    def test_window_cutoff_is_days_long_ending_today(self):
        from datetime import datetime, timedelta, timezone

        from shared.feedback import window_cutoff

        now = datetime.now(timezone.utc)
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
