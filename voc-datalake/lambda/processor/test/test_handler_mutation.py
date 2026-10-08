"""Mutation hardening for `processor/handler.py`.

`test_handler.py` pins that the processor validates (rejecting into the DLQ, #249),
deduplicates, enriches and writes a feedback item, but a mutation run found 202
of 302 mutants it cannot see. They fall into five groups, each pinned here with
literals:

* MODULE-LEVEL WIRING. Nothing re-imported the module, so the (now unconditional,
  #249) `shared.ingest_schemas` import, the two boto3 clients, the two table
  handles, the idempotency layer/config (3600 s, local cache of 256) and the
  warning logged when `IDEMPOTENCY_TABLE` is missing were all unobserved.
  `reload_handler` imports a fresh copy under controlled env/patches and puts
  the original back.
* THE PERSISTED SHAPE. Earlier tests asserted `'pk' in result`; a mutated key
  (`XXgsi1skXX`), a mutated prefix (`DATE#` → `XXDATE#…XX`) or a mutated
  default (`'unknown'`) passed. Every item, log row and handler response is
  compared whole, with the clock pinned.
* IDS. The fallback id's inputs (text[:500], 16-char text hash, created_at,
  url) and both branches' exact hashes were never pinned as literals.
* LOG LINES AND METRICS. Every `logger.*` message and `metrics.add_metric(...)`
  call is asserted with its exact text, unit and value.
* CACHE AND DECORATORS. The 300 s categories-cache TTL boundary, the cached
  empty result, each `@tracer.capture_method` subsegment name, and the
  idempotency wrapper actually consulting its store.
"""
import hashlib
import importlib
import json
import os
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import MagicMock, call, patch

import boto3
import pytest
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType
from aws_lambda_powertools.utilities.idempotency import DynamoDBPersistenceLayer, IdempotencyConfig
from aws_lambda_powertools.utilities.idempotency.exceptions import IdempotencyAlreadyInProgressError
from botocore.exceptions import ClientError
from moto import mock_aws

from processor import handler
from processor.test.sqs_fixtures import sqs_record
from shared.converse import BedrockThrottlingError

FIXED_NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
FIXED_ISO = '2026-01-02T03:04:05+00:00'
FIXED_TS = int(FIXED_NOW.timestamp())
SEVEN_DAYS = 604800

# The first 32 hex chars of sha256 over 'webscraper:review-123'.
ID_WEBSCRAPER_REVIEW_123 = '61ff1befdd7b5868216a90e6def29443'
# Over 'webscraper:test-source-id-123' — the conftest sample record.
ID_SAMPLE_RECORD = '67271e70944d7062cbf8e3607cdeeadb'
# Over 'unknown:::' — every input empty.
ID_ALL_EMPTY = 'c647fb164d5ba84e14e108cad5a2eca1'
# Over 'webscraper:2025-01-15T10:00:00Z:375c807c96eef9e5:https://example.com/review'.
ID_FALLBACK = '166cd4eef714968d85419ba2db5251a0'
# Over 'webscraper:2025-01-15T10:00:00Z::https://example.com/review' — no text.
ID_FALLBACK_NO_TEXT = '95e57d3f1677f88bf60696c01263729f'
TEXT_HASH_GREAT_PRODUCT = '375c807c96eef9e5'


def _client_error(operation: str) -> ClientError:
    return ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'boom'}}, operation)


def _string_attribute(row: Mapping[str, Mapping[str, object]], name: str) -> str:
    """The `S` value of one attribute of a low-level DynamoDB item, narrowed to `str`."""
    value = row[name].get('S')
    assert isinstance(value, str)
    return value


@pytest.fixture
def fixed_clock():
    with patch('processor.handler.datetime') as dt:
        dt.now.return_value = FIXED_NOW
        yield dt


@pytest.fixture
def log():
    with patch('processor.handler.logger') as logger:
        yield logger


@pytest.fixture
def metrics():
    with patch('processor.handler.metrics') as metrics:
        yield metrics


# ============================================
# Module-level wiring
# ============================================

@pytest.fixture
def reload_handler():
    """Import a fresh `processor.handler` under the caller's env/patches, then restore the original."""
    original = sys.modules['processor.handler']
    package = sys.modules['processor']

    def _reload():
        sys.modules.pop('processor.handler', None)
        return importlib.import_module('processor.handler')

    yield _reload
    sys.modules['processor.handler'] = original
    vars(package)['handler'] = original


