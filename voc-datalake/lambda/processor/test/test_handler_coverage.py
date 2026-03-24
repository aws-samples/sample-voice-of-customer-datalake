"""
Additional coverage tests for processor/handler.py.
Covers: validation with schemas enabled, idempotency paths, BedrockThrottlingError,
get_primary_language, get_categories_config caching, record_handler edge cases,
_process_feedback_idempotent, and lambda_handler batch processing.
"""
import json
import time
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestValidationEnabled:
    """Cover validate_sqs_message when VALIDATION_ENABLED is True (lines 132-159)."""

    @patch('processor.handler.log_validation_failure')
    @patch('processor.handler.VALIDATION_ENABLED', True)
    @patch('processor.handler.safe_validate_message')
    def test_returns_none_on_validation_errors(self, mock_validate, mock_log):
        from processor.handler import validate_sqs_message
        mock_validate.return_value = (None, ['Missing field: text'])
        result, errors = validate_sqs_message({'id': '1', 'source_platform': 'ws'})
        assert result is None
        assert len(errors) == 1
        mock_log.assert_called_once()

    @patch('processor.handler.VALIDATION_ENABLED', True)
    @patch('processor.handler.safe_validate_message')
    def test_returns_validated_dict_on_success(self, mock_validate):
        from processor.handler import validate_sqs_message
        mock_model = MagicMock()
        mock_model.model_dump.return_value = {'id': '1', 'text': 'Good'}
        mock_validate.return_value = (mock_model, [])
        result, errors = validate_sqs_message({'id': '1', 'text': 'Good'})
        assert result == {'id': '1', 'text': 'Good'}
        assert errors == []


class TestLogValidationFailureNoTable:
    """Cover log_validation_failure when aggregates_table is None (line 89-90)."""

    @patch('processor.handler.aggregates_table', None)
    def test_returns_early_when_no_table(self):
        from processor.handler import log_validation_failure
        # Should not raise
        log_validation_failure('ws', 'msg1', ['err'], 'preview')


class TestLogProcessingErrorNoTable:
    """Cover log_processing_error when aggregates_table is None (line 116)."""

    @patch('processor.handler.aggregates_table', None)
    def test_returns_early_when_no_table(self):
        from processor.handler import log_processing_error
        # Should not raise
        log_processing_error('ws', 'msg1', 'Error', 'message')


class TestGetPrimaryLanguage:
    """Cover get_primary_language() function (lines 207-233)."""

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_fetches_language_from_dynamodb(self, mock_table):
        from processor.handler import get_primary_language
        mock_table.get_item.return_value = {
            'Item': {'primary_language': 'es'}
        }
        result = get_primary_language()
        assert result == 'es'

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_falls_back_to_env_var_when_no_item(self, mock_table):
        from processor.handler import get_primary_language
        mock_table.get_item.return_value = {'Item': None}
        result = get_primary_language()
        assert result == 'en'  # PRIMARY_LANGUAGE env default

    @patch('processor.handler._language_cache', None)
    @patch('processor.handler._language_cache_time', None)
    @patch('processor.handler.aggregates_table')
    def test_falls_back_on_dynamodb_error(self, mock_table):
        from processor.handler import get_primary_language
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        result = get_primary_language()
        assert result == 'en'

    @patch('processor.handler._language_cache', 'fr')
    @patch('processor.handler._language_cache_time', time.time())
    def test_returns_cached_value(self):
        from processor.handler import get_primary_language
        result = get_primary_language()
        assert result == 'fr'


class TestGetCategoriesConfigCaching:
    """Cover get_categories_config caching branch (lines 232-233)."""

    @patch('processor.handler._categories_cache', [{'name': 'cached'}])
    @patch('processor.handler._categories_cache_time', time.time())
    def test_returns_cached_categories(self):
        from processor.handler import get_categories_config
        result = get_categories_config()
        assert result == [{'name': 'cached'}]


