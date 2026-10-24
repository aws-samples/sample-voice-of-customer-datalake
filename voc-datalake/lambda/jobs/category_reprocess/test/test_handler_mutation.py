"""Mutation hardening for `jobs/category_reprocess/handler.py`.

`test_handler.py` drives the worker end to end against moto tables and pins the
outcomes (the review is rewritten in place, the job counters, hand-over and
cancellation). A mutation run found what those journeys cannot see:

* the module's configuration surface: which environment variables it reads and
  what it falls back to, the page size the scan asks for, the exact time
  reserve at which an invocation hands over, and the number of throttle
  restarts it tolerates before failing the job;
* the Comprehend / Translate clients are created once, by service name, and
  reused;
* the raw-mode input: every reason the archived raw object is NOT used (wrong
  bucket, wrong prefix, unreadable, unparseable, no ``raw_item``, no text) falls
  back to the stored text, and when it IS used, which fields come from the
  archive and which from the stored review. The earlier tests only exercised
  the fallback, so the success path had never been asserted;
* the exact prompt record and text handed to the classifier (``normalized_text``
  first, then ``original_text``), and the exact ``update_item`` expression and
  names/values the in-place update is built from;
* the shape of the raw-mode attributes: the resolved category/subcategory
  replace the model's answer under the same keys.
"""
import importlib.util
import json
import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import pytest
from aws_lambda_powertools.metrics.provider.cold_start import reset_cold_start_flag
from botocore.exceptions import ClientError

from jobs.category_reprocess import handler
from jobs.category_reprocess.handler import (
    _time_left,
    build_update,
    processed_attributes,
    raw_attributes,
    raw_record_for,
    reprocess_item,
    run_job,
    scan_page,
)
from shared import reprocess_jobs as jobs
from shared.categorization import Enrichment
from shared.converse import BedrockThrottlingError

HANDLER_PATH = Path(handler.__file__)
ENV_SETTINGS = (
    ('FEEDBACK_TABLE', 'FEEDBACK_TABLE', ''),
    ('AGGREGATES_TABLE', 'AGGREGATES_TABLE', ''),
    ('RAW_DATA_BUCKET', 'RAW_DATA_BUCKET', ''),
    ('PRIMARY_LANGUAGE', 'PRIMARY_LANGUAGE', 'en'),
)
CATEGORIES = [
    {'name': 'shipping', 'description': 'Shipping', 'subcategories': [{'name': 'late'}]},
    {'name': 'billing', 'description': 'Billing'},
]
RAW_URI = 's3://raw-bucket/raw/web/2026/01/10/a.json'


def _item(**overrides) -> dict:
    item = {
        'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a', 'feedback_id': 'a',
        'date': datetime.now(UTC).strftime('%Y-%m-%d'),
        'source_platform': 'web', 'source_channel': 'reviews', 'rating': 2,
        'original_text': 'stored text', 'category': 'billing',
    }
    item.update(overrides)
    return item


def _load_fresh(env: dict[str, str]) -> ModuleType:
    """Execute the handler module again with only ``env`` of its settings present."""
    with patch.dict(os.environ):
        for name, _attr, _default in ENV_SETTINGS:
            os.environ.pop(name, None)
        os.environ.update(env)
        spec = importlib.util.spec_from_file_location('category_reprocess_handler_fresh', HANDLER_PATH)
        assert spec
        assert spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class TestConfigurationIsReadFromTheEnvironment:
    @pytest.mark.parametrize(('env_name', 'attribute', 'default'), ENV_SETTINGS)
    def test_the_named_variable_is_read(self, env_name: str, attribute: str, default: str):
        module = _load_fresh({env_name: 'configured-value'})
        assert getattr(module, attribute) == 'configured-value'
        assert getattr(module, attribute) != default

    @pytest.mark.parametrize(('attribute', 'default'), [(attr, default) for _env, attr, default in ENV_SETTINGS])
    def test_the_default_applies_when_unset(self, attribute: str, default: str):
        module = _load_fresh({})
        assert getattr(module, attribute) == default

    def test_the_loaded_module_sees_the_test_environment(self):
        assert handler.FEEDBACK_TABLE == os.environ['FEEDBACK_TABLE'] != ''
        assert handler.AGGREGATES_TABLE == os.environ['AGGREGATES_TABLE'] != ''
        assert handler.RAW_DATA_BUCKET == os.environ['RAW_DATA_BUCKET'] == 'test-raw-data-bucket'
        assert handler.PRIMARY_LANGUAGE == 'en'

    def test_constants(self):
        assert handler.PAGE_SIZE == 25
        assert handler.TIME_RESERVE_MS == 180_000
        assert handler.MAX_THROTTLE_RESTARTS == 3
        assert handler.CATEGORY_SOURCE_MANUAL == 'manual'
        assert handler.CATEGORY_SOURCE_REPROCESS == 'reprocess'