class TestModuleWiring:
    def test_leaves_sys_path_alone(self, reload_handler):
        """#249: the schema lives in the bundled `shared/`; nothing adds plugins/ to the path."""
        with patch.object(sys, 'path', list(sys.path)):
            before = list(sys.path)
            reload_handler()
            assert sys.path == before

    def test_validation_uses_the_bundled_shared_schema(self, reload_handler):
        from shared.ingest_schemas import safe_validate_message

        fresh = reload_handler()

        assert fresh.safe_validate_message is safe_validate_message
        assert not hasattr(fresh, 'VALIDATION_ENABLED')

    def test_a_missing_schema_fails_the_import_instead_of_disabling_validation(self, reload_handler):
        with patch.dict(sys.modules, {'shared.ingest_schemas': None}), \
             patch('shared.logging.logger') as logger, \
             pytest.raises(ImportError, match=r'shared\.ingest_schemas'):
            reload_handler()

        logger.warning.assert_not_called()

    def test_binds_comprehend_and_translate_clients(self, reload_handler):
        clients = {'comprehend': MagicMock(name='comprehend'), 'translate': MagicMock(name='translate')}
        with patch('boto3.client', side_effect=lambda name: clients[name]) as client:
            fresh = reload_handler()

        assert client.call_args_list == [call('comprehend'), call('translate')]
        assert fresh.comprehend is clients['comprehend']
        assert fresh.translate is clients['translate']

    def test_binds_the_feedback_and_aggregates_tables_from_the_env(self, reload_handler):
        tables = {'fb-table': MagicMock(name='feedback'), 'agg-table': MagicMock(name='aggregates')}
        resource = MagicMock()
        resource.Table.side_effect = lambda name: tables[name]
        with patch.dict(os.environ, {'FEEDBACK_TABLE': 'fb-table', 'AGGREGATES_TABLE': 'agg-table'}), \
             patch('shared.aws.get_dynamodb_resource', return_value=resource):
            fresh = reload_handler()

        assert resource.Table.call_args_list == [call('fb-table'), call('agg-table')]
        assert fresh.FEEDBACK_TABLE == 'fb-table'
        assert fresh.AGGREGATES_TABLE == 'agg-table'
        assert fresh.feedback_table is tables['fb-table']
        assert fresh.aggregates_table is tables['agg-table']

    @pytest.mark.parametrize(('env', 'expected'), [({'PRIMARY_LANGUAGE': 'fr'}, 'fr'), ({}, 'en')])
    def test_primary_language_comes_from_the_env_and_defaults_to_en(self, reload_handler, env, expected):
        with patch.dict(os.environ, env):
            if not env:
                os.environ.pop('PRIMARY_LANGUAGE', None)
            fresh = reload_handler()

        assert expected == fresh.PRIMARY_LANGUAGE

    def test_configures_idempotency_for_one_hour_with_a_local_cache_of_256(self, reload_handler):
        layer = MagicMock(name='layer')
        config = MagicMock(name='config')
        with patch.dict(os.environ, {'IDEMPOTENCY_TABLE': 'idem-table'}), \
             patch('shared.idempotency.get_persistence_layer', return_value=layer) as get_layer, \
             patch('shared.idempotency.get_idempotency_config', return_value=config) as get_config, \
             patch('shared.logging.logger') as logger:
            fresh = reload_handler()

        assert fresh.IDEMPOTENCY_TABLE == 'idem-table'
        get_layer.assert_called_once_with('idem-table')
        get_config.assert_called_once_with(expires_after_seconds=3600, use_local_cache=True, local_cache_max_items=256)
        assert fresh.persistence_layer is layer
        assert fresh.idempotency_config is config
        logger.warning.assert_not_called()

    def test_without_an_idempotency_table_duplicate_protection_is_off_with_a_warning(self, reload_handler):
        with patch.dict(os.environ, {}, clear=False), \
             patch('shared.idempotency.get_persistence_layer') as get_layer, \
             patch('shared.idempotency.get_idempotency_config') as get_config, \
             patch('shared.logging.logger') as logger:
            os.environ.pop('IDEMPOTENCY_TABLE', None)
            fresh = reload_handler()

        assert fresh.IDEMPOTENCY_TABLE == ''
        assert fresh.persistence_layer is None
        assert fresh.idempotency_config is None
        get_layer.assert_not_called()
        get_config.assert_not_called()
        assert logger.warning.call_args_list == [
            call("IDEMPOTENCY_TABLE not configured - duplicate protection disabled"),
        ]

    def test_starts_with_an_empty_categories_cache(self, reload_handler):
        fresh = reload_handler()

        assert fresh._categories_cache is None
        assert fresh._categories_cache_time is None
        assert fresh.CATEGORIES_CACHE_TTL == 300

    def test_batch_processor_is_an_sqs_processor(self):
        assert isinstance(handler.processor, BatchProcessor)
        assert handler.processor.event_type is EventType.SQS

    @pytest.mark.parametrize(('function_name', 'args', 'subsegments'), [
        ('get_categories_config', (), ['get_categories_config']),
        ('check_duplicate', ('p', 'f'), ['check_duplicate']),
        ('process_feedback', ({},), ['process_feedback', 'check_duplicate', 'get_categories_config']),
    ])
    def test_traced_functions_open_a_named_subsegment(self, function_name, args, subsegments):
        traced = getattr(handler, function_name)
        assert traced.__wrapped__.__name__ == function_name
        with patch.object(handler.tracer, 'provider') as provider, \
             patch.object(handler, '_categories_cache', [{'name': 'x'}]), \
             patch.object(handler, '_categories_cache_time', datetime.now(UTC).timestamp()), \
             patch('processor.handler.feedback_table') as table, \
             patch('processor.handler.run_enrichment') as enrichment:
            table.get_item.return_value = {}
            enrichment.return_value = MagicMock(
                attributes={'category': 'c', 'urgency': 'u', 'sentiment_score': Decimal('0')},
                llm_result={},
            )
            traced(*args)

        assert provider.in_subsegment.call_args_list == [
            call(name=f'## processor.handler.{name}') for name in subsegments
        ]


def _fail_b_by_id(record: dict) -> dict:
    """`process_feedback` stand-in: record `b` raises, the others become items."""
    if record['id'] == 'b':
        raise ValueError('boom')
    return {'feedback_id': f"f{record['id']}"}


class TestLambdaHandler:
    def test_reports_only_the_records_that_raised(self):
        event = {'Records': [
            sqs_record('m1', {'id': 'a', 'source_platform': 'webscraper'}),
            sqs_record('m2', {'id': 'b', 'source_platform': 'webscraper'}),
            sqs_record('m3', {'id': 'c', 'source_platform': 'webscraper'}),
        ]}
        context = MagicMock(
            function_name='voc-processor', memory_limit_in_mb=512, aws_request_id='req-1',
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-processor',
        )
        with patch('processor.handler.persistence_layer', None), \
             patch('processor.handler.idempotency_config', None), \
             patch('processor.handler.validate_sqs_message', side_effect=lambda r: (r, [])), \
             patch('processor.handler.process_feedback',
                   # Keyed by record, not by call order: records run concurrently.
                   side_effect=_fail_b_by_id), \
             patch('processor.handler.write_to_dynamodb') as write, \
             patch('processor.handler.log_processing_error'):
            response = handler.lambda_handler(event, context)

        assert response == {'batchItemFailures': [{'itemIdentifier': 'm2'}]}
        assert write.call_args_list == [call({'feedback_id': 'fa'}), call({'feedback_id': 'fc'})]


