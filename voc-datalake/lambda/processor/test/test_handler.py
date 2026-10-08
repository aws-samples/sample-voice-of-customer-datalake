"""Tests for processor/handler.py

The seams between this Lambda and `shared.categorization`: the Comprehend and
Translate wrappers, the real validation/LLM/categories-config paths with only the
AWS clients stubbed, and the optional provenance fields a processed item carries.
The exact persisted shape, every log line and metric, and the module's wiring are
pinned in `test_handler_mutation.py`.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from processor.test.sqs_fixtures import sqs_record
from shared.converse import BedrockThrottlingError


@pytest.fixture
def happy_enrichment(sample_sqs_record, sample_llm_insights):
    """Every enrichment stage stubbed to succeed: not a duplicate, English,
    text unchanged, positive sentiment, and the sample insights from the model."""
    with patch('processor.handler.check_duplicate', return_value=False), \
         patch('processor.handler.detect_language', return_value='en'), \
         patch('processor.handler.translate_text', return_value=sample_sqs_record['text']), \
         patch('processor.handler.get_comprehend_sentiment',
               return_value={'label': 'positive', 'score': 0.8}), \
         patch('processor.handler.invoke_bedrock_llm',
               return_value={'insights': sample_llm_insights, 'metadata': {}}):
        yield


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


class TestValidateSqsMessage:
    """Tests for validate_sqs_message() function."""

    def test_validates_with_the_bundled_shared_schema(self):
        """The processor's validator is the shared/ one its bundle ships (#249)."""
        import processor.handler as handler
        import shared.ingest_schemas as ingest_schemas

        assert handler.safe_validate_message is ingest_schemas.safe_validate_message

    def test_there_is_no_switch_that_disables_validation(self):
        """A silent VALIDATION_ENABLED=False was the #249 failure mode."""
        import processor.handler as handler

        assert not hasattr(handler, 'VALIDATION_ENABLED')

    @patch('processor.handler.log_validation_failure')
    def test_returns_errors_for_an_invalid_message(self, mock_log):
        from processor.handler import validate_sqs_message

        result, errors = validate_sqs_message({'id': '123', 'text': 'Test'})

        assert result is None
        assert any('source_platform' in e for e in errors)
        mock_log.assert_called_once()

    def test_returns_the_validated_record_for_a_valid_message(self, sample_sqs_record):
        from processor.handler import validate_sqs_message

        result, errors = validate_sqs_message(sample_sqs_record)

        assert errors == []
        assert result is not None
        assert result['id'] == sample_sqs_record['id']

    @patch('processor.handler.log_validation_failure')
    def test_logs_a_rejected_source_platform_without_its_key_separator(self, mock_log):
        """The rejected value becomes part of LOGS#validation#<source>: a '#' must not split that key."""
        from processor.handler import validate_sqs_message
        from shared.ingest_schemas import MAX_SOURCE_PLATFORM_LENGTH

        validate_sqs_message({'id': '1', 'text': 'x', 'source_platform': 'a#b' + 'c' * 400})

        logged_platform = mock_log.call_args.args[0]
        assert '#' not in logged_platform
        assert logged_platform.startswith('a_b')
        assert len(logged_platform) == MAX_SOURCE_PLATFORM_LENGTH

    @patch('processor.handler.aggregates_table')
    def test_a_rejected_record_leaves_no_pii_in_its_log_row_or_errors(self, mock_table):
        """Decision 3: `/logs/*` is readable by every user, so the stored row says what
        the record looked like (keys, text length) — never its values. The metadata
        key below makes pydantic's own message embed the email."""
        from processor.handler import MASKED_SEGMENT, validate_sqs_message

        planted = {
            'id': 'msg-pii',
            'text': 'My name is Jane Doe, call me',
            'submitter_email': 'jane.doe@example.com',
            'submitter_name': 'Jane Doe',
            'jane.doe@example.com': 'top-level key that is itself PII',
            'metadata': {'jane.doe@example.com' + 'x' * 60: 'v'},
        }

        _, errors = validate_sqs_message(planted)

        item = mock_table.put_item.call_args.kwargs['Item']
        stored = json.dumps(item, default=str).lower()
        for secret in ('jane', 'example.com', 'call me'):
            assert secret not in stored
            assert secret not in ' '.join(errors).lower()
        assert 'raw_preview' not in item
        assert item['text_length'] == len(planted['text'])
        assert item['record_keys'] == sorted(
            {MASKED_SEGMENT, 'id', 'metadata', 'submitter_email', 'submitter_name', 'text'})
        assert 'source_platform: missing' in item['errors']
        assert 'metadata: value_error' in item['errors']


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


    @pytest.mark.usefixtures("happy_enrichment")
    def test_persists_ingestion_method_when_sent(self, sample_sqs_record):
        """Carries ingestion_method provenance to the persisted item (#145)."""
        from processor.handler import process_feedback

        sample_sqs_record['ingestion_method'] = 'csv_upload'

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert result['ingestion_method'] == 'csv_upload'

    @pytest.mark.usefixtures("happy_enrichment")
    def test_omits_ingestion_method_when_not_sent(self, sample_sqs_record):
        """Sources that don't send ingestion_method must not gain a spurious
        or empty field (None-stripping keeps the record shape unchanged)."""
        from processor.handler import process_feedback

        assert 'ingestion_method' not in sample_sqs_record

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert 'ingestion_method' not in result

    @pytest.mark.usefixtures("happy_enrichment")
    @pytest.mark.parametrize('sent', [
        {'kind': 'issue', 'repo': 'acme/Kiro', 'number': 7, 'software_version': '0.4.2', 'labels': ['bug']},
        None,
    ])
    def test_persists_issue_attributes_only_when_sent(self, sample_sqs_record, sent):
        """github_issues' structured fields (version, labels, …) reach the stored item
        as one map, read by /metrics/github; other sources gain no attribute."""
        from processor.handler import process_feedback

        if sent is not None:
            sample_sqs_record['issue_attributes'] = sent

        result = process_feedback(sample_sqs_record)
        assert result is not None
        assert result.get('issue_attributes') == sent
        assert ('issue_attributes' in result) is (sent is not None)

    @pytest.mark.usefixtures("happy_enrichment")
    @pytest.mark.parametrize(('sent', 'expected'), [
        ('s3://voc-raw-data-1-us-east-1/raw/webscraper/2026/01/02/abc.json',
         's3://voc-raw-data-1-us-east-1/raw/webscraper/2026/01/02/abc.json'),
        (None, None),
    ])
    def test_persists_the_raw_object_uri_for_raw_reprocess(self, sample_sqs_record, sent, expected):
        """The category-reprocess worker's raw mode re-reads the archived object
        from `s3_raw_uri`; a record without one gains no null attribute."""
        from processor.handler import process_feedback

        if sent is not None:
            sample_sqs_record['s3_raw_uri'] = sent

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert result.get('s3_raw_uri') == expected
        assert ('s3_raw_uri' in result) is (expected is not None)

    @pytest.mark.usefixtures("happy_enrichment")
    def test_persists_csv_row_id_when_sent(self, sample_sqs_record):
        """
        A CSV `id` column is unique only within its file, so it cannot key the
        item — but an operator still needs to look a record up by it, so it is
        persisted alongside the derived id rather than discarded.
        """
        from processor.handler import process_feedback

        sample_sqs_record['csv_row_id'] = '4711'

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert result['csv_row_id'] == '4711'
        assert result['source_id'] != '4711'

    @pytest.mark.usefixtures("happy_enrichment")
    def test_omits_csv_row_id_when_not_sent(self, sample_sqs_record):
        """Non-CSV sources must not gain an empty provenance field."""
        from processor.handler import process_feedback

        assert 'csv_row_id' not in sample_sqs_record

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert 'csv_row_id' not in result

    @pytest.mark.usefixtures("happy_enrichment")
    def test_uses_preset_category_when_provided(self, sample_sqs_record):
        """Uses preset_category from feedback form instead of LLM result."""
        from processor.handler import process_feedback


        sample_sqs_record['preset_category'] = 'billing'

        result = process_feedback(sample_sqs_record)
        assert result is not None

        assert result['category'] == 'billing'