class TestNlpClientsAreCreatedOnceByServiceName:
    @pytest.mark.parametrize(('getter_name', 'global_name', 'service'), [
        ('_comprehend_client', '_comprehend', 'comprehend'),
        ('_translate_client', '_translate', 'translate'),
    ])
    def test_a_fresh_module_has_no_client_until_asked(self, getter_name: str, global_name: str, service: str):
        module = _load_fresh({})
        assert getattr(module, global_name) is None
        client = MagicMock(name=service)
        boto3_mock = MagicMock()
        boto3_mock.client.return_value = client
        with patch.object(module, 'boto3', boto3_mock):
            assert getattr(module, getter_name)() is client
        boto3_mock.client.assert_called_once_with(service)
        assert getattr(module, global_name) is client

    @pytest.mark.parametrize(('getter', 'global_name', 'service'), [
        (handler._comprehend_client, '_comprehend', 'comprehend'),
        (handler._translate_client, '_translate', 'translate'),
    ])
    def test_first_call_creates_later_calls_reuse(
        self, getter: Callable[[], Any], global_name: str, service: str,
    ):
        client = MagicMock(name=service)
        boto3_mock = MagicMock()
        boto3_mock.client.return_value = client
        with patch.object(handler, global_name, None), \
                patch.object(handler, 'boto3', boto3_mock):
            first = getter()
            second = getter()
            assert getattr(handler, global_name) is client
        assert first is client
        assert second is client
        boto3_mock.client.assert_called_once_with(service)

    @pytest.mark.parametrize(('getter', 'global_name'), [
        (handler._comprehend_client, '_comprehend'),
        (handler._translate_client, '_translate'),
    ])
    def test_an_existing_client_is_returned_untouched(self, getter: Callable[[], Any], global_name: str):
        existing = MagicMock(name='existing')
        boto3_mock = MagicMock()
        with patch.object(handler, global_name, existing), patch.object(handler, 'boto3', boto3_mock):
            assert getter() is existing
        boto3_mock.client.assert_not_called()


