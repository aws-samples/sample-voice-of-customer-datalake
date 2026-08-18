"""Tests for aggregator/handler.py

Tests the core aggregation functions:
- update_counter()
- update_average()
- process_new_feedback()
- record_handler()
"""
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestGetMetricType:
    """Tests for get_metric_type() function."""

    def test_returns_source_for_daily_source_pk(self):
        """Returns 'source' for daily_source metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_source#webscraper')
        
        assert result == 'source'

    def test_returns_persona_for_persona_pk(self):
        """Returns 'persona' for persona metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#persona#Happy Customer')
        
        assert result == 'persona'

    def test_returns_none_for_other_pk(self):
        """Returns None for non-indexed metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_total')
        
        assert result is None

    def test_returns_none_for_category_pk(self):
        """Returns None for category metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_category#product_quality')
        
        assert result is None


class TestUpdateCounter:
    """Tests for update_counter() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_one(self, mock_table):
        """Increments counter field by 1 by default."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count')
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_total', 'sk': '2025-01-15'}
        assert ':inc' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_custom_amount(self, mock_table):
        """Increments counter by specified amount."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=5)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 5

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the counter item."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', ttl_days=30)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']
        # TTL should be approximately 30 days from now
        ttl_value = call_kwargs['ExpressionAttributeValues'][':ttl']
        assert isinstance(ttl_value, int)

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_source_pk(self, mock_table):
        """Includes metric_type for source metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_source#webscraper', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'source'

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_persona_pk(self, mock_table):
        """Includes metric_type for persona metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#persona#Happy Customer', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'persona'


class TestUpdateAverage:
    """Tests for update_average() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_updates_sum_and_count(self, mock_table):
        """Updates sum and count for running average calculation."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-01-15'}
        assert ':val' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':val'] == Decimal('0.85')
        assert ':one' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':one'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the average item."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'), ttl_days=60)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']


class TestProcessNewFeedback:
    """Tests for process_new_feedback() function."""

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_total(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily total counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        # Check daily total was updated
        calls = mock_counter.call_args_list
        daily_total_call = [c for c in calls if c.args[0] == 'METRIC#daily_total']
        assert len(daily_total_call) == 1
        assert daily_total_call[0].args[1] == '2025-01-15'

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_source(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily source counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        source_call = [c for c in calls if 'daily_source#webscraper' in c.args[0]]
        assert len(source_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_category(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily category counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        category_call = [c for c in calls if 'daily_category#product_quality' in c.args[0]]
        assert len(category_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_sentiment(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily sentiment counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        sentiment_call = [c for c in calls if 'daily_sentiment#positive' in c.args[0]]
        assert len(sentiment_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_sentiment_average(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates sentiment score average."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        mock_avg.assert_called_once()
        call_args = mock_avg.call_args
        assert call_args.args[0] == 'METRIC#daily_sentiment_avg'
        assert call_args.args[1] == '2025-01-15'
        assert call_args.args[2] == Decimal('0.85')

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_urgent_counter_for_high_urgency(self, mock_counter, mock_avg, sample_urgent_feedback_item):
        """Updates urgent counter when urgency is high."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_urgent_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_urgent_counter_for_low_urgency(self, mock_counter, mock_avg, sample_feedback_item):
        """Does not update urgent counter when urgency is low."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 0

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_persona_counter(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates persona counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        persona_call = [c for c in calls if 'persona#Happy Customer' in c.args[0]]
        assert len(persona_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_category_sentiment_combo(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates category + sentiment combination counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        combo_call = [c for c in calls if 'category_sentiment#product_quality#positive' in c.args[0]]
        assert len(combo_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_uses_current_date_when_date_missing(self, mock_counter, mock_avg):
        """Uses current date when date field is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_date = {
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
        }
        
        process_new_feedback(item_without_date)
        
        # Should still call update_counter with some date
        assert mock_counter.called

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_sentiment_average_when_score_missing(self, mock_counter, mock_avg):
        """Skips sentiment average update when score is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_score = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
            'sentiment_score': None,
        }
        
        process_new_feedback(item_without_score)
        
        mock_avg.assert_not_called()


class TestRecordHandler:
    """Tests for record_handler() function."""

    @patch('aggregator.handler.process_new_feedback')
    def test_processes_insert_event(self, mock_process, sample_feedback_item):
        """Processes INSERT events from DynamoDB stream."""
        from aggregator.handler import record_handler
        
        # Create mock DynamoDB record
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'pk': {'S': 'SOURCE#webscraper'},
            'sk': {'S': 'FEEDBACK#abc123'},
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'category': {'S': 'product_quality'},
            'sentiment_label': {'S': 'positive'},
            'sentiment_score': {'N': '0.85'},
        }
        
        result = record_handler(record)
        
        assert result['status'] == 'success'
        mock_process.assert_called_once()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_modify_event(self, mock_process):
        """Skips MODIFY events from DynamoDB stream."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'MODIFY'
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'not an insert'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_remove_event(self, mock_process):
        """Skips REMOVE events from DynamoDB stream."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'REMOVE'
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_when_no_new_image(self, mock_process):
        """Skips when new_image is missing."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = None
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'no new image'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_converts_dynamodb_format_to_dict(self, mock_process):
        """Converts DynamoDB format to regular dict."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'sentiment_score': {'N': '0.85'},
        }
        
        record_handler(record)
        
        # Check the item passed to process_new_feedback
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'
        assert item['sentiment_score'] == Decimal('0.85')

    @patch('aggregator.handler.process_new_feedback')
    def test_handles_already_deserialized_format(self, mock_process):
        """Handles already deserialized DynamoDB format."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        # Powertools may already deserialize the data
        record.dynamodb.new_image = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'sentiment_score': Decimal('0.85'),
        }
        
        record_handler(record)
        
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'