# ============================================
# Validation / processing error log rows
# ============================================

class TestLogValidationFailureRow:
    """The row is readable by every signed-in user: identity, redacted errors and the
    record's shape — never a raw preview (owner decision 3, 2026-10-04)."""

    @pytest.mark.usefixtures('fixed_clock')
    @patch('processor.handler.aggregates_table')
    def test_writes_the_exact_row_with_a_32_char_message_id_in_the_sort_key(self, table, log):
        message_id = 'm' * 40
        handler.log_validation_failure(
            'webscraper', message_id, ['text: missing'], {'record_keys': ['id'], 'text_length': 7},
        )

        table.put_item.assert_called_once_with(Item={
            'pk': 'LOGS#validation#webscraper',
            'sk': f"{FIXED_ISO}#{'m' * 32}",
            'log_type': 'validation_failure',
            'source_platform': 'webscraper',
            'message_id': message_id,
            'errors': ['text: missing'],
            'record_keys': ['id'],
            'text_length': 7,
            'timestamp': FIXED_ISO,
            'ttl': FIXED_TS + SEVEN_DAYS,
        })
        assert log.info.call_args_list == [call(f"Logged validation failure for webscraper/{message_id}")]
        log.warning.assert_not_called()

    @pytest.mark.usefixtures('fixed_clock')
    @patch('processor.handler.aggregates_table')
    def test_keeps_exactly_128_message_id_characters_and_stringifies_it(self, table, log):
        handler.log_validation_failure('webscraper', 'x' * 129, ['e'], {'record_keys': []})
        handler.log_validation_failure('webscraper', 12345, ['e'], {'record_keys': []})

        first, second = (c.kwargs['Item'] for c in table.put_item.call_args_list)
        assert first['message_id'] == 'x' * 128
        assert first['sk'] == f"{FIXED_ISO}#{'x' * 32}"
        assert second['message_id'] == '12345'
        assert second['sk'] == f"{FIXED_ISO}#12345"
        assert log.info.call_args_list[0] == call(f"Logged validation failure for webscraper/{'x' * 128}")

    @patch('processor.handler.aggregates_table')
    def test_a_failed_write_is_logged_with_its_error(self, table, log):
        error = _client_error('PutItem')
        table.put_item.side_effect = error

        assert handler.log_validation_failure('webscraper', 'msg', ['e'], {'record_keys': []}) is None

        assert log.exception.call_args_list == [call(f"Failed to log validation failure: {error}")]
        log.info.assert_not_called()

    @patch('processor.handler.aggregates_table', None)
    def test_without_a_table_it_warns_and_writes_nothing(self, log):
        assert handler.log_validation_failure('webscraper', 'msg', ['e'], {'record_keys': []}) is None

        assert log.warning.call_args_list == [
            call("Cannot log validation failure - aggregates table not configured"),
        ]
        log.info.assert_not_called()


class TestLogProcessingErrorRow:
    """The exception's class name and a fixed message — never `str(error)`."""

    @pytest.mark.usefixtures('fixed_clock')
    @patch('processor.handler.aggregates_table')
    def test_writes_the_exact_row_with_a_32_char_message_id_in_the_sort_key(self, table, log):
        message_id = 'm' * 40
        handler.log_processing_error('webscraper', message_id, BedrockThrottlingError('Rate exceeded'))

        table.put_item.assert_called_once_with(Item={
            'pk': 'LOGS#processing#webscraper',
            'sk': f"{FIXED_ISO}#{'m' * 32}",
            'log_type': 'processing_error',
            'source_platform': 'webscraper',
            'message_id': message_id,
            'error_type': 'BedrockThrottlingError',
            'error_message': 'Bedrock throttled the request; SQS will retry the message',
            'timestamp': FIXED_ISO,
            'ttl': FIXED_TS + SEVEN_DAYS,
        })
        log.exception.assert_not_called()

    @pytest.mark.usefixtures('fixed_clock')
    @patch('processor.handler.aggregates_table')
    def test_any_other_error_stores_its_type_and_the_fixed_message_only(self, table):
        handler.log_processing_error('webscraper', 'msg', ValueError('e' * 1001))

        item = table.put_item.call_args.kwargs['Item']
        assert item['error_type'] == 'ValueError'
        assert item['error_message'] == 'Processing failed; details are in the processor CloudWatch logs'
        assert 'e' * 20 not in json.dumps(item)

    @patch('processor.handler.aggregates_table')
    def test_a_failed_write_is_logged_with_its_error(self, table, log):
        error = _client_error('PutItem')
        table.put_item.side_effect = error

        assert handler.log_processing_error('webscraper', 'msg', ValueError('e')) is None

        assert log.exception.call_args_list == [call(f"Failed to log processing error: {error}")]

    @patch('processor.handler.aggregates_table', None)
    def test_without_a_table_it_is_silent(self, log):
        assert handler.log_processing_error('webscraper', 'msg', ValueError('e')) is None

        log.warning.assert_not_called()
        log.exception.assert_not_called()


# ============================================
# validate_sqs_message
# ============================================