class TestScanPageAsksForExactlyOnePage:
    def test_all_time_without_cursor(self):
        table = MagicMock()
        table.scan.return_value = {'Items': []}
        assert scan_page(table, None, None) == {'Items': []}
        table.scan.assert_called_once_with(
            Limit=25,
            FilterExpression='begins_with(sk, :feedback)',
            ExpressionAttributeValues={':feedback': 'FEEDBACK#'},
        )

    def test_window_and_cursor(self):
        table = MagicMock()
        scan_page(table, {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'}, '2026-02-09')
        table.scan.assert_called_once_with(
            Limit=25,
            FilterExpression='begins_with(sk, :feedback) AND #date >= :cutoff',
            ExpressionAttributeNames={'#date': 'date'},
            ExpressionAttributeValues={':feedback': 'FEEDBACK#', ':cutoff': '2026-02-09'},
            ExclusiveStartKey={'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'},
        )


class TestTimeReserveBoundary:
    @pytest.mark.parametrize(('remaining_ms', 'expected'), [
        (180_001, True),
        (180_000, False),
        (179_999, False),
    ])
    def test_time_left(self, remaining_ms: int, expected: bool):
        context = MagicMock()
        context.get_remaining_time_in_millis.return_value = remaining_ms
        assert _time_left(context) is expected


@pytest.mark.usefixtures('converse_mock')
class TestThrottleRestartBudget:
    @pytest.fixture
    def throttled(self, tables, start_job, converse_mock):
        tables['feedback'].put_item(Item=_item())
        converse_mock.side_effect = BedrockThrottlingError('slow')
        return start_job()

    def test_the_third_restart_still_hands_over(self, tables, throttled, worker_context, invoke_mock):
        result = run_job({'job_id': throttled['sk'], 'throttle_restarts': 2}, worker_context)
        assert result == {'status': 'continued', 'scanned': 0, 'updated': 0, 'unchanged': 0,
                          'skipped_manual': 0, 'failed': 0}
        stored = jobs.get_job(tables['aggregates'], throttled['sk'])
        assert stored is not None
        invoke_mock.assert_called_once_with(
            'voc-job-category-reprocess',
            {'job_id': throttled['sk'], 'throttle_restarts': 3, 'worker_token': stored['worker_token']},
        )
        assert stored['status'] == 'running'

    def test_the_fourth_fails_the_job_with_its_message(self, tables, throttled, worker_context, invoke_mock):
        result = run_job({'job_id': throttled['sk'], 'throttle_restarts': 3}, worker_context)
        assert result == {'status': 'failed'}
        invoke_mock.assert_not_called()
        view = jobs.job_view(jobs.get_job(tables['aggregates'], throttled['sk']) or {})
        assert view['status'] == 'failed'
        assert view['error'] == 'Bedrock kept throttling; try again later'
        assert view['scanned'] == 0


class TestBuildUpdateExpression:
    def test_item_with_a_category_and_manual_protection(self):
        kwargs = build_update(_item(), {'category': 'shipping', 'subcategory': None}, False, '2026-03-10T00:00:00+00:00')
        assert kwargs == {
            'Key': {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a'},
            'UpdateExpression': 'SET #a0 = :v0, #a2 = :v2, #a3 = :v3 REMOVE #a1',
            'ConditionExpression': 'attribute_exists(#pk) AND #cat_now = :cat_before'
                                   ' AND (attribute_not_exists(#source) OR #source <> :manual)',
            'ExpressionAttributeNames': {
                '#pk': 'pk', '#cat_now': 'category', '#source': 'category_source',
                '#a0': 'category', '#a1': 'subcategory', '#a2': 'category_source',
                '#a3': 'category_reprocessed_at',
            },
            'ExpressionAttributeValues': {
                ':v0': 'shipping', ':v2': 'reprocess', ':v3': '2026-03-10T00:00:00+00:00',
                ':cat_before': 'billing', ':manual': 'manual',
            },
        }

    def test_item_without_a_category_and_include_manual(self):
        item = _item()
        del item['category']
        kwargs = build_update(item, {'category': 'shipping'}, True, 'now')
        assert kwargs['UpdateExpression'] == 'SET #a0 = :v0, #a1 = :v1, #a2 = :v2'
        assert kwargs['ConditionExpression'] == 'attribute_exists(#pk) AND attribute_not_exists(#cat_now)'
        assert kwargs['ExpressionAttributeNames'] == {
            '#pk': 'pk', '#cat_now': 'category',
            '#a0': 'category', '#a1': 'category_source', '#a2': 'category_reprocessed_at',
        }
        assert kwargs['ExpressionAttributeValues'] == {':v0': 'shipping', ':v1': 'reprocess', ':v2': 'now'}


class TestProcessedModeClassifierInput:
    @pytest.fixture
    def classify(self):
        mock = MagicMock(return_value=('shipping', 'late'))
        with patch.object(handler, 'classify_category', mock):
            yield mock

    def test_the_prompt_record_and_translated_text(self, classify: MagicMock):
        item = _item(normalized_text='translated text')
        assert processed_attributes(item, CATEGORIES) == {
            'category': 'shipping', 'subcategory': 'late', 'gsi2pk': 'CATEGORY#shipping',
        }
        classify.assert_called_once_with(
            {'text': 'stored text', 'source_platform': 'web', 'source_channel': 'reviews', 'rating': 2},
            'translated text', CATEGORIES,
        )

    def test_missing_fields_default(self, classify: MagicMock):
        item = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#a', 'normalized_text': 'translated text'}
        processed_attributes(item, CATEGORIES)
        classify.assert_called_once_with(
            {'text': '', 'source_platform': 'unknown', 'source_channel': 'unknown', 'rating': None},
            'translated text', CATEGORIES,
        )

    def test_the_original_text_is_the_fallback(self, classify: MagicMock):
        processed_attributes(_item(), CATEGORIES)
        assert classify.call_args.args[1] == 'stored text'

    @pytest.mark.parametrize('item', [
        {'pk': 'p', 'sk': 's'},
        _item(original_text=''),
        _item(original_text='   '),
        _item(original_text=None, normalized_text=None),
        _item(normalized_text=5),
    ])
    def test_unusable_text_is_not_classified(self, classify: MagicMock, item: dict):
        assert processed_attributes(item, CATEGORIES) is None
        classify.assert_not_called()

    def test_an_unresolved_answer_is_none(self, classify: MagicMock):
        classify.return_value = None
        assert processed_attributes(_item(), CATEGORIES) is None


class TestRawRecordFallsBackToTheStoredReview:
    """Every reason the archived raw object is not used yields the stored record."""

    STORED: ClassVar[dict] = {
        'text': 'stored text', 'source_platform': 'web', 'source_channel': 'reviews', 'rating': 2,
    }

    @staticmethod
    def _record(item: dict, s3_client: MagicMock, bucket: str = 'raw-bucket') -> dict:
        with patch.object(handler, 'RAW_DATA_BUCKET', bucket), \
                patch.object(handler, 'get_s3_client', return_value=s3_client):
            return raw_record_for(item)

    @pytest.mark.parametrize('uri', [
        None, 7, 'https://raw-bucket/raw/web/a.json', 's3://raw-bucket', 's3://raw-bucket/',
        's3://other-bucket/raw/web/a.json', 's3://raw-bucket/avatars/web/a.json', 's3://raw-bucket/rawx/a.json',
    ])
    def test_a_uri_outside_the_raw_prefix_is_not_fetched(self, uri: object):
        s3_client = MagicMock()
        assert self._record(_item(s3_raw_uri=uri), s3_client) == self.STORED
        s3_client.get_object.assert_not_called()

    def test_without_a_configured_bucket_nothing_is_fetched(self):
        s3_client = MagicMock()
        assert self._record(_item(s3_raw_uri=RAW_URI), s3_client, bucket='') == self.STORED
        s3_client.get_object.assert_not_called()

    @pytest.mark.parametrize(('error', 'error_type'), [
        (ClientError({'Error': {'Code': 'NoSuchKey', 'Message': 'gone'}}, 'GetObject'), 'ClientError'),
        (ValueError('bad'), 'ValueError'),
    ])
    def test_an_unreadable_object_is_logged_by_type_only(self, error: Exception, error_type: str):
        s3_client = MagicMock()
        s3_client.get_object.side_effect = error
        with patch.object(handler, 'logger') as logger_mock:
            assert self._record(_item(s3_raw_uri=RAW_URI), s3_client) == self.STORED
        logger_mock.warning.assert_called_once_with(
            f'Raw object unreadable, using stored original text: {error_type}',
        )
        s3_client.get_object.assert_called_once_with(Bucket='raw-bucket', Key='raw/web/2026/01/10/a.json')

    @pytest.mark.parametrize('body', [
        b'{not json', b'[]', b'"text"', b'{}', b'{"raw_item": null}', b'{"raw_item": "text"}',
        b'{"raw_item": []}', b'{"raw_item": {}}', b'{"raw_item": {"text": ""}}',
        b'{"raw_item": {"text": 5}}', b'{"raw_item": {"text": null}}', b'{"text": "top-level text"}',
    ])
    def test_a_payload_without_a_raw_item_text_uses_the_stored_record(self, body: bytes):
        s3_client = MagicMock()
        s3_client.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value=body))}
        with patch.object(handler, 'logger') as logger_mock:
            assert self._record(_item(s3_raw_uri=RAW_URI), s3_client) == self.STORED
        if body == b'{not json':
            logger_mock.warning.assert_called_once_with(
                'Raw object unreadable, using stored original text: JSONDecodeError',
            )
        else:
            logger_mock.warning.assert_not_called()


