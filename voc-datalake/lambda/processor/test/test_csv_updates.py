"""A confirmed CSV correction updates its stored row in place (issue #411, shared/csv_updates.py).

Before this, a `csv-row-v2` row re-sent with corrected content was skipped as a duplicate
(its id is stable across edits by design), so the correction never reached the stored
item. Every case drives the real `record_handler` against moto, because the guarantees are
conditional writes that only DynamoDB evaluates. The aggregator half (the MODIFY moves the
counters) follows the precedent of test_source_update_aggregates.py.
"""
import json
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from moto import mock_aws

from processor import handler
from processor.test.test_source_update_aggregates import _aggregate as aggregate_modify
from processor.test.test_source_updates import CATEGORIES, insights
from shared.csv_datasets import csv_row_id_v2
from shared.feedback_keys import feedback_item_key
from shared.source_updates import idempotency_key_for
from shared.test.moto_tables import create_pk_sk_table

ROW_ID = csv_row_id_v2('example air q3', '4711')
HASH_A = 'a' * 32
HASH_B = 'b' * 32


def csv_message(text: str = 'teh app crashes', content_hash: str = HASH_A, *, replace: bool = False, **extra) -> dict:
    """A `csv-row-v2` queue message as manual_import_handler sends it."""
    return {
        'id': ROW_ID, 'csv_row_id': '4711', 'source_platform': 'manual_import', 'source_channel': 'csv_upload',
        'ingestion_method': 'csv_upload', 'text': text, 'rating': 2, 'author': 'Ann', 'title': None,
        'url': None, 'created_at': '2026-01-15T00:00:00Z', 's3_raw_uri': None, 'pii_policy_applied': 'allow',
        'csv_dataset': 'example air q3', 'csv_content_hash': content_hash,
        **({'csv_replace': True} if replace else {}), **extra,
    }


@contextmanager
def world(llm_answers: list[dict] | None = None):
    with mock_aws():
        feedback = create_pk_sk_table('test-feedback-csv')
        llm = MagicMock(side_effect=llm_answers or [insights(), insights()])
        with patch.object(handler, 'feedback_table', feedback), \
             patch.object(handler, 'persistence_layer', None), \
             patch.object(handler, 'idempotency_config', None), \
             patch.object(handler, 'get_categories_config', return_value=CATEGORIES), \
             patch.object(handler, 'get_dimensions_config', return_value=[]), \
             patch.object(handler, 'source_profile', return_value={}), \
             patch.object(handler, 'detect_language', return_value='en'), \
             patch.object(handler, 'translate_text', side_effect=lambda text, _s, _d: text), \
             patch.object(handler, 'get_comprehend_sentiment', return_value={'label': 'negative', 'score': -0.4}), \
             patch.object(handler, 'invoke_bedrock_llm', llm):
            yield feedback, llm


def deliver(message: dict) -> dict:
    return handler.record_handler(MagicMock(body=json.dumps(message)))


def items(feedback) -> list[dict]:
    return feedback.scan()['Items']


class TestCorrections:
    def test_a_confirmed_correction_updates_the_stored_row_instead_of_adding_one(self):
        with world() as (feedback, llm):
            deliver(csv_message())
            deliver(csv_message('the app crashes', HASH_B, replace=True, rating=4, author='Ann B'))
            (item,) = items(feedback)

        assert item['original_text'] == 'the app crashes'
        assert (item['rating'], item['author'], item['csv_content_hash']) == (Decimal(4), 'Ann B', HASH_B)
        assert item['sk'] == feedback_item_key('manual_import', ROW_ID)['sk']
        assert 'source_refreshed_at' in item
        assert llm.call_count == 2  # the corrected text was enriched again

    def test_the_first_import_stores_the_dataset_and_the_digest(self):
        with world() as (feedback, _):
            deliver(csv_message())
            (item,) = items(feedback)
        assert (item['csv_dataset'], item['csv_content_hash'], item['csv_row_id']) == ('example air q3', HASH_A, '4711')

    def test_an_unconfirmed_resend_with_new_content_is_still_a_duplicate(self):
        with world() as (feedback, _):
            deliver(csv_message())
            result = deliver(csv_message('the app crashes', HASH_B))
            (item,) = items(feedback)
        assert result == {'status': 'skipped', 'reason': 'duplicate'}
        assert item['original_text'] == 'teh app crashes'

    def test_a_correction_with_the_stored_digest_writes_nothing(self):
        with world() as (feedback, llm):
            deliver(csv_message())
            before = items(feedback)
            deliver(csv_message(replace=True))
            after = items(feedback)
        assert after == before
        assert llm.call_count == 1

    def test_a_correction_of_only_the_rating_is_not_re_enriched(self):
        with world() as (feedback, llm):
            deliver(csv_message())
            deliver(csv_message(content_hash=HASH_B, replace=True, rating=5))
            (item,) = items(feedback)
        assert item['rating'] == Decimal(5)
        assert llm.call_count == 1

    def test_a_failed_model_call_keeps_the_stored_enrichment_and_digest_and_applies_the_row_fields(self):
        """Like an issue refresh: the fallback never overwrites a good enrichment; the stored
        digest stays, so the row still previews as changed and a later upload retries the text."""
        failed = {'insights': {}, 'metadata': {'error': 'unparseable'}}
        with world([insights('performance', -0.9, 'high'), failed]) as (feedback, llm):
            deliver(csv_message())
            (before,) = items(feedback)
            deliver(csv_message('the app crashes', HASH_B, replace=True, rating=4))
            (after,) = items(feedback)
        assert llm.call_count == 2
        enriched = ('original_text', 'category', 'sentiment_score', 'sentiment_label', 'urgency', 'csv_content_hash')
        assert {k: after.get(k) for k in enriched} == {k: before.get(k) for k in enriched}
        assert after['csv_content_hash'] == HASH_A
        assert after['rating'] == Decimal(4)
        assert 'source_refreshed_at' in after

    def test_a_correction_never_moves_a_manual_category(self):
        with world([insights('product_quality'), insights('performance')]) as (feedback, _):
            deliver(csv_message())
            key = {'pk': items(feedback)[0]['pk'], 'sk': items(feedback)[0]['sk']}
            feedback.update_item(Key=key, UpdateExpression='SET category_source = :m', ExpressionAttributeValues={':m': 'manual'})
            deliver(csv_message('it is slow now', HASH_B, replace=True))
            (item,) = items(feedback)
        assert (item['category'], item['original_text']) == ('product_quality', 'it is slow now')

    def test_a_correction_whose_row_was_deleted_is_stored_as_new(self):
        with world() as (feedback, _):
            deliver(csv_message('the app crashes', HASH_B, replace=True))
            (item,) = items(feedback)
        assert item['csv_content_hash'] == HASH_B

    def test_a_correction_of_a_summary_only_row_keeps_no_customer_words(self):
        answer = insights()
        answer['insights']['problem_summary'] = 'App crashes on start'
        with world([insights(), answer]) as (feedback, _):
            deliver(csv_message(pii_policy_applied='summary_only'))
            deliver(csv_message('my name is Ann and the app crashes', HASH_B, replace=True,
                                pii_policy_applied='summary_only'))
            (item,) = items(feedback)
        assert item['original_text'] == 'App crashes on start'
        assert 'author' not in item
        assert item['pii_policy'] == 'summary_only'


