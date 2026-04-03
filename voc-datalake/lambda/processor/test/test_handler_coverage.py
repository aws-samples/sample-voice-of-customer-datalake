"""
Tests for processor/handler.py — validation, language detection, caching,
idempotency, error handling, and translation paths.

Removed: no-op tests that only assert "should not raise" without verifying behavior
(TestLogValidationFailureNoTable, TestLogProcessingErrorNoTable).
Strengthened: assertions verify actual output values, not just status codes.
"""
import json
import time
import pytest
from unittest.mock import patch, MagicMock


class TestValidationEnabled:
    """Tests for validate_sqs_message when schema validation is enabled."""

    @patch('processor.handler.log_validation_failure')
    @patch('processor.handler.VALIDATION_ENABLED', True)
    @patch('processor.handler.safe_validate_message')
    def test_returns_none_with_errors_on_invalid_message(self, mock_validate, mock_log):
        """Returns (None, errors) and logs the failure when validation finds issues."""
        from processor.handler import validate_sqs_message
        mock_validate.return_value = (None, ['Missing field: text'])

        result, errors = validate_sqs_message({'id': '1', 'source_platform': 'ws'})

        assert result is None
        assert errors == ['Missing field: text']
        mock_log.assert_called_once()

    @patch('processor.handler.VALIDATION_ENABLED', True)
    @patch('processor.handler.safe_validate_message')
    def test_returns_validated_dict_on_valid_message(self, mock_validate):
        """Returns the model_dump dict with no errors when validation passes."""
        from processor.handler import validate_sqs_message
        mock_model = MagicMock()
        mock_model.model_dump.return_value = {'id': '1', 'text': 'Good'}
        mock_validate.return_value = (mock_model, [])

        result, errors = validate_sqs_message({'id': '1', 'text': 'Good'})

        assert result == {'id': '1', 'text': 'Good'}
        assert errors == []


class TestGetPrimaryLanguage:
    """Tests for get_primary_language() — DynamoDB lookup, fallback, and caching."""

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_returns_language_from_dynamodb(self, mock_table):
        """Fetches and returns the primary_language from DynamoDB settings."""
        from processor.handler import get_primary_language
        mock_table.get_item.return_value = {'Item': {'primary_language': 'es'}}

        assert get_primary_language() == 'es'

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_falls_back_to_english_when_no_setting_exists(self, mock_table):
        """Returns 'en' when DynamoDB has no primary_language setting."""
        from processor.handler import get_primary_language
        mock_table.get_item.return_value = {'Item': None}

        assert get_primary_language() == 'en'

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_falls_back_to_english_on_dynamodb_error(self, mock_table):
        """Returns 'en' when DynamoDB query fails — graceful degradation."""
        from processor.handler import get_primary_language
        mock_table.get_item.side_effect = Exception('DynamoDB error')

        assert get_primary_language() == 'en'

    @patch('processor.handler._language_cache', 'fr')
    @patch('processor.handler._language_cache_time', time.time())
    def test_returns_cached_language_without_db_call(self):
        """Returns cached value when cache is still fresh."""
        from processor.handler import get_primary_language

        assert get_primary_language() == 'fr'


class TestGetCategoriesConfigCaching:

    @patch('shared.api._categories_cache', [{'name': 'cached'}])
    @patch('shared.api._categories_cache_time', time.time())
    def test_returns_cached_categories(self):
        """Returns cached categories without hitting DynamoDB."""
        from processor.handler import get_categories_config

        assert get_categories_config() == [{'name': 'cached'}]


