"""Silver keeps its history (TENETS.md D1, D2, D4): the processor's in-place updates keep the item as it was.

A source refresh (github_issues) and a confirmed CSV correction change a stored item in place. Before
either update the processor writes the item as it was to ``silver/{source}/{feedback_id}/`` in the raw
bucket (``shared/silver_provenance.py``), and the update stamps ``updated_by`` / ``updated_at`` /
``change_reason``. A new item says how it was made (``pipeline_version``, ``enrichment_mode``).
Driven through the real ``record_handler`` against moto (DynamoDB + S3).
"""
from unittest.mock import patch

import boto3
import pytest

from processor import handler
from processor.test import test_csv_updates as csv
from processor.test import test_source_updates as issues
from shared.silver_provenance import PIPELINE_VERSION
from shared.test.silver_fixtures import kept_versions

BUCKET = 'voc-raw-test'


@pytest.fixture(autouse=True)
def _bucket_env(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)


def _kept_versions() -> list[dict]:
    return kept_versions(BUCKET)


def _create_bucket() -> None:
    boto3.client('s3', region_name='us-east-1').create_bucket(Bucket=BUCKET)


class TestNewItems:
    def test_a_new_item_says_how_it_was_made(self):
        with issues.world() as (feedback, _):
            issues.deliver(issues.issue_message())
            item = issues.stored(feedback)

        assert item['pipeline_version'] == PIPELINE_VERSION
        assert item['enrichment_mode'] == 'llm'
        assert item['enriched_at'] == item['processed_at']
        assert 'updated_by' not in item

    def test_a_failed_model_call_is_stored_as_defaults(self):
        failed = {'insights': {}, 'metadata': {'error': 'boom', 'prompt_version': '2.0.0'}}
        with issues.world([failed]) as (feedback, _):
            issues.deliver(issues.issue_message())
            item = issues.stored(feedback)

        assert item['enrichment_mode'] == 'defaults'
        assert item['llm_metadata'] == {'error': 'boom', 'prompt_version': '2.0.0'}


class TestSourceUpdates:
    def test_a_refresh_keeps_the_item_as_it_was_and_stamps_the_change(self):
        with issues.world() as (feedback, _):
            _create_bucket()
            issues.deliver(issues.issue_message())
            before = issues.stored(feedback)
            issues.deliver(issues.issue_message(issues.CHANGED, labels=['bug', 'regression']))
            after = issues.stored(feedback)
            (kept,) = _kept_versions()

        assert kept['key'].startswith(f"silver/github_issues/{before['feedback_id']}/")
        assert kept['item']['issue_attributes']['labels'] == ['bug']
        assert kept['item']['original_text'] == before['original_text']
        assert kept['actor'] == {'sub': 'system', 'kind': 'system'}
        assert kept['reason'] == 'source_update'
        assert kept['changed_fields'] == ['issue_attributes', 'source_refreshed_at']
        assert after['updated_by'] == {'sub': 'system', 'kind': 'system'}
        assert after['change_reason'] == 'source_update'
        assert after['updated_at'] == after['source_refreshed_at']

    def test_a_re_enrichment_records_its_provenance(self):
        with issues.world([issues.insights(), issues.insights('performance')]) as (feedback, _):
            _create_bucket()
            issues.deliver(issues.issue_message())
            issues.deliver(issues.issue_message(issues.CHANGED, text='The chat panel is slow.'))
            after = issues.stored(feedback)
            (kept,) = _kept_versions()

        assert after['enrichment_mode'] == 'source_update'
        assert after['pipeline_version'] == PIPELINE_VERSION
        assert kept['item']['enrichment_mode'] == 'llm'
        assert {'original_text', 'category', 'llm_metadata', 'enrichment_mode'} <= set(kept['changed_fields'])

    def test_an_unchanged_resend_keeps_nothing(self):
        with issues.world() as (_, _llm):
            _create_bucket()
            issues.deliver(issues.issue_message())
            issues.deliver(issues.issue_message())
            assert _kept_versions() == []

    def test_a_failed_version_write_never_fails_the_refresh(self):
        with issues.world() as (feedback, _), patch.object(handler, 'keep_silver_version', return_value=None):
            issues.deliver(issues.issue_message())
            result = issues.deliver(issues.issue_message(issues.CHANGED, labels=['question']))
            labels = issues.stored(feedback)['issue_attributes']['labels']

        assert result['status'] == 'skipped'
        assert labels == ['question']

    def test_the_version_is_kept_before_the_update(self):
        order: list[str] = []
        with issues.world() as (feedback, _):
            issues.deliver(issues.issue_message())
            real_update = feedback.update_item

            def update(**kwargs):
                order.append('update')
                return real_update(**kwargs)

            with patch.object(handler, 'keep_silver_version', side_effect=lambda *_a, **_k: order.append('keep')), \
                 patch.object(feedback, 'update_item', side_effect=update):
                issues.deliver(issues.issue_message(issues.CHANGED, labels=['question']))

        assert order == ['keep', 'update']


class TestCsvCorrections:
    def test_a_correction_keeps_the_row_as_it_was(self):
        with csv.world() as (feedback, _):
            _create_bucket()
            csv.deliver(csv.csv_message())
            csv.deliver(csv.csv_message('the app crashes', csv.HASH_B, replace=True, rating=4))
            (item,) = csv.items(feedback)
            (kept,) = _kept_versions()

        assert kept['item']['original_text'] == 'teh app crashes'
        assert kept['item']['rating'] == 2
        assert kept['reason'] == 'csv_correction'
        assert {'original_text', 'rating', 'csv_content_hash'} <= set(kept['changed_fields'])
        assert item['change_reason'] == 'csv_correction'
        assert item['updated_by'] == {'sub': 'system', 'kind': 'system'}
        assert item['enrichment_mode'] == 'source_update'

    def test_an_unchanged_correction_keeps_nothing(self):
        with csv.world() as (_, _llm):
            _create_bucket()
            csv.deliver(csv.csv_message())
            csv.deliver(csv.csv_message(replace=True))
            assert _kept_versions() == []