class TestRawRecordComesFromTheArchive:
    def _record(self, payload: bytes, item: dict) -> dict:
        s3_client = MagicMock()
        s3_client.get_object.return_value = {'Body': MagicMock(read=MagicMock(return_value=payload))}
        with patch.object(handler, 'RAW_DATA_BUCKET', 'raw-bucket'), \
                patch.object(handler, 'get_s3_client', return_value=s3_client):
            return raw_record_for(item)

    def test_text_and_rating_come_from_the_raw_item(self):
        record = self._record(
            b'{"raw_item": {"text": "Paket kam sp\\u00e4t", "rating": 1, "author": "x"}}',
            _item(s3_raw_uri=RAW_URI),
        )
        assert record == {
            'text': 'Paket kam spät', 'source_platform': 'web', 'source_channel': 'reviews', 'rating': 1,
        }

    def test_the_stored_rating_fills_a_raw_item_without_one(self):
        record = self._record(b'{"raw_item": {"text": "raw text"}}', _item(s3_raw_uri=RAW_URI))
        assert record == {'text': 'raw text', 'source_platform': 'web', 'source_channel': 'reviews', 'rating': 2}

    def test_a_raw_item_rating_of_null_is_kept(self):
        record = self._record(b'{"raw_item": {"text": "raw text", "rating": null}}', _item(s3_raw_uri=RAW_URI))
        assert record['rating'] is None

    def test_source_fields_still_come_from_the_stored_review(self):
        item = _item(s3_raw_uri=RAW_URI)
        del item['source_platform']
        del item['source_channel']
        record = self._record(b'{"raw_item": {"text": "raw text", "source_platform": "ignored"}}', item)
        assert record == {'text': 'raw text', 'source_platform': 'unknown', 'source_channel': 'unknown', 'rating': 2}