class TestValidateSqsMessage:
    @patch('processor.handler.metrics')
    @patch('processor.handler.log_validation_failure')
    def test_a_rejected_message_is_logged_with_its_identity_and_shape_not_its_text(self, log_failure, metrics):
        # Valid for the real schema, so the re-derived (redacted) errors fall back to the generic one.
        raw = {'id': 'msg-1', 'source_platform': 'webscraper', 'text': 't' * 600}
        with patch('processor.handler.safe_validate_message', return_value=(None, ['text too long'])) as validate:
            assert handler.validate_sqs_message(raw) == (None, ['(message): invalid'])

        validate.assert_called_once_with(raw)
        log_failure.assert_called_once_with(
            'webscraper', 'msg-1', ['(message): invalid'],
            {'record_keys': ['id', 'source_platform', 'text'], 'text_length': 600},
        )
        metrics.add_metric.assert_called_once_with(name="ValidationFailures", unit="Count", value=1)

    @patch('processor.handler.metrics')
    @patch('processor.handler.log_validation_failure')
    def test_a_rejected_message_without_identity_is_logged_as_unknown(self, log_failure, metrics):
        raw = {'text': 'hello'}
        with patch('processor.handler.safe_validate_message', return_value=(None, ['missing id'])):
            assert handler.validate_sqs_message(raw) == (None, ['id: missing', 'source_platform: missing'])

        log_failure.assert_called_once_with(
            'unknown', 'unknown', ['id: missing', 'source_platform: missing'],
            {'record_keys': ['text'], 'text_length': 5},
        )
        metrics.add_metric.assert_called_once_with(name="ValidationFailures", unit="Count", value=1)

    @patch('processor.handler.metrics')
    @patch('processor.handler.log_validation_failure')
    def test_no_model_and_no_errors_is_still_a_rejection(self, log_failure, metrics):
        with patch('processor.handler.safe_validate_message', return_value=(None, [])):
            assert handler.validate_sqs_message({'id': 'x'}) == (None, ['message did not validate'])

        log_failure.assert_not_called()
        metrics.add_metric.assert_not_called()

    @patch('processor.handler.metrics')
    @patch('processor.handler.log_validation_failure')
    def test_a_valid_message_is_dumped_as_json_without_none_values(self, log_failure, metrics):
        model = MagicMock()
        model.model_dump.return_value = {'id': 'x', 'text': 'hello'}
        with patch('processor.handler.safe_validate_message', return_value=(model, [])):
            assert handler.validate_sqs_message({'id': 'x', 'text': 'hello', 'url': None}) == (
                {'id': 'x', 'text': 'hello'}, [],
            )

        model.model_dump.assert_called_once_with(mode='json', exclude_none=True)
        log_failure.assert_not_called()
        metrics.add_metric.assert_not_called()

    def test_the_real_schema_accepts_the_sample_record(self, sample_sqs_record):
        validated, errors = handler.validate_sqs_message(sample_sqs_record)

        assert errors == []
        assert validated is not None
        assert validated['id'] == 'test-source-id-123'
        assert validated['source_platform'] == 'webscraper'

    def test_validation_always_runs_there_is_no_switch(self):
        raw = {'id': 'x', 'text': 'hello'}
        model = MagicMock()
        model.model_dump.return_value = {'id': 'x', 'text': 'hello'}
        with patch('processor.handler.safe_validate_message', return_value=(model, [])) as validator:
            assert handler.validate_sqs_message(raw) == ({'id': 'x', 'text': 'hello'}, [])

        validator.assert_called_once_with(raw)
        assert not hasattr(handler, 'VALIDATION_ENABLED')

    @patch('processor.handler.log_validation_failure')
    def test_a_rejected_source_platform_is_key_safe_and_bounded_to_256(self, log_failure):
        handler.validate_sqs_message({'id': '1', 'text': 'x', 'source_platform': 'a#b' + 'c' * 300})

        assert log_failure.call_args.args[0] == 'a_b' + 'c' * 253


# ============================================
# Categories cache
# ============================================

@pytest.fixture
def empty_categories_cache():
    with patch('processor.handler._categories_cache', None), \
         patch('processor.handler._categories_cache_time', None):
        yield


CATEGORIES = [{'name': 'shipping', 'description': 'Shipping'}, {'name': 'returns', 'description': 'Returns'}]


def _assert_two_reads_load_once_and_cache(load: MagicMock, expected: list) -> None:
    """Read the config twice: both answer `expected`, one load, and the cache holds it with its load time."""
    assert handler.get_categories_config() == expected
    assert handler.get_categories_config() == expected

    load.assert_called_once_with(handler.aggregates_table)
    assert handler._categories_cache == expected
    assert handler._categories_cache_time == FIXED_NOW.timestamp()


@pytest.mark.usefixtures('empty_categories_cache', 'fixed_clock')
class TestCategoriesCache:
    @patch('processor.handler.load_categories_config', return_value=CATEGORIES)
    def test_a_loaded_config_is_cached_with_its_load_time(self, load, log):
        _assert_two_reads_load_once_and_cache(load, CATEGORIES)
        assert log.info.call_args_list == [call("Loaded 2 categories from DynamoDB")]
        log.warning.assert_not_called()

    @patch('processor.handler.load_categories_config', return_value=[])
    def test_an_empty_config_is_cached_too_with_a_warning(self, load, log):
        _assert_two_reads_load_once_and_cache(load, [])
        assert log.warning.call_args_list == [call("No categories configured - will use defaults")]
        log.info.assert_not_called()

    @patch('processor.handler.load_categories_config')
    def test_a_failed_load_is_cached_as_empty_with_its_error(self, load, log):
        error = _client_error('GetItem')
        load.side_effect = error

        _assert_two_reads_load_once_and_cache(load, [])
        assert log.exception.call_args_list == [call(f"Could not fetch categories from DynamoDB: {error}")]

    @pytest.mark.parametrize(('age_seconds', 'reloads'), [(299.999, False), (300, True), (300.001, True)])
    @patch('processor.handler.load_categories_config', return_value=CATEGORIES)
    def test_the_cache_lives_for_strictly_less_than_300_seconds(self, load, age_seconds, reloads):
        stale = [{'name': 'stale'}]
        with patch('processor.handler._categories_cache', stale), \
             patch('processor.handler._categories_cache_time', FIXED_NOW.timestamp() - age_seconds):
            result = handler.get_categories_config()

        assert result == (CATEGORIES if reloads else stale)
        assert load.call_count == (1 if reloads else 0)

    @patch('processor.handler.load_categories_config', return_value=CATEGORIES)
    def test_a_cache_without_a_load_time_is_reloaded(self, load):
        with patch('processor.handler._categories_cache', [{'name': 'stale'}]), \
             patch('processor.handler._categories_cache_time', None):
            assert handler.get_categories_config() == CATEGORIES

        load.assert_called_once_with(handler.aggregates_table)


