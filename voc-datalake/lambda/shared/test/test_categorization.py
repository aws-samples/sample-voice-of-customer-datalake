"""Tests for shared/categorization.py — the classification helpers the processor
and the category-reprocess worker share."""
from unittest.mock import MagicMock, patch

import pytest

from shared.categorization import (
    DEFAULT_CATEGORY_NAMES,
    EnrichmentSteps,
    allowed_category_names,
    classify_category,
    load_categories_config,
    parse_llm_json_response,
    resolve_category,
    run_enrichment,
)
from shared.converse import BedrockThrottlingError

CONFIG = [
    {'name': 'shipping', 'description': 'Shipping issues', 'product': 'Logistics',
     'subcategories': [{'name': 'late'}, {'name': 'damaged'}]},
    {'name': 'billing', 'description': 'Billing'},
]


@pytest.fixture(autouse=True)
def _model():
    with patch('shared.categorization.get_active_model_id', return_value='test-model'):
        yield


class TestLoadCategoriesConfig:
    def test_drops_entries_without_a_name(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'categories': [
            {'name': 'a'}, {'description': 'nameless'}, 'junk', {'name': ''},
        ]}}
        assert load_categories_config(table) == [{'name': 'a'}]
        table.get_item.assert_called_once_with(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})

    def test_missing_item_is_empty(self):
        table = MagicMock()
        table.get_item.return_value = {}
        assert load_categories_config(table) == []


class TestAllowedCategoryNames:
    def test_defaults_when_unconfigured(self):
        assert allowed_category_names([]) == list(DEFAULT_CATEGORY_NAMES)

    def test_configured_names_in_order(self):
        assert allowed_category_names(CONFIG) == ['shipping', 'billing']


class TestResolveCategory:
    def test_rejects_unknown_category(self):
        assert resolve_category(CONFIG, 'other', None) is None
        assert resolve_category(CONFIG, 7, None) is None

    def test_keeps_only_configured_subcategories(self):
        assert resolve_category(CONFIG, 'shipping', 'late') == ('shipping', 'late')
        assert resolve_category(CONFIG, 'shipping', 'invented') == ('shipping', None)

    def test_free_text_subcategory_when_none_configured(self):
        assert resolve_category(CONFIG, 'billing', 'refund') == ('billing', 'refund')
        assert resolve_category(CONFIG, 'billing', '  ') == ('billing', None)


class TestParseLlmJsonResponse:
    """Moved from lambda/processor/test/test_handler.py: the processor runs this on every LLM reply."""

    def test_parses_plain_json(self):
        content = '{"category": "product_quality", "sentiment_label": "positive"}'
        assert parse_llm_json_response(content) == content

    def test_strips_markdown_code_block(self):
        content = '```json\n{"category": "product_quality"}\n```'
        assert parse_llm_json_response(content) == '{"category": "product_quality"}'

    def test_extracts_json_from_text(self):
        content = 'Here is the analysis: {"category": "other"} Hope this helps!'
        assert parse_llm_json_response(content) == '{"category": "other"}'

    def test_handles_whitespace(self):
        content = '  \n  {"category": "billing"}  \n  '
        assert parse_llm_json_response(content) == '{"category": "billing"}'


class TestClassifyCategory:
    def test_unparseable_or_unknown_answer_is_none(self):
        assert classify_category({}, 't', CONFIG, converse_fn=MagicMock(return_value='nope')) is None
        assert classify_category({}, 't', CONFIG,
                                 converse_fn=MagicMock(return_value='{"category": "x"}')) is None

    def test_throttling_propagates(self):
        converse_fn = MagicMock(side_effect=BedrockThrottlingError('slow down'))
        with pytest.raises(BedrockThrottlingError):
            classify_category({}, 't', CONFIG, converse_fn=converse_fn)


def _steps(insights: dict) -> EnrichmentSteps:
    return EnrichmentSteps(
        detect_language=lambda _text: 'en',
        translate_text=lambda text, _src, _dst: f'T:{text}',
        sentiment=lambda _text, _lang: {'label': 'negative', 'score': -0.5},
        llm=lambda _record: {'insights': insights, 'metadata': {}},
    )


class TestRunEnrichment:
    def test_preset_category_wins(self):
        enrichment = run_enrichment(
            {'text': 'x', 'preset_category': 'shipping', 'preset_subcategory': 'late'},
            _steps({'category': 'billing', 'subcategory': 'refund'}), 'en',
        )
        assert enrichment.attributes['category'] == 'shipping'
        assert enrichment.attributes['subcategory'] == 'late'
        assert enrichment.attributes['normalized_text'] is None