class TestRawAttributesShape:
    @pytest.fixture
    def enrichment(self):
        """``run_enrichment`` replaced; the steps it is handed are captured."""
        llm_result = {'insights': {}, 'metadata': {'model_name': 'test-model'}}
        attributes = {'category': 'shipping', 'subcategory': 'wrong', 'urgency': 'high', 'persona_name': None}
        run_mock = MagicMock(return_value=Enrichment(attributes=attributes, llm_result=llm_result))
        with patch.object(handler, 'run_enrichment', run_mock), \
                patch.object(handler, 'build_categories_instruction', return_value='INSTRUCTION'), \
                patch.object(handler, 'raw_record_for', return_value={'text': 'raw text', 'rating': 1}):
            yield run_mock

    def test_resolved_values_replace_the_model_answer_under_the_same_keys(self, enrichment: MagicMock):
        attributes = raw_attributes(_item(), CATEGORIES)
        assert attributes == {
            'category': 'shipping', 'subcategory': None, 'urgency': 'high', 'persona_name': None,
            'gsi2pk': 'CATEGORY#shipping', 'gsi3pk': 'URGENCY#high', 'llm_metadata': {'model_name': 'test-model'},
        }
        record, steps, primary_language, categories_config = enrichment.call_args.args
        assert record == {'text': 'raw text', 'rating': 1}
        assert primary_language == 'en'
        assert categories_config == CATEGORIES
        with patch.object(handler, 'invoke_enrichment_llm', return_value={'ok': True}) as llm:
            assert steps.llm({'text': 'raw text'}) == {'ok': True}
        llm.assert_called_once_with({'text': 'raw text'}, 'INSTRUCTION')

    def test_the_steps_bind_the_module_clients(self, enrichment: MagicMock):
        raw_attributes(_item(), CATEGORIES)
        steps = enrichment.call_args.args[1]
        comprehend, translate = MagicMock(name='comprehend'), MagicMock(name='translate')
        with patch.object(handler, '_comprehend_client', return_value=comprehend), \
                patch.object(handler, '_translate_client', return_value=translate), \
                patch.object(handler, 'detect_language', return_value='de') as detect, \
                patch.object(handler, 'translate_text', return_value='translated') as translate_fn, \
                patch.object(handler, 'comprehend_sentiment', return_value={'label': 'negative'}) as sentiment:
            assert steps.detect_language('t') == 'de'
            assert steps.translate_text('t', 'de', 'en') == 'translated'
            assert steps.sentiment('t', 'en') == {'label': 'negative'}
        detect.assert_called_once_with(comprehend, 't')
        translate_fn.assert_called_once_with(translate, 't', 'de', 'en')
        sentiment.assert_called_once_with(comprehend, 't', 'en')

    def test_an_unconfigured_category_is_none(self, enrichment: MagicMock):
        enrichment.return_value.attributes['category'] = 'invented'
        assert raw_attributes(_item(), CATEGORIES) is None

    def test_a_record_without_text_is_none_before_any_model_call(self, enrichment: MagicMock):
        with patch.object(handler, 'raw_record_for', return_value={'text': '', 'rating': 1}):
            assert raw_attributes(_item(), CATEGORIES) is None
        enrichment.assert_not_called()

    def test_a_failed_model_call_is_none(self, enrichment: MagicMock):
        enrichment.return_value.llm_result['metadata']['error'] = 'boom'
        assert raw_attributes(_item(), CATEGORIES) is None

    def test_a_model_category_run_enrichment_replaced_is_none(self, enrichment: MagicMock):
        enrichment.return_value = Enrichment(
            attributes={'category': 'other', 'subcategory': None, 'urgency': 'low'}, llm_result={},
            category_valid=False)
        assert raw_attributes(_item(), CATEGORIES) is None


# ============================================
# One review: outcomes and what each one writes / logs
# ============================================

def _counters(**outcome: int) -> dict:
    return {**dict.fromkeys(jobs.COUNTERS, 0), **outcome}


