"""The processor infers the built-in ``feedback_type`` in the SAME enrichment model call.

The dimensions config the processor hands the model always includes the built-in,
even with nothing configured; the model's value is validated against the ten
types and stored with ``dimension_sources.feedback_type = 'ai'``; a producer value
(a CSV column, an email alias) wins over the model.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from processor import handler
from processor.test.process_fixtures import process_with_model
from shared.dimension_config import with_builtin_dimensions
from shared.feedback_types import feedback_type_dimension

PRODUCT = {'key': 'product', 'label': 'Product', 'infer': True, 'values': [{'name': 'App'}, {'name': 'Web'}]}
CATEGORIES = [{'name': 'billing'}, {'name': 'other'}]
INSIGHTS = {'category': 'billing', 'sentiment_label': 'negative', 'sentiment_score': -0.5, 'urgency': 'medium'}


def _seed_loaded(dimensions: list) -> None:
    """Seed the processor's settings cache as ``load_dimensions_config`` would fill it."""
    handler._settings_cache['dimensions'] = (float('inf'), dimensions)


def _record(**extra) -> dict:
    return {'id': 'r1', 'source_platform': 'webscraper', 'text': 'The app crashes when I pay',
            'created_at': '2026-10-01T00:00:00Z', **extra}


@pytest.fixture
def process():
    """``process_feedback`` with no AWS calls; the model answers ``ai_dimensions`` inside its insights."""
    def run(record: dict, ai_dimensions: object = None) -> dict:
        insights = dict(INSIGHTS)
        if ai_dimensions is not None:
            insights['dimensions'] = ai_dimensions
        llm = {'insights': insights, 'metadata': {}}
        item = process_with_model(record, llm, CATEGORIES)
        assert item is not None
        return item
    return run


class TestTheDimensionsConfigTheModelSees:
    def test_nothing_configured_still_gives_the_builtin(self):
        _seed_loaded([])
        assert handler.get_dimensions_config() == [feedback_type_dimension()]

    def test_an_unreadable_dimensions_row_still_gives_the_builtin(self):
        handler._settings_cache.clear()
        table = MagicMock()
        table.get_item.side_effect = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                                                 'GetItem')
        with patch.object(handler, 'aggregates_table', table):
            assert handler.get_dimensions_config() == [feedback_type_dimension()]

    def test_a_loaded_config_is_used_as_is(self):
        loaded = with_builtin_dimensions([PRODUCT])
        _seed_loaded(loaded)
        assert [d['key'] for d in handler.get_dimensions_config()] == ['feedback_type', 'product']

    def test_the_enrichment_call_carries_the_builtin(self):
        _seed_loaded([])
        with patch.object(handler, 'invoke_enrichment_llm', return_value={'insights': {}, 'metadata': {}}) as llm:
            handler.invoke_bedrock_llm(_record())
        assert llm.call_args.kwargs['dimensions_config'] == [feedback_type_dimension()]

    def test_one_model_call_asks_for_the_category_and_the_feedback_type(self):
        _seed_loaded([])
        converse = MagicMock(return_value=json.dumps({**INSIGHTS, 'dimensions': {'feedback_type': 'bug'}}))
        with patch('shared.categorization.get_active_model_id', return_value='test-model'):
            result = handler.invoke_enrichment_llm(_record(), 'categories here', converse_fn=converse,
                                                   dimensions_config=handler.get_dimensions_config())
        converse.assert_called_once()
        prompt = converse.call_args.kwargs['prompt']
        assert '"category":' in prompt
        assert '"dimensions":{"feedback_type":"<value or null>"}' in prompt
        assert 'bug | service_failure | feature_request' in prompt
        assert result['insights']['dimensions'] == {'feedback_type': 'bug'}


class TestStoredFeedbackType:
    def test_the_model_value_is_stored_as_ai(self, process):
        _seed_loaded(with_builtin_dimensions([]))
        item = process(_record(), {'feedback_type': 'bug'})
        assert item['dimensions'] == {'feedback_type': 'bug'}
        assert item['dimension_sources'] == {'feedback_type': 'ai'}

    def test_the_model_value_is_canonicalised(self, process):
        _seed_loaded(with_builtin_dimensions([]))
        item = process(_record(), {'feedback_type': ' Feature_Request '})
        assert item['dimensions'] == {'feedback_type': 'feature_request'}

    @pytest.mark.parametrize('answer', [{'feedback_type': 'review'}, {'feedback_type': None},
                                        {'feedback_type': ['bug']}, {}, 'bug'])
    def test_a_value_outside_the_ten_types_is_not_stored(self, process, answer):
        _seed_loaded(with_builtin_dimensions([]))
        item = process(_record(), answer)
        assert 'dimensions' not in item
        assert 'dimension_sources' not in item

    def test_the_producer_value_beats_the_model(self, process):
        _seed_loaded(with_builtin_dimensions([]))
        item = process(_record(dimensions={'feedback_type': 'feature_request'}), {'feedback_type': 'bug'})
        assert item['dimensions'] == {'feedback_type': 'feature_request'}
        assert item['dimension_sources'] == {'feedback_type': 'source'}

    def test_a_producer_value_outside_the_types_falls_back_to_the_model(self, process):
        _seed_loaded(with_builtin_dimensions([]))
        item = process(_record(dimensions={'feedback_type': 'review'}), {'feedback_type': 'praise'})
        assert item['dimensions'] == {'feedback_type': 'praise'}
        assert item['dimension_sources'] == {'feedback_type': 'ai'}

    def test_the_type_sits_beside_the_configured_dimensions(self, process):
        _seed_loaded(with_builtin_dimensions([PRODUCT]))
        item = process(_record(), {'feedback_type': 'bug', 'product': 'App'})
        assert item['dimensions'] == {'feedback_type': 'bug', 'product': 'App'}
        assert item['dimension_sources'] == {'feedback_type': 'ai', 'product': 'ai'}