class TestLogValidationFailure:
    """Tests for log_validation_failure() function."""

    @patch('processor.handler.aggregates_table')
    def test_bounds_the_message_id(self, mock_table):
        from processor.handler import MAX_LOGGED_MESSAGE_ID_LENGTH, log_validation_failure

        log_validation_failure('webscraper', 'm' * 1000, ['e: missing'], {'record_keys': []})

        item = mock_table.put_item.call_args.kwargs['Item']
        assert len(item['message_id']) == MAX_LOGGED_MESSAGE_ID_LENGTH


class TestLogProcessingError:
    """Tests for log_processing_error() function."""

    @patch('processor.handler.aggregates_table')
    def test_stores_a_fixed_message_never_the_exception_text(self, mock_table):
        from processor.handler import PROCESSING_FAILED_MESSAGE, log_processing_error

        log_processing_error('webscraper', 'msg-123', KeyError('Jane Doe <jane.doe@example.com>'))

        item = mock_table.put_item.call_args.kwargs['Item']
        assert item['error_type'] == 'KeyError'
        assert item['error_message'] == PROCESSING_FAILED_MESSAGE
        assert 'jane' not in json.dumps(item, default=str).lower()


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


class TestRecordHandler:
    """Tests for record_handler() function."""

    @pytest.mark.parametrize('make_error', [
        pytest.param(lambda: RuntimeError('boom for Jane Doe <jane.doe@example.com>'), id='unexpected'),
        pytest.param(lambda: BedrockThrottlingError('throttled for jane.doe@example.com'), id='throttled'),
    ])
    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.aggregates_table')
    @patch('processor.handler.process_feedback')
    def test_a_failed_record_logs_the_error_type_not_its_text(
        self, mock_process, mock_table, make_error, sample_sqs_record
    ):
        """Both call sites hand the exception over; the row keeps its class name only."""
        from processor.handler import record_handler

        error = make_error()
        mock_process.side_effect = error
        record = MagicMock()
        record.body = json.dumps(sample_sqs_record)

        with pytest.raises(type(error)):
            record_handler(record)

        item = mock_table.put_item.call_args.kwargs['Item']
        assert item['error_type'] == type(error).__name__
        assert 'jane' not in json.dumps(item, default=str).lower()

    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message')
    def test_fails_an_invalid_message_instead_of_skipping_it(
        self, mock_validate, mock_process, mock_write, sample_sqs_record
    ):
        """A rejected message must fail the record so SQS retries then DLQs it (#249)."""
        from processor.handler import MessageRejectedError, record_handler

        mock_validate.return_value = (None, ['text: Field required'])

        record = MagicMock()
        record.body = json.dumps(sample_sqs_record)

        with pytest.raises(MessageRejectedError, match='text: Field required'):
            record_handler(record)
        mock_process.assert_not_called()
        mock_write.assert_not_called()

    @patch('processor.handler.persistence_layer', None)
    @patch('processor.handler.idempotency_config', None)
    @patch('processor.handler.log_validation_failure')
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    def test_an_invalid_message_is_reported_as_a_batch_item_failure(
        self, mock_process, mock_write, mock_log, lambda_context, sample_sqs_record
    ):
        """End to end through the BatchProcessor: the invalid record's messageId
        is in batchItemFailures (kept on the queue → DLQ), not silently deleted,
        while its valid neighbour is processed. (A batch in which EVERY record
        fails raises instead — Powertools' all-failed rule — which SQS also
        retries.)"""
        from processor.handler import lambda_handler

        mock_process.return_value = {'feedback_id': 'ok', 'llm_metadata': {}}

        event = {'Records': [
            sqs_record('msg-invalid', {'id': 'x', 'text': 'no platform', 'created_at': '2025-01-01T00:00:00Z'}),
            sqs_record('msg-valid', sample_sqs_record),
        ]}

        response = lambda_handler(event, lambda_context)

        assert response == {'batchItemFailures': [{'itemIdentifier': 'msg-invalid'}]}
        mock_write.assert_called_once()
        mock_log.assert_called_once()