class TestReprocessItemOutcomes:
    """Every outcome lands in ``scanned`` plus exactly one counter, and only
    ``updated`` writes. Table and classifiers are doubles so each path is exact."""

    NOW = '2026-03-10T00:00:00+00:00'
    NEW: ClassVar[dict] = {'category': 'shipping', 'subcategory': 'late', 'gsi2pk': 'CATEGORY#shipping'}

    @pytest.fixture
    def doubles(self):
        table = MagicMock()
        processed = MagicMock(return_value=dict(self.NEW))
        raw = MagicMock(return_value=dict(self.NEW))
        with patch.object(handler, 'processed_attributes', processed), \
                patch.object(handler, 'raw_attributes', raw), \
                patch.object(jobs, 'now_iso', return_value=self.NOW):
            yield table, processed, raw

    @staticmethod
    def _run(doubles, item: dict, **job) -> dict:
        table = doubles[0]
        counters = _counters()
        reprocess_item(table, item, {'mode': 'processed', **job}, CATEGORIES, counters)
        return counters

    def test_a_manual_correction_is_skipped_before_any_model_call(self, doubles):
        table, processed, raw = doubles
        counters = self._run(doubles, _item(category_source='manual'))
        assert counters == _counters(scanned=1, skipped_manual=1)
        processed.assert_not_called()
        raw.assert_not_called()
        table.update_item.assert_not_called()

    @pytest.mark.parametrize('include_manual', [False, 'yes', 1, None])
    def test_only_a_literal_true_includes_manual_corrections(self, doubles, include_manual):
        counters = self._run(doubles, _item(category_source='manual'), include_manual=include_manual)
        assert counters == _counters(scanned=1, skipped_manual=1)

    def test_include_manual_rewrites_the_correction_without_the_manual_guard(self, doubles):
        table, _processed, _raw = doubles
        item = _item(category_source='manual')
        counters = self._run(doubles, item, include_manual=True)
        assert counters == _counters(scanned=1, updated=1)
        table.update_item.assert_called_once_with(**build_update(item, self.NEW, True, self.NOW))
        assert ':manual' not in table.update_item.call_args.kwargs['ExpressionAttributeValues']

    def test_processed_mode_classifies_and_updates_in_place(self, doubles):
        table, processed, raw = doubles
        item = _item()
        counters = self._run(doubles, item)
        assert counters == _counters(scanned=1, updated=1)
        processed.assert_called_once_with(item, CATEGORIES)
        raw.assert_not_called()
        table.update_item.assert_called_once_with(**build_update(item, self.NEW, False, self.NOW))

    def test_raw_mode_re_enriches(self, doubles):
        table, processed, raw = doubles
        item = _item()
        counters = self._run(doubles, item, mode='raw')
        assert counters == _counters(scanned=1, updated=1)
        raw.assert_called_once_with(item, CATEGORIES)
        processed.assert_not_called()
        table.update_item.assert_called_once_with(**build_update(item, self.NEW, False, self.NOW))

    def test_raw_mode_never_short_circuits_on_an_unchanged_category(self, doubles):
        table, _processed, _raw = doubles
        counters = self._run(doubles, _item(category='shipping', subcategory='late'), mode='raw')
        assert counters == _counters(scanned=1, updated=1)
        table.update_item.assert_called_once()

    def test_processed_mode_leaves_an_unchanged_review_alone(self, doubles):
        table, _processed, _raw = doubles
        counters = self._run(doubles, _item(category='shipping', subcategory='late'))
        assert counters == _counters(scanned=1, unchanged=1)
        table.update_item.assert_not_called()

    @pytest.mark.parametrize('item', [
        _item(category='shipping', subcategory='early'),
        _item(category='shipping'),
        _item(category='billing', subcategory='late'),
    ])
    def test_a_changed_subcategory_alone_is_an_update(self, doubles, item):
        table, _processed, _raw = doubles
        counters = self._run(doubles, item)
        assert counters == _counters(scanned=1, updated=1)
        table.update_item.assert_called_once()

    @pytest.mark.parametrize('mode', ['processed', 'raw'])
    def test_no_attributes_counts_failed_without_a_write(self, doubles, mode):
        table, processed, raw = doubles
        processed.return_value = None
        raw.return_value = None
        counters = self._run(doubles, _item(), mode=mode)
        assert counters == _counters(scanned=1, failed=1)
        table.update_item.assert_not_called()

    def test_a_conditional_check_failure_is_a_manual_correction_that_won(self, doubles):
        table, _processed, _raw = doubles
        table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'changed'}}, 'UpdateItem',
        )
        with patch.object(handler, 'logger') as logger_mock:
            counters = self._run(doubles, _item())
        assert counters == _counters(scanned=1, skipped_manual=1)
        logger_mock.warning.assert_not_called()

    def test_any_other_failure_is_logged_by_review_id_and_type(self, doubles):
        table, _processed, _raw = doubles
        table.update_item.side_effect = RuntimeError('refused: "my card number is 4111…"')
        with patch.object(handler, 'logger') as logger_mock:
            counters = self._run(doubles, _item(feedback_id='fb-1'))
        assert counters == _counters(scanned=1, failed=1)
        logger_mock.warning.assert_called_once_with(
            'Reprocess failed for one review', extra={'feedback_id': 'fb-1', 'error_type': 'RuntimeError'},
        )
        assert '4111' not in repr(logger_mock.mock_calls)

    def test_throttling_propagates_with_nothing_recorded(self, doubles):
        table, processed, _raw = doubles
        processed.side_effect = BedrockThrottlingError('slow')
        counters = _counters()
        with pytest.raises(BedrockThrottlingError):
            reprocess_item(table, _item(), {'mode': 'processed'}, CATEGORIES, counters)
        assert counters == _counters()
        table.update_item.assert_not_called()


# ============================================
# The job loop
# ============================================

@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestRunJobRefusalsAreLogged:
    @pytest.mark.parametrize('event', [{}, {'job_id': 'nope'}, {'job_id': 7}, {'job_id': None}, {'job_id': 'rp_'}])
    def test_an_event_without_a_job_id_is_ignored(self, event: dict, worker_context):
        with patch.object(handler, 'logger') as logger_mock, patch.object(handler, '_tables') as tables_mock:
            assert run_job(event, worker_context) == {'status': 'ignored'}
        logger_mock.error.assert_called_once_with('Reprocess event without a valid job_id')
        tables_mock.assert_not_called()

    def test_a_job_that_cannot_be_claimed_is_logged_with_its_id(self, tables, start_job, worker_context):
        job = start_job()
        jobs.cancel_job(tables['aggregates'], job['sk'])
        with patch.object(handler, 'logger') as logger_mock:
            assert run_job({'job_id': job['sk']}, worker_context) == {'status': 'not_active'}
        logger_mock.info.assert_called_once_with(
            'Reprocess job is not active or owned by another delivery; nothing to do',
            extra={'job_id': job['sk']},
        )


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestTheScanResumesFromTheEventCursorFirst:
    EVENT_CURSOR: ClassVar[dict] = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#from-event'}
    JOB_CURSOR: ClassVar[dict] = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#from-job'}

    @pytest.fixture
    def scan(self):
        mock = MagicMock(return_value={'Items': []})
        with patch.object(handler, 'scan_page', mock):
            yield mock

    def _start_with_job_cursor(self, tables, start_job, cursor: dict | None) -> dict:
        job = start_job()
        if cursor is not None:
            token = 'bootstrap'
            assert jobs.claim_job(tables['aggregates'], job['sk'], token) is not None
            assert jobs.checkpoint(tables['aggregates'], job['sk'], _counters(), cursor, token) is not None
            # Release the bootstrap claim so the worker can take the job over as a hand-over would.
            tables['aggregates'].update_item(
                Key={'pk': jobs.JOB_PK, 'sk': job['sk']}, UpdateExpression='REMOVE worker_token',
            )
        return job

    @pytest.mark.parametrize(('event_cursor', 'job_cursor', 'expected'), [
        (EVENT_CURSOR, JOB_CURSOR, EVENT_CURSOR),
        (None, JOB_CURSOR, JOB_CURSOR),
        (EVENT_CURSOR, None, EVENT_CURSOR),
        (None, None, None),
        ({}, {}, None),
    ])
    def test_cursor_precedence(self, tables, start_job, worker_context, scan, event_cursor, job_cursor, expected):
        job = self._start_with_job_cursor(tables, start_job, job_cursor)
        event: dict = {'job_id': job['sk']}
        if event_cursor is not None:
            event['cursor'] = event_cursor
        assert run_job(event, worker_context)['status'] == 'completed'
        scan.assert_called_once_with(tables['feedback'], expected, None)