class TestInvokeBedrockLlm:
    @pytest.mark.parametrize(('kwargs', 'raise_on_throttle'), [({}, True), ({'raise_on_throttle': False}, False)])
    @patch('processor.handler.build_categories_instruction', return_value='CATEGORIES')
    @patch('processor.handler.invoke_enrichment_llm', return_value={'insights': {}, 'metadata': {}})
    def test_passes_the_categories_instruction_and_re_raises_throttling_by_default(
        self, enrich, instruction, kwargs, raise_on_throttle,
    ):
        record = {'id': 'x', 'text': 'hello'}

        assert handler.invoke_bedrock_llm(record, **kwargs) == {'insights': {}, 'metadata': {}}

        instruction.assert_called_once_with()
        enrich.assert_called_once_with(
            record, 'CATEGORIES', converse_fn=handler.converse, raise_on_throttle=raise_on_throttle,
            dimensions_config=[],
        )


# ============================================
# Deterministic ids
# ============================================

class TestDeterministicId:
    def test_source_id_branch_hashes_platform_colon_id(self, log):
        assert handler.generate_deterministic_id('webscraper', 'review-123') == ID_WEBSCRAPER_REVIEW_123
        assert hashlib.sha256(b'webscraper:review-123').hexdigest()[:32] == ID_WEBSCRAPER_REVIEW_123
        log.info.assert_not_called()

    def test_fallback_branch_hashes_platform_date_text_hash_and_url(self, log):
        result = handler.generate_deterministic_id(
            'webscraper', '', 'Great product!', '2025-01-15T10:00:00Z', 'https://example.com/review',
        )

        assert result == ID_FALLBACK
        assert hashlib.sha256(
            b'webscraper:2025-01-15T10:00:00Z:' + TEXT_HASH_GREAT_PRODUCT.encode() + b':https://example.com/review'
        ).hexdigest()[:32] == ID_FALLBACK
        assert hashlib.sha256(b'Great product!').hexdigest()[:16] == TEXT_HASH_GREAT_PRODUCT
        assert log.info.call_args_list == [
            call(f"Generated fallback ID for webscraper (no source_id): text_hash={TEXT_HASH_GREAT_PRODUCT}"),
        ]

    def test_fallback_without_text_has_an_empty_text_hash(self, log):
        result = handler.generate_deterministic_id(
            'webscraper', '', '', '2025-01-15T10:00:00Z', 'https://example.com/review',
        )

        assert result == ID_FALLBACK_NO_TEXT
        assert log.info.call_args_list == [call("Generated fallback ID for webscraper (no source_id): text_hash=")]

    def test_every_optional_input_defaults_to_empty(self):
        assert handler.generate_deterministic_id('unknown', '') == ID_ALL_EMPTY
        assert handler.generate_deterministic_id('unknown', '', '', '', '') == ID_ALL_EMPTY
        assert hashlib.sha256(b'unknown:::').hexdigest()[:32] == ID_ALL_EMPTY

    def test_only_the_first_500_text_characters_count(self):
        prefix = 'a' * 499
        same_500 = [prefix + 'b' + 'y', prefix + 'b' + 'z']
        differs_at_500 = prefix + 'c' + 'y'

        ids = {handler.generate_deterministic_id('p', '', text, '2025', 'u') for text in same_500}
        assert len(ids) == 1
        assert handler.generate_deterministic_id('p', '', differs_at_500, '2025', 'u') not in ids


class TestCheckDuplicateLogsItsFailure:
    @patch('processor.handler.feedback_table')
    def test_a_failed_lookup_is_logged_and_treated_as_new(self, table, log):
        error = _client_error('GetItem')
        table.get_item.side_effect = error

        assert handler.check_duplicate('webscraper', 'fid') is False

        assert log.warning.call_args_list == [call(f"Duplicate check failed: {error}")]


# ============================================
# process_feedback — the persisted item, whole
# ============================================

PERSONA_ATTRIBUTES = {'inferred_segment': 'loyal_customer', 'confidence': 'high'}


@pytest.fixture
def enrichment_steps(sample_llm_insights):
    with patch('processor.handler.check_duplicate', return_value=False) as dup, \
         patch('processor.handler.detect_language', return_value='en') as detect, \
         patch('processor.handler.translate_text', side_effect=lambda text, _src, _dst: text) as translate, \
         patch('processor.handler.get_comprehend_sentiment', return_value={'label': 'positive', 'score': 0.8}) as sentiment, \
         patch('processor.handler.invoke_bedrock_llm', return_value={
             'insights': sample_llm_insights,
             'metadata': {'model_name': 'haiku', 'prompt_version': 'v9', 'latency_ms': 12},
         }) as llm:
        yield {'dup': dup, 'detect': detect, 'translate': translate, 'sentiment': sentiment, 'llm': llm}


