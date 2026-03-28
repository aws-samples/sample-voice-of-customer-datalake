"""
Tests for shared/feedback.py - Feedback utilities for LLM context building.
"""

from unittest.mock import MagicMock


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

    def test_per_day_limit_is_forwarded(self):
        """The per_day_limit parameter is passed to DynamoDB Limit."""
        from shared.feedback import query_feedback_by_date

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        query_feedback_by_date(mock_table, days=1, per_day_limit=123, limit=50)

        call_kwargs = mock_table.query.call_args.kwargs
        assert call_kwargs['Limit'] == 123

    def test_days_capped_at_max_lookback(self):
        """Days parameter is capped at MAX_LOOKBACK_DAYS."""
        from shared.feedback import query_feedback_by_date, MAX_LOOKBACK_DAYS

        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}

        query_feedback_by_date(mock_table, days=9999, limit=10)

        assert mock_table.query.call_count == MAX_LOOKBACK_DAYS

    def test_gsi2_category_query_filters_by_date_range(self):
        """GSI2 category queries filter out items outside the date range."""
        from shared.feedback import query_feedback_by_date
        from datetime import datetime, timezone

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