class TestMarker:
    @pytest.mark.parametrize('change', [
        {'ingestion_method': 'json_upload'}, {'ingestion_method': None},
        {'csv_dataset': None}, {'csv_content_hash': None},
    ])
    def test_a_replace_from_anything_but_a_csv_dataset_row_is_refused_and_changes_nothing(self, change):
        with world() as (feedback, _):
            deliver(csv_message())
            with pytest.raises(handler.MessageRejectedError):
                deliver({**csv_message('the app crashes', HASH_B, replace=True), **change})
            (item,) = items(feedback)
        assert (item['original_text'], item['csv_content_hash']) == ('teh app crashes', HASH_A)

    def test_a_forged_replace_aimed_at_a_non_csv_item_fails_the_condition_and_changes_nothing(self):
        """An item no dataset stored (no csv_dataset) that merely shares the key is never overwritten."""
        with world() as (feedback, llm):
            deliver({**csv_message(), 'csv_dataset': None, 'csv_content_hash': None,
                     'ingestion_method': 'json_upload'})
            (before,) = items(feedback)
            with pytest.raises(handler.ConcurrentSourceUpdateError):
                deliver(csv_message('the app crashes', HASH_B, replace=True, rating=5))
            (after,) = items(feedback)
        assert 'csv_dataset' not in before
        assert after == before
        assert llm.call_count == 2  # enriched, then the conditional write refused it

    def test_a_replace_naming_another_dataset_fails_the_condition_and_changes_nothing(self):
        with world() as (feedback, _):
            deliver(csv_message())
            (before,) = items(feedback)
            with pytest.raises(handler.ConcurrentSourceUpdateError):
                deliver(csv_message('the app crashes', HASH_B, replace=True, csv_dataset='example air q4'))
            (after,) = items(feedback)
        assert after == before

    def test_a_correction_gets_an_idempotency_key_of_its_own(self):
        first, correction = csv_message(), csv_message(content_hash=HASH_B, replace=True)
        assert idempotency_key_for(first) == f'manual_import:{ROW_ID}'
        assert idempotency_key_for(correction) == f'manual_import:{ROW_ID}:csv:{HASH_B}'


def test_the_corrections_modify_moves_the_aggregates_without_double_counting():
    """Same precedent and helper as test_source_update_aggregates: the INSERT, then the real MODIFY images."""
    answers = [insights('product_quality', 0.6, 'low', 'positive'), insights('performance', -0.9, 'high')]
    with world(answers) as (feedback, _):
        deliver(csv_message())
        (before,) = items(feedback)
        deliver(csv_message('it takes 30 seconds to load', HASH_B, replace=True))
        (after,) = items(feedback)
        _, counts = aggregate_modify(before, after)

    assert counts['METRIC#daily_total'] == Decimal(1)
    assert counts['METRIC#daily_category#product_quality'] == Decimal(0)
    assert counts['METRIC#daily_category#performance'] == Decimal(1)
    assert counts['METRIC#daily_sentiment#positive'] == Decimal(0)
    assert counts['METRIC#daily_sentiment#negative'] == Decimal(1)