@pytest.mark.usefixtures('fixed_clock')
class TestProcessFeedbackItem:
    def test_the_sample_record_becomes_exactly_this_item(self, enrichment_steps, sample_sqs_record, metrics, log):
        text = sample_sqs_record['text']

        assert handler.process_feedback(sample_sqs_record) == {
            'pk': 'SOURCE#TestBrand',
            'sk': f'FEEDBACK#{ID_SAMPLE_RECORD}',
            'gsi1pk': 'DATE#2026-01-02',
            'gsi1sk': f'{FIXED_ISO}#{ID_SAMPLE_RECORD}',
            'gsi2pk': 'CATEGORY#product_quality',
            'gsi2sk': f'0.85#{FIXED_ISO}',
            'gsi3pk': 'URGENCY#low',
            'gsi3sk': FIXED_ISO,
            'feedback_id': ID_SAMPLE_RECORD,
            'source_id': 'test-source-id-123',
            'source_platform': 'webscraper',
            'source_channel': 'reviews',
            'source_url': 'https://example.com/review/123',
            'brand_name': 'TestBrand',
            'source_created_at': '2025-01-15T10:30:00Z',
            'ingested_at': '2025-01-15T11:00:00Z',
            'processed_at': FIXED_ISO,
            'date': '2026-01-02',
            'original_text': text,
            'rating': Decimal('5'),
            'original_language': 'en',
            'category': 'product_quality',
            'subcategory': 'durability',
            'journey_stage': 'usage',
            'sentiment_label': 'positive',
            'sentiment_score': Decimal('0.85'),
            'urgency': 'low',
            'impact_area': 'product',
            'direct_customer_quote': 'This product is amazing!',
            'persona_name': 'Satisfied Customer',
            'persona_type': 'existing_customer',
            'persona_attributes': PERSONA_ATTRIBUTES,
            'llm_metadata': {'model_name': 'haiku', 'prompt_version': 'v9', 'latency_ms': 12},
        }

        enrichment_steps['dup'].assert_called_once_with('TestBrand', ID_SAMPLE_RECORD)
        enrichment_steps['detect'].assert_called_once_with(text)
        enrichment_steps['translate'].assert_called_once_with(text, 'en', 'en')
        enrichment_steps['sentiment'].assert_called_once_with(text, 'en')
        enrichment_steps['llm'].assert_called_once_with(sample_sqs_record)
        metrics.add_metric.assert_not_called()
        log.info.assert_not_called()

    def test_an_empty_record_falls_back_to_unknown_everywhere(self, enrichment_steps, metrics):
        enrichment_steps['sentiment'].return_value = {'label': 'neutral', 'score': 0.0}
        enrichment_steps['llm'].return_value = {'insights': {}, 'metadata': {'error': 'boom'}}

        assert handler.process_feedback({}) == {
            'pk': 'SOURCE#unknown',
            'sk': f'FEEDBACK#{ID_ALL_EMPTY}',
            'gsi1pk': 'DATE#2026-01-02',
            'gsi1sk': f'{FIXED_ISO}#{ID_ALL_EMPTY}',
            'gsi2pk': 'CATEGORY#other',
            'gsi2sk': f'0.0#{FIXED_ISO}',
            'gsi3pk': 'URGENCY#low',
            'gsi3sk': FIXED_ISO,
            'feedback_id': ID_ALL_EMPTY,
            'source_id': '',
            'source_platform': 'unknown',
            'source_channel': 'unknown',
            'brand_name': 'unknown',
            'processed_at': FIXED_ISO,
            'date': '2026-01-02',
            'original_text': '',
            'original_language': 'en',
            'category': 'other',
            'journey_stage': 'unknown',
            'sentiment_label': 'neutral',
            'sentiment_score': Decimal('0.0'),
            'urgency': 'low',
            'impact_area': 'other',
            'llm_metadata': {'error': 'boom'},
        }

        enrichment_steps['dup'].assert_called_once_with('unknown', ID_ALL_EMPTY)
        enrichment_steps['detect'].assert_called_once_with('')
        metrics.add_metric.assert_not_called()

    def test_without_a_source_id_the_id_comes_from_date_text_and_url(self, enrichment_steps, sample_sqs_record):
        del sample_sqs_record['id']
        sample_sqs_record.update(text='Great product!', created_at='2025-01-15T10:00:00Z', url='https://example.com/review')

        item = handler.process_feedback(sample_sqs_record)

        assert item is not None
        assert item['feedback_id'] == ID_FALLBACK
        assert item['sk'] == f'FEEDBACK#{ID_FALLBACK}'
        assert item['source_id'] == ''
        enrichment_steps['dup'].assert_called_once_with('TestBrand', ID_FALLBACK)

    def test_without_a_brand_the_platform_is_the_partition(self, enrichment_steps, sample_sqs_record):
        del sample_sqs_record['brand_name']

        item = handler.process_feedback(sample_sqs_record)

        assert item is not None
        assert item['pk'] == 'SOURCE#webscraper'
        assert item['brand_name'] == 'webscraper'
        enrichment_steps['dup'].assert_called_once_with('webscraper', ID_SAMPLE_RECORD)

    def test_enrichment_targets_the_configured_primary_language(self, enrichment_steps, sample_sqs_record):
        text = sample_sqs_record['text']
        enrichment_steps['detect'].return_value = 'es'
        enrichment_steps['translate'].side_effect = None
        enrichment_steps['translate'].return_value = 'translated'
        with patch('processor.handler.PRIMARY_LANGUAGE', 'fr'):
            item = handler.process_feedback(sample_sqs_record)

        assert item is not None
        assert item['original_language'] == 'es'
        assert item['normalized_text'] == 'translated'
        enrichment_steps['translate'].assert_called_once_with(text, 'es', 'fr')
        enrichment_steps['sentiment'].assert_called_once_with('translated', 'fr')

    def test_a_duplicate_is_logged_counted_and_skipped_before_enrichment(
        self, enrichment_steps, sample_sqs_record, metrics, log,
    ):
        enrichment_steps['dup'].return_value = True

        assert handler.process_feedback(sample_sqs_record) is None

        assert log.info.call_args_list == [call("Skipping duplicate feedback: TestBrand/test-source-id-123")]
        metrics.add_metric.assert_called_once_with(name="DuplicatesSkipped", unit="Count", value=1)
        enrichment_steps['detect'].assert_not_called()
        enrichment_steps['llm'].assert_not_called()


