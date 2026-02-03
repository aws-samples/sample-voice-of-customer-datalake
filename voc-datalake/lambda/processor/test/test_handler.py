"""Tests for processor/handler.py

Tests the core feedback processing functions:
- validate_sqs_message()
- process_feedback()
- invoke_bedrock_llm()
- generate_deterministic_id()
- check_duplicate()
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestGenerateDeterministicId:
    """Tests for generate_deterministic_id() function."""

    def test_returns_hash_based_on_source_id_when_provided(self):
        """Uses source_platform + source_id for deterministic ID."""
        from processor.handler import generate_deterministic_id
        
        result = generate_deterministic_id(
            source_platform='webscraper',
            source_id='review-123'
        )
        
        # Should be 32 hex characters
        assert len(result) == 32
        assert all(c in '0123456789abcdef' for c in result)

    def test_same_inputs_produce_same_id(self):
        """Same source_platform + source_id always produces same ID."""
        from processor.handler import generate_deterministic_id
        
        id1 = generate_deterministic_id('webscraper', 'review-123')
        id2 = generate_deterministic_id('webscraper', 'review-123')
        
        assert id1 == id2

    def test_different_source_ids_produce_different_ids(self):
        """Different source_ids produce different IDs."""
        from processor.handler import generate_deterministic_id
        
        id1 = generate_deterministic_id('webscraper', 'review-123')
        id2 = generate_deterministic_id('webscraper', 'review-456')
        
        assert id1 != id2

    def test_different_platforms_produce_different_ids(self):
        """Different source_platforms produce different IDs."""
        from processor.handler import generate_deterministic_id
        
        id1 = generate_deterministic_id('webscraper', 'review-123')
        id2 = generate_deterministic_id('manual_import', 'review-123')
        
        assert id1 != id2

    def test_uses_content_hash_when_no_source_id(self):
        """Falls back to content-based hash when source_id is empty."""
        from processor.handler import generate_deterministic_id
        
        result = generate_deterministic_id(
            source_platform='webscraper',
            source_id='',
            text='Great product!',
            created_at='2025-01-15T10:00:00Z',
            url='https://example.com/review'
        )
        
        assert len(result) == 32
        assert all(c in '0123456789abcdef' for c in result)

    def test_content_hash_is_deterministic(self):
        """Same content produces same ID when no source_id."""
        from processor.handler import generate_deterministic_id
        
        id1 = generate_deterministic_id(
            source_platform='webscraper',
            source_id='',
            text='Great product!',
            created_at='2025-01-15T10:00:00Z',
            url='https://example.com/review'
        )
        id2 = generate_deterministic_id(
            source_platform='webscraper',
            source_id='',
            text='Great product!',
            created_at='2025-01-15T10:00:00Z',
            url='https://example.com/review'
        )
        
        assert id1 == id2

    def test_different_text_produces_different_id(self):
        """Different text produces different ID when no source_id."""
        from processor.handler import generate_deterministic_id
        
        id1 = generate_deterministic_id(
            source_platform='webscraper',
            source_id='',
            text='Great product!',
            created_at='2025-01-15T10:00:00Z',
            url='https://example.com/review'
        )
        id2 = generate_deterministic_id(
            source_platform='webscraper',
            source_id='',
            text='Terrible product!',
            created_at='2025-01-15T10:00:00Z',
            url='https://example.com/review'
        )
        
        assert id1 != id2


class TestCheckDuplicate:
    """Tests for check_duplicate() function."""

    @patch('processor.handler.feedback_table')
    def test_returns_true_when_item_exists(self, mock_table):
        """Returns True when feedback already exists in DynamoDB."""
        from processor.handler import check_duplicate
        
        mock_table.get_item.return_value = {
            'Item': {'feedback_id': 'existing-id'}
        }
        
        result = check_duplicate('webscraper', 'existing-id')
        
        assert result is True
        mock_table.get_item.assert_called_once_with(
            Key={'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#existing-id'},
            ProjectionExpression='feedback_id'
        )

    @patch('processor.handler.feedback_table')
    def test_returns_false_when_item_not_found(self, mock_table):
        """Returns False when feedback does not exist."""
        from processor.handler import check_duplicate
        
        mock_table.get_item.return_value = {}
        
        result = check_duplicate('webscraper', 'new-id')
        
        assert result is False

    @patch('processor.handler.feedback_table')
    def test_returns_false_on_dynamodb_error(self, mock_table):
        """Returns False gracefully when DynamoDB fails."""
        from processor.handler import check_duplicate
        
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        result = check_duplicate('webscraper', 'some-id')
        
        assert result is False


class TestDetectLanguage:
    """Tests for detect_language() function."""

    @patch('processor.handler.comprehend')
    def test_returns_detected_language_code(self, mock_comprehend):
        """Returns the dominant language code from Comprehend."""
        from processor.handler import detect_language
        
        mock_comprehend.detect_dominant_language.return_value = {
            'Languages': [
                {'LanguageCode': 'es', 'Score': 0.95},
                {'LanguageCode': 'en', 'Score': 0.05}
            ]
        }
        
        result = detect_language('Hola, este producto es excelente!')
        
        assert result == 'es'

    @patch('processor.handler.comprehend')
    def test_returns_en_when_no_languages_detected(self, mock_comprehend):
        """Returns 'en' as default when no languages detected."""
        from processor.handler import detect_language
        
        mock_comprehend.detect_dominant_language.return_value = {
            'Languages': []
        }
        
        result = detect_language('Some text')
        
        assert result == 'en'

    @patch('processor.handler.comprehend')
    def test_returns_en_on_comprehend_error(self, mock_comprehend):
        """Returns 'en' gracefully when Comprehend fails."""
        from processor.handler import detect_language
        
        mock_comprehend.detect_dominant_language.side_effect = Exception('Service error')
        
        result = detect_language('Some text')
        
        assert result == 'en'

    @patch('processor.handler.comprehend')
    def test_truncates_text_to_5000_chars(self, mock_comprehend):
        """Truncates input text to 5000 characters for Comprehend."""
        from processor.handler import detect_language
        
        mock_comprehend.detect_dominant_language.return_value = {
            'Languages': [{'LanguageCode': 'en', 'Score': 0.99}]
        }
        
        long_text = 'a' * 10000
        detect_language(long_text)
        
        call_args = mock_comprehend.detect_dominant_language.call_args
        assert len(call_args.kwargs['Text']) == 5000


class TestTranslateText:
    """Tests for translate_text() function."""

    @patch('processor.handler.translate')
    def test_returns_original_when_same_language(self, mock_translate):
        """Returns original text when source and target language are same."""
        from processor.handler import translate_text
        
        result = translate_text('Hello world', 'en', 'en')
        
        assert result == 'Hello world'
        mock_translate.translate_text.assert_not_called()

    @patch('processor.handler.translate')
    def test_returns_translated_text(self, mock_translate):
        """Returns translated text from AWS Translate."""
        from processor.handler import translate_text
        
        mock_translate.translate_text.return_value = {
            'TranslatedText': 'Hello world'
        }
        
        result = translate_text('Hola mundo', 'es', 'en')
        
        assert result == 'Hello world'
        mock_translate.translate_text.assert_called_once()

    @patch('processor.handler.translate')
    def test_returns_original_on_translate_error(self, mock_translate):
        """Returns original text gracefully when Translate fails."""
        from processor.handler import translate_text
        
        mock_translate.translate_text.side_effect = Exception('Service error')
        
        result = translate_text('Hola mundo', 'es', 'en')
        
        assert result == 'Hola mundo'


class TestGetComprehendSentiment:
    """Tests for get_comprehend_sentiment() function."""

    @patch('processor.handler.comprehend')
    def test_returns_positive_sentiment(self, mock_comprehend):
        """Returns positive sentiment with calculated score."""
        from processor.handler import get_comprehend_sentiment
        
        mock_comprehend.detect_sentiment.return_value = {
            'Sentiment': 'POSITIVE',
            'SentimentScore': {
                'Positive': 0.9,
                'Negative': 0.05,
                'Neutral': 0.03,
                'Mixed': 0.02
            }
        }
        
        result = get_comprehend_sentiment('Great product!', 'en')
        
        assert result['label'] == 'positive'
        assert result['score'] == 0.85  # 0.9 - 0.05

    @patch('processor.handler.comprehend')
    def test_returns_negative_sentiment(self, mock_comprehend):
        """Returns negative sentiment with calculated score."""
        from processor.handler import get_comprehend_sentiment
        
        mock_comprehend.detect_sentiment.return_value = {
            'Sentiment': 'NEGATIVE',
            'SentimentScore': {
                'Positive': 0.1,
                'Negative': 0.8,
                'Neutral': 0.05,
                'Mixed': 0.05
            }
        }
        
        result = get_comprehend_sentiment('Terrible product!', 'en')
        
        assert result['label'] == 'negative'
        assert result['score'] == -0.7  # 0.1 - 0.8

    @patch('processor.handler.comprehend')
    def test_returns_neutral_on_error(self, mock_comprehend):
        """Returns neutral sentiment gracefully on error."""
        from processor.handler import get_comprehend_sentiment
        
        mock_comprehend.detect_sentiment.side_effect = Exception('Service error')
        
        result = get_comprehend_sentiment('Some text', 'en')
        
        assert result['label'] == 'neutral'
        assert result['score'] == 0.0

    @patch('processor.handler.comprehend')
    def test_uses_en_for_unsupported_language(self, mock_comprehend):
        """Falls back to 'en' for unsupported language codes."""
        from processor.handler import get_comprehend_sentiment
        
        mock_comprehend.detect_sentiment.return_value = {
            'Sentiment': 'NEUTRAL',
            'SentimentScore': {'Positive': 0.3, 'Negative': 0.3, 'Neutral': 0.3, 'Mixed': 0.1}
        }
        
        get_comprehend_sentiment('Some text', 'xyz')
        
        call_args = mock_comprehend.detect_sentiment.call_args
        assert call_args.kwargs['LanguageCode'] == 'en'


class TestParseLlmJsonResponse:
    """Tests for _parse_llm_json_response() function."""

    def test_parses_plain_json(self):
        """Parses plain JSON response."""
        from processor.handler import _parse_llm_json_response
        
        content = '{"category": "product_quality", "sentiment_label": "positive"}'
        
        result = _parse_llm_json_response(content)
        
        assert result == '{"category": "product_quality", "sentiment_label": "positive"}'

    def test_strips_markdown_code_block(self):
        """Strips markdown code block wrapper."""
        from processor.handler import _parse_llm_json_response
        
        content = '```json\n{"category": "product_quality"}\n```'
        
        result = _parse_llm_json_response(content)
        
        assert result == '{"category": "product_quality"}'

    def test_extracts_json_from_text(self):
        """Extracts JSON object from surrounding text."""
        from processor.handler import _parse_llm_json_response
        
        content = 'Here is the analysis: {"category": "other"} Hope this helps!'
        
        result = _parse_llm_json_response(content)
        
        assert result == '{"category": "other"}'

    def test_handles_whitespace(self):
        """Handles leading/trailing whitespace."""
        from processor.handler import _parse_llm_json_response
        
        content = '  \n  {"category": "billing"}  \n  '
        
        result = _parse_llm_json_response(content)
        
        assert result == '{"category": "billing"}'


class TestValidateSqsMessage:
    """Tests for validate_sqs_message() function."""

    @patch('processor.handler.VALIDATION_ENABLED', False)
    def test_returns_original_when_validation_disabled(self):
        """Returns original record when validation is disabled."""
        from processor.handler import validate_sqs_message
        
        raw_record = {'id': '123', 'text': 'Test'}
        
        result, errors = validate_sqs_message(raw_record)
        
        assert result == raw_record
        assert errors == []


class TestInvokeBedrockLlm:
    """Tests for invoke_bedrock_llm() function."""

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config')
    def test_returns_parsed_insights(self, mock_categories, mock_converse, sample_sqs_record, sample_llm_insights):
        """Returns parsed LLM insights from Bedrock response."""
        from processor.handler import invoke_bedrock_llm
        
        mock_categories.return_value = []
        mock_converse.return_value = json.dumps(sample_llm_insights)
        
        result = invoke_bedrock_llm(sample_sqs_record)
        
        assert 'insights' in result
        assert 'metadata' in result
        assert result['insights']['category'] == 'product_quality'
        assert result['insights']['sentiment_label'] == 'positive'

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config')
    def test_returns_empty_insights_on_json_error(self, mock_categories, mock_converse, sample_sqs_record):
        """Returns empty insights when JSON parsing fails."""
        from processor.handler import invoke_bedrock_llm
        
        mock_categories.return_value = []
        mock_converse.return_value = 'Not valid JSON at all'
        
        result = invoke_bedrock_llm(sample_sqs_record)
        
        assert result['insights'] == {}
        assert 'error' in result['metadata']

    @patch('processor.handler.converse')
    @patch('processor.handler.get_categories_config')
    def test_includes_latency_in_metadata(self, mock_categories, mock_converse, sample_sqs_record, sample_llm_insights):
        """Includes latency_ms in metadata."""
        from processor.handler import invoke_bedrock_llm
        
        mock_categories.return_value = []
        mock_converse.return_value = json.dumps(sample_llm_insights)
        
        result = invoke_bedrock_llm(sample_sqs_record)
        
        assert 'latency_ms' in result['metadata']
        assert isinstance(result['metadata']['latency_ms'], int)


class TestProcessFeedback:
    """Tests for process_feedback() function."""

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_returns_none_for_duplicate(
        self, mock_check_dup, mock_detect, mock_translate, mock_sentiment, mock_llm, sample_sqs_record
    ):
        """Returns None when feedback is a duplicate."""
        from processor.handler import process_feedback
        
        mock_check_dup.return_value = True
        
        result = process_feedback(sample_sqs_record)
        
        assert result is None
        mock_llm.assert_not_called()  # Should skip expensive LLM call

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_returns_processed_item_with_all_fields(
        self, mock_check_dup, mock_detect, mock_translate, mock_sentiment, mock_llm, 
        sample_sqs_record, sample_llm_insights
    ):
        """Returns fully processed item with all required fields."""
        from processor.handler import process_feedback
        
        mock_check_dup.return_value = False
        mock_detect.return_value = 'en'
        mock_translate.return_value = sample_sqs_record['text']
        mock_sentiment.return_value = {'label': 'positive', 'score': 0.8}
        mock_llm.return_value = {'insights': sample_llm_insights, 'metadata': {'model_name': 'test'}}
        
        result = process_feedback(sample_sqs_record)
        
        # Check required fields
        assert 'pk' in result
        assert 'sk' in result
        assert 'feedback_id' in result
        assert 'source_platform' in result
        assert 'original_text' in result
        assert 'category' in result
        assert 'sentiment_label' in result
        assert 'sentiment_score' in result
        
        # Check key structure
        assert result['pk'].startswith('SOURCE#')
        assert result['sk'].startswith('FEEDBACK#')
        
        # Check GSI keys
        assert 'gsi1pk' in result  # DATE#
        assert 'gsi2pk' in result  # CATEGORY#
        assert 'gsi3pk' in result  # URGENCY#

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_uses_preset_category_when_provided(
        self, mock_check_dup, mock_detect, mock_translate, mock_sentiment, mock_llm, 
        sample_sqs_record, sample_llm_insights
    ):
        """Uses preset_category from feedback form instead of LLM result."""
        from processor.handler import process_feedback
        
        mock_check_dup.return_value = False
        mock_detect.return_value = 'en'
        mock_translate.return_value = sample_sqs_record['text']
        mock_sentiment.return_value = {'label': 'positive', 'score': 0.8}
        mock_llm.return_value = {'insights': sample_llm_insights, 'metadata': {}}
        
        sample_sqs_record['preset_category'] = 'billing'
        
        result = process_feedback(sample_sqs_record)
        
        assert result['category'] == 'billing'

    @patch('processor.handler.invoke_bedrock_llm')
    @patch('processor.handler.get_comprehend_sentiment')
    @patch('processor.handler.translate_text')
    @patch('processor.handler.detect_language')
    @patch('processor.handler.check_duplicate')
    def test_sentiment_score_is_decimal(
        self, mock_check_dup, mock_detect, mock_translate, mock_sentiment, mock_llm, 
        sample_sqs_record, sample_llm_insights
    ):
        """Sentiment score is stored as Decimal for DynamoDB."""
        from processor.handler import process_feedback
        
        mock_check_dup.return_value = False
        mock_detect.return_value = 'en'
        mock_translate.return_value = sample_sqs_record['text']
        mock_sentiment.return_value = {'label': 'positive', 'score': 0.8}
        mock_llm.return_value = {'insights': sample_llm_insights, 'metadata': {}}
        
        result = process_feedback(sample_sqs_record)
        
        assert isinstance(result['sentiment_score'], Decimal)



class TestLogValidationFailure:
    """Tests for log_validation_failure() function."""

    @patch('processor.handler.aggregates_table')
    def test_logs_validation_failure_to_dynamodb(self, mock_table):
        """Logs validation failure to DynamoDB."""
        from processor.handler import log_validation_failure
        
        log_validation_failure(
            source_platform='webscraper',
            message_id='msg-123',
            errors=['Missing required field: text'],
            raw_preview='{"id": "123"}'
        )
        
        mock_table.put_item.assert_called_once()
        call_kwargs = mock_table.put_item.call_args.kwargs
        item = call_kwargs['Item']
        assert item['pk'] == 'LOGS#validation#webscraper'
        assert item['log_type'] == 'validation_failure'
        assert item['source_platform'] == 'webscraper'
        assert 'Missing required field' in item['errors'][0]

    @patch('processor.handler.aggregates_table')
    def test_truncates_raw_preview_to_500_chars(self, mock_table):
        """Truncates raw_preview to 500 characters."""
        from processor.handler import log_validation_failure
        
        long_preview = 'x' * 1000
        log_validation_failure('webscraper', 'msg-123', ['error'], long_preview)
        
        call_kwargs = mock_table.put_item.call_args.kwargs
        item = call_kwargs['Item']
        assert len(item['raw_preview']) == 500

    @patch('processor.handler.aggregates_table')
    def test_handles_dynamodb_error_gracefully(self, mock_table):
        """Handles DynamoDB error gracefully without raising."""
        from processor.handler import log_validation_failure
        
        mock_table.put_item.side_effect = Exception('DynamoDB error')
        
        # Should not raise
        log_validation_failure('webscraper', 'msg-123', ['error'], 'preview')


class TestLogProcessingError:
    """Tests for log_processing_error() function."""

    @patch('processor.handler.aggregates_table')
    def test_logs_processing_error_to_dynamodb(self, mock_table):
        """Logs processing error to DynamoDB."""
        from processor.handler import log_processing_error
        
        log_processing_error(
            source_platform='webscraper',
            message_id='msg-123',
            error_type='BedrockThrottlingError',
            error_message='Rate limit exceeded'
        )
        
        mock_table.put_item.assert_called_once()
        call_kwargs = mock_table.put_item.call_args.kwargs
        item = call_kwargs['Item']
        assert item['pk'] == 'LOGS#processing#webscraper'
        assert item['log_type'] == 'processing_error'
        assert item['error_type'] == 'BedrockThrottlingError'

    @patch('processor.handler.aggregates_table')
    def test_truncates_error_message_to_1000_chars(self, mock_table):
        """Truncates error_message to 1000 characters."""
        from processor.handler import log_processing_error
        
        long_error = 'e' * 2000
        log_processing_error('webscraper', 'msg-123', 'Error', long_error)
        
        call_kwargs = mock_table.put_item.call_args.kwargs
        item = call_kwargs['Item']
        assert len(item['error_message']) == 1000


class TestGetCategoriesConfig:
    """Tests for get_categories_config() function."""

    @patch('processor.handler.aggregates_table')
    @patch('processor.handler._categories_cache', None)
    @patch('processor.handler._categories_cache_time', None)
    def test_fetches_categories_from_dynamodb(self, mock_table):
        """Fetches categories from DynamoDB."""
        from processor.handler import get_categories_config
        
        mock_table.get_item.return_value = {
            'Item': {
                'categories': [
                    {'name': 'product_quality', 'description': 'Product quality issues'},
                    {'name': 'billing', 'description': 'Billing issues'},
                ]
            }
        }
        
        result = get_categories_config()
        
        assert len(result) == 2
        assert result[0]['name'] == 'product_quality'

    @patch('processor.handler.aggregates_table')
    @patch('processor.handler._categories_cache', None)
    @patch('processor.handler._categories_cache_time', None)
    def test_returns_empty_list_when_no_categories(self, mock_table):
        """Returns empty list when no categories configured."""
        from processor.handler import get_categories_config
        
        mock_table.get_item.return_value = {'Item': {}}
        
        result = get_categories_config()
        
        assert result == []

    @patch('processor.handler.aggregates_table')
    @patch('processor.handler._categories_cache', None)
    @patch('processor.handler._categories_cache_time', None)
    def test_returns_empty_list_on_dynamodb_error(self, mock_table):
        """Returns empty list on DynamoDB error."""
        from processor.handler import get_categories_config
        
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        result = get_categories_config()
        
        assert result == []


class TestBuildCategoriesInstruction:
    """Tests for build_categories_instruction() function."""

    @patch('processor.handler.get_categories_config')
    def test_uses_defaults_when_no_custom_categories(self, mock_get_config):
        """Uses default categories when none configured."""
        from processor.handler import build_categories_instruction
        
        mock_get_config.return_value = []
        
        result = build_categories_instruction()
        
        assert 'delivery' in result
        assert 'customer_support' in result
        assert 'product_quality' in result

    @patch('processor.handler.get_categories_config')
    def test_builds_instruction_with_custom_categories(self, mock_get_config):
        """Builds instruction with custom categories."""
        from processor.handler import build_categories_instruction
        
        mock_get_config.return_value = [
            {'name': 'shipping', 'description': 'Shipping issues', 'subcategories': []},
            {'name': 'returns', 'description': 'Return issues', 'subcategories': [
                {'name': 'damaged_item'},
                {'name': 'wrong_item'},
            ]},
        ]
        
        result = build_categories_instruction()
        
        assert 'shipping' in result
        assert 'returns' in result
        assert 'damaged_item' in result
        assert 'wrong_item' in result


class TestWriteToDynamodb:
    """Tests for write_to_dynamodb() function."""

    @patch('processor.handler.feedback_table')
    def test_writes_item_to_feedback_table(self, mock_table):
        """Writes processed item to feedback table."""
        from processor.handler import write_to_dynamodb
        
        item = {
            'pk': 'SOURCE#webscraper',
            'sk': 'FEEDBACK#abc123',
            'feedback_id': 'abc123',
        }
        
        write_to_dynamodb(item)
        
        mock_table.put_item.assert_called_once_with(Item=item)


class TestRecordHandler:
    """Tests for record_handler() function."""

    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message')
    def test_processes_valid_sqs_record(
        self, mock_validate, mock_process, mock_write, sample_sqs_record, sample_llm_insights
    ):
        """Processes valid SQS record successfully."""
        from processor.handler import record_handler
        from unittest.mock import MagicMock
        
        mock_validate.return_value = (sample_sqs_record, [])
        mock_process.return_value = {
            'pk': 'SOURCE#webscraper',
            'sk': 'FEEDBACK#abc123',
            'feedback_id': 'abc123',
        }
        
        record = MagicMock()
        record.body = json.dumps(sample_sqs_record)
        
        result = record_handler(record)
        
        assert result['status'] == 'success'
        mock_write.assert_called_once()

    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.validate_sqs_message')
    def test_skips_invalid_message(self, mock_validate, sample_sqs_record):
        """Skips message that fails validation."""
        from processor.handler import record_handler
        from unittest.mock import MagicMock
        
        mock_validate.return_value = (None, ['Missing required field: text'])
        
        record = MagicMock()
        record.body = json.dumps(sample_sqs_record)
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'validation_failed'

    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message')
    def test_skips_duplicate_feedback(
        self, mock_validate, mock_process, mock_write, sample_sqs_record
    ):
        """Skips duplicate feedback."""
        from processor.handler import record_handler
        from unittest.mock import MagicMock
        
        mock_validate.return_value = (sample_sqs_record, [])
        mock_process.return_value = None  # Indicates duplicate
        
        record = MagicMock()
        record.body = json.dumps(sample_sqs_record)
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'duplicate'
        mock_write.assert_not_called()