class TestInvokeBedrockLlmErrorHandling:

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config', return_value=[])
    def test_reraises_throttling_for_sqs_retry(self, mock_cats, mock_converse):
        """BedrockThrottlingError propagates so SQS can retry the message."""
        from processor.handler import invoke_bedrock_llm
        from shared.converse import BedrockThrottlingError

        mock_converse.side_effect = BedrockThrottlingError('Throttled')

        with pytest.raises(BedrockThrottlingError):
            invoke_bedrock_llm({'source_platform': 'ws', 'text': 'test'})

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config', return_value=[])
    def test_returns_empty_insights_with_error_metadata_on_generic_failure(self, mock_cats, mock_converse):
        """Returns degraded result with error in metadata instead of crashing."""
        from processor.handler import invoke_bedrock_llm

        mock_converse.side_effect = RuntimeError('Unexpected')

        result = invoke_bedrock_llm({'source_platform': 'ws', 'text': 'test'})

        assert result['insights'] == {}
        assert 'error' in result['metadata']


class TestRecordHandlerIdempotency:
    """Tests for idempotency integration in record_handler."""

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler._process_feedback_idempotent')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', MagicMock())
    @patch('processor.handler.idempotency_config', MagicMock())
    def test_uses_idempotent_wrapper_when_configured(self, mock_validate, mock_idemp, mock_write, mock_log_err):
        """Routes through idempotent wrapper when persistence layer is configured."""
        from processor.handler import record_handler
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws', 'text': 'test'}, [])
        mock_idemp.return_value = {'feedback_id': 'abc', 'llm_metadata': {}}

        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws', 'text': 'test'})

        result = record_handler(record)

        assert result['status'] == 'success'
        assert result['feedback_id'] == 'abc'
        mock_idemp.assert_called_once()

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', MagicMock())
    @patch('processor.handler.idempotency_config', MagicMock())
    def test_skips_already_in_progress_items(self, mock_validate, mock_log_err):
        """Returns 'skipped' status for items already being processed (idempotency guard)."""
        from processor.handler import record_handler, IdempotencyAlreadyInProgressError
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])

        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})

        with patch('processor.handler._process_feedback_idempotent',
                   side_effect=IdempotencyAlreadyInProgressError('in progress')):
            result = record_handler(record)

        assert result['status'] == 'skipped'
        assert result['reason'] == 'idempotency_in_progress'

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    def test_reraises_throttling_for_sqs_visibility_timeout(self, mock_validate, mock_log_err):
        """BedrockThrottlingError re-raises so SQS retries after visibility timeout."""
        from processor.handler import record_handler
        from shared.converse import BedrockThrottlingError

        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])
        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})

        with patch('processor.handler.process_feedback', side_effect=BedrockThrottlingError('Throttled')):
            with pytest.raises(BedrockThrottlingError):
                record_handler(record)

    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    def test_succeeds_but_tracks_llm_error_in_metadata(self, mock_validate, mock_process, mock_write):
        """Item is saved successfully even when LLM returns an error in metadata."""
        from processor.handler import record_handler
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])
        mock_process.return_value = {
            'feedback_id': 'abc',
            'llm_metadata': {'error': 'JSON parse failed'}
        }

        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})

        result = record_handler(record)

        assert result['status'] == 'success'
        assert result['feedback_id'] == 'abc'


class TestProcessFeedbackTranslation:
    """Tests for the translation branch in process_feedback."""

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.get_primary_language', return_value='en')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_translates_and_stores_both_original_and_normalized_text(
        self, mock_dup, mock_detect, mock_translate, mock_lang, mock_sentiment, mock_llm
    ):
        """When source language differs from target, stores translated text as normalized_text."""
        from processor.handler import process_feedback

        mock_dup.return_value = False
        mock_detect.return_value = 'es'
        mock_translate.return_value = 'Translated text'
        mock_sentiment.return_value = {'label': 'positive', 'score': 0.8}
        mock_llm.return_value = {
            'insights': {
                'category': 'product_quality', 'sentiment_label': 'positive',
                'sentiment_score': 0.8, 'urgency': 'low', 'impact_area': 'product',
                'journey_stage': 'usage', 'persona': {}
            },
            'metadata': {}
        }

        result = process_feedback({
            'id': '1', 'source_platform': 'ws', 'text': 'Buen producto',
            'source_channel': 'reviews'
        })

        assert result['normalized_text'] == 'Translated text'
        assert result['original_language'] == 'es'
        mock_translate.assert_called_once()