class TestWriteToDynamodb:
    @patch('processor.handler.feedback_table')
    def test_logs_the_written_id(self, table, log):
        handler.write_to_dynamodb({'feedback_id': 'abc123', 'pk': 'SOURCE#x'})

        table.put_item.assert_called_once_with(Item={'feedback_id': 'abc123', 'pk': 'SOURCE#x'})
        assert log.info.call_args_list == [call("Wrote feedback abc123 to DynamoDB")]


# ============================================
# record_handler — every response and side effect
# ============================================

def _record(body: dict) -> MagicMock:
    record = MagicMock()
    record.body = json.dumps(body)
    return record


def _handle_with_idempotency(body: dict, *, layer: object, config: object, validated: dict) -> dict:
    """Run `record_handler` on `body` with the idempotency store/config set and validation answering `validated`."""
    with patch('processor.handler.persistence_layer', layer), \
         patch('processor.handler.idempotency_config', config), \
         patch('processor.handler.validate_sqs_message', return_value=(validated, [])):
        return handler.record_handler(_record(body))


@pytest.fixture
def no_idempotency():
    with patch('processor.handler.persistence_layer', None), \
         patch('processor.handler.idempotency_config', None):
        yield


@pytest.mark.usefixtures('no_idempotency')
class TestRecordHandlerResponses:
    @pytest.mark.parametrize(('body', 'who'), [
        ({'id': 'test-source-id-123', 'source_platform': 'webscraper'}, 'webscraper/test-source-id-123'),
        ({'text': 'no identity'}, 'unknown/unknown'),
    ])
    @patch('processor.handler.process_feedback')
    @patch('processor.handler.validate_sqs_message', return_value=(None, ['text: missing']))
    def test_a_rejected_message_fails_the_record_with_its_errors(self, validate, process, body, who, log):
        """#249: raise (→ batchItemFailure → DLQ), never return 'skipped'."""
        with pytest.raises(handler.MessageRejectedError) as raised:
            handler.record_handler(_record(body))

        assert str(raised.value) == f"Message {who} failed validation: text: missing"
        assert raised.value.errors == ['text: missing']
        validate.assert_called_once_with(body)
        assert log.warning.call_args_list == [call(f"Validation failed for {who}: ['text: missing']")]
        process.assert_not_called()

    @pytest.mark.parametrize(('validation', 'errors'), [
        ((None, []), ['message did not validate']),
        (({'id': 'x'}, ['odd', 'even']), ['odd', 'even']),
    ])
    @patch('processor.handler.process_feedback')
    def test_either_an_error_or_a_missing_model_rejects(self, process, validation, errors):
        with patch('processor.handler.validate_sqs_message', return_value=validation), \
             pytest.raises(handler.MessageRejectedError) as raised:
            handler.record_handler(_record({'id': 'x', 'source_platform': 'webscraper'}))

        assert raised.value.errors == errors
        assert str(raised.value) == f"Message webscraper/x failed validation: {'; '.join(errors)}"
        process.assert_not_called()

    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback', return_value={'feedback_id': 'fid-1', 'llm_metadata': {'model_name': 'haiku'}})
    def test_a_processed_item_is_written_and_counted_with_llm(self, process, write, metrics, log, sample_sqs_record):
        validated = {**sample_sqs_record, 'validated': True}
        with patch('processor.handler.validate_sqs_message', return_value=(validated, [])):
            result = handler.record_handler(_record(sample_sqs_record))

        assert result == {"status": "success", "feedback_id": 'fid-1'}
        process.assert_called_once_with(validated)
        write.assert_called_once_with({'feedback_id': 'fid-1', 'llm_metadata': {'model_name': 'haiku'}})
        assert metrics.add_metric.call_args_list == [
            call(name="FeedbackProcessed", unit="Count", value=1),
            call(name="FeedbackProcessedWithLLM", unit="Count", value=1),
        ]
        assert log.info.call_args_list == [call("Processing feedback from webscraper/test-source-id-123")]

    @pytest.mark.parametrize(('item', 'second_metric'), [
        ({'feedback_id': 'fid-2', 'llm_metadata': {'error': 'Expecting value'}}, "FeedbackProcessedWithoutLLM"),
        ({'feedback_id': 'fid-2', 'llm_metadata': {}}, "FeedbackProcessedWithLLM"),
        ({'feedback_id': 'fid-2'}, "FeedbackProcessedWithLLM"),
    ])
    @patch('processor.handler.write_to_dynamodb')
    def test_only_an_llm_error_counts_as_processed_without_llm(self, write, metrics, item, second_metric, sample_sqs_record):
        with patch('processor.handler.validate_sqs_message', return_value=(sample_sqs_record, [])), \
             patch('processor.handler.process_feedback', return_value=item):
            result = handler.record_handler(_record(sample_sqs_record))

        assert result == {"status": "success", "feedback_id": 'fid-2'}
        write.assert_called_once_with(item)
        assert metrics.add_metric.call_args_list == [
            call(name="FeedbackProcessed", unit="Count", value=1),
            call(name=second_metric, unit="Count", value=1),
        ]

    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback', return_value=None)
    def test_a_duplicate_is_skipped_without_a_write_or_a_metric(self, process, write, metrics, sample_sqs_record):
        with patch('processor.handler.validate_sqs_message', return_value=(sample_sqs_record, [])):
            result = handler.record_handler(_record(sample_sqs_record))

        assert result == {"status": "skipped", "reason": "duplicate"}
        process.assert_called_once_with(sample_sqs_record)
        write.assert_not_called()
        metrics.add_metric.assert_not_called()

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.write_to_dynamodb')
    def test_bedrock_throttling_is_logged_counted_recorded_and_re_raised(
        self, write, log_error, metrics, log, sample_sqs_record,
    ):
        error = BedrockThrottlingError('Bedrock throttled after 5 retries')
        with patch('processor.handler.validate_sqs_message', return_value=(sample_sqs_record, [])), \
             patch('processor.handler.process_feedback', side_effect=error), \
             pytest.raises(BedrockThrottlingError) as raised:
            handler.record_handler(_record(sample_sqs_record))

        assert raised.value is error
        assert log.warning.call_args_list == [
            call("Bedrock throttled for webscraper, message will be retried by SQS"),
        ]
        metrics.add_metric.assert_called_once_with(name="BedrockThrottleRetry", unit="Count", value=1)
        log_error.assert_called_once_with('webscraper', 'test-source-id-123', error)
        write.assert_not_called()
        log.exception.assert_not_called()

    @patch('processor.handler.log_processing_error')
    @patch('processor.handler.write_to_dynamodb')
    def test_any_other_error_is_logged_by_type_and_re_raised(self, write, log_error, metrics, log, sample_sqs_record):
        error = ValueError('bad payload')
        with patch('processor.handler.validate_sqs_message', return_value=(sample_sqs_record, [])), \
             patch('processor.handler.process_feedback', side_effect=error), \
             pytest.raises(ValueError, match='bad payload') as raised:
            handler.record_handler(_record(sample_sqs_record))

        assert raised.value is error
        assert log.exception.call_args_list == [
            call("Unexpected error processing webscraper/test-source-id-123: bad payload"),
        ]
        log_error.assert_called_once_with('webscraper', 'test-source-id-123', error)
        metrics.add_metric.assert_not_called()
        write.assert_not_called()