def _two_reviews_and_a_job(tables, start_job) -> dict:
    """Store reviews `a` and `b`, then start a reprocess job over them; the started job."""
    for feedback_id in ('a', 'b'):
        tables['feedback'].put_item(Item=_item(sk=f'FEEDBACK#{feedback_id}', feedback_id=feedback_id))
    return start_job()

@pytest.mark.usefixtures('converse_mock')
class TestHandOverEvents:
    def test_a_time_hand_over_carries_the_cursor_and_a_zero_throttle_count(
        self, tables, start_job, worker_context, invoke_mock,
    ):
        job = _two_reviews_and_a_job(tables, start_job)
        worker_context.get_remaining_time_in_millis.side_effect = [900_000, 1_000]
        result = run_job({'job_id': job['sk'], 'throttle_restarts': 2}, worker_context)
        assert result == {'status': 'continued', **_counters(scanned=1, updated=1)}
        stored = jobs.get_job(tables['aggregates'], job['sk'])
        assert stored is not None
        [(name, event)] = [c.args for c in invoke_mock.call_args_list]
        assert name == 'voc-job-category-reprocess'
        assert event == {
            'job_id': job['sk'], 'throttle_restarts': 0, 'worker_token': stored['worker_token'],
            'cursor': {'pk': 'SOURCE#web', 'sk': stored['cursor']['sk']},
        }
        assert event['cursor']['sk'] in ('FEEDBACK#a', 'FEEDBACK#b')

    def test_a_hand_over_before_any_review_carries_no_cursor(self, tables, start_job, worker_context, invoke_mock):
        tables['feedback'].put_item(Item=_item())
        job = start_job()
        worker_context.get_remaining_time_in_millis.return_value = 1_000
        assert run_job({'job_id': job['sk']}, worker_context) == {'status': 'continued', **_counters()}
        event = invoke_mock.call_args.args[1]
        assert 'cursor' not in event
        assert set(event) == {'job_id', 'throttle_restarts', 'worker_token'}

    def test_a_successful_review_resets_the_throttle_count(
        self, tables, start_job, worker_context, invoke_mock, converse_mock,
    ):
        job = _two_reviews_and_a_job(tables, start_job)
        converse_mock.side_effect = ['{"category": "shipping", "subcategory": "late"}', BedrockThrottlingError('slow')]
        result = run_job({'job_id': job['sk'], 'throttle_restarts': 2}, worker_context)
        assert result == {'status': 'continued', **_counters(scanned=1, updated=1)}
        assert invoke_mock.call_args.args[1]['throttle_restarts'] == 1

    def test_a_cancel_racing_the_hand_over_checkpoint_stops_without_invoking(
        self, tables, start_job, worker_context, invoke_mock,
    ):
        tables['feedback'].put_item(Item=_item())
        job = start_job()
        worker_context.get_remaining_time_in_millis.return_value = 1_000
        with patch.object(jobs, 'checkpoint', return_value=None):
            assert run_job({'job_id': job['sk']}, worker_context) == {'status': 'cancelled'}
        invoke_mock.assert_not_called()


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestSparseJobRowsFallBack:
    """A job row without counters or a window (written before those fields
    existed) starts from zero and covers all time."""

    JOB_ID = 'rp_0123456789ab'

    def test_counters_start_at_zero_and_the_window_is_all_time(self, tables, worker_context):
        old = (datetime.now(UTC) - timedelta(days=400)).strftime('%Y-%m-%d')
        tables['feedback'].put_item(Item=_item(date=old))
        tables['aggregates'].put_item(Item={'pk': jobs.JOB_PK, 'sk': self.JOB_ID, 'status': 'queued', 'mode': 'processed'})
        with patch.object(handler, 'scan_page', wraps=handler.scan_page) as scan:
            result = run_job({'job_id': self.JOB_ID}, worker_context)
        assert result == {'status': 'completed', **_counters(scanned=1, updated=1)}
        scan.assert_called_once_with(tables['feedback'], None, None)


