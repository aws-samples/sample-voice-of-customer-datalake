"""Reprocess ``mode: 'dimensions'`` fills the built-in ``feedback_type`` for stored reviews.

Against the conftest's moto tables: nothing configured in ``SETTINGS#dimensions`` still
gives the job the built-in (``load_dimensions_config``), the model is asked for it in
the narrow dimensions call, and a manual or producer value is never overwritten.
"""
import json
from unittest.mock import MagicMock

import pytest

from jobs.category_reprocess import handler
from jobs.category_reprocess.handler import reprocess_item
from shared import reprocess_jobs as jobs
from shared.dimension_config import DIMENSIONS_SETTINGS_KEY, load_dimensions_config
from shared.feedback_types import feedback_type_dimension

JOB = {'mode': jobs.MODE_DIMENSIONS}
KEY = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#1'}


def _store(tables, **extra) -> None:
    tables['feedback'].put_item(Item={**KEY, 'original_text': 'The app crashes at checkout',
                                      'category': 'shipping', **extra})


def _reprocess(tables) -> dict:
    counters = dict.fromkeys(jobs.COUNTERS, 0)
    item = tables['feedback'].get_item(Key=KEY)['Item']
    reprocess_item(tables['feedback'], item, JOB, [], counters, load_dimensions_config(tables['aggregates']))
    return counters


def _stored(tables) -> dict:
    return tables['feedback'].get_item(Key=KEY)['Item']


def _answer(converse_mock: MagicMock, value: object) -> None:
    converse_mock.return_value = json.dumps({'feedback_type': value})


class TestTheJobSeesTheBuiltin:
    def test_nothing_configured_still_loads_the_builtin(self, tables):
        assert load_dimensions_config(tables['aggregates']) == [feedback_type_dimension()]

    def test_a_stored_legacy_feedback_type_is_replaced(self, tables):
        legacy = {'key': 'feedback_type', 'infer': False, 'values': [{'name': 'review'}]}
        tables['aggregates'].put_item(Item={**DIMENSIONS_SETTINGS_KEY, 'dimensions': [legacy]})
        assert load_dimensions_config(tables['aggregates']) == [feedback_type_dimension()]

    def test_the_model_is_asked_for_the_feedback_type(self, tables, converse_mock):
        _store(tables)
        _answer(converse_mock, 'bug')
        _reprocess(tables)
        converse_mock.assert_called_once()
        prompt = converse_mock.call_args.kwargs['prompt']
        assert '"feedback_type":"<value or null>"' in prompt
        assert 'service_failure' in prompt


class TestBackfill:
    def test_a_review_without_a_type_gets_one_recorded_as_reprocess(self, tables, converse_mock):
        _store(tables)
        _answer(converse_mock, 'bug')
        counters = _reprocess(tables)
        assert counters['updated'] == 1
        item = _stored(tables)
        assert item['dimensions'] == {'feedback_type': 'bug'}
        assert item['dimension_sources'] == {'feedback_type': 'reprocess'}
        assert item['dimensions_reprocessed_at']

    def test_the_answer_is_canonicalised(self, tables, converse_mock):
        _store(tables)
        _answer(converse_mock, 'Pricing_Billing')
        _reprocess(tables)
        assert _stored(tables)['dimensions'] == {'feedback_type': 'pricing_billing'}

    @pytest.mark.parametrize('value', ['review', None, 'complaint'])
    def test_an_answer_outside_the_types_writes_nothing(self, tables, converse_mock, value):
        _store(tables)
        _answer(converse_mock, value)
        counters = _reprocess(tables)
        assert counters['unchanged'] == 1
        assert 'dimensions' not in _stored(tables)

    def test_an_earlier_ai_value_is_replaced(self, tables, converse_mock):
        _store(tables, dimensions={'feedback_type': 'other'}, dimension_sources={'feedback_type': 'ai'})
        _answer(converse_mock, 'performance')
        _reprocess(tables)
        item = _stored(tables)
        assert item['dimensions'] == {'feedback_type': 'performance'}
        assert item['dimension_sources'] == {'feedback_type': 'reprocess'}

    @pytest.mark.parametrize('source', ['manual', 'source', 'profile'])
    def test_a_manual_or_producer_value_is_kept(self, tables, converse_mock, source):
        _store(tables, dimensions={'feedback_type': 'feature_request'}, dimension_sources={'feedback_type': source})
        _answer(converse_mock, 'bug')
        counters = _reprocess(tables)
        assert counters['unchanged'] == 1
        item = _stored(tables)
        assert item['dimensions'] == {'feedback_type': 'feature_request'}
        assert item['dimension_sources'] == {'feedback_type': source}

    def test_a_same_answer_writes_nothing(self, tables, converse_mock):
        _store(tables, dimensions={'feedback_type': 'bug'}, dimension_sources={'feedback_type': 'reprocess'})
        _answer(converse_mock, 'bug')
        assert _reprocess(tables)['unchanged'] == 1
        assert 'dimensions_reprocessed_at' not in _stored(tables)

    def test_a_manual_category_does_not_stop_the_type_backfill(self, tables, converse_mock):
        _store(tables, category_source='manual')
        _answer(converse_mock, 'question')
        assert _reprocess(tables)['updated'] == 1
        assert _stored(tables)['dimensions'] == {'feedback_type': 'question'}


@pytest.mark.usefixtures('invoke_mock')
def test_the_job_walk_loads_the_builtin_for_dimensions_mode(tables, converse_mock, worker_context, start_job):
    _store(tables)
    _answer(converse_mock, 'usability')
    job = start_job(mode=jobs.MODE_DIMENSIONS)
    assert handler.lambda_handler({'job_id': job['sk']}, worker_context)['status'] == 'completed'
    assert _stored(tables)['dimensions'] == {'feedback_type': 'usability'}
    assert _stored(tables)['dimension_sources'] == {'feedback_type': 'reprocess'}
