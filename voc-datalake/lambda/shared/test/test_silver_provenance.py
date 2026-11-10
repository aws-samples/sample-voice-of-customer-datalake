"""The Silver contract helpers: provenance fields, change stamps and kept versions (TENETS.md D1, D2, D4)."""
import json
from decimal import Decimal
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared import silver_provenance as sp
from shared.test.fresh_module import fresh_module_copy

ITEM = {
    'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#fb1', 'feedback_id': 'fb1', 'source_platform': 'webscraper',
    'category': 'delivery', 'rating': Decimal('4'), 'sentiment_score': Decimal('-0.5'), 'tags': {'b', 'a'},
}
ACTOR = {'sub': 'user-1', 'kind': 'admin'}


def _client_error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code}}, 'PutObject')


@pytest.fixture
def s3(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', 'raw-bucket')
    client = MagicMock()
    with patch.object(sp, '_s3', return_value=client):
        yield client


@pytest.fixture
def failures():
    with patch.object(sp.metrics, 'add_metric') as add_metric:
        yield add_metric


class TestProvenance:
    def test_fields_without_llm_metadata(self):
        fields = sp.provenance('source_update', at='2026-01-01T00:00:00+00:00')
        assert fields == {'pipeline_version': sp.PIPELINE_VERSION, 'enrichment_mode': 'source_update',
                          'enriched_at': '2026-01-01T00:00:00+00:00'}

    def test_llm_metadata_keeps_only_contract_fields(self):
        fields = sp.provenance('llm', llm_metadata={
            'model_name': 'answered', 'requested_model': 'asked', 'prompt_version': '2.0.0',
            'latency_ms': 12, 'error': None, 'other': 'x'})
        assert fields['llm_metadata'] == {'model_name': 'answered', 'requested_model': 'asked',
                                          'prompt_version': '2.0.0', 'latency_ms': 12}
        assert fields['enriched_at']

    def test_error_is_kept(self):
        assert sp.provenance('defaults', llm_metadata={'error': 'boom'})['llm_metadata'] == {'error': 'boom'}

    @pytest.mark.parametrize(('env', 'expected'), [('6.03.0', '6.03.0'), ('', 'unknown')])
    def test_pipeline_version_reads_app_version(self, monkeypatch, env, expected):
        monkeypatch.setenv('APP_VERSION', env)
        fresh = fresh_module_copy('silver_provenance_cold_start', Path(sp.__file__))
        version = fresh.PIPELINE_VERSION
        assert version == expected


class TestChangeStamp:
    def test_stamp(self):
        assert sp.change_stamp(ACTOR, sp.REASON_CATEGORY_EDIT, at='t') == {
            'updated_by': {'sub': 'user-1', 'kind': 'admin'}, 'updated_at': 't', 'change_reason': 'category_edit'}

    def test_blank_actor_is_system(self):
        assert sp.change_stamp({}, 'x')['updated_by'] == sp.SYSTEM_ACTOR


class TestSilverPrefix:
    def test_prefix(self):
        assert sp.silver_item_prefix(ITEM) == 'silver/webscraper/fb1/'

    def test_source_from_pk_and_unsafe_ids_hashed(self):
        prefix = sp.silver_item_prefix({'pk': 'SOURCE#a/b', 'feedback_id': '../x'})
        assert prefix is not None
        assert prefix.startswith('silver/h.')
        assert '/../' not in prefix

    def test_no_id(self):
        assert sp.silver_item_prefix({'source_platform': 's'}) is None


class TestKeepSilverVersion:
    def test_writes_write_once_json(self, s3):
        uri = sp.keep_silver_version(ITEM, actor=ACTOR, reason='category_edit', changed_fields=['category', 'gsi2pk'])
        request = s3.put_object.call_args.kwargs
        assert request['IfNoneMatch'] == '*'
        assert request['Bucket'] == 'raw-bucket'
        assert request['Key'].startswith('silver/webscraper/fb1/')
        assert request['Key'].endswith('.json')
        assert uri == f"s3://raw-bucket/{request['Key']}"
        body = json.loads(request['Body'])
        assert body['item']['rating'] == 4
        assert body['item']['sentiment_score'] == -0.5
        assert body['item']['tags'] == ['a', 'b']
        assert body['actor'] == ACTOR
        assert body['reason'] == 'category_edit'
        assert body['changed_fields'] == ['category', 'gsi2pk']
        assert body['kept_at']

    def test_already_kept_is_success(self, s3, failures):
        s3.put_object.side_effect = _client_error('PreconditionFailed')
        uri = sp.keep_silver_version(ITEM, actor=ACTOR, reason='r', changed_fields=[])
        assert uri is not None
        assert uri.startswith('s3://raw-bucket/silver/webscraper/fb1/')
        failures.assert_not_called()

    @pytest.mark.parametrize('error', [_client_error('AccessDenied'), BotoCoreError()])
    def test_failure_never_raises_and_is_counted(self, s3, failures, error):
        s3.put_object.side_effect = error
        assert sp.keep_silver_version(ITEM, actor=ACTOR, reason='r', changed_fields=[]) is None
        failures.assert_called_once_with(name='SilverVersionFailures', unit='Count', value=1)

    def test_no_bucket(self, monkeypatch, failures):
        monkeypatch.delenv('RAW_DATA_BUCKET', raising=False)
        assert sp.keep_silver_version(ITEM, actor=ACTOR, reason='r', changed_fields=[]) is None
        failures.assert_called_once()

    def test_no_feedback_id(self, s3, failures):
        assert sp.keep_silver_version({'source_platform': 's'}, actor=ACTOR, reason='r', changed_fields=[]) is None
        s3.put_object.assert_not_called()
        failures.assert_called_once()


class TestReasons:
    def test_every_declared_reason_is_known(self):
        assert {'category_edit', 'dimensions_edit', 'data_explorer_edit', 'csv_correction',
                                     'source_update', 'reprocess'} == sp.CHANGE_REASONS

    @pytest.mark.usefixtures('s3')
    def test_an_undeclared_reason_is_logged_but_still_kept(self):
        with patch.object(sp.logger, 'warning') as warning:
            uri = sp.keep_silver_version(ITEM, actor=ACTOR, reason='typo', changed_fields=[])
        assert uri is not None
        warning.assert_called_once_with('Silver version kept with an undeclared reason', extra={'reason': 'typo'})


class TestSummaryOnlyVersions:
    """TENETS.md tenet 6 over D2: write-once history never holds what a summary-only source must not store."""

    LEAKED: ClassVar[dict] = {'normalized_text': 'my words', 'direct_customer_quote': '"my words"', 'author': 'Jane',
                              'title': 'Late', 'metadata': {'order': '5512'}}

    def _kept(self, s3, item):
        sp.keep_silver_version(item, actor={'sub': 's', 'kind': 'admin'}, reason=sp.REASON_REPROCESS,
                               changed_fields=['category'])
        return json.loads(s3.put_object.call_args.kwargs['Body'])['item']

    def test_a_summary_only_item_is_kept_without_the_fields_its_policy_drops(self, s3):
        item = {'feedback_id': 'f1', 'source_platform': 'web', 'pii_policy': 'summary_only', 'category': 'billing',
                **self.LEAKED}
        kept = self._kept(s3, item)
        assert not set(self.LEAKED) & set(kept)
        assert kept['category'] == 'billing'
        assert kept['pii_policy'] == 'summary_only'

    @pytest.mark.parametrize('policy', ['allow', 'redact', None])
    def test_other_policies_keep_the_item_as_it_was(self, s3, policy):
        item = {'feedback_id': 'f1', 'source_platform': 'web', **({'pii_policy': policy} if policy else {}),
                **self.LEAKED}
        assert set(self.LEAKED) <= set(self._kept(s3, item))