@pytest.mark.usefixtures('converse_mock', 'invoke_mock')
class TestCompletionCeilingAndCancellationAreObservable:
    def test_completion_emits_its_metric_once(self, tables, start_job, worker_context):
        tables['feedback'].put_item(Item=_item())
        job = start_job()
        with patch.object(handler, 'metrics') as metrics_mock, patch.object(handler, 'logger') as logger_mock:
            result = run_job({'job_id': job['sk']}, worker_context)
        assert result == {'status': 'completed', **_counters(scanned=1, updated=1)}
        metrics_mock.add_metric.assert_called_once_with(name='CategoryReprocessCompleted', unit='Count', value=1)
        logger_mock.warning.assert_not_called()
        logger_mock.error.assert_not_called()

    def test_the_ceiling_is_logged_and_counted(self, tables, start_job, worker_context):
        for suffix in ('a', 'b'):
            tables['feedback'].put_item(Item=_item(sk=f'FEEDBACK#{suffix}', feedback_id=suffix))
        job = start_job()
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', 1), patch.object(handler, 'metrics') as metrics_mock, \
                patch.object(handler, 'logger') as logger_mock:
            result = run_job({'job_id': job['sk']}, worker_context)
        assert result == {'status': 'completed', 'stopped_at_ceiling': True, **_counters(scanned=1, updated=1)}
        logger_mock.warning.assert_called_once_with('Reprocess job reached its item ceiling', extra={'job_id': job['sk']})
        metrics_mock.add_metric.assert_called_once_with(
            name='CategoryReprocessStoppedAtCeiling', unit='Count', value=1,
        )
        view = jobs.job_view(jobs.get_job(tables['aggregates'], job['sk']) or {})
        assert view['status'] == 'completed'
        assert view['stopped_at_ceiling'] is True

    @pytest.mark.parametrize(('items', 'ceiling', 'scanned'), [(2, 2, 2), (3, 2, 2), (1, 2, 1)])
    def test_the_ceiling_is_inclusive(self, tables, start_job, worker_context, items, ceiling, scanned):
        for index in range(items):
            tables['feedback'].put_item(Item=_item(sk=f'FEEDBACK#{index}', feedback_id=str(index)))
        job = start_job()
        with patch.object(jobs, 'MAX_REPROCESS_ITEMS', ceiling):
            result = run_job({'job_id': job['sk']}, worker_context)
        assert result['scanned'] == scanned
        assert ('stopped_at_ceiling' in result) is (items > ceiling)

    def test_a_lost_page_checkpoint_is_logged_with_the_job_id(self, tables, start_job, worker_context, invoke_mock):
        for suffix in ('a', 'b'):
            tables['feedback'].put_item(Item=_item(sk=f'FEEDBACK#{suffix}', feedback_id=suffix))
        job = start_job()
        with patch.object(handler, 'PAGE_SIZE', 1), patch.object(jobs, 'checkpoint', return_value=None), \
                patch.object(handler, 'logger') as logger_mock:
            assert run_job({'job_id': job['sk']}, worker_context) == {'status': 'cancelled'}
        logger_mock.info.assert_called_once_with(
            'Reprocess job cancelled or claimed by another delivery', extra={'job_id': job['sk']},
        )
        invoke_mock.assert_not_called()


class TestLambdaHandlerIsInstrumented:
    """The entry point carries the logger context, the tracer, the metrics
    flush (with the cold-start metric) and the invocation_cost CPU line; each
    decorator leaves ``__wrapped__``."""

    def test_four_decorators_wrap_the_handler(self):
        layers = 0
        function = handler.lambda_handler
        while '__wrapped__' in vars(function):
            function = vars(function)['__wrapped__']
            layers += 1
        assert layers == 4
        assert function.__qualname__ == 'lambda_handler'

    def test_the_cold_start_metric_and_lambda_context_are_emitted(self, capsys):
        reset_cold_start_flag()
        context = SimpleNamespace(
            function_name='voc-job-category-reprocess', memory_limit_in_mb=512,
            invoked_function_arn='arn:aws:lambda:us-east-1:123456789012:function:voc-job-category-reprocess',
            aws_request_id='req-category-reprocess-0001', get_remaining_time_in_millis=lambda: 900_000,
        )
        with patch.object(handler, 'run_job', return_value={'status': 'ignored'}) as run_mock:
            assert handler.lambda_handler({'job_id': 'nope'}, context) == {'status': 'ignored'}
        run_mock.assert_called_once_with({'job_id': 'nope'}, context)
        keys = handler.logger.get_current_keys()
        assert keys['function_name'] == 'voc-job-category-reprocess'
        assert keys['function_request_id'] == 'req-category-reprocess-0001'
        emitted = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
        cold_starts = [blob for blob in emitted if 'ColdStart' in blob]
        assert len(cold_starts) == 1
        assert cold_starts[0]['ColdStart'] == [1.0]
        assert cold_starts[0]['function_name'] == 'voc-job-category-reprocess'