class TestInvokeBedrockLlmThrottling:
    """Cover BedrockThrottlingError re-raise in invoke_bedrock_llm (lines 299-301)."""

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config', return_value=[])
    def test_reraises_throttling_error(self, mock_cats, mock_converse):
        from processor.handler import invoke_bedrock_llm
        from shared.converse import BedrockThrottlingError
        mock_converse.side_effect = BedrockThrottlingError('Throttled')
        with pytest.raises(BedrockThrottlingError):
            invoke_bedrock_llm({'source_platform': 'ws', 'text': 'test'})

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config', return_value=[])
    def test_returns_empty_on_generic_exception(self, mock_cats, mock_converse):
        from processor.handler import invoke_bedrock_llm
        mock_converse.side_effect = RuntimeError('Unexpected')
        result = invoke_bedrock_llm({'source_platform': 'ws', 'text': 'test'})
        assert result['insights'] == {}
        assert 'error' in result['metadata']


class TestRecordHandlerIdempotency:
    """Cover idempotency paths in record_handler (lines 640, 657, 663-680, 690-698, 707)."""

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler._process_feedback_idempotent')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', MagicMock())
    @patch('processor.handler.idempotency_config', MagicMock())
    def test_uses_idempotent_wrapper_when_configured(self, mock_validate, mock_idemp, mock_write, mock_log_err):
        from processor.handler import record_handler
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws', 'text': 'test'}, [])
        mock_idemp.return_value = {'feedback_id': 'abc', 'llm_metadata': {}}
        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws', 'text': 'test'})
        result = record_handler(record)
        assert result['status'] == 'success'
        mock_idemp.assert_called_once()

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', MagicMock())
    @patch('processor.handler.idempotency_config', MagicMock())
    def test_handles_idempotency_already_in_progress(self, mock_validate, mock_log_err):
        from processor.handler import record_handler, IdempotencyAlreadyInProgressError
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])
        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})
        with patch('processor.handler._process_feedback_idempotent', side_effect=IdempotencyAlreadyInProgressError('in progress')):
            result = record_handler(record)
        assert result['status'] == 'skipped'
        assert result['reason'] == 'idempotency_in_progress'

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    def test_reraises_bedrock_throttling(self, mock_validate, mock_log_err):
        from processor.handler import record_handler
        from shared.converse import BedrockThrottlingError
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])
        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})
        with patch('processor.handler.process_feedback', side_effect=BedrockThrottlingError('Throttled')):
            with pytest.raises(BedrockThrottlingError):
                record_handler(record)
        mock_log_err.assert_called_once()

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    def test_reraises_unexpected_exception(self, mock_validate, mock_log_err):
        from processor.handler import record_handler
        mock_validate.return_value = ({'id': '1', 'source_platform': 'ws'}, [])
        record = MagicMock()
        record.body = json.dumps({'id': '1', 'source_platform': 'ws'})
        with patch('processor.handler.process_feedback', side_effect=RuntimeError('Boom')):
            with pytest.raises(RuntimeError):
                record_handler(record)
        mock_log_err.assert_called_once()

    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message')
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    def test_tracks_llm_error_metric(self, mock_validate, mock_process, mock_write):
        """Cover the branch where llm_metadata has an error."""
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


class TestProcessFeedbackIdempotentWrapper:
    """Cover _process_feedback_idempotent wrapper (lines 690-698)."""

    @patch('processor.handler.process_feedback')
    @patch('processor.handler.idempotency_config', MagicMock())
    @patch('processor.handler.persistence_layer', MagicMock())
    def test_calls_process_feedback_via_wrapper(self, mock_process):
        from processor.handler import _process_feedback_idempotent
        mock_process.return_value = {'feedback_id': 'abc'}
        # The inner function uses @idempotent_function which may fail without real config,
        # but we can at least verify the wrapper structure exists
        with patch('processor.handler.idempotent_function', return_value=lambda f: f):
            result = _process_feedback_idempotent(
                raw_record={'id': '1', 'source_platform': 'ws'},
                idempotency_key='ws:1'
            )
            assert result == {'feedback_id': 'abc'}


class TestProcessFeedbackTranslation:
    """Cover translation branch where original_language != target_language."""

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.get_primary_language', return_value='en')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_includes_normalized_text_when_translated(
        self, mock_dup, mock_detect, mock_translate, mock_lang, mock_sentiment, mock_llm
    ):
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