class TestRecordHandlerIdempotency:
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback')
    @patch('processor.handler._process_feedback_idempotent', return_value={'feedback_id': 'fid-3'})
    def test_with_a_store_and_a_config_the_idempotent_path_is_keyed_platform_colon_id(
        self, idempotent, process, write, sample_sqs_record,
    ):
        layer, config = MagicMock(name='layer'), MagicMock(name='config')
        validated = {**sample_sqs_record, 'validated': True}
        result = _handle_with_idempotency(sample_sqs_record, layer=layer, config=config, validated=validated)

        assert result == {"status": "success", "feedback_id": 'fid-3'}
        idempotent.assert_called_once_with(
            raw_record=validated, idempotency_key='webscraper:test-source-id-123',
            persistence_store=layer, config=config,
        )
        process.assert_not_called()
        write.assert_called_once_with({'feedback_id': 'fid-3'})

    @pytest.mark.parametrize(('layer', 'config'), [(MagicMock(name='layer'), None), (None, MagicMock(name='config'))])
    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler.process_feedback', return_value={'feedback_id': 'fid-4'})
    @patch('processor.handler._process_feedback_idempotent')
    def test_with_only_one_half_configured_processing_is_direct(
        self, idempotent, process, write, layer, config, sample_sqs_record,
    ):
        result = _handle_with_idempotency(sample_sqs_record, layer=layer, config=config, validated=sample_sqs_record)

        assert result == {"status": "success", "feedback_id": 'fid-4'}
        idempotent.assert_not_called()
        process.assert_called_once_with(sample_sqs_record)
        write.assert_called_once_with({'feedback_id': 'fid-4'})

    @patch('processor.handler.write_to_dynamodb')
    @patch('processor.handler._process_feedback_idempotent', side_effect=IdempotencyAlreadyInProgressError('busy'))
    def test_a_record_another_invocation_holds_is_skipped(self, idempotent, write, metrics, log, sample_sqs_record):
        layer, config = MagicMock(name='layer'), MagicMock(name='config')
        result = _handle_with_idempotency(sample_sqs_record, layer=layer, config=config, validated=sample_sqs_record)

        assert result == {"status": "skipped", "reason": "idempotency_in_progress"}
        idempotent.assert_called_once_with(
            raw_record=sample_sqs_record, idempotency_key='webscraper:test-source-id-123',
            persistence_store=layer, config=config,
        )
        assert log.info.call_args_list == [
            call("Processing feedback from webscraper/test-source-id-123"),
            call("Idempotency: webscraper:test-source-id-123 already in progress, skipping"),
        ]
        metrics.add_metric.assert_called_once_with(name="IdempotencySkipped", unit="Count", value=1)
        write.assert_not_called()


class TestProcessFeedbackIdempotentWrapper:
    @patch('processor.handler.process_feedback', return_value={'feedback_id': 'fid-5'})
    def test_the_second_call_with_the_same_key_is_answered_from_the_store(self, process):
        with mock_aws():
            client = boto3.client('dynamodb', region_name='us-east-1')
            client.create_table(
                TableName='idem', BillingMode='PAY_PER_REQUEST',
                KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
                AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}],
            )
            store = DynamoDBPersistenceLayer(table_name='idem', boto3_client=client)
            kwargs = {'raw_record': {'id': 'abc'}, 'idempotency_key': 'webscraper:abc',
                      'persistence_store': store, 'config': IdempotencyConfig(use_local_cache=False)}

            first = handler._process_feedback_idempotent(**kwargs)
            second = handler._process_feedback_idempotent(**kwargs)
            rows = client.scan(TableName='idem')['Items']

        assert first == {'feedback_id': 'fid-5'}
        assert second == {'feedback_id': 'fid-5'}
        process.assert_called_once_with({'id': 'abc'})
        key_hash = hashlib.md5(json.dumps('webscraper:abc', sort_keys=True).encode(), usedforsecurity=False).hexdigest()
        (row,) = rows
        assert _string_attribute(row, 'id').endswith(
            f'processor.handler._process_feedback_idempotent.<locals>._inner#{key_hash}')
        assert _string_attribute(row, 'status') == 'COMPLETED'
        assert json.loads(_string_attribute(row, 'data')) == {'feedback_id': 'fid-5'}


class TestSafeSegmentRefusesATrailingNewline:
    def test_an_identifier_plus_newline_is_masked(self):
        """`$` under `re.match` also matches before a final newline; fullmatch does not."""
        assert handler._safe_segment('text') == 'text'
        assert handler._safe_segment('text\n') == handler.MASKED_SEGMENT
